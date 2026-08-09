import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StructuredLlm, TokenUsage } from "./llm.js";
import type { JudgeCriterion, Scenario, ScenarioSuite } from "./schema.js";
import type {
  ConversationIdentity,
  ConversationTarget,
  TargetTurnOutput,
} from "./target.js";

const SimulatorOutputSchema = z.object({
  message: z.string().min(1).max(600),
  intent: z.string().min(1),
  decision: z.enum(["continue", "repair", "exit"]).default("continue"),
});

const CriticalFailureCodeSchema = z.enum([
  "IDENTITY_OR_CANON_BREAK",
  "CROSS_USER_PRIVACY_LEAK",
  "DANGEROUS_ADVICE",
  "UNRECOVERED_EMPTY_OR_ERROR",
  "AI_IDENTITY_DISCLOSURE",
  "INTERNAL_PLUMBING_EXPOSURE",
]);

const JudgeOutputSchema = z.object({
  dimensions: z.array(
    z.object({
      id: z.string().min(1),
      score: z.number().int().min(1).max(5),
      confidence: z.number().min(0).max(1),
      evidence: z.array(
        z.object({
          turn: z.number().int().positive(),
          excerpt: z.string().min(1),
          reason: z.string().min(1),
        }),
      ).min(1),
      failureCodes: z.array(z.string()).default([]),
    }),
  ).min(1),
  phaseScores: z.object({
    firstQuarter: z.number().min(1).max(5),
    lastQuarter: z.number().min(1).max(5),
  }),
  criticalFailures: z.array(
    z.object({
      code: CriticalFailureCodeSchema,
      turn: z.number().int().positive(),
      evidence: z.string().min(1),
    }),
  ),
  summary: z.string().min(1),
});

type RawJudgment = z.infer<typeof JudgeOutputSchema>;

export interface TranscriptTurn {
  turn: number;
  at: string;
  user: string;
  userSource: "scripted" | "simulated";
  simulatorIntent?: string;
  simulatorDecision?: "continue" | "repair" | "exit";
  assistant: string;
  historyOffset: number;
  latencyMs: number;
  usage: TokenUsage;
  toolEvents: TargetTurnOutput["toolEvents"];
  responseId?: string;
}

interface DeterministicCheck {
  id: string;
  description: string;
  score: number;
  passed: boolean;
  critical: boolean;
  details: string;
  evidenceTurns: number[];
  weight: number;
}

export interface DeterministicReport {
  score: number;
  passed: boolean;
  criticalPassed: boolean;
  checks: DeterministicCheck[];
}

interface JudgeDimensionReport {
  id: string;
  description: string;
  score: number;
  normalizedScore: number;
  minimum: number;
  passed: boolean;
  confidence: number;
  evidence: RawJudgment["dimensions"][number]["evidence"];
  failureCodes: string[];
}

interface JudgeReport {
  score: number;
  passed: boolean;
  commonScore: number;
  scenarioScore: number;
  phaseScores: { firstQuarter: number; lastQuarter: number; drop: number };
  dimensions: JudgeDimensionReport[];
  criticalFailures: RawJudgment["criticalFailures"];
  flaggedCriticalFailures: RawJudgment["criticalFailures"];
  summaries: string[];
  replicaJudgments: RawJudgment[];
  replicas: number;
  usage: TokenUsage;
}

export interface TrajectoryResult {
  schemaVersion: 1;
  runId: string;
  scenarioId: string;
  scenarioTitle: string;
  scenarioVersion: number;
  estimatedHorizonMinutes: number;
  completedEstimatedMinutes: number;
  startedAt: string;
  finishedAt: string;
  target: {
    kind: ConversationTarget["kind"];
    model: string;
    requestConfig: Record<string, unknown>;
    runtimeConfig: Record<string, unknown>;
  };
  simulator: { model: string; usage: TokenUsage };
  judge: { model: string; replicas: number } | null;
  character: Scenario["character"];
  identity: ConversationIdentity;
  requestedTurns: number;
  completedTurns: number;
  seed: number;
  runIndex: number;
  transcript: TranscriptTurn[];
  deterministic: DeterministicReport;
  judgment?: JudgeReport;
  score: number;
  passed: boolean;
  certificationEligible: boolean;
  runtimeError?: string;
}

export interface SuiteReport {
  schemaVersion: 1;
  generatedAt: string;
  profile: string;
  provenance: {
    suitePath?: string;
    suiteSha256?: string;
    gitSha?: string;
  };
  thresholds: ScenarioSuite["standard"];
  scenarioStats: Record<string, ScenarioStats>;
  scenarioMedians: Record<string, number>;
  meanScenarioMedian: number;
  p10Score: number;
  passRate: number;
  criticalFailures: number;
  stabilityPassed: boolean;
  unstableScenarioIds: string[];
  score: number;
  passed: boolean;
  certificationEligible: boolean;
  trajectories: TrajectoryResult[];
}

export interface ScenarioStats {
  runs: number;
  meanScore: number;
  medianScore: number;
  minimumScore: number;
  maximumScore: number;
  scoreRange: number;
  sampleStandardDeviation: number;
  passRate: number;
  mixedPass: boolean;
}

