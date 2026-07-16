import type OpenAI from "openai";

export interface ProviderCallOptions {
  signal?: AbortSignal;
}

/**
 * The swappable LLM Provider. One OpenAI-compatible adapter (docs/adr/0001)
 * implements this for MVP, serving both OpenAI and Ollama by env config. Kept as
 * an interface so a native adapter can be added later without touching callers.
 */
export interface LLMProvider {
  /** Non-streaming chat completion. */
  chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    options?: ProviderCallOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;

  /** Streaming chat completion — yields OpenAI-shaped SSE chunks. */
  chatStream(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    options?: ProviderCallOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;

  /** Embed one or more texts (used for Archival Memory read + write). */
  embed(texts: string[], options?: ProviderCallOptions): Promise<number[][]>;

  /** The default model id, used when a request omits `model`. */
  readonly defaultModel: string;
}
