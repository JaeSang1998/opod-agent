import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  GrantBondInput,
  MemoryStore,
  MemoryRetrievalResult,
  NewMemory,
  RetrieveOptions,
  SummarySaveResult,
  SummaryWriteGuard,
} from "./memory-store.js";
import { nextBondState } from "./bond.js";
import type {
  ArchivalMemory,
  CoreMemory,
  MemoryKind,
  MemoryType,
  MemorySourceMessage,
  RelationshipKey,
  RelationshipState,
  SessionKey,
  Summary,
} from "./types.js";
import { duplicateMemory, lexicalQueryTerms, scoreHybridRetrievalCandidates, scoreRetrievalCandidates,
  validQueryEmbedding, validateMemoryEmbedding } from "./retrieval.js";

/**
 * How many of a relationship's most-recently-accessed memories are loaded as
 * ranking candidates in legacy mode. Hybrid mode applies this bound separately
 * after lexical/semantic ranking of the full scoped stream in PostgreSQL.
 */
const CANDIDATE_LIMIT = 512;

/**
 * Every relationship read/RETURNING projects the same shape — kept in one place.
 *
 * The physical column names intentionally match their domain meanings.
 */
const RELATIONSHIP_COLUMNS = `unreflected_importance_score, bond_experience_points, bond_level,
   last_exchange_at, daily_bond_experience_date, daily_bond_experience_points, updated_at`;

interface RelationshipRow {
  unreflected_importance_score: number;
  bond_experience_points: number;
  bond_level: number;
  last_exchange_at: Date;
  daily_bond_experience_date: string;
  daily_bond_experience_points: number;
  updated_at: Date;
}

interface MemoryRow {
  id: string;
  user_id: string;
  character_id: string;
  memory_text: string;
  derivation_type: MemoryKind;
  importance_score: number;
  memory_embedding: number[] | null;
  supporting_memory_ids: string[] | null;
  created_at: Date;
  last_recalled_at: Date;
  embedding_model?: string | null;
  embedded_text_sha256?: string | null;
  source_session_id?: string | null;
  source_message_snapshots?: MemorySourceMessage[] | null;
  memory_category?: MemoryType | null;
  context_injection_mode: "always" | "retrieved";
  event_occurred_at?: Date | null;
}

function rowToMemory(row: MemoryRow): ArchivalMemory {
  return {
    id: row.id,
    userId: row.user_id,
    characterId: row.character_id,
    content: row.memory_text,
    kind: row.derivation_type,
    importance: row.importance_score,
    contextInjectionMode: row.context_injection_mode,
    ...(row.memory_embedding && row.memory_embedding.length > 0
      ? { embedding: row.memory_embedding }
      : {}),
    ...(row.supporting_memory_ids && row.supporting_memory_ids.length > 0
      ? { evidence: row.supporting_memory_ids }
      : {}),
    ...(row.embedding_model != null ? { embeddingModel: row.embedding_model } : {}),
    ...(row.embedded_text_sha256 != null ? { embeddingSourceSha256: row.embedded_text_sha256 } : {}),
    ...(row.source_session_id != null ? { sourceSessionId: row.source_session_id } : {}),
    ...(row.source_message_snapshots != null
      ? { sourceMessages: row.source_message_snapshots }
      : {}),
    ...(row.memory_category != null ? { memoryType: row.memory_category } : {}),
    ...(row.event_occurred_at != null
      ? { occurredAt: row.event_occurred_at.toISOString() }
      : {}),
    createdAt: row.created_at.toISOString(),
    lastAccessedAt: row.last_recalled_at.toISOString(),
  };
}

