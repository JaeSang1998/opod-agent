import type OpenAI from "openai";
import type { LLMProvider } from "../provider/llm-provider.js";
import { type AgentTool, type ToolContext, executeToolCall } from "../tools/index.js";
import {
  assembleToolCall,
  createClientChunkFilter,
  emptyCompletion,
  reasoningOf,
  stopChunk,
  toStopCompletion,
} from "./tool-loop-wire.js";

/**
 * A transport-agnostic observation of the loop's tool activity, surfaced only when
 * a caller passes {@link ToolLoopOptions.onEvent}. The default reply is unaffected;
 * see docs/adr/0006 (the x-opod-debug channel).
 */
export type ToolLoopEvent =
  | { type: "tool_call"; callId: string; iteration: number; tool: string; args: string }
  | {
      type: "tool_result";
      callId: string;
      iteration: number;
      tool: string;
      ms: number;
      result: string;
    };

export interface ToolLoopOptions {
  provider: LLMProvider;
  request: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, "stream">;
  tools: AgentTool[];
  ctx: ToolContext;
  maxIterations?: number; // default 5
  /** Optional observer of tool activity. Emitted best-effort: a throwing listener
   *  is swallowed so it can never break a reply. */
  onEvent?: (event: ToolLoopEvent) => void;
}

const DEFAULT_MAX_ITERATIONS = 5;
const RESULT_PREVIEW = 200;

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

/**
 * Server-side tool loop (non-streaming). Repeatedly asks the provider for a reply;
 * when it comes back with tool_calls, runs them all (defensively, never throwing)
 * and feeds the results back as tool messages, until the model answers in text.
 * The final allowed iteration forces tool_choice:"none" so an answer is produced.
 */
