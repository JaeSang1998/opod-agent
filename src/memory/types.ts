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
 *  - Archival:   ArchivalMemory (Observations + Reflections), keyed
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

export interface ArchivalMemory {
  id: string;
  userId: string;
  characterId: string;
  /** The remembered Observation or Reflection, phrased as a standalone statement. */
  content: string;
  kind: MemoryKind;
  /** Poignancy 1-10 assigned at creation; drives retrieval + reflection trigger. */
  importance: number;
  /** Embedding of `content`; may be absent in stub retrieval paths. */
  embedding?: number[];
  /** For Reflections: ids of the memories this Reflection was inferred from. */
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
 * Per-relationship state. Carries two independent things that happen to share
 * a row because they share a key:
 *
 *  - the autonomous reflection trigger — accumulates the importance of new
 *    observations; when it crosses the threshold the Agent reflects and the
 *    accumulator resets (Generative Agents' importance trigger);
 *  - the Bond (see `bond.ts`) — how far this relationship has come (`bondXp`,
 *    which a level is read off) and when they last spoke (`lastExchangeAt`,
 *    which recency is read off).
 */
export interface RelationshipState {
  userId: string;
  characterId: string;
  importanceSinceReflection: number;
  /** Lifetime bond accumulator. Never drops below the floor of the level it earned. */
  bondXp: number;
  /** Level derived from `bondXp`, stored so other services need no copy of the table. */
  bondLevel: number;
  /**
   * When they last traded messages (ISO). Recency is derived from it on read.
   * Persisted in the `last_decay_at` column, which keeps its old name until the
   * schema catches up in opod-service-backend.
   */
  lastExchangeAt: string;
  /** Service-date (KST `YYYY-MM-DD`) the daily bond counter belongs to. */
  dailyBondDate: string;
  /** bondXp already granted on `dailyBondDate`. */
  dailyBondXp: number;
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
