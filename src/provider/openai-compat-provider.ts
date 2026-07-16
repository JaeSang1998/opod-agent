import OpenAI from "openai";
import type { LLMProvider, ProviderCallOptions } from "./llm-provider.js";

/** Narrow config the provider actually needs — see docs/adr/0001. */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  embeddingModel: string;
  /**
   * Optional separate endpoint for embeddings. Needed when the chat Provider
   * cannot serve `/v1/embeddings` — e.g. an MLX (`mlx_lm.server`) chat model,
   * with embeddings delegated to Ollama. Falls back to the chat endpoint.
   */
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
}

/**
 * OpenAI-compatible adapter. Talks to OpenAI, Ollama (`/v1`), vLLM, LM Studio,
 * MLX — whatever `baseUrl` points at. Chat and embeddings may target different
 * endpoints (see `embeddingBaseUrl`). See docs/adr/0001 and CONTEXT.md.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly defaultModel: string;
  private readonly client: OpenAI;
  private readonly embedClient: OpenAI;
  private readonly embeddingModel: string;

  constructor(config: ProviderConfig) {
    this.defaultModel = config.model;
    this.embeddingModel = config.embeddingModel;
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      // Ollama/MLX ignore the key but the SDK requires a non-empty string.
      apiKey: config.apiKey || "not-needed",
    });
    // Reuse the chat client unless embeddings are pointed at a separate endpoint.
    this.embedClient = config.embeddingBaseUrl
      ? new OpenAI({
          baseURL: config.embeddingBaseUrl,
          apiKey: config.embeddingApiKey || config.apiKey || "not-needed",
        })
      : this.client;
  }

  chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    options?: ProviderCallOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    return this.client.chat.completions.create(
      { ...req, stream: false },
      { signal: options?.signal },
    );
  }

  async chatStream(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    options?: ProviderCallOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    return this.client.chat.completions.create(
      { ...req, stream: true },
      { signal: options?.signal },
    );
  }

  async embed(texts: string[], options?: ProviderCallOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.embedClient.embeddings.create(
      {
        model: this.embeddingModel,
        input: texts,
      },
      { signal: options?.signal },
    );
    // Rows may come back reordered; `index` restores input order.
    return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