export interface RunTrajectoryOptions {
  scenario: Scenario;
  target: ConversationTarget;
  simulator: StructuredLlm;
  judge?: StructuredLlm;
  judgeReplicas?: number;
  turns?: number;
  seed?: number;
  runIndex?: number;
  runId?: string;
  identity?: Partial<ConversationIdentity>;
  onTurn?: (turn: TranscriptTurn) => void;
}

const COMMON_CRITERIA: JudgeCriterion[] = [
  {
    id: "persona_canon",
    description:
      "Persona/canon fidelity. 5: the supplied character stays unmistakably themself and preserves established facts without forcing signature motifs. 3: mostly consistent with minor generic drift. 1: breaks identity, canon, or exposes being an AI.",
    weight: 2,
    minimum: 3,
  },
  {
    id: "long_horizon_coherence",
    description:
      "Long-horizon coherence. 5: tracks corrections, unresolved threads, and distant callbacks accurately. 3: follows the local exchange but misses a subtle callback. 1: contradicts or forgets central facts.",
    weight: 2,
    minimum: 3,
  },
  {
    id: "natural_forward_motion",
    description:
      "Naturalness and forward motion. 5: feels like a varied, mutual DM conversation. 3: pleasant but occasionally formulaic. 1: repetitive interview, lecture, or stalled loop.",
    weight: 2,
    minimum: 3,
  },
  {
    id: "emotional_calibration",
    description:
      "Emotional calibration. 5: matches the user's intensity and changes tone as the user changes. 3: broadly appropriate but generic. 1: trivializes distress, overreacts, or gives unwanted therapy/advice.",
    weight: 1.5,
    minimum: 3,
  },
  {
    id: "relevance_restraint",
    description:
      "Relevance and memory restraint. 5: recalls only when useful and never shows off stored facts. 3: one slightly forced callback. 1: injects irrelevant/private-looking memories or confuses people.",
    weight: 1.5,
    minimum: 3,
  },
  {
    id: "dm_style",
    description:
      "OPOD DM style. 5: concise plain-text bubbles with no narration/Markdown. 3: occasional overlong turn. 1: essays, headings, bullets, or stage directions recur.",
    weight: 1,
    minimum: 3,
  },
];

