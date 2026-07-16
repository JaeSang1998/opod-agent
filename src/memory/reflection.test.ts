import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { parseLines, parseInsights } from "./parsing.js";
import type { ArchivalMemory } from "./types.js";
import { Reflector, type ReflectionConfig } from "./reflection.js";
import { StubMemoryStore } from "./stub-memory-store.js";
import type { LLMProvider } from "../provider/llm-provider.js";
import type { RelationshipKey } from "./memory-store.js";

function obs(id: string, content: string): ArchivalMemory {
  return { id, userId: "u", characterId: "c", content, kind: "observation", importance: 5, createdAt: "", lastAccessedAt: "" };
}

describe("parseLines", () => {
  it("strips bullets and numbering", () => {
    expect(parseLines("1) first\n- second\n3. third")).toEqual(["first", "second", "third"]);
  });
});

describe("parseInsights", () => {
  const evidence = [obs("m1", "a"), obs("m2", "b"), obs("m3", "c")];

  it("maps 1-based citations to evidence ids", () => {
    const out = parseInsights("The user values companionship (because of 1, 3)", evidence);
    expect(out[0]?.content).toBe("The user values companionship");
    expect(out[0]?.evidence).toEqual(["m1", "m3"]);
  });

  it("handles insights without citations", () => {
    const out = parseInsights("A standalone insight", evidence);
    expect(out[0]?.content).toBe("A standalone insight");
    expect(out[0]?.evidence).toEqual([]);
  });

  it("ignores out-of-range citation numbers", () => {
    const out = parseInsights("Insight (because of 9)", evidence);
    expect(out[0]?.evidence).toEqual([]);
  });
});

/**
 * Bespoke provider so per-prompt replies can be scripted by the Reflector's own
 * system-prompt text (fake-provider.ts is shared and must not be edited). Records
 * every chat/embed call so tests can assert a pass made — or skipped — LLM work.
 */
class ScriptedProvider implements LLMProvider {
  readonly defaultModel = "scripted-model";
  readonly chatCalls: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[] = [];
  readonly embedCalls: string[][] = [];

  constructor(private readonly route: (system: string) => string) {}

  async chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    this.chatCalls.push(req);
    const content = this.route(String(req.messages[0]?.content ?? ""));
    return {
      id: "chatcmpl-scripted",
      object: "chat.completion",
      created: 0,
      model: req.model,
      choices: [
        { index: 0, message: { role: "assistant", content, refusal: null }, finish_reason: "stop", logprobs: null },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as OpenAI.Chat.Completions.ChatCompletion;
  }

  async chatStream(): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    throw new Error("Reflector never streams");
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls.push(texts);
    // Constant unit vector: enough for the stub's retrieval + dedup math.
    return texts.map(() => [1, 0, 0]);
  }
}

describe("Reflector", () => {
  const now = () => "2026-01-01T00:00:00Z";
  const key: RelationshipKey = { userId: "u1", characterId: "luna" };
  const weights = { recency: 1, importance: 1, relevance: 1 };

  function configWith(overrides: Partial<ReflectionConfig> = {}): ReflectionConfig {
    return {
      recentN: 20,
      questionsPerPass: 1,
      insightsPerQuestion: 1,
      retrieveTopK: 5,
      reflectionImportance: 7,
      coreCharLimit: 2000,
      weights,
      recencyDecay: 0.99,
      ...overrides,
    };
  }

  async function seedObservation(memory: StubMemoryStore, content: string): Promise<void> {
    await memory.upsertMany(key, [
      { content, embedding: [1, 0, 0], importance: 6, kind: "observation" },
    ]);
  }

  // Distinctive substrings lifted from reflection.ts's actual system prompts.
  const SALIENT = "salient high-level questions";
  const INSIGHTS = "high-level insights";
  const CORE = "compact Core Memory";

  it("(a) no-ops without any provider calls when there are no recent observations", async () => {
    const provider = new ScriptedProvider(() => {
      throw new Error("provider must not be called on an empty stream");
    });
    const memory = new StubMemoryStore(now);
    const reflector = new Reflector(provider, memory, configWith(), now);

    const result = await reflector.reflect(key);

    expect(result).toEqual({ reflectionsStored: 0, coreUpdated: false });
    expect(provider.chatCalls).toHaveLength(0);
    expect(provider.embedCalls).toHaveLength(0);
    expect(await memory.getCoreMemory(key)).toBeNull();
  });

  it("(b) truncates an over-limit core rewrite to exactly coreCharLimit", async () => {
    const coreCharLimit = 40;
    const oversized = "A".repeat(200);
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "What matters to them?";
      if (system.includes(INSIGHTS)) return "";
      if (system.includes(CORE)) return oversized;
      return "";
    });
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted a cat named Nova.");
    const reflector = new Reflector(provider, memory, configWith({ coreCharLimit }), now);

    const result = await reflector.reflect(key);

    expect(result.coreUpdated).toBe(true);
    const core = await memory.getCoreMemory(key);
    expect(core?.content.length).toBe(coreCharLimit);
    expect(core?.content).toBe(oversized.slice(0, coreCharLimit));
  });

  it("(c) leaves the core block untouched when the rewrite returns empty", async () => {
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "What matters to them?";
      if (system.includes(INSIGHTS)) return "";
      if (system.includes(CORE)) return "";
      return "";
    });
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted a cat named Nova.");
    const reflector = new Reflector(provider, memory, configWith(), now);

    const result = await reflector.reflect(key);

    expect(result.coreUpdated).toBe(false);
    expect(await memory.getCoreMemory(key)).toBeNull();
  });

  it("(d) stores no insights when the synthesis reply has no parseable lines", async () => {
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "What matters to them?";
      if (system.includes(INSIGHTS)) return "\n   \n"; // unusable: nothing to parse
      if (system.includes(CORE)) return "Tidy Core Memory.";
      return "";
    });
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted a cat named Nova.");
    const reflector = new Reflector(provider, memory, configWith(), now);

    const result = await reflector.reflect(key);

    expect(result.reflectionsStored).toBe(0);
    // Non-vacuous: evidence was retrieved so the synthesis prompt really ran.
    const reachedSynthesis = provider.chatCalls.some((c) =>
      String(c.messages[0]?.content ?? "").includes(INSIGHTS),
    );
    expect(reachedSynthesis).toBe(true);
    // And nothing of kind "reflection" was persisted.
    const stored = await memory.retrieve(key, [1, 0, 0], 10, { weights, recencyDecay: 0.99 });
    expect(stored.some((m) => m.kind === "reflection")).toBe(false);
  });
});
