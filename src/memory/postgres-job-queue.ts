import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { JobQueue, MemoryUpdateJob } from "./job-queue.js";

/**
 * Producer onto the durable opod.agent_memory_jobs queue (docs/adr/0004; table
 * hosted by service-backend as schema owner). The idempotency-key unique
 * constraint makes re-enqueueing the same logical job a no-op, so retried turns
 * cannot fan out duplicate consolidations.
 */
export class PostgresJobQueue implements JobQueue {
  constructor(private readonly pool: Pool) {}

  async enqueueMemoryUpdate(job: MemoryUpdateJob): Promise<void> {
    await this.pool.query(
      `INSERT INTO opod.agent_memory_jobs
         (id, idempotency_key, user_id, character_id, payload_json, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), job.idempotencyKey, job.userId, job.characterId, JSON.stringify(job)],
    );
  }
}
