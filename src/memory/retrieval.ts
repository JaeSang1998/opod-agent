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
  if (items.length === 0) return [];

  const relevance = items.map((it) => cosineSimilarity(queryEmbedding, it.embedding ?? []));
  const importance = items.map((it) => it.importance);

  // Recency: rank by lastAccessedAt (newest first), decay over ordinal rank.
  const order = items
    .map((it, i) => ({ i, t: it.lastAccessedAt }))
    .sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
  const recency = new Array<number>(items.length).fill(0);
  order.forEach((entry, rank) => {
    recency[entry.i] = Math.pow(opts.recencyDecay, rank);
  });

  const nRel = normalize(relevance);
  const nImp = normalize(importance);
  const nRec = normalize(recency);
  const { weights: w } = opts;

  return items
    .map((it, i) => ({
      it,
      score:
        w.recency * (nRec[i] ?? 0) +
        w.importance * (nImp[i] ?? 0) +
        w.relevance * (nRel[i] ?? 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK)
    .map((x) => x.it);
}
