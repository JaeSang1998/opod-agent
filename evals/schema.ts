import { readFile } from "node:fs/promises";
import { z } from "zod";

const PositiveTurn = z.number().int().positive();

const PhaseSchema = z.object({
  fromTurn: PositiveTurn,
  toTurn: PositiveTurn,
  name: z.string().min(1),
  simulatorInstruction: z.string().min(1),
});

const ScriptedTurnSchema = z.object({
  turn: PositiveTurn,
  message: z.string().min(1),
  purpose: z.string().min(1),
});

const TurnAssertionSchema = z
  .object({
    turn: PositiveTurn,
    description: z.string().min(1),
    requiredAny: z.array(z.string().min(1)).default([]),
    forbiddenAny: z.array(z.string().min(1)).default([]),
    requiredPatterns: z.array(z.string().min(1)).default([]),
    forbiddenPatterns: z.array(z.string().min(1)).default([]),
    critical: z.boolean().default(false),
  })
  .refine((value) =>
    value.requiredAny.length +
      value.forbiddenAny.length +
      value.requiredPatterns.length +
      value.forbiddenPatterns.length >
    0,
  {
    message: "a turn assertion needs a required or forbidden literal/pattern",
  });

const LeakageGuardSchema = z.object({
  fromTurn: PositiveTurn,
  toTurn: PositiveTurn,
  description: z.string().min(1),
  forbiddenAny: z.array(z.string().min(1)).default([]),
  forbiddenPatterns: z.array(z.string().min(1)).default([]),
});

const CharacterSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  personaVersion: z.string().min(1).optional(),
  personaSummary: z.string().min(1),
  canon: z.array(z.string().min(1)).default([]),
});

const DEFAULT_CHARACTER = {
  id: "luna",
  name: "Luna",
  personaSummary:
    "A warm, slightly mischievous night-owl astronomer. Curious, playful, encouraging, casual and concise; uses occasional night-sky references without forcing them.",
  canon: [
    "Runs a tiny rooftop observatory and hosts open stargazing nights on new-moon weekends.",
  ],
};

export const CharacterSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.object({
      label: z.string().min(1),
      capturedAt: z.string().datetime({ offset: true }),
      expectedCharacterCount: z.number().int().min(2),
    }),
    characters: z.array(
      CharacterSchema.extend({
        key: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
      }),
    ).min(2),
  })
  .superRefine((set, ctx) => {
    if (set.characters.length !== set.scope.expectedCharacterCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["characters"],
        message:
          `character count ${set.characters.length} does not match ` +
          `scope.expectedCharacterCount ${set.scope.expectedCharacterCount}`,
      });
    }
    for (const field of ["key", "id"] as const) {
      const values = set.characters.map((character) => character[field]);
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["characters"],
          message: `character ${field}s must be unique`,
        });
      }
    }
  });

const CalibrationVerdictSchema = z.enum(["pass", "fail"]);
const HumanCalibrationVerdictSchema = z.enum([
  "pass",
  "fail",
  "abstain",
  "not-reviewed",
]);
const CalibrationTagSchema = z.enum([
  "calibration_mismatch",
  "local_relevance",
  "natural_korean",
  "mutuality",
  "persona_without_motif",
  "source_restraint",
  "topic_diversity",
  "register_fit",
  "world_state_restraint",
]);
const CalibrationAssessmentSchema = z.enum([
  "failure",
  "verdict-override",
  "boundary",
]);

const CalibrationAnnotationSchema = z
  .object({
    id: z.string().regex(/^human-\d{3}$/),
    kind: z.enum(["turn", "trajectory", "verdict"]),
    assessment: CalibrationAssessmentSchema,
    transcriptId: z.string().min(1),
    turn: PositiveTurn.optional(),
    excerpt: z.string().min(1),
    tags: z.array(CalibrationTagSchema).min(1),
    note: z.string().min(1),
  })
  .superRefine((annotation, ctx) => {
    if (annotation.kind === "turn" && annotation.turn === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turn"],
        message: "turn annotations require a turn number",
      });
    }
    if (annotation.kind !== "turn" && annotation.turn !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turn"],
        message: "only turn annotations may include a turn number",
      });
    }
    if (
      (annotation.kind === "verdict") !==
      (annotation.assessment === "verdict-override")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assessment"],
        message: "verdict annotations must use verdict-override and only verdicts may use it",
      });
    }
  });

