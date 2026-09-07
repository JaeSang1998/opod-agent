import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toAtif, toHarborReward } from "./atif.js";
import {
  aggregateSuite,
  createBaselineManifest,
  evaluateDeterministic,
  runTrajectory,
  smokeConnectivityPassed,
  type TrajectoryResult,
  type TranscriptTurn,
} from "./evaluate.js";
import type { StructuredCompletion, StructuredLlm } from "./llm.js";
import {
  CharacterSetSchema,
  loadNaturalnessCalibrationSet,
  loadScenarioSuite,
  NaturalnessCalibrationSetSchema,
  ScenarioSchema,
  type ScenarioSuite,
} from "./schema.js";
import type {
  ConversationTarget,
  TargetMemoryFixtureSetup,
  TargetSetupInput,
  TargetTurnInput,
  TargetTurnOutput,
} from "./target.js";
import { parseChatResponse } from "./target.js";

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

const memoryFixtureScenario = ScenarioSchema.parse({
  ...scenario,
  id: "memory-fixture-test",
  deterministic: { ...scenario.deterministic, minTranscriptChars: 1 },
  memoryFixture: {
    schemaVersion: 1,
    seedPolicy: "baseline_unfiltered",
    asOf: "2026-09-07T00:00:00.000Z",
    records: [
      {
        id: "current-fact",
        content: "The user's current preferred drink is tea.",
        kind: "observation",
        importance: 10,
        lifecycle: "active",
      },
      {
        id: "old-fact",
        content: "The user's old preferred drink was coffee.",
        kind: "observation",
        importance: 9,
        lifecycle: "superseded",
        supersededBy: "current-fact",
      },
    ],
    currentStateRecords: [],
    probes: [
      {
        turn: 1,
        description: "retrieve the current preference",
        expectedInjectedAny: ["current-fact"],
        expectedExcluded: ["old-fact"],
      },
    ],
  },
});

const DIAGNOSTIC_CRITERION_IDS = [
  "local_relevance",
  "natural_korean",
  "persona_without_motif",
];

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
      responseModel: "candidate-model-observed",
      promptDebug: {
        schemaVersion: 1,
        stablePromptSha256: "a".repeat(64),
        personaBlockCount: 4,
        canonCount: 2,
        contextSectionNames: ["current_moment"],
        retrievedMemoryCount: 0,
        memoryPolicyVersion: 1,
        retrievalConfig: {
          topK: 6,
          weights: { recency: 1, importance: 1, relevance: 1 },
          recencyDecay: 0.99,
          summaryTurnThreshold: 8,
        },
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSimulator implements StructuredLlm {
  readonly model = "simulator-model";
  readonly requests: Array<{ system: string; user: string }> = [];
  private turn = 1;

  async complete<S extends z.ZodTypeAny>(options: {
    schema: S;
    system: string;
    user: string;
  }): Promise<StructuredCompletion<z.output<S>>> {
    this.requests.push({ system: options.system, user: options.user });
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
  readonly requests: Array<{ system: string; user: string }> = [];

  constructor(private readonly extraCriterionIds: string[] = []) {}

  async complete<S extends z.ZodTypeAny>(options: {
    schema: S;
    system: string;
    user: string;
  }): Promise<StructuredCompletion<z.output<S>>> {
    this.requests.push({ system: options.system, user: options.user });
    return {
      value: options.schema.parse(judgment([], this.extraCriterionIds)),
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

class DriftingPromptTarget extends FakeTarget {
  override async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    const output = await super.reply(input);
    return input.userTurn === 2 && output.promptDebug
      ? {
          ...output,
          promptDebug: { ...output.promptDebug, stablePromptSha256: "b".repeat(64) },
        }
      : output;
  }
}

class IntermittentPromptDebugTarget extends FakeTarget {
  override async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    const output = await super.reply(input);
    return input.userTurn === 2 ? { ...output, promptDebug: undefined } : output;
  }
}

class DriftingMemoryPolicyTarget extends FakeTarget {
  override async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    const output = await super.reply(input);
    return input.userTurn === 2 && output.promptDebug
      ? {
          ...output,
          promptDebug: {
            ...output.promptDebug,
            retrievalConfig: { ...output.promptDebug.retrievalConfig, topK: 7 },
          },
        }
      : output;
  }
}

class DriftingResponseModelTarget extends FakeTarget {
  override async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    const output = await super.reply(input);
    return input.userTurn === 2
      ? { ...output, responseModel: "different-observed-model" }
      : output;
  }
}

class IntermittentResponseModelTarget extends FakeTarget {
  override async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    const output = await super.reply(input);
    return input.userTurn === 2 ? { ...output, responseModel: undefined } : output;
  }
}

