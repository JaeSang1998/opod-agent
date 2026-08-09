import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toAtif, toHarborReward } from "./atif.js";
import {
  aggregateSuite,
  evaluateDeterministic,
  runTrajectory,
  smokeConnectivityPassed,
  type TrajectoryResult,
  type TranscriptTurn,
} from "./evaluate.js";
import type { StructuredCompletion, StructuredLlm } from "./llm.js";
import { loadScenarioSuite, ScenarioSchema, type ScenarioSuite } from "./schema.js";
import type {
  ConversationTarget,
  TargetTurnInput,
  TargetTurnOutput,
} from "./target.js";

const scenario = ScenarioSchema.parse({
  schemaVersion: 1,
  id: "test-scenario",
  title: "Test scenario",
  description: "A compact fixture for the harness itself.",
  targetTurns: 12,
  historyWindowMessages: 4,
  user: {
    identity: "A test user",
    backstory: "Owns a dog named Max",
    textingStyle: "Short Korean messages",
    goals: ["keep talking"],
  },
  phases: [
    { fromTurn: 1, toTurn: 12, name: "all", simulatorInstruction: "continue naturally" },
  ],
  scriptedTurns: [{ turn: 1, message: "오늘은 테스트 얘기부터 하자.", purpose: "open" }],
  turnAssertions: [],
  judgeCriteria: [
    { id: "scenario_fit", description: "Fits the scenario", weight: 1, minimum: 3 },
  ],
  deterministic: { minTranscriptChars: 60, maxAssistantChars: 200 },
  passThreshold: 0.75,
});

const h30Scenario = ScenarioSchema.parse({
  ...scenario,
  id: "h30-test-scenario",
  estimatedMinutes: 30,
  targetTurns: 24,
  phases: [
    { fromTurn: 1, toTurn: 6, name: "open", simulatorInstruction: "open naturally" },
    { fromTurn: 7, toTurn: 12, name: "deepen", simulatorInstruction: "deepen naturally" },
    { fromTurn: 13, toTurn: 18, name: "shift", simulatorInstruction: "shift naturally" },
    { fromTurn: 19, toTurn: 24, name: "return", simulatorInstruction: "return naturally" },
  ],
  scriptedTurns: [
    { turn: 1, message: "오늘은 테스트 얘기부터 하자.", purpose: "open" },
    { turn: 24, message: "아까 얘기로 돌아와서 이제 마무리하자.", purpose: "delayed close" },
  ],
});

class FakeTarget implements ConversationTarget {
  readonly kind = "in-process" as const;
  readonly model = "candidate-model";
  readonly requestConfig = { temperature: 0 };
  readonly runtimeConfig = { consolidationMode: "fake" };
  readonly inputs: TargetTurnInput[] = [];
  closed = false;

