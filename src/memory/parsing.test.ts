import { describe, it, expect } from "vitest";
import { parseObservations, parseLines } from "./parsing.js";

describe("grounded observations", () => {
  const source = {
    turns: [{ role: "user" as const, content: "  난 차를 좋아해\n" }, { role: "assistant" as const, content: "내 고양이는 나비야" }],
    turnsStartOffset: 12,
  };
  const reply = (extra: Record<string, unknown>) => JSON.stringify([
    { content: "사용자는 차를 좋아함", importance: 4, memoryType: "user_fact", contextInjectionMode: "retrieved", sourceIndices: [0], ...extra },
  ]);

  it("keeps exact source text and absolute positions, ignoring invented metadata", () => {
    expect(parseObservations(reply({ sourceMessages: [{ content: "fabricated" }], occurredAt: "2026-01-01" }), source)).toEqual([
      { content: "사용자는 차를 좋아함", importance: 4, memoryType: "user_fact", contextInjectionMode: "retrieved", sourceMessages: [
        { role: "user", content: "  난 차를 좋아해\n", position: 12, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ] },
    ]);
  });

  it.each([[], [0, 0], [-1], [2], [0.5], ["0"], [1], [0, 1]].map((sourceIndices) => ({ sourceIndices })))("rejects ungrounded user fact indices $sourceIndices", ({ sourceIndices }) => {
    expect(() => parseObservations(reply({ sourceIndices }), source)).toThrow("Invalid memory observation response");
  });

  it("permits assistant evidence only as episode or interpretation, not a user fact", () => {
    for (const memoryType of ["shared_episode", "interpretation"]) {
      expect(parseObservations(reply({ memoryType, sourceIndices: [1] }), source)[0]).toMatchObject({
        memoryType, sourceMessages: [{ role: "assistant", content: "내 고양이는 나비야", position: 13 }],
      });
    }
  });

  it("allows always injection only for a user-authored user fact", () => {
    expect(
      parseObservations(
        reply({ contextInjectionMode: "always" }),
        source,
      )[0],
    ).toMatchObject({
      memoryType: "user_fact",
      contextInjectionMode: "always",
    });
    expect(() =>
      parseObservations(
        reply({
          memoryType: "shared_episode",
          contextInjectionMode: "always",
        }),
        source,
      ),
    ).toThrow("Invalid memory observation response");
  });

  it("fails closed for unknown positions and invalid memory types, but accepts no-memory output", () => {
    expect(() => parseObservations(reply({}), { turns: source.turns })).toThrow("Invalid memory observation source range");
    expect(() => parseObservations(reply({ memoryType: "canon" }), source)).toThrow("Invalid memory observation response");
    expect(() => parseObservations(reply({ memoryType: undefined }), source)).toThrow("Invalid memory observation response");
    expect(parseObservations("[]", source)).toEqual([]);
  });

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER])("rejects an unverifiable absolute offset %s", (turnsStartOffset) => {
    expect(() => parseObservations(reply({}), { ...source, turnsStartOffset })).toThrow("Invalid memory observation source range");
  });

  it("rejects empty or non-conversation source messages without leaking their contents", () => {
    for (const turn of [{ role: "user" as const, content: " " }, { role: "system" as const, content: "private instructions" }]) {
      expect(() => parseObservations(reply({}), { turns: [turn], turnsStartOffset: 0 }))
        .toThrow(/^Invalid memory observation response$/);
    }
  });
});

describe("parseObservations", () => {
  it("accepts a complete JSON array and trims factual content", () => {
    expect(parseObservations('[{"content":" has a dog ","importance":4}]')).toEqual([
      { content: "has a dog", importance: 4 },
    ]);
  });

  it("accepts one JSON code fence and an explicit empty array", () => {
    expect(parseObservations('```json\n[{"content":"has a dog","importance":4}]\n```')).toEqual([
      { content: "has a dog", importance: 4 },
    ]);
    expect(parseObservations("[]")).toEqual([]);
    expect(parseObservations("```json\r\n[]\r\n```")).toEqual([]);
  });

  it.each([
    "",
    "There is no durable user information.",
    "- likes tea\n- runs daily",
    "10 push-ups every morning",
    'Here you go: [{"content":"has a dog","importance":4}]',
    '[{"content":"private fact","importance":4}',
    '[{"content":"private fact","importance":4}] trailing explanation',
    '["just an observation"]',
    '{"content":"private fact","importance":4}',
    '[{"content":null,"importance":4}]',
    '[{"content":{"private":"fact"},"importance":4}]',
    '[{"content":"   ","importance":4}]',
    '[{"content":"private fact"}]',
    '[{"content":"private fact","importance":"high"}]',
    '[{"content":"private fact","importance":"4"}]',
    '[{"content":"private fact","importance":0}]',
    '[{"content":"private fact","importance":11}]',
    '[{"content":"private fact","importance":4.5}]',
    '[{"content":"valid fact","importance":4},{"importance":6}]',
  ])("rejects malformed extraction without exposing its contents: %s", (response) => {
    expect(() => parseObservations(response)).toThrow(/^Invalid memory observation response$/);
  });
});

describe("parseLines", () => {
  it("strips recognized list markers", () => {
    expect(parseLines("- bullet\n* star")).toEqual(["bullet", "star"]);
    expect(parseLines("1. likes tea\n2) runs daily")).toEqual(["likes tea", "runs daily"]);
  });

  it("preserves a bare leading number as legitimate prose (M4)", () => {
    // A number without a "." or ")" is content, not a list marker.
    expect(parseLines("10 push-ups every morning")).toEqual(["10 push-ups every morning"]);
  });
});