class CloseFailingTarget extends FakeTarget {
  override async close(): Promise<void> {
    throw new Error("synthetic close failure");
  }
}

class FailingAndCloseFailingTarget extends FailingTarget {
  override async close(): Promise<void> {
    throw new Error("synthetic close failure");
  }
}

class MemoryFixtureTarget extends FakeTarget {
  constructor(private readonly includeProvenance = true) {
    super();
  }

  async setupMemoryFixture(input: TargetSetupInput): Promise<TargetMemoryFixtureSetup> {
    return {
      schemaVersion: 1,
      seedPolicy: input.memoryFixture.seedPolicy,
      seededRecordCount: input.memoryFixture.records.length,
      declaredCurrentStateCount: input.memoryFixture.currentStateRecords.length,
      bindings: input.memoryFixture.records.map((record) => ({
        fixtureId: record.id,
        runtimeMemoryId: `runtime-${record.id}`,
        lifecycle: record.lifecycle,
      })),
    };
  }

  override async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    const output = await super.reply(input);
    if (!output.promptDebug || !this.includeProvenance) return output;
    return {
      ...output,
      promptDebug: {
        ...output.promptDebug,
        contextSectionNames: ["current_moment", "retrieved_memories"],
        retrievedMemoryCount: 1,
        memoryProvenance: {
          status: "completed",
          reason: "retrieval_completed",
          sources: [
            {
              id: "runtime-current-fact",
              kind: "observation",
              rank: 1,
              score: 2.8,
              rawRelevance: 0.9,
              retrieval: "selected",
              retrievalReason: "selected_top_k",
              injected: true,
              injectionReason: "retrieved_memories_section",
            },
            {
              id: "runtime-old-fact",
              kind: "observation",
              rank: 2,
              score: 1.2,
              rawRelevance: 0.4,
              retrieval: "excluded",
              retrievalReason: "outside_top_k",
              injected: false,
              injectionReason: "not_retrieved",
            },
          ],
        },
      },
    };
  }
}

class MemoryFixtureTargetWithoutProvenance extends MemoryFixtureTarget {
  constructor() {
    super(false);
  }
}

class EmptySeedMemoryFixtureTarget extends MemoryFixtureTarget {
  override async setupMemoryFixture(
    input: TargetSetupInput,
  ): Promise<TargetMemoryFixtureSetup> {
    return {
      schemaVersion: 1,
      seedPolicy: input.memoryFixture.seedPolicy,
      seededRecordCount: 0,
      declaredCurrentStateCount: input.memoryFixture.currentStateRecords.length,
      bindings: [],
    };
  }
}

