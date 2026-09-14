import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { StubMemoryStore } from "./stub-memory-store.js";
import type { NewMemory, RelationshipKey, RetrieveOptions } from "./memory-store.js";
import type { MemoryKind } from "./types.js";

const key: RelationshipKey = { userId: "u", characterId: "c" };
const retrieveOpts: RetrieveOptions = {
  weights: { recency: 1, importance: 1, relevance: 1 },
  recencyDecay: 0.99,
};

describe("hybrid archival retrieval", () => {
  it("finds old lexical matches without filling unrelated slots or crossing tenants", async () => {
    const store = new StubMemoryStore();
    await store.upsertMany(key, [newMem("제주 여행을 약속했다", [])]);
    await store.upsertMany(key, Array.from({ length: 520 }, (_, i) => newMem(`무관한 기록 ${i}`, [])));
    await store.upsertMany({ ...key, userId: "other" }, [newMem("제주 비밀", [])]);
    const result = await store.retrieveWithTrace(key, [], 4, {
      ...retrieveOpts, hybrid: { queryText: "제주" },
    });
    expect(result.memories.map(m => m.content)).toEqual(["제주 여행을 약속했다"]);
    expect(result.hybrid?.semanticStatus).toBe("query_unavailable");
  });

  it("persists grounded metadata and does not deduplicate embeddings across models", async () => {
    const store = new StubMemoryStore();
    const embedding = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
    const content = "사용자는 차를 좋아한다";
    const metadata = {
      embeddingModel: "synthetic-a", embeddingSourceSha256: createHash("sha256").update(content).digest("hex"),
      memoryType: "user_fact" as const, sourceSessionId: "session-a",
      sourceMessages: [{ role: "user" as const, content: "차 좋아해", position: 3,
        sha256: createHash("sha256").update("차 좋아해").digest("hex") }],
    };
    const first = await store.upsertMany(key, [{ ...newMem(content, embedding), ...metadata }], "op-a");
    expect(first[0]).toMatchObject(metadata);
    expect(await store.upsertMany(key, [newMem("changed retry", [])], "op-a")).toEqual(first);
    const other = "사용자는 바다를 좋아한다";
    expect(await store.upsertMany(key, [{ ...newMem(other, embedding), embeddingModel: "synthetic-b",
      embeddingSourceSha256: createHash("sha256").update(other).digest("hex") }])).toHaveLength(1);
  });

  it("rejects a stale embedded-source hash before storing any part of the batch", async () => {
    const store = new StubMemoryStore();
    await store.upsertMany(key, [newMem("existing", [])]);
    await expect(store.upsertMany(key, [newMem("must not persist", []), {
      ...newMem("changed source", Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)),
      embeddingModel: "synthetic", embeddingSourceSha256: "0".repeat(64),
    }])).rejects.toThrow("Memory embedding metadata");
    expect((await store.recentObservations(key, 10)).map(m => m.content)).toEqual(["existing"]);
  });

  it("keeps identical text from distinct fact, episode and interpretation domains", async () => {
    const store = new StubMemoryStore();
    const content = "고양이를 좋아한다";
    const incoming: NewMemory[] = [
      { ...newMem(content, []), memoryType: "user_fact" },
      { ...newMem(content, []), memoryType: "shared_episode" },
      { ...newMem(content, []), memoryType: "interpretation", kind: "reflection" },
      { ...newMem(content, []), memoryType: "interpretation", kind: "observation" },
    ];
    expect(await store.upsertMany(key, incoming)).toHaveLength(4);
    expect(await store.upsertMany(key, incoming)).toHaveLength(0);
    const result = await store.retrieveWithTrace(key, [], 8, {
      ...retrieveOpts, hybrid: { queryText: "고양이" },
    });
    expect(result.memories.map(m => `${m.kind}:${m.memoryType}`)).toEqual([
      "observation:user_fact", "observation:shared_episode", "reflection:interpretation", "observation:interpretation",
    ]);
  });
});

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
  it("does not refresh access time for irrelevant memories excluded by the relevance gate", async () => {
    let clock = "2026-01-01T00:00:00Z";
    const store = new StubMemoryStore(() => clock);
    await store.upsertMany(key, [newMem("unrelated", [0, 1])]);
    clock = "2026-01-02T00:00:00Z";
    const result = await store.retrieveWithTrace(key, [1, 0], 6, { ...retrieveOpts, minRelevance: 0 });
    expect(result.memories).toEqual([]);
    expect(result.candidates[0]).toMatchObject({ decision: "excluded", reason: "below_relevance_threshold" });
    expect((await store.recentObservations(key, 10))[0]?.lastAccessedAt).toBe("2026-01-01T00:00:00Z");
  });

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
