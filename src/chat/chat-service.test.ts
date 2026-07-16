import { describe, it, expect } from "vitest";
import { ChatService } from "./chat-service.js";
import { StubPersonaStore } from "../persona/stub-persona-store.js";
import { StubMemoryStore } from "../memory/stub-memory-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { buildDefaultTools } from "../tools/index.js";
import { noopLogger } from "../bootstrap/logger.js";
import type { ChatCompletionRequest } from "../protocol/chat.js";

const config = {
  retrieveTopK: 6,
  weights: { recency: 1, importance: 1, relevance: 1 },
  recencyDecay: 0.99,
  summaryTurnThreshold: 6,
};

function makeService(
  provider = new FakeProvider(),
  memory: MemoryStore = new StubMemoryStore(),
) {
  const queue = new StubJobQueue();
  const service = new ChatService(
    provider,
    new StubPersonaStore(),
    memory,
    queue,
    config,
  );
  return { service, queue, provider, memory };
}

/** Full identity — every retrieval branch (memories / core / summary) fires. */
const fullCtx = { characterId: "luna", userId: "u1", sessionId: "s1" };

/**
 * Wraps a StubMemoryStore so a chosen read method rejects, exercising each of
 * ChatService's three retrieval try/catch fallbacks. Everything else delegates.
 */
class ThrowingMemoryStore extends StubMemoryStore {
  constructor(
    private readonly failOn: { retrieve?: boolean; core?: boolean; summary?: boolean },
  ) {
    super();
  }

  override async retrieve(...args: Parameters<StubMemoryStore["retrieve"]>) {
    if (this.failOn.retrieve) throw new Error("retrieve boom");
    return super.retrieve(...args);
  }

  override async getCoreMemory(...args: Parameters<StubMemoryStore["getCoreMemory"]>) {
    if (this.failOn.core) throw new Error("getCoreMemory boom");
    return super.getCoreMemory(...args);
  }

  override async getSummary(...args: Parameters<StubMemoryStore["getSummary"]>) {
    if (this.failOn.summary) throw new Error("getSummary boom");
    return super.getSummary(...args);
  }
}

const body: ChatCompletionRequest = {
  messages: [{ role: "user", content: "My cat is named Nova." }],
};

describe("ChatService.prepare", () => {
  it("prepends a persona system prompt when a character is set", async () => {
    const { service } = makeService();
    const prepared = await service.prepare(body, { characterId: "luna" });
    const first = prepared.request.messages[0];
    expect(first?.role).toBe("system");
    expect(String(first?.content)).toContain("You are Luna.");
  });

  it("degrades to a plain proxy when no character header is present", async () => {
    const { service } = makeService();
    const prepared = await service.prepare(body, {});
    // No system prompt injected — messages untouched.
    expect(prepared.request.messages[0]?.role).toBe("user");
  });

  it("enqueues a memory-update job after a personalized turn", async () => {
    const { service, queue } = makeService();
    const prepared = await service.prepare(body, {
      characterId: "luna",
      userId: "u1",
      sessionId: "s1",
    });
    await prepared.postTurn("What a great name!");
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.sessionId).toBe("s1");
    expect(queue.enqueued[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not enqueue when identity is incomplete", async () => {
    const { service, queue } = makeService();
    const prepared = await service.prepare(body, { characterId: "luna" });
    await prepared.postTurn("reply");
    expect(queue.enqueued).toHaveLength(0);
  });

  it("does not enqueue a transient question while the Summary is fresh", async () => {
    const { service, queue } = makeService();
    const prepared = await service.prepare(
      { messages: [{ role: "user", content: "What time is it?" }] },
      fullCtx,
    );
    await prepared.postTurn("Noon.");
    expect(queue.enqueued).toHaveLength(0);
  });

  it("enqueues every turn not yet covered by the Summary", async () => {
    const { service, queue } = makeService();
    const prepared = await service.prepare(
      {
        messages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "My latest project is Atlas." },
        ],
      },
      fullCtx,
    );

    await prepared.postTurn("latest answer");

    expect(queue.enqueued[0]?.turns).toEqual([
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "My latest project is Atlas." },
      { role: "assistant", content: "latest answer" },
    ]);
  });
});