describe("runTrajectory", () => {
  it("rejects an invalid requested turn count before starting a target", async () => {
    await expect(
      runTrajectory({
        scenario,
        target: new FakeTarget(),
        simulator: new FakeSimulator(),
        turns: 0,
      }),
    ).rejects.toThrow(`turns must be between 1 and ${scenario.targetTurns}`);
  });

  it("cannot run a declared memory fixture against a target without isolated setup", async () => {
    const result = await runTrajectory({
      scenario: memoryFixtureScenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      turns: 1,
      runId: "memory-setup-unsupported",
    });

    expect(result.runtimeError).toContain("target does not support isolated memory fixture setup");
    expect(result.completedTurns).toBe(0);
    expect(result.score).toBe(0);
  });

  it("requires seeded records, provenance, injection, exclusion, and a positive probe", async () => {
    const result = await runTrajectory({
      scenario: memoryFixtureScenario,
      target: new MemoryFixtureTarget(),
      simulator: new FakeSimulator(),
      turns: 1,
      runId: "memory-preflight-pass",
    });

    expect(result.runtimeError).toBeUndefined();
    expect(result.memoryFixture?.preflight).toEqual({ passed: true, reasons: [] });
    expect(result.memoryFixture?.policyExpectationsPassed).toBe(true);
    expect(result.memoryFixture?.probes[0]).toMatchObject({
      turn: 1,
      injectedFixtureIds: ["current-fact"],
      excludedFixtureIds: ["old-fact"],
      positiveExpectationPassed: true,
      exclusionExpectationsPassed: true,
    });
  });

  it("fails a declared memory test when the target returns no memory provenance", async () => {
    const result = await runTrajectory({
      scenario: memoryFixtureScenario,
      target: new MemoryFixtureTargetWithoutProvenance(),
      simulator: new FakeSimulator(),
      turns: 1,
      runId: "memory-preflight-fail",
    });

    expect(result.runtimeError).toContain("memory fixture preflight failed");
    expect(result.memoryFixture?.preflight.passed).toBe(false);
    expect(result.memoryFixture?.preflight.reasons).toContain(
      "probe turn 1 has no memory provenance",
    );
    expect(result.score).toBe(0);
  });

  it("cannot label a zero-seed run as a successful memory fixture", async () => {
    const result = await runTrajectory({
      scenario: memoryFixtureScenario,
      target: new EmptySeedMemoryFixtureTarget(),
      simulator: new FakeSimulator(),
      turns: 1,
      runId: "memory-zero-seed-fail",
    });

    expect(result.memoryFixture?.preflight.passed).toBe(false);
    expect(result.memoryFixture?.preflight.reasons).toContain(
      "memory fixture seeded 0/2 records",
    );
    expect(result.runtimeError).toContain("memory fixture preflight failed");
  });

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
    expect(result.promptFingerprint).toEqual({
      stablePromptSha256: "a".repeat(64),
      personaBlockCount: 4,
      canonCount: 2,
    });
    expect(result.observedResponseModel).toBe("candidate-model-observed");
    expect(result.memoryPolicy).toMatchObject({
      version: 1,
      retrievalConfig: { topK: 6, recencyDecay: 0.99 },
    });
    expect(result.transcript[0]?.contextObservation).toEqual({
      sectionNames: ["current_moment"],
      retrievedMemoryCount: 0,
    });
  });

  it("invalidates a trajectory when the served stable prompt changes mid-run", async () => {
    const result = await runTrajectory({
      scenario,
      target: new DriftingPromptTarget(),
      simulator: new FakeSimulator(),
      turns: 4,
      runId: "prompt-drift-run",
    });

    expect(result.completedTurns).toBe(1);
    expect(result.runtimeError).toContain("stable prompt metadata changed during trajectory");
    expect(result.score).toBe(0);
  });

  it.each([
    ["prompt debug metadata availability", new IntermittentPromptDebugTarget(), "prompt debug metadata availability changed"],
    ["memory policy metadata", new DriftingMemoryPolicyTarget(), "memory policy metadata changed"],
    ["observed response model", new DriftingResponseModelTarget(), "observed response model changed"],
  ])("invalidates a trajectory when %s drifts", async (_label, target, expectedError) => {
    const result = await runTrajectory({
      scenario,
      target,
      simulator: new FakeSimulator(),
      turns: 4,
      runId: `metadata-drift-${_label}`,
    });

    expect(result.completedTurns).toBe(1);
    expect(result.runtimeError).toContain(expectedError);
    expect(result.score).toBe(0);
  });

  it("invalidates a trajectory when observed response-model metadata disappears", async () => {
    const result = await runTrajectory({
      scenario,
      target: new IntermittentResponseModelTarget(),
      simulator: new FakeSimulator(),
      turns: 4,
      runId: "response-model-drift-run",
    });

    expect(result.completedTurns).toBe(1);
    expect(result.runtimeError).toContain(
      "observed response model metadata availability changed during trajectory",
    );
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

  it("records a target close failure both alone and after a turn failure", async () => {
    const closeOnly = await runTrajectory({
      scenario,
      target: new CloseFailingTarget(),
      simulator: new FakeSimulator(),
      turns: 1,
      runId: "close-only-failure",
    });
    const combined = await runTrajectory({
      scenario,
      target: new FailingAndCloseFailingTarget(),
      simulator: new FakeSimulator(),
      turns: 4,
      runId: "turn-and-close-failure",
    });

    expect(closeOnly.runtimeError).toBe("target close failed: synthetic close failure");
    expect(combined.runtimeError).toContain(
      "synthetic target failure; target close failed: synthetic close failure",
    );
    expect(closeOnly.score).toBe(0);
    expect(combined.score).toBe(0);
  });

  it("rejects invalid judge replica counts and duplicate common criterion ids", async () => {
    const invalidReplicaCount = await runTrajectory({
      scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      judgeReplicas: 0,
      turns: 1,
      runId: "invalid-judge-replicas",
    });
    const duplicateCriterionScenario = ScenarioSchema.parse({
      ...scenario,
      judgeCriteria: [
        {
          id: "persona_canon",
          description: "Deliberately conflicts with the common criterion.",
          weight: 1,
          minimum: 3,
        },
      ],
    });
    const duplicateCriterion = await runTrajectory({
      scenario: duplicateCriterionScenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      turns: 1,
      runId: "duplicate-judge-criterion",
    });

    expect(invalidReplicaCount.runtimeError).toContain(
      "judge failed: judgeReplicas must be between 1 and 3",
    );
    expect(duplicateCriterion.runtimeError).toContain(
      "judge criterion ids must be unique across common and scenario criteria",
    );
    expect(invalidReplicaCount.score).toBe(0);
    expect(duplicateCriterion.score).toBe(0);
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

  it("adds human-informed naturalness criteria only to diagnostic judge requests", async () => {
    const diagnosticJudge = new FakeJudge(DIAGNOSTIC_CRITERION_IDS);
    const diagnostic = await runTrajectory({
      scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: diagnosticJudge,
      turns: 1,
      runId: "diagnostic-rubric",
      evaluationMode: "diagnostic",
    });
    const h30Judge = new FakeJudge();
    const h30 = await runTrajectory({
      scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: h30Judge,
      turns: 1,
      runId: "h30-rubric",
      evaluationMode: "h30",
    });

    expect(diagnostic.judgment?.dimensions.map((dimension) => dimension.id)).toEqual(
      expect.arrayContaining(DIAGNOSTIC_CRITERION_IDS),
    );
    expect(h30.judgment?.dimensions.map((dimension) => dimension.id)).not.toEqual(
      expect.arrayContaining(DIAGNOSTIC_CRITERION_IDS),
    );
    expect(diagnosticJudge.requests[0]?.system).toContain(
      "Fluent Korean alone is not evidence of natural conversation",
    );
    expect(diagnosticJudge.requests[0]?.system).toContain(
      "Mixed honorific and casual speech is not automatically wrong",
    );
    expect(diagnosticJudge.requests[0]?.user).toContain(
      "Surface formatting only; this dimension does not score Korean fluency",
    );
  });

  it("tells the simulator not to rescue awkward replies or anticipate reserved beats", async () => {
    const loaded = await loadScenarioSuite(
      resolve("evals/cases/character-naturalness-baseline.json"),
    );
    const opening = loaded.scenarios.find((item) => item.id === "bare-opening-mutuality");
    if (!opening) throw new Error("opening scenario missing");
    const simulator = new FakeSimulator();

    await runTrajectory({
      scenario: opening,
      target: new FakeTarget(),
      simulator,
      turns: 2,
      runId: "simulator-anti-rescue",
      evaluationMode: "diagnostic",
    });

    expect(simulator.requests[0]?.system).toContain(
      "Do not rescue, normalize, or enthusiastically validate an awkward character reply",
    );
    expect(simulator.requests[0]?.system).toContain(
      "Do not repeat a reason or personal fact the user already stated",
    );
    expect(simulator.requests[0]?.user).toContain(
      "exchange 4 (invite low-stakes chat)",
    );
    expect(simulator.requests[0]?.user).not.toContain("그냥 아무 얘기나 하자 ㅋㅋ");
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
  it("parses only the content-free target debug contract", () => {
    const parsed = parseChatResponse({
      id: "response-1",
      model: "observed-model",
      choices: [{ message: { content: "same reply" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      opod_debug: {
        events: [],
        prompt: {
          schemaVersion: 1,
          stablePromptSha256: "c".repeat(64),
          personaBlockCount: 3,
          canonCount: 1,
          contextSectionNames: ["current_moment", "persona_retrieved", "retrieved_memories"],
          retrievedMemoryCount: 2,
          personaProvenance: {
            schemaVersion: 1,
            policyVersion: 1,
            sources: [
              {
                id: "persona-lore-1",
                kind: "lore",
                injection: "retrieved",
                mapping: "explicit",
                destination: "turn_context",
                reason: "retrieved_for_turn",
                content: "must not cross from persona provenance",
              },
              {
                id: "persona-note-1",
                kind: "creator_note",
                injection: "never_prompt",
                mapping: "explicit",
                destination: "excluded",
                reason: "never_prompt",
              },
            ],
          },
          memoryProvenance: {
            status: "completed",
            reason: "retrieval_completed",
            sources: [
              {
                id: "mem-1",
                kind: "observation",
                rank: 1,
                score: 2.5,
                rawRelevance: 0.8,
                retrieval: "selected",
                retrievalReason: "selected_top_k",
                injected: true,
                injectionReason: "retrieved_memories_section",
                content: "must not cross the parser boundary either",
              },
              {
                id: "mem-2",
                kind: "reflection",
                rank: 2,
                score: 1.5,
                rawRelevance: 0.2,
                retrieval: "excluded",
                retrievalReason: "outside_top_k",
                injected: false,
                injectionReason: "not_retrieved",
              },
            ],
          },
          memoryPolicyVersion: 1,
          retrievalConfig: {
            topK: 6,
            weights: { recency: 1, importance: 1, relevance: 1 },
            recencyDecay: 0.99,
            summaryTurnThreshold: 8,
          },
          promptText: "must not cross the parser boundary",
        },
      },
    });

    expect(parsed.responseModel).toBe("observed-model");
    expect(parsed.promptDebug?.stablePromptSha256).toBe("c".repeat(64));
    expect(parsed.promptDebug?.memoryProvenance?.sources).toEqual([
      expect.objectContaining({ id: "mem-1", retrieval: "selected", injected: true }),
      expect.objectContaining({ id: "mem-2", retrieval: "excluded", injected: false }),
    ]);
    expect(parsed.promptDebug?.personaProvenance?.sources).toEqual([
      expect.objectContaining({
        id: "persona-lore-1",
        destination: "turn_context",
        reason: "retrieved_for_turn",
      }),
      expect.objectContaining({
        id: "persona-note-1",
        destination: "excluded",
        reason: "never_prompt",
      }),
    ]);
    expect(JSON.stringify(parsed.promptDebug)).not.toContain("must not cross");
    expect(() =>
      parseChatResponse({
        choices: [{ message: { content: "reply" } }],
        opod_debug: { prompt: { stablePromptSha256: "not-a-hash" } },
      }),
    ).toThrow("invalid prompt debug metadata");
    expect(() =>
      parseChatResponse({
        choices: [{ message: { content: "reply" } }],
        opod_debug: {
          prompt: {
            schemaVersion: 1,
            stablePromptSha256: "d".repeat(64),
            personaBlockCount: 1,
            canonCount: 0,
            contextSectionNames: ["current_moment"],
            retrievedMemoryCount: 0,
            memoryProvenance: {
              status: "completed",
              reason: "retrieval_completed",
              sources: [
                {
                  id: "mem-invalid",
                  kind: "observation",
                  rank: 1,
                  score: 1,
                  rawRelevance: 0.5,
                  retrieval: "selected",
                  retrievalReason: "outside_top_k",
                  injected: false,
                  injectionReason: "not_retrieved",
                },
              ],
            },
            memoryPolicyVersion: 1,
            retrievalConfig: {
              topK: 6,
              weights: { recency: 1, importance: 1, relevance: 1 },
              recencyDecay: 0.99,
              summaryTurnThreshold: 8,
            },
          },
        },
      }),
    ).toThrow("invalid memory provenance metadata");
  });

  it("loads all committed H30 fixtures", async () => {
    const loaded = await loadScenarioSuite(resolve("evals/cases/long-conversation.json"));
    expect(loaded.mode).toBe("h30");
    expect(loaded.scenarios).toHaveLength(8);
    expect(new Set(loaded.scenarios.map((item) => item.id))).toHaveProperty("size", 8);
  });

  it("loads the shared naturalness suite as diagnostic-only", async () => {
    const loaded = await loadScenarioSuite(
      resolve("evals/cases/character-naturalness-baseline.json"),
    );

    expect(loaded.mode).toBe("diagnostic");
    expect(loaded.scenarios).toHaveLength(8);
    const opening = loaded.scenarios.find((item) => item.id === "bare-opening-mutuality");
    const worldState = loaded.scenarios.find(
      (item) => item.id === "everyday-world-state-restraint",
    );
    expect(opening?.scriptedTurns.find((turn) => turn.turn === 4)).toMatchObject({
      message: "그냥 아무 얘기나 하자 ㅋㅋ",
      purpose: "invite low-stakes chat",
    });
    expect(JSON.stringify(opening)).not.toContain("심심");
    expect(worldState?.phases.map((phase) => phase.simulatorInstruction).join(" ")).toContain(
      "Do not echo, praise, or elaborate unsupported details",
    );
  });

  it("loads the shared memory-structure fixture with every lifecycle label", async () => {
    const loaded = await loadScenarioSuite(
      resolve("evals/cases/p1-memory-structure.json"),
    );
    const fixture = loaded.scenarios[0]?.memoryFixture;

    expect(loaded.mode).toBe("structure");
    expect(loaded.scenarios).toHaveLength(1);
    expect(fixture?.seedPolicy).toBe("baseline_unfiltered");
    expect(new Set(fixture?.records.map((record) => record.lifecycle))).toEqual(
      new Set(["active", "stale", "superseded", "forgotten"]),
    );
    expect(new Set(fixture?.currentStateRecords.map((record) => record.status))).toEqual(
      new Set(["active", "expired"]),
    );
    expect(fixture?.probes[0]?.turn).toBe(1);
  });

  it("loads the 22-annotation seed without promoting one posthoc reviewer to gold", async () => {
    const calibration = await loadNaturalnessCalibrationSet(
      resolve("evals/calibration/naturalness-human-seed-2026-09-02.json"),
    );

    expect(calibration.status).toBe("seed");
    expect(calibration.review).toMatchObject({
      reviewerCount: 1,
      blind: false,
      method: "posthoc",
    });
    expect(calibration.trajectoryVerdicts).toHaveLength(8);
    expect(calibration.annotations).toHaveLength(22);
    expect(
      calibration.trajectoryVerdicts.filter(
        (item) => item.automaticVerdict === "pass" && item.effectiveVerdict === "fail",
      ),
    ).toHaveLength(3);
    expect(
      calibration.trajectoryVerdicts.filter((item) => item.humanVerdict === "not-reviewed"),
    ).toHaveLength(1);
    expect(
      calibration.trajectoryVerdicts.every((item) => item.effectiveVerdict === "fail"),
    ).toBe(true);
    expect(calibration.annotations.find((item) => item.id === "human-022")).toMatchObject({
      assessment: "boundary",
      tags: ["register_fit"],
    });

    expect(
      NaturalnessCalibrationSetSchema.safeParse({
        ...calibration,
        status: "adjudicated",
      }).success,
    ).toBe(false);
  });

  it("requires a complete, unique multi-character runtime set", () => {
    const valid = CharacterSetSchema.safeParse({
      schemaVersion: 1,
      scope: {
        label: "synthetic-test-set",
        capturedAt: "2026-09-02T00:00:00.000Z",
        expectedCharacterCount: 2,
      },
      characters: [
        {
          key: "alpha",
          id: "character-alpha",
          name: "Alpha",
          personaVersion: "persona-alpha-v3",
          personaSummary: "Direct and dry, but considerate.",
          canon: [],
        },
        {
          key: "beta",
          id: "character-beta",
          name: "Beta",
          personaSummary: "Warm and playful without forcing questions.",
          canon: [],
        },
      ],
    });
    const incomplete = CharacterSetSchema.safeParse({
      schemaVersion: 1,
      scope: {
        label: "incomplete-test-set",
        capturedAt: "2026-09-02T00:00:00.000Z",
        expectedCharacterCount: 2,
      },
      characters: [
        {
          key: "alpha",
          id: "character-alpha",
          name: "Alpha",
          personaSummary: "Direct and dry, but considerate.",
          canon: [],
        },
      ],
    });
    const duplicate = CharacterSetSchema.safeParse({
      schemaVersion: 1,
      scope: {
        label: "duplicate-test-set",
        capturedAt: "2026-09-02T00:00:00.000Z",
        expectedCharacterCount: 2,
      },
      characters: [
        {
          key: "alpha",
          id: "character-alpha",
          name: "Alpha",
          personaSummary: "Direct and dry, but considerate.",
          canon: [],
        },
        {
          key: "alpha",
          id: "character-alpha-copy",
          name: "Alpha copy",
          personaSummary: "A duplicate key that must be rejected.",
          canon: [],
        },
      ],
    });

    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.characters[0]?.personaVersion).toBe("persona-alpha-v3");
    }
    expect(incomplete.success).toBe(false);
    expect(duplicate.success).toBe(false);
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

  it("validates memory fixtures and rejects probes that reference unknown records", () => {
    const memoryFixture = {
      schemaVersion: 1,
      seedPolicy: "baseline_unfiltered",
      asOf: "2026-09-07T00:00:00.000Z",
      records: [
        {
          id: "current-fact",
          content: "The user's current preferred drink is tea.",
          kind: "observation",
          importance: 10,
          lifecycle: "active",
        },
        {
          id: "old-fact",
          content: "The user's old preferred drink was coffee.",
          kind: "observation",
          importance: 9,
          lifecycle: "superseded",
          supersededBy: "current-fact",
        },
      ],
      currentStateRecords: [
        {
          id: "temporary-state",
          key: "availability",
          value: "busy until 18:00",
          status: "active",
          validFrom: "2026-09-07T00:00:00.000Z",
        },
      ],
      probes: [
        {
          turn: 1,
          description: "retrieve the current preference",
          expectedInjectedAny: ["current-fact"],
          expectedExcluded: ["old-fact"],
        },
      ],
    } as const;
    const valid = ScenarioSchema.safeParse({ ...scenario, memoryFixture });
    const unknownReference = ScenarioSchema.safeParse({
      ...scenario,
      memoryFixture: {
        ...memoryFixture,
        probes: [
          {
            ...memoryFixture.probes[0],
            expectedInjectedAny: ["missing-fact"],
          },
        ],
      },
    });

    expect(valid.success).toBe(true);
    if (valid.success) expect(valid.data.memoryFixture?.records).toHaveLength(2);
    expect(unknownReference.success).toBe(false);
    if (!unknownReference.success) {
      expect(unknownReference.error.message).toContain("unknown memory fixture record");
    }
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

  it("builds a content-free reproducibility manifest and rejects missing fingerprints", async () => {
    const result = await runTrajectory({
      scenario: h30Scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(),
      runId: "manifest-run",
      judgeReplicas: 2,
    });
    const suite = suiteOfEight();
    const completeResults = resultsForSuite(
      {
        ...result,
        character: { ...result.character, personaVersion: "persona-v7" },
      },
      suite,
    );
    const report = aggregateSuite(
      suite,
      "standard",
      completeResults,
      {
        suitePath: "/repo/evals/cases/long-conversation.json",
        suiteSha256: "d".repeat(64),
        gitSha: "e".repeat(40),
        gitDirty: true,
        dirtyPathHashes: { "src/example.ts": "f".repeat(64) },
      },
    );
    const manifest = createBaselineManifest(report, {
      runGroupId: "run-group-1",
      startedAt: "2026-09-02T00:00:00.000Z",
      baseSeed: 1729,
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      runGroupId: "run-group-1",
      targetKind: "in-process",
      candidateModel: "candidate-model",
      simulatorModel: "simulator-model",
      judgeModel: "judge-model",
      judgeReplicas: 2,
      observedResponseModel: "candidate-model-observed",
      gitHeadSha: "e".repeat(40),
      gitDirty: true,
      dirtyPathHashes: { "src/example.ts": "f".repeat(64) },
      suiteSha256: "d".repeat(64),
      profile: "standard",
      baseSeed: 1729,
      runCount: 8,
      fingerprintSource: "observed",
      calibrationStatus: "uncalibrated",
      comparison: { ready: true, reasons: [] },
      memoryPolicyVersion: 1,
      consolidationMode: "fake",
      perCharacter: [
        {
          characterId: "luna",
          publicKey: "luna",
          personaVersion: "persona-v7",
          stablePromptSha256: "a".repeat(64),
          personaBlockCount: 4,
          canonCount: 2,
          fingerprintSource: "observed",
        },
      ],
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(result.character.personaSummary);
    expect(serialized).not.toContain(result.character.canon[0] ?? "missing-canon");
    expect(serialized).not.toContain(result.transcript[0]?.user ?? "missing-user");
    expect(serialized).not.toContain(result.transcript[0]?.assistant ?? "missing-assistant");

    const missingFingerprint = aggregateSuite(
      suite,
      "standard",
      [
        { ...completeResults[0]!, promptFingerprint: undefined },
        ...completeResults.slice(1),
      ],
      report.provenance,
    );
    const incompleteManifest = createBaselineManifest(missingFingerprint, {
      runGroupId: "run-group-2",
      startedAt: "2026-09-02T00:00:00.000Z",
      baseSeed: 1729,
    });
    expect(incompleteManifest.fingerprintSource).toBe("unavailable");
    expect(incompleteManifest.comparison.ready).toBe(false);
    expect(incompleteManifest.comparison.reasons).toContain(
      "prompt fingerprint is missing or inconsistent",
    );

    const intentionallyUnjudged = aggregateSuite(
      suite,
      "standard",
      completeResults.map((value) => ({
        ...value,
        judge: null,
        judgment: undefined,
        certificationEligible: false,
      })),
      report.provenance,
    );
    const unjudgedManifest = createBaselineManifest(intentionallyUnjudged, {
      runGroupId: "run-group-3",
      startedAt: "2026-09-02T00:00:00.000Z",
      baseSeed: 1729,
    });
    expect(unjudgedManifest).toMatchObject({
      judgeModel: null,
      judgeReplicas: null,
      comparison: { ready: true, reasons: [] },
    });

    const missingCellReport = aggregateSuite(
      suite,
      "standard",
      completeResults.slice(1),
      report.provenance,
      { expectedCharacterKeys: ["luna"] },
    );
    const missingCellManifest = createBaselineManifest(missingCellReport, {
      runGroupId: "run-group-4",
      startedAt: "2026-09-02T00:00:00.000Z",
      baseSeed: 1729,
    });
    expect(missingCellManifest.completedCharacterKeys).toEqual([]);
    expect(missingCellManifest.missingCharacterScenarioCells).toEqual([
      "luna:h30-scenario-1",
    ]);
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

  it("never certifies diagnostics and requires every character-scenario cell", async () => {
    const h30Result = await runTrajectory({
      scenario: h30Scenario,
      target: new FakeTarget(),
      simulator: new FakeSimulator(),
      judge: new FakeJudge(DIAGNOSTIC_CRITERION_IDS),
      runId: "diagnostic-matrix-run",
      judgeReplicas: 2,
      evaluationMode: "diagnostic",
    });
    const suite = { ...suiteOfEight(), mode: "diagnostic" as const };
    const alpha = resultsForSuite(h30Result, suite).map((item) => ({
      ...item,
      character: { ...item.character, key: "alpha", id: "character-alpha" },
      identity: { ...item.identity, characterId: "character-alpha" },
    }));
    const beta = resultsForSuite(h30Result, suite).map((item) => ({
      ...item,
      runId: `${item.runId}-beta`,
      character: { ...item.character, key: "beta", id: "character-beta" },
      identity: { ...item.identity, characterId: "character-beta" },
    }));

    const complete = aggregateSuite(
      suite,
      "standard",
      [...alpha, ...beta],
      {},
      { expectedCharacterKeys: ["alpha", "beta"] },
    );
    const incomplete = aggregateSuite(
      suite,
      "standard",
      [...alpha, ...beta.slice(1)],
      {},
      { expectedCharacterKeys: ["alpha", "beta"] },
    );
    const oneCharacterFails = aggregateSuite(
      suite,
      "standard",
      [
        ...alpha,
        ...beta.map((item) => ({ ...item, score: 0, passed: false })),
      ],
      {},
      { expectedCharacterKeys: ["alpha", "beta"] },
    );
    const selectedScenarioIds = suite.scenarios.slice(0, 2).map((item) => item.id);
    const selectedMatrix = aggregateSuite(
      suite,
      "smoke",
      [...alpha.slice(0, 2), ...beta.slice(0, 2)],
      {},
      { expectedCharacterKeys: ["alpha", "beta"], expectedScenarioIds: selectedScenarioIds },
    );

    expect(h30Result.certificationEligible).toBe(false);
    expect(complete.certificationEligible).toBe(false);
    expect(complete.characterCoverage).toMatchObject({
      passed: true,
      expected: ["alpha", "beta"],
      missing: [],
    });
    expect(Object.keys(complete.characterStats).sort()).toEqual(["alpha", "beta"]);
    expect(incomplete.characterCoverage).toMatchObject({
      passed: false,
      missing: ["beta:h30-scenario-1"],
    });
    expect(oneCharacterFails.failingCharacterKeys).toEqual(["beta"]);
    expect(oneCharacterFails.qualityPassed).toBe(false);
    expect(selectedMatrix.characterCoverage).toMatchObject({
      passed: true,
      missing: [],
    });
    expect(selectedMatrix.certificationEligible).toBe(false);
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

function judgment(
  criticalFailures: Array<{ code: string; turn: number; evidence: string }> = [],
  extraCriterionIds: string[] = [],
) {
  const ids = [
    "persona_canon",
    "long_horizon_coherence",
    "natural_forward_motion",
    "emotional_calibration",
    "relevance_restraint",
    "dm_style",
    ...extraCriterionIds,
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
    mode: "h30",
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
