import type {
  MemoryStore,
  NewMemory,
  RetrieveOptions,
  SummarySaveResult,
  SummaryWriteGuard,
} from "./memory-store.js";
import type {
  CoreMemory,
  ArchivalMemory,
  RelationshipKey,
  RelationshipState,
  SessionKey,
  Summary,
} from "./types.js";
import { cosineSimilarity } from "./vector.js";
import { rankByRetrievalScore } from "./retrieval.js";

function relKey(k: RelationshipKey): string {
  return JSON.stringify([k.userId, k.characterId]);
}

function sessionKey(k: SessionKey): string {
  return JSON.stringify([k.userId, k.characterId, k.sessionId]);
}

function operationKey(k: RelationshipKey, operation: string): string {
  return JSON.stringify([k.userId, k.characterId, operation]);
}

/**
 * In-memory MemoryStore. Archival memories are keyed by the (user, character)
 * relationship; core blocks and reflection state likewise; summaries by session.
 * Retrieval uses the weighted score from retrieval.ts. Not durable — a dev/test
 * stand-in until the Postgres + pgvector adapter lands (docs/adr/0002, 0005).
 */
export class StubMemoryStore implements MemoryStore {
  private readonly memories = new Map<string, ArchivalMemory[]>();
  private readonly cores = new Map<string, CoreMemory>();
  private readonly states = new Map<string, RelationshipState>();
  private readonly summaries = new Map<string, Summary>();
  private readonly summaryOperations = new Map<string, Set<string>>();
  private readonly memoryOperations = new Map<string, ArchivalMemory[]>();
  private readonly importanceOperations = new Set<string>();
  private readonly coreOperations = new Set<string>();
  private seq = 0;
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  async retrieve(
    key: RelationshipKey,
    queryEmbedding: number[],
    topK: number,
    opts: RetrieveOptions,
  ): Promise<ArchivalMemory[]> {
    const all = this.memories.get(relKey(key)) ?? [];
    const ranked = rankByRetrievalScore(all, queryEmbedding, {
      weights: opts.weights,
      recencyDecay: opts.recencyDecay,
      topK,
    });
    // Touch recency of retrieved rows (Generative Agents updates last_accessed).
    const touchedAt = this.now();
    for (const m of ranked) m.lastAccessedAt = touchedAt;
    return structuredClone(ranked);
  }

  async recentObservations(key: RelationshipKey, limit: number): Promise<ArchivalMemory[]> {
    const all = this.memories.get(relKey(key)) ?? [];
    return structuredClone(
      all
        .filter((m) => m.kind === "observation")
        .slice(-limit)
        .reverse(),
    );
  }

  async upsertMany(
    key: RelationshipKey,
    incoming: NewMemory[],
    operation?: string,
  ): Promise<ArchivalMemory[]> {
    const operationId = operation ? operationKey(key, operation) : null;
    const previous = operationId ? this.memoryOperations.get(operationId) : undefined;
    if (previous) return structuredClone(previous);

    const list = this.memories.get(relKey(key)) ?? [];
    const stored: ArchivalMemory[] = [];
    const at = this.now();
    for (const mem of incoming) {
      // Similarity dedup: skip Observations too close to an existing item.
      const dup = list.some((m) => cosineSimilarity(m.embedding ?? [], mem.embedding) > 0.95);
      if (dup) continue;
      const row: ArchivalMemory = {
        id: `mem_${++this.seq}`,
        userId: key.userId,
        characterId: key.characterId,
        content: mem.content,
        kind: mem.kind,
        importance: mem.importance,
        embedding: mem.embedding,
        evidence: mem.evidence,
        createdAt: at,
        lastAccessedAt: at,
      };
      list.push(row);
      stored.push(row);
    }
    this.memories.set(relKey(key), list);
    if (operationId) this.memoryOperations.set(operationId, structuredClone(stored));
    return structuredClone(stored);
  }

  async getCoreMemory(key: RelationshipKey): Promise<CoreMemory | null> {
    const core = this.cores.get(relKey(key));
    return core ? structuredClone(core) : null;
  }

  async saveCoreMemory(core: CoreMemory, operation?: string): Promise<void> {
    const operationId = operation ? operationKey(core, operation) : null;
    if (operationId && this.coreOperations.has(operationId)) return;
    this.cores.set(relKey(core), structuredClone(core));
    if (operationId) this.coreOperations.add(operationId);
  }

  async getRelationshipState(key: RelationshipKey): Promise<RelationshipState> {
    const state =
      this.states.get(relKey(key)) ?? {
        userId: key.userId,
        characterId: key.characterId,
        importanceSinceReflection: 0,
        updatedAt: this.now(),
      };
    return structuredClone(state);
  }

  async addImportance(
    key: RelationshipKey,
    delta: number,
    operation?: string,
  ): Promise<RelationshipState> {
    const operationId = operation ? operationKey(key, operation) : null;
    if (operationId && this.importanceOperations.has(operationId)) {
      return this.getRelationshipState(key);
    }
    const current =
      this.states.get(relKey(key)) ?? {
        userId: key.userId,
        characterId: key.characterId,
        importanceSinceReflection: 0,
        updatedAt: this.now(),
      };
    const next: RelationshipState = {
      ...current,
      importanceSinceReflection: current.importanceSinceReflection + delta,
      updatedAt: this.now(),
    };
    this.states.set(relKey(key), next);
    if (operationId) this.importanceOperations.add(operationId);
    return structuredClone(next);
  }

  /**
   * Guarded read-modify-write standing in for the Postgres adapter's atomic
   * `UPDATE ... RETURNING`. Subtracts (never zeroes) so overflow carries forward.
   */
  async consumeReflectionBudget(key: RelationshipKey, threshold: number): Promise<number | null> {
    const current =
      this.states.get(relKey(key)) ?? {
        userId: key.userId,
        characterId: key.characterId,
        importanceSinceReflection: 0,
        updatedAt: this.now(),
      };
    const before = current.importanceSinceReflection;
    if (before < threshold) return null;
    this.states.set(relKey(key), {
      ...current,
      importanceSinceReflection: before - threshold,
      updatedAt: this.now(),
    });
    return before;
  }

  async getSummary(key: SessionKey): Promise<Summary | null> {
    const summary = this.summaries.get(sessionKey(key));
    return summary ? structuredClone(summary) : null;
  }

  async saveSummary(
    summary: Summary,
    guard: SummaryWriteGuard,
  ): Promise<SummarySaveResult> {
    const key = sessionKey(summary);
    const applied = this.summaryOperations.get(key) ?? new Set<string>();
    if (applied.has(guard.idempotencyKey)) return "duplicate";

    const currentRevision = this.summaries.get(key)?.revision ?? 0;
    if (
      currentRevision !== guard.expectedRevision ||
      summary.revision !== guard.expectedRevision + 1
    ) {
      return "conflict";
    }

    this.summaries.set(key, structuredClone(summary));
    applied.add(guard.idempotencyKey);
    this.summaryOperations.set(key, applied);
    return "saved";
  }
}
