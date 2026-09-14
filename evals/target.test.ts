import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/testing/fake-provider.js";
import { StubPersonaStore } from "../src/persona/stub-persona-store.js";
import { createConversationTarget, parseChatResponse, type TargetTurnInput } from "./target.js";

const persona = {
  characterId: "fixed-character", name: "Fixed", bio: "A synthetic character.",
  blocks: [
    { id: "voice", title: "Voice", content: "Keep a calm voice.", kind: "voice" as const, injection: "always" as const },
    { id: "lore", title: "Lore", content: "A lighthouse story.", kind: "lore" as const, injection: "retrieved" as const },
    { id: "note", title: "Note", content: "Private production instructions.", kind: "creator_note" as const, injection: "never_prompt" as const },
  ], canonMemories: ["A fixed canon fact."],
};
const input: TargetTurnInput = {
  runId: "local-probe", userTurn: 1, historyOffset: 0,
  identity: { characterId: persona.characterId, userId: "unused-user", sessionId: "unused-session", timezone: "Asia/Seoul" },
  messages: [{ role: "user", content: "Tell me about it." }],
};
const env = { EVAL_TARGET_PROVIDER: "deterministic", EVAL_CONSOLIDATION_MODE: "none" };

describe("isolated in-process evaluation inputs", () => {
  it("seeds and replies in integrated lexical mode without embedding calls and preserves budget/retrieval traces through HTTP", async () => {
    const provider = new FakeProvider();
    const target = createConversationTarget({ ...env, CHARACTER_CONTEXT_MODE: "integrated", CONTEXT_MAX_BYTES: "16000" }, {
      provider, personas: new StubPersonaStore([persona]),
    });
    try {
      await target.setupMemoryFixture?.({ runId: input.runId, identity: input.identity, memoryFixture: {
        schemaVersion: 1, seedPolicy: "baseline_unfiltered", asOf: "2026-09-11T00:00:00.000Z",
        records: [{ id: "tea", content: "The user likes jasmine tea.", kind: "observation", importance: 7, lifecycle: "active" }],
        currentStateRecords: [], probes: [],
      } });
      const result = await target.reply({ ...input, messages: [{ role: "user", content: "jasmine tea?" }] });
      expect(provider.embedCalls).toHaveLength(0);
      expect(target.runtimeConfig).toMatchObject({ characterContextMode: "integrated", contextMaxBytes: 16000 });
      expect(result.promptDebug?.contextBudget).toMatchObject({ status: "within_budget", maxBytes: 16000 });
      expect(result.promptDebug?.memoryProvenance?.hybrid).toEqual({ semanticStatus: "query_unavailable", lexicalCandidates: 1, semanticCandidates: 0 });
      expect(result.promptDebug?.retrievedMemoryCount).toBe(1);
      const metadata = { ...result.promptDebug, characterRetrieval: { semanticStatus: "no_valid_index", content: "private source" },
        memoryProvenance: { ...result.promptDebug?.memoryProvenance, sources: [{
          id: "duplicate", kind: "observation", rank: 2, score: 0, rawRelevance: 0, retrieval: "excluded",
          retrievalReason: "duplicate_content", injected: false, injectionReason: "not_retrieved", content: "private source",
        }] } };
      const parsed = parseChatResponse({ choices: [{ message: { content: "reply" } }], opod_debug: { prompt: metadata } });
      expect(parsed.promptDebug?.characterRetrieval).toEqual({ semanticStatus: "no_valid_index" });
      expect(parsed.promptDebug?.contextBudget).toEqual(result.promptDebug?.contextBudget);
      expect(parsed.promptDebug?.memoryProvenance?.sources[0]?.retrievalReason).toBe("duplicate_content");
      expect(JSON.stringify(parsed.promptDebug)).not.toContain("private source");
      for (const invalid of [
        { ...metadata, characterRetrieval: { semanticStatus: "invented" } },
        { ...metadata, contextBudget: { ...result.promptDebug?.contextBudget, bytes: 16001 } },
        { ...metadata, memoryProvenance: { ...metadata.memoryProvenance, hybrid: { semanticStatus: "used", lexicalCandidates: -1, semanticCandidates: 0 } } },
      ]) expect(() => parseChatResponse({ choices: [{ message: { content: "reply" } }], opod_debug: { prompt: invalid } })).toThrow(/metadata/);
    } finally { await target.close(); }
  });

  it("preserves structured canon provenance and memory gate metadata through HTTP", async () => {
    const memory = { id: "historical-event", type: "event", reason: "fixture", content: "An old harbor visit.",
      createdAt: "2026-01-01", updatedAt: "2026-01-01", kind: "event" as const,
      injection: "retrieved" as const, recallKeys: ["harbor"] };
    const target = createConversationTarget(env, { provider: new FakeProvider(),
      personalization: "none", personas: new StubPersonaStore([{ ...persona, canonMemories: [memory] }]),
    });
    try {
      const result = await target.reply({ ...input, messages: [{ role: "user", content: "Tell me about the harbor." }] });
      expect(result.promptDebug?.contextSectionNames).toContain("character_memories");
      // Counts describe loaded sources; destinations describe actual injection.
      expect(result.promptDebug?.canonCount).toBe(1);
      expect(result.promptDebug?.personaProvenance?.canonSources).toEqual([
        { id: memory.id, kind: "event", destination: "turn_context", reason: "retrieved_for_turn" },
      ]);
      expect(result.promptDebug?.memoryPolicyVersion).toBe(2);
      expect(result.promptDebug?.retrievalConfig.minRelevance).toBe(0);
    } finally { await target.close(); }
  });

  it("runs every delayed job without eval-only coalescing and keeps summary coverage aligned", async () => {
    const provider = new FakeProvider("ack", "[]");
    const target = createConversationTarget({ ...env, EVAL_CONSOLIDATION_MODE: "batched", EVAL_CONSOLIDATION_BATCH_TURNS: "2" }, {
      provider, personas: new StubPersonaStore([persona]),
    });
    try {
      const first = { ...input, messages: [{ role: "user" as const, content: "My cat is Nova." }] };
      const reply = await target.reply(first);
      expect(provider.chatCalls.filter((call) => String(call.messages[0]?.content).includes("running summary"))).toHaveLength(0);
      await target.reply({ ...input, userTurn: 2, messages: [
        ...first.messages, { role: "assistant", content: reply.text }, { role: "user", content: "My dog is Max." },
      ] });
      const summaries = provider.chatCalls.filter((call) => String(call.messages[0]?.content).includes("running summary"));
      expect(summaries).toHaveLength(2);
      const newTurns = String(summaries[1]!.messages[1]!.content).split("New turns:\n")[1];
      expect(newTurns).toContain("My dog is Max.");
      expect(newTurns).not.toContain("My cat is Nova.");
      expect(target.runtimeConfig.consolidationQueuePolicy).toBe("all_jobs_with_source_ranges_v1");
    } finally { await target.close(); }
  });

  it("preserves personalized evaluation behavior unless explicitly disabled", async () => {
    const provider = new FakeProvider();
    const target = createConversationTarget(env, { provider, personas: new StubPersonaStore([persona]) });
    try {
      const result = await target.reply(input);
      expect(result.promptDebug?.contextSectionNames).toContain("bond");
      expect(provider.embedCalls).toHaveLength(1);
      expect(target.runtimeConfig.personalization).toBe("tracked");
      expect(target.runtimeConfig).toMatchObject({ characterContextMode: "legacy", contextMaxBytes: 32000 });
    } finally { await target.close(); }
  });

  it("passes frozen Persona/clock/selection through HTTP without Bond or user-memory side effects", async () => {
    const provider = new FakeProvider();
    const target = createConversationTarget({ ...env, DATABASE_URL: "must-never-connect" }, {
      provider, personas: new StubPersonaStore([persona]),
      clock: () => new Date("2026-09-07T06:22:21Z"), personalization: "none",
      personaBlockSelector: { selectRelevantBlockIds: async ({ blocks }) => {
        expect(blocks.map((block) => block.id)).toEqual(["lore"]);
        return ["lore"];
      } },
    });
    try {
      const first = await target.reply(input);
      const second = await target.reply({ ...input, runId: "fresh-run" });
      expect(first.promptDebug?.personaProvenance?.sources).toContainEqual(expect.objectContaining({ id: "lore", destination: "turn_context" }));
      expect(first.promptDebug?.contextSectionNames).toEqual(["current_moment", "persona_retrieved"]);
      expect(first.promptDebug?.canonCount).toBe(1);
      expect(first.promptDebug?.stablePromptSha256).toBe(second.promptDebug?.stablePromptSha256);
      expect(provider.chatCalls).toHaveLength(2);
      expect(provider.chatCalls[0]!.messages).toEqual(provider.chatCalls[1]!.messages);
      const prompt = JSON.stringify(provider.chatCalls[0]!.messages);
      expect(prompt).toContain("September 7, 2026 at 3:22 PM");
      expect(prompt).toContain("Keep a calm voice.");
      expect(prompt).not.toContain("Private production instructions.");
      expect(provider.embedCalls).toHaveLength(0);
    } finally { await target.close(); }
    expect(provider.chatCalls).toHaveLength(2);
  });

  it("rejects missing frozen characters before a completion can degrade to a proxy", async () => {
    const provider = new FakeProvider();
    const target = createConversationTarget(env, { provider, personas: new StubPersonaStore([persona]) });
    await expect(target.reply({ ...input, identity: { ...input.identity, characterId: "missing" } })).rejects.toThrow("frozen Persona");
    expect(provider.chatCalls).toHaveLength(0);
  });

  it("rejects local input overrides on a remote target instead of silently ignoring them", () => {
    expect(() => createConversationTarget({ EVAL_TARGET_URL: "http://127.0.0.1:1", EVAL_TARGET_MODEL: "unused" }, {
      personas: new StubPersonaStore([persona]),
    })).toThrow("in-process");
  });
});
