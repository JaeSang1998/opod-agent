import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { buildContainer } from "../bootstrap/container.js";
import { loadEnv } from "../bootstrap/env.js";
import { noopLogger } from "../bootstrap/logger.js";
import { createApp } from "../http/app.js";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { StubMemoryStore } from "../memory/stub-memory-store.js";
import type { LLMProvider, ProviderCallOptions } from "../provider/llm-provider.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { ScriptedProvider, textTurn, toolCallTurn } from "../testing/scripted-provider.js";
import type { AgentTool } from "../tools/index.js";
const now = () => "2026-01-01T00:00:00Z";

/** Assemble the real Hono app over stub stores + an injectable provider. */
function buildApp(
  provider: LLMProvider = new FakeProvider(),
  tools?: AgentTool[],
  env: NodeJS.ProcessEnv = {},
) {
  const memory = new StubMemoryStore(now);
  const queue = new StubJobQueue();
  const container = buildContainer(loadEnv({
    REFLECTION_IMPORTANCE_THRESHOLD: "1000",
    ...env,
  }), {
    provider,
    memory,
    queue,
    tools,
    log: noopLogger,
  });
  return { app: createApp(container), memory, queue, provider };
}

/** A tool that always returns a canned string, used to drive the server tool loop. */
function stubTool(name: string, result: string): AgentTool {
  return {
    definition: { type: "function", function: { name, parameters: { type: "object", properties: {} } } },
    async execute() {
      return result;
    },
  };
}

/** Full identity: persona is loaded AND consolidation is enqueued. */
const IDENTITY = {
  "content-type": "application/json",
  "x-opod-character-id": "luna",
  "x-opod-history-offset": "0",
  "x-opod-user-id": "u1",
  "x-opod-session-id": "s1",
  "x-opod-turn-id": "turn-http-1",
};

/** Reassemble the assistant text from the SSE `data:` frames (skips [DONE] and any
 *  debug `event: opod` frames, whose data is a tool event, not a chat chunk). */
function reassembleSSE(text: string): string {
  return text
    .split("\n\n")
    .filter((block) => !block.split("\n").some((l) => l.startsWith("event:")))
    .flatMap((block) => block.split("\n").filter((l) => l.startsWith("data:")))
    .map((l) => l.slice("data:".length).trimStart())
    .filter((p) => p !== "[DONE]" && p !== "")
    .map((p) => {
      const chunk = JSON.parse(p) as OpenAI.Chat.Completions.ChatCompletionChunk;
      return chunk.choices[0]?.delta?.content ?? "";
    })
    .join("");
}

/** Parse the debug `event: opod` SSE frames into their tool events. */
function parseOpodEvents(text: string): { type: string; tool?: string }[] {
  return text
    .split("\n\n")
    .filter((block) => block.split("\n").some((l) => l.trim() === "event: opod"))
    .map((block) => block.split("\n").find((l) => l.startsWith("data:"))!.slice("data:".length).trim())
    .map((data) => JSON.parse(data) as { type: string; tool?: string });
}

describe("POST /v1/chat/completions", () => {
  it("requires a logical turn id when full learning identity is present", async () => {
    const { app } = buildApp();
    const { "x-opod-turn-id": _turnId, ...headers } = IDENTITY;
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { type: "invalid_request_error" } });
  });

  it("rejects an invalid absolute history offset", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...IDENTITY, "x-opod-history-offset": "not-an-integer" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: { type: "invalid_request_error" } });
  });

  it("rejects a malformed body with a 400 OpenAI-style error envelope", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("invalid_request_error");
    expect(typeof json.error.message).toBe("string");
  });

  it("returns a completion and enqueues exactly one consolidation job carrying the assistant reply", async () => {
    const { app, queue } = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: IDENTITY,
      body: JSON.stringify({ messages: [{ role: "user", content: "My cat is named Nova." }] }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as OpenAI.Chat.Completions.ChatCompletion;
    expect(json.choices[0]?.message?.content).toBe("Hello from the stars.");

    expect(queue.enqueued).toHaveLength(1);
    const job = queue.enqueued[0]!;
    expect(job.sessionId).toBe("s1");
    const assistantTurn = job.turns.find((t) => t.role === "assistant");
    expect(assistantTurn?.content).toBe("Hello from the stars.");
  });

  it("streams SSE chunks that reassemble to the full reply and enqueues the matching turn", async () => {
    const { app, queue } = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: IDENTITY,
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "My cat is named Nova." }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");
    // FakeProvider streams "word " chunks; trim the trailing space before comparing.
    expect(reassembleSSE(text).trim()).toBe("Hello from the stars.");

    expect(queue.enqueued).toHaveLength(1);
    const assistantTurn = queue.enqueued[0]!.turns.find((t) => t.role === "assistant");
    expect(String(assistantTurn?.content).trim()).toBe("Hello from the stars.");
  });

  it("does not consolidate a partial reply when the provider stream fails", async () => {
    class PartialStreamProvider extends FakeProvider {
      override async chatStream(): Promise<
        AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
      > {
        async function* stream() {
          yield {
            id: "partial",
            object: "chat.completion.chunk",
            created: 0,
            model: "fake-model",
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          } as OpenAI.Chat.Completions.ChatCompletionChunk;
          throw new Error("stream interrupted");
        }
        return stream();
      }
    }

    const { app, queue } = buildApp(new PartialStreamProvider());
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: IDENTITY,
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(await response.text()).toContain("server_error");
    expect(queue.enqueued).toHaveLength(0);
  });

  it("maps a provider failure to a 5xx with a generic message that leaks no internals", async () => {
    const SECRET = "LEAKED_DSN postgres://user:pw@db.internal/prod";
    class FailingProvider implements LLMProvider {
      readonly defaultModel = "fake-model";
      async chat(): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        throw new Error(SECRET);
      }
      async chatStream(): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
        throw new Error(SECRET);
      }
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => [0]);
      }
    }

    // No character header -> plain proxy, so the failure originates in provider.chat.
    const { app } = buildApp(new FailingProvider());
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain("postgres");
    expect(raw).not.toContain("LEAKED_DSN");
    const json = JSON.parse(raw) as { error: { type: string; message: string } };
    expect(json.error.type).toBe("server_error");
    expect(json.error.message).toBe("internal server error");
  });

  it("maps the configured Provider deadline to a 504 timeout_error", async () => {
    class HangingProvider extends FakeProvider {
      override async chat(
        _req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        options?: ProviderCallOptions,
      ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        return new Promise((_, reject) => {
          const signal = options?.signal;
          if (!signal) return reject(new Error("missing signal"));
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    }

    const { app } = buildApp(new HangingProvider(), undefined, {
      LLM_REQUEST_TIMEOUT_MS: "5",
    });
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: { type: "timeout_error" } });
  });
});

