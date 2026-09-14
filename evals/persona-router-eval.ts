import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ChatService } from "../src/chat/chat-service.js";
import { noopLogger } from "../src/bootstrap/logger.js";
import { StubJobQueue } from "../src/memory/stub-job-queue.js";
import { StubMemoryStore } from "../src/memory/stub-memory-store.js";
import { Persona, type PersonaBlock } from "../src/persona/persona.js";
import type {
  PersonaBlockSelector,
  PromptPersonaProvenance,
} from "../src/persona/persona-router.js";
import {
  PersonaRoutingManifest,
  RoutedPersonaStore,
} from "../src/persona/routed-persona-store.js";
import { StubPersonaStore } from "../src/persona/stub-persona-store.js";
import { FakeProvider } from "../src/testing/fake-provider.js";

const FixtureBlock = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  content: z.string().min(1),
});

const RetrievalRule = z.object({
  blockId: z.string().min(1),
  whenUserContains: z.array(z.string().min(1)).min(1),
});

const ExpectedDestinations = z.object({
  turn: z.number().int().positive(),
  systemPrompt: z.array(z.string().min(1)),
  turnContext: z.array(z.string().min(1)),
  excluded: z.array(z.string().min(1)),
});

const PersonaCase = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    id: z.string().min(1),
    name: z.string().min(1),
    bio: z.string().min(1),
    blocks: z.array(FixtureBlock).min(4),
    routing: z.object({
      manifest: PersonaRoutingManifest,
      retrievalRules: z.array(RetrievalRule).min(1),
    }),
    turns: z.array(
      z.object({
        turn: z.number().int().positive(),
        message: z.string().min(1),
      }),
    ).min(3),
    expectations: z.object({
      control: z.array(ExpectedDestinations).min(3),
      candidate: z.array(ExpectedDestinations).min(3),
    }),
  })
  .superRefine((persona, ctx) => {
    const blockIds = persona.blocks.map((block) => block.id);
    const known = new Set(blockIds);
    if (known.size !== blockIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocks"],
        message: "persona fixture block ids must be unique",
      });
    }
    const routeIds = persona.routing.manifest.blocks.map((route) => route.blockId);
    if (
      JSON.stringify([...routeIds].sort()) !== JSON.stringify([...blockIds].sort())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["routing", "manifest", "blocks"],
        message: "explicit routing manifest must cover every fixture block exactly once",
      });
    }
    const routeById = new Map(
      persona.routing.manifest.blocks.map((route) => [route.blockId, route]),
    );
    for (const [index, rule] of persona.routing.retrievalRules.entries()) {
      if (!known.has(rule.blockId) || routeById.get(rule.blockId)?.injection !== "retrieved") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routing", "retrievalRules", index, "blockId"],
          message: "retrieval rules must reference a retrieved fixture block",
        });
      }
    }
    const expectedTurns = persona.turns.map((turn) => turn.turn);
    const sequentialTurns = persona.turns.map((_, index) => index + 1);
    if (JSON.stringify(expectedTurns) !== JSON.stringify(sequentialTurns)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turns"],
        message: "persona fixture turns must be consecutive from one",
      });
    }
    for (const condition of ["control", "candidate"] as const) {
      const expectations = persona.expectations[condition];
      if (
        JSON.stringify(expectations.map((item) => item.turn)) !==
        JSON.stringify(expectedTurns)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectations", condition],
          message: "each condition must declare every fixture turn in order",
        });
      }
      expectations.forEach((expectation, index) => {
        const all = [
          ...expectation.systemPrompt,
          ...expectation.turnContext,
          ...expectation.excluded,
        ];
        if (
          new Set(all).size !== all.length ||
          JSON.stringify([...all].sort()) !== JSON.stringify([...blockIds].sort())
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["expectations", condition, index],
            message: "expected destinations must partition every fixture block",
          });
        }
      });
    }
  });

