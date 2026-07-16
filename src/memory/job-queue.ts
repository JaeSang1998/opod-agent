import type { ConsolidationRequest } from "../protocol/consolidation.js";

/**
 * Payload for a "memory-update" job. The Agent produces these when it judges
 * consolidation is warranted; opod-worker executes them against the Agent's
 * /memory/consolidate endpoint (docs/adr/0004).
 */
export type MemoryUpdateJob = ConsolidationRequest;

/**
 * Producer seam onto the existing Postgres job queue. The stub logs/records;
 * the Postgres adapter inserts a row into the shared jobs table.
 */
export interface JobQueue {
  enqueueMemoryUpdate(job: MemoryUpdateJob): Promise<void>;
}
