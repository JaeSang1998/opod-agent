import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/testing/fake-provider.js";
import { StubPersonaStore } from "../src/persona/stub-persona-store.js";
import { createConversationTarget, type TargetTurnInput } from "./target.js";

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
  it("preserves personalized evaluation behavior unless explicitly disabled", async () => {
    const provider = new FakeProvider();
    const target = createConversationTarget(env, { provider, personas: new StubPersonaStore([persona]) });
    try {
      const result = await target.reply(input);
      expect(result.promptDebug?.contextSectionNames).toContain("bond");
      expect(provider.embedCalls).toHaveLength(1);
      expect(target.runtimeConfig.personalization).toBe("tracked");
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
