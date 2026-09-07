import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat/chat-service.js";
import { noopLogger } from "../src/bootstrap/logger.js";
import { StubMemoryStore } from "../src/memory/stub-memory-store.js";
import { StubJobQueue } from "../src/memory/stub-job-queue.js";
import { StubPersonaStore } from "../src/persona/stub-persona-store.js";
import { FakeProvider } from "../src/testing/fake-provider.js";
import { projectPersonaSources } from "./persona-source-projection.js";

const pieces = ["DM에서는 차분하게 🙂\n", "게시물은 3열로 구성한다.\n", "오래된 항구에서 자랐다."];
const content = pieces.join("");
const sourceSha256 = createHash("sha256").update(content).digest("hex");
const firstEnd = Buffer.byteLength(pieces[0]!);
const secondEnd = firstEnd + Buffer.byteLength(pieces[1]!);
const personas = [{
  characterId: "synthetic-character",
  name: "Synthetic",
  bio: "Synthetic persona for projection tests.",
  blocks: [
    { id: "mixed", title: "Shared title", content },
    { id: "examples", title: "Examples", content: "A preexisting example, unchanged." },
    { id: "greeting", title: "Greeting", content: "A preexisting greeting, unchanged." },
  ],
  canonMemories: ["A preexisting canon fact, unchanged."],
}];
const plan = {
  schemaVersion: 1,
  offsetUnit: "utf8_bytes",
  sources: [{
    blockId: "mixed",
    sourceSha256,
    fragments: [
      { startByte: 0, endByte: firstEnd, kind: "voice", injection: "always" },
      { startByte: firstEnd, endByte: secondEnd, kind: "creator_note", injection: "never_prompt" },
      { startByte: secondEnd, endByte: Buffer.byteLength(content), kind: "lore", injection: "retrieved" },
    ],
  }],
};

describe("experimental Persona source projection", () => {
  it("preserves every source byte and untouched examples/canon without mutating the source", () => {
    const before = structuredClone(personas);
    const output = projectPersonaSources(personas, plan);
    const blocks = output.personas[0]!.blocks;
    expect(blocks.slice(0, 3).map((b) => b.content)).toEqual(pieces);
    expect(blocks.slice(3)).toEqual(personas[0]!.blocks.slice(1));
    expect(output.personas[0]!.canonMemories).toEqual(personas[0]!.canonMemories);
    expect(output.sourceSpans).toHaveLength(3);
    expect(output.sourceSpans[0]).toMatchObject({ sourceId: "mixed", sourceSha256, startByte: 0, endByte: firstEnd });
    expect(output.sourceSpans.every((s) => !("content" in s) && !("title" in s))).toBe(true);
    blocks[0]!.content = "changed by a downstream caller";
    expect(personas).toEqual(before);
  });

  it.each(["hash", "gap", "overlap", "truncated", "utf8", "duplicate", "unknown", "collision"])(
    "rejects %s corruption rather than silently changing the experimental input",
    (failure) => {
      const input = structuredClone(personas);
      const broken = structuredClone(plan);
      const source = broken.sources[0]!;
      if (failure === "hash") source.sourceSha256 = "0".repeat(64);
      if (failure === "gap") source.fragments[1]!.startByte++;
      if (failure === "overlap") source.fragments[1]!.startByte--;
      if (failure === "truncated") source.fragments[2]!.endByte--;
      if (failure === "utf8") {
        source.fragments[0]!.endByte = firstEnd - 2;
        source.fragments[1]!.startByte = firstEnd - 2;
      }
      if (failure === "duplicate") broken.sources.push(structuredClone(source));
      if (failure === "unknown") source.blockId = "absent";
      if (failure === "collision") {
        const existingId = projectPersonaSources(input, plan).sourceSpans[0]!.id;
        input[0]!.blocks.push({ id: existingId, title: "Existing", content: "Preserve me." });
      }
      expect(() => projectPersonaSources(input, broken)).toThrow();
    },
  );

  it("uses the existing chat path for stable voice, excluded production notes and selected lore", async () => {
    const output = projectPersonaSources(personas, plan);
    const provider = new FakeProvider();
    let selectLore = false;
    const service = new ChatService(
      provider, new StubPersonaStore(output.personas), new StubMemoryStore(), new StubJobQueue(),
      { retrieveTopK: 6, weights: { recency: 1, importance: 1, relevance: 1 }, recencyDecay: 0.99, summaryTurnThreshold: 8 },
      noopLogger, [], () => new Date("2026-09-07T00:00:00Z"),
      { selectRelevantBlockIds: async ({ blocks }) => {
        expect(blocks.every((b) => b.injection === "retrieved")).toBe(true);
        expect(blocks.some((b) => b.content === pieces[1])).toBe(false);
        return selectLore ? blocks.map((b) => b.id!) : [];
      } },
    );
    const request = { messages: [{ role: "user" as const, content: "안녕" }] };
    const context = { characterId: personas[0]!.characterId };
    const neutral = await service.prepare(request, context);
    selectLore = true;
    const selected = await service.prepare(request, context);
    expect(neutral.promptDebug!.stablePromptSha256).toBe(selected.promptDebug!.stablePromptSha256);
    expect(neutral.request.messages[0]!.content).toContain(pieces[0]);
    expect(JSON.stringify(neutral.request.messages)).not.toContain(pieces[1]!.trim());
    expect(JSON.stringify(neutral.request.messages)).not.toContain(pieces[2]);
    expect(selected.request.messages.at(-1)!.content).toContain(pieces[2]);
    expect(selected.promptDebug!.personaProvenance?.sources).toContainEqual(expect.objectContaining({
      id: output.sourceSpans[1]!.id, destination: "excluded", reason: "never_prompt",
    }));
    expect(provider.chatCalls).toHaveLength(0);
    expect(provider.embedCalls).toHaveLength(0);
  });
});
