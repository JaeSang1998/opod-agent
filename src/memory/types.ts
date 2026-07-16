/**
 * Memory model (see docs/adr/0005). Grounded in two lines of research:
 *  - Generative Agents (Park et al. 2023): an append-only memory stream of
 *    Observations, each scored for importance (poignancy 1-10), plus Reflections
 *    synthesized when accumulated importance crosses a threshold.
 *  - MemGPT / Letta (Packer et al. 2023): a compact, self-rewritten Core block
 *    that always stays in context — the character's mental model of the user.
 *
 * Tiers:
 *  - Short-term: recent turns, passed in by the caller — not stored here.
 *  - Archival:   LongTermMemory (observations + reflections) in pgvector, keyed
 *                by the (user, character) relationship, importance-weighted.
 *  - Core:       CoreMemory — a small always-injected relationship digest.
 *  - Summary:    a rolling episodic compression, keyed by session.
 */

export type MemoryKind = "observation" | "reflection";

export interface RelationshipKey {
  userId: string;
  characterId: string;
}

export interface SessionKey extends RelationshipKey {
  sessionId: string;
}

export interface LongTermMemory {
  id: string;
  userId: string;
  characterId: string;
  /** The remembered fact/insight, phrased as a standalone statement. */
  content: string;
  kind: MemoryKind;
  /** Poignancy 1-10 assigned at creation; drives retrieval + reflection trigger. */
  importance: number;
  /** Embedding of `content`; may be absent in stub retrieval paths. */
  embedding?: number[];
  /** For reflections: ids of the memories this insight was inferred from. */
  evidence?: string[];
  createdAt: string;
  /** Last time this memory was retrieved — the recency signal. */
  lastAccessedAt: string;
}

/**
 * MemGPT-style core block: a compact, self-rewritten digest of the user that the
 * character always sees. Relationship-scoped (survives across sessions).
 */
export interface CoreMemory {
  userId: string;
  characterId: string;
  content: string;
  updatedAt: string;
}

/**
 * Per-relationship state backing the autonomous reflection trigger. Accumulates
 * the importance of new observations; when it crosses the threshold the Agent
 * reflects and the accumulator resets (Generative Agents' importance trigger).
 */
export interface RelationshipState {
  userId: string;
  characterId: string;
  importanceSinceReflection: number;
  updatedAt: string;
}

export interface Summary extends SessionKey {
  content: string;
  /** How many turns are already folded into this summary. */
  turnsCovered: number;
  /** Monotonic version used for compare-and-swap updates. */
  revision: number;
  updatedAt: string;
}