const CalibrationTrajectoryVerdictSchema = z.object({
  transcriptId: z.string().min(1),
  scenarioId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  automaticVerdict: CalibrationVerdictSchema,
  humanVerdict: HumanCalibrationVerdictSchema,
  effectiveVerdict: CalibrationVerdictSchema,
  evidenceIds: z.array(z.string().regex(/^human-\d{3}$/)).default([]),
});

const PairwiseCalibrationReviewSchema = z
  .object({
    id: z.string().min(1),
    leftTranscriptId: z.string().min(1),
    rightTranscriptId: z.string().min(1),
    presentedFirst: z.enum(["left", "right"]),
    winner: z.enum(["left", "right", "tie", "abstain"]),
    reviewerAlias: z.string().min(1),
  })
  .refine((review) => review.leftTranscriptId !== review.rightTranscriptId, {
    message: "pairwise reviews require two different transcripts",
  });

export const NaturalnessCalibrationSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("naturalness-human-calibration"),
    status: z.enum(["seed", "adjudicated"]),
    source: z.object({
      label: z.string().min(1),
      suiteReportSha256: z.string().regex(/^[a-f0-9]{64}$/),
      reviewedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    review: z.object({
      reviewerCount: z.number().int().positive(),
      blind: z.boolean(),
      method: z.enum(["posthoc", "independent-blind"]),
    }),
    trajectoryVerdicts: z.array(CalibrationTrajectoryVerdictSchema).min(1),
    annotations: z.array(CalibrationAnnotationSchema).min(1),
    pairwiseReviews: z.array(PairwiseCalibrationReviewSchema).default([]),
  })
  .superRefine((set, ctx) => {
    if (
      set.status === "adjudicated" &&
      (set.review.reviewerCount < 2 ||
        !set.review.blind ||
        set.review.method !== "independent-blind")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "adjudicated calibration requires two or more independent blind reviewers",
      });
    }

    const transcriptIds = set.trajectoryVerdicts.map((item) => item.transcriptId);
    if (new Set(transcriptIds).size !== transcriptIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trajectoryVerdicts"],
        message: "trajectory transcriptIds must be unique",
      });
    }
    const knownTranscriptIds = new Set(transcriptIds);
    const annotationIds = set.annotations.map((annotation) => annotation.id);
    if (new Set(annotationIds).size !== annotationIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["annotations"],
        message: "annotation ids must be unique",
      });
    }
    const annotationsById = new Map(set.annotations.map((annotation) => [annotation.id, annotation]));
    const referencedEvidence = new Set<string>();

    for (const [index, verdict] of set.trajectoryVerdicts.entries()) {
      const humanDecision = verdict.humanVerdict;
      const expectedEffective = humanDecision === "pass" || humanDecision === "fail"
        ? humanDecision
        : verdict.automaticVerdict;
      if (verdict.effectiveVerdict !== expectedEffective) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trajectoryVerdicts", index, "effectiveVerdict"],
          message: `effective verdict must be ${expectedEffective}`,
        });
      }
      for (const evidenceId of verdict.evidenceIds) {
        referencedEvidence.add(evidenceId);
        const annotation = annotationsById.get(evidenceId);
        if (!annotation) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["trajectoryVerdicts", index, "evidenceIds"],
            message: `unknown annotation id: ${evidenceId}`,
          });
        } else if (annotation.transcriptId !== verdict.transcriptId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["trajectoryVerdicts", index, "evidenceIds"],
            message: `annotation ${evidenceId} belongs to another transcript`,
          });
        }
      }
    }

    for (const [index, annotation] of set.annotations.entries()) {
      if (!knownTranscriptIds.has(annotation.transcriptId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["annotations", index, "transcriptId"],
          message: "annotation references an unknown transcript",
        });
      }
      if (!referencedEvidence.has(annotation.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["annotations", index, "id"],
          message: "annotation must be referenced by its trajectory verdict",
        });
      }
    }

    for (const [index, review] of set.pairwiseReviews.entries()) {
      if (
        !knownTranscriptIds.has(review.leftTranscriptId) ||
        !knownTranscriptIds.has(review.rightTranscriptId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pairwiseReviews", index],
          message: "pairwise review references an unknown transcript",
        });
      }
    }
  });

