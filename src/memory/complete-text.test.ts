import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import { FakeProvider } from "../testing/fake-provider.js";
import { completeText } from "./complete-text.js";

async function completeWith(choices: unknown[] | null | undefined): Promise<string> {
  const provider = new FakeProvider();
  vi.spyOn(provider, "chat").mockResolvedValue({
    choices,
  } as OpenAI.Chat.Completions.ChatCompletion);
  return completeText(provider, "Memory instruction", "Synthetic input", {});
}

describe("completeText", () => {
  it.each(["[]", "A supported observation", ""])("returns completed text unchanged: %s", async (content) => {
    await expect(completeWith([
      { finish_reason: "stop", message: { content, refusal: null } },
    ])).resolves.toBe(content);
  });

  it.each([
    { choices: undefined },
    { choices: null },
    { choices: [] },
    { choices: [{ finish_reason: "length", message: { content: "[]" } }] },
    { choices: [{ finish_reason: "content_filter", message: { content: "private fragment" } }] },
    { choices: [{ finish_reason: "tool_calls", message: { content: "[]" } }] },
    { choices: [{ message: { content: "[]" } }] },
    { choices: [{ finish_reason: "stop" }] },
    { choices: [{ finish_reason: "stop", message: { content: null } }] },
    { choices: [{ finish_reason: "stop", message: { content: "[]", refusal: "private refusal" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "[]", tool_calls: [{ id: "tool" }] } }] },
    { choices: [{ finish_reason: "stop", message: { content: "[]", function_call: { name: "tool", arguments: "{}" } } }] },
  ])("rejects incomplete, refused, and non-text responses: $choices", async ({ choices }) => {
    await expect(completeWith(choices)).rejects.toThrow(/^Invalid memory completion response$/);
  });
});
