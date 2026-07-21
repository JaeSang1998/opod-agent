import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresMemoryStore } from "./postgres-memory-store.js";
import { PostgresJobQueue } from "./postgres-job-queue.js";
import type { NewMemory, RetrieveOptions } from "./memory-store.js";
import type { RelationshipKey } from "./types.js";

/**
 * Integration tests against a real Postgres with the opod.agent_* tables
 * (service-backend migration `agent_relationship_memory`). Gated by
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
    await pool.query("SELECT 1 FROM opod.agent_archival_memories LIMIT 0");
  });

  afterAll(async () => {
    if (createdUsers.length > 0) {
      for (const table of [
        "agent_archival_memories",
        "agent_core_memories",
        "agent_relationship_state",
        "agent_summaries",
        "agent_memory_operations",
      ]) {
        await pool.query(`DELETE FROM opod.${table} WHERE user_id = ANY($1)`, [createdUsers]);
      }
    }
    if (createdJobKeys.length > 0) {
      await pool.query(`DELETE FROM opod.agent_memory_jobs WHERE idempotency_key = ANY($1)`, [
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
      "SELECT count(*)::int AS n FROM opod.agent_archival_memories WHERE user_id = $1",
      [key.userId],
    );
    expect(count.rows[0].n).toBe(2);
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
      `SELECT content, last_accessed_at > created_at AS moved
       FROM opod.agent_archival_memories WHERE user_id = $1`,
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
      "SELECT payload_json FROM opod.agent_memory_jobs WHERE idempotency_key = $1",
      [job.idempotencyKey],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].payload_json.userId).toBe(job.userId);

    // Delete the queued row right away: the worker suite runs in parallel and
    // its drain() would otherwise claim this job (shared queue table).
    await pool.query("DELETE FROM opod.agent_memory_jobs WHERE idempotency_key = $1", [
      job.idempotencyKey,
    ]);
  });
});
