import { describe, expect, it } from "vitest";
import { contextRecallQuery, KeyphrasePersonaBlockSelector, selectCharacterRecallIds } from "./character-recall.js";

describe("authored keyphrase recall", () => {
  it("uses the immediately preceding exchange only for a referential query and resets on topic cut", () => {
    const history = [
      { role: "user" as const, content: "커피 뭐 좋아해?" },
      { role: "assistant" as const, content: "아메리카노요." },
    ];
    expect(contextRecallQuery([...history, { role: "user", content: "그거 따뜻한 거?" }])).toBe("커피 뭐 좋아해?\n아메리카노요.\n그거 따뜻한 거?");
    expect(contextRecallQuery([...history, { role: "user", content: "커피 말고 음악은?" }])).toBe(" 음악은?");
    expect(contextRecallQuery([...history, { role: "user", content: "오늘 버스 놓쳤어" }])).toBe("오늘 버스 놓쳤어");
    expect(contextRecallQuery([...history, { role: "user", content: "그래픽카드 추천해줘" }])).toBe("그래픽카드 추천해줘");
    expect(contextRecallQuery([...history, { role: "user", content: "응급실에 있어" }])).toBe("응급실에 있어");
  });
  it("normalizes matching, bounds recalled items and never fills unmatched slots", () => {
    const sources = Array.from({ length: 6 }, (_, i) => ({ id: String(i), recallKeys: ["ＡＥ－１"] }));
    expect(selectCharacterRecallIds("ae-1 처음 샀을 때?", sources)).toEqual(["0", "1", "2", "3"]);
    expect(selectCharacterRecallIds("뭐해?", sources)).toEqual([]);
    expect(selectCharacterRecallIds("", [{ id: "empty", recallKeys: [" "] }])).toEqual([]);
    expect(selectCharacterRecallIds("ae-1", [{ id: "no-keys" }, { recallKeys: ["ae-1"] }])).toEqual([]);
  });

  it("searches only the supplied character scope, with no cached cross-character results", async () => {
    const selector = new KeyphrasePersonaBlockSelector();
    const block = { id: "a-memory", title: "Lore", content: "A's history", recallKeys: ["항구"] };
    expect(await selector.selectRelevantBlockIds({ characterId: "a", query: "항구", blocks: [block] })).toEqual(["a-memory"]);
    expect(await selector.selectRelevantBlockIds({ characterId: "b", query: "항구", blocks: [] })).toEqual([]);
  });

  it("keeps only the new subject after an explicit topic cut", () => {
    const sources = [
      { id: "coffee", content: "Likes iced coffee.", recallKeys: ["커피"] },
      { id: "music", content: "Likes rock.", recallKeys: ["음악"] },
    ];
    expect(selectCharacterRecallIds("커피 얘기는 됐고, 심심해요", sources)).toEqual([]);
    expect(selectCharacterRecallIds("커피 말고 음악은 뭐 들어?", sources)).toEqual(["music"]);
  });

  it("resolves a short referential follow-up from one previous user turn, not every old topic", () => {
    const sources = [{ id: "coffee", content: "Coffee after meals.", recallKeys: ["커피"] }];
    expect(selectCharacterRecallIds("그거 언제 마셔?", sources, "커피는 뭐 좋아해?")).toEqual(["coffee"]);
    expect(selectCharacterRecallIds("오늘 버스 놓쳤어", sources, "커피는 뭐 좋아해?")).toEqual([]);
    expect(selectCharacterRecallIds("그건 됐고 다른 얘기 하자", sources, "커피는 뭐 좋아해?")).toEqual([]);
    expect(selectCharacterRecallIds("그거 언제 마셔?", sources)).toEqual([]);
    expect(selectCharacterRecallIds("그거 언제 마셔?", sources, "커피 말고 음악은 뭐 좋아해?")).toEqual([]);
    expect(selectCharacterRecallIds("그거 말고 커피는?", [
      ...sources, { id: "music", recallKeys: ["음악"] },
    ], "음악은 뭐 좋아해?")).toEqual(["coffee"]);
    expect(selectCharacterRecallIds("그거 음악 말하는 거야?", [
      ...sources, { id: "music", recallKeys: ["음악"] },
    ], "커피는 뭐 좋아해?")).toEqual(["music"]);
    expect(selectCharacterRecallIds(`그거 ${"자".repeat(120)}`, sources, "커피는 뭐 좋아해?")).toEqual([]);
    expect(selectCharacterRecallIds("그거 언제 마셔?", sources, `커피 ${"자".repeat(256)}`)).toEqual([]);
  });

  it("prefers specific cues, skips oversized entries and does not repeat identical content", () => {
    const sources = [
      { id: "oversized", content: "x".repeat(1201), recallKeys: ["민서 호캉스"] },
      { id: "broad", content: "A broad event.", recallKeys: ["민서"] },
      { id: "specific", content: "A specific event.", recallKeys: ["민서 호캉스"] },
      { id: "duplicate", content: "  A specific event.  ", recallKeys: ["민서 호캉스"] },
    ];
    expect(selectCharacterRecallIds("민서 호캉스 어땠어?", sources)).toEqual(["specific", "broad"]);
    expect(selectCharacterRecallIds("민서", [
      { id: "one", content: "x".repeat(700), recallKeys: ["민서"] },
      { id: "two", content: "y".repeat(600), recallKeys: ["민서"] },
      { id: "short", content: "z".repeat(100), recallKeys: ["민서"] },
    ])).toEqual(["one", "short"]);
    expect(selectCharacterRecallIds("민서", [
      { id: "unicode", content: "😀".repeat(1200), recallKeys: ["민서"] },
      { id: "over-budget", content: "a", recallKeys: ["민서"] },
    ])).toEqual(["unicode"]);
  });
});
