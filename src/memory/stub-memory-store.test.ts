import { describe, it, expect } from "vitest";
import { StubMemoryStore } from "./stub-memory-store.js";
import type { NewMemory, RelationshipKey, RetrieveOptions } from "./memory-store.js";
import type { MemoryKind } from "./types.js";

const key: RelationshipKey = { userId: "u", characterId: "c" };
const retrieveOpts: RetrieveOptions = {
  weights: { recency: 1, importance: 1, relevance: 1 },
  recencyDecay: 0.99,
};

function newMem(
  content: string,
  embedding: number[],
  importance = 5,
  kind: MemoryKind = "observation",
): NewMemory {
  return { content, embedding, importance, kind };
}

describe("StubMemoryStore.upsertMany dedup", () => {
  it("skips a near-identical embedding (cosine > 0.95) and keeps a single row", async () => {
    const store = new StubMemoryStore();
    const seeded = await store.upsertMany(key, [newMem("likes tea", [1, 0, 0])]);
    expect(seeded).toHaveLength(1);

    // cosine([1,0,0],[1,0.01,0]) ≈ 0.99995 > 0.95 -> duplicate, not stored.
    const dup = await store.upsertMany(key, [newMem("enjoys tea", [1, 0.01, 0])]);
    expect(dup).toHaveLength(0);

    const rows = await store.retrieve(key, [1, 0, 0], 10, retrieveOpts);
    expect(rows).toHaveLength(1);
  });

  it("stores clearly distinct embeddings (cosine < 0.95)", async () => {
    const store = new StubMemoryStore();
    await store.upsertMany(key, [newMem("likes tea", [1, 0, 0])]);

    // Orthogonal embedding, cosine 0 < 0.95 -> stored.
    const distinct = await store.upsertMany(key, [newMem("has a dog", [0, 1, 0])]);
    expect(distinct).toHaveLength(1);

    const rows = await store.retrieve(key, [1, 0, 0], 10, retrieveOpts);
    expect(rows).toHaveLength(2);
  });

  it("replays the original batch result for the same operation key", async () => {
    const store = new StubMemoryStore();
    const first = await store.upsertMany(
      key,
      [newMem("likes tea", [1, 0, 0])],
      "job-1:observations",
    );
    const retry = await store.upsertMany(
      key,
      [newMem("stochastic retry text", [0, 1, 0])],
      "job-1:observations",
    );

    expect(retry).toEqual(first);
    expect((await store.retrieve(key, [1, 0, 0], 10, retrieveOpts))).toHaveLength(1);
  });
});

describe("StubMemoryStore.retrieve recency touch", () => {
  it("advances lastAccessedAt on retrieve and persists the mutation", async () => {
    let clock = "2026-01-01T00:00:00Z";
    const store = new StubMemoryStore(() => clock);

    await store.upsertMany(key, [newMem("seed", [1, 0, 0])]);

    // Retrieve at a later time -> row's lastAccessedAt is touched to that time.
    clock = "2026-01-02T00:00:00Z";
    const retrieved = await store.retrieve(key, [1, 0, 0], 10, retrieveOpts);
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.lastAccessedAt).toBe("2026-01-02T00:00:00Z");
    // createdAt is untouched (still the insertion time).
    expect(retrieved[0]?.createdAt).toBe("2026-01-01T00:00:00Z");

    // The mutation persists to a later, non-touching read.
    clock = "2026-01-03T00:00:00Z";
    const later = await store.recentObservations(key, 10);
    expect(later[0]?.lastAccessedAt).toBe("2026-01-02T00:00:00Z");
  });
});

describe("StubMemoryStore.recentObservations", () => {
  it("returns only observations, most-recent-first, capped at limit", async () => {
    const store = new StubMemoryStore();
    // Distinct (orthogonal) embeddings so nothing is deduped; inserted in order.
    await store.upsertMany(key, [newMem("o1", [1, 0, 0, 0])]);
    await store.upsertMany(key, [newMem("r1", [0, 1, 0, 0], 7, "reflection")]);
    await store.upsertMany(key, [newMem("o2", [0, 0, 1, 0])]);
    await store.upsertMany(key, [newMem("o3", [0, 0, 0, 1])]);

    const recent = await store.recentObservations(key, 2);
    expect(recent.map((m) => m.content)).toEqual(["o3", "o2"]);
    expect(recent.every((m) => m.kind === "observation")).toBe(true);
  });

  it("excludes reflections even when they are the most recent rows", async () => {
    const store = new StubMemoryStore();
    await store.upsertMany(key, [newMem("o1", [1, 0, 0, 0])]);
    await store.upsertMany(key, [newMem("r1", [0, 1, 0, 0], 7, "reflection")]);

    const recent = await store.recentObservations(key, 10);
    expect(recent.map((m) => m.content)).toEqual(["o1"]);
  });
});

