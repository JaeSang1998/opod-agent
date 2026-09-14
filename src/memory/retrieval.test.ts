import { describe, it, expect } from "vitest";
import {
  rankByRetrievalScore,
  scoreRetrievalCandidates,
  scoreHybridRetrievalCandidates,
  memoryContentSha256,
  type Scorable,
} from "./retrieval.js";

const weights = { recency: 1, importance: 1, relevance: 1 };

function mem(id: string, embedding: number[], importance: number, lastAccessedAt: string) {
  return { id, embedding, importance, lastAccessedAt } as Scorable & { id: string };
}

describe("rankByRetrievalScore", () => {
  it("does not fill slots with irrelevant memories even when importance and recency are high", () => {
    const candidates = scoreRetrievalCandidates([
      mem("unrelated", [0, 1], 10, "2026-01-03T00:00:00Z"),
      mem("relevant", [1, 0], 1, "2026-01-01T00:00:00Z"),
    ], [1, 0], { weights, recencyDecay: 0.99, topK: 1, minRelevance: 0 });
    expect(candidates.filter(c => c.decision === "selected").map(c => c.item.id)).toEqual(["relevant"]);
    expect(candidates.find(c => c.item.id === "unrelated")?.reason).toBe("below_relevance_threshold");
  });

  it("returns no memories when all are below the absolute gate or have no vector", () => {
    expect(rankByRetrievalScore([
      mem("orthogonal", [0, 1], 10, "2026-01-03"),
      mem("negative", [-1, 0], 10, "2026-01-03"),
      mem("missing", [], 10, "2026-01-03"),
    ], [1, 0], { weights, recencyDecay: 0.99, topK: 6, minRelevance: 0 })).toEqual([]);
  });

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

  it("keeps content-free provenance for selected and excluded candidates", () => {
    const candidates = scoreRetrievalCandidates(
      [
        mem("relevant", [1, 0, 0], 8, "2026-01-03T00:00:00Z"),
        mem("recent", [0, 1, 0], 6, "2026-01-02T00:00:00Z"),
        mem("outside", [0, 0, 1], 1, "2026-01-01T00:00:00Z"),
      ],
      [1, 0, 0],
      { weights, recencyDecay: 0.99, topK: 2 },
    );

    expect(candidates.map(({ item, rank, decision, reason }) => ({
      id: item.id,
      rank,
      decision,
      reason,
    }))).toEqual([
      { id: "relevant", rank: 1, decision: "selected", reason: "selected_top_k" },
      { id: "recent", rank: 2, decision: "selected", reason: "selected_top_k" },
      { id: "outside", rank: 3, decision: "excluded", reason: "outside_top_k" },
    ]);
    expect(candidates[0]?.rawRelevance).toBe(1);
    expect(candidates.every((candidate) => Number.isFinite(candidate.score))).toBe(true);
    expect(rankByRetrievalScore(
      candidates.map((candidate) => candidate.item),
      [1, 0, 0],
      { weights, recencyDecay: 0.99, topK: 2 },
    ).map((item) => item.id)).toEqual(["relevant", "recent"]);
  });
});

describe("hybrid retrieval compatibility", () => {
  const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
  const make = (content: string) => ({
    content, embedding: vector, embeddingModel: "test-model",
    embeddingSourceSha256: memoryContentSha256(content), importance: 5, lastAccessedAt: "2026-01-01",
  });
  const opts = { weights, recencyDecay: 0.99, topK: 8, queryText: "제주", embeddingModel: "test-model" };

  it("excludes unknown, stale, different-model, invalid-dimension and nonfinite vectors", () => {
    const candidates = [
      make("valid semantic"),
      { ...make("stale"), embeddingSourceSha256: "0".repeat(64) },
      { ...make("different"), embeddingModel: "other-model" },
      { ...make("unknown"), embeddingModel: undefined },
      { ...make("dimension"), embedding: [1, 0] },
      { ...make("nonfinite"), embedding: vector.map((n, i) => i === 0 ? Infinity : n) },
      { ...make("제주 여행"), embeddingModel: undefined },
    ];
    const selected = scoreHybridRetrievalCandidates(candidates, vector, opts).filter(c => c.decision === "selected");
    expect(selected.map(c => c.item.content).sort()).toEqual(["valid semantic", "제주 여행"].sort());
    expect(scoreHybridRetrievalCandidates(candidates, [], { ...opts, queryText: "없음" }).filter(c => c.decision === "selected")).toEqual([]);
  });

  it("does not inject duplicate content after lexical and semantic fusion", () => {
    const result = scoreHybridRetrievalCandidates([make("제주 여행"), make("제주 여행"), make("별개 기록")], vector, opts);
    expect(result.filter(c => c.decision === "selected")).toHaveLength(2);
    expect(result.filter(c => c.reason === "duplicate_content")).toHaveLength(1);
  });
});
