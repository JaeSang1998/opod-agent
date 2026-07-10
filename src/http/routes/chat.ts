import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type OpenAI from "openai";
import type { Container } from "../../core/container.js";
import { ChatCompletionRequest } from "../../openai/types.js";
import { getRequestContext } from "../middleware/context.js";

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

    let prepared;
    try {
      prepared = await container.chat.prepare(body, ctx);
    } catch (err) {
      return c.json(openaiError("server_error", String(err)), 500);
    }

    if (body.stream) {
      return streamSSE(c, async (sse) => {
        let assistant = "";
        try {
          const stream = await container.provider.chatStream({
            ...prepared.request,
            stream: true,
          } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

          for await (const chunk of stream) {
            assistant += chunk.choices[0]?.delta?.content ?? "";
            await sse.writeSSE({ data: JSON.stringify(chunk) });
          }
          await sse.writeSSE({ data: "[DONE]" });
        } catch (err) {
          container.log.error("stream error", { err: String(err) });
          await sse.writeSSE({ data: JSON.stringify(openaiError("server_error", String(err))) });
        } finally {
          // Autonomous consolidation runs once the full reply is known.
          await prepared.postTurn(assistant).catch(() => {});
        }
      });
    }

    try {
      const res = await container.provider.chat({
        ...prepared.request,
        stream: false,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
      const assistant = res.choices[0]?.message?.content ?? "";
      await prepared.postTurn(assistant);
      return c.json(res);
    } catch (err) {
      container.log.error("chat error", { err: String(err) });
      return c.json(openaiError("server_error", String(err)), 500);
    }
  });

  return app;
}

function openaiError(type: string, message: string) {
  return { error: { type, message } };
}
