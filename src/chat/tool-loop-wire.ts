import type OpenAI from "openai";

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Delta = Chunk["choices"][number]["delta"];
type DeltaToolCall = Delta["tool_calls"] extends (infer T)[] | undefined ? T : never;
type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

/** Allowlist public deltas and emit the assistant role once; never stream reasoning. */
export function createClientChunkFilter(): (chunk: Chunk) => Chunk | null {
  let roleSent = false;
  return (chunk) => {
    const choices = chunk.choices.map(choice => {
      const delta: Delta = {};
      if (choice.delta.role && !roleSent) {
        delta.role = choice.delta.role;
        roleSent = true;
      }
      if (choice.delta.content != null) delta.content = choice.delta.content;
      if (choice.delta.refusal != null) delta.refusal = choice.delta.refusal;
      return { index: choice.index, delta, finish_reason: choice.finish_reason, logprobs: null };
    });
    if (!chunk.usage && choices.every(choice => !choice.delta.role && !choice.delta.content && !choice.delta.refusal && !choice.finish_reason)) return null;
    return {
      id: chunk.id, object: chunk.object, created: chunk.created, model: chunk.model,
      choices,
      ...(chunk.usage ? { usage: chunk.usage } : {}),
    };
  };
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
