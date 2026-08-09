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

const DEFAULT_CHARACTER = {
  id: "luna",
  name: "Luna",
  personaSummary:
    "A warm, slightly mischievous night-owl astronomer. Curious, playful, encouraging, casual and concise; uses occasional night-sky references without forcing them.",
  canon: [
    "Runs a tiny rooftop observatory and hosts open stargazing nights on new-moon weekends.",
  ],
};

const JudgeCriterionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  weight: z.number().positive().default(1),
  minimum: z.number().int().min(1).max(5).default(3),
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
    character: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        personaSummary: z.string().min(1),
        canon: z.array(z.string().min(1)).default([]),
      })
      .default(DEFAULT_CHARACTER),
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

const ScenarioSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  standard: z.object({
    minimumPassRate: z.number().min(0).max(1),
    minimumMeanScore: z.number().min(0).max(1),
    minimumP10Score: z.number().min(0).max(1),
    maximumScenarioScoreRange: z.number().min(0).max(1),
  }),
  scenarios: z.array(ScenarioSchema).min(1),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioSuite = z.infer<typeof ScenarioSuiteSchema>;
export type JudgeCriterion = z.infer<typeof JudgeCriterionSchema>;

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
