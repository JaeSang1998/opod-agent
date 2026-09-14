import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { ConsolidationService } from "./consolidation.js";
import { parseObservations } from "./parsing.js";
import { Reflector } from "./reflection.js";
import { StubMemoryStore } from "./stub-memory-store.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { ChatService } from "../chat/chat-service.js";
import { StubPersonaStore } from "../persona/stub-persona-store.js";
import { StubJobQueue } from "./stub-job-queue.js";
import type { ChatMessage } from "../protocol/index.js";

const weights = { recency: 1, importance: 1, relevance: 1 };

function reflectorFor(provider: FakeProvider, memory: StubMemoryStore) {
  return new Reflector(
    provider,
    memory,
    {
      recentN: 20,
      questionsPerPass: 1,
      reflectionsPerQuestion: 1,
      retrieveTopK: 5,
      reflectionImportance: 7,
      coreCharLimit: 2000,
      weights,
      recencyDecay: 0.99,
    },
    () => "2026-01-01T00:00:00Z",
  );
}

describe("parseObservations", () => {
  it("parses {content, importance} objects", () => {
    expect(parseObservations('[{"content":"has a cat","importance":6}]')).toEqual([
      { content: "has a cat", importance: 6 },
    ]);
  });
  it("returns empty for []", () => {
    expect(parseObservations("[]")).toEqual([]);
  });
});