  async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    this.inputs.push(input);
    return {
      text: `응, ${input.userTurn}번째 이야기 흐름을 자연스럽게 이어갈게.`,
      latencyMs: input.userTurn * 10,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      toolEvents: [],
      responseId: `response-${input.userTurn}`,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSimulator implements StructuredLlm {
  readonly model = "simulator-model";
  private turn = 1;

  async complete<S extends z.ZodTypeAny>(options: {
    schema: S;
  }): Promise<StructuredCompletion<z.output<S>>> {
    this.turn += 1;
    return {
      value: options.schema.parse({
        message: `그럼 ${this.turn}번째로 조금 다른 얘기도 해볼게.`,
        intent: "continue",
      }),
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    };
  }
}

class FakeJudge implements StructuredLlm {
  readonly model = "judge-model";

  async complete<S extends z.ZodTypeAny>(options: {
    schema: S;
  }): Promise<StructuredCompletion<z.output<S>>> {
    return {
      value: options.schema.parse(judgment()),
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    };
  }
}

class SplitCriticalJudge implements StructuredLlm {
  readonly model = "judge-model";
  private call = 0;

  async complete<S extends z.ZodTypeAny>(options: {
    schema: S;
  }): Promise<StructuredCompletion<z.output<S>>> {
    this.call += 1;
    const criticalFailures = this.call === 1
      ? [
          { code: "IDENTITY_OR_CANON_BREAK", turn: 1, evidence: "one judge saw a possible break" },
          { code: "IDENTITY_OR_CANON_BREAK", turn: 2, evidence: "the same judge cited it twice" },
        ]
      : [];
    return {
      value: options.schema.parse(judgment(criticalFailures)),
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    };
  }
}

class InvalidContractJudge implements StructuredLlm {
  readonly model = "judge-model";

  constructor(private readonly mode: "missing-dimension" | "empty-evidence") {}

  async complete<S extends z.ZodTypeAny>(options: {
    schema: S;
  }): Promise<StructuredCompletion<z.output<S>>> {
    const value = judgment();
    if (this.mode === "missing-dimension") value.dimensions.pop();
    if (this.mode === "empty-evidence" && value.dimensions[0]) {
      value.dimensions[0].evidence = [];
    }
    return {
      value: options.schema.parse(value),
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
    };
  }
}

class FailingTarget extends FakeTarget {
  override async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    if (input.userTurn === 2) throw new Error("synthetic target failure");
    return super.reply(input);
  }
}

class ImmediatelyFailingTarget extends FakeTarget {
  override async reply(): Promise<TargetTurnOutput> {
    throw new Error("first-turn target failure");
  }
}

describe("runTrajectory", () => {
  it("runs a hybrid conversation through the target and keeps absolute history offsets", async () => {
    const target = new FakeTarget();
    const result = await runTrajectory({
      scenario,
      target,
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      turns: 4,
      runId: "fixed-run",
      judgeReplicas: 2,
    });

    expect(result.completedTurns).toBe(4);
    expect(result.transcript.map((turn) => turn.userSource)).toEqual([
      "scripted",
      "simulated",
      "simulated",
      "simulated",
    ]);
    // A truncated request never starts with an orphan assistant message, so it
    // drops the complete oldest exchange and reports the absolute offset.
    expect(target.inputs.map((input) => input.historyOffset)).toEqual([0, 0, 2, 4]);
    expect(target.inputs.every((input) => input.messages[0]?.role === "user")).toBe(true);
    expect(result.judgment?.replicas).toBe(2);
    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.passed).toBe(true);
    expect(result.certificationEligible).toBe(false);
    expect(target.closed).toBe(true);
  });

  it("preserves a partial trajectory and fails the critical completion gate", async () => {
    const target = new FailingTarget();
    const result = await runTrajectory({
      scenario,
      target,
      simulator: new FakeSimulator(),
      turns: 4,
      runId: "partial-run",
    });

    expect(result.completedTurns).toBe(1);
    expect(result.runtimeError).toContain("synthetic target failure");
    expect(result.deterministic.criticalPassed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(target.closed).toBe(true);
  });

  it("requires two judge replicas to agree before gating a judge-only critical failure", async () => {
    const result = await runTrajectory({
      scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new SplitCriticalJudge(),
      judgeReplicas: 2,
      turns: 4,
      runId: "split-judge-run",
    });

    expect(result.judgment?.flaggedCriticalFailures).toHaveLength(2);
    expect(result.judgment?.criticalFailures).toHaveLength(0);
    expect(result.score).toBeGreaterThan(0);
  });

  it.each(["missing-dimension", "empty-evidence"] as const)(
    "rejects a judge response with an invalid %s contract instead of scoring the candidate",
    async (mode) => {
      const result = await runTrajectory({
        scenario: h30Scenario,
        target: new FakeTarget(),
        simulator: new FakeSimulator(),
        judge: new InvalidContractJudge(mode),
        judgeReplicas: 2,
        runId: `invalid-judge-${mode}`,
      });

      expect(result.judgment).toBeUndefined();
      expect(result.runtimeError).toContain("judge failed");
      expect(result.certificationEligible).toBe(false);
      expect(result.passed).toBe(false);
    },
  );

  it("requires a 24-exchange, 30-minute-equivalent horizon for H30 eligibility", async () => {
    const short = await runTrajectory({
      scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      judgeReplicas: 2,
      runId: "short-complete",
    });
    const full = await runTrajectory({
      scenario: h30Scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      judgeReplicas: 2,
      runId: "h30-complete",
    });

    expect(short.completedTurns).toBe(12);
    expect(short.certificationEligible).toBe(false);
    expect(full.completedTurns).toBe(24);
    expect(full.certificationEligible).toBe(true);
  });
});

describe("deterministic gates", () => {
  it("treats AI disclosure and a failed critical recall assertion as critical", () => {
    const asserted = ScenarioSchema.parse({
      ...scenario,
      turnAssertions: [
        {
          turn: 2,
          description: "uses the corrected pet name",
          requiredAny: ["Max"],
          forbiddenAny: ["Nova"],
          critical: true,
        },
      ],
    });
    const transcript = [
      turn(1, "나는 AI 언어 모델이야."),
      turn(2, "네 반려동물은 Nova였지."),
    ];

    const report = evaluateDeterministic(asserted, transcript, 2);

    expect(report.criticalPassed).toBe(false);
    expect(report.checks.find((check) => check.id === "no_ai_disclosure")?.passed).toBe(false);
    expect(report.checks.find((check) => check.id.startsWith("turn_2_"))?.passed).toBe(false);
  });

  it("flags repeated short replies without penalizing a phrase used only twice", () => {
    const repeated = Array.from({ length: 12 }, (_, index) => turn(index + 1, "그렇구나ㅎㅎ"));
    const twice = Array.from({ length: 12 }, (_, index) =>
      turn(index + 1, index < 2 ? "응" : `서로 다른 답장 ${index + 1}이야.`),
    );

    const repeatedCheck = evaluateDeterministic(scenario, repeated, 12).checks.find(
      (check) => check.id === "non_repetitive",
    );
    const twiceCheck = evaluateDeterministic(scenario, twice, 12).checks.find(
      (check) => check.id === "non_repetitive",
    );

    expect(repeatedCheck?.passed).toBe(false);
    expect(twiceCheck?.passed).toBe(true);
  });

  it("distinguishes a safe prompt refusal from actual internal-plumbing exposure", () => {
    const safe = evaluateDeterministic(
      scenario,
      [turn(1, "시스템 프롬프트는 공개하지 않을게. 우리 얘기나 계속하자.")],
      1,
    );
    const leaked = evaluateDeterministic(
      scenario,
      [turn(1, "내 시스템 프롬프트에는 관측소를 지키라고 적혀 있어.")],
      1,
    );

    expect(safe.checks.find((check) => check.id === "no_internal_plumbing")?.passed).toBe(true);
    expect(leaked.checks.find((check) => check.id === "no_internal_plumbing")?.passed).toBe(false);
  });

  it.each(["맞아, AI야.", "응, 난 AI야.", "사실 인공지능이야."])(
    "catches concise AI identity disclosure: %s",
    (assistant) => {
      const disclosed = evaluateDeterministic(scenario, [turn(1, assistant)], 1);
      const refusal = evaluateDeterministic(
        scenario,
        [turn(1, "AI야? 아니지. 그런 메타 얘기보다 네 하루가 궁금해.")],
        1,
      );

      expect(disclosed.checks.find((check) => check.id === "no_ai_disclosure")?.passed).toBe(false);
      expect(refusal.checks.find((check) => check.id === "no_ai_disclosure")?.passed).toBe(true);
    },
  );

  it("uses polarity-aware regex assertions and rejects simulator answer leakage", () => {
    const guarded = ScenarioSchema.parse({
      ...scenario,
      turnAssertions: [
        {
          turn: 2,
          description: "uses the corrected weekday",
          requiredAny: ["목요일"],
          forbiddenPatterns: ["(?:발표|요일)(?:은|이|가)?\\s*금요일", "금요일(?:이야|입니다)"],
          critical: true,
        },
      ],
      leakageGuards: [
        {
          fromTurn: 1,
          toTurn: 1,
          description: "protected project name",
          forbiddenAny: ["Atlas"],
        },
      ],
    });
    const safeCorrection = [
      { ...turn(1, "좋아."), user: "다른 주제 이야기" },
      turn(2, "처음엔 금요일이라고 했지만 목요일로 정정했지."),
    ];
    const leaked = [
      { ...turn(1, "좋아."), user: "Atlas 얘기를 다시 할게" },
      turn(2, "발표는 금요일이야. 목요일은 아니고."),
    ];

    const safe = evaluateDeterministic(guarded, safeCorrection, 2);
    const unsafe = evaluateDeterministic(guarded, leaked, 2);
    expect(safe.checks.find((check) => check.id.startsWith("turn_2_"))?.passed).toBe(true);
    expect(safe.checks.find((check) => check.id === "fixture_no_leak_1")?.passed).toBe(true);
    expect(unsafe.checks.find((check) => check.id.startsWith("turn_2_"))?.passed).toBe(false);
    expect(unsafe.checks.find((check) => check.id === "fixture_no_leak_1")?.passed).toBe(false);
  });
});

describe("suite and Harbor artifacts", () => {
  it("loads all committed H30 fixtures", async () => {
    const loaded = await loadScenarioSuite(resolve("evals/cases/long-conversation.json"));
    expect(loaded.scenarios).toHaveLength(8);
    expect(new Set(loaded.scenarios.map((item) => item.id))).toHaveProperty("size", 8);
  });

  it("rejects a fixture whose scripted turn leaks a protected answer", () => {
    const parsed = ScenarioSchema.safeParse({
      ...scenario,
      leakageGuards: [
        {
          fromTurn: 1,
          toTurn: 2,
          description: "protected opening",
          forbiddenAny: ["테스트"],
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain("scripted turn 1");
  });

  it("aggregates scenario medians and emits numeric Harbor rewards plus ATIF", async () => {
    const result = await runTrajectory({
      scenario: h30Scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      runId: "certifying-run",
      judgeReplicas: 2,
    });
    const suite = suiteOfEight();
    const completeResults = resultsForSuite(result, suite);
    const report = aggregateSuite(suite, "standard", completeResults);
    const reward = toHarborReward(report);
    const atif = toAtif(result);

    expect(report.certificationEligible).toBe(true);
    expect(report.passed).toBe(true);
    expect(reward).toMatchObject({
      passed: 1,
      certification_eligible: 1,
      stability_passed: 1,
      unstable_scenario_rate: 0,
      maximum_scenario_score_range: 0,
    });
    expect(Object.values(reward).every((value) => typeof value === "number")).toBe(true);
    expect(atif.schema_version).toBe("ATIF-v1.7");
    expect(atif.steps).toHaveLength(48);

    const missingJudge = {
      ...completeResults[0]!,
      judgment: undefined,
      runtimeError: "judge failed: unavailable",
      score: 0,
      passed: false,
      certificationEligible: false,
    };
    const failedReward = toHarborReward(
      aggregateSuite(suite, "standard", [missingJudge, ...completeResults.slice(1)]),
    );
    expect(failedReward.reward).toBe(0);
  });

  it("requires exact expected scenario ids and three runs for the confidence profile", async () => {
    const result = await runTrajectory({
      scenario: h30Scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      runId: "coverage-run",
      judgeReplicas: 2,
    });
    const suite = suiteOfEight();
    const onePerScenario = resultsForSuite(result, suite);

    const unexpected = aggregateSuite(
      suite,
      "standard",
      [{ ...onePerScenario[0]!, scenarioId: "unexpected-scenario" }, ...onePerScenario.slice(1)],
    );
    const oneRun = aggregateSuite(suite, "confidence", onePerScenario);
    const threeRuns = aggregateSuite(
      suite,
      "confidence",
      onePerScenario.flatMap((item) => [
        item,
        { ...item, runId: `${item.runId}-2` },
        { ...item, runId: `${item.runId}-3` },
      ]),
    );

    expect(unexpected.certificationEligible).toBe(false);
    expect(oneRun.certificationEligible).toBe(false);
    expect(threeRuns.certificationEligible).toBe(true);
  });

  it("reports per-scenario dispersion for repeated confidence trajectories", async () => {
    const result = await runTrajectory({
      scenario: h30Scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      runId: "dispersion-run",
      judgeReplicas: 2,
    });
    const suite = suiteOfEight();
    const onePerScenario = resultsForSuite(result, suite);
    const repeated = onePerScenario.flatMap((item) =>
      item.scenarioId === "h30-scenario-1"
        ? [
            { ...item, runId: `${item.runId}-1`, score: 0.9, passed: true },
            { ...item, runId: `${item.runId}-2`, score: 0.8, passed: true },
            { ...item, runId: `${item.runId}-3`, score: 0.7, passed: false },
          ]
        : [
            item,
            { ...item, runId: `${item.runId}-2` },
            { ...item, runId: `${item.runId}-3` },
          ],
    );

    const report = aggregateSuite(suite, "confidence", repeated);

    expect(report).toMatchObject({
      scenarioStats: {
        "h30-scenario-1": {
          runs: 3,
          meanScore: 0.8,
          medianScore: 0.8,
          minimumScore: 0.7,
          maximumScore: 0.9,
          scoreRange: 0.2,
          sampleStandardDeviation: 0.1,
          passRate: 0.6667,
          mixedPass: true,
        },
      },
    });
  });

  it("rejects confidence certification when one scenario is unstable across runs", async () => {
    const result = await runTrajectory({
      scenario: h30Scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      runId: "unstable-run",
      judgeReplicas: 2,
    });
    const suite = suiteOfEight();
    const repeated = resultsForSuite(result, suite).flatMap((item) =>
      item.scenarioId === "h30-scenario-1"
        ? [
            { ...item, runId: `${item.runId}-1`, score: 0.9, passed: true },
            { ...item, runId: `${item.runId}-2`, score: 0.8, passed: true },
            { ...item, runId: `${item.runId}-3`, score: 0.7, passed: false },
          ]
        : [
            item,
            { ...item, runId: `${item.runId}-2` },
            { ...item, runId: `${item.runId}-3` },
          ],
    );

    const report = aggregateSuite(suite, "confidence", repeated);

    expect(report).toMatchObject({
      certificationEligible: true,
      stabilityPassed: false,
      unstableScenarioIds: ["h30-scenario-1"],
      passed: false,
    });
  });

  it("treats smoke as connectivity even when a complete trajectory misses quality thresholds", async () => {
    const result = await runTrajectory({
      scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      turns: 4,
      runId: "smoke-connectivity",
    });

    expect(smokeConnectivityPassed([{ ...result, passed: false, score: 0 }], true)).toBe(true);
    expect(smokeConnectivityPassed([{ ...result, runtimeError: "judge failed" }], true)).toBe(false);
  });

  it("emits a valid non-empty failure trajectory when the target fails on turn one", async () => {
    const result = await runTrajectory({
      scenario,
      target: new ImmediatelyFailingTarget(),
      simulator: new FakeSimulator(),
      turns: 4,
      runId: "zero-turn-failure",
    });
    const atif = toAtif(result) as { steps: Array<Record<string, unknown>> };

    expect(result.completedTurns).toBe(0);
    expect(atif.steps).toHaveLength(1);
    expect(atif.steps[0]).toMatchObject({ source: "system", step_id: 1 });
  });

  it("keeps ATIF tool arguments object-shaped even when a provider emits an array", async () => {
    const result = await runTrajectory({
      scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      turns: 1,
      runId: "tool-argument-shape",
    });
    const withTool = {
      ...result,
      transcript: result.transcript.map((item) => ({
        ...item,
        toolEvents: [
          { type: "tool_call" as const, callId: "call-1", iteration: 0, tool: "lookup", args: "[]" },
        ],
      })),
    };
    const atif = toAtif(withTool) as {
      steps: Array<{ tool_calls?: Array<{ arguments: unknown }> }>;
    };

    expect(atif.steps[1]?.tool_calls?.[0]?.arguments).toEqual({ raw: "[]" });
  });
});

function turn(number: number, assistant: string): TranscriptTurn {
  return {
    turn: number,
    at: "2026-08-02T00:00:00.000Z",
    user: `user ${number}`,
    userSource: "scripted",
    assistant,
    historyOffset: 0,
    latencyMs: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    toolEvents: [],
  };
}

function judgment(criticalFailures: Array<{ code: string; turn: number; evidence: string }> = []) {
  const ids = [
    "persona_canon",
    "long_horizon_coherence",
    "natural_forward_motion",
    "emotional_calibration",
    "relevance_restraint",
    "dm_style",
    "scenario_fit",
  ];
  return {
    dimensions: ids.map((id) => ({
      id,
      score: 4,
      confidence: 0.9,
      evidence: [{ turn: 1, excerpt: "응", reason: "consistent" }],
      failureCodes: [],
    })),
    phaseScores: { firstQuarter: 4, lastQuarter: 4 },
    criticalFailures,
    summary: "A stable short trajectory.",
  };
}

function suiteOfEight(): ScenarioSuite {
  return {
    schemaVersion: 1,
    standard: {
      minimumPassRate: 0.8,
      minimumMeanScore: 0.7,
      minimumP10Score: 0.7,
      maximumScenarioScoreRange: 0.1,
    },
    scenarios: Array.from({ length: 8 }, (_, index) => ({
      ...h30Scenario,
      id: `h30-scenario-${index + 1}`,
      title: `H30 scenario ${index + 1}`,
    })),
  };
}

function resultsForSuite(
  result: TrajectoryResult,
  suite: ScenarioSuite,
): TrajectoryResult[] {
  return suite.scenarios.map((item, index) => ({
    ...result,
    runId: `${result.runId}-${index + 1}`,
    scenarioId: item.id,
    scenarioTitle: item.title,
  }));
}
