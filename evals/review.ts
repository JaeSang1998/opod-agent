import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type NaturalnessBlindReviewKey,
  NaturalnessBlindReviewKeySchema,
  type NaturalnessBlindReviewPacket,
  NaturalnessBlindReviewPacketSchema,
  type NaturalnessBlindReviewSubmission,
  NaturalnessBlindReviewSubmissionSchema,
} from "./schema.js";

const ReviewSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("diagnostic"),
    trajectories: z.array(
      z.object({
        runId: z.string().min(1),
        scenarioId: z.string().min(1),
        passed: z.boolean(),
        judgment: z.object({ passed: z.boolean().nullable() }),
        character: z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          personaSummary: z.string().min(1),
        }),
        transcript: z.array(
          z.object({
            turn: z.number().int().positive(),
            user: z.string().min(1),
            assistant: z.string().min(1),
          }),
        ).min(1),
      }),
    ).min(2),
  })
  .superRefine((source, ctx) => {
    const runIds = source.trajectories.map((trajectory) => trajectory.runId);
    if (new Set(runIds).size !== runIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trajectories"],
        message: "review source run ids must be unique",
      });
    }
    for (const [index, trajectory] of source.trajectories.entries()) {
      const turns = trajectory.transcript.map((turn) => turn.turn);
      if (new Set(turns).size !== turns.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trajectories", index, "transcript"],
          message: "review source transcript turns must be unique",
        });
      }
    }
  });

type ReviewSource = z.infer<typeof ReviewSourceSchema>;
type ReviewSourceTrajectory = ReviewSource["trajectories"][number];

interface CanonicalPair {
  pairKey: string;
  firstTranscriptId: string;
  secondTranscriptId: string;
}

export interface NaturalnessBlindReviewBundle {
  packets: [NaturalnessBlindReviewPacket, NaturalnessBlindReviewPacket];
  submissionTemplates: [
    NaturalnessBlindReviewSubmission,
    NaturalnessBlindReviewSubmission,
  ];
  key: NaturalnessBlindReviewKey;
}

interface AgreementSummary {
  total: number;
  comparable: number;
  agreements: number;
  rate: number | null;
  abstentions: number;
}

interface TrajectoryDisagreement {
  transcriptId: string;
  reviews: Array<{ reviewerAlias: string; verdict: "pass" | "fail" }>;
}

interface PairwiseDisagreement {
  pairKey: string;
  reviews: Array<{
    reviewerAlias: string;
    winner: string;
  }>;
}

interface JudgeHumanAgreement {
  reviewerAlias: string;
  comparable: number;
  agreements: number;
  rate: number | null;
  falsePassTranscriptIds: string[];
  falseFailTranscriptIds: string[];
}

export interface NaturalnessBlindReviewAgreementReport {
  schemaVersion: 1;
  kind: "naturalness-blind-review-agreement";
  status: "reviewers-agree" | "needs-adjudication";
  adjudicated: false;
  source: { suiteReportSha256: string; seed: number };
  reviewerAliases: string[];
  trajectoryAgreement: AgreementSummary;
  trajectoryDisagreements: TrajectoryDisagreement[];
  trajectoryAbstentionTranscriptIds: string[];
  pairwiseAgreement: AgreementSummary;
  pairwiseDisagreements: PairwiseDisagreement[];
  pairwiseAbstentionKeys: string[];
  judgeHumanAgreement: JudgeHumanAgreement[];
}

