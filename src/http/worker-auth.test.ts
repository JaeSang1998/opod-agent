import { describe, expect, it } from "vitest";
import { isAuthorizedWorker } from "./worker-auth.js";

describe("isAuthorizedWorker", () => {
  it("allows local development when no token is configured", () => {
    expect(isAuthorizedWorker(undefined, undefined)).toBe(true);
  });

  it("accepts only the configured Bearer token", () => {
    expect(isAuthorizedWorker("secret-token", "Bearer secret-token")).toBe(true);
    expect(isAuthorizedWorker("secret-token", "Bearer wrong-token")).toBe(false);
    expect(isAuthorizedWorker("secret-token", "secret-token")).toBe(false);
    expect(isAuthorizedWorker("secret-token", undefined)).toBe(false);
  });
});