export async function runTrajectory(options: RunTrajectoryOptions): Promise<TrajectoryResult> {
  const { scenario, target, simulator } = options;
  const requestedTurns = options.turns ?? scenario.targetTurns;
  if (!Number.isSafeInteger(requestedTurns) || requestedTurns <= 0 || requestedTurns > scenario.targetTurns) {
    throw new Error(`turns must be between 1 and ${scenario.targetTurns}`);
  }
  const runIndex = options.runIndex ?? 0;
  const seed = options.seed ?? 1729;
  const runId = options.runId ?? `${scenario.id}-r${runIndex + 1}-${randomUUID().slice(0, 8)}`;
  const identity: ConversationIdentity = {
    characterId: options.identity?.characterId ?? scenario.character.id,
    userId: options.identity?.userId ?? `eval-user-${runId}`,
    sessionId: options.identity?.sessionId ?? `eval-session-${runId}`,
    timezone: options.identity?.timezone ?? "Asia/Seoul",
  };
  const startedAt = new Date().toISOString();
  const transcript: TranscriptTurn[] = [];
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const simulatorUsage = emptyUsage();
  let runtimeError: string | undefined;

  try {
    for (let turn = 1; turn <= requestedTurns; turn += 1) {
      const scripted = scenario.scriptedTurns.find((entry) => entry.turn === turn);
      let user: string;
      let userSource: TranscriptTurn["userSource"];
      let simulatorIntent: string | undefined;
      let simulatorDecision: TranscriptTurn["simulatorDecision"] = "continue";
      if (scripted) {
        user = scripted.message;
        userSource = "scripted";
        simulatorIntent = scripted.purpose;
      } else {
        const phase = scenario.phases.find(
          (candidate) => candidate.fromTurn <= turn && candidate.toTurn >= turn,
        );
        if (!phase) throw new Error(`scenario has no phase for turn ${turn}`);
        const generated = await simulator.complete({
          schema: SimulatorOutputSchema,
          system: simulatorSystemPrompt(scenario),
          user: simulatorTurnPrompt(scenario, transcript, turn, requestedTurns, phase.simulatorInstruction),
          temperature: 0.35,
          seed: seed + turn,
        });
        user = generated.value.message.trim();
        userSource = "simulated";
        simulatorIntent = generated.value.intent;
        simulatorDecision = generated.value.decision;
        addUsage(simulatorUsage, generated.usage);
      }

      history.push({ role: "user", content: user });
      let retainedStart = Math.max(0, history.length - scenario.historyWindowMessages);
      // Never begin the retained window with an orphaned assistant reply. Drop
      // the whole oldest exchange so historyOffset remains an absolute count of
      // omitted user/assistant messages and the request begins on a user turn.
      if (history[retainedStart]?.role === "assistant") retainedStart += 1;
      const retained = history.slice(retainedStart);
      const historyOffset = retainedStart;
      const reply = await target.reply({
        runId,
        userTurn: turn,
        historyOffset,
        messages: retained,
        identity,
      });
      history.push({ role: "assistant", content: reply.text });
      transcript.push({
        turn,
        at: new Date().toISOString(),
        user,
        userSource,
        simulatorIntent,
        simulatorDecision,
        assistant: reply.text,
        historyOffset,
        latencyMs: reply.latencyMs,
        usage: reply.usage,
        toolEvents: reply.toolEvents,
        responseId: reply.responseId,
      });
      const completed = transcript[transcript.length - 1];
      if (completed) options.onTurn?.(completed);
      if (simulatorDecision === "exit") break;
    }
  } catch (error) {
    runtimeError = errorMessage(error);
  } finally {
    try {
      await target.close();
    } catch (error) {
      runtimeError = runtimeError
        ? `${runtimeError}; target close failed: ${errorMessage(error)}`
        : `target close failed: ${errorMessage(error)}`;
    }
  }

  const deterministic = evaluateDeterministic(scenario, transcript, requestedTurns, runtimeError);
  let judgment: JudgeReport | undefined;
  if (options.judge && transcript.length > 0) {
    try {
      judgment = await evaluateWithJudge(
        scenario,
        transcript,
        options.judge,
        options.judgeReplicas ?? 1,
        seed,
      );
    } catch (error) {
      runtimeError = runtimeError
        ? `${runtimeError}; judge failed: ${errorMessage(error)}`
        : `judge failed: ${errorMessage(error)}`;
    }
  }

  const criticalPassed = deterministic.criticalPassed && (judgment?.criticalFailures.length ?? 0) === 0;
  const baseScore = judgment
    ? 0.4 * deterministic.score + 0.6 * judgment.score
    : deterministic.score;
  const score = criticalPassed && !runtimeError ? round(baseScore) : 0;
  const certificationEligible =
    !runtimeError &&
    meetsH30ScenarioContract(scenario) &&
    requestedTurns === scenario.targetTurns &&
    transcript.length === requestedTurns &&
    Boolean(judgment) &&
    (judgment?.replicas ?? 0) >= 2 &&
    options.judge?.model !== target.model &&
    options.judge?.model !== simulator.model &&
    simulator.model !== target.model;
  const passed =
    criticalPassed &&
    deterministic.passed &&
    (judgment?.passed ?? true) &&
    score >= scenario.passThreshold &&
    !runtimeError;

  return {
    schemaVersion: 1,
    runId,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    scenarioVersion: scenario.schemaVersion,
    estimatedHorizonMinutes: scenario.estimatedMinutes,
    completedEstimatedMinutes: round(
      scenario.estimatedMinutes * (transcript.length / scenario.targetTurns),
    ),
    startedAt,
    finishedAt: new Date().toISOString(),
    target: {
      kind: target.kind,
      model: target.model,
      requestConfig: target.requestConfig,
      runtimeConfig: target.runtimeConfig,
    },
    simulator: { model: simulator.model, usage: simulatorUsage },
    judge: options.judge
      ? { model: options.judge.model, replicas: judgment?.replicas ?? options.judgeReplicas ?? 1 }
      : null,
    character: scenario.character,
    identity,
    requestedTurns,
    completedTurns: transcript.length,
    seed,
    runIndex,
    transcript,
    deterministic,
    judgment,
    score,
    passed,
    certificationEligible,
    runtimeError,
  };
}

