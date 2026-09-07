import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toAtif, toHarborReward } from "./atif.js";
import {
  aggregateSuite,
  createBaselineManifest,
  runTrajectory,
  smokeConnectivityPassed,
  type TrajectoryResult,
} from "./evaluate.js";
import { OpenAiStructuredLlm, structuredLlmConfig } from "./llm.js";
import {
  aggregateNaturalnessBlindReviews,
  createNaturalnessBlindReviewBundle,
  renderNaturalnessBlindReviewAgreement,
  renderNaturalnessBlindReviewPacket,
} from "./review.js";
import {
  type CharacterSet,
  loadCharacterSet,
  loadScenarioSuite,
  type Scenario,
} from "./schema.js";
import { createConversationTarget } from "./target.js";

import { collectGitProvenance } from "./git-provenance.js";

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
  character?: CharacterSet["characters"][number];
  runIndex: number;
}

const parsed = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    profile: { type: "string" },
    suite: { type: "string" },
    characters: { type: "string" },
    cases: { type: "string" },
    turns: { type: "string" },
    runs: { type: "string" },
    concurrency: { type: "string" },
    output: { type: "string" },
    "reward-file": { type: "string" },
    "judge-replicas": { type: "string" },
    "skip-judge": { type: "boolean" },
    source: { type: "string" },
    key: { type: "string" },
    submissions: { type: "string" },
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
  if (command === "review-prepare") {
    await prepareBlindReview();
    return;
  }
  if (command === "review-aggregate") {
    await aggregateBlindReview();
    return;
  }
  const suitePath = resolve(
    parsed.values.suite ?? "evals/cases/long-conversation.json",
  );
  const suiteBytes = await readFile(suitePath);
  const suite = await loadScenarioSuite(suitePath);
  const characterSetPathRaw = parsed.values.characters ?? process.env.EVAL_CHARACTER_SET_PATH;
  const characterSetPath = characterSetPathRaw ? resolve(characterSetPathRaw) : undefined;
  const characterSetBytes = characterSetPath ? await readFile(characterSetPath) : undefined;
  const characterSet = characterSetPath ? await loadCharacterSet(characterSetPath) : undefined;
  const isMemoryStructureSuite = suite.scenarios.every((scenario) => scenario.memoryFixture);
  if (command === "validate") {
    console.log(
      `Validated ${suite.scenarios.length} ${suite.mode} scenarios in ${suitePath}` +
        (characterSet
          ? ` with ${characterSet.characters.length} characters from ${characterSetPath}`
          : ""),
    );
    return;
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);
  if (isMemoryStructureSuite && characterSet) {
    throw new Error("An isolated memory-structure run does not accept a runtime character set.");
  }
  if (isMemoryStructureSuite && process.env.EVAL_TARGET_URL) {
    throw new Error("An isolated memory-structure run cannot write fixtures to an HTTP target.");
  }
  if (suite.mode === "diagnostic" && !isMemoryStructureSuite && !characterSet) {
    throw new Error(
      "A diagnostic run requires --characters or EVAL_CHARACTER_SET_PATH so it cannot be attributed to one implicit character.",
    );
  }
  if (suite.mode === "diagnostic" && !isMemoryStructureSuite && !process.env.EVAL_TARGET_URL) {
    throw new Error(
      "A multi-character diagnostic run requires EVAL_TARGET_URL; the in-process target only owns the synthetic default persona.",
    );
  }
  if (suite.mode === "h30" && characterSet) {
    throw new Error("--characters is only supported by diagnostic suites; H30 keeps its existing scenario identities.");
  }

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
  const runGroupId = randomUUID();
  const runStartedAt = new Date().toISOString();
  const git = await collectGitProvenance();

  const simulator = new OpenAiStructuredLlm(structuredLlmConfig("simulator"));
  const judge = skipJudge
    ? undefined
    : new OpenAiStructuredLlm(structuredLlmConfig("judge"));
  if (!judge && !isMemoryStructureSuite) {
    console.warn("Judge disabled: this run cannot certify H30 readiness.");
  }
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
  const work: WorkItem[] = selected.flatMap((scenario) => {
    const characters = characterSet?.characters ?? [undefined];
    return characters.flatMap((character) =>
      Array.from({ length: runs }, (_, runIndex) => ({ scenario, character, runIndex })),
    );
  });
  console.log(
    `Running ${work.length} trajectories (${selected.length} scenarios × ` +
      `${characterSet?.characters.length ?? 1} character(s) × ${runs} run(s), concurrency ${concurrency})`,
  );

  const trajectories = await mapLimit(work, concurrency, async ({ scenario, character, runIndex }) => {
    const target = createConversationTarget();
    const effectiveScenario = character ? { ...scenario, character } : scenario;
    const characterKey = effectiveScenario.character.key ?? effectiveScenario.character.id;
    const requestedTurns = Math.min(
      turnsOverride ?? effectiveScenario.targetTurns,
      effectiveScenario.targetTurns,
    );
    console.log(
      `[${characterKey}/${effectiveScenario.id} r${runIndex + 1}] start: ` +
        `${requestedTurns} exchanges on ${target.kind}`,
    );
    const result = await runTrajectory({
      scenario: effectiveScenario,
      runIndex,
      turns: requestedTurns,
      seed: seed + runIndex * 10_000,
      target,
      simulator,
      judge,
      judgeReplicas,
      evaluationMode: suite.mode,
      onTurn: (turn) =>
        console.log(
          `[${characterKey}/${effectiveScenario.id} r${runIndex + 1}] ` +
            `${turn.turn}/${requestedTurns} ${Math.round(turn.latencyMs)}ms`,
        ),
    });
    await writeTrajectoryArtifacts(outputDir, result);
    if (isMemoryStructureSuite) {
      console.log(
        `[${characterKey}/${effectiveScenario.id} r${runIndex + 1}] ` +
          `STRUCTURE-${result.memoryFixture?.preflight.passed ? "PASS" : "FAIL"} ` +
          `POLICY-${result.memoryFixture?.policyExpectationsPassed ? "PASS" : "FAIL"}`,
      );
    } else {
      const outcome = profile.name === "smoke"
        ? smokeConnectivityPassed([result], Boolean(judge))
          ? "CONNECTED"
          : "CONNECTIVITY-FAIL"
        : result.passed
          ? "PASS"
          : "FAIL";
      console.log(
        `[${characterKey}/${effectiveScenario.id} r${runIndex + 1}] ` +
          `${outcome} score=${result.score.toFixed(3)}`,
      );
    }
    return result;
  });

  const aggregate = aggregateSuite(suite, profile.name, trajectories, {
    suitePath,
    suiteSha256: createHash("sha256").update(suiteBytes).digest("hex"),
    gitSha: git.gitSha,
    gitDirty: git.gitDirty,
    dirtyPathHashes: git.dirtyPathHashes,
    characterSetPath,
    characterSetSha256: characterSetBytes
      ? createHash("sha256").update(characterSetBytes).digest("hex")
      : undefined,
    characterSetLabel: characterSet?.scope.label,
    characterSetCapturedAt: characterSet?.scope.capturedAt,
  }, {
    expectedCharacterKeys: characterSet?.characters.map((character) => character.key),
    expectedScenarioIds: selected.map((scenario) => scenario.id),
  });
  const baseline = createBaselineManifest(aggregate, {
    runGroupId,
    startedAt: runStartedAt,
    baseSeed: seed,
  });
  const report = { ...aggregate, baseline };
  await writeJson(resolve(outputDir, "suite-report.json"), report);
  await writeJson(resolve(outputDir, "baseline-manifest.json"), baseline);
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
  const memoryStructurePreflightPassed =
    isMemoryStructureSuite &&
    trajectories.every((result) => result.memoryFixture?.preflight.passed === true);
  const memoryPolicyExpectationsPassed =
    isMemoryStructureSuite &&
    trajectories.every((result) => result.memoryFixture?.policyExpectationsPassed === true);
  if (isMemoryStructureSuite) {
    console.log(
      `Memory structure ${memoryStructurePreflightPassed ? "PASS" : "FAIL"}: ` +
        `fixture/provenance=${memoryStructurePreflightPassed ? "VALID" : "INVALID"} ` +
        `lifecyclePolicy=${memoryPolicyExpectationsPassed ? "PASS" : "FAIL"}`,
    );
  } else if (suite.mode === "diagnostic") {
    console.log(
      `Diagnostic ${report.characterCoverage.passed ? "COMPLETE" : "INCOMPLETE"}: ` +
        `quality=${report.qualityPassed ? "PASS" : "FAIL"} score=${report.score.toFixed(3)} ` +
        `characters=${report.characterCoverage.observed.length}/${report.characterCoverage.expected.length} ` +
        `missing=${report.characterCoverage.missing.join(",") || "none"} ` +
        `failingCharacters=${report.failingCharacterKeys.join(",") || "none"}`,
    );
  } else if (profile.name === "smoke") {
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
  if (isMemoryStructureSuite) {
    console.log("Conversation-quality baseline comparability: not applicable to this structural probe");
  } else {
    console.log(
      `Baseline comparability: ${baseline.comparison.ready ? "READY" : "NOT READY"}` +
        (baseline.comparison.reasons.length
          ? ` (${baseline.comparison.reasons.join("; ")})`
          : ""),
    );
  }

  const diagnosticExecutionComplete =
    report.characterCoverage.passed &&
    baseline.comparison.ready &&
    trajectories.every(
      (result) =>
        !result.runtimeError && result.completedTurns === result.requestedTurns &&
        (skipJudge || Boolean(result.judgment)),
    );
  process.exitCode = isMemoryStructureSuite
    ? smokePassed && memoryStructurePreflightPassed
      ? 0
      : 1
    : suite.mode === "diagnostic"
    ? diagnosticExecutionComplete
      ? 0
      : 1
    : profile.name === "smoke"
      ? smokePassed
        ? 0
        : 1
      : report.passed
        ? 0
        : 1;
}

