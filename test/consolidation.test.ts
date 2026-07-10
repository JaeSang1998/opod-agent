import { describe, it, expect } from "vitest";
import { ConsolidationService, parseObservations } from "../src/memory/consolidation.js";
import { Reflector } from "../src/memory/reflection.js";
import { StubMemoryStore } from "../src/memory/stub/StubMemoryStore.js";
import { FakeProvider } from "./fakeProvider.js";

const weights = { recency: 1, importance: 1, relevance: 1 };

function reflectorFor(provider: FakeProvider, memory: StubMemoryStore) {
  return new Reflector(
    provider,
    memory,
    {
      recentN: 20,
      questionsPerPass: 1,
      insightsPerQuestion: 1,
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
    expect(parseObservations('["just a fact"]')).toEqual([{ content: "just a fact", importance: 5 }]);
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
    expect(await memory.getSummary("s1")).not.toBeNull();
  });

  it("autonomously reflects once accumulated importance crosses the threshold", async () => {
    const provider = new FakeProvider("reply", '[{"content":"User is training for a marathon.","importance":8}]');
    const memory = new StubMemoryStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 5, // importance 8 crosses it in one turn
    }, now);

    const result = await service.consolidate({
      userId: "u1", characterId: "luna", sessionId: "s1",
      turns: [{ role: "user", content: "I'm training for a marathon." }],
      refreshSummary: false,
    });

    expect(result.reflected).toBe(true);
    expect(result.reflectionsStored).toBeGreaterThan(0);
    expect(result.coreUpdated).toBe(true);

    // Core block was self-written and the accumulator reset.
    const core = await memory.getCoreMemory({ userId: "u1", characterId: "luna" });
    expect(core?.content).toContain("Nova");
    const state = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    expect(state.importanceSinceReflection).toBe(0);
  });

  it("does not reflect below the threshold", async () => {
    const provider = new FakeProvider("reply", '[{"content":"User likes tea.","importance":2}]');
    const memory = new StubMemoryStore(now);
    const service = new ConsolidationService(provider, memory, reflectorFor(provider, memory), {
      reflectionThreshold: 25,
    }, now);
    const result = await service.consolidate({
      userId: "u1", characterId: "luna", sessionId: "s1",
      turns: [{ role: "user", content: "I like tea." }],
      refreshSummary: false,
    });
    expect(result.reflected).toBe(false);
    const state = await memory.getRelationshipState({ userId: "u1", characterId: "luna" });
    expect(state.importanceSinceReflection).toBe(2);
  });
});
