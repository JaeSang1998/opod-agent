import { createHash } from "node:crypto";
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
import type { Persona } from "../persona/persona.js";
import { PersonaContextIntegrityError, type PersonaStore } from "../persona/persona-store.js";

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

  override async retrieveWithTrace(...args: Parameters<StubMemoryStore["retrieveWithTrace"]>) {
    if (this.failOn.retrieve) throw new Error("retrieve boom");
    return super.retrieveWithTrace(...args);
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
  it.each([false, true])("uses runtime query model identity without a fixed env model; failure=%s", async (failed) => {
    const vector = [1, ...Array(1023).fill(0)];
    const provider = Object.assign(new FakeProvider(), {
      embedQuery: async () => { if (failed) throw new Error("embedding offline"); return { model: "runtime-qwen", embeddings: [vector] }; },
    });
    const source = new StubPersonaStore();
    let selected: Parameters<NonNullable<PersonaStore["retrieveContext"]>>[0] | undefined;
    const personas: PersonaStore = {
      get: id => source.get(id),
      retrieveContext: async input => {
        selected = input;
        return { fragmentIds: [], canonIds: [], sourceHashes: {}, contextHashes: {}, semanticStatus: input.queryEmbedding.length ? "used" : "query_unavailable" };
      },
    };
    const service = new ChatService(provider, personas, new StubMemoryStore(), new StubJobQueue(), { ...config, integratedContext: true });
    const prepared = await service.prepare(body, fullCtx);
    expect(selected?.queryEmbedding).toEqual(failed ? [] : vector);
    expect(selected?.embeddingModel).toBe(failed ? undefined : "runtime-qwen");
    expect(prepared.promptDebug?.characterRetrieval?.semanticStatus).toBe(failed ? "query_unavailable" : "used");
    expect(lastMessage(prepared).content).toContain("My cat is named Nova.");
    expect(provider.embedCalls).toEqual([]);
  });

  it("propagates authored-context integrity failures instead of silently dropping context", async () => {
    const persona: Persona = { characterId: "c", name: "Synthetic", bio: "", blocks: [], canonMemories: [] };
    const source = new StubPersonaStore([persona]);
    const personas: PersonaStore = {
      get: characterId => source.get(characterId),
      retrieveContext: async () => { throw new PersonaContextIntegrityError("invalid link"); },
    };
    const service = new ChatService(new FakeProvider(), personas, new StubMemoryStore(), new StubJobQueue(), {
      ...config, integratedContext: true,
    });
    await expect(service.prepare({ messages: [{ role: "user", content: "hello" }] }, { characterId: "c" }))
      .rejects.toBeInstanceOf(PersonaContextIntegrityError);
  });

  it("keeps character canon and a user fact separate even when their wording is identical", async () => {
    const content = "고양이를 좋아한다.";
    const persona: Persona = { characterId: "luna", name: "Synthetic", bio: "", blocks: [], canonMemories: [{ id: "canon", content, type: "fact", reason: "fixture", createdAt: "t", updatedAt: "t", kind: "fact", injection: "retrieved", recallKeys: ["고양이"] }] };
    const memory = new StubMemoryStore();
    await memory.upsertMany(fullCtx, [{ content, embedding: [], kind: "observation", memoryType: "user_fact", importance: 4 }]);
    const service = new ChatService(new FakeProvider(), new StubPersonaStore([persona]), memory, new StubJobQueue(), { ...config, integratedContext: true });
    const prepared = await service.prepare({ messages: [{ role: "user", content: "고양이 좋아해?" }] }, fullCtx);
    expect(lastMessage(prepared).content.split(content)).toHaveLength(3);
    expect(prepared.promptDebug?.retrievedMemoryCount).toBe(1);
    expect(prepared.promptDebug?.personaProvenance?.canonSources?.[0]?.destination).toBe("turn_context");
  });
  it("integrated mode uses lexical memory without an embedding call and keeps prior raw messages", async () => {
    const provider = new FakeProvider();
    provider.embed = async () => { throw new Error("external embedding must not run"); };
    const memory = new StubMemoryStore();
    await memory.upsertMany(fullCtx, [{ content: "Nova is the user's cat", embedding: [], importance: 3, kind: "observation" }]);
    const service = new ChatService(provider, new StubPersonaStore(), memory, new StubJobQueue(), { ...config, integratedContext: true, contextMaxBytes: 32_000 });
    const messages = [{ role: "user" as const, content: "Nova 이야기 했었지?" }, { role: "assistant" as const, content: "고양이 말하는 거죠?" }, { role: "user" as const, content: "그거 기억나?" }];
    const prepared = await service.prepare({ messages }, fullCtx);
    expect(prepared.request.messages.slice(1, -1)).toEqual(messages.slice(0, -1));
    expect(lastMessage(prepared).content).toContain("Nova is the user's cat");
    expect(lastMessage(prepared).content).toMatch(/그거 기억나\?$/u);
    expect(prepared.promptDebug?.contextBudget?.status).toBe("within_budget");
  });

  it("integrated mode reports overflow instead of silently dropping uncovered conversation", async () => {
    const provider = new FakeProvider();
    const service = new ChatService(provider, new StubPersonaStore(), new StubMemoryStore(), new StubJobQueue(), { ...config, integratedContext: true, contextMaxBytes: 100 });
    await expect(service.prepare(body, fullCtx)).rejects.toThrow(/context.*budget/i);
  });
  it("omits only a raw-covered summary while retaining cross-session conversation agreements", async () => {
    const memory = new StubMemoryStore();
    await memory.upsertMany(fullCtx, [
      {
        content: "사용자는 반말로 대화하기를 요청했다",
        embedding: [],
        importance: 10,
        kind: "observation",
        memoryType: "user_fact",
        contextInjectionMode: "always",
      },
    ]);
    await memory.saveSummary({ ...fullCtx, content: "summary duplicate", turnsCovered: 2, revision: 1, updatedAt: "" }, { idempotencyKey: "seed", expectedRevision: 0 });
    const service = new ChatService(new FakeProvider(), new StubPersonaStore(), memory, new StubJobQueue(), { ...config, integratedContext: true });
    const messages = [{ role: "user" as const, content: "원문 사실" }, { role: "assistant" as const, content: "기억했어요" }, { role: "user" as const, content: "오늘 뭐 먹지?" }];
    const full = await service.prepare({ messages }, fullCtx);
    expect(full.request.messages.slice(1, -1)).toEqual(messages.slice(0, -1));
    expect(JSON.stringify(full.request.messages)).not.toContain("summary duplicate");
    expect(JSON.stringify(full.request.messages)).toContain("사용자는 반말로 대화하기를 요청했다");
    expect(JSON.stringify(full.request.messages)).toContain("Stable things to keep in mind");
    const partial = await service.prepare({ messages: messages.slice(2) }, { ...fullCtx, historyOffset: 2 });
    expect(JSON.stringify(partial.request.messages)).toContain("summary duplicate");
  });
  it("prepends a persona system prompt when a character is set", async () => {
    const { service } = makeService();
    const prepared = await service.prepare(body, { characterId: "luna" });
    const first = prepared.request.messages[0];
    expect(first?.role).toBe("system");
    expect(String(first?.content)).toContain("You are Luna.");
  });

  it.each(["cozy", "blunt", "formal", "playful"])("applies the common reply contract without rewriting the %s persona or learning hidden guidance", async (voice) => {
    const persona: Persona = {
      characterId: `synthetic-${voice}`,
      name: `Synthetic ${voice}`,
      bio: "A character used only for this regression.",
      blocks: [{ title: "Voice", content: voice }, { title: "Examples", content: "User: What are you doing?\nCharacter: Just finished a concert." }],
      canonMemories: ["Attended a concert last month."],
    };
    const provider = new FakeProvider();
    const memory = new StubMemoryStore();
    const queue = new StubJobQueue();
    const context = { ...fullCtx, characterId: persona.characterId, timezone: "Asia/Seoul" };
    await memory.saveCoreMemory({ ...context, content: "The user introduced themselves as Min.", updatedAt: "" });
    const service = new ChatService(provider, new StubPersonaStore([persona]), memory, queue, { ...config, summaryTurnThreshold: 2 }, noopLogger, [], () => new Date("2026-09-08T06:00:00Z"));
    const request: ChatCompletionRequest = { messages: [
      { role: "user", content: "일 얘기는 됐고, 내 고양이 이름은 나비야." },
      { role: "assistant", content: "나비요?" },
      { role: "user", content: "ㅇㅇ" },
    ] };
    const original = structuredClone(request);
    const prepared = await service.prepare(request, context);
    const system = String(prepared.request.messages[0]?.content);
    const tail = lastMessage(prepared).content;
    expect(system).toContain(`# Voice\n${voice}`);
    expect(system).toContain("Attended a concert last month.");
    expect(system).toContain("Authored examples are not exchanges with this person");
    expect(system).toContain("Read a short reply together with what it answers");
    expect(tail).toContain("The user introduced themselves as Min.");
    expect(tail).toContain("not evidence of weather, anyone's schedule, or current activity");
    expect(tail).not.toContain("don't know their name");
    expect(prepared.request.messages.slice(1, -1)).toEqual(request.messages.slice(0, -1));
    expect(tail.startsWith("<context>")).toBe(true);
    expect(tail.endsWith("</context>\n\nㅇㅇ")).toBe(true);
    expect(request).toEqual(original);
    await prepared.postTurn("알겠어요.");
    expect(queue.enqueued[0]?.turns).toEqual([...original.messages, { role: "assistant", content: "알겠어요." }]);
    expect(JSON.stringify(queue.enqueued)).not.toContain("<context>");
    expect(await memory.getCoreMemory(context)).toMatchObject({ content: "The user introduced themselves as Min." });
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

describe("ChatService Persona routing", () => {
  const routedPersona = {
    characterId: "shared-router-fixture",
    name: "Router Fixture",
    bio: "Synthetic identity used to test the shared Persona path.",
    blocks: [
      {
        id: "shared-identity",
        title: "Core",
        content: "Keeps a calm, wry tone.",
        kind: "identity",
        injection: "always",
      },
      {
        id: "first-contact",
        title: "Arrival",
        content: "Start with a little distance.",
        kind: "example",
        injection: "start_only",
      },
      {
        id: "radio-lore",
        title: "Background",
        content: "Repairs old radios as a hobby.",
        kind: "lore",
        injection: "retrieved",
      },
      {
        id: "feed-note",
        title: "Production",
        content: "Use amber colors in feed images.",
        kind: "creator_note",
        injection: "never_prompt",
      },
    ],
    canonMemories: [],
  } satisfies Persona;

  const selectorInputs: Array<{
    characterId: string;
    blocks: readonly Persona["blocks"][number][];
    query: string;
  }> = [];
  const selector = {
    async selectRelevantBlockIds(input: {
      characterId: string;
      blocks: readonly Persona["blocks"][number][];
      query: string;
    }) {
      selectorInputs.push(input);
      return input.query.toLowerCase().includes("radio") ? ["radio-lore"] : [];
    },
  };

  function makeRoutedService(
    personaSelector: typeof selector | undefined = selector,
  ) {
    return new ChatService(
      new FakeProvider(),
      new StubPersonaStore([routedPersona]),
      new StubMemoryStore(),
      new StubJobQueue(),
      config,
      noopLogger,
      [],
      () => new Date("2026-09-07T04:00:00Z"),
      personaSelector,
    );
  }

  it("keeps always stable, starts once, retrieves only when selected, and never leaks creator notes", async () => {
    selectorInputs.length = 0;
    const service = makeRoutedService();
    const first = await service.prepare(
      { messages: [{ role: "user", content: "hi" }] },
      { ...fullCtx, characterId: routedPersona.characterId },
    );
    const relevant = await service.prepare(
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "Do you like old radios?" },
        ],
      },
      { ...fullCtx, characterId: routedPersona.characterId, turnId: "turn-2" },
    );
    const unrelated = await service.prepare(
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "Let's talk about lunch." },
        ],
      },
      { ...fullCtx, characterId: routedPersona.characterId, turnId: "turn-3" },
    );

    const stable = String(first.request.messages[0]?.content);
    expect(stable).toContain("Keeps a calm, wry tone.");
    expect(stable).not.toContain("Start with a little distance.");
    expect(stable).not.toContain("Repairs old radios as a hobby.");
    expect(stable).not.toContain("Use amber colors in feed images.");
    expect(relevant.request.messages[0]?.content).toBe(stable);
    expect(unrelated.request.messages[0]?.content).toBe(stable);
    expect(relevant.promptDebug?.stablePromptSha256).toBe(
      first.promptDebug?.stablePromptSha256,
    );

    expect(lastMessage(first).content).toContain("Start with a little distance.");
    expect(lastMessage(first).content).not.toContain("Repairs old radios as a hobby.");
    expect(lastMessage(relevant).content).not.toContain("Start with a little distance.");
    expect(lastMessage(relevant).content).toContain("Repairs old radios as a hobby.");
    expect(lastMessage(unrelated).content).not.toContain("Repairs old radios as a hobby.");
    expect(JSON.stringify(first.request.messages)).not.toContain("amber colors");
    expect(JSON.stringify(relevant.request.messages)).not.toContain("amber colors");
    expect(selectorInputs).toHaveLength(3);
    expect(selectorInputs.every((input) => input.characterId === routedPersona.characterId)).toBe(
      true,
    );
    expect(selectorInputs.flatMap((input) => input.blocks.map((block) => block.id))).toEqual([
      "radio-lore",
      "radio-lore",
      "radio-lore",
    ]);

    expect(first.promptDebug?.contextSectionNames).toContain("persona_start");
    expect(relevant.promptDebug?.contextSectionNames).toContain("persona_retrieved");
    expect(unrelated.promptDebug?.contextSectionNames).not.toContain("persona_retrieved");
    expect(relevant.promptDebug?.personaProvenance?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "radio-lore",
          destination: "turn_context",
          reason: "retrieved_for_turn",
        }),
        expect.objectContaining({
          id: "first-contact",
          destination: "excluded",
          reason: "start_only_after_first_turn",
        }),
        expect.objectContaining({
          id: "feed-note",
          destination: "excluded",
          reason: "never_prompt",
        }),
      ]),
    );
    const debug = JSON.stringify(relevant.promptDebug?.personaProvenance);
    expect(debug).not.toContain("radios");
    expect(debug).not.toContain("amber");
  });

  it("treats a nonzero history offset as an established conversation", async () => {
    const prepared = await makeRoutedService().prepare(
      { messages: [{ role: "user", content: "hi again" }] },
      { ...fullCtx, characterId: routedPersona.characterId, historyOffset: 8 },
    );

    expect(lastMessage(prepared).content).not.toContain("Start with a little distance.");
    expect(prepared.promptDebug?.personaProvenance?.sources).toContainEqual(
      expect.objectContaining({
        id: "first-contact",
        reason: "start_only_after_first_turn",
      }),
    );
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

  it("reports selected and excluded memory sources without exposing their content", async () => {
    const memory = new StubMemoryStore();
    const seedProvider = new FakeProvider();
    const contents = ["User's cat is named Nova", "User keeps a red umbrella"];
    const embeddings = await seedProvider.embed(contents);
    const stored = await memory.upsertMany(
      { userId: "u1", characterId: "luna" },
      contents.map((content, index) => ({
        content,
        embedding: embeddings[index]!,
        importance: index === 0 ? 8 : 1,
        kind: "observation" as const,
      })),
    );
    const service = new ChatService(
      new FakeProvider(),
      new StubPersonaStore(),
      memory,
      new StubJobQueue(),
      { ...config, retrieveTopK: 1 },
    );

    const prepared = await service.prepare(body, fullCtx);
    const provenance = prepared.promptDebug?.memoryProvenance;

    expect(provenance).toMatchObject({ status: "completed", reason: "retrieval_completed" });
    expect(provenance?.sources).toHaveLength(2);
    expect(provenance?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: stored[0]?.id,
          retrieval: "selected",
          retrievalReason: "selected_top_k",
          injected: true,
          injectionReason: "retrieved_memories_section",
        }),
        expect.objectContaining({
          id: stored[1]?.id,
          retrieval: "excluded",
          retrievalReason: "outside_top_k",
          injected: false,
          injectionReason: "not_retrieved",
        }),
      ]),
    );
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain("Nova");
    expect(serialized).not.toContain("umbrella");
  });

  it("keeps selected-only provenance for a legacy MemoryStore adapter", async () => {
    const memory = new StubMemoryStore();
    const content = "User's cat is named Nova";
    const embedding = (await new FakeProvider().embed([content]))[0];
    if (!embedding) throw new Error("test embedding missing");
    const [stored] = await memory.upsertMany(
      { userId: "u1", characterId: "luna" },
      [{ content, embedding, importance: 5, kind: "observation" }],
    );
    const tracedRetrieve = memory.retrieveWithTrace.bind(memory);
    Object.defineProperties(memory, {
      retrieve: {
        value: async (...args: Parameters<StubMemoryStore["retrieve"]>) =>
          (await tracedRetrieve(...args)).memories,
      },
      retrieveWithTrace: { value: undefined },
    });

    const { service } = makeService(new FakeProvider(), memory);
    const provenance = (await service.prepare(body, fullCtx)).promptDebug?.memoryProvenance;

    expect(provenance?.sources).toEqual([
      expect.objectContaining({
        id: stored?.id,
        rank: 1,
        score: null,
        rawRelevance: null,
        retrieval: "selected",
        retrievalReason: "legacy_store_selected",
        injected: true,
      }),
    ]);
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
    expect(prepared.promptDebug?.memoryProvenance).toEqual({
      status: "failed",
      reason: "retrieval_failed",
      sources: [],
    });

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
    expect(tail.content).toContain("Optional room for expression:");
    expect(tail.content).toContain("You may refer to something they actually shared");
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
    expect(second.promptDebug?.stablePromptSha256).toBe(first.promptDebug?.stablePromptSha256);
    expect(lastMessage(second).content).not.toBe(lastMessage(first).content);
  });

  it("fingerprints the served prompt without exposing persona or memory content", async () => {
    const { service } = makeService();
    const prepared = await service.prepare(body, fullCtx);

    expect(prepared.promptDebug).toMatchObject({
      schemaVersion: 1,
      personaBlockCount: 5,
      canonCount: 1,
      contextSectionNames: ["current_moment", "bond"],
      retrievedMemoryCount: 0,
      memoryPolicyVersion: 1,
      retrievalConfig: {
        topK: 6,
        weights: { recency: 1, importance: 1, relevance: 1 },
        recencyDecay: 0.99,
      },
    });
    expect(prepared.promptDebug?.stablePromptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.promptDebug?.stablePromptSha256).toBe(
      createHash("sha256")
        .update(String(prepared.request.messages[0]?.content), "utf8")
        .digest("hex"),
    );
    const serialized = JSON.stringify(prepared.promptDebug);
    expect(serialized).not.toContain("Luna");
    expect(serialized).not.toContain("observatory");
    expect(serialized).not.toContain("Nova");
  });

  it("changes the stable fingerprint when persona or canon content changes", async () => {
    const base = await new StubPersonaStore().get("luna");
    if (!base) throw new Error("stub persona missing");
    const prepare = async (persona: typeof base) => {
      const service = new ChatService(
        new FakeProvider(),
        new StubPersonaStore([persona]),
        new StubMemoryStore(),
        new StubJobQueue(),
        config,
      );
      return service.prepare(body, { characterId: persona.characterId });
    };

    const original = await prepare(base);
    const personaChanged = await prepare({ ...base, bio: `${base.bio}!` });
    const canonChanged = await prepare({
      ...base,
      canonMemories: [...base.canonMemories, "Keeps a red notebook."],
    });

    expect(personaChanged.promptDebug?.stablePromptSha256).not.toBe(
      original.promptDebug?.stablePromptSha256,
    );
    expect(canonChanged.promptDebug?.stablePromptSha256).not.toBe(
      original.promptDebug?.stablePromptSha256,
    );
  });
});
