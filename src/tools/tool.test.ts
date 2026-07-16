import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { executeToolCall, type AgentTool, type ToolContext } from "./tool.js";
import { noopLogger } from "../bootstrap/logger.js";

const ctx: ToolContext = { log: noopLogger };

function toolCall(
  name: string,
  args: string,
): OpenAI.Chat.Completions.ChatCompletionMessageToolCall {
  return { id: "call_1", type: "function", function: { name, arguments: args } };
}

const echoTool: AgentTool = {
  definition: {
    type: "function",
    function: { name: "echo", parameters: { type: "object", properties: {} } },
  },
  async execute(args) {
    return `echo: ${JSON.stringify(args)}`;
  },
};

const throwingTool: AgentTool = {
  definition: {
    type: "function",
    function: { name: "boom", parameters: { type: "object", properties: {} } },
  },
  async execute() {
    throw new Error("kaboom");
  },
};

describe("executeToolCall", () => {
  it("dispatches to the named tool and returns its output", async () => {
    const out = await executeToolCall([echoTool], toolCall("echo", '{"a":1}'), ctx);
    expect(out).toBe('echo: {"a":1}');
  });

  it("returns an error string for an unknown tool (never throws)", async () => {
    const out = await executeToolCall([echoTool], toolCall("nope", "{}"), ctx);
    expect(out).toContain("nope");
    expect(out).toContain("unknown tool");
  });

  it("returns an error string for malformed JSON arguments", async () => {
    const out = await executeToolCall([echoTool], toolCall("echo", "{not json"), ctx);
    expect(out).toContain("echo failed");
    expect(out.toLowerCase()).toContain("json");
  });

  it("treats empty arguments as an empty object", async () => {
    const out = await executeToolCall([echoTool], toolCall("echo", ""), ctx);
    expect(out).toBe("echo: {}");
  });

  it("catches a thrown execute() and returns a readable error string", async () => {
    const out = await executeToolCall([throwingTool], toolCall("boom", "{}"), ctx);
    expect(out).toBe("boom failed: kaboom");
  });
});
