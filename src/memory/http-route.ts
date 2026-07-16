import { Hono } from "hono";
import type { Container } from "../bootstrap/container.js";
import { ConsolidationRequest } from "../protocol/index.js";
import { openaiError } from "../http/errors.js";
import { classifyRequestError, createRequestSignal } from "../http/request-lifecycle.js";
import { isAuthorizedWorker } from "../http/worker-auth.js";

/**
 * POST /memory/consolidate — invoked by opod-worker's memory-update job
 * (docs/adr/0004). Extracts long-term memory and optionally refreshes the summary.
 */
export function consolidateRoute(container: Container): Hono {
  const app = new Hono();

  app.post("/memory/consolidate", async (c) => {
    if (!isAuthorizedWorker(container.env.OPOD_WORKER_TOKEN, c.req.header("authorization"))) {
      return c.json(openaiError("authentication_error", "invalid worker credentials"), 401);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = ConsolidationRequest.safeParse(raw);
    if (!parsed.success) {
      return c.json(openaiError("invalid_request_error", parsed.error.message), 400);
    }

    try {
      const signal = createRequestSignal(c.req.raw.signal, container.env.LLM_REQUEST_TIMEOUT_MS);
      const result = await container.consolidation.consolidate(parsed.data, signal);
      return c.json({ ok: true, ...result });
    } catch (err) {
      const failure = classifyRequestError(err);
      container.log.error("consolidation error", {
        correlationId: parsed.data.correlationId,
        err: String(err),
      });
      return c.json(openaiError(failure.type, failure.message), failure.status);
    }
  });

  return app;
}
