import { describe, it, expect } from "vitest";
import { ConsolidationService } from "./consolidation.js";
import { parseObservations } from "./parsing.js";
import { Reflector } from "./reflection.js";
import { StubMemoryStore } from "./stub-memory-store.js";
import { FakeProvider } from "../testing/fake-provider.js";

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
  it("clamps importance into 1..10 and rounds", () => {
    expect(parseObservations('[{"content":"x","importance":99}]')[0]?.importance).toBe(10);
    expect(parseObservations('[{"content":"y","importance":0}]')[0]?.importance).toBe(1);
  });
  it("tolerates bare strings with a default importance", () => {
    expect(parseObservations('["just an observation"]')).toEqual([
      { content: "just an observation", importance: 5 },
    ]);
  });
  it("returns empty for []", () => {
    expect(parseObservations("[]")).toEqual([]);
  });
});

describe("ConsolidationService", () => {
  const now = () => "2026-01-01T00:00:00Z";

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
    expect(result.coreUpdated).toBe(true);

    // Core block was self-written and one reflection budget consumed. Subtract-
    // (not zero-)semantics preserve overflow: importance 8 - threshold 5 = 3 remainder.
    const core = await memory.getCoreMemory({ userId: "u1", characterId: "luna" });
    expect(core?.content).toContain("Nova");
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