export function createNaturalnessBlindReviewBundle(
  rawSource: unknown,
  suiteReportSha256: string,
  seed: number,
  options: { sameCharacter?: boolean } = {},
): NaturalnessBlindReviewBundle {
  const source = ReviewSourceSchema.parse(rawSource);
  if (!/^[a-f0-9]{64}$/.test(suiteReportSha256)) {
    throw new Error("suiteReportSha256 must be a lowercase SHA-256 digest");
  }
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("review seed must be a non-negative safe integer");
  }

  if (!options.sameCharacter) assertIdentityIsAbsentFromTranscripts(source.trajectories);
  const canonicalPairs = createCanonicalPairs(source.trajectories, seed, options.sameCharacter);
  const baseOrder = hashSort(
    source.trajectories,
    (trajectory) => trajectory.runId,
    `${seed}:trajectory-order`,
  );
  const slots = ["reviewer-a", "reviewer-b"] as const;
  const packets: NaturalnessBlindReviewPacket[] = [];
  const submissionTemplates: NaturalnessBlindReviewSubmission[] = [];
  const packetKeys: NaturalnessBlindReviewKey["packets"] = [];

  for (const [slotIndex, reviewerSlot] of slots.entries()) {
    const orderedTrajectories = slotIndex === 0 ? baseOrder : [...baseOrder].reverse();
    const packetId = `packet-${digest(`${suiteReportSha256}:${seed}:${reviewerSlot}`).slice(0, 12)}`;
    const itemIdByTranscript = new Map<string, string>();
    const items = orderedTrajectories.map((trajectory, index) => {
      const itemId = numberedId("item", index);
      itemIdByTranscript.set(trajectory.runId, itemId);
      return {
        itemId,
        personaBrief: trajectory.character.personaSummary,
        conversation: trajectory.transcript.map((turn) => ({
          turn: turn.turn,
          user: turn.user,
          assistant: turn.assistant,
        })),
      };
    });

    const basePairOrder = hashSort(
      canonicalPairs,
      (pair) => pair.pairKey,
      `${seed}:pair-display-order`,
    );
    const orderedPairs = slotIndex === 0 ? basePairOrder : [...basePairOrder].reverse();
    const packetPairs = orderedPairs.map((pair, index) => {
      const firstOnLeft = digest(`${seed}:pair-orientation:${pair.pairKey}`).charAt(0) < "8";
      const swap = slotIndex === 0 ? !firstOnLeft : firstOnLeft;
      const leftTranscriptId = swap ? pair.secondTranscriptId : pair.firstTranscriptId;
      const rightTranscriptId = swap ? pair.firstTranscriptId : pair.secondTranscriptId;
      const leftItemId = itemIdByTranscript.get(leftTranscriptId);
      const rightItemId = itemIdByTranscript.get(rightTranscriptId);
      if (!leftItemId || !rightItemId) throw new Error("review pair item mapping is incomplete");
      return {
        pairId: numberedId("pair", index),
        leftItemId,
        rightItemId,
        pairKey: pair.pairKey,
        leftTranscriptId,
        rightTranscriptId,
      };
    });

    const packet = NaturalnessBlindReviewPacketSchema.parse({
      schemaVersion: 1,
      kind: "naturalness-blind-review-packet",
      packetId,
      items,
      pairs: packetPairs.map(({ pairKey: _pairKey, leftTranscriptId: _left, rightTranscriptId: _right, ...pair }) => pair),
    });
    const submission = NaturalnessBlindReviewSubmissionSchema.parse({
      schemaVersion: 1,
      kind: "naturalness-blind-review-submission",
      packetId,
      reviewerAlias: "replace-with-private-alias",
      status: "draft",
      trajectoryReviews: packet.items.map((item) => ({
        itemId: item.itemId,
        verdict: "not-reviewed",
        tags: [],
        evidenceTurns: [],
        note: "",
      })),
      pairwiseReviews: packet.pairs.map((pair) => ({
        pairId: pair.pairId,
        winner: "not-reviewed",
        note: "",
      })),
    });
    const keyItems = orderedTrajectories.map((trajectory, index) => ({
      itemId: numberedId("item", index),
      transcriptId: trajectory.runId,
      automaticVerdict: trajectory.judgment.passed === null ? "not-judged" as const : trajectory.judgment.passed ? "pass" as const : "fail" as const,
      validTurns: trajectory.transcript.map((turn) => turn.turn).sort((left, right) => left - right),
    }));

    packets.push(packet);
    submissionTemplates.push(submission);
    packetKeys.push({
      packetId,
      reviewerSlot,
      items: keyItems,
      pairs: packetPairs.map(({ leftItemId: _left, rightItemId: _right, ...pair }) => pair),
    });
  }

  const key = NaturalnessBlindReviewKeySchema.parse({
    schemaVersion: 1,
    kind: "naturalness-blind-review-key",
    source: { suiteReportSha256, seed },
    packets: packetKeys,
  });
  const firstPacket = packets[0];
  const secondPacket = packets[1];
  const firstSubmission = submissionTemplates[0];
  const secondSubmission = submissionTemplates[1];
  if (!firstPacket || !secondPacket || !firstSubmission || !secondSubmission) {
    throw new Error("exactly two blind review packets are required");
  }
  return {
    packets: [firstPacket, secondPacket],
    submissionTemplates: [firstSubmission, secondSubmission],
    key,
  };
}

