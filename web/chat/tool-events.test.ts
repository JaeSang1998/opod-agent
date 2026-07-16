import { describe, expect, it } from "vitest";
import { createToolEventReducer } from "./tool-events";

describe("createToolEventReducer", () => {
  it("opens a running part on tool_call and closes it on tool_result under one id", () => {
    const reduce = createToolEventReducer();
    const running = reduce({ type: "tool_call", iteration: 0, tool: "get_time", args: "{}" });
    expect(running).toEqual({
      id: "tool-0-get_time-0",
      tool: "get_time",
      args: "{}",
      state: "running",
    });

    const done = reduce({ type: "tool_result", iteration: 0, tool: "get_time", ms: 12, result: "now" });
    expect(done).toEqual({
      id: "tool-0-get_time-0",
      tool: "get_time",
      args: "{}",
      state: "done",
      ms: 12,
      result: "now",
    });
  });

  it("pairs two calls of the same tool in one iteration FIFO", () => {
    const reduce = createToolEventReducer();
    const a = reduce({ type: "tool_call", iteration: 0, tool: "web_search", args: "{\"q\":\"a\"}" });
    const b = reduce({ type: "tool_call", iteration: 0, tool: "web_search", args: "{\"q\":\"b\"}" });
    expect(a?.id).toBe("tool-0-web_search-0");
    expect(b?.id).toBe("tool-0-web_search-1");

    const firstDone = reduce({ type: "tool_result", iteration: 0, tool: "web_search", ms: 5, result: "ra" });
    const secondDone = reduce({ type: "tool_result", iteration: 0, tool: "web_search", ms: 6, result: "rb" });
    expect(firstDone).toMatchObject({ id: "tool-0-web_search-0", args: "{\"q\":\"a\"}", result: "ra" });
    expect(secondDone).toMatchObject({ id: "tool-0-web_search-1", args: "{\"q\":\"b\"}", result: "rb" });
  });

  it("gives calls of the same tool in different iterations distinct ids", () => {
    const reduce = createToolEventReducer();
    const i0 = reduce({ type: "tool_call", iteration: 0, tool: "get_time", args: "{}" });
    const i1 = reduce({ type: "tool_call", iteration: 1, tool: "get_time", args: "{}" });
    expect(i0?.id).toBe("tool-0-get_time-0");
    expect(i1?.id).toBe("tool-1-get_time-0");
  });

  it("preserves the original args on the done part", () => {
    const reduce = createToolEventReducer();
    reduce({ type: "tool_call", iteration: 2, tool: "get_weather", args: "{\"city\":\"seoul\"}" });
    const done = reduce({ type: "tool_result", iteration: 2, tool: "get_weather", ms: 30, result: "sunny" });
    expect(done?.args).toBe("{\"city\":\"seoul\"}");
  });

  it("returns null for a result with no matching call", () => {
    const reduce = createToolEventReducer();
    expect(reduce({ type: "tool_result", iteration: 0, tool: "get_time", ms: 1, result: "x" })).toBeNull();
  });

  it("returns null for a duplicate result", () => {
    const reduce = createToolEventReducer();
    reduce({ type: "tool_call", iteration: 0, tool: "get_time", args: "{}" });
    reduce({ type: "tool_result", iteration: 0, tool: "get_time", ms: 1, result: "x" });
    expect(reduce({ type: "tool_result", iteration: 0, tool: "get_time", ms: 1, result: "x" })).toBeNull();
  });

  it("returns null for malformed or unknown events", () => {
    const reduce = createToolEventReducer();
    expect(reduce(null)).toBeNull();
    expect(reduce("nope")).toBeNull();
    expect(reduce({ type: "tool_call", iteration: 0, tool: "get_time" })).toBeNull();
    expect(reduce({ type: "tool_call", iteration: "0", tool: "get_time", args: "{}" })).toBeNull();
    expect(reduce({ type: "tool_result", iteration: 0, tool: "get_time", result: "x" })).toBeNull();
    expect(reduce({ type: "something_else", iteration: 0, tool: "get_time" })).toBeNull();
  });
});
