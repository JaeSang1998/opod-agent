import type OpenAI from "openai";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Delta = Chunk["choices"][number]["delta"];
type DeltaToolCall = Delta["tool_calls"] extends (infer T)[] | undefined ? T : never;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

/** Keeps only the first streamed assistant role while preserving later payload fields. */
export function createClientChunkFilter(): (chunk: Chunk) => Chunk | null {
  let roleSent = false;
  return (chunk) => {
    const choice = chunk.choices[0];
    const delta = choice?.delta;
    if (!delta?.role) return chunk;
    if (!roleSent) {
      roleSent = true;
      return chunk;
    }

    const { role: _role, ...rest } = delta;
    const hasMore =
      rest.content != null ||
      rest.tool_calls != null ||
      reasoningOf(rest) !== "" ||
      choice?.finish_reason != null;
    if (!hasMore) return null;
    return { ...chunk, choices: [{ ...choice, delta: rest }] } as Chunk;
  };
}

/** Reads the nonstandard reasoning string emitted by some local Providers. */
export function reasoningOf(delta: Delta | undefined): string {
  const value = (delta as Record<string, unknown> | undefined)?.reasoning;
  return typeof value === "string" ? value : "";
}

/** Rewrites an exhausted completion into a tool-call-free stop turn. */
export function toStopCompletion(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): OpenAI.Chat.Completions.ChatCompletion {
  const choice = completion.choices[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  return {
    ...completion,
    choices: [
      {
        index: choice?.index ?? 0,
        logprobs: choice?.logprobs ?? null,
        finish_reason: "stop",
        message: { role: "assistant", content, refusal: choice?.message?.refusal ?? null },
      },
    ],
  };
}

/** A minimal empty completion for a disabled iteration budget. */
export function emptyCompletion(model: string): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "chatcmpl-tool-loop",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: "stop",
        message: { role: "assistant", content: "", refusal: null },
      },
    ],
  } as OpenAI.Chat.Completions.ChatCompletion;
}

/** A single empty chunk that closes an exhausted stream. */
export function stopChunk(model: string): Chunk {
  return {
    id: "chatcmpl-tool-loop",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
  };
}

/** Merges one indexed streamed tool-call fragment into its accumulator. */
export function assembleToolCall(acc: ToolCall[], fragment: DeltaToolCall): void {
  const current = acc[fragment.index] ?? {
    id: "",
    type: "function",
    function: { name: "", arguments: "" },
  };
  if (fragment.id) current.id = fragment.id;
  if (fragment.function?.name) current.function.name = fragment.function.name;
  if (fragment.function?.arguments) current.function.arguments += fragment.function.arguments;
  acc[fragment.index] = current;
}
