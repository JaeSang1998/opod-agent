import { cosineSimilarity } from "./vector.js";
import { createHash } from "node:crypto";
import type { MemoryKind, MemoryMetadata } from "./types.js";

/**
 * Generative-Agents retrieval scoring (docs/adr/0005): combine recency,
 * importance, and relevance — each min-max normalized to [0,1] — into a weighted
 * sum, then take the top-K. A Postgres adapter would push this into pgvector +
 * SQL; this pure form keeps the ranking logic testable and shared.
 */

export interface RetrievalWeights {
  recency: number;
  importance: number;
  relevance: number;
}

export interface Scorable {
  embedding?: number[];
  importance: number;
  /** ISO timestamp; used for the recency signal (ranked, then decayed). */
  lastAccessedAt: string;
}

export interface RankOptions {
  weights: RetrievalWeights;
  /** Exponential decay applied over recency rank (0.99 ≈ the paper's demo). */
  recencyDecay: number;
  topK: number;
  /** Optional absolute cosine gate, applied before filling top-K. */
  minRelevance?: number;
}

export interface ScoredRetrievalCandidate<T> {
  item: T;
  /** One-based position after applying the current weighted ranking. */
  rank: number;
  score: number;
  /** Cosine similarity before min-max normalization. */
  rawRelevance: number;
  decision: "selected" | "excluded";
  reason: "selected_top_k" | "outside_top_k" | "below_relevance_threshold" | "duplicate_content";
}

export function lexicalQueryTerms(query: string): string[] {
  return [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(term => term.length > 1).slice(-24);
}

export function validQueryEmbedding(vector: number[]): boolean {
  return vector.length === 1024 && vector.every(value => Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38)
    && vector.some(value => value !== 0);
}

export function memoryContentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type IndexedMemory = MemoryMetadata & { content: string; embedding?: number[]; kind?: MemoryKind };

export function compatibleMemoryEmbedding(memory: IndexedMemory, model?: string): boolean {
  return Boolean(model && memory.embeddingModel === model
    && memory.embeddingSourceSha256 === memoryContentSha256(memory.content)
    && validQueryEmbedding(memory.embedding ?? []));
}

/** Keep legacy writes compatible; metadata-bearing writes must name the exact embedded source. */
export function validateMemoryEmbedding(memory: IndexedMemory): void {
  if (memory.embeddingModel === undefined && memory.embeddingSourceSha256 === undefined) return;
  if (!compatibleMemoryEmbedding(memory, memory.embeddingModel)) {
    throw new Error("Memory embedding metadata does not match its content, model or dimension");
  }
}

export function duplicateMemory(a: IndexedMemory, b: IndexedMemory): boolean {
  if (a.kind !== b.kind || a.memoryType !== b.memoryType) return false;
  if (a.content.normalize("NFKC").trim() === b.content.normalize("NFKC").trim()) return true;
  if (a.embeddingModel !== b.embeddingModel) return false;
  if (a.embeddingModel && (!compatibleMemoryEmbedding(a, a.embeddingModel) || !compatibleMemoryEmbedding(b, a.embeddingModel))) return false;
  return cosineSimilarity(a.embedding ?? [], b.embedding ?? []) > 0.95;
}

/** Reciprocal-rank fusion: only actual lexical/semantic hits compete; recency never fills empty slots. */
export function scoreHybridRetrievalCandidates<T extends Scorable & IndexedMemory>(
  items: T[], queryEmbedding: number[], opts: RankOptions & { queryText: string; embeddingModel?: string },
): ScoredRetrievalCandidate<T>[] {
  const terms = lexicalQueryTerms(opts.queryText);
  const values = items.map((item, index) => {
    const text = item.content.normalize("NFKC").toLowerCase();
    const lexical = terms.filter(term => text.includes(term)).length;
    const relevance = validQueryEmbedding(queryEmbedding) && compatibleMemoryEmbedding(item, opts.embeddingModel)
      ? cosineSimilarity(queryEmbedding, item.embedding ?? []) : 0;
    return { item, index, lexical, relevance, score: 0 };
  });
  const semantic = values.filter(v => v.relevance > Math.max(0, opts.minRelevance ?? 0.2))
    .sort((a, b) => b.relevance - a.relevance || a.index - b.index);
  const lexical = values.filter(v => v.lexical > 0).sort((a, b) => b.lexical - a.lexical || a.index - b.index);
  for (const stream of [semantic, lexical]) stream.forEach((v, i) => { v.score += 1 / (61 + i); });
  const seen = new Set<string>();
  let selected = 0;
  return values.sort((a, b) => b.score - a.score || a.index - b.index).map((v, i) => {
    const content = JSON.stringify([v.item.kind ?? null, v.item.memoryType ?? null, v.item.content.normalize("NFKC").trim()]);
    const duplicate = seen.has(content);
    const eligible = v.score > 0 && !duplicate;
    const take = eligible && selected < Math.max(0, Math.min(512, Math.floor(opts.topK)));
    if (take) { selected++; seen.add(content); }
    return { item: v.item, rank: i + 1, score: v.score, rawRelevance: v.relevance,
      decision: take ? "selected" : "excluded",
      reason: duplicate ? "duplicate_content" : !eligible ? "below_relevance_threshold" : take ? "selected_top_k" : "outside_top_k" };
  });
}

/** Min-max normalize to [0,1]; a zero range maps everything to 0.5 (as GA does). */
function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return values.map(() => 0.5);
  return values.map((v) => (v - min) / range);
}