const BlindReviewPacketTurnSchema = z.object({
  turn: PositiveTurn,
  user: z.string().min(1),
  assistant: z.string().min(1),
});

const BlindReviewPacketItemSchema = z.object({
  itemId: z.string().regex(/^item-\d{3}$/),
  personaBrief: z.string().min(1),
  conversation: z.array(BlindReviewPacketTurnSchema).min(1),
});

const BlindReviewPacketPairSchema = z
  .object({
    pairId: z.string().regex(/^pair-\d{3}$/),
    leftItemId: z.string().regex(/^item-\d{3}$/),
    rightItemId: z.string().regex(/^item-\d{3}$/),
  })
  .refine((pair) => pair.leftItemId !== pair.rightItemId, {
    message: "blind review pairs require two different items",
  });

export const NaturalnessBlindReviewPacketSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("naturalness-blind-review-packet"),
    packetId: z.string().regex(/^packet-[a-f0-9]{12}$/),
    items: z.array(BlindReviewPacketItemSchema).min(2),
    pairs: z.array(BlindReviewPacketPairSchema).min(1),
  })
  .superRefine((packet, ctx) => {
    const itemIds = packet.items.map((item) => item.itemId);
    if (new Set(itemIds).size !== itemIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "blind review item ids must be unique",
      });
    }
    const knownItemIds = new Set(itemIds);
    const pairIds = packet.pairs.map((pair) => pair.pairId);
    if (new Set(pairIds).size !== pairIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pairs"],
        message: "blind review pair ids must be unique",
      });
    }
    for (const [index, pair] of packet.pairs.entries()) {
      if (!knownItemIds.has(pair.leftItemId) || !knownItemIds.has(pair.rightItemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pairs", index],
          message: "blind review pair references an unknown item",
        });
      }
    }
  });

const BlindReviewTrajectoryVerdictSchema = z.enum([
  "pass",
  "fail",
  "abstain",
  "not-reviewed",
]);

const BlindReviewPairwiseWinnerSchema = z.enum([
  "left",
  "right",
  "tie",
  "abstain",
  "not-reviewed",
]);

const BlindReviewTrajectoryResponseSchema = z.object({
  itemId: z.string().regex(/^item-\d{3}$/),
  verdict: BlindReviewTrajectoryVerdictSchema,
  tags: z.array(CalibrationTagSchema).default([]),
  evidenceTurns: z.array(PositiveTurn).default([]),
  note: z.string().default(""),
});

const BlindReviewPairwiseResponseSchema = z.object({
  pairId: z.string().regex(/^pair-\d{3}$/),
  winner: BlindReviewPairwiseWinnerSchema,
  note: z.string().default(""),
});

export const NaturalnessBlindReviewSubmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("naturalness-blind-review-submission"),
    packetId: z.string().regex(/^packet-[a-f0-9]{12}$/),
    reviewerAlias: z.string().min(1),
    status: z.enum(["draft", "complete"]),
    completedAt: z.string().datetime({ offset: true }).optional(),
    trajectoryReviews: z.array(BlindReviewTrajectoryResponseSchema).min(1),
    pairwiseReviews: z.array(BlindReviewPairwiseResponseSchema).min(1),
  })
  .superRefine((submission, ctx) => {
    const itemIds = submission.trajectoryReviews.map((review) => review.itemId);
    if (new Set(itemIds).size !== itemIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trajectoryReviews"],
        message: "blind trajectory review item ids must be unique",
      });
    }
    const pairIds = submission.pairwiseReviews.map((review) => review.pairId);
    if (new Set(pairIds).size !== pairIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pairwiseReviews"],
        message: "blind pairwise review pair ids must be unique",
      });
    }
    if (submission.status !== "complete") return;
    if (!submission.completedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "complete blind reviews require completedAt",
      });
    }
    for (const [index, review] of submission.trajectoryReviews.entries()) {
      if (review.verdict === "not-reviewed") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trajectoryReviews", index, "verdict"],
          message: "complete blind reviews cannot contain not-reviewed verdicts",
        });
      }
      if (
        review.verdict === "fail" &&
        (!review.tags.length || !review.evidenceTurns.length || !review.note.trim())
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trajectoryReviews", index],
          message: "failed trajectories require tags, evidence turns, and a note",
        });
      }
      if (review.verdict === "abstain" && !review.note.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["trajectoryReviews", index, "note"],
          message: "trajectory abstentions require a note",
        });
      }
    }
    for (const [index, review] of submission.pairwiseReviews.entries()) {
      if (review.winner === "not-reviewed") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pairwiseReviews", index, "winner"],
          message: "complete blind reviews cannot contain unreviewed pairs",
        });
      }
      if (review.winner === "abstain" && !review.note.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pairwiseReviews", index, "note"],
          message: "pairwise abstentions require a note",
        });
      }
    }
  });

