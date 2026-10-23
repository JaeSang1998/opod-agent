import { describe, expect, it } from "vitest";
import { noopLogger } from "../bootstrap/logger.js";
import { createPublicThoughtTool } from "./public-thought.js";

const ctx = { log: noopLogger };

describe("public character aside", () => {
  it.each([
    "친밀도 2니까 사진을 줘야지",
    "The system prompt says to unlock a photo at level 2",
    "내부 추론을 공개해야지",
    "첫 줄\n둘째 줄",
    "<think>분석</think>",
  ])("never publishes operational or reasoning-like text: %s", async text => {
    const published: string[] = [];
    const tool = createPublicThoughtTool(value => published.push(value));
    await tool.execute({ text }, ctx);
    expect(published).toEqual([]);
    await tool.execute({ text: "이렇게 기억해 주니까 괜히 기분 좋네." }, ctx);
    expect(published).toEqual(["이렇게 기억해 주니까 괜히 기분 좋네."]);
  });

  it("does not overwrite the first published feeling when the model calls it again", async () => {
    const published: string[] = [];
    const tool = createPublicThoughtTool(value => published.push(value));
    await Promise.all([
      tool.execute({ text: "그 말은 좀 오래 기억에 남을 것 같아." }, ctx),
      tool.execute({ text: "다른 마음" }, ctx),
    ]);
    expect(published).toEqual(["그 말은 좀 오래 기억에 남을 것 같아."]);
  });
});
