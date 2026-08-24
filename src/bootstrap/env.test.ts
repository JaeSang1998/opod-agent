import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv deployment safety", () => {
  it("allows a DB-less test process without worker authentication", () => {
    expect(loadEnv({}).OPOD_WORKER_TOKEN).toBeUndefined();
  });

  it("requires worker authentication whenever Postgres is configured", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://db/opod" })).toThrow(
      "OPOD_WORKER_TOKEN",
    );
    expect(
      loadEnv({
        DATABASE_URL: "postgres://db/opod",
        OPOD_WORKER_TOKEN: "a-very-long-worker-token",
      }).DATABASE_URL,
    ).toBe("postgres://db/opod");
  });
});
