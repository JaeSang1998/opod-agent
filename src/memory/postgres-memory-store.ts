import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  MemoryStore,
  NewMemory,
  RetrieveOptions,
  SummarySaveResult,
  SummaryWriteGuard,
} from "./memory-store.js";
import type {
  ArchivalMemory,
  CoreMemory,
  MemoryKind,
  RelationshipKey,
  RelationshipState,
  SessionKey,
  Summary,
} from "./types.js";
import { cosineSimilarity } from "./vector.js";
import { rankByRetrievalScore } from "./retrieval.js";

/**
 * How many of a relationship's most-recently-accessed memories are loaded as
 * ranking candidates. Per-relationship streams are small (hundreds for a heavy
 * user), so an app-side scan matches the stub's semantics exactly; pgvector
 * candidate narrowing is deferred until volume warrants it (docs/
 * persona-memory-plan.md — same observe-then-adopt rule as the content
 * pipeline).
 */
const CANDIDATE_LIMIT = 512;

/** Observations closer than this to an existing memory are duplicates (stub parity). */
const DEDUP_SIMILARITY = 0.95;

interface MemoryRow {
  id: string;
  user_id: string;
  character_id: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  embedding: number[] | null;
  evidence: string[] | null;
  created_at: Date;
  last_accessed_at: Date;
}

function rowToMemory(row: MemoryRow): ArchivalMemory {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    content: row.content,
    kind: row.kind,
    importance: row.importance,
    ...(row.embedding && row.embedding.length > 0 ? { embedding: row.embedding } : {}),
    ...(row.evidence && row.evidence.length > 0 ? { evidence: row.evidence } : {}),
    createdAt: row.created_at.toISOString(),
    lastAccessedAt: row.last_accessed_at.toISOString(),
  };
}

/**
 * MemoryStore on the OPOD Postgres (opod.agent_* tables, hosted by
 * service-backend as schema owner). Semantics mirror StubMemoryStore; ranking
 * reuses the shared pure function so stub and Postgres cannot drift. All
 * idempotent writes ride the agent_memory_operations ledger or the archival
 * (relationship, operation_key, ordinal) unique constraint.
 */
