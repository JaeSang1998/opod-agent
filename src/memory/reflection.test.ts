import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type OpenAI from "openai";
import { parseLines, parseReflections } from "./parsing.js";
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

describe("parseReflections", () => {
  const evidence = [obs("m1", "a"), obs("m2", "b"), obs("m3", "c")];

  it("maps 1-based citations to evidence ids", () => {
    const out = parseReflections("The user values companionship (because of 1, 3)", evidence);
    expect(out[0]?.content).toBe("The user values companionship");
    expect(out[0]?.evidence).toEqual(["m1", "m3"]);
  });

  it("accepts no reflections and deduplicates valid citations", () => {
    expect(parseReflections("\n  \n", evidence)).toEqual([]);
    expect(parseReflections("A reflection (because of 1, 1, 3)", evidence)).toEqual([
      { content: "A reflection", evidence: ["m1", "m3"] },
    ]);
  });

  it.each([
    "A standalone Reflection",
    "Private claim (because of 9)",
    "Private claim (because of 0)",
    "Private claim (because of 1, 9)",
    "Private claim (because of -1)",
    "Private claim (because of 1.5)",
    "Private claim (age 1)",
    "(because of 1)",
    "Valid claim (because of 1)\nPrivate claim without evidence",
  ])("rejects a whole synthesis batch with unsupported citations: %s", (response) => {
    expect(() => parseReflections(response, evidence)).toThrow(/^Invalid memory reflection response$/);
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
      reflectionsPerQuestion: 1,
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
  const REFLECTIONS = "high-level Reflections";
  const CORE = "compact Core Memory";

  it("uses lexical evidence and stores an unembedded interpretation when no model identity is verified", async () => {
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "Nova";
      if (system.includes(REFLECTIONS)) return "User may value Nova's company (because of 1)";
      throw new Error("Unexpected generation stage");
    });
    const embed = vi.spyOn(provider, "embed").mockRejectedValue(new Error("Unknown model must not be called"));
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted Nova.");
    await memory.upsertMany(key, [{ content: "Unrelated private detail.", embedding: [0, 1, 0], importance: 10, kind: "observation" }]);
    const writes = vi.spyOn(memory, "upsertMany");
    const reflector = new Reflector(provider, memory, configWith({ integratedContext: true }), now);
    await expect(reflector.reflect(key, "lexical-reflection")).resolves.toEqual({ reflectionsStored: 1, coreUpdated: false });
    expect(writes.mock.calls[0]![1][0]).toMatchObject({ embedding: [], memoryType: "interpretation", evidence: ["mem_1"] });
    const synthesis = provider.chatCalls.find((call) => String(call.messages[0]?.content).includes(REFLECTIONS));
    expect(synthesis?.messages[1]?.content).toContain("User adopted Nova.");
    expect(synthesis?.messages[1]?.content).not.toContain("Unrelated private detail.");
    expect(embed).not.toHaveBeenCalled();
  });

  it("marks grounded cited reflections as interpretations without fabricating source messages or event times", async () => {
    const reflection = "The user may care about companionship";
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "Nova";
      if (system.includes(REFLECTIONS)) return `${reflection} (because of 1)`;
      if (system.includes(CORE)) return "User adopted Nova.";
      return "";
    });
    provider.embed = async (texts) => texts.map((text) => Array.from({ length: 1024 }, (_, i) => i === (text === reflection ? 1 : 0) ? 1 : 0));
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted Nova.");
    const core = { ...key, content: "Existing legacy core.", updatedAt: now() };
    await memory.saveCoreMemory(core);
    const writes = vi.spyOn(memory, "upsertMany");
    const reflector = new Reflector(provider, memory, configWith({ integratedContext: true, embeddingModel: "synthetic-test" }), now);
    await reflector.reflect(key, "grounded-reflection");
    const row = writes.mock.calls[0]![1][0]!;
    expect(row).toMatchObject({ kind: "reflection", memoryType: "interpretation", evidence: ["mem_1"],
      embeddingModel: "synthetic-test", embeddingSourceSha256: createHash("sha256").update(reflection).digest("hex") });
    expect(row).not.toHaveProperty("sourceMessages");
    expect(row).not.toHaveProperty("occurredAt");
    expect(writes.mock.calls[0]![2]).toBe("grounded-reflection:reflections");
    expect(await memory.getCoreMemory(key)).toEqual(core);
    expect(provider.chatCalls.some((call) => String(call.messages[0]?.content).includes(CORE))).toBe(false);
  });

  it.each([
    "An uncited private conclusion",
    "Valid claim (because of 1)\nPrivate conclusion (because of 1, 9)",
  ])("keeps unsupported synthesis out of archival storage and core: %s", async (synthesis) => {
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "What matters to them?";
      if (system.includes(REFLECTIONS)) return synthesis;
      if (system.includes(CORE)) return "An incorrectly replaced core.";
      return "";
    });
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted a cat named Nova.");
    const core = { ...key, content: "Existing verified facts.", updatedAt: now() };
    await memory.saveCoreMemory(core);
    const reflector = new Reflector(provider, memory, configWith(), now);

    await expect(reflector.reflect(key)).rejects.toThrow("Invalid memory reflection response");
    const rows = await memory.retrieve(key, [1, 0, 0], 10, { weights, recencyDecay: 0.99 });
    expect(rows.map((row) => row.kind)).toEqual(["observation"]);
    expect(await memory.getCoreMemory(key)).toEqual(core);
    expect(provider.chatCalls.some((call) => String(call.messages[0]?.content).includes(CORE))).toBe(false);
  });

  it("persists valid cited synthesis without requesting a core rewrite", async () => {
    const reflection = "The user cares about their cat";
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "What matters to them?";
      if (system.includes(REFLECTIONS)) return `${reflection} (because of 1)`;
      if (system.includes(CORE)) return "The user adopted Nova and cares about the cat.";
      return "";
    });
    provider.embed = async (texts) => texts.map((text) => text === reflection ? [0, 1, 0] : [1, 0, 0]);
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted a cat named Nova.");
    const [source] = await memory.recentObservations(key, 1);
    const reflector = new Reflector(provider, memory, configWith(), now);

    await expect(reflector.reflect(key)).resolves.toMatchObject({ reflectionsStored: 1, coreUpdated: false });
    const rows = await memory.retrieve(key, [1, 0, 0], 10, { weights, recencyDecay: 0.99 });
    expect(rows.find((row) => row.kind === "reflection")).toMatchObject({ content: reflection, evidence: [source?.id] });
    const coreCall = provider.chatCalls.find((call) => String(call.messages[0]?.content).includes(CORE));
    expect(coreCall).toBeUndefined();
    expect(await memory.getCoreMemory(key)).toBeNull();
  });

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

  it("does not rewrite a separate core block", async () => {
    const coreCharLimit = 40;
    const content = "A".repeat(coreCharLimit);
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "What matters to them?";
      if (system.includes(REFLECTIONS)) return "";
      if (system.includes(CORE)) return content;
      return "";
    });
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted a cat named Nova.");
    const reflector = new Reflector(provider, memory, configWith({ coreCharLimit }), now);

    const result = await reflector.reflect(key);

    expect(result.coreUpdated).toBe(false);
    const core = await memory.getCoreMemory(key);
    expect(core).toBeNull();
  });

  it("does not request or store a core rewrite", async () => {
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "What matters to them?";
      if (system.includes(REFLECTIONS)) return "";
      if (system.includes(CORE)) return "";
      return "";
    });
    const memory = new StubMemoryStore(now);
    await seedObservation(memory, "User adopted a cat named Nova.");
    const reflector = new Reflector(provider, memory, configWith(), now);

    await expect(reflector.reflect(key)).resolves.toEqual({
      reflectionsStored: 0,
      coreUpdated: false,
    });
    expect(await memory.getCoreMemory(key)).toBeNull();
  });

  it("(d) stores no Reflections when the synthesis reply has no parseable lines", async () => {
    const provider = new ScriptedProvider((system) => {
      if (system.includes(SALIENT)) return "What matters to them?";
      if (system.includes(REFLECTIONS)) return "\n   \n"; // unusable: nothing to parse
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
      String(c.messages[0]?.content ?? "").includes(REFLECTIONS),
    );
    expect(reachedSynthesis).toBe(true);
    // And nothing of kind "reflection" was persisted.
    const stored = await memory.retrieve(key, [1, 0, 0], 10, { weights, recencyDecay: 0.99 });
    expect(stored.some((m) => m.kind === "reflection")).toBe(false);
  });
});