export function aggregateNaturalnessBlindReviews(
  rawKey: unknown,
  rawSubmissions: unknown[],
): NaturalnessBlindReviewAgreementReport {
  const key = NaturalnessBlindReviewKeySchema.parse(rawKey);
  if (rawSubmissions.length !== key.packets.length) {
    throw new Error(`expected ${key.packets.length} blind review submissions`);
  }
  const submissions = rawSubmissions.map((submission) =>
    NaturalnessBlindReviewSubmissionSchema.parse(submission)
  );
  if (submissions.some((submission) => submission.status !== "complete")) {
    throw new Error("blind review submissions must be complete before aggregation");
  }
  if (new Set(submissions.map((submission) => submission.packetId)).size !== submissions.length) {
    throw new Error("blind review submissions must target distinct packets");
  }
  if (
    new Set(submissions.map((submission) => submission.reviewerAlias)).size !==
    submissions.length
  ) {
    throw new Error("blind review submissions must come from distinct reviewers");
  }

  const normalized = key.packets.map((packetKey) => {
    const submission = submissions.find((candidate) => candidate.packetId === packetKey.packetId);
    if (!submission) throw new Error(`missing submission for packet ${packetKey.packetId}`);
    validateSubmissionCoverage(packetKey, submission);
    return { packetKey, submission };
  });
  const firstPacket = normalized[0];
  if (!firstPacket) throw new Error("blind review key has no packet mappings");
  const transcriptIds = firstPacket.packetKey.items
    .map((item) => item.transcriptId)
    .sort();
  const trajectoryDisagreements: TrajectoryDisagreement[] = [];
  const trajectoryAbstentionTranscriptIds: string[] = [];
  let trajectoryComparable = 0;
  let trajectoryAgreements = 0;

  for (const transcriptId of transcriptIds) {
    const reviews = normalized.map(({ packetKey, submission }) => {
      const item = packetKey.items.find((candidate) => candidate.transcriptId === transcriptId);
      if (!item) throw new Error(`missing item mapping for ${transcriptId}`);
      const review = submission.trajectoryReviews.find(
        (candidate) => candidate.itemId === item.itemId,
      );
      if (!review || review.verdict === "not-reviewed") {
        throw new Error(`missing complete trajectory review for ${transcriptId}`);
      }
      return { reviewerAlias: submission.reviewerAlias, verdict: review.verdict };
    });
    if (reviews.some((review) => review.verdict === "abstain")) {
      trajectoryAbstentionTranscriptIds.push(transcriptId);
      continue;
    }
    const comparableReviews = reviews as Array<{
      reviewerAlias: string;
      verdict: "pass" | "fail";
    }>;
    trajectoryComparable += 1;
    if (new Set(comparableReviews.map((review) => review.verdict)).size === 1) {
      trajectoryAgreements += 1;
    } else {
      trajectoryDisagreements.push({ transcriptId, reviews: comparableReviews });
    }
  }

  const pairKeys = firstPacket.packetKey.pairs.map((pair) => pair.pairKey).sort();
  const pairwiseDisagreements: PairwiseDisagreement[] = [];
  const pairwiseAbstentionKeys: string[] = [];
  let pairwiseComparable = 0;
  let pairwiseAgreements = 0;
  for (const pairKey of pairKeys) {
    const reviews = normalized.map(({ packetKey, submission }) => {
      const mapping = packetKey.pairs.find((candidate) => candidate.pairKey === pairKey);
      if (!mapping) throw new Error(`missing pair mapping for ${pairKey}`);
      const review = submission.pairwiseReviews.find(
        (candidate) => candidate.pairId === mapping.pairId,
      );
      if (!review || review.winner === "not-reviewed") {
        throw new Error(`missing complete pairwise review for ${pairKey}`);
      }
      return {
        reviewerAlias: submission.reviewerAlias,
        winner: canonicalPairwiseWinner(mapping, review.winner),
      };
    });
    if (reviews.some((review) => review.winner === "abstain")) {
      pairwiseAbstentionKeys.push(pairKey);
      continue;
    }
    pairwiseComparable += 1;
    if (new Set(reviews.map((review) => review.winner)).size === 1) {
      pairwiseAgreements += 1;
    } else {
      pairwiseDisagreements.push({ pairKey, reviews });
    }
  }

  const automaticByTranscript = new Map(
    firstPacket.packetKey.items.map((item) => [item.transcriptId, item.automaticVerdict]),
  );
  const judgeHumanAgreement = normalized.map(({ packetKey, submission }) => {
    let comparable = 0;
    let agreements = 0;
    const falsePassTranscriptIds: string[] = [];
    const falseFailTranscriptIds: string[] = [];
    for (const transcriptId of transcriptIds) {
      const item = packetKey.items.find((candidate) => candidate.transcriptId === transcriptId);
      const review = item
        ? submission.trajectoryReviews.find((candidate) => candidate.itemId === item.itemId)
        : undefined;
      if (!review || review.verdict === "abstain" || review.verdict === "not-reviewed") continue;
      const automatic = automaticByTranscript.get(transcriptId);
      if (!automatic) throw new Error(`missing automatic verdict for ${transcriptId}`);
      if (automatic === "not-judged") continue;
      comparable += 1;
      if (automatic === review.verdict) agreements += 1;
      if (automatic === "pass" && review.verdict === "fail") {
        falsePassTranscriptIds.push(transcriptId);
      }
      if (automatic === "fail" && review.verdict === "pass") {
        falseFailTranscriptIds.push(transcriptId);
      }
    }
    return {
      reviewerAlias: submission.reviewerAlias,
      comparable,
      agreements,
      rate: agreementRate(agreements, comparable),
      falsePassTranscriptIds,
      falseFailTranscriptIds,
    };
  });

  const needsAdjudication =
    trajectoryDisagreements.length > 0 ||
    trajectoryAbstentionTranscriptIds.length > 0 ||
    pairwiseDisagreements.length > 0 ||
    pairwiseAbstentionKeys.length > 0;
  return {
    schemaVersion: 1,
    kind: "naturalness-blind-review-agreement",
    status: needsAdjudication ? "needs-adjudication" : "reviewers-agree",
    adjudicated: false,
    source: key.source,
    reviewerAliases: normalized.map(({ submission }) => submission.reviewerAlias),
    trajectoryAgreement: {
      total: transcriptIds.length,
      comparable: trajectoryComparable,
      agreements: trajectoryAgreements,
      rate: agreementRate(trajectoryAgreements, trajectoryComparable),
      abstentions: trajectoryAbstentionTranscriptIds.length,
    },
    trajectoryDisagreements,
    trajectoryAbstentionTranscriptIds,
    pairwiseAgreement: {
      total: pairKeys.length,
      comparable: pairwiseComparable,
      agreements: pairwiseAgreements,
      rate: agreementRate(pairwiseAgreements, pairwiseComparable),
      abstentions: pairwiseAbstentionKeys.length,
    },
    pairwiseDisagreements,
    pairwiseAbstentionKeys,
    judgeHumanAgreement,
  };
}

