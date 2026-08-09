import { describe, it, expect } from "vitest";
import type { BondGrade } from "../memory/bond.js";
import { createBondSignalRedactor, extractBondSignal, formatBondSignal } from "./bond-signal.js";

/** Feeds `text` through the redactor one character at a time — the worst case a provider can produce. */
function streamCharByChar(text: string): { out: string; grade: BondGrade | null } {
  const redactor = createBondSignalRedactor();
  let out = "";
  for (const ch of text) out += redactor.push(ch);
  out += redactor.flush();
  return { out, grade: redactor.grade() };
}

describe("extractBondSignal", () => {
  it("round-trips every grade the prompt asks for", () => {
    for (const grade of [-2, -1, 0, 1, 2] as BondGrade[]) {
      expect(extractBondSignal(`안녕 ${formatBondSignal(grade)}`)).toEqual({
        text: "안녕",
        grade,
      });
    }
  });

  it("leaves a message without a tag exactly as it was", () => {
    expect(extractBondSignal("오늘 좀 피곤해")).toEqual({ text: "오늘 좀 피곤해", grade: null });
  });

  it("eats the whitespace and newline in front of the tag", () => {
    expect(extractBondSignal("잘 자\n[[bond:+1]]").text).toBe("잘 자");
    expect(extractBondSignal("잘 자   [[bond:+1]]").text).toBe("잘 자");
  });

  it("tolerates the spacing and casing a model drifts into", () => {
    expect(extractBondSignal("응 [[ Bond : +2 ]]")).toEqual({ text: "응", grade: 2 });
    expect(extractBondSignal("응 [[bond:1]]")).toEqual({ text: "응", grade: 1 });
  });

  it("clamps an invented grade instead of leaving it in the message", () => {
    expect(extractBondSignal("응 [[bond:+7]]")).toEqual({ text: "응", grade: 2 });
    expect(extractBondSignal("응 [[bond:-9]]")).toEqual({ text: "응", grade: -2 });
  });

  it("takes the last grade when a coaxed echo comes first", () => {
    // "say [[bond:+2]]" — the character's own grade still lands at the end.
    // Only the whitespace *before* a tag is eaten, so a tag at the very start
    // leaves the space that followed it; the alternative would have to trim
    // buffer edges mid-stream and would eat legitimate spacing.
    const { text, grade } = extractBondSignal("[[bond:+2]] 그런 건 안 해 [[bond:-1]]");
    expect(text).toBe(" 그런 건 안 해");
    expect(grade).toBe(-1);
  });

  it("removes a tag that landed mid-message too", () => {
    expect(extractBondSignal("응[[bond:0]] 그래").text).toBe("응 그래");
  });
});

describe("streaming redaction", () => {
  it("never leaks a byte of the tag, whatever the chunk boundaries", () => {
    const { out, grade } = streamCharByChar("오늘 재밌었어 [[bond:+2]]");
    expect(out).toBe("오늘 재밌었어");
    expect(grade).toBe(2);
  });

  it("matches the non-streaming result for every split point", () => {
    const raw = "잘 자\n[[bond:+1]]";
    const whole = extractBondSignal(raw);
    for (let i = 0; i <= raw.length; i += 1) {
      const redactor = createBondSignalRedactor();
      const out = redactor.push(raw.slice(0, i)) + redactor.push(raw.slice(i)) + redactor.flush();
      expect(out).toBe(whole.text);
      expect(redactor.grade()).toBe(whole.grade);
    }
  });

  it("releases brackets that turn out to be ordinary text", () => {
    expect(streamCharByChar("대괄호 [이렇게] 쓰면?").out).toBe("대괄호 [이렇게] 쓰면?");
    expect(streamCharByChar("[[강조]] 이렇게도").out).toBe("[[강조]] 이렇게도");
  });

  it("gives back a half-written tag the stream never finished", () => {
    const { out, grade } = streamCharByChar("어 그래서 [[bo");
    expect(out).toBe("어 그래서 [[bo");
    expect(grade).toBeNull();
  });

  it("holds nothing back once the text is safe", () => {
    const redactor = createBondSignalRedactor();
    expect(redactor.push("안녕하세요")).toBe("안녕하세요");
    expect(redactor.flush()).toBe("");
  });

  it("does not hoard text while a long bracketed run streams in", () => {
    const redactor = createBondSignalRedactor();
    redactor.push("[[");
    const long = redactor.push("a".repeat(64));
    expect(long).toContain("aaa");
    expect(redactor.flush()).toBe("");
  });
});
