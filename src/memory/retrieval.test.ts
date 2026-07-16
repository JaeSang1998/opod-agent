import { describe, it, expect } from "vitest";
import { rankByRetrievalScore, type Scorable } from "./retrieval.js";

const weights = { recency: 1, importance: 1, relevance: 1 };

function mem(id: string, embedding: number[], importance: number, lastAccessedAt: string) {
  return { id, embedding, importance, lastAccessedAt } as Scorable & { id: string };
}

describe("rankByRetrievalScore", () => {
  it("ranks an on-topic, important, recent memory above an off-topic old one", () => {
    const query = [1, 0, 0];
    const items = [
      mem("relevant", [1, 0, 0], 8, "2026-01-02T00:00:00Z"),
      mem("irrelevant", [0, 1, 0], 2, "2026-01-01T00:00:00Z"),
    ];
    const ranked = rankByRetrievalScore(items, query, { weights, recencyDecay: 0.99, topK: 2 });
    expect(ranked[0]?.id).toBe("relevant");
  });

  it("honors importance weighting when relevance ties", () => {
    const query = [1, 0, 0];
    const items = [
      mem("low", [1, 0, 0], 1, "2026-01-01T00:00:00Z"),
      mem("high", [1, 0, 0], 10, "2026-01-01T00:00:00Z"),
    ];
    const ranked = rankByRetrievalScore(items, query, {
      weights: { recency: 0, importance: 1, relevance: 0 },
      recencyDecay: 0.99,
      topK: 1,
    });
    expect(ranked[0]?.id).toBe("high");
  });

  it("respects topK", () => {
    const query = [1, 0, 0];
    const items = [
      mem("a", [1, 0, 0], 5, "2026-01-03T00:00:00Z"),
      mem("b", [1, 0, 0], 5, "2026-01-02T00:00:00Z"),
      mem("c", [1, 0, 0], 5, "2026-01-01T00:00:00Z"),
    ];
    expect(rankByRetrievalScore(items, query, { weights, recencyDecay: 0.99, topK: 2 })).toHaveLength(2);
  });

  it("returns empty for no candidates", () => {
    expect(rankByRetrievalScore([], [1, 0], { weights, recencyDecay: 0.99, topK: 5 })).toEqual([]);
  });
});