export const PersonaRouterFixture = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("structure"),
    personas: z.array(PersonaCase).min(2),
  })
  .superRefine((fixture, ctx) => {
    for (const field of ["key", "id"] as const) {
      const values = fixture.personas.map((persona) => persona[field]);
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["personas"],
          message: `persona fixture ${field}s must be unique`,
        });
      }
    }
    const conversations = fixture.personas.map((persona) =>
      persona.turns.map((turn) => turn.message),
    );
    if (
      conversations.some(
        (conversation) => JSON.stringify(conversation) !== JSON.stringify(conversations[0]),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["personas"],
        message: "all personas must use the same fixed conversation",
      });
    }
  });

export type PersonaRouterFixture = z.infer<typeof PersonaRouterFixture>;
type PersonaCase = PersonaRouterFixture["personas"][number];
type Condition = "control" | "candidate";
type Destination = "system_prompt" | "turn_context" | "excluded";

interface TurnObservation {
  turn: number;
  user: string;
  stablePromptSha256: string;
  contextSectionNames: string[];
  destinations: Record<Destination, string[]>;
  provenance: PromptPersonaProvenance;
}

interface ConditionObservation {
  condition: Condition;
  turns: TurnObservation[];
}

interface PersonaComparison {
  personaKey: string;
  personaName: string;
  control: ConditionObservation;
  candidate: ConditionObservation;
}

export interface PersonaRouterReport {
  schemaVersion: 1;
  mode: "structure";
  generatedAt: string;
  fixtureSha256: string;
  qualityPassed: false;
  passed: false;
  certificationEligible: false;
  preflight: { passed: boolean; reasons: string[] };
  metrics: {
    personaCount: number;
    comparisonCount: number;
    controlNeutralUninvitedInjectionCount: number;
    candidateNeutralUninvitedInjectionCount: number;
    controlPostStartOnlyInjectionCount: number;
    candidatePostStartOnlyInjectionCount: number;
    controlNeverPromptLeakCount: number;
    candidateNeverPromptLeakCount: number;
    candidateRelevantRetrievedTurnContextCount: number;
  };
  comparisons: PersonaComparison[];
}

export async function loadPersonaRouterFixture(path: string): Promise<PersonaRouterFixture> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return PersonaRouterFixture.parse(parsed);
}

export async function runPersonaRouterEvaluation(
  fixture: PersonaRouterFixture,
): Promise<PersonaRouterReport> {
  const validated = PersonaRouterFixture.parse(fixture);
  const comparisons = await Promise.all(
    validated.personas.map(async (persona) => ({
      personaKey: persona.key,
      personaName: persona.name,
      control: await runCondition(persona, "control"),
      candidate: await runCondition(persona, "candidate"),
    })),
  );
  const reasons = assessComparisons(validated, comparisons);

  return {
    schemaVersion: 1,
    mode: "structure",
    generatedAt: new Date().toISOString(),
    fixtureSha256: createHash("sha256")
      .update(JSON.stringify(validated), "utf8")
      .digest("hex"),
    qualityPassed: false,
    passed: false,
    certificationEligible: false,
    preflight: { passed: reasons.length === 0, reasons },
    metrics: calculateMetrics(validated, comparisons),
    comparisons,
  };
}

async function runCondition(
  fixture: PersonaCase,
  condition: Condition,
): Promise<ConditionObservation> {
  const rawPersona = Persona.parse({
    characterId: fixture.id,
    name: fixture.name,
    bio: fixture.bio,
    blocks: fixture.blocks,
    canonMemories: [],
  });
  const source = new StubPersonaStore([rawPersona]);
  const personas = condition === "candidate"
    ? new RoutedPersonaStore(source, fixture.routing.manifest)
    : source;
  const selector = new FixtureSelector(fixture.routing.retrievalRules);
  const service = new ChatService(
    new FakeProvider(),
    personas,
    new StubMemoryStore(),
    new StubJobQueue(),
    {
      retrieveTopK: 6,
      weights: { recency: 1, importance: 1, relevance: 1 },
      recencyDecay: 0.99,
      summaryTurnThreshold: 8,
    },
    noopLogger,
    [],
    () => new Date("2026-09-07T04:00:00.000Z"),
    selector,
  );
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const turns: TurnObservation[] = [];

  for (const turn of fixture.turns) {
    history.push({ role: "user", content: turn.message });
    const prepared = await service.prepare(
      { messages: history },
      { characterId: fixture.id, historyOffset: 0 },
    );
    const debug = prepared.promptDebug;
    if (!debug?.personaProvenance) {
      throw new Error(`${fixture.key}/${condition}/turn-${turn.turn} has no Persona provenance`);
    }
    const system = String(prepared.request.messages[0]?.content ?? "");
    const tail = String(prepared.request.messages.at(-1)?.content ?? "");
    turns.push({
      turn: turn.turn,
      user: turn.message,
      stablePromptSha256: debug.stablePromptSha256,
      contextSectionNames: [...debug.contextSectionNames],
      destinations: actualDestinations(fixture.blocks, system, tail),
      provenance: debug.personaProvenance,
    });
    history.push({ role: "assistant", content: `fixture reply ${turn.turn}` });
  }

  return { condition, turns };
}