describe("ConsolidationService", () => {
  const now = () => "2026-01-01T00:00:00Z";

  it("stores grounded observations without embedding calls when the model identity is unknown", async () => {
    const provider = new FakeProvider("ack", JSON.stringify([
      { content: "사용자는 차를 좋아함", importance: 4, memoryType: "user_fact", contextInjectionMode: "retrieved", sourceIndices: [0] },
    ]));
    const embed = vi.spyOn(provider, "embed").mockRejectedValue(new Error("Unknown model must not be called"));
    const memory = new StubMemoryStore(now);
    const key = { userId: "u-lexical", characterId: "c-lexical", sessionId: "s-lexical" };
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 1000, integratedContext: true,
    }, now);
    await expect(service.consolidate({ ...key, correlationId: "lexical", idempotencyKey: "lexical", reason: "manual",
      refreshSummary: false, turnsStartOffset: 0, turns: [{ role: "user", content: "난 차를 좋아해" }],
    })).resolves.toMatchObject({ observationsStored: 1 });
    const [row] = await memory.recentObservations(key, 1);
    expect(row).toMatchObject({ embedding: [], memoryType: "user_fact", contextInjectionMode: "retrieved", sourceSessionId: "s-lexical",
      sourceMessages: [{ role: "user", content: "난 차를 좋아해", position: 0 }] });
    expect(row?.embeddingModel).toBeUndefined();
    expect(row?.embeddingSourceSha256).toBeUndefined();
    expect(embed).not.toHaveBeenCalled();
  });

  it("rejects ungrounded facts before any writes, then stores server-grounded evidence on a retry exactly once", async () => {
    class GroundedProvider extends FakeProvider {
      fail = true;
      override async embed(texts: string[]) {
        this.embedCalls.push(texts);
        return texts.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0));
      }
      override async chat(...args: Parameters<FakeProvider["chat"]>) {
        const response = await super.chat(...args);
        if (String(args[0].messages[0]?.content).includes("Extract durable Observations")) {
          response.choices[0]!.message.content = JSON.stringify([{
            content: "사용자는 차를 좋아함", importance: 4, memoryType: "user_fact", contextInjectionMode: "retrieved", sourceIndices: [this.fail ? 1 : 0],
            occurredAt: "2026-01-01T00:00:00Z", sourceSessionId: "invented", sourceMessages: [{ content: "invented" }],
          }]);
        }
        return response;
      }
    }
    const provider = new GroundedProvider();
    const memory = new StubMemoryStore(now);
    const writes = vi.spyOn(memory, "upsertMany");
    const key = { userId: "u-grounded", characterId: "c-grounded", sessionId: "s-grounded" };
    const previous = { ...key, content: "Existing summary.", turnsCovered: 12, revision: 1, updatedAt: now() };
    await memory.saveSummary(previous, { idempotencyKey: "seed", expectedRevision: 0 });
    const input = { ...key, correlationId: "grounded", idempotencyKey: "grounded", reason: "manual" as const,
      refreshSummary: true, turnsStartOffset: 12,
      turns: [{ role: "user" as const, content: "  난 차를 좋아해\n" }, { role: "assistant" as const, content: "난 커피" }],
    };
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 1000, integratedContext: true, embeddingModel: "synthetic-test",
    }, now);
    await expect(service.consolidate(input)).rejects.toMatchObject({ stage: "observations" });
    expect(writes).not.toHaveBeenCalled();
    expect(provider.embedCalls).toHaveLength(0);
    expect(await memory.getSummary(key)).toEqual(previous);

    provider.fail = false;
    await expect(service.consolidate(input)).resolves.toMatchObject({ observationsStored: 1, summaryUpdated: true });
    const row = writes.mock.calls[0]![1][0]!;
    expect(row).toMatchObject({ memoryType: "user_fact", sourceSessionId: "s-grounded",
      embeddingModel: "synthetic-test", embeddingSourceSha256: createHash("sha256").update(row.content).digest("hex"),
      sourceMessages: [{ role: "user", content: "  난 차를 좋아해\n", position: 12,
        sha256: createHash("sha256").update("  난 차를 좋아해\n").digest("hex") }],
    });
    expect(row).not.toHaveProperty("occurredAt");
    expect(writes.mock.calls[0]![2]).toBe("grounded:observations");
    const ids = (await memory.recentObservations(key, 10)).map((memory) => memory.id);
    await expect(service.consolidate(input)).resolves.toMatchObject({ summaryUpdated: false });
    expect((await memory.recentObservations(key, 10)).map((memory) => memory.id)).toEqual(ids);
    expect(await memory.getSummary(key)).toMatchObject({ turnsCovered: 14, revision: 2 });
    expect((await memory.getRelationshipState(key)).importanceSinceReflection).toBe(4);
    const sent = String(provider.chatCalls[0]!.messages[1]!.content);
    expect(JSON.parse(sent)).toEqual(input.turns.map((turn, sourceIndex) => ({ sourceIndex, role: turn.role, content: turn.content })));
  });

  it.each([false, true])("rejects an empty summary without consuming its source range and retries: existing=%s", async (existing) => {
    class EmptySummaryProvider extends FakeProvider {
      fail = true;
      override async chat(...args: Parameters<FakeProvider["chat"]>) {
        const response = await super.chat(...args);
        if (this.fail && String(args[0].messages[0]?.content).includes("running summary")) {
          response.choices[0]!.message.content = " \n ";
        }
        return response;
      }
    }
    const provider = new EmptySummaryProvider();
    const memory = new StubMemoryStore(now);
    const key = { userId: "u-empty-summary", characterId: "luna", sessionId: "s-empty" };
    const previous = existing
      ? { ...key, content: "Earlier context.", turnsCovered: 2, revision: 1, updatedAt: now() }
      : null;
    if (previous) await memory.saveSummary(previous, { idempotencyKey: "seed", expectedRevision: 0 });
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), { reflectionThreshold: 1000 }, now);
    const input = {
      ...key, correlationId: "empty-summary", idempotencyKey: "empty-summary", reason: "manual" as const,
      refreshSummary: true, turnsStartOffset: previous?.turnsCovered ?? 0,
      turns: [{ role: "user" as const, content: "I have a cat named Nova." }],
    };
    await expect(service.consolidate(input)).rejects.toMatchObject({
      stage: "summary", cause: expect.objectContaining({ message: "Invalid memory summary response" }),
    });
    expect(await memory.getSummary(key)).toEqual(previous);

    provider.fail = false;
    await expect(service.consolidate(input)).resolves.toMatchObject({ summaryUpdated: true });
    const saved = await memory.getSummary(key);
    expect(saved).toMatchObject({ content: "They introduced their cat Nova.", turnsCovered: input.turnsStartOffset + 1, revision: (previous?.revision ?? 0) + 1 });
    await expect(service.consolidate(input)).resolves.toMatchObject({ summaryUpdated: false });
    expect(await memory.getSummary(key)).toEqual(saved);
  });

  it.each(["empty", "oversized"])("does not run the retired core rewrite path for an %s legacy response", async (failure) => {
    class InvalidCoreProvider extends FakeProvider {
      fail = true;
      override async chat(...args: Parameters<FakeProvider["chat"]>) {
        const response = await super.chat(...args);
        if (this.fail && String(args[0].messages[0]?.content).includes("compact Core Memory")) {
          response.choices[0]!.message.content = failure === "empty" ? " \n " : "A".repeat(2001);
        }
        return response;
      }
    }
    const provider = new InvalidCoreProvider("reply", '[{"content":"User has a cat named Nova.","importance":6}]');
    const memory = new StubMemoryStore(now);
    const key = { userId: "u-core-retry", characterId: "luna" };
    const core = { ...key, content: "Existing verified facts.", updatedAt: now() };
    await memory.saveCoreMemory(core);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), { reflectionThreshold: 5 }, now);
    const input = {
      ...key, sessionId: "s-core", correlationId: "core-retry", idempotencyKey: "core-retry",
      reason: "manual" as const, refreshSummary: false,
      turns: [{ role: "user" as const, content: "I have a cat named Nova." }],
    };
    await expect(service.consolidate(input)).resolves.toMatchObject({
      reflected: true,
      coreUpdated: false,
    });
    expect(await memory.getCoreMemory(key)).toEqual(core);
    expect((await memory.getRelationshipState(key)).importanceSinceReflection).toBe(1);
    const rows = await memory.retrieve(key, [1, 0, 0], 20, { weights, recencyDecay: 0.99 });
    expect(rows.filter((row) => row.kind === "reflection")).toHaveLength(1);

    provider.fail = false;
    await expect(service.consolidate(input)).resolves.toMatchObject({ reflected: false, coreUpdated: false });
    expect(await memory.getCoreMemory(key)).toEqual(core);
    expect((await memory.getRelationshipState(key)).importanceSinceReflection).toBe(1);
    const afterRetry = await memory.retrieve(key, [1, 0, 0], 20, { weights, recencyDecay: 0.99 });
    expect(afterRetry.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
    await expect(service.consolidate(input)).resolves.toMatchObject({ reflected: false });
    expect((await memory.getRelationshipState(key)).importanceSinceReflection).toBe(1);
  });

  it.each(["forward", "reverse"])("does not double-count overlapping jobs captured before the worker runs: %s", async (order) => {
    const provider = new FakeProvider("ack", "[]");
    const memory = new StubMemoryStore(now);
    const queue = new StubJobQueue();
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), { reflectionThreshold: 1000 }, now);
    const chat = new ChatService(provider, new StubPersonaStore(), memory, queue, {
      retrieveTopK: 6, weights, recencyDecay: 0.99, summaryTurnThreshold: 6,
    });
    const key = { userId: "u-overlap", characterId: "luna", sessionId: "s-overlap" };
    const turns: ChatMessage[] = [
      { role: "user", content: "My cat is Nova." }, { role: "assistant", content: "Nice name." },
      { role: "user", content: "My dog is Max." }, { role: "assistant", content: "Good to know." },
    ];
    for (const end of [2, 4]) {
      await (await chat.prepare({ messages: turns.slice(0, end - 1) }, { ...key, turnId: `turn-${end}` })).postTurn(String(turns[end - 1]!.content));
    }
    expect(queue.enqueued.map((job) => job.turns.length)).toEqual([2, 4]);
    const jobs = order === "forward" ? queue.enqueued : [...queue.enqueued].reverse();
    for (const job of jobs) await service.consolidate(job);
    expect(await memory.getSummary(key)).toMatchObject({ turnsCovered: 4, revision: order === "forward" ? 2 : 1 });
    const summaries = () => provider.chatCalls.filter((call) => String(call.messages[0]?.content).includes("running summary"));
    const beforeRetry = summaries().length;
    await service.consolidate(queue.enqueued[0]!);
    expect(summaries()).toHaveLength(beforeRetry);
    if (order === "forward") {
      const secondNewTurns = String(summaries()[1]!.messages[1]!.content).split("New turns:\n")[1];
      expect(secondNewTurns).toContain("My dog is Max.");
      expect(secondNewTurns).not.toContain("My cat is Nova.");
    }
    await (await chat.prepare({ messages: [...turns, { role: "user", content: "I like tea." }] }, { ...key, turnId: "turn-6" })).postTurn("Me too.");
    const next = queue.enqueued.at(-1)!;
    expect(next.refreshSummary).toBe(true);
    await service.consolidate(next);
    expect(await memory.getSummary(key)).toMatchObject({ turnsCovered: 6 });
  });

  it("does not advance across an unknown range and can retry after the missing prefix is covered", async () => {
    const provider = new FakeProvider("ack", "[]");
    const memory = new StubMemoryStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), { reflectionThreshold: 1000 }, now);
    const key = { userId: "u-gap", characterId: "luna", sessionId: "s-gap" };
    const job = {
      ...key, correlationId: "gap", idempotencyKey: "gap", reason: "manual" as const, refreshSummary: true,
      turnsStartOffset: 2, turns: [{ role: "user" as const, content: "I like tea." }, { role: "assistant" as const, content: "Me too." }],
    };
    await expect(service.consolidate(job)).rejects.toMatchObject({ stage: "summary", cause: expect.objectContaining({ message: "Summary source range has an unverifiable gap" }) });
    expect(await memory.getSummary(key)).toBeNull();
    expect(provider.chatCalls.some((call) => String(call.messages[0]?.content).includes("running summary"))).toBe(false);
    await service.consolidate({ ...job, idempotencyKey: "prefix", turnsStartOffset: 0 });
    await expect(service.consolidate(job)).resolves.toMatchObject({ summaryUpdated: true });
    expect(await memory.getSummary(key)).toMatchObject({ turnsCovered: 4, revision: 2 });
  });

  it("recomputes the uncovered suffix after another summary writer wins the revision race", async () => {
    class RacingStore extends StubMemoryStore {
      private race = true;
      override async saveSummary(...args: Parameters<StubMemoryStore["saveSummary"]>) {
        if (this.race) {
          this.race = false;
          await super.saveSummary({ ...args[0], content: "Earlier exchange already covered.", turnsCovered: 2, revision: 1 }, { idempotencyKey: "concurrent-prefix", expectedRevision: 0 });
          return "conflict" as const;
        }
        return super.saveSummary(...args);
      }
    }
    const provider = new FakeProvider("ack", "[]");
    const memory = new RacingStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), { reflectionThreshold: 1000 }, now);
    const key = { userId: "u-race", characterId: "luna", sessionId: "s-race" };
    const job = {
      ...key, correlationId: "race", idempotencyKey: "race", reason: "manual" as const, refreshSummary: true,
      turnsStartOffset: 0, turns: [
        { role: "user" as const, content: "Old exchange." }, { role: "assistant" as const, content: "Old reply." },
        { role: "user" as const, content: "New exchange." }, { role: "assistant" as const, content: "New reply." },
      ],
    };
    await service.consolidate(job);
    expect(await memory.getSummary(key)).toMatchObject({ turnsCovered: 4, revision: 2 });
    const summaries = provider.chatCalls.filter((call) => String(call.messages[0]?.content).includes("running summary"));
    expect(summaries).toHaveLength(2);
    expect(String(summaries[1]!.messages[1]!.content)).toContain("New exchange.");
    expect(String(summaries[1]!.messages[1]!.content)).not.toContain("Old exchange.");
  });

  it.each(["malformed", "truncated"])("preserves state after %s extraction and resumes the same job exactly once", async (failure) => {
    class RetryProvider extends FakeProvider {
      fail = true;

      override async chat(...args: Parameters<FakeProvider["chat"]>) {
        const response = await super.chat(...args);
        const choice = response.choices[0];
        if (this.fail && choice && String(args[0].messages[0]?.content).includes("Extract durable Observations")) {
          if (failure === "truncated") choice.finish_reason = "length";
          else choice.message.content = '[{"content":"valid-looking fact","importance":6},{"importance":4}]';
        }
        return response;
      }
    }
    const provider = new RetryProvider("unused", '[{"content":"User has a cat named Nova.","importance":6}]');
    const memory = new StubMemoryStore(now);
    const key = { userId: "synthetic-user", characterId: "synthetic-character" };
    const core = { ...key, content: "Existing verified facts.", updatedAt: now() };
    const summary = { ...key, sessionId: "s1", content: "Previous context.", turnsCovered: 2, revision: 1, updatedAt: now() };
    await memory.saveCoreMemory(core);
    await memory.saveSummary(summary, { idempotencyKey: "seed", expectedRevision: 0 });
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), { reflectionThreshold: 1000 }, now);
    const input = {
      ...key, sessionId: "s1", correlationId: "request-retry", idempotencyKey: "job-retry",
      reason: "manual" as const, refreshSummary: true,
      turns: [{ role: "user" as const, content: "I have a cat named Nova." }],
    };

    await expect(service.consolidate(input)).rejects.toMatchObject({
      stage: "observations",
      cause: expect.objectContaining({ message: failure === "truncated"
        ? "Invalid memory completion response" : "Invalid memory observation response" }),
    });
    expect(await memory.recentObservations(key, 20)).toEqual([]);
    expect(await memory.getCoreMemory(key)).toEqual(core);
    expect(await memory.getSummary(summary)).toEqual(summary);
    expect((await memory.getRelationshipState(key)).importanceSinceReflection).toBe(0);

    provider.fail = false;
    await expect(service.consolidate(input)).resolves.toMatchObject({ observationsStored: 1, summaryUpdated: true });
    await expect(service.consolidate(input)).resolves.toMatchObject({ summaryUpdated: false });
    expect((await memory.recentObservations(key, 20)).map((row) => row.content)).toEqual(["User has a cat named Nova."]);
    expect((await memory.getRelationshipState(key)).importanceSinceReflection).toBe(6);
    expect(await memory.getSummary(summary)).toMatchObject({ revision: 2, turnsCovered: 3 });
    expect(await memory.getCoreMemory(key)).toEqual(core);
  });

  it("stores observations with importance and refreshes the summary", async () => {
    const provider = new FakeProvider("reply", '[{"content":"User has a cat named Nova.","importance":6}]');
    const memory = new StubMemoryStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 1000, // effectively never in this test
    }, now);

    const result = await service.consolidate({
      correlationId: "request-store-summary",
      idempotencyKey: "job-store-summary",
      reason: "manual",
      userId: "u1", characterId: "luna", sessionId: "s1",
      turns: [{ role: "user", content: "I have a cat named Nova." }],
      refreshSummary: true,
    });

    expect(result.observationsStored).toBe(1);
    expect(result.reflected).toBe(false);
    expect(result.summaryUpdated).toBe(true);

    const stored = await memory.retrieve({ userId: "u1", characterId: "luna" }, [1, 2, 3, 4], 5, {
      weights, recencyDecay: 0.99,
    });
    expect(stored.map((m) => m.content)).toContain("User has a cat named Nova.");
    expect(
      await memory.getSummary({ userId: "u1", characterId: "luna", sessionId: "s1" }),
    ).not.toBeNull();
  });

  it("autonomously reflects once accumulated importance crosses the threshold", async () => {
    const provider = new FakeProvider("reply", '[{"content":"User is training for a marathon.","importance":8}]');
    const memory = new StubMemoryStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 5, // importance 8 crosses it in one turn
    }, now);

    const result = await service.consolidate({
      correlationId: "request-reflect",
      idempotencyKey: "job-reflect",
      reason: "manual",
      userId: "u1", characterId: "luna", sessionId: "s1",
      turns: [{ role: "user", content: "I'm training for a marathon." }],
      refreshSummary: false,
    });

    expect(result.reflected).toBe(true);
    expect(result.reflectionsStored).toBeGreaterThan(0);
    expect(result.coreUpdated).toBe(false);

    // No separate core block is written. Subtract-(not zero-)semantics preserve
    // overflow: importance 8 - threshold 5 = 3 remainder.
    const core = await memory.getCoreMemory({ userId: "u1", characterId: "luna" });
    expect(core).toBeNull();
    const state = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    expect(state.importanceSinceReflection).toBe(3);
  });

  it("does not reflect below the threshold", async () => {
    const provider = new FakeProvider("reply", '[{"content":"User likes tea.","importance":2}]');
    const memory = new StubMemoryStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 25,
    }, now);
    const result = await service.consolidate({
      correlationId: "request-below-threshold",
      idempotencyKey: "job-below-threshold",
      reason: "manual",
      userId: "u1", characterId: "luna", sessionId: "s1",
      turns: [{ role: "user", content: "I like tea." }],
      refreshSummary: false,
    });
    expect(result.reflected).toBe(false);
    const state = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    expect(state.importanceSinceReflection).toBe(2);
  });

  it("restores consumed importance and actually reflects on the worker retry", async () => {
    const provider = new FakeProvider(
      "reply",
      '[{"content":"User is training for a marathon.","importance":8}]',
    );
    const memory = new StubMemoryStore(now);
    let attempts = 0;
    const flakyReflector = {
      reflect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary provider failure");
        return { reflectionsStored: 1, coreUpdated: true };
      },
    } as unknown as Reflector;
    const service = new ConsolidationService(provider, memory, flakyReflector, {
      reflectionThreshold: 5,
    }, now);

    const input = {
      correlationId: "request-flaky-reflection",
      idempotencyKey: "job-flaky-reflection",
      reason: "manual" as const,
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
      turns: [{ role: "user" as const, content: "I'm training for a marathon." }],
      refreshSummary: false,
    };

    await expect(service.consolidate(input)).rejects.toMatchObject({
      stage: "reflection",
      cause: expect.objectContaining({ message: "temporary provider failure" }),
    });

    expect(
      (await memory.getRelationshipState({ userId: "u1", characterId: "luna" }))
        .importanceSinceReflection,
    ).toBe(8);

    const retry = await service.consolidate(input);
    expect(retry).toMatchObject({ reflected: true, reflectionsStored: 1, coreUpdated: true });
    expect(attempts).toBe(2);
    expect(
      (await memory.getRelationshipState({ userId: "u1", characterId: "luna" }))
        .importanceSinceReflection,
    ).toBe(3);
  });

  it("resumes after importance persistence fails without losing the stored Observation", async () => {
    class FlakyImportanceStore extends StubMemoryStore {
      private fail = true;

      override async addImportance(
        ...args: Parameters<StubMemoryStore["addImportance"]>
      ) {
        if (this.fail) {
          this.fail = false;
          throw new Error("importance write interrupted");
        }
        return super.addImportance(...args);
      }
    }

    const provider = new FakeProvider(
      "reply",
      '[{"content":"User is training for a marathon.","importance":8}]',
    );
    const memory = new FlakyImportanceStore(now);
    const reflector = {
      reflect: async () => ({ reflectionsStored: 1, coreUpdated: true }),
    } as unknown as Reflector;
    const service = new ConsolidationService(provider, memory, reflector, {
      reflectionThreshold: 5,
    }, now);
    const input = {
      correlationId: "request-interrupted-importance",
      idempotencyKey: "job-interrupted-importance",
      reason: "manual" as const,
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
      turns: [{ role: "user" as const, content: "I'm training for a marathon." }],
      refreshSummary: false,
    };

    await expect(service.consolidate(input)).rejects.toMatchObject({
      stage: "observations",
      cause: expect.objectContaining({ message: "importance write interrupted" }),
    });
    await expect(service.consolidate(input)).resolves.toMatchObject({ reflected: true });
    expect(
      (await memory.getRelationshipState({ userId: "u1", characterId: "luna" }))
        .importanceSinceReflection,
    ).toBe(3);
  });

  it("counts messages rather than transcript lines in a summary", async () => {
    const provider = new FakeProvider();
    const memory = new StubMemoryStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 1000,
    }, now);

    await service.consolidate({
      correlationId: "request-multiline",
      idempotencyKey: "job-multiline",
      reason: "manual",
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
      turns: [
        { role: "user", content: "line one\nline two" },
        { role: "assistant", content: "answer\ncontinued" },
      ],
      refreshSummary: true,
    });

    const summary = await memory.getSummary({
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
    });
    expect(summary?.turnsCovered).toBe(2);
  });

  it("does not fold the same worker job into the Summary twice", async () => {
    const provider = new FakeProvider();
    const memory = new StubMemoryStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 1000,
    }, now);
    const input = {
      correlationId: "request-summary-retry",
      idempotencyKey: "job-summary-retry",
      reason: "manual" as const,
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
      turns: [{ role: "user" as const, content: "I like tea." }],
      refreshSummary: true,
    };

    expect((await service.consolidate(input)).summaryUpdated).toBe(true);
    expect((await service.consolidate(input)).summaryUpdated).toBe(false);

    const summary = await memory.getSummary({
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
    });
    expect(summary).toMatchObject({ turnsCovered: 1, revision: 1 });
  });
});
