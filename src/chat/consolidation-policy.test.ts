import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../protocol/index.js";
import type { Summary } from "../memory/types.js";
import { decideConsolidation } from "./consolidation-policy.js";

const config = { summaryTurnThreshold: 6 };

function decide(
  messages: ChatMessage[],
  assistantContent = "Got it.",
  summary: Summary | null = null,
  historyOffset = 0,
) {
  return decideConsolidation({ messages, assistantContent, historyOffset, summary }, config);
}

describe("decideConsolidation", () => {
  it("skips a short transient question while the Summary is fresh", () => {
    expect(decide([{ role: "user", content: "What time is it?" }])).toEqual({
      enqueue: false,
      reason: "not-needed",
      refreshSummary: false,
      turns: [],
    });
  });

  it.each([
    "My cat is named Nova.",
    "나는 취리히에서 일하고 있어.",
  ])("enqueues durable personal content: %s", (content) => {
    const result = decide([{ role: "user", content }]);

    expect(result).toMatchObject({
      enqueue: true,
      reason: "memorable-content",
      refreshSummary: true,
    });
    expect(result.turns).toEqual([
      { role: "user", content },
      { role: "assistant", content: "Got it." },
    ]);
  });

  it("enqueues all uncovered conversation turns once the Summary is stale", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you?" },
      { role: "assistant", content: "well" },
      { role: "user", content: "what time is it?" },
    ];

    const result = decide(messages, "Noon.");

    expect(result).toMatchObject({
      enqueue: true,
      reason: "summary-stale",
      refreshSummary: true,
    });
    expect(result.turns).toHaveLength(6);
  });

  it("sends only turns not already covered by the existing Summary", () => {
    const summary: Summary = {
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
      content: "They greeted each other.",
      turnsCovered: 2,
      revision: 1,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "My dog is named Max." },
    ];

    expect(decide(messages, "Lovely.", summary).turns).toEqual([
      { role: "user", content: "My dog is named Max." },
      { role: "assistant", content: "Lovely." },
    ]);
  });

  it("uses an absolute history offset to select the uncovered suffix of a truncated window", () => {
    const summary: Summary = {
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
      content: "A much longer earlier conversation.",
      turnsCovered: 100,
      revision: 2,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "Earlier retained turn" },
      { role: "assistant", content: "Earlier retained reply" },
      { role: "user", content: "My new project is Atlas." },
    ];

    expect(decide(messages, "Tell me more.", summary, 98)).toEqual({
      enqueue: true,
      reason: "memorable-content",
      refreshSummary: true,
      turns: [
        { role: "user", content: "My new project is Atlas." },
        { role: "assistant", content: "Tell me more." },
      ],
    });
  });

  it("still learns the latest memorable exchange when an earlier gap is unverifiable", () => {
    const summary: Summary = {
      userId: "u1",
      characterId: "luna",
      sessionId: "s1",
      content: "Earlier conversation.",
      turnsCovered: 10,
      revision: 2,
      updatedAt: "2026-01-01T00:00:00Z",
    };

    expect(
      decide([{ role: "user", content: "My new project is Atlas." }], "Tell me more.", summary),
    ).toEqual({
      enqueue: true,
      reason: "memorable-content",
      refreshSummary: false,
      turns: [
        { role: "user", content: "My new project is Atlas." },
        { role: "assistant", content: "Tell me more." },
      ],
    });
  });
});
