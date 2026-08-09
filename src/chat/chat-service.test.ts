import { describe, it, expect } from "vitest";
import { ChatService } from "./chat-service.js";
import { StubPersonaStore } from "../persona/stub-persona-store.js";
import { StubMemoryStore } from "../memory/stub-memory-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { buildDefaultTools } from "../tools/index.js";
import { noopLogger } from "../bootstrap/logger.js";
import type { ChatCompletionRequest } from "../protocol/index.js";
import { BOND_XP_BY_GRADE } from "../memory/bond.js";

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

/** The tail message, where everything that changes per turn is injected. */
function lastMessage(prepared: { request: { messages: unknown[] } }) {
  const message = prepared.request.messages.at(-1) as { role: string; content: string };
  return { role: message.role, content: String(message.content) };
}

/** Full identity — every retrieval branch (memories / core / summary) fires. */
const fullCtx = {
  characterId: "luna",
  historyOffset: 0,
  sessionId: "s1",
  turnId: "turn-1",
  userId: "u1",
};

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
      turnId: "turn-enqueue",
      userId: "u1",
      sessionId: "s1",
    });
    await prepared.postTurn("What a great name!");
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.sessionId).toBe("s1");
    expect(queue.enqueued[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps correlation separate from a stable logical-turn retry identity", async () => {
    const { service, queue } = makeService();
    const context = { ...fullCtx, requestId: "chat-request-123" };

    await (await service.prepare(body, context)).postTurn("What a great name!");
    await (await service.prepare(body, context)).postTurn("What a great name!");

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      correlationId: "chat-request-123",
    });
    expect(queue.enqueued[0]?.idempotencyKey).not.toBe("chat-request-123");
  });

  it("does not collapse distinct turns that reuse one correlation id", async () => {
    const { service, queue } = makeService();
    const context = { ...fullCtx, requestId: "reused-trace", turnId: "turn-cat" };

    await (await service.prepare(body, context)).postTurn("What a great name!");
    await (
      await service.prepare(
        { messages: [{ role: "user", content: "My dog is named Max." }] },
        { ...context, turnId: "turn-dog" },
      )
    ).postTurn("Max is a lovely name!");

    expect(queue.enqueued).toHaveLength(2);
    expect(queue.enqueued.map((job) => job.correlationId)).toEqual([
      "reused-trace",
      "reused-trace",
    ]);
    expect(new Set(queue.enqueued.map((job) => job.idempotencyKey))).toHaveProperty("size", 2);
  });

  it("keeps identical exchanges distinct when their logical turn ids differ", async () => {
    const { service, queue } = makeService();

    await (await service.prepare(body, { ...fullCtx, turnId: "repeat-1" })).postTurn("Nice!");
    await (await service.prepare(body, { ...fullCtx, turnId: "repeat-2" })).postTurn("Nice!");

    expect(queue.enqueued).toHaveLength(2);
    expect(new Set(queue.enqueued.map((job) => job.idempotencyKey))).toHaveProperty("size", 2);
  });

  it("is a pure pass-through when the client supplies tools", async () => {
    const { service, queue } = makeService();
    const request = {
      ...body,
      tools: [{ type: "function", function: { name: "client_tool", parameters: {} } }],
    } as ChatCompletionRequest;

    const prepared = await service.prepare(request, fullCtx);
    await prepared.postTurn("client-managed result");

    expect(prepared.request.messages[0]?.role).toBe("user");
    expect(prepared.tools).toBeUndefined();
    expect(queue.enqueued).toHaveLength(0);
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
  it("recalls a seeded memory into the per-turn context block", async () => {
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

    // rankByRetrievalScore applies no similarity threshold, so the lone seeded
    // observation surfaces within topK regardless of query similarity.
    const tail = lastMessage(prepared);
    expect(tail.role).toBe("user");
    expect(tail.content).toContain("# Things you recall");
    expect(tail.content).toContain("Nova");
    // …and never in the cached prefix.
    expect(String(prepared.request.messages[0]?.content)).not.toContain("# Things you recall");

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
    // Abilities are a property of the character (cached); the clock is not.
    expect(String(prepared.request.messages[0]?.content)).toContain("# Your abilities");
    const tail = lastMessage(prepared);
    expect(tail.content).toContain("# Current moment");
    expect(tail.content).toContain("Europe/Zurich");
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

describe("ChatService bond", () => {
  it("moves the bond by the grade the reply carried", async () => {
    const { service, memory } = makeService();
    const prepared = await service.prepare(body, fullCtx);
    await prepared.postTurn("고양이 이름 예쁘다", 2);

    const state = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    expect(state.bondXp).toBe(BOND_XP_BY_GRADE[2]);
  });

  it("counts a missing grade as neutral rather than skipping the turn", async () => {
    // A model that forgot its tag must not leave the character acting distant:
    // the write is also what records that they spoke just now.
    const { service, memory } = makeService();
    const before = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await (await service.prepare(body, fullCtx)).postTurn("응");

    const after = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    expect(after.bondXp).toBe(0);
    expect(Date.parse(after.lastExchangeAt)).toBeGreaterThan(Date.parse(before.lastExchangeAt));
  });

  it("grades a retried turn only once", async () => {
    const { service, memory } = makeService();
    await (await service.prepare(body, fullCtx)).postTurn("응", 2);
    await (await service.prepare(body, fullCtx)).postTurn("응", 2);

    const state = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    expect(state.bondXp).toBe(BOND_XP_BY_GRADE[2]);
  });

  it("asks for a closing tag on persona turns only", async () => {
    const { service } = makeService();
    expect((await service.prepare(body, fullCtx)).expectsBondSignal).toBe(true);
    expect((await service.prepare(body, {})).expectsBondSignal).toBe(false);
    // No identity means no relationship to grade, so nothing to strip either.
    expect((await service.prepare(body, { characterId: "luna" })).expectsBondSignal).toBe(false);
  });

  it("still answers when the bond write fails", async () => {
    class FailingBondStore extends StubMemoryStore {
      override async grantBond(): Promise<never> {
        throw new Error("grantBond boom");
      }
    }
    const { service, queue } = makeService(new FakeProvider(), new FailingBondStore());
    await expect((await service.prepare(body, fullCtx)).postTurn("응", 1)).resolves.toBeUndefined();
    expect(queue.enqueued).toHaveLength(1);
  });

  it("opens new behaviour in the prompt once the level rises", async () => {
    const memory = new StubMemoryStore();
    let now = Date.parse("2026-08-02T05:00:00Z");
    const service = new ChatService(
      new FakeProvider(),
      new StubPersonaStore(),
      memory,
      new StubJobQueue(),
      config,
      noopLogger,
      [],
      () => new Date(now),
    );

    // Three days of warm conversation. It takes days rather than turns because
    // the daily cap is what stops a level being bought in one evening.
    for (let day = 0; day < 3; day += 1) {
      for (let turn = 0; turn < 4; turn += 1) {
        const ctx = { ...fullCtx, turnId: `d${day}-t${turn}` };
        await (await service.prepare(body, ctx)).postTurn("응", 2);
      }
      now += 24 * 60 * 60 * 1000;
    }

    const state = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    expect(state.bondLevel).toBe(2);

    const tail = lastMessage(await service.prepare(body, fullCtx));
    expect(tail.content).toContain("What that lets you do now:");
    expect(tail.content).toContain("Use their name");
  });

  it("leaves the cached prefix untouched while the turn context moves", async () => {
    // The reason the unlocks are injected at runtime at all: the system prompt
    // is the prefix every Provider caches, so it has to be byte-identical from
    // one turn to the next even as the clock, the memory and the level change.
    const memory = new StubMemoryStore();
    let now = Date.parse("2026-08-02T05:00:00Z");
    const service = new ChatService(
      new FakeProvider(),
      new StubPersonaStore(),
      memory,
      new StubJobQueue(),
      config,
      noopLogger,
      [],
      () => new Date(now),
    );

    const first = await service.prepare(body, fullCtx);
    await first.postTurn("응", 2);
    now += 3 * 24 * 60 * 60 * 1000; // a different clock, a different recency
    const second = await service.prepare(body, { ...fullCtx, turnId: "turn-2" });

    expect(second.request.messages[0]?.content).toBe(first.request.messages[0]?.content);
    expect(lastMessage(second).content).not.toBe(lastMessage(first).content);
  });
});
