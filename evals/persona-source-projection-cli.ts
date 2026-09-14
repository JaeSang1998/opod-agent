import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Persona } from "../src/persona/persona.js";
import { routePersona } from "../src/persona/persona-router.js";
import { assembleSystemPrompt } from "../src/chat/system-prompt.js";
import { projectPersonaSources } from "./persona-source-projection.js";

const inputPath = process.env.EVAL_PERSONA_INPUT;
const projectionPath = process.env.EVAL_PERSONA_PROJECTION;
if (!inputPath || !projectionPath) {
  throw new Error("EVAL_PERSONA_INPUT and EVAL_PERSONA_PROJECTION are required local JSON paths");
}
const [inputBytes, projectionBytes] = await Promise.all([
  readFile(resolve(inputPath)),
  readFile(resolve(projectionPath)),
]);
const input = Persona.array().min(1).parse(JSON.parse(inputBytes.toString("utf8")));
const output = projectPersonaSources(input, JSON.parse(projectionBytes.toString("utf8")));

// These are deterministic route probes, not relevance selection or generated replies.
const probes = output.personas.flatMap((persona) => {
  const optionalIds = persona.blocks.filter((b) => b.injection === "retrieved").map((b) => {
    if (!b.id) throw new Error("optional source probes require explicit block IDs");
    return b.id;
  });
  const observations = [
    { name: "initial_without_optional", isConversationStart: true, retrievedBlockIds: [] as string[] },
    { name: "later_without_optional", isConversationStart: false, retrievedBlockIds: [] as string[] },
    { name: "later_with_all_optional", isConversationStart: false, retrievedBlockIds: optionalIds },
  ].map(({ name, ...selection }) => {
    const routed = routePersona({ persona, ...selection });
    return {
      characterId: persona.characterId,
      name,
      stablePromptSha256: createHash("sha256")
        .update(assembleSystemPrompt({ persona: routed.stablePersona })).digest("hex"),
      sources: routed.provenance.sources,
    };
  });
  if (new Set(observations.map((o) => o.stablePromptSha256)).size !== 1) {
    throw new Error("optional source selection changed the stable prompt");
  }
  return observations;
});
const report = {
  schemaVersion: 1,
  kind: "experimental-persona-source-projection",
  generatedAt: new Date().toISOString(),
  qualityPassed: false,
  certificationEligible: false,
  fullPersonaRoutingReady: false,
  inputFileSha256: createHash("sha256").update(inputBytes).digest("hex"),
  projectionFileSha256: createHash("sha256").update(projectionBytes).digest("hex"),
  characterCount: input.length,
  originalBlockCount: input.reduce((n, p) => n + p.blocks.length, 0),
  projectedBlockCount: output.personas.reduce((n, p) => n + p.blocks.length, 0),
  splitSourceCount: new Set(output.sourceSpans.map((s) => s.sourceId)).size,
  fragmentCount: output.sourceSpans.length,
  sourceSpans: output.sourceSpans,
  probes,
};
// A fresh output directory prevents accidental replacement of the source or a prior run.
const outputDir = resolve(process.env.EVAL_RESULTS_DIR ??
  `evals/results/persona-projection-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(resolve(outputDir, ".."), { recursive: true });
await mkdir(outputDir, { mode: 0o700 });
await writeFile(resolve(outputDir, "projected-personas.json"), `${JSON.stringify(output.personas, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await writeFile(resolve(outputDir, "projection-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(`Projected ${report.splitSourceCount} sources into ${report.fragmentCount} fragments; ${report.originalBlockCount} -> ${report.projectedBlockCount} blocks.`);
console.log("Source integrity and stable prompt probes passed. No model calls; conversation quality was not evaluated.");
console.log(`Artifacts: ${outputDir}`);