export function rankByRetrievalScore<T extends Scorable>(
  items: T[],
  queryEmbedding: number[],
  opts: RankOptions,
): T[] {
  return scoreRetrievalCandidates(items, queryEmbedding, opts)
    .filter((candidate) => candidate.decision === "selected")
    .map((candidate) => candidate.item);
}

/**
 * The same ranking used for retrieval, retaining content-free evidence for
 * candidates that fell outside top-K. Keeping this at the ranking owner avoids
 * a debug-only scoring implementation drifting from the actual selection.
 */
export function scoreRetrievalCandidates<T extends Scorable>(
  items: T[],
  queryEmbedding: number[],
  opts: RankOptions,
): ScoredRetrievalCandidate<T>[] {
  if (items.length === 0) return [];

  const relevance = items.map((it) => cosineSimilarity(queryEmbedding, it.embedding ?? []));
  const importance = items.map((it) => it.importance);

  // Recency: rank by lastAccessedAt (newest first), decay over ordinal rank.
  const order = items
    .map((it, i) => ({ i, t: it.lastAccessedAt }))
    .sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
  const recency = new Array<number>(items.length).fill(0);
  order.forEach((entry, rank) => {
    recency[entry.i] = opts.recencyDecay ** rank;
  });

  const nRel = normalize(relevance);
  const nImp = normalize(importance);
  const nRec = normalize(recency);
  const { weights: w } = opts;

  let selectedCount = 0;
  return items
    .map((it, i) => ({
      it,
      originalIndex: i,
      rawRelevance: relevance[i] ?? 0,
      score:
        w.recency * (nRec[i] ?? 0) +
        w.importance * (nImp[i] ?? 0) +
        w.relevance * (nRel[i] ?? 0),
    }))
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
    .map(({ it, score, rawRelevance }, index) => {
      const eligible = opts.minRelevance === undefined || rawRelevance > opts.minRelevance;
      const selected = eligible && selectedCount < opts.topK;
      if (selected) selectedCount++;
      return {
        item: it,
        rank: index + 1,
        score,
        rawRelevance,
        decision: selected ? "selected" : "excluded",
        reason: !eligible ? "below_relevance_threshold" : selected ? "selected_top_k" : "outside_top_k",
      };
    });
}
