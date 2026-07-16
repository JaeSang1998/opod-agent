import type OpenAI from "openai";
import type { LLMProvider } from "../provider/llm-provider.js";

/** One scripted reply: the assistant message the provider returns for the next
 *  chat() call, or streams as fragmented chunks for the next chatStream() call. */
export interface ScriptedTurn {
  message: OpenAI.Chat.Completions.ChatCompletionMessage;
}

/** A plain-text assistant reply. */
export function textTurn(content: string): ScriptedTurn {
  return { message: { role: "assistant", content, refusal: null } };
}

/** An assistant reply that calls one or more tools. */
export function toolCallTurn(
  calls: { id: string; name: string; arguments: string }[],
): ScriptedTurn {
  return {
    message: {
      role: "assistant",
      content: null,
      refusal: null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    },
  };
}

/**
 * Deterministic LLMProvider driven by a script of turns, for exercising the tool
 * loop. Each chat()/chatStream() call consumes the next turn; chatStream() splits
 * it into realistic fragmented chunks (a role opener, content in slices or
 * tool_calls as index+id+name then argument slices, then a finish chunk). Every
 * request is recorded so tests can assert tools / tool_choice / messages.
 */
export class ScriptedProvider implements LLMProvider {
  readonly defaultModel = "scripted-model";
  readonly requests: OpenAI.Chat.Completions.ChatCompletionCreateParams[] = [];
  private cursor = 0;

  constructor(private readonly turns: ScriptedTurn[]) {}

  async chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    this.requests.push(req);
    const message = this.next();
    return {
      id: "chatcmpl-scripted",
      object: "chat.completion",
      created: 0,
      model: req.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.tool_calls?.length ? "tool_calls" : "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as OpenAI.Chat.Completions.ChatCompletion;
  }

  async chatStream(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    this.requests.push(req);
    return toChunks(this.next(), req.model);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(8).fill(0));
  }

  /** Next scripted assistant message; the last turn repeats if the script runs dry. */
  private next(): OpenAI.Chat.Completions.ChatCompletionMessage {
    const turn = this.turns[this.cursor] ?? this.turns[this.turns.length - 1];
    if (!turn) throw new Error("ScriptedProvider has no turns to reply with");
    this.cursor++;
    return turn.message;
  }
}

async function* toChunks(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
  model: string,
): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
  const base = { id: "chatcmpl-scripted", object: "chat.completion.chunk" as const, created: 0, model };
  const mk = (
    delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
    finish_reason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"] = null,
  ): OpenAI.Chat.Completions.ChatCompletionChunk => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason }],
  });

  yield mk({ role: "assistant" });

  const toolCalls = message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (!tc) continue;
      // First fragment: index + id + name (empty args); later fragments carry
      // argument slices — exactly how a real provider streams tool calls.
      yield mk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] });
      for (const slice of split(tc.function.arguments, 2)) {
        yield mk({ tool_calls: [{ index: i, function: { arguments: slice } }] });
      }
    }
    yield mk({}, "tool_calls");
    return;
  }

  const content = typeof message.content === "string" ? message.content : "";
  for (const slice of split(content, 3)) yield mk({ content: slice });
  yield mk({}, "stop");
}

/** Splits a string into up to `parts` non-empty slices whose concatenation is the
 *  original (empty input yields no slices). */
function split(text: string, parts: number): string[] {
  if (text.length === 0) return [];
  const size = Math.ceil(text.length / Math.min(parts, text.length));
  const slices: string[] = [];
  for (let i = 0; i < text.length; i += size) slices.push(text.slice(i, i + size));
  return slices;
}
