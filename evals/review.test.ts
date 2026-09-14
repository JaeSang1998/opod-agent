import { describe, expect, it } from "vitest";
import {
  aggregateNaturalnessBlindReviews,
  createNaturalnessBlindReviewBundle,
  type NaturalnessBlindReviewBundle,
  renderNaturalnessBlindReviewAgreement,
  renderNaturalnessBlindReviewPacket,
} from "./review.js";
import { NaturalnessBlindReviewSubmissionSchema } from "./schema.js";

const source = {
  schemaVersion: 1,
  mode: "diagnostic",
  trajectories: [
    trajectory("opening-alpha", "opening", "character-alpha", "Alpha", true, "가볍게 인사해요."),
    trajectory("opening-beta", "opening", "character-beta", "Beta", false, "무슨 일로 왔어요?"),
    trajectory("world-gamma", "world-state", "character-gamma", "Gamma", true, "차 마시는 중이에요."),
    trajectory("world-delta", "world-state", "character-delta", "Delta", false, "파일 정리하고 있어요."),
  ],
};

describe("naturalness blind review", () => {
  it("compares the same character without rewriting names or inventing an automatic verdict", () => {
    const fixed = {
      schemaVersion: 1, mode: "diagnostic",
      trajectories: ["only-left", "only-right"].map((runId) => ({
        runId, scenarioId: "same-prefix", passed: false, judgment: { passed: null },
        character: { id: "character-alpha", name: "Alpha", personaSummary: "Alpha is a calm person." },
        transcript: [
          { turn: 1, user: "내일 면접이야", assistant: "응원할게요" },
          { turn: 2, user: "잘 끝났어", assistant: runId === "only-left" ? "Alpha도 기뻐요." : "잘됐네요. Alpha도 응원했어요." },
        ],
      })),
    };
    const before = structuredClone(fixed);
    const bundle = createNaturalnessBlindReviewBundle(fixed, "f".repeat(64), 5, { sameCharacter: true });
    expect(fixed).toEqual(before);
    expect(bundle.packets[0].pairs).toHaveLength(1);
    expect(bundle.packets[0].items.map((i) => i.conversation.at(-1)?.assistant).sort())
      .toEqual(fixed.trajectories.map((t) => t.transcript.at(-1)?.assistant).sort());
    expect(bundle.key.packets[0]!.items.every((i) => i.automaticVerdict === "not-judged")).toBe(true);
    const rendered = renderNaturalnessBlindReviewPacket(bundle.packets[0], { singleReviewer: true });
    expect(rendered).toContain("사용자 1인");
    expect(rendered).toContain("both_bad");
    expect(rendered).not.toContain("only-left");
    const submissions = [0, 1].map((i) => completeSubmission(bundle, i, { "only-left": "pass", "only-right": "pass" }));
    const summary = aggregateNaturalnessBlindReviews(bundle.key, submissions);
    expect(summary.judgeHumanAgreement.every((a) => a.comparable === 0 && a.rate === null)).toBe(true);
    const rejected = structuredClone(fixed);
    rejected.trajectories[1]!.transcript[0]!.assistant = "A different past reply";
    expect(() => createNaturalnessBlindReviewBundle(rejected, "f".repeat(64), 5, { sameCharacter: true })).toThrow("identical fixed prefixes");
  });

  it("creates two balanced packets without leaking identity, provenance, or automatic verdicts", () => {
    const bundle = createNaturalnessBlindReviewBundle(source, "a".repeat(64), 20260902);

    expect(bundle.packets).toHaveLength(2);
    expect(bundle.submissionTemplates).toHaveLength(2);
    expect(bundle.submissionTemplates.map((submission) => submission.reviewerAlias)).toEqual([
      "replace-with-private-alias",
      "replace-with-private-alias",
    ]);
    for (const [index, packet] of bundle.packets.entries()) {
      expect(packet.items.every((item) => item.personaBrief.length > 0)).toBe(true);
      const rendered = `${JSON.stringify(packet)}\n${renderNaturalnessBlindReviewPacket(packet)}`;
      for (const forbidden of [
        "Alpha",
        "Beta",
        "Gamma",
        "Delta",
        "character-alpha",
        "opening-alpha",
        "automaticVerdict",
        '"passed"',
        '"score"',
        '"model"',
        "scripted",
        "simulated",
      ]) {
        expect(rendered).not.toContain(forbidden);
      }
      expect(
        NaturalnessBlindReviewSubmissionSchema.safeParse(
          bundle.submissionTemplates[index],
        ).success,
      ).toBe(true);
    }

    const [firstKey, secondKey] = bundle.key.packets;
    if (!firstKey || !secondKey) throw new Error("review packet keys missing");
    expect(secondKey.items.map((item) => item.transcriptId)).toEqual(
      [...firstKey.items.map((item) => item.transcriptId)].reverse(),
    );
    for (const firstPair of firstKey.pairs) {
      const secondPair = secondKey.pairs.find((pair) => pair.pairKey === firstPair.pairKey);
      expect(secondPair).toMatchObject({
        leftTranscriptId: firstPair.rightTranscriptId,
        rightTranscriptId: firstPair.leftTranscriptId,
      });
    }

    const divergent = structuredClone(source);
    divergent.trajectories[0]!.passed = false;
    divergent.trajectories[0]!.judgment.passed = true;
    const divergentBundle = createNaturalnessBlindReviewBundle(
      divergent,
      "d".repeat(64),
      20260902,
    );
    expect(
      divergentBundle.key.packets[0]?.items.find(
        (item) => item.transcriptId === "opening-alpha",
      )?.automaticVerdict,
    ).toBe("pass");

    const leaked = structuredClone(source);
    leaked.trajectories[0]!.transcript[0]!.assistant = "Beta가 답할게요.";
    expect(() =>
      createNaturalnessBlindReviewBundle(leaked, "a".repeat(64), 20260902),
    ).toThrow("identity literal");
  });

  it("normalizes opposite pair orientation and reports reviewer and judge disagreement", () => {
    const bundle = createNaturalnessBlindReviewBundle(source, "b".repeat(64), 20260902);
    const reviewerA = completeSubmission(bundle, 0, {
      "opening-alpha": "fail",
      "opening-beta": "fail",
      "world-gamma": "pass",
      "world-delta": "pass",
    });
    const reviewerB = completeSubmission(bundle, 1, {
      "opening-alpha": "fail",
      "opening-beta": "pass",
      "world-gamma": "pass",
      "world-delta": "pass",
    });

    const report = aggregateNaturalnessBlindReviews(bundle.key, [reviewerA, reviewerB]);

    expect(report.status).toBe("needs-adjudication");
    expect(report.trajectoryAgreement).toMatchObject({
      comparable: 4,
      agreements: 3,
      rate: 0.75,
    });
    expect(report.trajectoryDisagreements).toEqual([
      expect.objectContaining({ transcriptId: "opening-beta" }),
    ]);
    expect(report.pairwiseAgreement).toMatchObject({
      comparable: 2,
      agreements: 2,
      rate: 1,
    });
    expect(report.judgeHumanAgreement).toEqual([
      expect.objectContaining({
        reviewerAlias: "reviewer-a",
        comparable: 4,
        agreements: 2,
        rate: 0.5,
        falsePassTranscriptIds: ["opening-alpha"],
        falseFailTranscriptIds: ["world-delta"],
      }),
      expect.objectContaining({
        reviewerAlias: "reviewer-b",
        comparable: 4,
        agreements: 1,
        rate: 0.25,
        falsePassTranscriptIds: ["opening-alpha"],
        falseFailTranscriptIds: ["opening-beta", "world-delta"],
      }),
    ]);
    expect(report.adjudicated).toBe(false);
  });

  it("rejects drafts and two submissions attributed to the same reviewer", () => {
    const bundle = createNaturalnessBlindReviewBundle(source, "c".repeat(64), 20260902);
    const reviewerA = completeSubmission(bundle, 0, allFailVerdicts());
    const reviewerB = completeSubmission(bundle, 1, allFailVerdicts());

    expect(() =>
      aggregateNaturalnessBlindReviews(bundle.key, [
        bundle.submissionTemplates[0]!,
        reviewerB,
      ]),
    ).toThrow("complete");
    expect(() =>
      aggregateNaturalnessBlindReviews(bundle.key, [
        reviewerA,
        { ...reviewerB, reviewerAlias: reviewerA.reviewerAlias },
      ]),
    ).toThrow("distinct reviewers");

    const corruptedKey = structuredClone(bundle.key);
    const corruptedItem = corruptedKey.packets[1]?.items[0];
    if (!corruptedItem) throw new Error("key item missing");
    corruptedItem.automaticVerdict = corruptedItem.automaticVerdict === "pass" ? "fail" : "pass";
    expect(() =>
      aggregateNaturalnessBlindReviews(corruptedKey, [reviewerA, reviewerB]),
    ).toThrow("consistent automatic verdicts");

    const corruptedPairKey = structuredClone(bundle.key);
    const corruptedPair = corruptedPairKey.packets[1]?.pairs[0];
    const replacement = corruptedPairKey.packets[1]?.items.find(
      (item) =>
        item.transcriptId !== corruptedPair?.leftTranscriptId &&
        item.transcriptId !== corruptedPair?.rightTranscriptId,
    );
    if (!corruptedPair || !replacement) throw new Error("key pair fixture missing");
    corruptedPair.rightTranscriptId = replacement.transcriptId;
    expect(() =>
      aggregateNaturalnessBlindReviews(corruptedPairKey, [reviewerA, reviewerB]),
    ).toThrow("consistent pair membership");
  });

  it("keeps unanimous reviews unadjudicated and renders zero-comparable abstentions as N/A", () => {
    const bundle = createNaturalnessBlindReviewBundle(source, "e".repeat(64), 20260902);
    const reviewerA = completeSubmission(bundle, 0, allFailVerdicts());
    const reviewerB = completeSubmission(bundle, 1, allFailVerdicts());
    const unanimous = aggregateNaturalnessBlindReviews(bundle.key, [reviewerA, reviewerB]);

    expect(unanimous.status).toBe("reviewers-agree");
    expect(unanimous.trajectoryAgreement.rate).toBe(1);
    expect(unanimous.adjudicated).toBe(false);
    expect(renderNaturalnessBlindReviewAgreement(unanimous)).toContain(
      "Adjudicated: **no**",
    );

    const abstain = (submission: typeof reviewerA) => ({
      ...submission,
      trajectoryReviews: submission.trajectoryReviews.map((review) => ({
        ...review,
        verdict: "abstain" as const,
        tags: [],
        evidenceTurns: [],
        note: "판단할 수 없음",
      })),
      pairwiseReviews: submission.pairwiseReviews.map((review) => ({
        ...review,
        winner: "abstain" as const,
        note: "판단할 수 없음",
      })),
    });
    const abstentions = aggregateNaturalnessBlindReviews(bundle.key, [
      abstain(reviewerA),
      abstain(reviewerB),
    ]);

    expect(abstentions.status).toBe("needs-adjudication");
    expect(abstentions.trajectoryAgreement).toMatchObject({
      comparable: 0,
      rate: null,
      abstentions: 4,
    });
    expect(abstentions.pairwiseAgreement).toMatchObject({
      comparable: 0,
      rate: null,
      abstentions: 2,
    });
    expect(renderNaturalnessBlindReviewAgreement(abstentions)).toContain(
      "Trajectory agreement: 0/0 (N/A)",
    );
  });
});

