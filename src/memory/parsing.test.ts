import { describe, it, expect } from "vitest";
import { parseObservations, parseLines } from "./parsing.js";

describe("parseObservations", () => {
  it("extracts a JSON array embedded in prose", () => {
    // indexOf('[')/lastIndexOf(']') slice out the array from the surrounding chatter.
    expect(parseObservations('Here you go: [{"content":"has a dog","importance":4}]')).toEqual([
      { content: "has a dog", importance: 4 },
    ]);
  });

  it("falls back to bullet lines with a default mid importance", () => {
    // No JSON array present, so parseLines drives with importance 5.
    expect(parseObservations("- likes tea\n- runs daily")).toEqual([
      { content: "likes tea", importance: 5 },
      { content: "runs daily", importance: 5 },
    ]);
  });

  it("drops objects missing a content field", () => {
    expect(
      parseObservations('[{"importance":6},{"content":"has a dog","importance":4}]'),
    ).toEqual([{ content: "has a dog", importance: 4 }]);
  });

  it("clamps a non-numeric importance to the default 5", () => {
    expect(parseObservations('[{"content":"has a dog","importance":"high"}]')).toEqual([
      { content: "has a dog", importance: 5 },
    ]);
  });

  it("keeps a bare leading number through the bullet fallback (M4)", () => {
    expect(parseObservations("10 push-ups every morning")).toEqual([
      { content: "10 push-ups every morning", importance: 5 },
    ]);
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
