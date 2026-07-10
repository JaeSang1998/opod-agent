import type { JobQueue, MemoryUpdateJob } from "../JobQueue.js";

/**
 * In-memory JobQueue. Records enqueued jobs (inspectable in tests) and logs them.
 * In production this is replaced by a Postgres-backed producer.
 */
export class StubJobQueue implements JobQueue {
  readonly enqueued: MemoryUpdateJob[] = [];

  constructor(private readonly log: (msg: string, meta?: unknown) => void = () => {}) {}

  async enqueueMemoryUpdate(job: MemoryUpdateJob): Promise<void> {
    this.enqueued.push(job);
    this.log("enqueued memory-update job", {
      sessionId: job.sessionId,
      characterId: job.characterId,
      refreshSummary: job.refreshSummary,
    });
  }
}
