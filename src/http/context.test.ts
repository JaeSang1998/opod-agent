import { describe, it, expect } from "vitest";
import { buildContainer } from "../bootstrap/container.js";
import { loadEnv } from "../bootstrap/env.js";
import { noopLogger } from "../bootstrap/logger.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { createApp } from "./app.js";
import { getRequestContext } from "./context.js";

/**
 * Build the real Hono app (so contextMiddleware runs exactly as wired in app.ts)
 * and mount a probe route that echoes the RequestContext the middleware produced.
 */
function buildApp() {
  const container = buildContainer(loadEnv({}), {
    provider: new FakeProvider(),
    log: noopLogger,
  });
  const app = createApp(container);
  // The `app.use("*", contextMiddleware)` registered inside createApp still runs
  // ahead of this later-registered route, so it observes the seam's real output.
  app.get("/__ctx", (c) => c.json(getRequestContext(c)));
  return app;
}

describe("contextMiddleware -> RequestContext", () => {
  it("populates all three fields when every header is present", async () => {
    const app = buildApp();
    const res = await app.request("/__ctx", {
      headers: {
        "x-opod-character-id": "luna",
        "x-opod-user-id": "u1",
        "x-opod-session-id": "s1",
      },
    });

    expect(await res.json()).toEqual({
      characterId: "luna",
      requestId: expect.any(String),
      sessionId: "s1",
      userId: "u1",
    });
  });

  it("leaves every field undefined when no header is present", async () => {
    const app = buildApp();
    const res = await app.request("/__ctx");

    // undefined fields are dropped by JSON serialization.
    expect(await res.json()).toEqual({ requestId: expect.any(String) });
  });

  it("sets only the supplied fields when headers are mixed", async () => {
    const app = buildApp();
    const res = await app.request("/__ctx", {
      headers: {
        "x-opod-character-id": "luna",
        "x-opod-session-id": "s1",
      },
    });

    expect(await res.json()).toEqual({
      characterId: "luna",
      requestId: expect.any(String),
      sessionId: "s1",
    });
  });

  it("parses x-opod-timezone into ctx.timezone", async () => {
    const app = buildApp();
    const res = await app.request("/__ctx", {
      headers: { "x-opod-timezone": "Europe/Zurich" },
    });

    expect(await res.json()).toEqual({
      requestId: expect.any(String),
      timezone: "Europe/Zurich",
    });
  });

  it("leaves timezone undefined when the header is absent", async () => {
    const app = buildApp();
    const res = await app.request("/__ctx");

    // undefined is dropped by JSON serialization.
    expect(await res.json()).toEqual({ requestId: expect.any(String) });
  });

  it("preserves a caller request ID and echoes it on the response", async () => {
    const app = buildApp();
    const res = await app.request("/__ctx", {
      headers: { "x-request-id": "trace-123" },
    });

    expect(await res.json()).toEqual({ requestId: "trace-123" });
    expect(res.headers.get("x-request-id")).toBe("trace-123");
  });
});
