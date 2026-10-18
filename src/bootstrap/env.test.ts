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

  it("keeps Decisions configuration independent from chat defaults", () => {
    expect(loadEnv({})).toMatchObject({
      OPENROUTER_API_KEY: "",
      OPENROUTER_BASE_URL: "https://openrouter.ai",
      BOND_JUDGE_MODEL: "typesafe/jev-1.13",
      BOND_JUDGE_TIMEOUT_MS: 8_000,
    });
    expect(loadEnv({ BOND_JUDGE_MODEL: "explicit-model", BOND_JUDGE_TIMEOUT_MS: "500" }))
      .toMatchObject({ BOND_JUDGE_MODEL: "explicit-model", BOND_JUDGE_TIMEOUT_MS: 500 });
    for (const timeout of ["0", "-1", "Infinity", "120001"]) {
      expect(() => loadEnv({ BOND_JUDGE_TIMEOUT_MS: timeout })).toThrow("BOND_JUDGE_TIMEOUT_MS");
    }
  });
});