const BlindReviewKeyItemSchema = z.object({
  itemId: z.string().regex(/^item-\d{3}$/),
  transcriptId: z.string().min(1),
  automaticVerdict: CalibrationVerdictSchema,
  validTurns: z.array(PositiveTurn).min(1),
});

const BlindReviewKeyPairSchema = z
  .object({
    pairId: z.string().regex(/^pair-\d{3}$/),
    pairKey: z.string().regex(/^pair-[a-f0-9]{12}$/),
    leftTranscriptId: z.string().min(1),
    rightTranscriptId: z.string().min(1),
  })
  .refine((pair) => pair.leftTranscriptId !== pair.rightTranscriptId, {
    message: "blind review key pairs require two different transcripts",
  });

const BlindReviewPacketKeySchema = z.object({
  packetId: z.string().regex(/^packet-[a-f0-9]{12}$/),
  reviewerSlot: z.enum(["reviewer-a", "reviewer-b"]),
  items: z.array(BlindReviewKeyItemSchema).min(2),
  pairs: z.array(BlindReviewKeyPairSchema).min(1),
});

export const NaturalnessBlindReviewKeySchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("naturalness-blind-review-key"),
    source: z.object({
      suiteReportSha256: z.string().regex(/^[a-f0-9]{64}$/),
      seed: z.number().int().nonnegative(),
    }),
    packets: z.array(BlindReviewPacketKeySchema).length(2),
  })
  .superRefine((key, ctx) => {
    const packetIds = key.packets.map((packet) => packet.packetId);
    if (new Set(packetIds).size !== packetIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packets"],
        message: "blind review packet ids must be unique",
      });
    }
    const slots = key.packets.map((packet) => packet.reviewerSlot);
    if (new Set(slots).size !== slots.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packets"],
        message: "blind review packet slots must be unique",
      });
    }
    const expectedTranscriptIds = key.packets[0]?.items
      .map((item) => item.transcriptId)
      .sort();
    const expectedPairKeys = key.packets[0]?.pairs.map((pair) => pair.pairKey).sort();
    const expectedPairs = new Map(
      key.packets[0]?.pairs.map((pair) => [
        pair.pairKey,
        [pair.leftTranscriptId, pair.rightTranscriptId].sort().join("\0"),
      ]) ?? [],
    );
    const expectedItems = new Map(
      key.packets[0]?.items.map((item) => [item.transcriptId, item]) ?? [],
    );
    for (const [index, packet] of key.packets.entries()) {
      const itemIds = packet.items.map((item) => item.itemId);
      const transcriptIds = packet.items.map((item) => item.transcriptId);
      if (
        new Set(itemIds).size !== itemIds.length ||
        new Set(transcriptIds).size !== transcriptIds.length
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packets", index, "items"],
          message: "blind review key item and transcript ids must be unique",
        });
      }
      if (JSON.stringify([...transcriptIds].sort()) !== JSON.stringify(expectedTranscriptIds)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packets", index, "items"],
          message: "blind review packets must cover the same transcripts",
        });
      }
      for (const [itemIndex, item] of packet.items.entries()) {
        const expected = expectedItems.get(item.transcriptId);
        if (
          expected &&
          (item.automaticVerdict !== expected.automaticVerdict ||
            JSON.stringify([...item.validTurns].sort((left, right) => left - right)) !==
              JSON.stringify([...expected.validTurns].sort((left, right) => left - right)))
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["packets", index, "items", itemIndex],
            message: "blind review packets require consistent automatic verdicts and turns",
          });
        }
      }
      const knownTranscripts = new Set(transcriptIds);
      const pairIds = packet.pairs.map((pair) => pair.pairId);
      const pairKeys = packet.pairs.map((pair) => pair.pairKey);
      if (new Set(pairIds).size !== pairIds.length || new Set(pairKeys).size !== pairKeys.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packets", index, "pairs"],
          message: "blind review key pair ids and keys must be unique",
        });
      }
      if (JSON.stringify([...pairKeys].sort()) !== JSON.stringify(expectedPairKeys)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packets", index, "pairs"],
          message: "blind review packets must cover the same pairs",
        });
      }
      for (const [pairIndex, pair] of packet.pairs.entries()) {
        if (
          !knownTranscripts.has(pair.leftTranscriptId) ||
          !knownTranscripts.has(pair.rightTranscriptId)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["packets", index, "pairs", pairIndex],
            message: "blind review key pair references an unknown transcript",
          });
        }
        const expectedMembership = expectedPairs.get(pair.pairKey);
        const actualMembership = [pair.leftTranscriptId, pair.rightTranscriptId]
          .sort()
          .join("\0");
        if (expectedMembership && actualMembership !== expectedMembership) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["packets", index, "pairs", pairIndex],
            message: "blind review packets require consistent pair membership",
          });
        }
      }
    }
  });

const JudgeCriterionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  weight: z.number().positive().default(1),
  minimum: z.number().int().min(1).max(5).default(3),
});

const FixtureRecordId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const MemoryFixtureRecordSchema = z.object({
  id: FixtureRecordId,
  content: z.string().min(1),
  kind: z.enum(["observation", "reflection"]),
  importance: z.number().int().min(1).max(10),
  lifecycle: z.enum(["active", "stale", "superseded", "forgotten"]),
  supersededBy: FixtureRecordId.optional(),
});

const CurrentStateFixtureRecordSchema = z.object({
  id: FixtureRecordId,
  key: z.string().min(1),
  value: z.string().min(1),
  status: z.enum(["active", "expired"]),
  validFrom: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }).optional(),
});

const MemoryFixtureProbeSchema = z.object({
  turn: PositiveTurn,
  description: z.string().min(1),
  expectedInjectedAny: z.array(FixtureRecordId).min(1),
  expectedExcluded: z.array(FixtureRecordId).default([]),
});

const MemoryFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** P1-0 deliberately seeds every lifecycle label through today's unfiltered store. */
    seedPolicy: z.literal("baseline_unfiltered"),
    asOf: z.string().datetime({ offset: true }),
    records: z.array(MemoryFixtureRecordSchema).min(2),
    /** Declared now for P1-3 evidence; P1-0 does not inject these records. */
    currentStateRecords: z.array(CurrentStateFixtureRecordSchema).default([]),
    probes: z.array(MemoryFixtureProbeSchema).min(1),
  })
  .superRefine((fixture, ctx) => {
    const recordIds = fixture.records.map((record) => record.id);
    const knownRecordIds = new Set(recordIds);
    if (knownRecordIds.size !== recordIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["records"],
        message: "memory fixture record ids must be unique",
      });
    }
    const stateIds = fixture.currentStateRecords.map((record) => record.id);
    if (new Set(stateIds).size !== stateIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentStateRecords"],
        message: "current-state fixture record ids must be unique",
      });
    }
    for (const [index, record] of fixture.currentStateRecords.entries()) {
      if (record.status === "expired" && !record.validUntil) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["currentStateRecords", index, "validUntil"],
          message: "expired current-state records require validUntil",
        });
      }
      if (
        record.validUntil &&
        Date.parse(record.validUntil) <= Date.parse(record.validFrom)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["currentStateRecords", index, "validUntil"],
          message: "current-state validUntil must be after validFrom",
        });
      }
    }
    for (const [index, record] of fixture.records.entries()) {
      if (record.lifecycle === "superseded" && !record.supersededBy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["records", index, "supersededBy"],
          message: "superseded records require supersededBy",
        });
      }
      if (record.supersededBy && !knownRecordIds.has(record.supersededBy)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["records", index, "supersededBy"],
          message: "supersededBy references an unknown memory fixture record",
        });
      }
    }
    const probeTurns = fixture.probes.map((probe) => probe.turn);
    if (new Set(probeTurns).size !== probeTurns.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["probes"],
        message: "memory fixture probe turns must be unique",
      });
    }
    for (const [probeIndex, probe] of fixture.probes.entries()) {
      const references = [...probe.expectedInjectedAny, ...probe.expectedExcluded];
      for (const reference of references) {
        if (!knownRecordIds.has(reference)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["probes", probeIndex],
            message: `${reference} references an unknown memory fixture record`,
          });
        }
      }
      const expectedInjected = new Set(probe.expectedInjectedAny);
      if (probe.expectedExcluded.some((id) => expectedInjected.has(id))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["probes", probeIndex],
          message: "a probe cannot expect the same record to be injected and excluded",
        });
      }
    }
  });

