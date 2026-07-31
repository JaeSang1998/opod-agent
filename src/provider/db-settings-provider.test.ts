import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { baseUrlFrom, DbSettingsProvider } from "./db-settings-provider.js";
import { noopLogger } from "../bootstrap/logger.js";

const ENV_CONFIG = {
  baseUrl: "https://env.example/v1",
  apiKey: "env-key",
  model: "env-model",
  embeddingModel: "env-embed",
};

function fakePool(rows: () => { key: string; value: string }[]) {
  const calls = { count: 0 };
  const pool = {
    async query() {
      calls.count += 1;
      return { rows: rows() };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

describe("DbSettingsProvider", () => {
  it("normalizes a stored chat-completions URL to a base URL", () => {
    expect(baseUrlFrom("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1",
    );
    expect(baseUrlFrom("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
  });

  it("prefers agent.* overrides, inherits planner.* per field, falls back to env, and refreshes on TTL", async () => {
    let settings = [
      { key: "planner.llmApiUrl", value: "https://llm.test/v1/chat/completions" },
      { key: "planner.llmApiKey", value: "planner-key" },
      { key: "planner.llmModel", value: "planner-model" },
      { key: "agent.llmModel", value: "chat-model" },
    ];
    let clock = 0;
    const { pool, calls } = fakePool(() => settings);
    const provider = new DbSettingsProvider(
      pool,
      ENV_CONFIG,
      noopLogger,
      1_000,
      () => clock,
    );

    // 모델만 오버라이드 → 키·URL은 planner 상속 (ex.1 시나리오).
    await provider.embed([]).catch(() => undefined);
    expect(provider.defaultModel).toBe("chat-model");
    expect(calls.count).toBe(1);

    // TTL 안에서는 재조회하지 않는다.
    clock = 500;
    await provider.embed([]).catch(() => undefined);
    expect(calls.count).toBe(1);

    // TTL이 지나면 재조회하고, 별도 키를 넣는 순간(ex.2) 그 키가 적용된다.
    settings = [...settings, { key: "agent.llmApiKey", value: "chat-key" }];
    clock = 1_500;
    await provider.embed([]).catch(() => undefined);
    expect(calls.count).toBe(2);
    expect(provider.defaultModel).toBe("chat-model");

    // DB 행이 전부 사라지면 env 폴백으로 복귀한다.
    settings = [];
    clock = 3_000;
    await provider.embed([]).catch(() => undefined);
    expect(provider.defaultModel).toBe("env-model");
  });
});