export class PostgresMemoryStore implements MemoryStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async retrieve(
    key: RelationshipKey,
    queryEmbedding: number[],
    topK: number,
    opts: RetrieveOptions,
  ): Promise<ArchivalMemory[]> {
    const candidates = await this.pool.query<MemoryRow>(
      `SELECT * FROM opod.agent_archival_memories
       WHERE user_id = $1 AND character_id = $2
       ORDER BY last_accessed_at DESC LIMIT $3`,
      [key.userId, key.characterId, CANDIDATE_LIMIT],
    );
    const ranked = rankByRetrievalScore(candidates.rows.map(rowToMemory), queryEmbedding, {
      weights: opts.weights,
      recencyDecay: opts.recencyDecay,
      topK,
    });
    if (ranked.length === 0) return [];

    // Touch recency of retrieved rows (Generative Agents updates last_accessed).
    const touchedAt = this.now();
    await this.pool.query(
      `UPDATE opod.agent_archival_memories SET last_accessed_at = $1 WHERE id = ANY($2::uuid[])`,
      [touchedAt, ranked.map((m) => m.id)],
    );
    return ranked.map((m) => ({ ...m, lastAccessedAt: touchedAt.toISOString() }));
  }

  async recentObservations(key: RelationshipKey, limit: number): Promise<ArchivalMemory[]> {
    const result = await this.pool.query<MemoryRow>(
      `SELECT * FROM opod.agent_archival_memories
       WHERE user_id = $1 AND character_id = $2 AND kind = 'observation'
       ORDER BY created_at DESC, ordinal DESC LIMIT $3`,
      [key.userId, key.characterId, limit],
    );
    return result.rows.map(rowToMemory);
  }

  async upsertMany(
    key: RelationshipKey,
    incoming: NewMemory[],
    operationKey?: string,
  ): Promise<ArchivalMemory[]> {
    if (operationKey) {
      const previous = await this.memoriesForOperation(key, operationKey);
      if (previous.length > 0) return previous;
    }

    // Similarity dedup against the existing stream and earlier batch items.
    const existing = await this.pool.query<{ embedding: number[] | null }>(
      `SELECT embedding FROM opod.agent_archival_memories
       WHERE user_id = $1 AND character_id = $2`,
      [key.userId, key.characterId],
    );
    const seen = existing.rows.map((r) => r.embedding ?? []);
    const survivors: NewMemory[] = [];
    for (const mem of incoming) {
      const dup = seen.some((e) => cosineSimilarity(e, mem.embedding) > DEDUP_SIMILARITY);
      if (dup) continue;
      survivors.push(mem);
      seen.push(mem.embedding);
    }

    const at = this.now();
    const stored: ArchivalMemory[] = [];
    await this.withTransaction(async (client) => {
      for (const [ordinal, mem] of survivors.entries()) {
        const inserted = await client.query<MemoryRow>(
          `INSERT INTO opod.agent_archival_memories
             (id, user_id, character_id, content, kind, importance, embedding,
              evidence, operation_key, ordinal, created_at, last_accessed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
           ON CONFLICT (user_id, character_id, operation_key, ordinal) DO NOTHING
           RETURNING *`,
          [
            randomUUID(),
            key.userId,
            key.characterId,
            mem.content,
            mem.kind,
            mem.importance,
            mem.embedding,
            mem.evidence ?? [],
            operationKey ?? null,
            ordinal,
            at,
          ],
        );
        if (inserted.rows[0]) stored.push(rowToMemory(inserted.rows[0]));
      }
    });

    // A concurrent retry may have won some inserts; the operation's stored rows
    // are the logical result either way.
    if (operationKey && stored.length !== survivors.length) {
      return this.memoriesForOperation(key, operationKey);
    }
    return stored;
  }

  async getCoreMemory(key: RelationshipKey): Promise<CoreMemory | null> {
    const result = await this.pool.query<{ content: string; updated_at: Date }>(
      `SELECT content, updated_at FROM opod.agent_core_memories
       WHERE user_id = $1 AND character_id = $2`,
      [key.userId, key.characterId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: key.userId,
      characterId: key.characterId,
      content: row.content,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async saveCoreMemory(core: CoreMemory, operationKey?: string): Promise<void> {
    await this.withTransaction(async (client) => {
      if (operationKey) {
        const fresh = await this.claimOperation(client, core, `core:${operationKey}`);
        if (!fresh) return;
      }
      await client.query(
        `INSERT INTO opod.agent_core_memories (user_id, character_id, content, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, character_id)
         DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
        [core.userId, core.characterId, core.content, this.now()],
      );
    });
  }

  async getRelationshipState(key: RelationshipKey): Promise<RelationshipState> {
    const result = await this.pool.query<{
      importance_since_reflection: number;
      updated_at: Date;
    }>(
      `SELECT importance_since_reflection, updated_at FROM opod.agent_relationship_state
       WHERE user_id = $1 AND character_id = $2`,
      [key.userId, key.characterId],
    );
    const row = result.rows[0];
    return {
      userId: key.userId,
      characterId: key.characterId,
      importanceSinceReflection: row?.importance_since_reflection ?? 0,
      updatedAt: (row?.updated_at ?? this.now()).toISOString(),
    };
  }

  async addImportance(
    key: RelationshipKey,
    delta: number,
    operationKey?: string,
  ): Promise<RelationshipState> {
    return this.withTransaction(async (client) => {
      if (operationKey) {
        const fresh = await this.claimOperation(client, key, `importance:${operationKey}`);
        if (!fresh) {
          const state = await client.query<{
            importance_since_reflection: number;
            updated_at: Date;
          }>(
            `SELECT importance_since_reflection, updated_at FROM opod.agent_relationship_state
             WHERE user_id = $1 AND character_id = $2`,
            [key.userId, key.characterId],
          );
          const row = state.rows[0];
          return {
            userId: key.userId,
            characterId: key.characterId,
            importanceSinceReflection: row?.importance_since_reflection ?? 0,
            updatedAt: (row?.updated_at ?? this.now()).toISOString(),
          };
        }
      }
      const updated = await client.query<{
        importance_since_reflection: number;
        updated_at: Date;
      }>(
        `INSERT INTO opod.agent_relationship_state
           (user_id, character_id, importance_since_reflection, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, character_id)
         DO UPDATE SET
           importance_since_reflection =
             opod.agent_relationship_state.importance_since_reflection + EXCLUDED.importance_since_reflection,
           updated_at = EXCLUDED.updated_at
         RETURNING importance_since_reflection, updated_at`,
        [key.userId, key.characterId, delta, this.now()],
      );
      const row = updated.rows[0];
      return {
        userId: key.userId,
        characterId: key.characterId,
        importanceSinceReflection: row?.importance_since_reflection ?? delta,
        updatedAt: (row?.updated_at ?? this.now()).toISOString(),
      };
    });
  }

  async consumeReflectionBudget(key: RelationshipKey, threshold: number): Promise<number | null> {
    // Single atomic compare-and-consume: subtract (never zero) so overflow
    // carries forward, and concurrent jobs cannot both cross the threshold.
    const result = await this.pool.query<{ before: number }>(
      `UPDATE opod.agent_relationship_state
       SET importance_since_reflection = importance_since_reflection - $3,
           updated_at = $4
       WHERE user_id = $1 AND character_id = $2 AND importance_since_reflection >= $3
       RETURNING importance_since_reflection + $3 AS before`,
      [key.userId, key.characterId, threshold, this.now()],
    );
    return result.rows[0]?.before ?? null;
  }

  async getSummary(key: SessionKey): Promise<Summary | null> {
    const result = await this.pool.query<{
      content: string;
      turns_covered: number;
      revision: number;
      updated_at: Date;
    }>(
      `SELECT content, turns_covered, revision, updated_at FROM opod.agent_summaries
       WHERE user_id = $1 AND character_id = $2 AND session_id = $3`,
      [key.userId, key.characterId, key.sessionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: key.userId,
      characterId: key.characterId,
      sessionId: key.sessionId,
      content: row.content,
      turnsCovered: row.turns_covered,
      revision: row.revision,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async saveSummary(summary: Summary, guard: SummaryWriteGuard): Promise<SummarySaveResult> {
    return this.withTransaction(async (client) => {
      // Idempotency first: an already-applied job is a duplicate regardless of
      // the (now advanced) revision. The ledger row commits only with a save.
      const fresh = await this.claimOperation(
        client,
        summary,
        `summary:${summary.sessionId}:${guard.idempotencyKey}`,
      );
      if (!fresh) return "duplicate";

      if (summary.revision !== guard.expectedRevision + 1) {
        // Roll back so the ledger row is not recorded for a rejected write.
        throw new SummaryConflict();
      }

      // Atomic conditional writes — no check-then-write gap. For the first
      // revision a `SELECT … FOR UPDATE` would lock nothing (no row yet), so
      // two concurrent creators could both pass a read check; instead the PK
      // unique constraint picks the winner and the loser sees rowCount 0.
      const params = [
        summary.userId,
        summary.characterId,
        summary.sessionId,
        summary.content,
        summary.turnsCovered,
        summary.revision,
        this.now(),
      ];
      const written =
        guard.expectedRevision === 0
          ? await client.query(
              `INSERT INTO opod.agent_summaries
                 (user_id, character_id, session_id, content, turns_covered, revision, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (user_id, character_id, session_id) DO NOTHING`,
              params,
            )
          : await client.query(
              `UPDATE opod.agent_summaries
               SET content = $4, turns_covered = $5, revision = $6, updated_at = $7
               WHERE user_id = $1 AND character_id = $2 AND session_id = $3
                 AND revision = $6 - 1`,
              params,
            );
      if (written.rowCount === 0) {
        throw new SummaryConflict();
      }
      return "saved";
    }).catch((err: unknown) => {
      if (err instanceof SummaryConflict) return "conflict" as const;
      throw err;
    });
  }

  /** Rows previously stored under an operation, in batch order. */
  private async memoriesForOperation(
    key: RelationshipKey,
    operationKey: string,
  ): Promise<ArchivalMemory[]> {
    const result = await this.pool.query<MemoryRow>(
      `SELECT * FROM opod.agent_archival_memories
       WHERE user_id = $1 AND character_id = $2 AND operation_key = $3
       ORDER BY ordinal ASC`,
      [key.userId, key.characterId, operationKey],
    );
    return result.rows.map(rowToMemory);
  }

  /** True when this operation key was claimed now; false when already applied. */
  private async claimOperation(
    client: PoolClient,
    key: RelationshipKey,
    operationKey: string,
  ): Promise<boolean> {
    const claimed = await client.query(
      `INSERT INTO opod.agent_memory_operations (id, user_id, character_id, operation_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, character_id, operation_key) DO NOTHING
       RETURNING id`,
      [randomUUID(), key.userId, key.characterId, operationKey],
    );
    return claimed.rows.length > 0;
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Internal control-flow marker for the summary CAS rejection path. */
class SummaryConflict extends Error {
  constructor() {
    super("summary revision conflict");
  }
}
