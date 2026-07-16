import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type OpenAI from "openai";
import type { Container } from "../bootstrap/container.js";
import { ChatCompletionRequest } from "../protocol/index.js";
import { getRequestContext } from "../http/context.js";
import { openaiError } from "../http/errors.js";
import { classifyRequestError, createRequestSignal } from "../http/request-lifecycle.js";
import { type ToolLoopEvent, runToolLoop, runToolLoopStream } from "./tool-loop.js";
import type { PreparedTurn } from "./chat-service.js";

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
    const debug = Boolean(c.req.header("x-opod-debug"));

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
              { signal },
            );

          for await (const chunk of stream) {
            assistant += chunk.choices[0]?.delta?.content ?? "";
            write({ data: JSON.stringify(chunk) });
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
          if (completed) await prepared.postTurn(assistant).catch(() => {});
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
            onEvent: debug ? (ev) => events.push(ev) : undefined,
          })
        : await container.provider.chat({
            ...prepared.request,
            stream: false,
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
          { signal },
        );
      const assistant = res.choices[0]?.message?.content ?? "";
      await prepared.postTurn(assistant);
      // Only when the client opted in AND the loop ran do we attach the debug field;
      // otherwise the body is exactly the completion as before.
      return debug && prepared.tools ? c.json({ ...res, opod_debug: { events } }) : c.json(res);
    } catch (err) {
      const failure = classifyRequestError(err);
      container.log.error("chat error", { err: String(err), requestId: ctx.requestId });
      return c.json(openaiError(failure.type, failure.message), failure.status);
    }
  });

  return app;
}
