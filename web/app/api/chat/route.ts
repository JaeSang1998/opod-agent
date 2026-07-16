import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { fetchOpod } from "@/backend/opod";
import { PlaygroundChatRequest } from "@/backend/chat-contract";
import { opodChatHeaders, toOpodChatRequest } from "@/backend/opod-chat-request";
import { readSSEData } from "@/chat/openai-sse";
import { OPOD_HEADERS } from "@opod/protocol";

/** A 30B reasoning model on local hardware is slow — don't cut it off. */
export const maxDuration = 800;

/**
 * Bridges opod-agent (OpenAI-compatible wire format) to the AI SDK UI message
 * stream that `useChat` consumes.
 *
 * The reason this is hand-rolled rather than using an openai-compatible
 * provider: mlx_lm.server returns the model's thinking in a separate
 * `delta.reasoning` field (not `<think>` tags in content, not
 * `reasoning_content`), so neither the provider's default mapping nor
 * `extractReasoningMiddleware` would surface it. Translating the SSE directly
 * lets reasoning render in the <Reasoning> component.
 */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = PlaygroundChatRequest.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: { type: "invalid_request_error", message: parsed.error.message } },
      { status: 400 },
    );
  }
  // Persona + memory context rides in headers (opod ADR-0003).
  const requestId = req.headers.get(OPOD_HEADERS.requestId) ?? crypto.randomUUID();
  const headers = opodChatHeaders(parsed.data, requestId);
  const body = toOpodChatRequest(parsed.data);

  let upstream: Response;
  try {
    upstream = await fetchOpod("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch {
    return new Response("opod-agent unavailable", {
      headers: { [OPOD_HEADERS.requestId]: requestId },
      status: 502,
    });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(`opod-agent error ${upstream.status}`, {
      headers: { [OPOD_HEADERS.requestId]: requestId },
      status: 502,
    });
  }
  const upstreamBody = upstream.body;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let reasoningOpen = false;
      let textOpen = false;
      let done = false;

      try {
        for await (const payload of readSSEData(upstreamBody, req.signal)) {
          if (payload === "[DONE]") {
            done = true;
            break;
          }

          let chunk: {
            error?: { message?: string };
            choices?: { delta?: { content?: string; reasoning?: string } }[];
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            throw new Error("malformed upstream SSE frame");
          }

          if (chunk.error) {
            throw new Error("upstream SSE error frame");
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.reasoning) {
            if (!reasoningOpen) {
              writer.write({ type: "reasoning-start", id: "reasoning" });
              reasoningOpen = true;
            }
            writer.write({
              type: "reasoning-delta",
              id: "reasoning",
              delta: delta.reasoning,
            });
          }

          if (delta.content) {
            // Thinking always precedes the answer — close it on first content.
            if (reasoningOpen) {
              writer.write({ type: "reasoning-end", id: "reasoning" });
              reasoningOpen = false;
            }
            if (!textOpen) {
              writer.write({ type: "text-start", id: "text" });
              textOpen = true;
            }
            writer.write({
              type: "text-delta",
              id: "text",
              delta: delta.content,
            });
          }
        }
        if (!done) throw new Error("upstream SSE ended before [DONE]");
      } finally {
        if (reasoningOpen) writer.write({ type: "reasoning-end", id: "reasoning" });
        if (textOpen) writer.write({ type: "text-end", id: "text" });
      }
    },
    onError: () => "stream failed",
  });

  const response = createUIMessageStreamResponse({ stream });
  response.headers.set(OPOD_HEADERS.requestId, requestId);
  return response;
}