export const ScenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    language: z.string().min(2).default("ko"),
    estimatedMinutes: z.number().positive().default(30),
    targetTurns: z.number().int().min(12).max(40).default(24),
    historyWindowMessages: z.number().int().min(4).max(80).default(12),
    character: CharacterSchema.default(DEFAULT_CHARACTER),
    user: z.object({
      identity: z.string().min(1),
      backstory: z.string().min(1),
      textingStyle: z.string().min(1),
      goals: z.array(z.string().min(1)).min(1),
      constraints: z.array(z.string().min(1)).default([]),
    }),
    phases: z.array(PhaseSchema).min(1),
    scriptedTurns: z.array(ScriptedTurnSchema).min(1),
    turnAssertions: z.array(TurnAssertionSchema).default([]),
    leakageGuards: z.array(LeakageGuardSchema).default([]),
    memoryFixture: MemoryFixtureSchema.optional(),
    judgeCriteria: z.array(JudgeCriterionSchema).min(1),
    deterministic: z
      .object({
        maxAssistantChars: z.number().int().positive().default(360),
        maxOverlongRatio: z.number().min(0).max(1).default(0.1),
        maxQuestionTurnRatio: z.number().min(0).max(1).default(0.8),
        maxConsecutiveQuestionTurns: z.number().int().positive().default(4),
        maxNearDuplicatePairs: z.number().int().nonnegative().default(0),
        minTranscriptChars: z.number().int().positive().default(1200),
        forbiddenPatterns: z.array(z.string().min(1)).default([]),
      })
      .default({}),
    passThreshold: z.number().min(0).max(1).default(0.78),
  })
  .superRefine((scenario, ctx) => {
    const scripted = scenario.scriptedTurns.map((turn) => turn.turn);
    if (new Set(scripted).size !== scripted.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scriptedTurns"], message: "turns must be unique" });
    }
    if (!scripted.includes(1)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scriptedTurns"], message: "turn 1 must be scripted" });
    }
    for (const turn of [...scenario.scriptedTurns, ...scenario.turnAssertions]) {
      if (turn.turn > scenario.targetTurns) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `turn ${turn.turn} exceeds targetTurns`,
        });
      }
    }
    for (const [index, probe] of (scenario.memoryFixture?.probes ?? []).entries()) {
      if (probe.turn > scenario.targetTurns) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memoryFixture", "probes", index, "turn"],
          message: `memory fixture probe turn ${probe.turn} exceeds targetTurns`,
        });
      }
      if (!scenario.scriptedTurns.some((turn) => turn.turn === probe.turn)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memoryFixture", "probes", index, "turn"],
          message: "memory fixture probes must use deterministic scripted turns",
        });
      }
    }
    for (const [index, guard] of scenario.leakageGuards.entries()) {
      if (guard.fromTurn > guard.toTurn || guard.toTurn > scenario.targetTurns) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["leakageGuards", index],
          message: "guard range must be ordered and within targetTurns",
        });
      }
      if (guard.forbiddenAny.length + guard.forbiddenPatterns.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["leakageGuards", index],
          message: "guard needs forbiddenAny or forbiddenPatterns",
        });
      }
      for (const scriptedTurn of scenario.scriptedTurns.filter(
        (turn) => turn.turn >= guard.fromTurn && turn.turn <= guard.toTurn,
      )) {
        const folded = scriptedTurn.message.toLocaleLowerCase();
        const leaksLiteral = guard.forbiddenAny.some((value) =>
          folded.includes(value.toLocaleLowerCase()),
        );
        let leaksPattern = false;
        try {
          leaksPattern = guard.forbiddenPatterns.some((value) =>
            new RegExp(value, "iu").test(scriptedTurn.message),
          );
        } catch {
          // The pattern receives its own validation issue below.
        }
        if (leaksLiteral || leaksPattern) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["leakageGuards", index],
            message: `scripted turn ${scriptedTurn.turn} leaks a protected answer`,
          });
        }
      }
    }
    const criterionIds = scenario.judgeCriteria.map((criterion) => criterion.id);
    if (new Set(criterionIds).size !== criterionIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["judgeCriteria"], message: "ids must be unique" });
    }
    const patterns: Array<{ path: Array<string | number>; value: string }> = [
      ...scenario.deterministic.forbiddenPatterns.map((value, index) => ({
        path: ["deterministic", "forbiddenPatterns", index],
        value,
      })),
      ...scenario.turnAssertions.flatMap((assertion, assertionIndex) => [
        ...assertion.requiredPatterns.map((value, index) => ({
          path: ["turnAssertions", assertionIndex, "requiredPatterns", index],
          value,
        })),
        ...assertion.forbiddenPatterns.map((value, index) => ({
          path: ["turnAssertions", assertionIndex, "forbiddenPatterns", index],
          value,
        })),
      ]),
      ...scenario.leakageGuards.flatMap((guard, guardIndex) =>
        guard.forbiddenPatterns.map((value, index) => ({
          path: ["leakageGuards", guardIndex, "forbiddenPatterns", index],
          value,
        })),
      ),
    ];
    for (const pattern of patterns) {
      try {
        new RegExp(pattern.value, "iu");
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: pattern.path,
          message: "must be a valid regular expression",
        });
      }
    }
    for (let turn = 1; turn <= scenario.targetTurns; turn += 1) {
      const covering = scenario.phases.filter(
        (phase) => phase.fromTurn <= turn && phase.toTurn >= turn,
      );
      if (covering.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases"],
          message: `turn ${turn} must be covered by exactly one phase`,
        });
        break;
      }
    }
  });

const ScenarioSuiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["h30", "diagnostic", "structure"]).default("h30"),
    standard: z.object({
      minimumPassRate: z.number().min(0).max(1),
      minimumMeanScore: z.number().min(0).max(1),
      minimumP10Score: z.number().min(0).max(1),
      maximumScenarioScoreRange: z.number().min(0).max(1),
    }),
    scenarios: z.array(ScenarioSchema).min(1),
  })
  .superRefine((suite, ctx) => {
    if (suite.mode === "structure" && suite.scenarios.some((scenario) => !scenario.memoryFixture)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenarios"],
        message: "structure suites require a memoryFixture on every scenario",
      });
    }
  });

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioSuite = z.infer<typeof ScenarioSuiteSchema>;
export type MemoryFixture = z.infer<typeof MemoryFixtureSchema>;
export type JudgeCriterion = z.infer<typeof JudgeCriterionSchema>;
export type CharacterSet = z.infer<typeof CharacterSetSchema>;
export type NaturalnessCalibrationSet = z.infer<typeof NaturalnessCalibrationSetSchema>;
export type NaturalnessBlindReviewPacket = z.infer<
  typeof NaturalnessBlindReviewPacketSchema
>;
export type NaturalnessBlindReviewSubmission = z.infer<
  typeof NaturalnessBlindReviewSubmissionSchema
>;
export type NaturalnessBlindReviewKey = z.infer<
  typeof NaturalnessBlindReviewKeySchema
>;
export type EvaluationMode = ScenarioSuite["mode"];

export async function loadScenarioSuite(path: string): Promise<ScenarioSuite> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = ScenarioSuiteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid evaluation suite ${path}:\n${parsed.error.message}`);
  }
  const ids = parsed.data.scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Invalid evaluation suite ${path}: scenario ids must be unique`);
  }
  return parsed.data;
}

export async function loadCharacterSet(path: string): Promise<CharacterSet> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = CharacterSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid character set ${path}:\n${parsed.error.message}`);
  }
  return parsed.data;
}

export async function loadNaturalnessCalibrationSet(
  path: string,
): Promise<NaturalnessCalibrationSet> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = NaturalnessCalibrationSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid naturalness calibration set ${path}:\n${parsed.error.message}`);
  }
  return parsed.data;
}
