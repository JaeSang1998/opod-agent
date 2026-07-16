import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

afterEach(() => vi.restoreAllMocks());

describe("createLogger", () => {
  it("redacts credentials, tokens, and API keys before emitting metadata", () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    const logger = createLogger("debug");

    logger.error("failed", {
      apiKey: "sk-super-secret-key",
      authorization: "Bearer worker-secret",
      err: "connect postgres://alice:password@db.internal/opod with sk-another-secret",
    });

    const rendered = output.join("\n");
    expect(rendered).not.toContain("super-secret");
    expect(rendered).not.toContain("worker-secret");
    expect(rendered).not.toContain("alice:password");
    expect(rendered).not.toContain("another-secret");
    expect(rendered).toContain("[REDACTED]");
  });

  it("keeps ordinary structured metadata readable", () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    createLogger("info").info("request complete", { requestId: "req-1", status: 200 });
    expect(output[0]).toContain('"requestId":"req-1"');
    expect(output[0]).toContain('"status":200');
  });
});