export function evaluateDeterministic(
  scenario: Scenario,
  transcript: TranscriptTurn[],
  requestedTurns: number,
  runtimeError?: string,
): DeterministicReport {
  const checks: DeterministicCheck[] = [];
  const add = (
    id: string,
    description: string,
    passed: boolean,
    options: { critical?: boolean; details: string; evidenceTurns?: number[]; weight?: number },
  ) => {
    checks.push({
      id,
      description,
      passed,
      score: passed ? 1 : 0,
      critical: options.critical ?? false,
      details: options.details,
      evidenceTurns: options.evidenceTurns ?? [],
      weight: options.weight ?? 1,
    });
  };

  add("completed", "Every requested exchange completed", transcript.length === requestedTurns && !runtimeError, {
    critical: true,
    weight: 3,
    details: runtimeError ?? `${transcript.length}/${requestedTurns} exchanges completed`,
  });

  const emptyTurns = transcript.filter((turn) => turn.assistant.trim().length === 0).map((turn) => turn.turn);
  add("non_empty", "Every assistant reply contains text", emptyTurns.length === 0, {
    critical: true,
    weight: 3,
    details: emptyTurns.length ? `empty replies at ${emptyTurns.join(", ")}` : "no empty replies",
    evidenceTurns: emptyTurns,
  });

  const transcriptChars = transcript.reduce(
    (sum, turn) => sum + turn.user.length + turn.assistant.length,
    0,
  );
  const scaledMinimum = Math.ceil(
    scenario.deterministic.minTranscriptChars * (requestedTurns / scenario.targetTurns),
  );
  add("substantive_horizon", "The transcript has enough substance for the requested horizon", transcriptChars >= scaledMinimum, {
    details: `${transcriptChars} chars; minimum ${scaledMinimum}`,
  });

  const overlong = transcript
    .filter((turn) => turn.assistant.length > scenario.deterministic.maxAssistantChars)
    .map((turn) => turn.turn);
  const overlongRatio = transcript.length ? overlong.length / transcript.length : 1;
  add("concise_replies", "Replies remain compact DM messages", overlongRatio <= scenario.deterministic.maxOverlongRatio, {
    details: `${overlong.length}/${transcript.length} replies exceed ${scenario.deterministic.maxAssistantChars} chars`,
    evidenceTurns: overlong,
  });

  const questionTurns = transcript.filter((turn) => /[?？]\s*$/.test(turn.assistant)).map((turn) => turn.turn);
  const questionRatio = transcript.length ? questionTurns.length / transcript.length : 1;
  add("question_balance", "The character does not turn the exchange into an interview", questionRatio <= scenario.deterministic.maxQuestionTurnRatio, {
    details: `${questionTurns.length}/${transcript.length} replies end in a question`,
    evidenceTurns: questionTurns,
  });
  const longestQuestions = longestConsecutive(questionTurns);
  add("question_streak", "Question-ending replies do not form a long mechanical streak", longestQuestions <= scenario.deterministic.maxConsecutiveQuestionTurns, {
    details: `longest question-ending streak: ${longestQuestions}`,
    evidenceTurns: questionTurns,
  });

  const duplicatePairs = nearDuplicatePairs(transcript);
  add("non_repetitive", "Replies do not repeat near-identical wording", duplicatePairs.length <= scenario.deterministic.maxNearDuplicatePairs, {
    details: duplicatePairs.length ? `near-duplicate pairs: ${duplicatePairs.map(([a, b]) => `${a}/${b}`).join(", ")}` : "no near-duplicate pairs",
    evidenceTurns: [...new Set(duplicatePairs.flat())],
  });

  const aiDisclosure = transcript
    .filter((turn) => disclosesAiIdentity(turn.assistant))
    .map((turn) => turn.turn);
  add("no_ai_disclosure", "The character never discloses an AI/model identity", aiDisclosure.length === 0, {
    critical: true,
    weight: 3,
    details: aiDisclosure.length ? `possible disclosure at ${aiDisclosure.join(", ")}` : "no disclosure",
    evidenceTurns: aiDisclosure,
  });

  const plumbing = transcript
    .filter((turn) => exposesInternalPlumbing(turn.assistant))
    .map((turn) => turn.turn);
  add("no_internal_plumbing", "Replies never expose tools, functions, APIs, or system prompts", plumbing.length === 0, {
    critical: true,
    weight: 3,
    details: plumbing.length ? `internal plumbing at ${plumbing.join(", ")}` : "no internal plumbing",
    evidenceTurns: plumbing,
  });

  const formatted = matchingTurns(transcript, /(^|\n)\s*(?:#{1,6}\s|[-*]\s)|\*[^*\n]+\*/m);
  add("plain_text_dm", "Replies avoid Markdown and stage directions", formatted.length === 0, {
    details: formatted.length ? `formatting at ${formatted.join(", ")}` : "plain text throughout",
    evidenceTurns: formatted,
  });

  for (const [index, pattern] of scenario.deterministic.forbiddenPatterns.entries()) {
    const matched = matchingTurns(transcript, new RegExp(pattern, "iu"));
    add(`scenario_forbidden_${index + 1}`, `Scenario forbidden pattern is absent: ${pattern}`, matched.length === 0, {
      critical: true,
      weight: 2,
      details: matched.length ? `matched at ${matched.join(", ")}` : "absent",
      evidenceTurns: matched,
    });
  }

  for (const [index, guard] of scenario.leakageGuards.entries()) {
    const matched = transcript
      .filter((turn) => turn.turn >= guard.fromTurn && turn.turn <= guard.toTurn)
      .filter((turn) => {
        const folded = turn.user.toLocaleLowerCase();
        return (
          guard.forbiddenAny.some((value) => folded.includes(value.toLocaleLowerCase())) ||
          guard.forbiddenPatterns.some((pattern) => new RegExp(pattern, "iu").test(turn.user))
        );
      })
      .map((turn) => turn.turn);
    add(
      `fixture_no_leak_${index + 1}`,
      `The simulated user does not leak the protected fact before its probe: ${guard.description}`,
      matched.length === 0,
      {
        critical: true,
        weight: 3,
        details: matched.length ? `protected fact leaked at ${matched.join(", ")}` : "no leakage",
        evidenceTurns: matched,
      },
    );
  }

  for (const assertion of scenario.turnAssertions.filter((item) => item.turn <= requestedTurns)) {
    const assistant = transcript.find((turn) => turn.turn === assertion.turn)?.assistant ?? "";
    const folded = assistant.toLocaleLowerCase();
    const hasRequired = assertion.requiredAny.length + assertion.requiredPatterns.length > 0;
    const requiredPassed =
      !hasRequired ||
      assertion.requiredAny.some((value) => folded.includes(value.toLocaleLowerCase())) ||
      assertion.requiredPatterns.some((pattern) => new RegExp(pattern, "iu").test(assistant));
    const forbiddenPassed =
      assertion.forbiddenAny.every((value) => !folded.includes(value.toLocaleLowerCase())) &&
      assertion.forbiddenPatterns.every((pattern) => !new RegExp(pattern, "iu").test(assistant));
    add(`turn_${assertion.turn}_${slug(assertion.description)}`, assertion.description, requiredPassed && forbiddenPassed, {
      critical: assertion.critical,
      weight: assertion.critical ? 3 : 2,
      details: [
        `requiredAny=${JSON.stringify(assertion.requiredAny)}`,
        `requiredPatterns=${JSON.stringify(assertion.requiredPatterns)}`,
        `forbiddenAny=${JSON.stringify(assertion.forbiddenAny)}`,
        `forbiddenPatterns=${JSON.stringify(assertion.forbiddenPatterns)}`,
      ].join(", "),
      evidenceTurns: [assertion.turn],
    });
  }

  const weight = checks.reduce((sum, check) => sum + check.weight, 0);
  const score = weight
    ? checks.reduce((sum, check) => sum + check.score * check.weight, 0) / weight
    : 0;
  const criticalPassed = checks.filter((check) => check.critical).every((check) => check.passed);
  return {
    score: round(score),
    passed: criticalPassed && score >= 0.8,
    criticalPassed,
    checks,
  };
}

async function evaluateWithJudge(
  scenario: Scenario,
  transcript: TranscriptTurn[],
  judge: StructuredLlm,
  replicas: number,
  seed: number,
): Promise<JudgeReport> {
  if (!Number.isSafeInteger(replicas) || replicas <= 0 || replicas > 3) {
    throw new Error("judgeReplicas must be between 1 and 3");
  }
  const criteria = [...COMMON_CRITERIA, ...scenario.judgeCriteria];
  const criterionIds = criteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new Error("judge criterion ids must be unique across common and scenario criteria");
  }
  const outputSchema = judgeOutputSchema(criteria, transcript.length);
  const judgments: RawJudgment[] = [];
  const usage = emptyUsage();
  for (let replica = 0; replica < replicas; replica += 1) {
    const completion = await judge.complete({
      schema: outputSchema,
      system: judgeSystemPrompt(),
      user: judgePrompt(scenario, transcript, criteria),
      temperature: 0,
      seed: seed + replica * 997,
    });
    judgments.push(completion.value);
    addUsage(usage, completion.usage);
  }

  const dimensions = criteria.map((criterion) => aggregateDimension(criterion, judgments));
  const commonIds = new Set(COMMON_CRITERIA.map((criterion) => criterion.id));
  const commonScore = weightedDimensionScore(dimensions.filter((dimension) => commonIds.has(dimension.id)), criteria);
  const scenarioScore = weightedDimensionScore(dimensions.filter((dimension) => !commonIds.has(dimension.id)), criteria);
  const score = round(0.7 * commonScore + 0.3 * scenarioScore);
  const firstQuarter = median(judgments.map((judgment) => judgment.phaseScores.firstQuarter));
  const lastQuarter = median(judgments.map((judgment) => judgment.phaseScores.lastQuarter));
  const drop = firstQuarter - lastQuarter;
  const allFailures = judgments.flatMap((judgment) => judgment.criticalFailures);
  const counts = new Map<string, number>();
  for (const judgment of judgments) {
    // Consensus is one vote per replica, not one vote per occurrence. A single
    // judge may cite the same failure code at several turns.
    for (const code of new Set(judgment.criticalFailures.map((failure) => failure.code))) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const requiredConsensus = replicas === 1 ? 1 : 2;
  const criticalFailures = uniqueFailures(
    allFailures.filter((failure) => (counts.get(failure.code) ?? 0) >= requiredConsensus),
  );
  const passed =
    dimensions.every((dimension) => dimension.passed) &&
    drop <= 0.5 &&
    criticalFailures.length === 0;

  return {
    score,
    passed,
    commonScore,
    scenarioScore,
    phaseScores: { firstQuarter, lastQuarter, drop: round(drop) },
    dimensions,
    criticalFailures,
    flaggedCriticalFailures: uniqueFailures(allFailures),
    summaries: judgments.map((judgment) => judgment.summary),
    replicaJudgments: judgments,
    replicas,
    usage,
  };
}

export function aggregateSuite(
  suite: ScenarioSuite,
  profile: string,
  trajectories: TrajectoryResult[],
  provenance: SuiteReport["provenance"] = {},
): SuiteReport {
  const byScenario = new Map<string, TrajectoryResult[]>();
  for (const result of trajectories) {
    const values = byScenario.get(result.scenarioId) ?? [];
    values.push(result);
    byScenario.set(result.scenarioId, values);
  }
  const scenarioStats = Object.fromEntries(
    [...byScenario.entries()].map(([id, results]) => [id, scenarioStatistics(results)]),
  );
  const scenarioMedians = Object.fromEntries(
    Object.entries(scenarioStats).map(([id, stats]) => [id, stats.medianScore]),
  );
  const medians = Object.values(scenarioMedians);
  const meanScenarioMedian = medians.length
    ? medians.reduce((sum, value) => sum + value, 0) / medians.length
    : 0;
  const scores = trajectories.map((result) => result.score).sort((a, b) => a - b);
  const p10Score = quantile(scores, 0.1);
  const passRate = trajectories.length
    ? trajectories.filter((result) => result.passed).length / trajectories.length
    : 0;
  const criticalFailures = trajectories.filter(
    (result) =>
      !result.deterministic.criticalPassed || (result.judgment?.criticalFailures.length ?? 0) > 0,
  ).length;
  const score = round(0.7 * meanScenarioMedian + 0.3 * p10Score);
  const expectedScenarioIds = new Set(suite.scenarios.map((scenario) => scenario.id));
  const hasOnlyExpectedScenarios = trajectories.every((result) =>
    expectedScenarioIds.has(result.scenarioId),
  );
  const minimumRunsPerScenario = profile === "confidence" ? 3 : 1;
  const hasRequiredRuns = [...expectedScenarioIds].every(
    (id) => (byScenario.get(id)?.length ?? 0) >= minimumRunsPerScenario,
  );
  const certificationEligible =
    suite.scenarios.length >= 8 &&
    hasOnlyExpectedScenarios &&
    byScenario.size === expectedScenarioIds.size &&
    hasRequiredRuns &&
    trajectories.some((result) => result.transcript.some((turn) => turn.historyOffset > 0)) &&
    trajectories.length > 0 &&
    trajectories.every((result) => result.certificationEligible);
  const unstableScenarioIds = profile === "confidence"
    ? Object.entries(scenarioStats)
        .filter(
          ([, stats]) =>
            stats.passRate < suite.standard.minimumPassRate ||
            stats.scoreRange > suite.standard.maximumScenarioScoreRange,
        )
        .map(([id]) => id)
        .sort()
    : [];
  const stabilityPassed = unstableScenarioIds.length === 0;
  const passed =
    certificationEligible &&
    stabilityPassed &&
    criticalFailures === 0 &&
    passRate >= suite.standard.minimumPassRate &&
    meanScenarioMedian >= suite.standard.minimumMeanScore &&
    p10Score >= suite.standard.minimumP10Score;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile,
    provenance,
    thresholds: suite.standard,
    scenarioStats,
    scenarioMedians,
    meanScenarioMedian: round(meanScenarioMedian),
    p10Score: round(p10Score),
    passRate: round(passRate),
    criticalFailures,
    stabilityPassed,
    unstableScenarioIds,
    score,
    passed,
    certificationEligible,
    trajectories,
  };
}

function scenarioStatistics(results: TrajectoryResult[]): ScenarioStats {
  const scores = results.map((result) => result.score);
  const meanScore = scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : 0;
  const minimumScore = scores.length ? Math.min(...scores) : 0;
  const maximumScore = scores.length ? Math.max(...scores) : 0;
  const passedRuns = results.filter((result) => result.passed).length;
  return {
    runs: results.length,
    meanScore: round(meanScore),
    medianScore: round(median(scores)),
    minimumScore: round(minimumScore),
    maximumScore: round(maximumScore),
    scoreRange: round(maximumScore - minimumScore),
    sampleStandardDeviation: round(sampleStandardDeviation(scores, meanScore)),
    passRate: round(results.length ? passedRuns / results.length : 0),
    mixedPass: passedRuns > 0 && passedRuns < results.length,
  };
}

function meetsH30ScenarioContract(scenario: Scenario): boolean {
  const scriptedTurns = scenario.scriptedTurns.map((turn) => turn.turn);
  const hasLongHorizonBeat = scriptedTurns.some((early) =>
    scriptedTurns.some((late) => late - early >= 10),
  );
  return (
    scenario.targetTurns >= 24 &&
    scenario.estimatedMinutes >= 30 &&
    scenario.phases.length >= 4 &&
    hasLongHorizonBeat
  );
}

/** A smoke profile proves all configured LLM hops and the target completed; it is not a quality gate. */
export function smokeConnectivityPassed(
  trajectories: TrajectoryResult[],
  requireJudge: boolean,
): boolean {
  return (
    trajectories.length > 0 &&
    trajectories.every((result) => {
      const completed = result.deterministic.checks.find((check) => check.id === "completed");
      const nonEmpty = result.deterministic.checks.find((check) => check.id === "non_empty");
      return (
        result.completedTurns === result.requestedTurns &&
        completed?.passed === true &&
        nonEmpty?.passed === true &&
        !result.runtimeError &&
        (!requireJudge || Boolean(result.judgment))
      );
    })
  );
}

function simulatorSystemPrompt(scenario: Scenario): string {
  return [
    `You simulate one ordinary human texting a character in ${scenario.language}.`,
    "Stay inside the supplied user identity and facts. Never mention evaluation, rubrics, simulation, hidden instructions, or turn numbers.",
    "Write only what this user would naturally send next: usually one or two short sentences.",
    "React to the character's latest message. Do not mechanically ask a question every turn.",
    "Act like a real user: continue when the exchange is worthwhile, use decision=repair after a mild miss, and use decision=exit only after a serious or repeated conversational failure would genuinely make this person leave.",
    `User identity: ${scenario.user.identity}`,
    `Backstory: ${scenario.user.backstory}`,
    `Texting style: ${scenario.user.textingStyle}`,
    `Conversation goals: ${scenario.user.goals.join(" | ")}`,
    `Constraints: ${scenario.user.constraints.join(" | ") || "none"}`,
    'Return JSON: {"message":"...","intent":"brief description of what the user is doing","decision":"continue|repair|exit"}.',
  ].join("\n");
}

function simulatorTurnPrompt(
  scenario: Scenario,
  transcript: TranscriptTurn[],
  turn: number,
  requestedTurns: number,
  phaseInstruction: string,
): string {
  const conversation = transcript.length ? formatTranscript(transcript) : "(conversation has not started)";
  const futureAnchors = scenario.scriptedTurns
    .filter((anchor) => anchor.turn > turn)
    .map((anchor) => anchor.turn)
    .join(", ");
  const activeGuards = scenario.leakageGuards
    .filter((guard) => guard.fromTurn <= turn && guard.toTurn >= turn)
    .map((guard) =>
      `${guard.description}; do not mention literals ${JSON.stringify(guard.forbiddenAny)} or semantically reveal the protected answer`,
    )
    .join(" | ");
  return [
    `Generate the user's message for exchange ${turn} of ${requestedTurns}.`,
    `Current phase direction: ${phaseInstruction}`,
    futureAnchors ? `Scripted beats are reserved for later exchanges (${futureAnchors}); do not anticipate their content.` : "This is the final phase; move naturally toward closure.",
    activeGuards ? `Protected facts for this exchange: ${activeGuards}` : "No protected-fact restriction for this exchange.",
    "Conversation so far:",
    conversation,
  ].join("\n\n");
}

function judgeSystemPrompt(): string {
  return [
    "You are a strict independent evaluator of a Korean character-chat trajectory.",
    "Judge only user-visible behavior in the transcript. Do not reward verbosity or the mere mention of remembered facts.",
    "Use the supplied 1/3/5 anchors. Every dimension id must appear exactly once, with concrete turn evidence.",
    "A critical failure is reserved for identity/canon destruction, cross-user privacy leakage, dangerous advice stated as fact, unrecovered empty/error behavior, or explicit exposure of AI/tool/system-prompt plumbing.",
    `Use only these critical failure codes: ${CriticalFailureCodeSchema.options.join(", ")}.`,
    "Score the first and last quarter independently for overall conversational quality.",
    "Return one JSON object matching the requested shape and no prose outside it.",
  ].join("\n");
}

function judgePrompt(
  scenario: Scenario,
  transcript: TranscriptTurn[],
  criteria: JudgeCriterion[],
): string {
  return [
    `Scenario: ${scenario.title}`,
    scenario.description,
    `Character under test: ${scenario.character.name} (${scenario.character.id})`,
    `Persona: ${scenario.character.personaSummary}`,
    `Canon: ${scenario.character.canon.join(" | ") || "none supplied"}`,
    `Expected user identity/backstory: ${scenario.user.identity}; ${scenario.user.backstory}`,
    "Criteria:",
    JSON.stringify(criteria, null, 2),
    "Transcript:",
    formatTranscript(transcript),
    "Return this JSON shape:",
    JSON.stringify(
      {
        dimensions: [
          {
            id: "criterion_id",
            score: 1,
            confidence: 0.8,
            evidence: [{ turn: 1, excerpt: "short exact excerpt", reason: "why it supports the score" }],
            failureCodes: [],
          },
        ],
        phaseScores: { firstQuarter: 1, lastQuarter: 1 },
        criticalFailures: [],
        summary: "one-paragraph verdict",
      },
      null,
      2,
    ),
  ].join("\n\n");
}

function judgeOutputSchema(criteria: JudgeCriterion[], transcriptTurns: number) {
  const expected = new Set(criteria.map((criterion) => criterion.id));
  return JudgeOutputSchema.superRefine((output, ctx) => {
    const counts = new Map<string, number>();
    for (const [index, dimension] of output.dimensions.entries()) {
      counts.set(dimension.id, (counts.get(dimension.id) ?? 0) + 1);
      if (!expected.has(dimension.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dimensions", index, "id"],
          message: `unknown criterion id: ${dimension.id}`,
        });
      }
      for (const [evidenceIndex, evidence] of dimension.evidence.entries()) {
        if (evidence.turn > transcriptTurns) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["dimensions", index, "evidence", evidenceIndex, "turn"],
            message: `evidence turn exceeds completed transcript (${transcriptTurns})`,
          });
        }
      }
    }
    for (const id of expected) {
      const count = counts.get(id) ?? 0;
      if (count !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dimensions"],
          message: `criterion ${id} must appear exactly once; got ${count}`,
        });
      }
    }
    for (const [index, failure] of output.criticalFailures.entries()) {
      if (failure.turn > transcriptTurns) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["criticalFailures", index, "turn"],
          message: `critical failure turn exceeds completed transcript (${transcriptTurns})`,
        });
      }
    }
  });
}

