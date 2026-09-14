import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContainer } from "../bootstrap/container.js";
import { loadEnv } from "../bootstrap/env.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { Persona } from "./persona.js";
import { PersonaRoutingManifest, RoutedPersonaStore } from "./routed-persona-store.js";
import { StubPersonaStore } from "./stub-persona-store.js";
import { projectPersonaSources } from "./persona-source-projection.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const voice = "DM은 담백한 존댓말.\n";
const production = "캡션은 시적으로, 해시태그는 다섯 개.";
const event = "지난 여행에서 파란 우산을 잃어버렸다.";
const raw = Persona.parse({
  characterId: "synthetic-context-character", name: "Synthetic", blocks: [
    { id: "mixed", title: "말투", content: voice + production },
    { id: "lore", title: "배경", content: "북쪽 항구에서 자랐다." },
    { id: "example", title: "예시", content: "복사하면 안 되는 예시 답변." },
  ],
  canonMemories: [{ id: "event", content: event, type: "operator-authored", reason: "fixture",
    createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
});
const plan = {
  schemaVersion: 1, mappingMode: "explicit_block_id", blocks: [
    { blockId: "mixed", kind: "voice", injection: "always" },
    { blockId: "lore", kind: "lore", injection: "retrieved", recallKeys: ["북쪽 항구"] },
    { blockId: "example", kind: "example", injection: "never_prompt" },
  ],
  structuredCharacters: [{ characterId: raw.characterId,
    projection: { schemaVersion: 1, offsetUnit: "utf8_bytes", sources: [{
      blockId: "mixed", sourceSha256: hash(voice + production), fragments: [
        { startByte: 0, endByte: Buffer.byteLength(voice), kind: "voice", injection: "always" },
        { startByte: Buffer.byteLength(voice), endByte: Buffer.byteLength(voice + production), kind: "creator_note", injection: "never_prompt" },
      ],
    }] },
    canon: [{ memoryId: "event", sourceSha256: hash(event), kind: "event", injection: "retrieved", recallKeys: ["파란 우산"] }],
  }],
};

describe("structured character context through the serving path", () => {
  it("recalls both persona and canon for a follow-up but drops them after a topic cut", async () => {
    const persona = Persona.parse({ characterId: "followup", name: "Synthetic", blocks: [
      { id: "coffee-lore", title: "Preference", content: "쓴 커피를 좋아한다.", kind: "lore", injection: "retrieved", recallKeys: ["커피"] },
    ], canonMemories: [{ id: "coffee-fact", content: "커피는 식사 후에 마신다.", kind: "fact", injection: "retrieved", recallKeys: ["커피"],
      type: "operator-authored", reason: "fixture", createdAt: "2026-01-01", updatedAt: "2026-01-01" }] });
    const provider = new FakeProvider();
    const { chat } = buildContainer(loadEnv({ TOOLS_ENABLED: "false" }), { personas: new StubPersonaStore([persona]), provider });
    const history = [{ role: "user" as const, content: "커피는 뭐 좋아해요?" }, { role: "assistant" as const, content: "쓴 커피요." }];
    const prepare = (content: string, previous = history) => chat.prepare({ messages: [...previous, { role: "user", content }] }, { characterId: persona.characterId });
    const followup = await prepare("그거 언제 마셔요?");
    expect(followup.request.messages.at(-1)?.content).toContain("쓴 커피를 좋아한다.");
    expect(followup.request.messages.at(-1)?.content).toContain("커피는 식사 후에 마신다.");
    const cut = await prepare("커피 얘기는 됐고, 심심해요");
    const unrelated = await prepare("오늘 버스 놓쳤어요");
    const assistantOnly = await prepare("그거 언제 마셔요?", [{ role: "assistant", content: "커피는요?" }]);
    const stale = await prepare("그거 언제 마셔요?", [...history, { role: "assistant", content: "다른 얘기요." }]);
    for (const result of [cut, unrelated, assistantOnly, stale]) {
      expect(result.request.messages.at(-1)?.content).not.toContain("쓴 커피를 좋아한다.");
      expect(result.request.messages.at(-1)?.content).not.toContain("커피는 식사 후에 마신다.");
      expect(result.request.messages[0]?.content).toEqual(followup.request.messages[0]?.content);
    }
    expect(provider.chatCalls).toHaveLength(0);
    expect(provider.embedCalls).toHaveLength(0);
  });

  it("carries explicit reaction/voice roles without flattening two characters into a shared style", async () => {
    const characters = [
      { characterId: "reserved", name: "Reserved", reaction: "낯을 가리지만 고마움은 전한다.", voice: "담백한 존댓말." },
      { characterId: "direct", name: "Direct", reaction: "자기 생각을 분명히 말한다.", voice: "솔직하고 자신 있는 말투." },
    ];
    const personas = new StubPersonaStore(characters.map(c => Persona.parse({ ...c, blocks: [
      { id: "reaction", title: "identity", content: c.reaction, kind: "behavior", injection: "always" },
      { id: "voice", title: "identity", content: c.voice, kind: "voice", injection: "always" },
      { id: "background", title: "identity", content: "차가운 커피를 좋아한다.", kind: "lore", injection: "retrieved", recallKeys: ["커피"] },
      { id: "greeting", title: "identity", content: "아직 모르는 상대에게는 친밀함을 가정하지 않는다.", kind: "greeting", injection: "start_only" },
      { id: "example", title: "identity", content: "복사 금지 예문.", kind: "example", injection: "never_prompt" },
    ] })));
    const provider = new FakeProvider();
    const { chat } = buildContainer(loadEnv({ TOOLS_ENABLED: "false" }), { personas, provider });
    for (const character of characters) {
      const prepare = (content: string) => chat.prepare({ messages: [{ role: "user", content }] }, { characterId: character.characterId });
      const neutral = await prepare("너 멋있다");
      const recalled = await prepare("커피는 뭐 좋아해?");
      const system = String(neutral.request.messages[0]?.content);
      expect(system).toContain("# identity\nPurpose — Personality: how you judge and react");
      expect(system).toContain("# identity\nPurpose — Voice: how you type your reaction");
      expect(system).toContain(character.reaction);
      expect(system).toContain(character.voice);
      for (const other of characters.filter(c => c !== character)) expect(system).not.toContain(other.reaction);
      expect(system).not.toContain("차가운 커피를 좋아한다.");
      expect(system).not.toContain("복사 금지 예문.");
      expect(recalled.request.messages[0]?.content).toEqual(system);
      expect(recalled.request.messages.at(-1)?.content).toContain("## identity\nPurpose — Background: facts to draw on when relevant");
      expect(neutral.request.messages.at(-1)?.content).toContain("## identity\nPurpose — Greeting: first-contact guidance");
      expect(recalled.request.messages.at(-1)?.content).toContain("차가운 커피를 좋아한다.");
    }
    expect(provider.chatCalls).toHaveLength(0);
    expect(provider.embedCalls).toHaveLength(0);
  });

  it("loads the explicit manifest through production configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opod-persona-context-"));
    try {
      const path = join(dir, "manifest.json");
      await writeFile(path, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
      const { personas } = buildContainer(loadEnv({ PERSONA_ROUTING_MANIFEST_PATH: path }), {
        personas: new StubPersonaStore([raw]), provider: new FakeProvider(),
      });
      const result = await personas.get(raw.characterId);
      expect(result?.blocks).toHaveLength(4);
      expect(result?.canonMemories[0]).toMatchObject({ kind: "event", injection: "retrieved" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not inherit parent recall keys into newly classified fragments", () => {
    const input = structuredClone(raw);
    input.blocks[0]!.recallKeys = ["parent-only"];
    const projected = projectPersonaSources([input], plan.structuredCharacters[0]!.projection);
    expect(projected.personas[0]?.blocks.slice(0, 2).every(b => b.recallKeys === undefined)).toBe(true);
    expect(JSON.stringify(projected.sourceSpans)).not.toContain("parent-only");
  });

  it("rejects an explicit persistent event even outside the manifest adapter", () => {
    const memory = raw.canonMemories[0];
    if (!memory || typeof memory === "string") throw new Error("fixture canon missing");
    expect(() => Persona.parse({ ...raw, canonMemories: [
      { ...memory, kind: "event", injection: "always" },
    ] })).toThrow("events must not be persistent");
    expect(() => Persona.parse({ ...raw, canonMemories: [
      { ...memory, kind: "event" },
    ] })).toThrow("events must not be persistent");
  });

  it("validates authored event precision without inventing an instant", () => {
    const memory = raw.canonMemories[0];
    if (!memory || typeof memory === "string") throw new Error("fixture canon missing");
    const parse = (fields: Record<string, unknown>) => Persona.parse({ ...raw, canonMemories: [{
      ...memory, kind: "event", injection: "retrieved", ...fields,
    }] });
    expect(() => parse({ occurredLabel: "2023-02-29", occurredPrecision: "day" })).toThrow("calendar");
    expect(() => parse({ occurredLabel: "2023-07", occurredPrecision: "month", occurredAt: "2023-07-01T00:00:00Z" })).toThrow("must not invent");
    expect(() => parse({ occurredLabel: "2023-07-01 10:00", occurredPrecision: "instant", occurredAt: "2023-07-01T10:00:00" })).toThrow("timezone");
    expect(parse({ occurredLabel: "2023-07", occurredPrecision: "month" }).canonMemories[0]).toMatchObject({ occurredLabel: "2023-07", occurredPrecision: "month" });
  });

  it("splits mixed source text and recalls only relevant character history without rewriting the stable prefix", async () => {
    const source = new StubPersonaStore([raw]);
    const store = new RoutedPersonaStore(source, PersonaRoutingManifest.parse(plan));
    const provider = new FakeProvider();
    const { chat } = buildContainer(loadEnv({ TOOLS_ENABLED: "false" }), { personas: store, provider });
    const prepare = (text: string) => chat.prepare({ messages: [{ role: "user", content: text }] }, { characterId: raw.characterId });
    const neutral = await prepare("뭐해?");
    const recalled = await prepare("북쪽 항구에서 파란 우산 잃어버린 적 있어?");
    expect(neutral.request.messages[0]?.content).toContain(voice.trim());
    expect(JSON.stringify(neutral.request.messages)).not.toContain(production);
    expect(JSON.stringify(neutral.request.messages)).not.toContain(event);
    expect(JSON.stringify(recalled.request.messages)).not.toContain(production);
    expect(JSON.stringify(recalled.request.messages)).not.toContain("복사하면 안 되는 예시 답변");
    expect(recalled.request.messages.at(-1)?.content).toContain("북쪽 항구에서 자랐다.");
    expect(recalled.request.messages.at(-1)?.content).toContain(event);
    expect(recalled.request.messages[0]?.content).toEqual(neutral.request.messages[0]?.content);
    expect(await source.get(raw.characterId)).toEqual(raw);
    expect(provider.chatCalls).toHaveLength(0);
    expect(provider.embedCalls).toHaveLength(0);
  });

  it("rejects changed or incompletely mapped canon instead of silently injecting it", async () => {
    const changed = structuredClone(raw);
    const memory = changed.canonMemories[0];
    if (typeof memory === "string" || !memory) throw new Error("fixture canon missing");
    memory.content = "A newer event.";
    const store = new RoutedPersonaStore(new StubPersonaStore([changed]), PersonaRoutingManifest.parse(plan));
    await expect(store.get(raw.characterId)).rejects.toThrow("canon source changed");
    const incomplete = structuredClone(plan);
    incomplete.structuredCharacters[0]!.canon = [];
    const missing = new RoutedPersonaStore(new StubPersonaStore([raw]), PersonaRoutingManifest.parse(incomplete));
    await expect(missing.get(raw.characterId)).rejects.toThrow("canon mapping must cover");
    const duplicate = structuredClone(raw);
    duplicate.canonMemories.push(duplicate.canonMemories[0]!);
    const duplicatePlan = structuredClone(plan);
    duplicatePlan.structuredCharacters[0]!.canon.push({ ...duplicatePlan.structuredCharacters[0]!.canon[0]!, memoryId: "unused" });
    await expect(new RoutedPersonaStore(new StubPersonaStore([duplicate]), PersonaRoutingManifest.parse(duplicatePlan)).get(raw.characterId)).rejects.toThrow("exactly once");
  });
});
