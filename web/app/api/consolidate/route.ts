import { fetchOpod } from "@/backend/opod";
import { ConsolidationRequest } from "@opod/protocol/consolidation";
import { OPOD_HEADERS } from "@opod/protocol/headers";

/** The sleep-time passes make several LLM calls — slow on a local 30B model. */
export const maxDuration = 800;

/** Thin proxy to opod-agent's POST /memory/consolidate (keeps opod off the browser's origin). */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = ConsolidationRequest.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: { type: "invalid_request_error", message: parsed.error.message } },
      { status: 400 },
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [OPOD_HEADERS.requestId]: parsed.data.correlationId,
  };
  if (process.env.OPOD_WORKER_TOKEN) {
    headers.Authorization = `Bearer ${process.env.OPOD_WORKER_TOKEN}`;
  }

  const res = await fetchOpod("/memory/consolidate", {
    method: "POST",
    headers,
    body: JSON.stringify(parsed.data),
    signal: req.signal,
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
