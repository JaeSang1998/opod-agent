import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectGitProvenance } from "./git-provenance.js";
import { loadPersonaComparison, runPersonaComparison } from "./persona-comparison.js";
import { createNaturalnessBlindReviewBundle, renderNaturalnessBlindReviewPacket } from "./review.js";

const args = parseArgs({ allowPositionals: true, options: {
  manifest: { type: "string" }, output: { type: "string" }, "max-calls": { type: "string" },
} });
const mode = args.positionals[0] ?? "preflight";
if (mode !== "preflight" && mode !== "run") throw new Error("expected preflight or run");
if (!args.values.manifest || !args.values["max-calls"]) throw new Error("--manifest and --max-calls are required");
const manifestPath = resolve(args.values.manifest);
const { fixture, manifestSha256 } = await loadPersonaComparison(manifestPath);
const git = await collectGitProvenance();
const outputDir = resolve(args.values.output ?? `evals/results/persona-comparison-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(dirname(outputDir), { recursive: true });
await mkdir(outputDir, { mode: 0o700 });
const writeJson = (name: string, data: unknown) => writeFile(resolve(outputDir, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await writeJson("input-provenance.json", { manifestPath, manifestSha256, ...git });
await writeFile(resolve(outputDir, "responses.jsonl"), "", { mode: 0o600, flag: "wx" });
let completed = 0;
try {
  const report = await runPersonaComparison(fixture, {
    mode, maxCalls: Number(args.values["max-calls"]),
    onResult: async (result) => {
      await appendFile(resolve(outputDir, "responses.jsonl"), `${JSON.stringify(result)}\n`);
      completed++;
      if (mode === "run" || completed === 1 || completed % 10 === 0) console.log(`Saved response ${completed}`);
    },
  });
  await writeJson("comparison-report.json", { ...report, manifestSha256, ...git });
  for (const [index, pair] of fixture.pairs.entries()) {
    const source = {
      schemaVersion: 1, mode: "diagnostic",
      trajectories: report.observations.filter((o) => pair.includes(o.conditionId)).map((o) => {
        const persona = fixture.conditions.find((c) => c.id === o.conditionId)?.personas.find((p) => p.characterId === o.characterId);
        const item = fixture.cases.find((c) => c.id === o.caseId);
        if (!persona || !item) throw new Error("review source is incomplete");
        const transcript = [];
        for (let i = 0; i < item.messages.length; i += 2) {
          const user = item.messages[i];
          if (!user) throw new Error("review prefix is incomplete");
          transcript.push({ turn: i / 2 + 1, user: user.content, assistant: item.messages[i + 1]?.content ?? o.text });
        }
        return {
          runId: o.runId, scenarioId: JSON.stringify([o.caseId, o.repetition]),
          passed: false, judgment: { passed: null },
          character: { id: persona.characterId, name: persona.name, personaSummary: persona.bio || persona.name },
          transcript,
        };
      }),
    };
    const sourceSha = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    const bundle = createNaturalnessBlindReviewBundle(source, sourceSha, fixture.reviewSeed, { sameCharacter: true });
    const name = `review-${index + 1}`;
    // One user reviews one packet. The agreement aggregator is not a quality gate.
    await writeJson(`${name}-packet.json`, bundle.packets[0]);
    await writeJson(`${name}-submission.json`, bundle.submissionTemplates[0]);
    await writeJson(`${name}-private-key.json`, { comparison: pair, source, key: bundle.key });
    const notice = mode === "preflight" ? "> 합성 응답으로 실행 경로만 검증한 파일입니다. 대화 품질 검수에 사용하지 마세요.\n\n" : "";
    await writeFile(resolve(outputDir, `${name}.md`), notice + renderNaturalnessBlindReviewPacket(bundle.packets[0], { singleReviewer: true }), { mode: 0o600, flag: "wx" });
  }
  console.log(`${mode}: ${report.completedCalls} responses; external model calls ${report.externalModelCalls}; quality remains unreviewed.`);
  console.log(`Artifacts: ${outputDir}`);
} catch (error) {
  await writeJson("incomplete.json", { mode, completedResponses: completed, qualityPassed: false, status: "incomplete" });
  throw error;
}
