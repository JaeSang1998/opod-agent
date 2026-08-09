import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type OpenAI from "openai";
import type { Container } from "../bootstrap/container.js";
import { ChatCompletionRequest, OPOD_HEADERS } from "../protocol/index.js";
import { getRequestContext } from "../http/context.js";
import { openaiError } from "../http/errors.js";
import { classifyRequestError, createRequestSignal } from "../http/request-lifecycle.js";
import { type ToolLoopEvent, runToolLoop, runToolLoopStream } from "./tool-loop.js";
import type { PreparedTurn } from "./chat-service.js";
import {
  type BondSignalRedactor,
  createBondSignalRedactor,
  extractBondSignal,
} from "./bond-signal.js";
import { LLM_LOG_TYPE } from "../provider/llm-provider.js";

/** POST /v1/chat/completions — OpenAI-compatible, persona+memory-enriched. */
export function chatRoute(container: Container): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ChatCompletionRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json(openaiError("invalid_request_error", parsed.error.message), 400);
    }
    const body = parsed.data;
    const ctx = getRequestContext(c);
    if (!Number.isSafeInteger(ctx.historyOffset) || (ctx.historyOffset ?? 0) < 0) {
      return c.json(
        openaiError("invalid_request_error", "X-Opod-History-Offset must be a non-negative integer"),
        400,
      );
    }
    if (ctx.characterId && ctx.userId && ctx.sessionId && !ctx.turnId) {
      return c.json(
        openaiError("invalid_request_error", "X-Opod-Turn-Id is required for personalized learning"),
        400,
      );
    }
    const signal = createRequestSignal(c.req.raw.signal, container.env.LLM_REQUEST_TIMEOUT_MS);
    // Transport-level opt-in for the tool-activity debug channel (docs/adr/0006).
    // Any non-empty value enables it. It is NOT part of RequestContext/ChatContext —
    // it carries no identity, only a per-request "show me the plumbing" flag.
    const debug = Boolean(c.req.header(OPOD_HEADERS.debug));

    let prepared: PreparedTurn;
    try {
      prepared = await container.chat.prepare(body, ctx, signal);
    } catch (err) {
      const failure = classifyRequestError(err);
      container.log.error("prepare error", { err: String(err), requestId: ctx.requestId });
      return c.json(openaiError(failure.type, failure.message), failure.status);
    }

    if (body.stream) {
      return streamSSE(c, async (sse) => {
        let assistant = "";
        let completed = false;
        // The character's closeness grade rides out on the same channel as its
        // words (chat/bond-signal.ts). It is removed here, before the first
        // byte of it can reach a client.
        const redactor = prepared.expectsBondSignal ? createBondSignalRedactor() : null;
        // Serialize every SSE write through one promise chain so debug event frames
        // (emitted mid-loop via onEvent) and chunk frames never interleave mid-frame.
        let chain: Promise<unknown> = Promise.resolve();
        const write = (frame: Parameters<typeof sse.writeSSE>[0]) =>
          (chain = chain.then(() => sse.writeSSE(frame)));
        try {
          const stream = prepared.tools
            ? runToolLoopStream({
                provider: container.provider,
                request: prepared.request,
                tools: prepared.tools,
                ctx: { timezone: ctx.timezone, signal, log: container.log },
                logContext: {
                  type: LLM_LOG_TYPE.chatTool,
                  requestId: ctx.requestId,
                  userId: ctx.userId,
                  characterId: ctx.characterId,
                },
                // Only with the debug header do we emit "event: opod" frames; the
                // default surface stays byte-identical (no extra frames/fields).
                onEvent: debug
                  ? (ev) => void write({ event: "opod", data: JSON.stringify(ev) })
                  : undefined,
              })
            : await container.provider.chatStream({
                ...prepared.request,
                stream: true,
              } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
              {
                signal,
                log: {
                  type: LLM_LOG_TYPE.chat,
                  requestId: ctx.requestId,
                  userId: ctx.userId,
                  characterId: ctx.characterId,
                },
              },
            );

          let lastFrame: OpenAI.Chat.Completions.ChatCompletionChunk | undefined;
          for await (const chunk of stream) {
            const frame = redactor ? redactChunk(redactor, chunk) : chunk;
            if (!frame) continue;
            lastFrame = frame;
            assistant += frame.choices[0]?.delta?.content ?? "";
            write({ data: JSON.stringify(frame) });
          }
          // A stream that ended without a finish_reason never triggered the
          // flush inside redactChunk. Whatever is still held is ordinary text
          // and belongs to the client.
          const tail = redactor?.flush() ?? "";
          if (tail && lastFrame) {
            assistant += tail;
            const choice = lastFrame.choices[0];
            write({
              data: JSON.stringify({
                ...lastFrame,
                choices: [{ index: choice?.index ?? 0, delta: { content: tail }, finish_reason: null }],
              }),
            });
          }
          await chain;
          await sse.writeSSE({ data: "[DONE]" });
          completed = true;
        } catch (err) {
          const failure = classifyRequestError(err);
          container.log.error("stream error", { err: String(err), requestId: ctx.requestId });
          await sse.writeSSE({
            data: JSON.stringify(openaiError(failure.type, failure.message)),
          });
        } finally {
          // Never learn from a truncated/error reply. Consolidate only after the
          // provider stream completed and the client received the DONE frame.
          if (completed) await prepared.postTurn(assistant, redactor?.grade()).catch(() => {});
        }
      });
    }

    try {
      const events: ToolLoopEvent[] = [];
      const res = prepared.tools
        ? await runToolLoop({
            provider: container.provider,
            request: prepared.request,
            tools: prepared.tools,
            ctx: { timezone: ctx.timezone, signal, log: container.log },
            logContext: {
              type: LLM_LOG_TYPE.chatTool,
              requestId: ctx.requestId,
              userId: ctx.userId,
              characterId: ctx.characterId,
            },
            onEvent: debug ? (ev) => events.push(ev) : undefined,
          })
        : await container.provider.chat({
            ...prepared.request,
            stream: false,
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
          {
            signal,
            log: {
              type: LLM_LOG_TYPE.chat,
              requestId: ctx.requestId,
              userId: ctx.userId,
              characterId: ctx.characterId,
            },
          },
        );
      const raw = res.choices[0]?.message?.content ?? "";
      const { text: assistant, grade } = prepared.expectsBondSignal
        ? extractBondSignal(raw)
        : { text: raw, grade: null };
      await prepared.postTurn(assistant, grade);
      const body = assistant === raw ? res : withMessageContent(res, assistant);
      // Only when the client opted in AND the loop ran do we attach the debug field;
      // otherwise the body is exactly the completion as before.
      return debug && prepared.tools ? c.json({ ...body, opod_debug: { events } }) : c.json(body);
    } catch (err) {
      const failure = classifyRequestError(err);
      container.log.error("chat error", { err: String(err), requestId: ctx.requestId });
      return c.json(openaiError(failure.type, failure.message), failure.status);
    }
  });

  return app;
}