function trajectory(
  runId: string,
  scenarioId: string,
  characterId: string,
  characterName: string,
  passed: boolean,
  assistant: string,
) {
  return {
    runId,
    scenarioId,
    passed,
    judgment: { passed },
    character: {
      id: characterId,
      name: characterName,
      personaSummary: "차분하지만 상황에 맞게 짧고 편하게 반응하는 사람.",
    },
    transcript: [
      { turn: 1, user: "안녕", userSource: "scripted", assistant },
      { turn: 2, user: "그냥 얘기하자", userSource: "simulated", assistant: "그래요." },
    ],
  };
}

function allFailVerdicts(): Record<string, "fail"> {
  return Object.fromEntries(
    source.trajectories.map((item) => [item.runId, "fail" as const]),
  );
}

function completeSubmission(
  bundle: NaturalnessBlindReviewBundle,
  packetIndex: number,
  verdicts: Record<string, "pass" | "fail">,
) {
  const template = bundle.submissionTemplates[packetIndex];
  const key = bundle.key.packets[packetIndex];
  if (!template || !key) throw new Error("review packet missing");

  return {
    ...template,
    reviewerAlias: packetIndex === 0 ? "reviewer-a" : "reviewer-b",
    status: "complete" as const,
    completedAt: "2026-09-02T12:00:00.000Z",
    trajectoryReviews: template.trajectoryReviews.map((review) => {
      const mapping = key.items.find((item) => item.itemId === review.itemId);
      if (!mapping) throw new Error("item mapping missing");
      const verdict = verdicts[mapping.transcriptId];
      if (!verdict) throw new Error("verdict missing");
      return {
        ...review,
        verdict,
        tags: verdict === "fail" ? ["local_relevance" as const] : [],
        evidenceTurns: verdict === "fail" ? [1] : [],
        note: verdict === "fail" ? "직전 발화와 연결되지 않는다." : "자연스럽게 이어진다.",
      };
    }),
    pairwiseReviews: template.pairwiseReviews.map((review) => {
      const mapping = key.pairs.find((pair) => pair.pairId === review.pairId);
      if (!mapping) throw new Error("pair mapping missing");
      const canonicalWinner = [
        mapping.leftTranscriptId,
        mapping.rightTranscriptId,
      ].sort()[0];
      return {
        ...review,
        winner: canonicalWinner === mapping.leftTranscriptId ? "left" as const : "right" as const,
        note: "왼쪽과 오른쪽을 전체 흐름으로 비교했다.",
      };
    }),
  };
}