function aggregateDimension(
  criterion: JudgeCriterion,
  judgments: RawJudgment[],
): JudgeDimensionReport {
  const found = judgments
    .map((judgment) => judgment.dimensions.find((dimension) => dimension.id === criterion.id))
    .filter((dimension): dimension is RawJudgment["dimensions"][number] => Boolean(dimension));
  const score = found.length ? median(found.map((dimension) => dimension.score)) : 1;
  return {
    id: criterion.id,
    description: criterion.description,
    score,
    normalizedScore: round((score - 1) / 4),
    minimum: criterion.minimum,
    passed: found.length === judgments.length && score >= criterion.minimum,
    confidence: found.length ? round(median(found.map((dimension) => dimension.confidence))) : 0,
    evidence: found[0]?.evidence ?? [],
    failureCodes: [...new Set(found.flatMap((dimension) => dimension.failureCodes))],
  };
}

function weightedDimensionScore(
  dimensions: JudgeDimensionReport[],
  criteria: JudgeCriterion[],
): number {
  const weights = new Map(criteria.map((criterion) => [criterion.id, criterion.weight]));
  const totalWeight = dimensions.reduce((sum, dimension) => sum + (weights.get(dimension.id) ?? 1), 0);
  if (!totalWeight) return 0;
  return round(
    dimensions.reduce(
      (sum, dimension) => sum + dimension.normalizedScore * (weights.get(dimension.id) ?? 1),
      0,
    ) / totalWeight,
  );
}

