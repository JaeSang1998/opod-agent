import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NewMemory, RetrieveOptions } from "./memory-store.js";
import { PostgresJobQueue } from "./postgres-job-queue.js";
import { PostgresMemoryStore } from "./postgres-memory-store.js";
import type { RelationshipKey } from "./types.js";

/**
 * Integration tests against the real PostgreSQL chat-memory tables.
 * Gated by
 * TEST_DATABASE_URL so environments without the schema skip cleanly:
 *
 *   TEST_DATABASE_URL=postgresql://ai_sns:ai_sns@localhost:5433/ai_sns npm test
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const RETRIEVE_OPTS: RetrieveOptions = {
  weights: { recency: 0, importance: 0, relevance: 1 },
  recencyDecay: 0.99,
};

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  return {
    content: "the user lives in Busan",
    embedding: [1, 0, 0],
    importance: 5,
    kind: "observation",
    ...overrides,
  };
}

describe("PostgresMemoryStore hybrid failure trace", () => {
  it("retains lexical matches and labels a failed semantic query without reusing semantic scores", async () => {
    const content = "제주 여행";
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      id: randomUUID(), user_id: "u", character_id: "c", memory_text: content,
      derivation_type: "observation", importance_score: 5,
      memory_embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0),
      embedding_model: "synthetic-test", embedded_text_sha256: createHash("sha256").update(content).digest("hex"),
      supporting_memory_ids: null, context_injection_mode: "retrieved",
      created_at: new Date(), last_recalled_at: new Date(),
    }] }).mockRejectedValueOnce(new Error("semantic unavailable")).mockResolvedValueOnce({ rows: [] });
    const store = new PostgresMemoryStore({ query } as unknown as pg.Pool);
    const result = await store.retrieveWithTrace({ userId: "u", characterId: "c" },
      Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0), 4,
      { ...RETRIEVE_OPTS, hybrid: { queryText: "제주", embeddingModel: "synthetic-test" } });
    expect(result.memories.map(m => m.content)).toEqual([content]);
    expect(result.hybrid?.semanticStatus).toBe("failed");
    expect(result.candidates[0]?.rawRelevance).toBe(0);
  });
});

describe.skipIf(!databaseUrl)("PostgresMemoryStore (integration)", () => {
  const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null!;
  const store = databaseUrl ? new PostgresMemoryStore(pool) : null!;
  const createdUsers: string[] = [];
  // Job keys created here; cleanup must not use wildcards — the worker suite
  // runs in parallel against the same queue table.
  const createdJobKeys: string[] = [];

  function freshKey(): RelationshipKey {
    const key = { userId: `it-${randomUUID()}`, characterId: `it-char-${randomUUID()}` };
    createdUsers.push(key.userId);
    return key;
  }

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM opod.chat_memory_entries LIMIT 0");
  });

  afterAll(async () => {
    if (createdUsers.length > 0) {
      for (const table of [
        "chat_memory_entries",
        "chat_relationship_states",
        "chat_memory_session_summaries",
        "chat_applied_state_changes",
      ]) {
        await pool.query(`DELETE FROM opod.${table} WHERE user_id = ANY($1)`, [createdUsers]);
      }
    }
    if (createdJobKeys.length > 0) {
      await pool.query(`DELETE FROM opod.chat_memory_consolidation_jobs WHERE idempotency_key = ANY($1)`, [
        createdJobKeys,
      ]);
    }
    await pool.end();
  });

  it("stores a batch once and returns the original rows on operation retry", async () => {
    const key = freshKey();
    const first = await store.upsertMany(
      key,
      [newMemory(), newMemory({ content: "the user shoots film", embedding: [0, 1, 0] })],
      "turn-1",
    );
    expect(first).toHaveLength(2);

    // Retried batch content differs (stochastic extraction) — original wins.
    const retried = await store.upsertMany(
      key,
      [newMemory({ content: "changed on retry", embedding: [0, 0, 1] })],
      "turn-1",
    );
    expect(retried.map((m) => m.content)).toEqual(first.map((m) => m.content));

    const count = await pool.query(
      "SELECT count(*)::int AS n FROM opod.chat_memory_entries WHERE user_id = $1",
      [key.userId],
    );
    expect(count.rows[0].n).toBe(2);
  });

  it("retrieves old scoped lexical and semantic matches beyond 512 newer memories", async () => {
    const key = freshKey();
    const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
    const content = "오래된 약속";
    const [semantic] = await store.upsertMany(key, [newMemory({ content, embedding: vector,
      embeddingModel: "synthetic-test", embeddingSourceSha256: createHash("sha256").update(content).digest("hex") })]);
    await store.upsertMany(key, [newMemory({ content: "제주 여행", embedding: [] })]);
    await store.upsertMany(key, Array.from({ length: 520 }, (_, i) => newMemory({ content: `무관 ${i}`, embedding: [] })));
    await store.upsertMany(freshKey(), [newMemory({ content: "제주 다른 사용자", embedding: [] })]);
    await store.upsertMany({ ...key, characterId: "different-character" }, [newMemory({ content: "제주 다른 캐릭터", embedding: [] })]);
    const result = await store.retrieveWithTrace(key, vector, 6, {
      ...RETRIEVE_OPTS, hybrid: { queryText: "제주", embeddingModel: "synthetic-test" },
    });
    expect(result.memories.map(m => m.content).sort()).toEqual(["오래된 약속", "제주 여행"].sort());
    expect(result.hybrid?.semanticStatus).toBe("used");

    await pool.query("UPDATE opod.chat_memory_entries SET memory_text = '변경된 원문' WHERE id = $1", [semantic!.id]);
    const stale = await store.retrieveWithTrace(key, vector, 6, {
      ...RETRIEVE_OPTS, hybrid: { queryText: "제주", embeddingModel: "synthetic-test" },
    });
    expect(stale.memories.map(m => m.content)).toEqual(["제주 여행"]);
    expect(stale.hybrid?.semanticStatus).toBe("no_valid_index");
  });

  it("round-trips source metadata and preserves unknown legacy metadata", async () => {
    const key = freshKey();
    const sourceMessages = [{ role: "user" as const, content: "난 차 좋아해", position: 8,
      sha256: createHash("sha256").update("난 차 좋아해").digest("hex") }];
    const metadata = { sourceMessages, sourceSessionId: "synthetic-session", memoryType: "user_fact" as const };
    const first = await store.upsertMany(key, [newMemory({ ...metadata, embedding: [] })], "grounded-turn");
    expect((await store.recentObservations(key, 1))[0]).toMatchObject(metadata);
    expect(first[0]?.occurredAt).toBeUndefined();
    expect(await store.upsertMany(key, [newMemory({ content: "retry changes", embedding: [] })], "grounded-turn")).toEqual(first);
    const legacy = await store.upsertMany(key, [newMemory({ content: "legacy", embedding: [] })]);
    expect(legacy[0]?.sourceMessages).toBeUndefined();
    expect(legacy[0]?.embeddingModel).toBeUndefined();
  });

  it("gates malformed legacy arrays before pgvector casts instead of failing the semantic branch", async () => {
    const key = freshKey();
    const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
    for (const [i, embedding] of [[1, 0], vector.map(() => NaN), vector.map(() => Infinity), vector.map(() => 0)].entries()) {
      const content = `잘못된 벡터 ${i}`;
      await pool.query(`INSERT INTO opod.chat_memory_entries
        (id, user_id, character_id, memory_text, derivation_type, importance_score, memory_embedding, embedding_model, embedded_text_sha256)
        VALUES ($1,$2,$3,$4,'observation',5,$5,'synthetic-test',$6)`,
      [randomUUID(), key.userId, key.characterId, content, embedding, createHash("sha256").update(content).digest("hex")]);
    }
    const result = await store.retrieveWithTrace(key, vector, 4, {
      ...RETRIEVE_OPTS, hybrid: { queryText: "없는 단어", embeddingModel: "synthetic-test" },
    });
    expect(result.memories).toEqual([]);
    expect(result.hybrid?.semanticStatus).toBe("no_valid_index");
  });

  it("drops near-duplicate observations (similarity dedup)", async () => {
    const key = freshKey();
    await store.upsertMany(key, [newMemory({ embedding: [1, 0, 0] })], "turn-1");
    const second = await store.upsertMany(
      key,
      [
        newMemory({ content: "near duplicate", embedding: [0.999, 0.01, 0] }),
        newMemory({ content: "genuinely new", embedding: [0, 1, 0] }),
      ],
      "turn-2",
    );
    expect(second.map((m) => m.content)).toEqual(["genuinely new"]);
  });

  it("retrieves by relevance and touches recency of the returned rows", async () => {
    const key = freshKey();
    await store.upsertMany(key, [
      newMemory({ content: "about film", embedding: [1, 0, 0] }),
      newMemory({ content: "about the sea", embedding: [0, 1, 0] }),
    ]);

    const hits = await store.retrieve(key, [1, 0, 0], 1, RETRIEVE_OPTS);
    expect(hits.map((m) => m.content)).toEqual(["about film"]);

    const touched = await pool.query<{ content: string; moved: boolean }>(
      `SELECT memory_text AS content, last_recalled_at > created_at AS moved
       FROM opod.chat_memory_entries WHERE user_id = $1`,
      [key.userId],
    );
    const byContent = new Map(touched.rows.map((r) => [r.content, r.moved]));
    expect(byContent.get("about film")).toBe(true);
    expect(byContent.get("about the sea")).toBe(false);
  });

  it("lists recent observations newest-first, excluding reflections", async () => {
    const key = freshKey();
    await store.upsertMany(key, [newMemory({ content: "older", embedding: [1, 0, 0] })], "t1");
    await store.upsertMany(key, [
      newMemory({ content: "newer", embedding: [0, 1, 0] }),
      newMemory({ content: "a conclusion", embedding: [0, 0, 1], kind: "reflection" }),
    ]);

    const recent = await store.recentObservations(key, 5);
    expect(recent.map((m) => m.content)).toEqual(["newer", "older"]);
  });

  it("saves the core block idempotently per operation key", async () => {
    const key = freshKey();
    const core = { ...key, content: "v1", updatedAt: new Date().toISOString() };
    await store.saveCoreMemory(core, "reflect-1");
    await store.saveCoreMemory({ ...core, content: "retry must not apply" }, "reflect-1");
    expect((await store.getCoreMemory(key))?.content).toBe("v1");

    await store.saveCoreMemory({ ...core, content: "v2" }, "reflect-2");
    expect((await store.getCoreMemory(key))?.content).toBe("v2");
  });

  it("accumulates importance once per operation and consumes budget atomically", async () => {
    const key = freshKey();
    await store.addImportance(key, 5, "turn-1");
    const afterRetry = await store.addImportance(key, 5, "turn-1");
    expect(afterRetry.importanceSinceReflection).toBe(5);
    await store.addImportance(key, 4, "turn-2");

    expect(await store.consumeReflectionBudget(key, 10)).toBeNull();
    expect(await store.consumeReflectionBudget(key, 7)).toBe(9);
    // Overflow carries forward: 9 - 7 = 2 remains.
    expect((await store.getRelationshipState(key)).importanceSinceReflection).toBe(2);
  });

  it("applies summary writes with revision CAS and idempotency", async () => {
    const key = { ...freshKey(), sessionId: `it-sess-${randomUUID()}` };
    const summary = {
      ...key,
      content: "first summary",
      turnsCovered: 4,
      revision: 1,
      updatedAt: new Date().toISOString(),
    };

    expect(await store.saveSummary(summary, { idempotencyKey: "job-1", expectedRevision: 0 })).toBe(
      "saved",
    );
    expect(await store.saveSummary(summary, { idempotencyKey: "job-1", expectedRevision: 0 })).toBe(
      "duplicate",
    );
    // Stale revision from a concurrent job is rejected, and the rejected key
    // stays unrecorded so a corrected retry could proceed.
    expect(
      await store.saveSummary(
        { ...summary, content: "stale", revision: 1 },
        { idempotencyKey: "job-2", expectedRevision: 0 },
      ),
    ).toBe("conflict");

    expect((await store.getSummary(key))?.content).toBe("first summary");

    expect(
      await store.saveSummary(
        { ...summary, content: "second summary", turnsCovered: 8, revision: 2 },
        { idempotencyKey: "job-3", expectedRevision: 1 },
      ),
    ).toBe("saved");
    expect((await store.getSummary(key))?.revision).toBe(2);
  });

  it("lets exactly one of two concurrent first-summary writers win", async () => {
    const key = { ...freshKey(), sessionId: `it-sess-${randomUUID()}` };
    const writer = (label: string, jobKey: string) =>
      store.saveSummary(
        {
          ...key,
          content: label,
          turnsCovered: 4,
          revision: 1,
          updatedAt: new Date().toISOString(),
        },
        { idempotencyKey: jobKey, expectedRevision: 0 },
      );

    // Two different jobs race to create the session's first summary. Whatever
    // the interleaving, the PK decides one winner; the loser must see
    // "conflict", never a silent overwrite of the winner's content.
    const results = await Promise.all([writer("from job-a", "job-a"), writer("from job-b", "job-b")]);

    expect([...results].sort()).toEqual(["conflict", "saved"]);
    const winner = results[0] === "saved" ? "from job-a" : "from job-b";
    const stored = await store.getSummary(key);
    expect(stored?.content).toBe(winner);
    expect(stored?.revision).toBe(1);
  });

  it("enqueues a memory-update job once per idempotency key", async () => {
    const queue = new PostgresJobQueue(pool);
    const job = {
      characterId: "char-1",
      correlationId: "corr-1",
      idempotencyKey: `it-${randomUUID()}`,
      reason: "memorable-content" as const,
      refreshSummary: false,
      sessionId: "sess-1",
      turns: [{ role: "user" as const, content: "hello" }],
      userId: `it-${randomUUID()}`,
    };
    createdJobKeys.push(job.idempotencyKey);
    await queue.enqueueMemoryUpdate(job);
    await queue.enqueueMemoryUpdate(job);

    const rows = await pool.query(
      "SELECT consolidation_request FROM opod.chat_memory_consolidation_jobs WHERE idempotency_key = $1",
      [job.idempotencyKey],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].consolidation_request.userId).toBe(job.userId);

    // Delete the queued row right away: the worker suite runs in parallel and
    // its drain() would otherwise claim this job (shared queue table).
    await pool.query("DELETE FROM opod.chat_memory_consolidation_jobs WHERE idempotency_key = $1", [
      job.idempotencyKey,
    ]);
  });
});