/**
 * MemoryStore on the OPOD Postgres (opod.chat_* tables, hosted by
 * service-backend as schema owner). Semantics mirror StubMemoryStore; ranking
 * reuses the shared pure function so stub and Postgres cannot drift. All
 * idempotent writes ride the chat_applied_state_changes ledger or the memory
 * (relationship, write_operation_key, write_batch_index) unique constraint.
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
    return (await this.retrieveWithTrace(key, queryEmbedding, topK, opts)).memories;
  }

  async retrieveWithTrace(
    key: RelationshipKey,
    queryEmbedding: number[],
    topK: number,
    opts: RetrieveOptions,
  ): Promise<MemoryRetrievalResult> {
    if (opts.hybrid) return this.retrieveHybrid(key, queryEmbedding, topK, { ...opts, hybrid: opts.hybrid });
    const candidates = await this.pool.query<MemoryRow>(
      `SELECT * FROM opod.chat_memory_entries
       WHERE user_id = $1 AND character_id = $2
         AND context_injection_mode = 'retrieved'
       ORDER BY last_recalled_at DESC LIMIT $3`,
      [key.userId, key.characterId, CANDIDATE_LIMIT],
    );
    const scored = scoreRetrievalCandidates(candidates.rows.map(rowToMemory), queryEmbedding, {
      weights: opts.weights,
      recencyDecay: opts.recencyDecay,
      topK,
      minRelevance: opts.minRelevance,
    });
    const ranked = scored
      .filter((candidate) => candidate.decision === "selected")
      .map((candidate) => candidate.item);
    if (ranked.length === 0) {
      return {
        memories: [],
        candidates: scored.map((candidate) => ({
          id: candidate.item.id,
          kind: candidate.item.kind,
          rank: candidate.rank,
          score: candidate.score,
          rawRelevance: candidate.rawRelevance,
          decision: candidate.decision,
          reason: candidate.reason,
        })),
      };
    }

    // Touch recency of retrieved rows (Generative Agents recency signal).
    const touchedAt = this.now();
    await this.pool.query(
      `UPDATE opod.chat_memory_entries SET last_recalled_at = $1 WHERE id = ANY($2::uuid[])`,
      [touchedAt, ranked.map((m) => m.id)],
    );
    return {
      memories: ranked.map((m) => ({ ...m, lastAccessedAt: touchedAt.toISOString() })),
      candidates: scored.map((candidate) => ({
        id: candidate.item.id,
        kind: candidate.item.kind,
        rank: candidate.rank,
        score: candidate.score,
        rawRelevance: candidate.rawRelevance,
        decision: candidate.decision,
        reason: candidate.reason,
      })),
    };
  }

  async alwaysMemories(key: RelationshipKey): Promise<ArchivalMemory[]> {
    const result = await this.pool.query<MemoryRow>(
      `SELECT * FROM opod.chat_memory_entries
       WHERE user_id = $1 AND character_id = $2
         AND context_injection_mode = 'always'
       ORDER BY importance_score DESC, created_at DESC, id`,
      [key.userId, key.characterId],
    );
    return result.rows.map(rowToMemory);
  }

  private async retrieveHybrid(
    key: RelationshipKey, queryEmbedding: number[], topK: number,
    opts: RetrieveOptions & { hybrid: NonNullable<RetrieveOptions["hybrid"]> },
  ): Promise<MemoryRetrievalResult> {
    const hybrid = opts.hybrid;
    const terms = lexicalQueryTerms(hybrid.queryText);
    // Scope is applied before both ranking branches, not after a recent-512 sample.
    const lexical = await this.pool.query<MemoryRow>(
      `SELECT m.* FROM opod.chat_memory_entries m
       WHERE user_id = $1 AND character_id = $2
         AND context_injection_mode = 'retrieved'
         AND EXISTS (SELECT 1 FROM unnest($3::text[]) term
                     WHERE strpos(lower(normalize(m.memory_text, NFKC)), term) > 0)
       ORDER BY (SELECT count(*) FROM unnest($3::text[]) term
                 WHERE strpos(lower(normalize(m.memory_text, NFKC)), term) > 0) DESC, id
       LIMIT $4`, [key.userId, key.characterId, terms, CANDIDATE_LIMIT],
    );
    let semantic: MemoryRow[] = [];
    let semanticStatus: NonNullable<MemoryRetrievalResult["hybrid"]>["semanticStatus"] = "query_unavailable";
    if (hybrid.embeddingModel && validQueryEmbedding(queryEmbedding)) {
      try {
        const result = await this.pool.query<MemoryRow>(
          `WITH scoped AS MATERIALIZED (
             SELECT * FROM opod.chat_memory_entries
              WHERE user_id = $1 AND character_id = $2
                AND context_injection_mode = 'retrieved'
           ), compatible AS MATERIALIZED (
             SELECT *, CASE WHEN embedding_model = $3
               AND embedded_text_sha256 = encode(sha256(convert_to(memory_text, 'UTF8')), 'hex')
               AND array_ndims(memory_embedding) = 1 AND cardinality(memory_embedding) = 1024
               AND NOT EXISTS (SELECT 1 FROM unnest(memory_embedding) v
                               WHERE v IS NULL OR NOT (v BETWEEN -3.4028234663852886e38 AND 3.4028234663852886e38))
               AND EXISTS (SELECT 1 FROM unnest(memory_embedding) v WHERE v <> 0)
             THEN memory_embedding::vector(1024) ELSE NULL END AS compatible_vector FROM scoped
           ) SELECT * FROM compatible WHERE compatible_vector IS NOT NULL
             ORDER BY compatible_vector <=> $4::vector(1024), id LIMIT $5`,
          [key.userId, key.characterId, hybrid.embeddingModel, JSON.stringify(queryEmbedding), CANDIDATE_LIMIT],
        );
        semantic = result.rows;
        semanticStatus = semantic.length > 0 ? "used" : "no_valid_index";
      } catch {
        // A semantic backend failure must not erase successful lexical matches.
        semanticStatus = "failed";
      }
    }
    const merged = [...new Map([...lexical.rows, ...semantic].map(row => [row.id, row])).values()];
    const scored = scoreHybridRetrievalCandidates(merged.map(rowToMemory), semanticStatus === "failed" ? [] : queryEmbedding, {
      ...opts, ...hybrid, topK,
    });
    const ranked = scored.filter(c => c.decision === "selected").map(c => c.item);
    const touchedAt = this.now();
    if (ranked.length > 0) await this.pool.query(
      `UPDATE opod.chat_memory_entries SET last_recalled_at = $1
       WHERE user_id = $2 AND character_id = $3 AND id = ANY($4::uuid[])`,
      [touchedAt, key.userId, key.characterId, ranked.map(m => m.id)],
    );
    return {
      memories: ranked.map(m => ({ ...m, lastAccessedAt: touchedAt.toISOString() })),
      candidates: scored.map(c => ({ id: c.item.id, kind: c.item.kind, rank: c.rank, score: c.score,
        rawRelevance: c.rawRelevance, decision: c.decision, reason: c.reason })),
      hybrid: { semanticStatus, lexicalCandidates: lexical.rows.length, semanticCandidates: semantic.length },
    };
  }

  async recentObservations(key: RelationshipKey, limit: number): Promise<ArchivalMemory[]> {
    const result = await this.pool.query<MemoryRow>(
      `SELECT * FROM opod.chat_memory_entries
       WHERE user_id = $1 AND character_id = $2 AND derivation_type = 'observation'
       ORDER BY created_at DESC, write_batch_index DESC LIMIT $3`,
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
    const existing = await this.pool.query<MemoryRow>(
      `SELECT * FROM opod.chat_memory_entries
       WHERE user_id = $1 AND character_id = $2`,
      [key.userId, key.characterId],
    );
    const seen: (NewMemory | ArchivalMemory)[] = existing.rows.map(rowToMemory);
    const survivors: NewMemory[] = [];
    for (const mem of incoming) {
      validateMemoryEmbedding(mem);
      const dup = seen.some((existingMemory) => duplicateMemory(existingMemory, mem));
      if (dup) continue;
      survivors.push(mem);
      seen.push(mem);
    }

    const at = this.now();
    const stored: ArchivalMemory[] = [];
    await this.withTransaction(async (client) => {
      for (const [ordinal, mem] of survivors.entries()) {
        const inserted = await client.query<MemoryRow>(
          `INSERT INTO opod.chat_memory_entries
             (id, user_id, character_id, memory_text, derivation_type, importance_score, memory_embedding,
              supporting_memory_ids, write_operation_key, write_batch_index, created_at, last_recalled_at,
              embedding_model, embedded_text_sha256, source_session_id, source_message_snapshots,
              memory_category, context_injection_mode, event_occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT (user_id, character_id, write_operation_key, write_batch_index) DO NOTHING
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
            mem.embeddingModel ?? null,
            mem.embeddingSourceSha256 ?? null,
            mem.sourceSessionId ?? null,
            mem.sourceMessages ? JSON.stringify(mem.sourceMessages) : null,
            mem.memoryType ?? null,
            mem.contextInjectionMode ?? "retrieved",
            mem.occurredAt ?? null,
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

  /** @deprecated Compatibility facade backed by an always-injected memory row. */
  async getCoreMemory(key: RelationshipKey): Promise<CoreMemory | null> {
    const result = await this.pool.query<{ memory_text: string; created_at: Date }>(
      `SELECT memory_text, created_at FROM opod.chat_memory_entries
       WHERE user_id = $1 AND character_id = $2
         AND write_operation_key LIKE 'compat-core:%'
       ORDER BY created_at DESC LIMIT 1`,
      [key.userId, key.characterId],
    );
    const row = result.rows[0];
    return row
      ? { ...key, content: row.memory_text, updatedAt: row.created_at.toISOString() }
      : null;
  }

  /** @deprecated Compatibility facade; no separate core-memory table is used. */
  async saveCoreMemory(core: CoreMemory, operationKey?: string): Promise<void> {
    const writeKey = `compat-core:${operationKey ?? randomUUID()}`;
    await this.withTransaction(async (client) => {
      if (operationKey) {
        const fresh = await this.claimOperation(client, core, writeKey);
        if (!fresh) return;
      }
      await client.query(
        `DELETE FROM opod.chat_memory_entries
         WHERE user_id = $1 AND character_id = $2
           AND write_operation_key LIKE 'compat-core:%'`,
        [core.userId, core.characterId],
      );
      await client.query(
        `INSERT INTO opod.chat_memory_entries
           (id, user_id, character_id, memory_text, derivation_type,
            importance_score, memory_embedding, memory_category,
            context_injection_mode, supporting_memory_ids,
            write_operation_key, write_batch_index, created_at, last_recalled_at)
         VALUES ($1, $2, $3, $4, 'reflection', 10, ARRAY[]::double precision[],
                 'interpretation', 'always', ARRAY[]::text[], $5, 0, $6, $6)`,
        [randomUUID(), core.userId, core.characterId, core.content, writeKey, this.now()],
      );
    });
  }

  async getRelationshipState(key: RelationshipKey): Promise<RelationshipState> {
    const result = await this.pool.query<RelationshipRow>(
      `SELECT ${RELATIONSHIP_COLUMNS} FROM opod.chat_relationship_states
       WHERE user_id = $1 AND character_id = $2`,
      [key.userId, key.characterId],
    );
    return this.mapRelationshipRow(key, result.rows[0]);
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
          const state = await client.query<RelationshipRow>(
            `SELECT ${RELATIONSHIP_COLUMNS} FROM opod.chat_relationship_states
             WHERE user_id = $1 AND character_id = $2`,
            [key.userId, key.characterId],
          );
          return this.mapRelationshipRow(key, state.rows[0]);
        }
      }
      const updated = await client.query<RelationshipRow>(
        `INSERT INTO opod.chat_relationship_states
           (user_id, character_id, unreflected_importance_score, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, character_id)
         DO UPDATE SET
           unreflected_importance_score =
             opod.chat_relationship_states.unreflected_importance_score + EXCLUDED.unreflected_importance_score,
           updated_at = EXCLUDED.updated_at
         RETURNING ${RELATIONSHIP_COLUMNS}`,
        [key.userId, key.characterId, delta, this.now()],
      );
      return this.mapRelationshipRow(key, updated.rows[0]);
    });
  }

  async grantBond(
    key: RelationshipKey,
    input: GrantBondInput,
    operationKey?: string,
  ): Promise<RelationshipState> {
    return this.withTransaction(async (client) => {
      // SELECT ... FOR UPDATE, not a bare read: the level floor and the daily
      // cap are read-modify-write, so two turns landing on the same
      // relationship at once would otherwise both compute from the same
      // `before` and one grade would vanish. addImportance can stay lock-free
      // because it is a pure increment the database can do itself.
      const existing = await client.query<RelationshipRow>(
        `SELECT ${RELATIONSHIP_COLUMNS} FROM opod.chat_relationship_states
         WHERE user_id = $1 AND character_id = $2 FOR UPDATE`,
        [key.userId, key.characterId],
      );
      const before = this.mapRelationshipRow(key, existing.rows[0]);

      if (operationKey) {
        const fresh = await this.claimOperation(client, key, `bond:${operationKey}`);
        if (!fresh) return before;
      }

      const next = nextBondState(
        {
          bondXp: before.bondXp,
          lastExchangeAtMs: Date.parse(before.lastExchangeAt),
          dailyBondDate: before.dailyBondDate,
          dailyBondXp: before.dailyBondXp,
        },
        input,
      );

      const updated = await client.query<RelationshipRow>(
        `INSERT INTO opod.chat_relationship_states
           (user_id, character_id, bond_experience_points, bond_level, last_exchange_at,
            daily_bond_experience_date, daily_bond_experience_points, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, character_id)
         DO UPDATE SET
           bond_experience_points = EXCLUDED.bond_experience_points,
           bond_level = EXCLUDED.bond_level,
           last_exchange_at = EXCLUDED.last_exchange_at,
           daily_bond_experience_date = EXCLUDED.daily_bond_experience_date,
           daily_bond_experience_points = EXCLUDED.daily_bond_experience_points,
           updated_at = EXCLUDED.updated_at
         RETURNING ${RELATIONSHIP_COLUMNS}`,
        [
          key.userId,
          key.characterId,
          next.bondXp,
          next.bondLevel,
          new Date(next.lastExchangeAtMs),
          next.dailyBondDate,
          next.dailyBondXp,
          this.now(),
        ],
      );
      return this.mapRelationshipRow(key, updated.rows[0]);
    });
  }

  /** Absent row = a relationship that has never been written; zeroed defaults. */
  private mapRelationshipRow(
    key: RelationshipKey,
    row: RelationshipRow | undefined,
  ): RelationshipState {
    const now = this.now();
    return {
      userId: key.userId,
      characterId: key.characterId,
      importanceSinceReflection: row?.unreflected_importance_score ?? 0,
      bondXp: row?.bond_experience_points ?? 0,
      bondLevel: row?.bond_level ?? 1,
      lastExchangeAt: (row?.last_exchange_at ?? now).toISOString(),
      dailyBondDate: row?.daily_bond_experience_date ?? "",
      dailyBondXp: row?.daily_bond_experience_points ?? 0,
      updatedAt: (row?.updated_at ?? now).toISOString(),
    };
  }

  async consumeReflectionBudget(key: RelationshipKey, threshold: number): Promise<number | null> {
    // Single atomic compare-and-consume: subtract (never zero) so overflow
    // carries forward, and concurrent jobs cannot both cross the threshold.
    const result = await this.pool.query<{ before: number }>(
      `UPDATE opod.chat_relationship_states
       SET unreflected_importance_score = unreflected_importance_score - $3,
           updated_at = $4
       WHERE user_id = $1 AND character_id = $2 AND unreflected_importance_score >= $3
       RETURNING unreflected_importance_score + $3 AS before`,
      [key.userId, key.characterId, threshold, this.now()],
    );
    return result.rows[0]?.before ?? null;
  }

  async getSummary(key: SessionKey): Promise<Summary | null> {
    const result = await this.pool.query<{
      summary_text: string;
      summarized_message_count: number;
      revision_number: number;
      updated_at: Date;
    }>(
      `SELECT summary_text, summarized_message_count, revision_number, updated_at
         FROM opod.chat_memory_session_summaries
       WHERE user_id = $1 AND character_id = $2 AND session_id = $3`,
      [key.userId, key.characterId, key.sessionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: key.userId,
      characterId: key.characterId,
      sessionId: key.sessionId,
      content: row.summary_text,
      turnsCovered: row.summarized_message_count,
      revision: row.revision_number,
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
              `INSERT INTO opod.chat_memory_session_summaries
                 (user_id, character_id, session_id, summary_text, summarized_message_count, revision_number, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (user_id, character_id, session_id) DO NOTHING`,
              params,
            )
          : await client.query(
              `UPDATE opod.chat_memory_session_summaries
               SET summary_text = $4, summarized_message_count = $5, revision_number = $6, updated_at = $7
               WHERE user_id = $1 AND character_id = $2 AND session_id = $3
                 AND revision_number = $6 - 1`,
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
      `SELECT * FROM opod.chat_memory_entries
       WHERE user_id = $1 AND character_id = $2 AND write_operation_key = $3
       ORDER BY write_batch_index ASC`,
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
      `INSERT INTO opod.chat_applied_state_changes (id, user_id, character_id, idempotency_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, character_id, idempotency_key) DO NOTHING
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
