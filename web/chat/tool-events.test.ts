import { describe, expect, it } from "vitest";
import { createToolEventReducer } from "./tool-events";

const call = (callId: string, tool: string, args: string, iteration = 0) => ({
  type: "tool_call",
  callId,
  iteration,
  tool,
  args,
});

const result = (callId: string, tool: string, value: string, iteration = 0) => ({
  type: "tool_result",
  callId,
  iteration,
  tool,
  ms: 12,
  result: value,
});

describe("createToolEventReducer", () => {
  it("opens and closes one part under the provider call id", () => {
    const reduce = createToolEventReducer();
    expect(reduce(call("call-time", "get_time", "{}"))).toEqual({
      id: "tool-0-call-time",
      tool: "get_time",
      args: "{}",
      state: "running",
    });
    expect(reduce(result("call-time", "get_time", "now"))).toEqual({
      id: "tool-0-call-time",
      tool: "get_time",
      args: "{}",
      state: "done",
      ms: 12,
      result: "now",
    });
  });

  it("pairs parallel same-tool results correctly when they finish out of order", () => {
    const reduce = createToolEventReducer();
    reduce(call("call-a", "web_search", '{"q":"a"}'));
    reduce(call("call-b", "web_search", '{"q":"b"}'));

    expect(reduce(result("call-b", "web_search", "rb"))).toMatchObject({
      id: "tool-0-call-b",
      args: '{"q":"b"}',
      result: "rb",
    });
    expect(reduce(result("call-a", "web_search", "ra"))).toMatchObject({
      id: "tool-0-call-a",
      args: '{"q":"a"}',
      result: "ra",
    });
  });

  it("scopes reused provider call ids by iteration", () => {
    const reduce = createToolEventReducer();
    expect(reduce(call("same-id", "get_time", "{}", 0))?.id).toBe("tool-0-same-id");
    expect(reduce(call("same-id", "get_time", "{}", 1))?.id).toBe("tool-1-same-id");
  });

  it("returns null for an unmatched or duplicate result", () => {
    const reduce = createToolEventReducer();
    expect(reduce(result("missing", "get_time", "x"))).toBeNull();
    reduce(call("once", "get_time", "{}"));
    reduce(result("once", "get_time", "x"));
    expect(reduce(result("once", "get_time", "x"))).toBeNull();
  });

  it("returns null for malformed or unknown events", () => {
    const reduce = createToolEventReducer();
    expect(reduce(null)).toBeNull();
    expect(reduce("nope")).toBeNull();
    expect(reduce({ type: "tool_call", iteration: 0, tool: "get_time", args: "{}" })).toBeNull();
    expect(reduce({ ...call("c1", "get_time", "{}"), iteration: "0" })).toBeNull();
    expect(reduce({ type: "something_else", callId: "c1", iteration: 0, tool: "get_time" })).toBeNull();
  });
});