describe("POST /v1/chat/completions with the server tool loop", () => {
  it("runs the tool loop and returns the final completion, consolidating only the final text", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: '{"timezone":"UTC"}' }]),
      textTurn("It's midnight among the stars."),
    ]);
    const { app, queue } = buildApp(provider, [stubTool("get_time", "2026-01-01 00:00 in UTC")]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: IDENTITY,
      // A memorable phrasing so the consolidation policy enqueues (it gates on a
      // memory cue in the latest user turn); the tool loop still runs get_time.
      body: JSON.stringify({ messages: [{ role: "user", content: "I want to know what time it is." }] }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as OpenAI.Chat.Completions.ChatCompletion;
    expect(json.choices[0]?.message?.content).toBe("It's midnight among the stars.");

    // The provider was driven twice (tool turn, then the text turn).
    expect(provider.requests).toHaveLength(2);
    // Consolidation carries only the final user-visible text, not the tool traffic.
    expect(queue.enqueued).toHaveLength(1);
    const assistantTurn = queue.enqueued[0]!.turns.find((t) => t.role === "assistant");
    expect(assistantTurn?.content).toBe("It's midnight among the stars.");
  });

  it("streams the tool loop as SSE that reassembles to the final text only, ending with [DONE]", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
      textTurn("Late, as always."),
    ]);
    const { app, queue } = buildApp(provider, [stubTool("get_time", "late")]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: IDENTITY,
      body: JSON.stringify({
        stream: true,
        // Memorable phrasing so consolidation enqueues (see the note above).
        messages: [{ role: "user", content: "I want to know what time it is." }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");
    // The tool turn is fully suppressed; only the final text reaches the client.
    expect(reassembleSSE(text)).toBe("Late, as always.");
    expect(text).not.toContain("tool_calls");

    expect(queue.enqueued).toHaveLength(1);
    const assistantTurn = queue.enqueued[0]!.turns.find((t) => t.role === "assistant");
    expect(String(assistantTurn?.content)).toBe("Late, as always.");
  });
});

describe("POST /v1/chat/completions tool-loop debug channel (x-opod-debug)", () => {
  const DEBUG = { ...IDENTITY, "x-opod-debug": "1" };

  it("with the header, streaming emits event: opod frames without altering the content", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
      textTurn("Late, as always."),
    ]);
    const { app } = buildApp(provider, [stubTool("get_time", "late")]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: DEBUG,
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "what time is it?" }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: opod");
    const events = parseOpodEvents(text);
    expect(events.some((e) => e.type === "tool_call" && e.tool === "get_time")).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && e.tool === "get_time")).toBe(true);
    // The user-visible reply is unchanged by the debug frames.
    expect(reassembleSSE(text)).toBe("Late, as always.");
  });

  it("without the header, streaming carries no event: lines and the content is unchanged", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
      textTurn("Late, as always."),
    ]);
    const { app } = buildApp(provider, [stubTool("get_time", "late")]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: IDENTITY,
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "what time is it?" }],
      }),
    });

    const text = await res.text();
    expect(text).not.toContain("event:");
    expect(reassembleSSE(text)).toBe("Late, as always.");
  });

  it("with the header, the non-streaming body carries opod_debug.events", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
      textTurn("It's midnight among the stars."),
    ]);
    const { app } = buildApp(provider, [stubTool("get_time", "midnight")]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: DEBUG,
      body: JSON.stringify({ messages: [{ role: "user", content: "what time is it?" }] }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as OpenAI.Chat.Completions.ChatCompletion & {
      opod_debug?: { events: { type: string; tool?: string }[] };
    };
    expect(json.choices[0]?.message?.content).toBe("It's midnight among the stars.");
    expect(json.opod_debug?.events).toHaveLength(2);
    expect(json.opod_debug?.events[0]).toMatchObject({ type: "tool_call", tool: "get_time" });
    expect(json.opod_debug?.events[1]).toMatchObject({ type: "tool_result", tool: "get_time" });
  });

  it("without the header, the non-streaming body has no opod_debug key", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
      textTurn("It's midnight among the stars."),
    ]);
    const { app } = buildApp(provider, [stubTool("get_time", "midnight")]);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: IDENTITY,
      body: JSON.stringify({ messages: [{ role: "user", content: "what time is it?" }] }),
    });

    const json = (await res.json()) as Record<string, unknown>;
    expect("opod_debug" in json).toBe(false);
  });
});
