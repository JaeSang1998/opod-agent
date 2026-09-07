import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { Persona } from "../src/persona/persona.js";
import { routePersona } from "../src/persona/persona-router.js";
import { StubPersonaStore } from "../src/persona/stub-persona-store.js";
import { createConversationTarget, type TargetTurnOutput } from "./target.js";

const Id = z.string().min(1);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Case = z.object({
  id: Id,
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: Id }).strict()).min(1),
  historyOffset: z.number().int().safe().nonnegative().default(0),
  reviewFocus: z.string().optional(),
}).superRefine((item, ctx) => {
  if (item.messages.length % 2 !== 1 || item.messages.some((m, i) => m.role !== (i % 2 === 0 ? "user" : "assistant"))) {
    ctx.addIssue({ code: "custom", message: "fixed prefixes must alternate user/assistant and end with user" });
  }
});
const Settings = z.object({
  schemaVersion: z.literal(1),
  clock: z.string().datetime({ offset: true }),
  timezone: Id.refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "invalid timezone"),
  repetitions: z.number().int().safe().positive(),
  pairs: z.array(z.tuple([Id, Id])).min(1),
  reviewSeed: z.number().int().safe().nonnegative().default(1729),
});
const Fixture = Settings.extend({
  conditions: z.array(z.object({ id: Id, personas: z.array(Persona).min(1) })).min(2),
  cases: z.array(Case).min(1),
}).superRefine((fixture, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const ids = fixture.conditions.map((c) => c.id);
  if (new Set(ids).size !== ids.length) fail("duplicate condition ID");
  if (new Set(fixture.cases.map((c) => c.id)).size !== fixture.cases.length) fail("duplicate case ID");
  const pairKeys = fixture.pairs.map((pair) => [...pair].sort().join("\0"));
  if (new Set(pairKeys).size !== pairKeys.length) fail("duplicate comparison pair");
  if (fixture.pairs.some(([a, b]) => a === b || !ids.includes(a) || !ids.includes(b))) fail("unknown or self comparison pair");
  if (ids.some((id) => !fixture.pairs.some((pair) => pair.includes(id)))) fail("unpaired condition");
  const baseline = fixture.conditions[0];
  for (const condition of fixture.conditions) {
    const characters = condition.personas.map((p) => p.characterId);
    if (new Set(characters).size !== characters.length) fail("duplicate character ID");
    if (JSON.stringify([...characters].sort()) !== JSON.stringify(baseline?.personas.map((p) => p.characterId).sort())) fail("character sets differ");
    const sourceIds = condition.personas.flatMap((p) => p.blocks.map((b) => b.id));
    if (sourceIds.some((id) => !id) || new Set(sourceIds).size !== sourceIds.length) fail("source IDs must be present and unique");
    for (const persona of condition.personas) {
      if (!persona.characterId.trim() || !persona.name.trim()) fail("character identity must be non-empty");
      const original = baseline?.personas.find((p) => p.characterId === persona.characterId);
      const identity = (p: Persona | undefined) => p && { name: p.name, bio: p.bio, canon: p.canonMemories };
      if (JSON.stringify(identity(persona)) !== JSON.stringify(identity(original))) fail("identity or canon changed between conditions");
    }
  }
});

type ComparisonFixture = z.infer<typeof Fixture>;
type ComparisonObservation = TargetTurnOutput & {
  conditionId: string;
  characterId: string;
  caseId: string;
  repetition: number;
  runId: string;
};

