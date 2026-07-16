import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv deployment safety", () => {
  it("allows the local stub driver without worker authentication", () => {
    expect(loadEnv({ STORE_DRIVER: "stub" }).OPOD_WORKER_TOKEN).toBeUndefined();
  });

  it("requires worker authentication for a deployment persistence driver", () => {
    expect(() => loadEnv({ STORE_DRIVER: "postgres" })).toThrow("OPOD_WORKER_TOKEN");
    expect(
      loadEnv({
        OPOD_WORKER_TOKEN: "a-very-long-worker-token",
        STORE_DRIVER: "postgres",
      }).STORE_DRIVER,
    ).toBe("postgres");
  });
});