async function prepareBlindReview(): Promise<void> {
  const sourcePath = requiredPath(parsed.values.source, "--source");
  const outputDir = requiredPath(parsed.values.output, "--output");
  const seed = parsed.values.seed
    ? positiveInteger(parsed.values.seed, "seed")
    : 20260902;
  const sourceBytes = await readFile(sourcePath);
  const source: unknown = JSON.parse(sourceBytes.toString("utf8"));
  const suiteReportSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const bundle = createNaturalnessBlindReviewBundle(source, suiteReportSha256, seed);

  await createNewOutputDirectory(outputDir);
  for (const [index, reviewerSlot] of ["reviewer-a", "reviewer-b"].entries()) {
    const packet = bundle.packets[index];
    const submission = bundle.submissionTemplates[index];
    if (!packet || !submission) throw new Error(`missing ${reviewerSlot} review packet`);
    await Promise.all([
      writeJson(resolve(outputDir, `${reviewerSlot}.packet.json`), packet),
      writeFile(
        resolve(outputDir, `${reviewerSlot}.packet.md`),
        renderNaturalnessBlindReviewPacket(packet),
        "utf8",
      ),
      writeJson(resolve(outputDir, `${reviewerSlot}.submission.json`), submission),
    ]);
  }
  await Promise.all([
    writeJson(resolve(outputDir, "_PRIVATE-review-key.json"), bundle.key),
    writeFile(
      resolve(outputDir, "README.md"),
      [
        "# Blind review packet",
        "",
        "각 reviewer에게 자신의 `.packet.md`와 `.submission.json`만 전달한다.",
        "`_PRIVATE-review-key.json`과 다른 reviewer 파일은 전달하지 않는다.",
        "기존 원문·자동 점수·22개 예시가 있는 사람 검수 보고서와 가이드는 전달하지 않는다.",
        "각 reviewer는 `reviewerAlias`를 서로 다른 비식별 가명으로 교체한다.",
        "Submission의 모든 항목을 채우고 `status`를 `complete`로 바꾼 뒤 집계한다.",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);
  console.log(
    `Prepared 2 blind review packets for ${bundle.packets[0].items.length} trajectories in ${outputDir}`,
  );
  console.log(`Private mapping: ${resolve(outputDir, "_PRIVATE-review-key.json")}`);
}

async function aggregateBlindReview(): Promise<void> {
  const keyPath = requiredPath(parsed.values.key, "--key");
  const outputDir = requiredPath(parsed.values.output, "--output");
  const submissionPaths = (parsed.values.submissions ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));
  if (submissionPaths.length !== 2) {
    throw new Error("--submissions must contain exactly two comma-separated JSON paths");
  }
  const key: unknown = JSON.parse(await readFile(keyPath, "utf8"));
  const submissions: unknown[] = await Promise.all(
    submissionPaths.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown),
  );
  const report = aggregateNaturalnessBlindReviews(key, submissions);

  await createNewOutputDirectory(outputDir);
  await Promise.all([
    writeJson(resolve(outputDir, "agreement-report.json"), report),
    writeFile(
      resolve(outputDir, "agreement-report.md"),
      renderNaturalnessBlindReviewAgreement(report),
      "utf8",
    ),
  ]);
  console.log(
    `Blind review ${report.status}: trajectory=${report.trajectoryAgreement.agreements}/${report.trajectoryAgreement.comparable} ` +
      `pairwise=${report.pairwiseAgreement.agreements}/${report.pairwiseAgreement.comparable}`,
  );
  console.log(`Agreement artifacts: ${outputDir}`);
}

async function createNewOutputDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path);
}

