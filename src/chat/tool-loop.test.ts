import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { type ToolLoopEvent, runToolLoop, runToolLoopStream } from "./tool-loop.js";
import { ScriptedProvider, textTurn, toolCallTurn } from "../testing/scripted-provider.js";
import type { LLMProvider } from "../provider/llm-provider.js";
import type { AgentTool, ToolContext } from "../tools/index.js";
import { noopLogger } from "../bootstrap/logger.js";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;

/** Streams the given per-turn chunk lists in order, so tests can model providers
 *  (e.g. a mixed content-then-tool_calls turn) that ScriptedProvider does not. */
function streamProviderOf(turns: Chunk[][]): LLMProvider {
  let cursor = 0;
  return {
    defaultModel: "custom",
    async chat() {
      throw new Error("chat() not used in this test");
    },
    async chatStream() {
      const chunks = turns[cursor++] ?? [];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
    async embed(texts: string[]) {
      return texts.map(() => [0]);
    },
  };
}

function chunk(
  delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta,
  finish: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"] = null,
): Chunk {
  return {
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "custom",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** A gemma-style reasoning fragment: role on every chunk plus the nonstandard
 *  `reasoning` delta field, no content/tool_calls. */
function reasoningChunk(text: string): Chunk {
  return chunk({
    role: "assistant",
    reasoning: text,
  } as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta);
}

/** The nonstandard reasoning fragment a chunk carries (or ""). */
function reasoningOf(c: Chunk): string {
  const r = (c.choices[0]?.delta as Record<string, unknown> | undefined)?.reasoning;
  return typeof r === "string" ? r : "";
}

const ctx: ToolContext = { log: noopLogger };

function baseRequest(): Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, "stream"> {
  return { model: "scripted-model", messages: [{ role: "user", content: "hi" }] };
}

/** A tool that records the args it received and returns a canned result. */
function makeTool(
  name: string,
  result: string | ((args: unknown) => string | Promise<string>),
): { tool: AgentTool; calls: unknown[] } {
  const calls: unknown[] = [];
  const tool: AgentTool = {
    definition: { type: "function", function: { name, parameters: { type: "object", properties: {} } } },
    async execute(args) {
      calls.push(args);
      return typeof result === "function" ? await result(args) : result;
    },
  };
  return { tool, calls };
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

describe("runToolLoop", () => {
  it("runs a single tool round-trip and returns the final text completion", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "call_1", name: "get_time", arguments: '{"timezone":"UTC"}' }]),
      textTurn("It is noon."),
    ]);
    const { tool, calls } = makeTool("get_time", "2026-07-16 12:00 in UTC");

    const result = await runToolLoop({ provider, request: baseRequest(), tools: [tool], ctx });

    expect(result.choices[0]?.message?.content).toBe("It is noon.");
    expect(calls[0]).toEqual({ timezone: "UTC" });

    // The first call offers tools with tool_choice "auto".
    expect(provider.requests[0]?.tool_choice).toBe("auto");
    expect(provider.requests[0]?.tools?.map((t) => t.function.name)).toEqual(["get_time"]);

    // The second call carries the assistant tool_call message and its tool result.
    const second = provider.requests[1]!.messages as Msg[];
    const assistant = second.find(
      (m): m is OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam =>
        m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
    );
    expect(assistant?.tool_calls?.[0]?.id).toBe("call_1");
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("2026-07-16 12:00 in UTC");
    expect((toolMsg as OpenAI.Chat.Completions.ChatCompletionToolMessageParam).tool_call_id).toBe("call_1");
  });

  it("runs parallel tool calls in a single turn, preserving order", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([
        { id: "c1", name: "get_time", arguments: "{}" },
        { id: "c2", name: "get_weather", arguments: '{"location":"Zurich"}' },
      ]),
      textTurn("Noon and sunny."),
    ]);
    const time = makeTool("get_time", "noon");
    const weather = makeTool("get_weather", "sunny");

    const result = await runToolLoop({
      provider,
      request: baseRequest(),
      tools: [time.tool, weather.tool],
      ctx,
    });

    expect(result.choices[0]?.message?.content).toBe("Noon and sunny.");
    const second = provider.requests[1]!.messages as Msg[];
    const toolMsgs = second.filter((m) => m.role === "tool") as OpenAI.Chat.Completions.ChatCompletionToolMessageParam[];
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(toolMsgs.map((m) => m.content)).toEqual(["noon", "sunny"]);
  });

  it("forces tool_choice \"none\" on the final allowed iteration", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
      toolCallTurn([{ id: "c2", name: "get_time", arguments: "{}" }]),
    ]);
    const { tool } = makeTool("get_time", "noon");

    await runToolLoop({ provider, request: baseRequest(), tools: [tool], ctx, maxIterations: 2 });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tool_choice).toBe("auto");
    expect(provider.requests[1]?.tool_choice).toBe("none");
  });

  it("on iteration exhaustion returns a tool-call-free stop turn, never leaking tool_calls", async () => {
    // The model keeps requesting tools on every turn, including the forced-"none"
    // final one (a local model that ignores tool_choice:"none"); the loop must not
    // hand the server's internal tool_calls back to the client.
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
    ]);
    const { tool } = makeTool("get_time", "noon");

    const result = await runToolLoop({
      provider,
      request: baseRequest(),
      tools: [tool],
      ctx,
      maxIterations: 2,
    });

    const message = result.choices[0]?.message;
    expect(message?.tool_calls).toBeUndefined();
    expect(message?.content).toBe("");
    expect(result.choices[0]?.finish_reason).toBe("stop");
  });

  it("hands a tool execution error back to the model as the tool message", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "boom", arguments: "{}" }]),
      textTurn("Handled it."),
    ]);
    const { tool } = makeTool("boom", () => {
      throw new Error("kaboom");
    });

    const result = await runToolLoop({ provider, request: baseRequest(), tools: [tool], ctx });

    expect(result.choices[0]?.message?.content).toBe("Handled it.");
    const second = provider.requests[1]!.messages as Msg[];
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("boom failed: kaboom");
  });

  it("executes a repeated tool call id only once", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "same-call", name: "get_time", arguments: "{}" }]),
      toolCallTurn([{ id: "same-call", name: "get_time", arguments: "{}" }]),
      textTurn("Still noon."),
    ]);
    const time = makeTool("get_time", "noon");

    const result = await runToolLoop({
      provider,
      request: baseRequest(),
      tools: [time.tool],
      ctx,
      maxIterations: 3,
    });

    expect(result.choices[0]?.message?.content).toBe("Still noon.");
    expect(time.calls).toHaveLength(1);
  });

  it("emits tool_call then tool_result to onEvent with correct fields", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: '{"timezone":"UTC"}' }]),
      textTurn("It is noon."),
    ]);
    const { tool } = makeTool("get_time", "2026-07-16 12:00 in UTC");
    const events: ToolLoopEvent[] = [];

    await runToolLoop({
      provider,
      request: baseRequest(),
      tools: [tool],
      ctx,
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "tool_call",
      iteration: 0,
      tool: "get_time",
      args: '{"timezone":"UTC"}',
    });
    const result = events[1];
    expect(result?.type).toBe("tool_result");
    if (result?.type !== "tool_result") throw new Error("expected tool_result");
    expect(result.iteration).toBe(0);
    expect(result.tool).toBe("get_time");
    expect(typeof result.ms).toBe("number");
    expect(result.result).toBe("2026-07-16 12:00 in UTC");
  });

  it("a throwing onEvent never breaks the reply", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
      textTurn("Handled anyway."),
    ]);
    const { tool } = makeTool("get_time", "noon");

    const result = await runToolLoop({
      provider,
      request: baseRequest(),
      tools: [tool],
      ctx,
      onEvent: () => {
        throw new Error("listener boom");
      },
    });

    expect(result.choices[0]?.message?.content).toBe("Handled anyway.");
  });
});

