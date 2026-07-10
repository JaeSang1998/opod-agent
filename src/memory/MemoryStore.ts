import type { CoreMemory, LongTermMemory, MemoryKind, RelationshipState, Summary } from "./types.js";
import type { RetrievalWeights } from "./retrieval.js";

export interface RelationshipKey {
  userId: string;
  characterId: string;
}

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
  ): Promise<LongTermMemory[]>;

  /** The most recently created observations (used to seed a reflection pass). */
  recentObservations(key: RelationshipKey, limit: number): Promise<LongTermMemory[]>;

  /** Persist newly extracted memories; returns the stored rows (with ids). */
  upsertMany(key: RelationshipKey, memories: NewMemory[]): Promise<LongTermMemory[]>;

  /** The MemGPT-style core block for a relationship. */
  getCoreMemory(key: RelationshipKey): Promise<CoreMemory | null>;
  saveCoreMemory(core: CoreMemory): Promise<void>;

  /** Reflection-trigger accumulator (Generative Agents). */
  getRelationshipState(key: RelationshipKey): Promise<RelationshipState>;
  addImportance(key: RelationshipKey, delta: number): Promise<RelationshipState>;
  resetImportance(key: RelationshipKey): Promise<void>;

  getSummary(sessionId: string): Promise<Summary | null>;
  saveSummary(summary: Summary): Promise<void>;
}