describe("StubMemoryStore reflection accumulator", () => {
  it("accumulates importance across addImportance calls", async () => {
    const store = new StubMemoryStore();
    const s1 = await store.addImportance(key, 3);
    expect(s1.importanceSinceReflection).toBe(3);
    const s2 = await store.addImportance(key, 4);
    expect(s2.importanceSinceReflection).toBe(7);
    expect((await store.getRelationshipState(key)).importanceSinceReflection).toBe(7);
  });

  it("returns null and leaves state untouched below threshold", async () => {
    const store = new StubMemoryStore();
    await store.addImportance(key, 7);

    const consumed = await store.consumeReflectionBudget(key, 10);
    expect(consumed).toBeNull();
    expect((await store.getRelationshipState(key)).importanceSinceReflection).toBe(7);
  });

  it("returns the pre-consume value and subtracts the threshold, preserving overflow", async () => {
    const store = new StubMemoryStore();
    await store.addImportance(key, 12);

    const consumed = await store.consumeReflectionBudget(key, 10);
    expect(consumed).toBe(12);
    // Overflow (12 - 10 = 2) carries forward — not zeroed.
    expect((await store.getRelationshipState(key)).importanceSinceReflection).toBe(2);
  });

  it("consumes exactly at the threshold, leaving zero", async () => {
    const store = new StubMemoryStore();
    await store.addImportance(key, 10);

    const consumed = await store.consumeReflectionBudget(key, 10);
    expect(consumed).toBe(10);
    expect((await store.getRelationshipState(key)).importanceSinceReflection).toBe(0);
  });

  it("does not lose concurrent increments", async () => {
    const store = new StubMemoryStore();
    await Promise.all(Array.from({ length: 20 }, () => store.addImportance(key, 1)));
    expect((await store.getRelationshipState(key)).importanceSinceReflection).toBe(20);
  });

  it("applies an importance operation exactly once", async () => {
    const store = new StubMemoryStore();
    await store.addImportance(key, 7, "job-1:importance");
    await store.addImportance(key, 7, "job-1:importance");
    expect((await store.getRelationshipState(key)).importanceSinceReflection).toBe(7);
  });
});

describe("StubMemoryStore Core Memory idempotency", () => {
  it("does not rewrite Core Memory twice for the same operation key", async () => {
    const store = new StubMemoryStore();
    const base = {
      ...key,
      content: "first",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await store.saveCoreMemory(base, "job-1:core");
    await store.saveCoreMemory({ ...base, content: "retry drift" }, "job-1:core");
    expect((await store.getCoreMemory(key))?.content).toBe("first");
  });
});

describe("StubMemoryStore summary isolation", () => {
  it("scopes the same session id to its user-character relationship", async () => {
    const store = new StubMemoryStore();
    await store.saveSummary(
      {
        userId: "u1",
        characterId: "luna",
        sessionId: "shared",
        content: "private summary",
        turnsCovered: 1,
        revision: 1,
        updatedAt: "2026-01-01T00:00:00Z",
      },
      { idempotencyKey: "job-isolation", expectedRevision: 0 },
    );

    expect(
      await store.getSummary({ userId: "u2", characterId: "luna", sessionId: "shared" }),
    ).toBeNull();
    expect(
      await store.getSummary({ userId: "u1", characterId: "luna", sessionId: "shared" }),
    ).toMatchObject({ content: "private summary" });
  });

  it("returns copies so callers cannot mutate persisted summaries", async () => {
    const store = new StubMemoryStore();
    const session = { userId: "u1", characterId: "luna", sessionId: "s1" };
    await storeSummary();

    const first = await store.getSummary(session);
    first!.content = "mutated";

    expect((await store.getSummary(session))?.content).toBe("original");

    async function storeSummary() {
      await store.saveSummary(
        {
          ...session,
          content: "original",
          turnsCovered: 1,
          revision: 1,
          updatedAt: "2026-01-01T00:00:00Z",
        },
        { idempotencyKey: "job-clone", expectedRevision: 0 },
      );
    }
  });

  it("atomically rejects duplicate operations and stale revisions", async () => {
    const store = new StubMemoryStore();
    const session = { userId: "u1", characterId: "luna", sessionId: "s1" };
    const first = {
      ...session,
      content: "first",
      turnsCovered: 1,
      revision: 1,
      updatedAt: "2026-01-01T00:00:00Z",
    };

    await expect(
      store.saveSummary(first, { idempotencyKey: "job-1", expectedRevision: 0 }),
    ).resolves.toBe("saved");
    await expect(
      store.saveSummary(first, { idempotencyKey: "job-1", expectedRevision: 0 }),
    ).resolves.toBe("duplicate");
    await expect(
      store.saveSummary(
        { ...first, content: "stale writer" },
        { idempotencyKey: "job-2", expectedRevision: 0 },
      ),
    ).resolves.toBe("conflict");
    expect((await store.getSummary(session))?.content).toBe("first");
  });
});
