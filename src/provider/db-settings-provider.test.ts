import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { noopLogger } from "../bootstrap/logger.js";
import { FakeProvider } from "../testing/fake-provider.js";
import type { ProviderConfig } from "./openai-compat-provider.js";
import {
  baseUrlFrom,
  DbSettingsProvider,
  LlmConfigUnavailableError,
} from "./db-settings-provider.js";

const COMPLETE_SETTINGS = [
  { key: "planner.llmApiUrl", value: "https://planner.test/v1/chat/completions" },
  { key: "planner.llmApiKey", value: "planner-key" },
  { key: "planner.llmModel", value: "planner-model" },
  { key: "agent.llmModel", value: "chat-model" },
  { key: "agent.embeddingApiUrl", value: "https://embed.test/v1/embeddings" },
  { key: "agent.embeddingApiKey", value: "embed-key" },
  { key: "agent.embeddingModel", value: "embed-model" },
];

function fakePool(rows: () => { key: string; value: string }[]) {
  const calls = { count: 0 };
  const pool = {
    async query() {
      calls.count += 1;
      return { rows: rows() };
    },
  };
  return { pool: pool as unknown as Pick<Pool, "query">, calls };
}

function providerWithCapturedConfig(configs: ProviderConfig[]) {
  return (config: ProviderConfig) => {
    configs.push(config);
    const provider = new FakeProvider();
    Object.defineProperty(provider, "defaultModel", { value: config.model });
    return provider;
  };
}

describe("DbSettingsProvider", () => {
  it("normalizes stored operation URLs to OpenAI client base URLs", () => {
    expect(baseUrlFrom("https://api.test/v1/chat/completions", "chat/completions")).toBe(
      "https://api.test/v1",
    );
    expect(baseUrlFrom("https://api.test/v1/embeddings", "embeddings")).toBe(
      "https://api.test/v1",
    );
  });

  it("rejects malformed or mismatched DB API URLs as unavailable configuration", () => {
    expect(() => baseUrlFrom("not-a-url", "chat/completions")).toThrow(
      LlmConfigUnavailableError,
    );
    expect(() => baseUrlFrom("https://api.test/v1/embeddings", "chat/completions")).toThrow(
      LlmConfigUnavailableError,
    );
  });

  it("uses DB-only chat settings and a separately configured embedding endpoint and key", async () => {
    const configs: ProviderConfig[] = [];
    const { pool, calls } = fakePool(() => COMPLETE_SETTINGS);
    const provider = new DbSettingsProvider(
      pool as unknown as Pick<Pool, "query">,
      noopLogger,
      providerWithCapturedConfig(configs),
    );

    await provider.embed(["memory"]);

    expect(calls.count).toBe(1);
    expect(configs).toEqual([
      {
        baseUrl: "https://planner.test/v1",
        apiKey: "planner-key",
        model: "chat-model",
        embeddingBaseUrl: "https://embed.test/v1",
        embeddingApiKey: "embed-key",
        embeddingModel: "embed-model",
      },
    ]);
  });

  it("rejects incomplete DB settings instead of falling back to environment defaults", async () => {
    const { pool } = fakePool(() => []);
    const provider = new DbSettingsProvider(pool, noopLogger);

    await expect(provider.embed([])).rejects.toBeInstanceOf(LlmConfigUnavailableError);
  });

  it("fails closed after a DB lookup error instead of using the last successful provider", async () => {
    let fail = false;
    const pool = {
      async query() {
        if (fail) throw new Error("database unavailable");
        return { rows: COMPLETE_SETTINGS };
      },
    };
    const provider = new DbSettingsProvider(
      pool as unknown as Pick<Pool, "query">,
      noopLogger,
      providerWithCapturedConfig([]),
    );

    await expect(provider.embed([])).resolves.toEqual([]);
    fail = true;
    await expect(provider.embed([])).rejects.toBeInstanceOf(LlmConfigUnavailableError);
  });
});