describe("ChatService.prepare retrieval", () => {
  it("recalls a seeded memory into the recall section of the system prompt", async () => {
    // Seed a memory BEFORE prepare. Its embedding uses the same deterministic
    // FakeProvider algorithm; a throwaway instance keeps the service provider's
    // embedCalls clean so we can assert the query embed precisely.
    const memory = new StubMemoryStore();
    const seedEmbedding = (await new FakeProvider().embed(["User's cat is named Nova"]))[0]!;
    await memory.upsertMany(
      { userId: "u1", characterId: "luna" },
      [{ content: "User's cat is named Nova", embedding: seedEmbedding, importance: 5, kind: "observation" }],
    );

    const { service, provider } = makeService(new FakeProvider(), memory);
    const prepared = await service.prepare(body, fullCtx);

    const first = prepared.request.messages[0];
    expect(first?.role).toBe("system");
    const content = String(first?.content);
    // rankByRetrievalScore applies no similarity threshold, so the lone seeded
    // observation surfaces within topK regardless of query similarity.
    expect(content).toContain("# Things you recall");
    expect(content).toContain("Nova");

    // The query embedded was the last user text of the request.
    expect(provider.embedCalls).toContainEqual(["My cat is named Nova."]);
  });
});

describe("ChatService.prepare resilience", () => {
  it("continues (empty memories) when retrieve throws", async () => {
    const { service, queue } = makeService(new FakeProvider(), new ThrowingMemoryStore({ retrieve: true }));
    const prepared = await service.prepare(body, fullCtx);

    const first = prepared.request.messages[0];
    expect(first?.role).toBe("system");
    const content = String(first?.content);
    // Persona still assembled; no recall section without memories.
    expect(content).toContain("You are Luna.");
    expect(content).not.toContain("# Things you recall");

    // The turn still completes end to end.
    await prepared.postTurn("What a great name!");
    expect(queue.enqueued).toHaveLength(1);
  });

  it("continues (no core) when getCoreMemory throws", async () => {
    const { service, queue } = makeService(new FakeProvider(), new ThrowingMemoryStore({ core: true }));
    const prepared = await service.prepare(body, fullCtx);

    const first = prepared.request.messages[0];
    expect(first?.role).toBe("system");
    const content = String(first?.content);
    expect(content).toContain("You are Luna.");
    expect(content).not.toContain("# What you know about this person");

    await prepared.postTurn("What a great name!");
    expect(queue.enqueued).toHaveLength(1);
  });

  it("continues (no summary) when getSummary throws", async () => {
    const { service, queue } = makeService(new FakeProvider(), new ThrowingMemoryStore({ summary: true }));
    const prepared = await service.prepare(body, fullCtx);

    const first = prepared.request.messages[0];
    expect(first?.role).toBe("system");
    const content = String(first?.content);
    expect(content).toContain("You are Luna.");
    expect(content).not.toContain("# Conversation so far (summary)");

    await prepared.postTurn("What a great name!");
    expect(queue.enqueued).toHaveLength(1);
  });
});

describe("ChatService.prepare server tools", () => {
  const clock = () => new Date("2026-07-16T12:00:00Z");

  function makeToolService(tools = buildDefaultTools({})) {
    const service = new ChatService(
      new FakeProvider(),
      new StubPersonaStore(),
      new StubMemoryStore(),
      new StubJobQueue(),
      config,
      noopLogger,
      tools,
      clock,
    );
    return { service };
  }

  it("attaches server tools and adds the time + abilities sections for a persona turn", async () => {
    const { service } = makeToolService();
    const prepared = await service.prepare(body, { characterId: "luna", timezone: "Europe/Zurich" });

    expect(prepared.tools?.map((t) => t.definition.function.name)).toEqual(["get_time", "get_weather"]);
    const sys = String(prepared.request.messages[0]?.content);
    expect(sys).toContain("# Current moment");
    expect(sys).toContain("Europe/Zurich");
    expect(sys).toContain("# Your abilities");
  });

  it("omits server tools (and the abilities section) when the client body supplies its own tools", async () => {
    const { service } = makeToolService();
    const clientBody = {
      ...body,
      tools: [{ type: "function", function: { name: "client_tool" } }],
    } as ChatCompletionRequest;
    const prepared = await service.prepare(clientBody, { characterId: "luna" });

    expect(prepared.tools).toBeUndefined();
    expect(String(prepared.request.messages[0]?.content)).not.toContain("# Your abilities");
  });

  it("never attaches server tools on the proxy path (no persona)", async () => {
    const { service } = makeToolService();
    const prepared = await service.prepare(body, {});
    expect(prepared.tools).toBeUndefined();
  });

  it("attaches no tools and omits the abilities section when built without any", async () => {
    const { service } = makeToolService([]);
    const prepared = await service.prepare(body, { characterId: "luna" });
    expect(prepared.tools).toBeUndefined();
    expect(String(prepared.request.messages[0]?.content)).not.toContain("# Your abilities");
  });
});
