import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toAtif, toHarborReward } from "./atif.js";
import {
  aggregateSuite,
  runTrajectory,
  smokeConnectivityPassed,
  type TrajectoryResult,
} from "./evaluate.js";
import { OpenAiStructuredLlm, structuredLlmConfig } from "./llm.js";
import { loadScenarioSuite, type Scenario } from "./schema.js";
import { createConversationTarget } from "./target.js";

type ProfileName = "smoke" | "standard" | "confidence";

interface Profile {
  name: ProfileName;
  runs: number;
  concurrency: number;
  judgeReplicas: number;
  smokeTurns?: number;
  smokeCases?: number;
}

interface WorkItem {
  scenario: Scenario;
  runIndex: number;
}

const parsed = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    profile: { type: "string" },
    suite: { type: "string" },
    cases: { type: "string" },
    turns: { type: "string" },
    runs: { type: "string" },
    concurrency: { type: "string" },
    output: { type: "string" },
    "reward-file": { type: "string" },
    "judge-replicas": { type: "string" },
    "skip-judge": { type: "boolean" },
    seed: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (parsed.values.help) {
  printHelp();
} else {
  await main();
}

async function main(): Promise<void> {
  const command = parsed.positionals[0] ?? "validate";
  const suitePath = resolve(
    parsed.values.suite ?? "evals/cases/long-conversation.json",
  );
  const suiteBytes = await readFile(suitePath);
  const suite = await loadScenarioSuite(suitePath);
  if (command === "validate") {
    console.log(`Validated ${suite.scenarios.length} long-conversation scenarios in ${suitePath}`);
    return;
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);

  const profile = resolveProfile(parsed.values.profile);
  const selected = selectScenarios(suite.scenarios, parsed.values.cases, profile);
  const runs = parsed.values.runs ? positiveInteger(parsed.values.runs, "runs") : profile.runs;
  const concurrency = parsed.values.concurrency
    ? positiveInteger(parsed.values.concurrency, "concurrency")
    : profile.concurrency;
  const turnsOverride = parsed.values.turns
    ? positiveInteger(parsed.values.turns, "turns")
    : profile.smokeTurns;
  const judgeReplicas = parsed.values["judge-replicas"]
    ? positiveInteger(parsed.values["judge-replicas"], "judge-replicas")
    : numberFromEnv("EVAL_JUDGE_REPLICAS", profile.judgeReplicas);
  const seed = parsed.values.seed ? positiveInteger(parsed.values.seed, "seed") : numberFromEnv("EVAL_SEED", 1729);
  const skipJudge = parsed.values["skip-judge"] || process.env.EVAL_SKIP_JUDGE === "true";
  const outputDir = resolve(
    parsed.values.output ??
      process.env.EVAL_RESULTS_DIR ??
      `evals/results/${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );

  const simulator = new OpenAiStructuredLlm(structuredLlmConfig("simulator"));
  const judge = skipJudge
    ? undefined
    : new OpenAiStructuredLlm(structuredLlmConfig("judge"));
  if (!judge) console.warn("Judge disabled: this run cannot certify H30 readiness.");
  const candidateModel = process.env.EVAL_TARGET_MODEL || process.env.LLM_MODEL || "gpt-4o-mini";
  console.log(
    `Models: candidate=${candidateModel} simulator=${simulator.model} judge=${judge?.model ?? "disabled"}`,
  );
  if (judge && new Set([candidateModel, simulator.model, judge.model]).size < 3) {
    console.warn(
      `Candidate (${candidateModel}), simulator (${simulator.model}), and judge (${judge.model}) must be three distinct models for release certification.`,
    );
  }

  await mkdir(outputDir, { recursive: true });
  const work: WorkItem[] = selected.flatMap((scenario) =>
    Array.from({ length: runs }, (_, runIndex) => ({ scenario, runIndex })),
  );
  console.log(
    `Running ${work.length} trajectories (${selected.length} scenarios × ${runs} run(s), concurrency ${concurrency})`,
  );

  const trajectories = await mapLimit(work, concurrency, async ({ scenario, runIndex }) => {
    const target = createConversationTarget();
    const requestedTurns = Math.min(turnsOverride ?? scenario.targetTurns, scenario.targetTurns);
    console.log(`[${scenario.id} r${runIndex + 1}] start: ${requestedTurns} exchanges on ${target.kind}`);
    const result = await runTrajectory({
      scenario,
      runIndex,
      turns: requestedTurns,
      seed: seed + runIndex * 10_000,
      target,
      simulator,
      judge,
      judgeReplicas,
      onTurn: (turn) =>
        console.log(
          `[${scenario.id} r${runIndex + 1}] ${turn.turn}/${requestedTurns} ${Math.round(turn.latencyMs)}ms`,
        ),
    });
    await writeTrajectoryArtifacts(outputDir, result);
    const outcome = profile.name === "smoke"
      ? smokeConnectivityPassed([result], Boolean(judge))
        ? "CONNECTED"
        : "CONNECTIVITY-FAIL"
      : result.passed
        ? "PASS"
        : "FAIL";
    console.log(
      `[${scenario.id} r${runIndex + 1}] ${outcome} score=${result.score.toFixed(3)}`,
    );
    return result;
  });

  const report = aggregateSuite(suite, profile.name, trajectories, {
    suitePath,
    suiteSha256: createHash("sha256").update(suiteBytes).digest("hex"),
    gitSha: process.env.EVAL_GIT_SHA || process.env.GITHUB_SHA,
  });
  await writeJson(resolve(outputDir, "suite-report.json"), report);
  await writeJson(resolve(outputDir, "harbor-reward.json"), toHarborReward(report));

  // RewardKit accepts one ATIF trajectory path. Preserve every run under its own
  // directory and expose the lowest-scoring run at the conventional root path so
  // an optional Harbor judge inspects the suite's weakest evidence, not its best.
  const weakest = [...trajectories].sort((left, right) => left.score - right.score)[0];
  if (weakest) await writeJson(resolve(outputDir, "trajectory.json"), toAtif(weakest));
  if (parsed.values["reward-file"]) {
    await writeJson(resolve(parsed.values["reward-file"]), toHarborReward(report));
  }

  const smokePassed = smokeConnectivityPassed(trajectories, Boolean(judge));
  if (profile.name === "smoke") {
    console.log(
      `Smoke connectivity ${smokePassed ? "PASS" : "FAIL"}; H30 certification was not evaluated.`,
    );
  } else {
    const maximumScenarioScoreRange = Math.max(
      0,
      ...Object.values(report.scenarioStats).map((stats) => stats.scoreRange),
    );
    console.log(
      `Suite ${report.passed ? "PASS" : "FAIL"}: score=${report.score.toFixed(3)} passRate=${report.passRate.toFixed(3)} p10=${report.p10Score.toFixed(3)} stability=${report.stabilityPassed ? "PASS" : "FAIL"} maxRange=${maximumScenarioScoreRange.toFixed(3)} unstable=${report.unstableScenarioIds.join(",") || "none"}`,
    );
  }
  console.log(`Artifacts: ${outputDir}`);

  process.exitCode = profile.name === "smoke" ? (smokePassed ? 0 : 1) : report.passed ? 0 : 1;
}

function resolveProfile(raw: string | undefined): Profile {
  const name = (raw ?? process.env.EVAL_PROFILE ?? "standard") as ProfileName;
  if (name === "smoke") {
    return { name, runs: 1, concurrency: 1, judgeReplicas: 1, smokeTurns: 6, smokeCases: 2 };
  }
  if (name === "standard") return { name, runs: 1, concurrency: 2, judgeReplicas: 2 };
  if (name === "confidence") return { name, runs: 3, concurrency: 3, judgeReplicas: 2 };
  throw new Error(`profile must be smoke, standard, or confidence; got ${name}`);
}

function selectScenarios(
  scenarios: Scenario[],
  rawCases: string | undefined,
  profile: Profile,
): Scenario[] {
  if (!rawCases) return profile.smokeCases ? scenarios.slice(0, profile.smokeCases) : scenarios;
  const requested = new Set(rawCases.split(",").map((value) => value.trim()).filter(Boolean));
  const selected = scenarios.filter((scenario) => requested.has(scenario.id));
  const missing = [...requested].filter((id) => !selected.some((scenario) => scenario.id === id));
  if (missing.length) throw new Error(`Unknown scenario ids: ${missing.join(", ")}`);
  return selected;
}

async function writeTrajectoryArtifacts(root: string, result: TrajectoryResult): Promise<void> {
  const directory = resolve(root, "trajectories", result.runId);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeJson(resolve(directory, "result.json"), result),
    writeJson(resolve(directory, "trajectory.atif.json"), toAtif(result)),
  ]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function positiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw ? positiveInteger(raw, name) : fallback;
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval:validate
  npm run eval:smoke -- [--cases id,id] [--output path]
  npm run eval:long -- [--cases id,id] [--runs n] [--concurrency n]

Commands:
  validate  Validate every scenario without making model calls (default)
  run       Execute closed-loop trajectories and write JSON + ATIF artifacts

Profiles:
  smoke       2 scenarios × 6 exchanges × 1 judge (connectivity, not H30 certification)
  standard    8 scenarios × 24 exchanges × 2 judge replicas
  confidence  standard suite × 3 independent runs

Important options:
  --suite path              Scenario suite JSON
  --cases id,id             Run a subset
  --turns n                 Override exchanges (cannot exceed scenario target)
  --skip-judge              Deterministic diagnostics only; never certifies H30
  --reward-file path        Also emit Harbor reward.json at this path
  --seed n                  Base simulator/judge seed
`);
}
