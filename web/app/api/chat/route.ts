import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { fetchOpod } from "@/backend/opod";
import { PlaygroundChatRequest } from "@/backend/chat-contract";
import { opodChatHeaders, toOpodChatRequest } from "@/backend/opod-chat-request";
import { readSSEEvents } from "@/chat/openai-sse";
import { createToolEventReducer } from "@/chat/tool-events";
import { CharacterExperience, OPOD_HEADERS } from "@opod/protocol";

/** A 30B reasoning model on local hardware is slow — don't cut it off. */
export const maxDuration = 800;

/** Bridge text and explicitly public character events to AI SDK UI parts.
 * Provider reasoning is never a display channel, including from older agents. */
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
      let experience: CharacterExperience = {};
      let textOpen = false;
      let done = false;
      const reduceToolEvent = createToolEventReducer();

      try {
        for await (const frame of readSSEEvents(upstreamBody, req.signal)) {
          // opod-agent interleaves "event: opod" tool-activity frames between the
          // OpenAI data chunks — reconcile them into data-opodTool UI parts (by id,
          // so a running chip updates in place to done) and never let them reach the
          // OpenAI-chunk JSON path below.
          if (frame.event === "opod") {
            let toolEvent: unknown;
            try {
              toolEvent = JSON.parse(frame.data);
            } catch {
              continue;
            }
            if (typeof toolEvent === "object" && toolEvent !== null && "tool" in toolEvent &&
              (toolEvent.tool === "express_thought" || toolEvent.tool === "share_photo")) continue;
            const part = reduceToolEvent(toolEvent);
            if (part) writer.write({ type: "data-opodTool", id: part.id, data: part });
            continue;
          }

          if (frame.event === "character") {
            try {
              const parsed = CharacterExperience.safeParse(JSON.parse(frame.data));
              if (parsed.success) {
                experience = { ...experience, ...parsed.data };
                writer.write({ type: "data-opodCharacter", id: "character", data: experience });
              }
            } catch { continue; }
            continue;
          }
          if (frame.event) continue;

          const payload = frame.data;
          if (payload === "[DONE]") {
            done = true;
            break;
          }

          let chunk: {
            error?: { message?: string };
            choices?: { delta?: { content?: string } }[];
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


          if (delta.content) {
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
        if (textOpen) writer.write({ type: "text-end", id: "text" });
      }
    },
    onError: () => "stream failed",
  });

  const response = createUIMessageStreamResponse({ stream });
  response.headers.set(OPOD_HEADERS.requestId, requestId);
  return response;
}
