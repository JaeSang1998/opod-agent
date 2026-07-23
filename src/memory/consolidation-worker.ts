import type { Pool } from "pg";
import type { Logger } from "../bootstrap/logger.js";
import { ConsolidationRequest } from "../protocol/index.js";

/** The one consolidation capability the worker needs; ConsolidationService satisfies it. */
export interface ConsolidationRunner {
  consolidate(input: ConsolidationRequest): Promise<unknown>;
}

export interface ConsolidationWorkerConfig {
  intervalMs: number;
  leaseMs: number;
  maxAttempts: number;
  /** Wait before a failed job may be claimed again — keeps drain() from hot-looping a failing job. */
  retryDelayMs: number;
}

interface ClaimedJob {
  id: string;
  user_id: string;
  character_id: string;
  payload_json: unknown;
  attempt_count: number;
}

/**
 * In-process consumer of the durable opod.agent_memory_jobs queue. ADR-0004
 * planned an external opod-worker calling /memory/consolidate; until that
 * service exists the Agent hosts the loop itself (docs/persona-memory-plan.md
 * Phase 4 — the same in-process-worker rule the admin pipeline follows).
 *
 * Claims use FOR UPDATE SKIP LOCKED with a lease, so several Agent instances
 * can run the loop concurrently and a crashed run is reclaimed after its lease
 * expires. Consolidation stages are idempotent (operation keys), so retrying a
 * half-finished job cannot duplicate memories or importance.
 */
export class ConsolidationWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Set by stop(): drain() finishes the in-flight job, then exits its loop. */
  private stopRequested = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: Pool,
    private readonly consolidation: ConsolidationRunner,
    private readonly config: ConsolidationWorkerConfig,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    const loop = () => {
      if (!this.running) return;
      this.inFlight = this.drain()
        .then(() => undefined)
        .catch((err) => {
          this.log.error("consolidation worker tick failed", { error: String(err) });
        })
        .finally(() => {
          if (this.running) this.timer = setTimeout(loop, this.config.intervalMs);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopRequested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /**
   * Processes claimable jobs until the queue is empty — or stop() is called,
   * so shutdown waits for at most the in-flight job, not the whole backlog.
   * Returns jobs handled.
   */
  async drain(): Promise<number> {
    let handled = 0;
    while (!this.stopRequested) {
      const worked = await this.tick();
      if (!worked) return handled;
      handled += 1;
    }
    return handled;
  }

  /** Claims and processes one job. Returns false when nothing is claimable. */
  async tick(): Promise<boolean> {
    const claimed = await this.pool.query<ClaimedJob>(
      `UPDATE opod.agent_memory_jobs
       SET status = 'running',
           lease_expires_at = now() + make_interval(secs => $1 / 1000.0),
           attempt_count = attempt_count + 1,
           updated_at = now()
       WHERE id = (
         SELECT id FROM opod.agent_memory_jobs
         -- queued rows may carry a retry-backoff "not before" in lease_expires_at
         WHERE (status = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
            OR (status = 'running' AND lease_expires_at < now())
         ORDER BY created_at ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, user_id, character_id, payload_json, attempt_count`,
      [this.config.leaseMs],
    );
    const job = claimed.rows[0];
    if (!job) return false;

    const parsed = ConsolidationRequest.safeParse(job.payload_json);
    if (!parsed.success) {
      // A malformed payload can never succeed — fail it permanently.
      await this.finish(job.id, "failed", `invalid payload: ${parsed.error.message}`);
      this.log.error("memory job payload invalid", { jobId: job.id });
      return true;
    }

    // Serialize execution per (user, character): summary/dedup writes for one
    // relationship must never run concurrently across instances. The advisory
    // lock lives on a dedicated connection for the whole consolidation, so an
    // expired-lease reclaim of a still-running job also queues up behind it
    // instead of double-spending LLM calls. A crashed holder's session dies
    // and the lock auto-releases.
    const guard = await this.acquireRelationshipLock(job.user_id, job.character_id);
    if (!guard) {
      // Another instance is consolidating this relationship. Put the job back
      // behind the retry backoff without spending an attempt.
      await this.pool.query(
        `UPDATE opod.agent_memory_jobs
         SET status = 'queued',
             lease_expires_at = now() + make_interval(secs => $2 / 1000.0),
             attempt_count = attempt_count - 1, updated_at = now()
         WHERE id = $1`,
        [job.id, this.config.retryDelayMs],
      );
      this.log.info("memory job deferred; relationship busy", { jobId: job.id });
      return true;
    }

    try {
      await this.consolidation.consolidate(parsed.data);
      await this.finish(job.id, "completed", null);
      this.log.info("memory job consolidated", { jobId: job.id, attempt: job.attempt_count });
    } catch (err) {
      const message = String(err).slice(0, 500);
      if (job.attempt_count >= this.config.maxAttempts) {
        await this.finish(job.id, "failed", message);
        this.log.error("memory job failed permanently", { jobId: job.id, error: message });
      } else {
        // Back to queued behind a retry backoff; a later tick retries it.
        await this.pool.query(
          `UPDATE opod.agent_memory_jobs
           SET status = 'queued',
               lease_expires_at = now() + make_interval(secs => $2 / 1000.0),
               error_message = $3, updated_at = now()
           WHERE id = $1`,
          [job.id, this.config.retryDelayMs, message],
        );
        this.log.warn("memory job failed; will retry", {
          jobId: job.id,
          attempt: job.attempt_count,
          error: message,
        });
      }
    } finally {
      await guard.release();
    }
    return true;
  }

  /**
   * Session-scoped advisory lock keyed by the relationship hash, held on a
   * dedicated connection until release(). Returns null when another holder has
   * it. Advisory locks are cluster-wide, so this serializes across instances.
   */
  private async acquireRelationshipLock(
    userId: string,
    characterId: string,
  ): Promise<{ release: () => Promise<void> } | null> {
    const key = `${userId}|${characterId}`;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [key],
      );
      if (!result.rows[0]?.locked) {
        client.release();
        return null;
      }
    } catch (err) {
      client.release();
      throw err;
    }
    return {
      release: async () => {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        } finally {
          client.release();
        }
      },
    };
  }

  private async finish(id: string, status: "completed" | "failed", error: string | null): Promise<void> {
    // A completed job's payload (raw conversation turns) has been consumed into
    // the memory tables and is never read again — scrub it immediately so PII
    // doesn't linger in the queue. Failed jobs keep theirs: the payload is the
    // only reprocessing unit if a systemic failure is fixed later.
    await this.pool.query(
      `UPDATE opod.agent_memory_jobs
       SET status = $2, lease_expires_at = NULL, error_message = $3, updated_at = now(),
           payload_json = CASE WHEN $2::opod.agent_job_status = 'completed'
                               THEN '{}'::jsonb ELSE payload_json END
       WHERE id = $1`,
      [id, status, error],
    );
  }
}
