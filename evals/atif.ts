import type { SuiteReport, TrajectoryResult, TranscriptTurn } from "./evaluate.js";

/**
 * Harbor's Agent Trajectory Interchange Format (ATIF) v1.7. We keep this as a
 * plain JSON builder so the TypeScript runner does not need Harbor's Python
 * package merely to emit portable artifacts.
 */
export function toAtif(result: TrajectoryResult): Record<string, unknown> {
  const steps: Array<Record<string, unknown>> = [];
  let stepId = 0;
  for (const turn of result.transcript) {
    steps.push({
      step_id: ++stepId,
      timestamp: turn.at,
      source: "user",
      message: turn.user,
      extra: {
        user_turn: turn.turn,
        source: turn.userSource,
        simulator_intent: turn.simulatorIntent,
        history_offset: turn.historyOffset,
      },
    });
    steps.push(agentStep(++stepId, turn, result.target.model));
  }
  if (steps.length === 0) {
    // Harbor's ATIF v1.7 Trajectory requires at least one step. Preserve a
    // first-turn crash as explicit system evidence instead of emitting an
    // invalid empty trajectory and losing the original failure.
    steps.push({
      step_id: ++stepId,
      timestamp: result.finishedAt,
      source: "system",
      message: result.runtimeError
        ? `Trajectory failed before the first completed exchange: ${result.runtimeError}`
        : "Trajectory ended before the first completed exchange.",
      extra: { terminal_failure: true },
    });
  }
  const totals = result.transcript.reduce(
    (sum, turn) => ({
      prompt: sum.prompt + turn.usage.promptTokens,
      completion: sum.completion + turn.usage.completionTokens,
      total: sum.total + turn.usage.totalTokens,
    }),
    { prompt: 0, completion: 0, total: 0 },
  );

  return {
    schema_version: "ATIF-v1.7",
    trajectory_id: result.runId,
    session_id: result.identity.sessionId,
    agent: {
      name: "opod-agent",
      version: "0.1.0",
      model_name: result.target.model,
      extra: {
        target_kind: result.target.kind,
        request_config: result.target.requestConfig,
        runtime_config: result.target.runtimeConfig,
        character_id: result.identity.characterId,
        character_name: result.character.name,
        persona_summary: result.character.personaSummary,
        canon: result.character.canon,
        user_id: result.identity.userId,
      },
    },
    steps,
    final_metrics: {
      total_prompt_tokens: totals.prompt,
      total_completion_tokens: totals.completion,
      total_steps: steps.length,
    },
    extra: {
      scenario_id: result.scenarioId,
      scenario_version: result.scenarioVersion,
      requested_turns: result.requestedTurns,
      completed_turns: result.completedTurns,
      seed: result.seed,
      run_index: result.runIndex,
      estimated_horizon_minutes: result.estimatedHorizonMinutes,
      completed_estimated_minutes: result.completedEstimatedMinutes,
      score: result.score,
      passed: result.passed,
      certification_eligible: result.certificationEligible,
      deterministic_checks: result.deterministic.checks,
      judgment: result.judgment,
      simulator: result.simulator,
      runtime_error: result.runtimeError,
      total_tokens_reported_by_target: totals.total,
    },
  };
}

export function toHarborReward(report: SuiteReport): Record<string, number> {
  const evidenceComplete = report.trajectories.every(
    (result) => Boolean(result.judgment) && !result.runtimeError,
  );
  const scenarioStats = Object.values(report.scenarioStats);
  return {
    reward: evidenceComplete ? report.score : 0,
    passed: report.passed ? 1 : 0,
    certification_eligible: report.certificationEligible ? 1 : 0,
    pass_rate: report.passRate,
    mean_scenario_median: report.meanScenarioMedian,
    p10_score: report.p10Score,
    stability_passed: report.stabilityPassed ? 1 : 0,
    unstable_scenario_rate:
      scenarioStats.length > 0
        ? report.unstableScenarioIds.length / scenarioStats.length
        : 1,
    maximum_scenario_score_range:
      scenarioStats.length > 0
        ? Math.max(...scenarioStats.map((stats) => stats.scoreRange))
        : 1,
    critical_failure_rate:
      report.trajectories.length > 0
        ? report.criticalFailures / report.trajectories.length
        : 1,
  };
}

function agentStep(
  stepId: number,
  turn: TranscriptTurn,
  model: string,
): Record<string, unknown> {
  const calls = turn.toolEvents.filter((event) => event.type === "tool_call");
  const results = turn.toolEvents.filter((event) => event.type === "tool_result");
  const llmCallCount = turn.toolEvents.length
    ? Math.max(...turn.toolEvents.map((event) => event.iteration)) + 2
    : 1;
  return {
    step_id: stepId,
    timestamp: turn.at,
    source: "agent",
    model_name: model,
    message: turn.assistant,
    ...(calls.length
      ? {
          tool_calls: calls.map((event) => ({
            tool_call_id: event.callId,
            function_name: event.tool,
            arguments: parseArguments(event.args),
          })),
        }
      : {}),
    ...(results.length
      ? {
          observation: {
            results: results.map((event) => ({
              source_call_id: event.callId,
              content: event.result,
            })),
          },
        }
      : {}),
    metrics: {
      prompt_tokens: turn.usage.promptTokens,
      completion_tokens: turn.usage.completionTokens,
    },
    llm_call_count: llmCallCount,
    extra: {
      user_turn: turn.turn,
      latency_ms: turn.latencyMs,
      response_id: turn.responseId,
    },
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(raw);
    if (isRecord(decoded)) return decoded;
    return { raw };
  } catch {
    return { raw };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
