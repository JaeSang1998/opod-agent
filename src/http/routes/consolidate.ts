import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../../core/container.js";
import { ChatMessage } from "../../openai/types.js";

const ConsolidateBody = z.object({
  userId: z.string().min(1),
  characterId: z.string().min(1),
  sessionId: z.string().min(1),
  turns: z.array(ChatMessage).min(1),
  refreshSummary: z.boolean().default(false),
});

/**
 * POST /memory/consolidate — invoked by opod-worker's memory-update job
 * (docs/adr/0004). Extracts long-term memory and optionally refreshes the summary.
 */
export function consolidateRoute(container: Container): Hono {
  const app = new Hono();

  app.post("/memory/consolidate", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ConsolidateBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { type: "invalid_request_error", message: parsed.error.message } }, 400);
    }

    try {
      const result = await container.consolidation.consolidate(parsed.data);
      return c.json({ ok: true, ...result });
    } catch (err) {
      container.log.error("consolidation error", { err: String(err) });
      return c.json({ error: { type: "server_error", message: String(err) } }, 500);
    }
  });

  return app;
}
