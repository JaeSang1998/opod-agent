import type OpenAI from "openai";

/**
 * The swappable LLM backend. One OpenAI-compatible adapter (docs/adr/0001)
 * implements this for MVP, serving both OpenAI and Ollama by env config. Kept as
 * an interface so a native adapter can be added later without touching callers.
 */
export interface LLMProvider {
  /** Non-streaming chat completion. */
  chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;

  /** Streaming chat completion — yields OpenAI-shaped SSE chunks. */
  chatStream(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;

  /** Embed one or more texts (used for long-term memory read + write). */
  embed(texts: string[]): Promise<number[][]>;

  /** The default model id, used when a request omits `model`. */
  readonly defaultModel: string;
}