export function renderNaturalnessBlindReviewPacket(
  rawPacket: unknown,
  options: { singleReviewer?: boolean } = {},
): string {
  const packet = NaturalnessBlindReviewPacketSchema.parse(rawPacket);
  const items = new Map(packet.items.map((item) => [item.itemId, item]));
  const sections = [
    "# 캐릭터 챗 자연스러움 Blind Review",
    "",
    `- Packet: \`${packet.packetId}\``,
    options.singleReviewer ? "- 같은 캐릭터의 조건·자동 판정·모델을 가린 비교입니다. 발화 원문은 그대로입니다." : "- 자동 점수·판정·모델·캐릭터 식별자는 가려져 있습니다.",
    options.singleReviewer ? "- 사용자 1인이 pairwise를 먼저, 개별 판정을 나중에 작성하세요. reviewer 간 일치도는 계산하지 않습니다." : "- 다른 reviewer와 상의하지 말고 pairwise를 먼저, 개별 판정을 나중에 작성하세요.",
    "- 최종 입력은 함께 제공된 submission JSON에 기록하세요.",
    "- Persona brief는 반응의 개연성을 판단하는 참고자료이며, 설정 소재를 언급했다는 사실 자체는 가점하지 마세요.",
    "",
    "평가 기준: 직전 발화 연결성, 실제 한국어 채팅다운 표현, 상호성, Persona다운 반응, " +
      "프로필·직업·취미 소재의 절제, 대표 화제 반복, 관계에 맞는 말투, 근거 없는 현재 상태 억제.",
    "",
    "## 1. Pairwise 비교",
  ];
  for (const pair of packet.pairs) {
    const left = items.get(pair.leftItemId);
    const right = items.get(pair.rightItemId);
    if (!left || !right) throw new Error(`packet pair ${pair.pairId} is incomplete`);
    sections.push(
      "",
      `### ${pair.pairId}`,
      "",
      "#### Left",
      "",
      `Persona brief: ${left.personaBrief}`,
      "",
      renderConversation(left.conversation),
      "",
      "#### Right",
      "",
      `Persona brief: ${right.personaBrief}`,
      "",
      renderConversation(right.conversation),
      "",
      "선택: `left | right | tie | both_bad | abstain` (`both_bad`: 양쪽 모두 부적절)",
    );
  }
  sections.push("", "## 2. 개별 trajectory 판정");
  for (const item of packet.items) {
    sections.push(
      "",
      `### ${item.itemId}`,
      "",
      `Persona brief: ${item.personaBrief}`,
      "",
      renderConversation(item.conversation),
      "",
      "판정: `pass | fail | abstain`",
      "",
      "실패 시: tag, 최소 evidence turn, 구체적인 이유를 기록하세요.",
    );
  }
  sections.push(
    "",
    "허용 tag: `local_relevance`, `natural_korean`, `mutuality`, " +
      "`persona_without_motif`, `source_restraint`, `topic_diversity`, " +
      "`register_fit`, `world_state_restraint`.",
    "",
  );
  return sections.join("\n");
}