export async function runToolLoop(
  opts: ToolLoopOptions,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { provider, request, tools, ctx } = opts;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const defs = tools.map((t) => t.definition);
  const messages: Message[] = [...(request.messages as Message[])];
  const toolResults = new Map<string, Promise<string>>();

  let completion: OpenAI.Chat.Completions.ChatCompletion | undefined;
  for (let i = 0; i < maxIterations; i++) {
    completion = await provider.chat(
      {
        ...request,
        messages,
        tools: defs,
        tool_choice: i === maxIterations - 1 ? "none" : "auto",
        stream: false,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal: ctx.signal },
    );

    const message = completion.choices[0]?.message;
    const toolCalls = message?.tool_calls;
    if (!message || !toolCalls || toolCalls.length === 0) return completion;

    messages.push(message as Message);
    const results = await Promise.all(
      toolCalls.map((call) => invoke(tools, call, ctx, toolResults, i, opts.onEvent)),
    );
    for (const { call, content } of results) {
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  // Reached only if the model kept requesting tools through the final "none" turn
  // (common with local models that ignore tool_choice:"none"). Never leak the
  // server's own tool_calls to a client that never sent any tools (docs/adr/0003):
  // hand back a well-formed, tool-call-free "stop" turn instead.
  return completion ? toStopCompletion(completion) : emptyCompletion(request.model ?? "");
}

/**
 * Streaming counterpart. Suppresses tool turns entirely (their chunks, including
 * the finish_reason:"tool_calls" chunk, never reach the client) and streams only
 * the text turns through. A rare mixed turn (content flushed, then tool_calls)
 * suppresses the tool fragments, runs the tools, and lets the next turn's content
 * continue the same stream. At most one role delta ever reaches the client across
 * the whole (possibly multi-turn) stream, and on iteration exhaustion a
 * well-formed, tool-call-free "stop" turn is emitted so the client never sees a
 * blank stream or the server's internal tool_calls (docs/adr/0003).
 */
export async function* runToolLoopStream(
  opts: ToolLoopOptions,
): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  const { provider, request, tools, ctx } = opts;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const defs = tools.map((t) => t.definition);
  const messages: Message[] = [...(request.messages as Message[])];
  const toolResults = new Map<string, Promise<string>>();

  const forClient = createClientChunkFilter();

  for (let i = 0; i < maxIterations; i++) {
    const stream = await provider.chatStream(
      {
        ...request,
        messages,
        tools: defs,
        tool_choice: i === maxIterations - 1 ? "none" : "auto",
        stream: true,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal: ctx.signal },
    );

    let content = "";
    const acc: ToolCall[] = [];
    let isToolTurn = false;
    let flushed = false;
    const buffer: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      const finishReason = choice?.finish_reason;

      const piece = delta?.content ?? "";
      if (piece) content += piece;

      const fragments = delta?.tool_calls;
      if (fragments && fragments.length > 0) {
        isToolTurn = true;
        for (const frag of fragments) assembleToolCall(acc, frag);
        continue; // never emit a chunk carrying tool_calls
      }
      if (finishReason === "tool_calls") isToolTurn = true;

      // Once the turn is known to be a tool turn, emit nothing more from it —
      // including its reasoning.
      if (isToolTurn) continue;

      // Nonstandard "reasoning" fragment (delta.reasoning) with no content/tool_calls,
      // in a turn not yet known to be a tool turn: stream it IMMEDIATELY, never buffer.
      // Reasoning can never retroactively become content, so passing it through cannot
      // mis-order a text turn. A tool turn's early reasoning (before its tool_calls
      // fragment arrives) intentionally streams too: the field is nonstandard and
      // ignored by strict OpenAI clients, whereas buffering minutes of thinking (see
      // the live-verified gemma behavior) makes clients look dead.
      if (!piece && reasoningOf(delta) !== "") {
        const out = forClient(chunk);
        if (out) yield out;
        continue;
      }

      if (piece) {
        // Content settled the turn's nature: flush what we held, then stream.
        if (!flushed) {
          for (const b of buffer) {
            const out = forClient(b);
            if (out) yield out;
          }
          buffer.length = 0;
          flushed = true;
        }
        const out = forClient(chunk);
        if (out) yield out;
      } else if (flushed) {
        // Trailing chunks of a text turn (e.g. the natural finish chunk).
        const out = forClient(chunk);
        if (out) yield out;
      } else {
        // Nature not yet known (role-only opener, empty delta): hold it back.
        buffer.push(chunk);
      }
    }

    const calls = acc.filter(Boolean);
    if (calls.length === 0) {
      // A pure text turn is final. Flush anything still held (a content-less turn)
      // and end the stream.
      if (!flushed) {
        for (const b of buffer) {
          const out = forClient(b);
          if (out) yield out;
        }
      }
      return;
    }

    messages.push({ role: "assistant", content: content || null, tool_calls: calls });
    const results = await Promise.all(
      calls.map((call) => invoke(tools, call, ctx, toolResults, i, opts.onEvent)),
    );
    for (const { call, content: result } of results) {
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // Exhausted all iterations still on a tool turn: close the stream with a
  // well-formed, tool-call-free "stop" turn (role stripped if one already went out).
  const stop = forClient(stopChunk(request.model ?? ""));
  if (stop) yield stop;
}

/** Runs one tool call, logs its name + duration at info level, and (best-effort)
 *  emits tool_call before and tool_result after via the optional observer. */
async function invoke(
  tools: AgentTool[],
  call: ToolCall,
  ctx: ToolContext,
  cache: Map<string, Promise<string>>,
  iteration: number,
  onEvent?: (event: ToolLoopEvent) => void,
): Promise<{ call: ToolCall; content: string }> {
  const tool = call.function.name;
  emit(onEvent, {
    type: "tool_call",
    callId: call.id,
    iteration,
    tool,
    args: call.function.arguments,
  });
  const started = Date.now();
  const cached = cache.has(call.id);
  let pending = cache.get(call.id);
  if (!pending) {
    pending = executeToolCall(tools, call, ctx);
    cache.set(call.id, pending);
  }
  const content = await pending;
  const ms = Date.now() - started;
  ctx.log.info("tool call", { tool, ms, cached });
  emit(onEvent, {
    type: "tool_result",
    callId: call.id,
    iteration,
    tool,
    ms,
    result: content.slice(0, RESULT_PREVIEW),
  });
  return { call, content };
}

/** Delivers one event to the observer, swallowing any throw so a misbehaving
 *  listener can never break the reply. */
function emit(onEvent: ((event: ToolLoopEvent) => void) | undefined, event: ToolLoopEvent): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    // A throwing listener must never affect the model reply.
  }
}