describe("runToolLoopStream", () => {
  async function collect(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  ): Promise<OpenAI.Chat.Completions.ChatCompletionChunk[]> {
    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }

  it("suppresses the tool turn entirely and streams only the final text turn", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: '{"timezone":"UTC"}' }]),
      textTurn("The time is noon."),
    ]);
    const { tool, calls } = makeTool("get_time", "noon");

    const chunks = await collect(
      runToolLoopStream({ provider, request: baseRequest(), tools: [tool], ctx }),
    );

    // No chunk ever carries a tool_calls delta or a tool_calls finish reason.
    expect(chunks.some((c) => c.choices[0]?.delta?.tool_calls)).toBe(false);
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "tool_calls")).toBe(false);

    // Only the final text turn reaches the client, with its natural finish chunk.
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe("The time is noon.");
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);

    // The tool still ran, with the reassembled arguments.
    expect(calls[0]).toEqual({ timezone: "UTC" });
  });

  it("reassembles fragmented tool_call arguments before invoking the tool", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_weather", arguments: '{"location":"Zurich"}' }]),
      textTurn("Sunny in Zurich."),
    ]);
    const { tool, calls } = makeTool("get_weather", "sunny");

    const chunks = await collect(
      runToolLoopStream({ provider, request: baseRequest(), tools: [tool], ctx }),
    );

    // The streamed fragments were concatenated back into valid JSON args.
    expect(calls[0]).toEqual({ location: "Zurich" });
    // The second request carries the tool result message.
    const second = provider.requests[1]!.messages as Msg[];
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("sunny");
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("Sunny in Zurich.");
  });

  it("executes a repeated streamed tool call id only once", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "same-call", name: "get_weather", arguments: '{"location":"Zurich"}' }]),
      toolCallTurn([{ id: "same-call", name: "get_weather", arguments: '{"location":"Zurich"}' }]),
      textTurn("Sunny."),
    ]);
    const weather = makeTool("get_weather", "sunny");

    const chunks = await collect(
      runToolLoopStream({
        provider,
        request: baseRequest(),
        tools: [weather.tool],
        ctx,
        maxIterations: 3,
      }),
    );

    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("Sunny.");
    expect(weather.calls).toHaveLength(1);
  });

  it("on iteration exhaustion emits a well-formed tool-call-free stop turn (never a blank stream)", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
    ]);
    const { tool } = makeTool("get_time", "noon");

    const chunks = await collect(
      runToolLoopStream({ provider, request: baseRequest(), tools: [tool], ctx, maxIterations: 2 }),
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.choices[0]?.delta?.tool_calls)).toBe(false);
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "tool_calls")).toBe(false);
    // A well-formed final turn: a stop finish reason and no leaked text.
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("");
    // At most one role delta opens the stream.
    expect(chunks.filter((c) => c.choices[0]?.delta?.role).length).toBe(1);
  });

  it("emits only one role delta when a mixed content-then-tool_calls turn precedes a text turn", async () => {
    // Turn 1 streams text then tool_calls (some models do this); turn 2 is plain text.
    const provider = streamProviderOf([
      [
        chunk({ role: "assistant" }),
        chunk({ content: "Let me check... " }),
        chunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_time", arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
      ],
      [chunk({ role: "assistant" }), chunk({ content: "It is noon." }), chunk({}, "stop")],
    ]);
    const { tool } = makeTool("get_time", "noon");

    const chunks = await collect(
      runToolLoopStream({ provider, request: baseRequest(), tools: [tool], ctx }),
    );

    // Exactly one role delta reaches the client across the whole stream.
    expect(chunks.filter((c) => c.choices[0]?.delta?.role).length).toBe(1);
    // No tool_calls ever leak; the stream still finishes cleanly.
    expect(chunks.some((c) => c.choices[0]?.delta?.tool_calls)).toBe(false);
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "tool_calls")).toBe(false);
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
    // The visible text is the pre-tool preamble plus the final answer.
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe(
      "Let me check... It is noon.",
    );
  });

  it("streams gemma-style reasoning live across a tool turn and a text turn", async () => {
    // Turn 1 (tool): reasoning fragments (role on EVERY chunk), then a tool_calls
    // fragment, then the tool_calls finish. Turn 2 (text): reasoning then content.
    const provider = streamProviderOf([
      [
        reasoningChunk("weighing "),
        reasoningChunk("options "),
        chunk({
          role: "assistant",
          tool_calls: [
            { index: 0, id: "c1", type: "function", function: { name: "get_time", arguments: "{}" } },
          ],
        }),
        chunk({ role: "assistant" }, "tool_calls"),
      ],
      [
        reasoningChunk("almost there "),
        chunk({ role: "assistant", content: "It is noon." }),
        chunk({ role: "assistant" }, "stop"),
      ],
    ]);
    const { tool } = makeTool("get_time", "noon");

    const chunks = await collect(
      runToolLoopStream({ provider, request: baseRequest(), tools: [tool], ctx }),
    );

    // Reasoning from BOTH the tool turn (before its tool_calls) and the text turn
    // reaches the client, live.
    expect(chunks.map(reasoningOf).join("")).toBe("weighing options almost there ");
    // The text turn's content reaches the client.
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("It is noon.");
    // Exactly one role delta total, and zero tool_calls deltas.
    expect(chunks.filter((c) => c.choices[0]?.delta?.role).length).toBe(1);
    expect(chunks.some((c) => c.choices[0]?.delta?.tool_calls)).toBe(false);
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "tool_calls")).toBe(false);
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
  });

  it("emits tool_call then tool_result to onEvent with correct fields", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_weather", arguments: '{"location":"Zurich"}' }]),
      textTurn("Sunny."),
    ]);
    const { tool } = makeTool("get_weather", "sunny in Zurich");
    const events: ToolLoopEvent[] = [];

    await collect(
      runToolLoopStream({
        provider,
        request: baseRequest(),
        tools: [tool],
        ctx,
        onEvent: (e) => events.push(e),
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "tool_call",
      iteration: 0,
      tool: "get_weather",
      args: '{"location":"Zurich"}',
    });
    const result = events[1];
    if (result?.type !== "tool_result") throw new Error("expected tool_result");
    expect(result.iteration).toBe(0);
    expect(result.tool).toBe("get_weather");
    expect(typeof result.ms).toBe("number");
    expect(result.result).toBe("sunny in Zurich");
  });

  it("a throwing onEvent never breaks the reply", async () => {
    const provider = new ScriptedProvider([
      toolCallTurn([{ id: "c1", name: "get_time", arguments: "{}" }]),
      textTurn("The time is noon."),
    ]);
    const { tool } = makeTool("get_time", "noon");

    const chunks = await collect(
      runToolLoopStream({
        provider,
        request: baseRequest(),
        tools: [tool],
        ctx,
        onEvent: () => {
          throw new Error("listener boom");
        },
      }),
    );

    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("The time is noon.");
  });
});