/** Content/version validation completes before constructing any model provider. */
export async function loadPersonaComparison(path: string): Promise<{
  fixture: ComparisonFixture;
  manifestSha256: string;
}> {
  const bytes = await readFile(path);
  const manifest = Settings.extend({
    conditions: z.array(z.object({ id: Id, personaFile: Id, personaSha256: Sha256 }).strict()).min(2),
    casesFile: Id, casesSha256: Sha256,
  }).strict().parse(JSON.parse(bytes.toString("utf8")));
  const readPinned = async (file: string, hash: string) => {
    const data = await readFile(resolve(dirname(path), file));
    if (createHash("sha256").update(data).digest("hex") !== hash) throw new Error("comparison input hash mismatch");
    return JSON.parse(data.toString("utf8"));
  };
  const conditions = await Promise.all(manifest.conditions.map(async (c) => ({ id: c.id, personas: await readPinned(c.personaFile, c.personaSha256) })));
  const cases = z.object({ cases: z.array(Case) }).parse(await readPinned(manifest.casesFile, manifest.casesSha256)).cases;
  return { fixture: Fixture.parse({ ...manifest, conditions, cases }), manifestSha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Fixed-prefix diagnostics reuse the production HTTP target, never the simulator. */
export async function runPersonaComparison(rawFixture: unknown, options: {
  mode: "preflight" | "run";
  maxCalls: number;
  env?: NodeJS.ProcessEnv;
  onResult?: (result: ComparisonObservation) => Promise<void>;
}) {
  const fixture = Fixture.parse(rawFixture);
  const characters = fixture.conditions[0]?.personas.map((p) => p.characterId) ?? [];
  const plannedCalls = characters.length * fixture.conditions.length * fixture.cases.length * fixture.repetitions;
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < plannedCalls) throw new Error("comparison exceeds the explicit call limit");
  const suppliedEnv = options.env ?? process.env;
  if (suppliedEnv.EVAL_TARGET_URL) throw new Error("fixed comparisons require an in-process target");
  if (options.mode === "run" && (!suppliedEnv.LLM_BASE_URL || !(suppliedEnv.EVAL_TARGET_MODEL || suppliedEnv.LLM_MODEL) || !suppliedEnv.EVAL_TARGET_MAX_TOKENS)) {
    throw new Error("run requires explicit LLM_BASE_URL, model and EVAL_TARGET_MAX_TOKENS");
  }
  const env = {
    ...suppliedEnv,
    EVAL_TARGET_PROVIDER: options.mode === "preflight" ? "deterministic" : "configured",
    EVAL_TARGET_MODEL: options.mode === "preflight" ? "persona-comparison-deterministic" : suppliedEnv.EVAL_TARGET_MODEL ?? suppliedEnv.LLM_MODEL,
    EVAL_TARGET_TOOLS: "false", EVAL_CONSOLIDATION_MODE: "none", EVAL_TARGET_MAX_RETRIES: "0",
  };
  const observations: ComparisonObservation[] = [];
  const stableHashes = new Map<string, string>();
  let responseModel: string | undefined;
  let targetConfig: { model: string; requestConfig: Record<string, unknown>; runtimeConfig: Record<string, unknown> } | undefined;
  for (let repetition = 1; repetition <= fixture.repetitions; repetition++) {
    for (const [caseIndex, item] of fixture.cases.entries()) {
      for (const [characterIndex, characterId] of characters.entries()) {
        // Rotate condition order so one condition does not always go first.
        const offset = (repetition - 1 + caseIndex + characterIndex) % fixture.conditions.length;
        const conditions = [...fixture.conditions.slice(offset), ...fixture.conditions.slice(0, offset)];
        for (const condition of conditions) {
          const persona = condition.personas.find((p) => p.characterId === characterId);
          if (!persona) throw new Error("missing comparison character");
          const target = createConversationTarget(env, {
            personas: new StubPersonaStore([persona]), clock: () => new Date(fixture.clock),
            personalization: "none", personaBlockSelector: { selectRelevantBlockIds: async () => [] },
          });
          const config = { model: target.model, requestConfig: target.requestConfig, runtimeConfig: target.runtimeConfig };
          if (targetConfig && JSON.stringify(config) !== JSON.stringify(targetConfig)) throw new Error("target configuration changed during comparison");
          targetConfig = config;
          const runId = `comparison-${observations.length + 1}`;
          try {
            const result = await target.reply({
              runId, userTurn: (item.messages.length + 1) / 2, historyOffset: item.historyOffset,
              identity: { characterId, userId: "unused", sessionId: "unused", timezone: fixture.timezone },
              messages: structuredClone(item.messages),
            });
            const observation = { ...result, conditionId: condition.id, characterId, caseId: item.id, repetition, runId };
            // Preserve paid responses even if a later assertion or request fails.
            await options.onResult?.(observation);
            if (!result.responseModel || (responseModel && responseModel !== result.responseModel) || result.finishReason !== "stop") {
              throw new Error("comparison response model changed, is missing, or completion was truncated");
            }
            responseModel = result.responseModel;
            const debug = result.promptDebug;
            const expected = routePersona({ persona, isConversationStart: item.historyOffset === 0 && item.messages.length === 1, retrievedBlockIds: [] });
            if (!debug || JSON.stringify(debug.personaProvenance) !== JSON.stringify(expected.provenance) || debug.canonCount !== persona.canonMemories.length || debug.retrievedMemoryCount !== 0 || debug.contextSectionNames.some((s) => ["bond", "core_memory", "conversation_summary", "retrieved_memories"].includes(s))) {
              throw new Error("comparison prompt provenance or hidden state mismatch");
            }
            const key = JSON.stringify([characterId, condition.id]);
            const hash = stableHashes.get(key);
            if (hash && hash !== debug.stablePromptSha256) throw new Error("stable prompt changed within a condition");
            stableHashes.set(key, debug.stablePromptSha256);
            observations.push(observation);
          } finally { await target.close(); }
        }
      }
    }
  }
  return {
    schemaVersion: 1, kind: "persona-fixed-prefix-comparison", mode: options.mode,
    completedAt: new Date().toISOString(), structurePassed: true, qualityPassed: false, certificationEligible: false,
    selectorMode: "fixed_empty_diagnostic_only", personalization: "none", judgeUsed: false,
    fixtureSha256: createHash("sha256").update(JSON.stringify(fixture)).digest("hex"),
    plannedCalls, completedCalls: observations.length, externalModelCalls: options.mode === "run" ? observations.length : 0,
    target: targetConfig, observations,
  };
}