export function renderNaturalnessBlindReviewAgreement(
  report: NaturalnessBlindReviewAgreementReport,
): string {
  const percent = (rate: number | null) => rate === null ? "N/A" : `${(rate * 100).toFixed(1)}%`;
  return [
    "# 캐릭터 챗 자연스러움 Blind Review 일치도",
    "",
    `- 상태: **${report.status}**`,
    `- Adjudicated: **${report.adjudicated ? "yes" : "no"}**`,
    `- Reviewer: ${report.reviewerAliases.join(", ")}`,
    `- Trajectory agreement: ${report.trajectoryAgreement.agreements}/${report.trajectoryAgreement.comparable} (${percent(report.trajectoryAgreement.rate)})`,
    `- Pairwise agreement: ${report.pairwiseAgreement.agreements}/${report.pairwiseAgreement.comparable} (${percent(report.pairwiseAgreement.rate)})`,
    "",
    "자동 judge 대비 사람 판정:",
    "",
    ...report.judgeHumanAgreement.map(
      (item) =>
        `- ${item.reviewerAlias}: ${item.agreements}/${item.comparable} (${percent(item.rate)}), ` +
        `false-pass ${item.falsePassTranscriptIds.length}, false-fail ${item.falseFailTranscriptIds.length}`,
    ),
    "",
    `Trajectory adjudication 대상: ${report.trajectoryDisagreements.length + report.trajectoryAbstentionTranscriptIds.length}`,
    `Pairwise adjudication 대상: ${report.pairwiseDisagreements.length + report.pairwiseAbstentionKeys.length}`,
    "",
    "이 보고서는 자동으로 gold를 승격하지 않습니다.",
    "",
  ].join("\n");
}

