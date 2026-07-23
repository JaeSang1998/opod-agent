import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ConsolidationWorker } from "./consolidation-worker.js";
import { PostgresJobQueue } from "./postgres-job-queue.js";
import type { ConsolidationRequest } from "../protocol/index.js";
import { noopLogger } from "../bootstrap/logger.js";

/** Integration tests against the real queue table; see postgres-memory-store.test.ts. */
const databaseUrl = process.env.TEST_DATABASE_URL;

const CONFIG = { intervalMs: 10, leaseMs: 60_000, maxAttempts: 2, retryDelayMs: 60_000 };

function request(): ConsolidationRequest {
  return {
    characterId: `it-char-${randomUUID()}`,
    correlationId: "corr-1",
    idempotencyKey: `it-${randomUUID()}`,
    reason: "memorable-content",
    refreshSummary: false,
    sessionId: "sess-1",
    turns: [{ role: "user", content: "hello" }],
    userId: `it-${randomUUID()}`,
  };
}

describe.skipIf(!databaseUrl)("ConsolidationWorker (integration)", () => {
  const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null!;
  const queue = databaseUrl ? new PostgresJobQueue(pool) : null!;
  // Cleanup targets ONLY keys this file created: suites run in parallel
  // against the shared queue table, so a wildcard delete here would race the
  // other suite's in-flight rows.
  const createdKeys: string[] = [];

  function track<T extends { idempotencyKey: string }>(job: T): T {
    createdKeys.push(job.idempotencyKey);
    return job;
  }

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await pool.query(`DELETE FROM opod.agent_memory_jobs WHERE idempotency_key = ANY($1)`, [
        createdKeys,
      ]);
    }
    await pool.end();
  });

  async function statusOf(idempotencyKey: string) {
    const rows = await pool.query(
      `SELECT status, attempt_count, error_message, payload_json
       FROM opod.agent_memory_jobs WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return rows.rows[0];
  }

  it("claims a queued job, consolidates its payload, and completes it", async () => {
    const job = track(request());
    await queue.enqueueMemoryUpdate(job);
    const seen: ConsolidationRequest[] = [];
    const worker = new ConsolidationWorker(
      pool,
      { consolidate: async (input) => void seen.push(input) },
      CONFIG,
      noopLogger,
    );

    const handled = await worker.drain();

    expect(handled).toBeGreaterThanOrEqual(1);
    expect(seen.map((s) => s.idempotencyKey)).toContain(job.idempotencyKey);
    const final = await statusOf(job.idempotencyKey);
    expect(final).toMatchObject({ status: "completed" });
    // PII scrub: a completed job's raw turns are consumed and emptied.
    expect(final.payload_json).toEqual({});
  });

  it("requeues a failed job and fails it permanently at max attempts", async () => {
    const job = track(request());
    await queue.enqueueMemoryUpdate(job);
    const worker = new ConsolidationWorker(
      pool,
      { consolidate: async () => Promise.reject(new Error("provider down")) },
      CONFIG,
      noopLogger,
    );

    // First attempt fails → requeued behind a retry backoff, so the same
    // drain cannot hot-loop it.
    await worker.drain();
    expect(await statusOf(job.idempotencyKey)).toMatchObject({
      status: "queued",
      attempt_count: 1,
    });

    // Simulate the backoff elapsing, then the next attempt exhausts the budget.
    await pool.query(
      `UPDATE opod.agent_memory_jobs SET lease_expires_at = NULL WHERE idempotency_key = $1`,
      [job.idempotencyKey],
    );
    await worker.drain();
    const final = await statusOf(job.idempotencyKey);
    expect(final).toMatchObject({ status: "failed", attempt_count: 2 });
    expect(final.error_message).toContain("provider down");
    // Failed jobs keep their payload — it is the only reprocessing unit.
    expect(final.payload_json.turns).toBeDefined();
  });

  it("serializes same-relationship jobs across worker instances", async () => {
    const userId = `it-${randomUUID()}`;
    const characterId = `it-char-${randomUUID()}`;
    const jobA = track({ ...request(), userId, characterId });
    const jobB = track({ ...request(), userId, characterId });
    const jobOther = track(request());
    await queue.enqueueMemoryUpdate(jobA);
    await queue.enqueueMemoryUpdate(jobB);
    await queue.enqueueMemoryUpdate(jobOther);
    // Deterministic claim order: A oldest, then B, then the other relationship.
    for (const [index, job] of [jobA, jobB, jobOther].entries()) {
      await pool.query(
        `UPDATE opod.agent_memory_jobs
         SET created_at = now() - make_interval(secs => $2) WHERE idempotency_key = $1`,
        [job.idempotencyKey, 30 - index],
      );
    }

    // Worker 1 claims job A and blocks mid-consolidation, holding the
    // relationship lock.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let startedA!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const worker1 = new ConsolidationWorker(
      pool,
      {
        consolidate: async (input) => {
          expect(input.idempotencyKey).toBe(jobA.idempotencyKey);
          startedA();
          await gateA;
        },
      },
      CONFIG,
      noopLogger,
    );
    const run1 = worker1.tick();
    await aStarted;

    // Worker 2 must defer job B (same relationship, lock held) but still
    // process the unrelated relationship's job.
    const seen2: string[] = [];
    const worker2 = new ConsolidationWorker(
      pool,
      {
        consolidate: async (input) => {
          seen2.push(input.idempotencyKey);
        },
      },
      CONFIG,
      noopLogger,
    );
    await worker2.drain();

    expect(seen2).toContain(jobOther.idempotencyKey);
    expect(seen2).not.toContain(jobB.idempotencyKey);
    // Deferred without spending an attempt, parked behind the retry backoff.
    expect(await statusOf(jobB.idempotencyKey)).toMatchObject({
      status: "queued",
      attempt_count: 0,
    });

    // Once A finishes and the backoff elapses, B processes normally.
    releaseA();
    await run1;
    expect(await statusOf(jobA.idempotencyKey)).toMatchObject({ status: "completed" });
    await pool.query(
      `UPDATE opod.agent_memory_jobs SET lease_expires_at = NULL WHERE idempotency_key = $1`,
      [jobB.idempotencyKey],
    );
    await worker2.drain();
    expect(await statusOf(jobB.idempotencyKey)).toMatchObject({ status: "completed" });
  });

  it("stop() finishes only the in-flight job, leaving the backlog queued", async () => {
    const first = track(request());
    const second = track(request());
    const third = track(request());
    const jobs = [first, second, third] as const;
    for (const [index, job] of jobs.entries()) {
      await queue.enqueueMemoryUpdate(job);
      await pool.query(
        `UPDATE opod.agent_memory_jobs
         SET created_at = now() - make_interval(secs => $2) WHERE idempotency_key = $1`,
        [job.idempotencyKey, 30 - index],
      );
    }

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const worker = new ConsolidationWorker(
      pool,
      {
        consolidate: async (input) => {
          if (input.idempotencyKey === first.idempotencyKey) {
            firstStarted();
            await gate;
          }
        },
      },
      CONFIG,
      noopLogger,
    );

    worker.start();
    await started;
    // Shutdown arrives mid-job with a backlog behind it.
    const stopping = worker.stop();
    releaseFirst();
    await stopping;

    expect(await statusOf(first.idempotencyKey)).toMatchObject({ status: "completed" });
    expect((await statusOf(second.idempotencyKey)).status).toBe("queued");
    expect((await statusOf(third.idempotencyKey)).status).toBe("queued");

    // Remove the still-queued backlog so later tests' drain() cannot claim it.
    await pool.query(`DELETE FROM opod.agent_memory_jobs WHERE idempotency_key = ANY($1)`, [
      [second.idempotencyKey, third.idempotencyKey],
    ]);
  });

  it("fails a malformed payload permanently without invoking consolidation", async () => {
    const key = `it-${randomUUID()}`;
    createdKeys.push(key);
    await pool.query(
      `INSERT INTO opod.agent_memory_jobs
         (id, idempotency_key, user_id, character_id, payload_json, updated_at)
       VALUES ($1, $2, 'it-user', 'it-char', '{"not": "a request"}', now())`,
      [randomUUID(), key],
    );
    let called = 0;
    const worker = new ConsolidationWorker(
      pool,
      {
        consolidate: async () => {
          called += 1;
        },
      },
      CONFIG,
      noopLogger,
    );

    await worker.drain();

    expect(called).toBe(0);
    expect((await statusOf(key)).status).toBe("failed");
  });
});
