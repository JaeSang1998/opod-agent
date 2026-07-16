import type {
  CoreMemory,
  ArchivalMemory,
  MemoryKind,
  RelationshipKey,
  RelationshipState,
  SessionKey,
  Summary,
} from "./types.js";
import type { RetrievalWeights } from "./retrieval.js";

export type { RelationshipKey } from "./types.js";

export interface NewMemory {
  content: string;
  embedding: number[];
  importance: number;
  kind: MemoryKind;
  /** For reflections: source memory ids this was inferred from. */
  evidence?: string[];
}

export interface RetrieveOptions {
  weights: RetrievalWeights;
  recencyDecay: number;
}

export interface SummaryWriteGuard {
  /** Stable worker job id; applying the same job twice must be a no-op. */
  idempotencyKey: string;
  /** Revision observed before producing the new Summary. */
  expectedRevision: number;
}

export type SummarySaveResult = "saved" | "duplicate" | "conflict";

/**
 * Data-access seam for memory (docs/adr/0002, 0005). Default (stub) is in-memory;
 * the Postgres + pgvector adapter lands once the schema is confirmed.
 */
export interface MemoryStore {
  /**
   * Archival memories for a relationship, ranked by the weighted retrieval score
   * (recency · importance · relevance). Retrieved rows have their recency touched.
   */
  retrieve(
    key: RelationshipKey,
    queryEmbedding: number[],
    topK: number,
    opts: RetrieveOptions,
  ): Promise<ArchivalMemory[]>;

  /** The most recently created observations (used to seed a reflection pass). */
  recentObservations(key: RelationshipKey, limit: number): Promise<ArchivalMemory[]>;

  /**
   * Persist a memory batch. When `operationKey` is present, retries return the
   * original logical result without applying a changed/stochastic batch again.
   */
  upsertMany(
    key: RelationshipKey,
    memories: NewMemory[],
    operationKey?: string,
  ): Promise<ArchivalMemory[]>;

  /** The MemGPT-style core block for a relationship. */
  getCoreMemory(key: RelationshipKey): Promise<CoreMemory | null>;
  saveCoreMemory(core: CoreMemory, operationKey?: string): Promise<void>;

  /**
   * Reflection-trigger accumulator (Generative Agents). Add the importance of the
   * newly stored observations, then atomically try to consume a reflection budget.
   */
  addImportance(
    key: RelationshipKey,
    delta: number,
    operationKey?: string,
  ): Promise<RelationshipState>;
  /**
   * Atomic compare-and-consume of the reflection accumulator. If
   * `importanceSinceReflection >= threshold`, subtract `threshold` (leaving any
   * overflow so a big batch can't skip the next reflection) and return the
   * pre-consume accumulator value; otherwise leave it untouched and return `null`.
   * Must be atomic — a single `UPDATE ... RETURNING` in the Postgres adapter — so
   * two concurrent consolidation jobs can't both cross the same threshold, and
   * importance added during a long reflect() is never silently zeroed.
   */
  consumeReflectionBudget(key: RelationshipKey, threshold: number): Promise<number | null>;

  getSummary(key: SessionKey): Promise<Summary | null>;
  /**
   * Atomically save a Summary when its revision still matches, and record the
   * idempotency key in the same transaction. Database adapters should enforce a
   * unique `(user, character, session, idempotency_key)` constraint.
   */
  saveSummary(summary: Summary, guard: SummaryWriteGuard): Promise<SummarySaveResult>;
}