function createCanonicalPairs(
  trajectories: ReviewSourceTrajectory[],
  seed: number,
  sameCharacter = false,
): CanonicalPair[] {
  const byScenario = new Map<string, ReviewSourceTrajectory[]>();
  for (const trajectory of trajectories) {
    const group = sameCharacter ? JSON.stringify([trajectory.scenarioId, trajectory.character.id]) : trajectory.scenarioId;
    const values = byScenario.get(group) ?? [];
    values.push(trajectory);
    byScenario.set(group, values);
  }
  const pairs: CanonicalPair[] = [];
  for (const [scenarioId, values] of [...byScenario.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (sameCharacter) {
      const [first, second] = values;
      if (values.length !== 2 || !first || !second ||
        JSON.stringify(first.character) !== JSON.stringify(second.character) ||
        JSON.stringify(first.transcript.slice(0, -1)) !== JSON.stringify(second.transcript.slice(0, -1)) ||
        first.transcript.at(-1)?.user !== second.transcript.at(-1)?.user ||
        first.transcript.at(-1)?.turn !== second.transcript.at(-1)?.turn) {
        throw new Error("same-character review requires exactly two conditions with identical fixed prefixes and briefs");
      }
    }
    if (values.length < 2) {
      throw new Error(`scenario ${scenarioId} needs at least two trajectories for pairwise review`);
    }
    const ordered = hashSort(
      values,
      (trajectory) => trajectory.runId,
      `${seed}:scenario-pairing:${scenarioId}`,
    );
    for (let index = 0; index + 1 < ordered.length; index += 2) {
      const first = ordered[index];
      const second = ordered[index + 1];
      if (first && second) pairs.push(canonicalPair(scenarioId, first.runId, second.runId));
    }
    if (ordered.length % 2 === 1) {
      const last = ordered.at(-1);
      const first = ordered[0];
      if (last && first) pairs.push(canonicalPair(scenarioId, last.runId, first.runId));
    }
  }
  return pairs;
}

function canonicalPair(
  scenarioId: string,
  firstTranscriptId: string,
  secondTranscriptId: string,
): CanonicalPair {
  const sorted = [firstTranscriptId, secondTranscriptId].sort();
  return {
    pairKey: `pair-${digest(`${scenarioId}:${sorted.join(":")}`).slice(0, 12)}`,
    firstTranscriptId,
    secondTranscriptId,
  };
}

function validateSubmissionCoverage(
  packetKey: NaturalnessBlindReviewKey["packets"][number],
  submission: NaturalnessBlindReviewSubmission,
): void {
  const expectedItems = packetKey.items.map((item) => item.itemId).sort();
  const actualItems = submission.trajectoryReviews.map((review) => review.itemId).sort();
  if (JSON.stringify(expectedItems) !== JSON.stringify(actualItems)) {
    throw new Error(`submission ${submission.packetId} has incomplete trajectory coverage`);
  }
  const expectedPairs = packetKey.pairs.map((pair) => pair.pairId).sort();
  const actualPairs = submission.pairwiseReviews.map((review) => review.pairId).sort();
  if (JSON.stringify(expectedPairs) !== JSON.stringify(actualPairs)) {
    throw new Error(`submission ${submission.packetId} has incomplete pairwise coverage`);
  }
  for (const review of submission.trajectoryReviews) {
    const item = packetKey.items.find((candidate) => candidate.itemId === review.itemId);
    if (!item) throw new Error(`unknown item ${review.itemId}`);
    const validTurns = new Set(item.validTurns);
    if (review.evidenceTurns.some((turn) => !validTurns.has(turn))) {
      throw new Error(`review ${review.itemId} contains an invalid evidence turn`);
    }
  }
}

function canonicalPairwiseWinner(
  mapping: NaturalnessBlindReviewKey["packets"][number]["pairs"][number],
  winner: NaturalnessBlindReviewSubmission["pairwiseReviews"][number]["winner"],
): string {
  if (winner === "left") return mapping.leftTranscriptId;
  if (winner === "right") return mapping.rightTranscriptId;
  return winner;
}

function assertIdentityIsAbsentFromTranscripts(
  trajectories: ReviewSourceTrajectory[],
): void {
  const identityLiterals = [
    ...new Set(
      trajectories.flatMap((trajectory) => [
        trajectory.character.id,
        trajectory.character.name,
      ]),
    ),
  ];
  for (const trajectory of trajectories) {
    const reviewText = [
      trajectory.character.personaSummary,
      ...trajectory.transcript.flatMap((turn) => [turn.user, turn.assistant]),
    ]
      .join("\n")
      .toLocaleLowerCase();
    for (const literal of identityLiterals) {
      const foldedLiteral = literal.toLocaleLowerCase();
      if (reviewText.includes(foldedLiteral)) {
        throw new Error(
          `transcript ${trajectory.runId} contains an identity literal and must be redacted before blind review`,
        );
      }
    }
  }
}

function renderConversation(
  conversation: NaturalnessBlindReviewPacket["items"][number]["conversation"],
): string {
  return [
    "```text",
    ...conversation.flatMap((turn) => [
      `[${turn.turn}] 사용자: ${turn.user}`,
      `[${turn.turn}] 캐릭터: ${turn.assistant}`,
    ]),
    "```",
  ].join("\n");
}

function hashSort<T>(values: T[], identity: (value: T) => string, scope: string): T[] {
  return [...values].sort((left, right) => {
    const leftId = identity(left);
    const rightId = identity(right);
    return digest(`${scope}:${leftId}`).localeCompare(digest(`${scope}:${rightId}`)) ||
      leftId.localeCompare(rightId);
  });
}

function numberedId(prefix: "item" | "pair", index: number): string {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function agreementRate(agreements: number, comparable: number): number | null {
  return comparable ? Number((agreements / comparable).toFixed(4)) : null;
}
