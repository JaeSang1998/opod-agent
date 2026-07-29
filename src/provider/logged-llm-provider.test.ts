import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "./llm-provider.js";
import {
  LoggedLlmProvider,
  PostgresLlmLogStore,
  type LlmLogStore,
  redactLlmPayload,
} from "./logged-llm-provider.js";

type StartInput = Parameters<LlmLogStore["start"]>[0];
type SuccessInput = Parameters<LlmLogStore["succeed"]>[1];

class TestStore implements LlmLogStore {
  started: StartInput[] = [];
  succeeded: SuccessInput[] = [];
  startError?: Error;
  succeedError?: Error;

  async start(input: StartInput): Promise<bigint> {
    if (this.startError) throw this.startError;
    this.started.push(input);
    return 1n;
  }

  async succeed(_log: { id: bigint; redactedPaths: string[] }, result: SuccessInput): Promise<void> {
    if (this.succeedError) throw this.succeedError;
    this.succeeded.push(result);
  }

  fail(): Promise<void> {
    return Promise.resolve();
  }
}

function completion(): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: "hello", refusal: null },
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}

function baseProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    defaultModel: "test-model",
    chat: vi.fn().mockResolvedValue(completion()),
    chatStream: vi.fn(),
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    ...overrides,
  };
}

function logged(provider: LLMProvider, store: LlmLogStore, onFinishWriteError?: () => void) {
  return new LoggedLlmProvider(provider, store, {
    provider: "openai-compatible",
    chatEndpoint: "https://api.example.com/v1/chat/completions",
    embeddingEndpoint: "https://api.example.com/v1/embeddings",
    embeddingModel: "embed-model",
    onFinishWriteError,
  });
}

describe("LoggedLlmProvider", () => {
  it("does not call the provider when the initial log insert fails", async () => {
    const store = new TestStore();
    store.startError = new Error("database unavailable");
    const provider = baseProvider();

    await expect(
      logged(provider, store).chat({ model: "test-model", messages: [] }),
    ).rejects.toThrow("database unavailable");
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns the model response when only the completion update fails", async () => {
    const store = new TestStore();
    store.succeedError = new Error("database unavailable");
    const onFinishWriteError = vi.fn();

    await expect(
      logged(baseProvider(), store, onFinishWriteError).chat({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).resolves.toMatchObject({ id: "chatcmpl-1" });
    expect(onFinishWriteError).toHaveBeenCalledOnce();
  });

  it("records embedding dimensions without persisting raw vectors", async () => {
    const store = new TestStore();

    await logged(baseProvider(), store).embed(["hello"]);

    expect(store.succeeded[0]?.responseJson).toMatchObject({
      data: [{ index: 0, dimensions: 2, embedding: "[REDACTED]" }],
    });
    expect(store.succeeded[0]?.redactedPaths).toContain("$.response.data[0].embedding");
    expect(JSON.stringify(store.succeeded[0]?.responseJson)).not.toContain("0.1");
  });

  it("stores one assembled response instead of streaming chunks", async () => {
    const store = new TestStore();
    const provider = baseProvider({
      chatStream: vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "hel" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          };
          yield {
            id: "chatcmpl-stream",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [
              {
                index: 0,
                delta: { content: "lo" },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          };
        })(),
      ),
    });

    const stream = await logged(provider, store).chatStream({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    for await (const _chunk of stream) {
      // Consuming the stream is what finalizes the log.
    }

    expect(store.succeeded[0]?.responseJson).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { total_tokens: 3 },
    });
  });

  it("redacts metadata and signed endpoint query values before insertion", async () => {
    const store = new TestStore();
    const provider = new LoggedLlmProvider(baseProvider(), store, {
      provider: "openai-compatible",
      chatEndpoint:
        "https://api.example.com/v1/chat?X-Amz-Signature=secret&version=1",
      embeddingEndpoint: "https://api.example.com/v1/embeddings",
      embeddingModel: "embed-model",
    });

    await provider.chat(
      { model: "test-model", messages: [{ role: "user", content: "hello" }] },
      {
        log: {
          type: "agent.chat",
          metadata: { apiKey: "secret", source: "test" },
        },
      },
    );

    expect(store.started[0]).toMatchObject({
      endpoint: "https://api.example.com/v1/chat?version=1",
      context: { metadata: { apiKey: "[REDACTED]", source: "test" } },
    });
    expect(store.started[0]?.redactedPaths).toEqual(
      expect.arrayContaining([
        "$.metadata.apiKey",
        "$.endpoint.query.X-Amz-Signature",
      ]),
    );
  });
});

describe("PostgresLlmLogStore", () => {
  it("persists running, succeeded, and failed lifecycle fields", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "42" }] })
      .mockResolvedValue({ rows: [] });
    const store = new PostgresLlmLogStore({ query } as never);
    const id = await store.start({
      type: "agent.chat",
      provider: "openai-compatible",
      model: "test-model",
      endpoint: "https://api.example.com/v1/chat",
      isStreaming: false,
      context: {
        requestId: "request-1",
        userId: "user-1",
        characterId: "character-1",
        type: "agent.chat",
        metadata: { source: "test" },
      },
      systemPromptJson: [{ role: "system", content: "system" }],
      userPromptJson: [{ role: "user", content: "hello" }],
      requestJson: { model: "test-model" },
      redactedPaths: ["$.request.apiKey"],
    });

    expect(id).toBe(42n);
    await store.succeed(
      { id, redactedPaths: ["$.request.apiKey"] },
      {
        responseJson: { id: "chat-1" },
        redactedPaths: ["$.response.secret"],
        providerRequestId: "provider-1",
        httpStatus: 200,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      },
    );
    await store.fail(
      { id, redactedPaths: [] },
      Object.assign(new Error("Bearer hidden-token"), {
        status: 429,
        request_id: "provider-2",
        body: { apiKey: "secret" },
      }),
    );

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        "42",
        JSON.stringify({ id: "chat-1" }),
        ["$.request.apiKey", "$.response.secret"],
        "provider-1",
        200,
        2,
        3,
        5,
      ]),
    );
    expect(query.mock.calls[2]?.[1]).toEqual(
      expect.arrayContaining([
        "42",
        expect.arrayContaining(["$.response.apiKey", "$.errorMessage"]),
        "provider-2",
        429,
        "Error",
        "Bearer [REDACTED]",
        JSON.stringify({ apiKey: "[REDACTED]" }),
      ]),
    );
  });
});

describe("redactLlmPayload", () => {
  it("removes secrets, image base64, and signed URL query values while preserving paths", () => {
    const result = redactLlmPayload({
      apiKey: "secret",
      image: "data:image/png;base64,AAAA",
      url: "https://bucket.example/a.png?X-Amz-Signature=sig&width=100",
    });

    expect(result.value).toEqual({
      apiKey: "[REDACTED]",
      image: "[REDACTED]",
      url: "https://bucket.example/a.png?width=100",
    });
    expect(result.redactedPaths).toEqual([
      "$.apiKey",
      "$.image",
      "$.url.query.X-Amz-Signature",
    ]);
  });
});
