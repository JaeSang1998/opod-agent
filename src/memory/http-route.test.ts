import { describe, it, expect } from "vitest";
import { buildContainer } from "../bootstrap/container.js";
import { loadEnv } from "../bootstrap/env.js";
import { noopLogger } from "../bootstrap/logger.js";
import { createApp } from "../http/app.js";
import type { LLMProvider } from "../provider/llm-provider.js";
import { FakeProvider } from "../testing/fake-provider.js";
import type { ConsolidationService } from "./consolidation.js";
import { StubMemoryStore } from "./stub-memory-store.js";

const weights = { recency: 1, importance: 1, relevance: 1 };
const now = () => "2026-01-01T00:00:00Z";

/** Assemble the real Hono app; provider + consolidation are injectable. */
function buildApp(
  opts: {
    provider?: LLMProvider;
    consolidation?: ConsolidationService;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const provider = opts.provider ?? new FakeProvider();
  const memory = new StubMemoryStore(now);
  const container = buildContainer(loadEnv({
    REFLECTION_IMPORTANCE_THRESHOLD: "1000",
    ...opts.env,
  }), {
    provider,
    memory,
    log: noopLogger,
  });
  return {
    app: createApp(opts.consolidation ? { ...container, consolidation: opts.consolidation } : container),
    memory,
  };
}

describe("POST /memory/consolidate", () => {
  it("consolidates a valid body and makes the observation retrievable from the store", async () => {
    const provider = new FakeProvider(
      "reply",
      '[{"content":"User has a cat named Nova.","importance":6}]',
    );
    const { app, memory } = buildApp({ provider });

    const res = await app.request("/memory/consolidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        correlationId: "request-http-valid",
        idempotencyKey: "job-http-valid",
        reason: "manual",
        userId: "u1",
        characterId: "luna",
        sessionId: "s1",
        turns: [{ role: "user", content: "I have a cat named Nova." }],
        refreshSummary: false,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; observationsStored: number };
    expect(json.ok).toBe(true);
    expect(json.observationsStored).toBe(1);
    expect(res.headers.get("x-request-id")).toBe("request-http-valid");

    const stored = await memory.retrieve({ userId: "u1", characterId: "luna" }, [1, 2, 3, 4], 5, {
      weights,
      recencyDecay: 0.99,
    });
    expect(stored.map((m) => m.content)).toContain("User has a cat named Nova.");
  });

  it("rejects a body missing sessionId with a 400 invalid_request_error", async () => {
    const { app } = buildApp();
    const res = await app.request("/memory/consolidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        correlationId: "request-http-invalid",
        idempotencyKey: "job-http-invalid",
        reason: "manual",
        userId: "u1",
        characterId: "luna",
        turns: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("invalid_request_error");
  });

  it("maps a service throw to a 500 with a generic message that leaks no internals", async () => {
    const SECRET = "LEAKED_DSN postgres://user:pw@db.internal/prod";
    const throwing = {
      consolidate: async () => {
        throw new Error(SECRET);
      },
    } as unknown as ConsolidationService;
    const { app } = buildApp({ consolidation: throwing });

    const res = await app.request("/memory/consolidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        correlationId: "request-http-error",
        idempotencyKey: "job-http-error",
        reason: "manual",
        userId: "u1",
        characterId: "luna",
        sessionId: "s1",
        turns: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain("postgres");
    expect(raw).not.toContain("LEAKED_DSN");
    const json = JSON.parse(raw) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("server_error");
    expect(json.error.message).toBe("internal server error");
  });

  it("requires the configured worker Bearer token", async () => {
    const { app } = buildApp({ env: { OPOD_WORKER_TOKEN: "a-very-long-worker-token" } });
    const body = JSON.stringify({
      characterId: "luna",
      correlationId: "request-auth",
      idempotencyKey: "job-auth",
      reason: "manual",
      refreshSummary: false,
      sessionId: "s1",
      turns: [{ role: "user", content: "hello" }],
      userId: "u1",
    });

    const rejected = await app.request("/memory/consolidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(rejected.status).toBe(401);

    const accepted = await app.request("/memory/consolidate", {
      method: "POST",
      headers: {
        authorization: "Bearer a-very-long-worker-token",
        "content-type": "application/json",
      },
      body,
    });
    expect(accepted.status).toBe(200);
  });

  it("rejects request bodies above the configured size limit", async () => {
    const { app } = buildApp({ env: { MAX_REQUEST_BYTES: "64" } });
    const response = await app.request("/memory/consolidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oversized: "x".repeat(256) }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "request_too_large" },
    });
  });
});