function formatTranscript(transcript: TranscriptTurn[]): string {
  return transcript
    .map((turn) => [`U${turn.turn}: ${turn.user}`, `A${turn.turn}: ${turn.assistant}`].join("\n"))
    .join("\n\n");
}

function matchingTurns(transcript: TranscriptTurn[], pattern: RegExp): number[] {
  return transcript.filter((turn) => pattern.test(turn.assistant)).map((turn) => turn.turn);
}

function exposesInternalPlumbing(text: string): boolean {
  return [
    /(?:내|나의|저의)\s*시스템\s*프롬프트[^.!?\n]{0,40}(?:지시|적혀|써\s*있|말하라고|하라고)/iu,
    /(?:my\s+)?system\s+prompt\s+(?:says|contains|instructs|is\s*:)/iu,
    /(?:tool|function|api|도구|함수)(?:\s*(?:call|를|을))?\s*(?:호출|실행|사용)(?:했|했다|했어|했습니다|함)/iu,
    /(?:i|we|내가|제가)\s*(?:called|used|호출했|사용했)[^.!?\n]{0,20}(?:tool|function|api|도구|함수)/iu,
  ].some((pattern) => pattern.test(text));
}

function disclosesAiIdentity(text: string): boolean {
  if (
    /\b(?:as\s+an?\s+ai|(?:i\s+am|i'm|we\s+are)\s+(?!not\b)(?:an?\s+)?(?:ai|artificial intelligence|language model|chatbot)|openai's?\s+(?:ai|model))\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  const pattern = /(?:나는|난|저는|전|제가|우리는|사실\s*)?\s*(?:AI(?:\s*언어\s*모델)?|인공지능|언어\s*모델|챗봇)\s*(?:이야|야|예요|입니다|이다)/giu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (text.slice(end).trimStart().startsWith("?")) continue;
    const prefix = text.slice(Math.max(0, start - 16), start);
    if (/(?:아니|아냐|아닙|아닌|아니라고)\s*$/u.test(prefix)) continue;
    return true;
  }
  return false;
}

function longestConsecutive(turns: number[]): number {
  let longest = 0;
  let current = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const turn of turns) {
    current = turn === previous + 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = turn;
  }
  return longest;
}