/**
 * One streamed chunk, with any part of a closeness tag taken out of it.
 *
 * Returns null when the delta was *only* tag and there is nothing else in the
 * frame worth sending — dropping it is what keeps a redacted stream looking
 * exactly like a stream that never carried a tag. The last chunk additionally
 * flushes whatever the redactor was still holding, so nothing arrives after the
 * frame that carries `finish_reason` and no client can miss it.
 */
function redactChunk(
  redactor: BondSignalRedactor,
  chunk: OpenAI.Chat.Completions.ChatCompletionChunk,
): OpenAI.Chat.Completions.ChatCompletionChunk | null {
  const choice = chunk.choices[0];
  const raw = choice?.delta?.content;
  const last = choice != null && choice.finish_reason != null;
  if (!choice || (typeof raw !== "string" && !last)) return chunk;

  const content =
    (typeof raw === "string" ? redactor.push(raw) : "") + (last ? redactor.flush() : "");
  if (content === "") {
    if (typeof raw !== "string") return chunk;
    // An empty content delta still carries the opening role, tool calls, or the
    // stop reason; only a frame with none of those is safe to swallow.
    const bare = !last && !choice.delta?.role && !choice.delta?.tool_calls;
    if (bare) return null;
  }
  return { ...chunk, choices: [{ ...choice, delta: { ...choice.delta, content } }] };
}

/** The same completion with its assistant text replaced. */
function withMessageContent(
  res: OpenAI.Chat.Completions.ChatCompletion,
  content: string,
): OpenAI.Chat.Completions.ChatCompletion {
  const [choice, ...rest] = res.choices;
  if (!choice) return res;
  return { ...res, choices: [{ ...choice, message: { ...choice.message, content } }, ...rest] };
}
