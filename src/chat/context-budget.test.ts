import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../protocol/index.js";
import { fitContextBudget } from "./context-budget.js";

const render = (values: readonly string[]): string | null => values.length ? values.join("\n") : null;
const messages: ChatMessage[] = [{ role: "user", content: "안녕" }];

describe("fitContextBudget", () => {
  it("counts Korean UTF-8 bytes, system text and message envelopes, not characters", () => {
    const input = { system: "가", messages, optionalEntries: [], assembleTurnContext: render };
    // This exact serialized input has 70 UTF-8 bytes; its JS string length is 64.
    const accepted = fitContextBudget({ ...input, maxBytes: 70 });
    expect(accepted.status).toBe("within_budget");
    expect(accepted.bytes).toBe(70);
    expect(fitContextBudget({ ...input, maxBytes: 69 }).status).toBe("overflow");
  });

  it("removes lower-priority whole entries first and keeps retained presentation order", () => {
    const optionalEntries = [
      { id: "low", priority: 1, value: "x".repeat(100) },
      { id: "high", priority: 9, value: "두" },
      { id: "middle", priority: 5, value: "세" },
    ];
    const result = fitContextBudget({
      system: "", messages, optionalEntries, assembleTurnContext: render, maxBytes: 100,
    });
    expect(result.status).toBe("within_budget");
    expect(result.retainedIds).toEqual(["high", "middle"]);
    expect(result.droppedIds).toEqual(["low"]);
    expect(result.bytes).toBeLessThanOrEqual(100);
    if (result.status !== "within_budget") throw new Error("expected assembled messages");
    expect(result.messages[1]?.content).toBe("두\n세\n\n안녕");
    expect(optionalEntries[0]?.value).toHaveLength(100);
  });

  it("retains earlier entries when equal-priority entries cannot all fit", () => {
    const result = fitContextBudget({
      system: "", messages,
      optionalEntries: [
        { id: "first", priority: 2, value: "a".repeat(20) },
        { id: "second", priority: 2, value: "b".repeat(20) },
      ],
      assembleTurnContext: render, maxBytes: 95,
    });
    expect(result.status).toBe("within_budget");
    expect(result.retainedIds).toEqual(["first"]);
    expect(result.droppedIds).toEqual(["second"]);
  });

  it("preserves complete raw history, multimodal content, metadata and the latest user text", () => {
    const history: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "지난 이야기" }] },
      { role: "assistant", content: "그 다음은?", name: "character" },
      { role: "user", content: "그건 됐고 지금 말한 거", trace: "original" },
    ];
    const original = structuredClone(history);
    const result = fitContextBudget({
      system: "required", messages: history,
      optionalEntries: [{ id: "memory", priority: 1, value: "irrelevant".repeat(100) }],
      assembleTurnContext: render, maxBytes: 350,
    });
    expect(result.status).toBe("within_budget");
    if (result.status !== "within_budget") throw new Error("expected assembled messages");
    expect(result.messages).toEqual([{ role: "system", content: "required" }, ...original]);
    expect(history).toEqual(original);
  });

  it("reports mandatory context/history overflow without exposing a truncated prompt", () => {
    const history: ChatMessage[] = [{ role: "user", content: "미해결 내용".repeat(30) }];
    const result = fitContextBudget({
      system: "required", messages: history,
      optionalEntries: [{ id: "extra", priority: 1, value: "extra" }],
      assembleTurnContext: (values) => ["mandatory context", ...values].join("\n"),
      maxBytes: 100,
    });
    expect(result.status).toBe("overflow");
    expect(result.bytes).toBeGreaterThan(100);
    expect(result.retainedIds).toEqual([]);
    expect(result.droppedIds).toEqual(["extra"]);
    expect(result).not.toHaveProperty("messages");
    expect(history[0]?.content).toBe("미해결 내용".repeat(30));
  });

  it.each([70, 69])("includes fixed tool definitions before fitting a %i-byte message allowance", (allowance) => {
    const tools = [{
      type: "function",
      function: {
        name: "recall",
        description: "Find relevant memories for this conversation.",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    }];
    const requestOverheadBytes = Buffer.byteLength(JSON.stringify({ model: "test-model", tools }), "utf8");
    const input = {
      system: "가", messages,
      optionalEntries: [{ id: "memory", priority: 1, value: "배경" }],
      assembleTurnContext: render,
      maxBytes: requestOverheadBytes + allowance,
    };
    // Messages alone fit, but the fixed request fields consume that room.
    expect(fitContextBudget(input).retainedIds).toEqual(["memory"]);
    const result = fitContextBudget({ ...input, requestOverheadBytes });
    expect(result.bytes).toBe(requestOverheadBytes + 70);
    expect(result.retainedIds).toEqual([]);
    expect(result.droppedIds).toEqual(["memory"]);
    expect(result.status).toBe(allowance === 70 ? "within_budget" : "overflow");
    if (result.status === "overflow") expect(result).not.toHaveProperty("messages");
    expect(messages).toEqual([{ role: "user", content: "안녕" }]);
  });
});