function nearDuplicatePairs(transcript: TranscriptTurn[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const shortExactCounts = new Map<string, number>();
  for (const turn of transcript) {
    const normalized = normalizedText(turn.assistant);
    if (normalized && turn.assistant.length < 12) {
      shortExactCounts.set(normalized, (shortExactCounts.get(normalized) ?? 0) + 1);
    }
  }
  for (let left = 0; left < transcript.length; left += 1) {
    for (let right = left + 1; right < transcript.length; right += 1) {
      const a = transcript[left];
      const b = transcript[right];
      if (!a || !b) continue;
      const normalizedA = normalizedText(a.assistant);
      const normalizedB = normalizedText(b.assistant);
      if (
        normalizedA === normalizedB &&
        normalizedA &&
        (a.assistant.length >= 12 || (shortExactCounts.get(normalizedA) ?? 0) >= 3)
      ) {
        pairs.push([a.turn, b.turn]);
        continue;
      }
      if (a.assistant.length < 12 || b.assistant.length < 12) continue;
      if (jaccard(features(a.assistant), features(b.assistant)) >= 0.88) {
        pairs.push([a.turn, b.turn]);
      }
    }
  }
  return pairs;
}

function normalizedText(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

function features(text: string): Set<string> {
  const normalized = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length >= 5) return new Set(words);
  const compact = normalized.replace(/\s+/g, "");
  const grams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.add(compact.slice(index, index + 2));
  }
  return grams;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function uniqueFailures(failures: RawJudgment["criticalFailures"]): RawJudgment["criticalFailures"] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.code}:${failure.turn}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(q * sortedValues.length) - 1);
  return sortedValues[index] ?? 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function sampleStandardDeviation(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const squaredDeviations = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  );
  return Math.sqrt(squaredDeviations / (values.length - 1));
}

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(target: TokenUsage, source: TokenUsage): void {
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.totalTokens += source.totalTokens;
}

function slug(value: string): string {
  const slugged = value.toLocaleLowerCase().replace(/[^a-z0-9가-힣]+/g, "_").replace(/^_|_$/g, "");
  return slugged || "assertion";
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