class FixtureSelector implements PersonaBlockSelector {
  constructor(private readonly rules: PersonaCase["routing"]["retrievalRules"]) {}

  async selectRelevantBlockIds(input: { query: string }): Promise<readonly string[]> {
    const query = input.query.toLocaleLowerCase();
    return this.rules
      .filter((rule) =>
        rule.whenUserContains.some((term) => query.includes(term.toLocaleLowerCase())),
      )
      .map((rule) => rule.blockId);
  }
}

function actualDestinations(
  blocks: PersonaBlock[],
  system: string,
  tail: string,
): Record<Destination, string[]> {
  const result: Record<Destination, string[]> = {
    system_prompt: [],
    turn_context: [],
    excluded: [],
  };
  for (const block of blocks) {
    if (!block.id) throw new Error("Persona Router fixture blocks require ids");
    const inSystem = system.includes(block.content);
    const inTail = tail.includes(block.content);
    if (inSystem && inTail) {
      throw new Error(`block ${block.id} was duplicated across prompt channels`);
    }
    result[inSystem ? "system_prompt" : inTail ? "turn_context" : "excluded"].push(block.id);
  }
  return result;
}

function assessComparisons(
  fixture: PersonaRouterFixture,
  comparisons: PersonaComparison[],
): string[] {
  const reasons: string[] = [];
  for (const persona of fixture.personas) {
    const comparison = comparisons.find((item) => item.personaKey === persona.key);
    if (!comparison) {
      reasons.push(`${persona.key}: comparison missing`);
      continue;
    }
    for (const condition of ["control", "candidate"] as const) {
      const observation = comparison[condition];
      if (new Set(observation.turns.map((turn) => turn.stablePromptSha256)).size !== 1) {
        reasons.push(`${persona.key}/${condition}: stable prompt changed between turns`);
      }
      for (const turn of observation.turns) {
        const expected = persona.expectations[condition].find(
          (item) => item.turn === turn.turn,
        );
        if (!expected) {
          reasons.push(`${persona.key}/${condition}/turn-${turn.turn}: expectation missing`);
          continue;
        }
        const expectedDestinations: Record<Destination, string[]> = {
          system_prompt: expected.systemPrompt,
          turn_context: expected.turnContext,
          excluded: expected.excluded,
        };
        for (const destination of ["system_prompt", "turn_context", "excluded"] as const) {
          if (!sameSet(turn.destinations[destination], expectedDestinations[destination])) {
            reasons.push(
              `${persona.key}/${condition}/turn-${turn.turn}: ${destination} did not match fixture`,
            );
          }
          const provenanceIds = turn.provenance.sources
            .filter((source) => source.destination === destination)
            .map((source) => source.id);
          if (!sameSet(provenanceIds, turn.destinations[destination])) {
            reasons.push(
              `${persona.key}/${condition}/turn-${turn.turn}: ${destination} provenance disagreed with prompt`,
            );
          }
        }
        const serializedProvenance = JSON.stringify(turn.provenance);
        if (persona.blocks.some((block) => serializedProvenance.includes(block.content))) {
          reasons.push(`${persona.key}/${condition}/turn-${turn.turn}: provenance exposed content`);
        }
      }
    }
  }
  return [...new Set(reasons)];
}

