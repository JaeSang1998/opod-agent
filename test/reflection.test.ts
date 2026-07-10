import { describe, it, expect } from "vitest";
import { parseLines, parseInsights } from "../src/memory/parsing.js";
import type { LongTermMemory } from "../src/memory/types.js";

function obs(id: string, content: string): LongTermMemory {
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
