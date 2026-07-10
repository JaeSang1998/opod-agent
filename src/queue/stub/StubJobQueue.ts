import type { JobQueue, MemoryUpdateJob } from "../JobQueue.js";
import { type Logger, noopLogger } from "../../logging/logger.js";

/**
 * In-memory JobQueue. Records enqueued jobs (inspectable in tests) and logs them.
 * In production this is replaced by a Postgres-backed producer.
 */
export class StubJobQueue implements JobQueue {
  readonly enqueued: MemoryUpdateJob[] = [];

  constructor(private readonly log: Logger = noopLogger) {}

  async enqueueMemoryUpdate(job: MemoryUpdateJob): Promise<void> {
    this.enqueued.push(job);
    this.log.debug("enqueued memory-update job", {
      sessionId: job.sessionId,
      characterId: job.characterId,
      refreshSummary: job.refreshSummary,
    });
  }
}
