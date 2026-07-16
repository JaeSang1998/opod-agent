import { describe, it, expect } from "vitest";
import { lastUserMessage, lastUserText, transcriptOf } from "./messages.js";
import type { ChatMessage } from "../protocol/chat.js";

describe("lastUserMessage", () => {
  it("returns the most recent user message when several are present", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    expect(lastUserMessage(messages)).toEqual({ role: "user", content: "second" });
  });

  it("returns null when there are no user messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are a bot" },
      { role: "assistant", content: "hello" },
    ];
    expect(lastUserMessage(messages)).toBeNull();
  });

  it("skips a trailing user message with array-form (multimodal) content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "plain text" },
      { role: "user", content: [{ type: "text", text: "multimodal" }] },
    ];
    // The string-content guard rejects the array, so the earlier string turn wins.
    expect(lastUserMessage(messages)).toEqual({ role: "user", content: "plain text" });
  });

  it("skips user messages whose content is empty or whitespace only", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "kept" },
      { role: "user", content: "   " },
    ];
    // trim().length > 0 drops the whitespace-only trailing turn.
    expect(lastUserMessage(messages)).toEqual({ role: "user", content: "kept" });
  });

  it("returns null for an empty messages array", () => {
    expect(lastUserMessage([])).toBeNull();
  });
});

describe("lastUserText", () => {
  it("returns the text of the most recent user message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old" },
      { role: "user", content: "new" },
    ];
    expect(lastUserText(messages)).toBe("new");
  });

  it("returns null when there is no user text", () => {
    expect(lastUserText([{ role: "assistant", content: "hi" }])).toBeNull();
  });

  it("falls back past a multimodal trailing turn to the last string user message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "string turn" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
    ];
    expect(lastUserText(messages)).toBe("string turn");
  });

  it("returns null for an empty messages array", () => {
    expect(lastUserText([])).toBeNull();
  });
});

describe("transcriptOf", () => {
  it("renders user and assistant turns as `role: content` lines joined by newlines", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
      { role: "user", content: "how are you" },
    ];
    expect(transcriptOf(messages)).toBe("user: hi\nassistant: hello there\nuser: how are you");
  });

  it("omits system, tool, and developer roles", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "persona" },
      { role: "user", content: "ping" },
      { role: "tool", content: "tool result" },
      { role: "developer", content: "dev note" },
      { role: "assistant", content: "pong" },
    ];
    expect(transcriptOf(messages)).toBe("user: ping\nassistant: pong");
  });

  it("skips messages whose content is not a plain string", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "multimodal" }] },
      { role: "assistant", content: null },
      { role: "user", content: "only this survives" },
    ];
    expect(transcriptOf(messages)).toBe("user: only this survives");
  });

  it("returns an empty string for an empty messages array", () => {
    expect(transcriptOf([])).toBe("");
  });
});
