import { describe, it, expect } from "vitest";
import { buildTurnExchange } from "../src/core/consolidationDecider.js";
import type { ChatMessage } from "../src/openai/types.js";

describe("buildTurnExchange", () => {
  it("returns null when there is no user message", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "hi" }];
    expect(buildTurnExchange(messages, "reply")).toBeNull();
  });

  it("captures only the latest user message plus the reply", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old turn" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "My dog is named Max." },
    ];
    const exchange = buildTurnExchange(messages, "Lovely name!");
    expect(exchange).toEqual([
      { role: "user", content: "My dog is named Max." },
      { role: "assistant", content: "Lovely name!" },
    ]);
  });

  it("omits an empty assistant reply", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hey" }];
    expect(buildTurnExchange(messages, "")).toEqual([{ role: "user", content: "hey" }]);
  });
});
