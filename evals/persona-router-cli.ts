import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadPersonaRouterFixture,
  renderPersonaRouterReport,
  runPersonaRouterEvaluation,
} from "./persona-router-eval.js";

const fixturePath = resolve(
  process.env.EVAL_PERSONA_ROUTER_FIXTURE ?? "evals/cases/p1-persona-router.json",
);
const outputDir = resolve(
  process.env.EVAL_RESULTS_DIR ??
    `evals/results/persona-router-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const fixture = await loadPersonaRouterFixture(fixturePath);
const report = await runPersonaRouterEvaluation(fixture);

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, "persona-router-report.json"), `${JSON.stringify(report, null, 2)}\n`),
  writeFile(resolve(outputDir, "persona-router-report.html"), renderPersonaRouterReport(report, fixture)),
]);

console.log(
  `Persona Router STRUCTURE-${report.preflight.passed ? "PASS" : "FAIL"}; ` +
    "conversation quality was not evaluated.",
);
console.log(
  `Neutral uninvited sources: ${report.metrics.controlNeutralUninvitedInjectionCount} -> ` +
    report.metrics.candidateNeutralUninvitedInjectionCount,
);
console.log(
  `Post-start start_only sources: ${report.metrics.controlPostStartOnlyInjectionCount} -> ` +
    report.metrics.candidatePostStartOnlyInjectionCount,
);
console.log(
  `never_prompt leaks: ${report.metrics.controlNeverPromptLeakCount} -> ` +
    report.metrics.candidateNeverPromptLeakCount,
);
console.log(`Artifacts: ${outputDir}`);

if (!report.preflight.passed) process.exitCode = 1;
