import { cosineSimilarity } from "./vector.js";

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
}

export interface ScoredRetrievalCandidate<T> {
  item: T;
  /** One-based position after applying the current weighted ranking. */
  rank: number;
  score: number;
  /** Cosine similarity before min-max normalization. */
  rawRelevance: number;
  decision: "selected" | "excluded";
  reason: "selected_top_k" | "outside_top_k";
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
      const selected = index < opts.topK;
      return {
        item: it,
        rank: index + 1,
        score,
        rawRelevance,
        decision: selected ? "selected" : "excluded",
        reason: selected ? "selected_top_k" : "outside_top_k",
      };
    });
}