function requiredPath(raw: string | undefined, option: string): string {
  if (!raw?.trim()) throw new Error(`${option} is required`);
  return resolve(raw);
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
  npm run eval:naturalness -- --characters path

Commands:
  validate  Validate every scenario without making model calls (default)
  run       Execute closed-loop trajectories and write JSON + ATIF artifacts
  review-prepare    Create two blinded packets and draft submissions without model calls
  review-aggregate  Validate two completed submissions and calculate agreement

Profiles:
  smoke       2 scenarios × 6 exchanges × 1 judge (connectivity, not H30 certification)
  standard    8 scenarios × 24 exchanges × 2 judge replicas
  confidence  standard suite × 3 independent runs

Important options:
  --suite path              Scenario suite JSON
  --characters path         Complete runtime character-set JSON (diagnostic only)
  --cases id,id             Run a subset
  --turns n                 Override exchanges (cannot exceed scenario target)
  --skip-judge              Deterministic diagnostics only; never certifies H30
  --reward-file path        Also emit Harbor reward.json at this path
  --seed n                  Base simulator/judge seed

Blind review:
  review-prepare --source suite-report.json --output new-directory [--seed n]
  review-aggregate --key _PRIVATE-review-key.json --submissions a.json,b.json --output new-directory
`);
}
