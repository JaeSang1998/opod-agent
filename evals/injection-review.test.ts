import { describe, expect, it } from "vitest";
import { aggregateInjectionReview } from "./review.js";

const key = { packetId: "packet-95ff0144b194", runId: "audit", items: [
  { id: "answer-01", requestSha256: "a".repeat(64) },
  { id: "answer-02", requestSha256: "b".repeat(64) },
  { id: "answer-03", requestSha256: "c".repeat(64) },
] };
const submission = { schemaVersion: 1, kind: "persona-memory-injection-review-submission", packetId: key.packetId, runId: key.runId, reviewerAlias: "user", status: "draft", answerReviews: [
  { answerId: "answer-01", requestSha256: "a".repeat(64), verdict: "pass", note: "" },
  { answerId: "answer-02", requestSha256: "b".repeat(64), verdict: "not-reviewed", note: "문장이 어색함", contextVerdict: "problem" },
] };

describe("single answer review import", () => {
  it("preserves explicit verdicts and comments without deriving unreviewed or whole-conversation PASS", () => {
    const result = aggregateInjectionReview(key, submission);
    expect(result.counts).toEqual({ pass: 1, fail: 0, abstain: 0, "not-reviewed": 2 });
    expect(result.contextProblems).toEqual(["answer-02"]);
    expect(result.answerReviews[1]?.note).toBe("문장이 어색함");
    expect(result.answerReviews[1]?.verdict).toBe("not-reviewed");
    expect(result.answerReviews[2]?.verdict).toBe("not-reviewed");
    expect(result.trajectoryVerdict).toBe("not-reviewed");
  });
  it("rejects stale hashes, duplicate answers, unknown IDs and wrong packets", () => {
    for (const change of [
      { packetId: "packet-000000000000" },
      { answerReviews: [submission.answerReviews[0], submission.answerReviews[0]] },
      { answerReviews: [{ ...submission.answerReviews[0], requestSha256: "b".repeat(64) }] },
      { answerReviews: [{ ...submission.answerReviews[0], answerId: "answer-99" }] },
    ]) expect(() => aggregateInjectionReview(key, { ...submission, ...change })).toThrow();
  });
});
