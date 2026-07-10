import type {
  MemoryStore,
  NewMemory,
  RelationshipKey,
  RetrieveOptions,
} from "../MemoryStore.js";
import type { CoreMemory, LongTermMemory, RelationshipState, Summary } from "../types.js";
import { cosineSimilarity } from "../vector.js";
import { rankByRetrievalScore } from "../retrieval.js";

function relKey(k: RelationshipKey): string {
  return `${k.userId}::${k.characterId}`;
}

/**
 * In-memory MemoryStore. Archival memories are keyed by the (user, character)
 * relationship; core blocks and reflection state likewise; summaries by session.
 * Retrieval uses the weighted score from retrieval.ts. Not durable — a dev/test
 * stand-in until the Postgres + pgvector adapter lands (docs/adr/0002, 0005).
 */
export class StubMemoryStore implements MemoryStore {
  private readonly memories = new Map<string, LongTermMemory[]>();
  private readonly cores = new Map<string, CoreMemory>();
  private readonly states = new Map<string, RelationshipState>();
  private readonly summaries = new Map<string, Summary>();
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
  ): Promise<LongTermMemory[]> {
    const all = this.memories.get(relKey(key)) ?? [];
    const ranked = rankByRetrievalScore(all, queryEmbedding, {
      weights: opts.weights,
      recencyDecay: opts.recencyDecay,
      topK,
    });
    // Touch recency of retrieved rows (Generative Agents updates last_accessed).
    const touchedAt = this.now();
    for (const m of ranked) m.lastAccessedAt = touchedAt;
    return ranked;
  }

  async recentObservations(key: RelationshipKey, limit: number): Promise<LongTermMemory[]> {
    const all = this.memories.get(relKey(key)) ?? [];
    return all
      .filter((m) => m.kind === "observation")
      .slice(-limit)
      .reverse();
  }

  async upsertMany(key: RelationshipKey, incoming: NewMemory[]): Promise<LongTermMemory[]> {
    const list = this.memories.get(relKey(key)) ?? [];
    const stored: LongTermMemory[] = [];
    const at = this.now();
    for (const mem of incoming) {
      // Similarity dedup: skip facts too close to an existing one.
      const dup = list.some((m) => cosineSimilarity(m.embedding ?? [], mem.embedding) > 0.95);
      if (dup) continue;
      const row: LongTermMemory = {
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
    return stored;
  }

  async getCoreMemory(key: RelationshipKey): Promise<CoreMemory | null> {
    return this.cores.get(relKey(key)) ?? null;
  }

  async saveCoreMemory(core: CoreMemory): Promise<void> {
    this.cores.set(relKey(core), core);
  }

  async getRelationshipState(key: RelationshipKey): Promise<RelationshipState> {
    return (
      this.states.get(relKey(key)) ?? {
        userId: key.userId,
        characterId: key.characterId,
        importanceSinceReflection: 0,
        updatedAt: this.now(),
      }
    );
  }

  async addImportance(key: RelationshipKey, delta: number): Promise<RelationshipState> {
    const current = await this.getRelationshipState(key);
    const next: RelationshipState = {
      ...current,
      importanceSinceReflection: current.importanceSinceReflection + delta,
      updatedAt: this.now(),
    };
    this.states.set(relKey(key), next);
    return next;
  }

  async resetImportance(key: RelationshipKey): Promise<void> {
    const current = await this.getRelationshipState(key);
    this.states.set(relKey(key), {
      ...current,
      importanceSinceReflection: 0,
      updatedAt: this.now(),
    });
  }

  async getSummary(sessionId: string): Promise<Summary | null> {
    return this.summaries.get(sessionId) ?? null;
  }

  async saveSummary(summary: Summary): Promise<void> {
    this.summaries.set(summary.sessionId, summary);
  }
}
