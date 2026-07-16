import type { JobQueue, MemoryUpdateJob } from "./job-queue.js";
import { type Logger, noopLogger } from "../bootstrap/logger.js";

/**
 * In-memory JobQueue. Records enqueued jobs (inspectable in tests) and logs them.
 * In production this is replaced by a Postgres-backed producer.
 */
export class StubJobQueue implements JobQueue {
  readonly enqueued: MemoryUpdateJob[] = [];
  private readonly idempotencyKeys = new Set<string>();

  constructor(private readonly log: Logger = noopLogger) {}

  async enqueueMemoryUpdate(job: MemoryUpdateJob): Promise<void> {
    if (this.idempotencyKeys.has(job.idempotencyKey)) {
      this.log.debug("skipped duplicate memory-update job", {
        idempotencyKey: job.idempotencyKey,
        correlationId: job.correlationId,
      });
      return;
    }
    this.enqueued.push(job);
    this.idempotencyKeys.add(job.idempotencyKey);
    this.log.debug("enqueued memory-update job", {
      idempotencyKey: job.idempotencyKey,
      correlationId: job.correlationId,
      reason: job.reason,
      sessionId: job.sessionId,
      characterId: job.characterId,
      refreshSummary: job.refreshSummary,
    });
  }
}