function calculateMetrics(
  fixture: PersonaRouterFixture,
  comparisons: PersonaComparison[],
): PersonaRouterReport["metrics"] {
  let controlNeutralUninvitedInjectionCount = 0;
  let candidateNeutralUninvitedInjectionCount = 0;
  let controlPostStartOnlyInjectionCount = 0;
  let candidatePostStartOnlyInjectionCount = 0;
  let controlNeverPromptLeakCount = 0;
  let candidateNeverPromptLeakCount = 0;
  let candidateRelevantRetrievedTurnContextCount = 0;

  for (const persona of fixture.personas) {
    const comparison = comparisons.find((item) => item.personaKey === persona.key);
    if (!comparison) continue;
    const routeById = new Map(
      persona.routing.manifest.blocks.map((route) => [route.blockId, route]),
    );
    const neutralTurn = persona.turns[0]?.turn;
    for (const condition of ["control", "candidate"] as const) {
      for (const turn of comparison[condition].turns) {
        const injected = [
          ...turn.destinations.system_prompt,
          ...turn.destinations.turn_context,
        ];
        const neutralUninvited = injected.filter((id) => {
          const policy = routeById.get(id)?.injection;
          return turn.turn === neutralTurn && (policy === "retrieved" || policy === "never_prompt");
        }).length;
        const postStart = injected.filter(
          (id) => turn.turn > 1 && routeById.get(id)?.injection === "start_only",
        ).length;
        const neverLeaks = injected.filter(
          (id) => routeById.get(id)?.injection === "never_prompt",
        ).length;
        if (condition === "control") {
          controlNeutralUninvitedInjectionCount += neutralUninvited;
          controlPostStartOnlyInjectionCount += postStart;
          controlNeverPromptLeakCount += neverLeaks;
        } else {
          candidateNeutralUninvitedInjectionCount += neutralUninvited;
          candidatePostStartOnlyInjectionCount += postStart;
          candidateNeverPromptLeakCount += neverLeaks;
          const query = turn.user.toLocaleLowerCase();
          const relevantIds = new Set(
            persona.routing.retrievalRules
              .filter((rule) =>
                rule.whenUserContains.some((term) =>
                  query.includes(term.toLocaleLowerCase()),
                ),
              )
              .map((rule) => rule.blockId),
          );
          candidateRelevantRetrievedTurnContextCount +=
            turn.destinations.turn_context.filter((id) => relevantIds.has(id)).length;
        }
      }
    }
  }

  return {
    personaCount: fixture.personas.length,
    comparisonCount: comparisons.length,
    controlNeutralUninvitedInjectionCount,
    candidateNeutralUninvitedInjectionCount,
    controlPostStartOnlyInjectionCount,
    candidatePostStartOnlyInjectionCount,
    controlNeverPromptLeakCount,
    candidateNeverPromptLeakCount,
    candidateRelevantRetrievedTurnContextCount,
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function renderPersonaRouterReport(
  report: PersonaRouterReport,
  fixture: PersonaRouterFixture,
): string {
  const status = report.preflight.passed ? "구조 검증 통과" : "구조 검증 실패";
  const comparisons = report.comparisons.map((comparison) => {
    const persona = fixture.personas.find((item) => item.key === comparison.personaKey);
    if (!persona) throw new Error(`report references unknown persona ${comparison.personaKey}`);
    const routeById = new Map(
      persona.routing.manifest.blocks.map((route) => [route.blockId, route]),
    );
    const legend = persona.blocks.map((block) => {
      const route = routeById.get(block.id);
      if (!route) throw new Error(`report fixture has no route for block ${block.id}`);
      return `<tr><td><code>${escapeHtml(block.id)}</code></td><td>${route.kind}</td><td>${route.injection}</td><td>${escapeHtml(block.content)}</td></tr>`;
    }).join("");
    const turnRows = persona.turns.flatMap((turn) => {
      return (["control", "candidate"] as const).map((condition) => {
        const observed = comparison[condition].turns.find((item) => item.turn === turn.turn);
        if (!observed) {
          throw new Error(
            `report has no ${condition} observation for ${persona.key} turn ${turn.turn}`,
          );
        }
        const cell = (destination: Destination) =>
          observed.destinations[destination].length
            ? observed.destinations[destination].map((id) => `<code>${escapeHtml(id)}</code>`).join(" ")
            : '<span class="empty">없음</span>';
        return `<tr class="${condition}"><td>${turn.turn}</td><td>${escapeHtml(turn.message)}</td><td>${condition === "control" ? "Control" : "Candidate"}</td><td>${cell("system_prompt")}</td><td>${cell("turn_context")}</td><td>${cell("excluded")}</td></tr>`;
      });
    }).join("");
    return `<section><h2>${escapeHtml(comparison.personaName)} <small>${escapeHtml(comparison.personaKey)}</small></h2><h3>블록 분류</h3><table><thead><tr><th>ID</th><th>kind</th><th>injection</th><th>합성 내용</th></tr></thead><tbody>${legend}</tbody></table><h3>동일 문맥 A/B</h3><table><thead><tr><th>턴</th><th>사용자</th><th>조건</th><th>system_prompt</th><th>turn_context</th><th>excluded</th></tr></thead><tbody>${turnRows}</tbody></table></section>`;
  }).join("");
  const reasons = report.preflight.reasons.length
    ? `<ul>${report.preflight.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
    : "<p>기대 destination, 실제 prompt, provenance가 모두 일치했습니다.</p>";

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>P1-1 Persona Router 구조 A/B</title><style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#111827;color:#e5e7eb}body{max-width:1180px;margin:0 auto;padding:32px 20px 80px;line-height:1.55}h1{font-size:30px;margin-bottom:8px}h2{margin-top:42px;border-top:1px solid #374151;padding-top:28px}h3{margin-top:24px}small,.muted{color:#9ca3af;font-weight:400}.warning{background:#3f2d12;border:1px solid #b7791f;border-radius:12px;padding:16px;margin:20px 0}.status{display:inline-block;padding:6px 10px;border-radius:999px;background:${report.preflight.passed ? "#064e3b" : "#7f1d1d"};font-weight:700}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:24px 0}.metric{background:#1f2937;border:1px solid #374151;border-radius:12px;padding:14px}.metric strong{display:block;font-size:24px}table{width:100%;border-collapse:collapse;font-size:14px;display:block;overflow-x:auto}th,td{border-bottom:1px solid #374151;padding:10px;text-align:left;vertical-align:top}th{color:#d1d5db;background:#1f2937}.candidate{background:rgba(6,78,59,.18)}code{white-space:nowrap;background:#374151;border-radius:4px;padding:2px 5px}.empty{color:#6b7280}
</style></head><body><span class="status">${status}</span><h1>P1-1 Persona Router 구조 A/B</h1><p class="muted">생성 시각 ${escapeHtml(report.generatedAt)} · fixture ${report.fixtureSha256.slice(0, 12)}</p><div class="warning"><strong>대화 자연스러움: 판정하지 않음</strong><br>이 문서는 어떤 Persona source가 어느 prompt 채널에 들어갔는지만 검증합니다. 모델 답변을 생성하거나 자동 품질 PASS를 부여하지 않았습니다.</div><div class="metrics"><div class="metric">중립 첫 턴의 불필요 source<br><strong>${report.metrics.controlNeutralUninvitedInjectionCount} → ${report.metrics.candidateNeutralUninvitedInjectionCount}</strong></div><div class="metric">첫 턴 이후 start_only 잔류<br><strong>${report.metrics.controlPostStartOnlyInjectionCount} → ${report.metrics.candidatePostStartOnlyInjectionCount}</strong></div><div class="metric">never_prompt 누출<br><strong>${report.metrics.controlNeverPromptLeakCount} → ${report.metrics.candidateNeverPromptLeakCount}</strong></div><div class="metric">관련 lore의 turn_context 주입<br><strong>${report.metrics.candidateRelevantRetrievedTurnContextCount}</strong></div></div>${reasons}${comparisons}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
