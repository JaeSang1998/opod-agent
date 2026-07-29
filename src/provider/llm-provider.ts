import type OpenAI from "openai";

export const LLM_LOG_TYPE = {
  chat: "agent.chat",
  chatTool: "agent.chat.tool",
  memoryRetrieveEmbedding: "agent.memory.retrieve.embedding",
  memoryExtract: "agent.memory.extract",
  memoryObservationEmbedding: "agent.memory.observation.embedding",
  memoryReflectionQuestions: "agent.memory.reflection.questions",
  memoryReflectionQuestionEmbedding: "agent.memory.reflection.question.embedding",
  memoryReflectionSynthesis: "agent.memory.reflection.synthesis",
  memoryReflectionEmbedding: "agent.memory.reflection.embedding",
  memoryCoreRewrite: "agent.memory.core.rewrite",
  memorySummary: "agent.memory.summary",
} as const;

type LlmLogType = (typeof LLM_LOG_TYPE)[keyof typeof LLM_LOG_TYPE];

export interface LlmLogContext {
  type: LlmLogType;
  requestId?: string;
  userId?: string;
  characterId?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderCallOptions {
  signal?: AbortSignal;
  log?: LlmLogContext;
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

  /** Optional raw-response variant used by the logging decorator for usage. */
  embedWithResponse?(
    texts: string[],
    options?: ProviderCallOptions,
  ): Promise<{
    embeddings: number[][];
    response: OpenAI.CreateEmbeddingResponse;
  }>;

  /** The default model id, used when a request omits `model`. */
  readonly defaultModel: string;
}
