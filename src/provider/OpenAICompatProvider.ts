import OpenAI from "openai";
import type { Env } from "../config/env.js";
import type { LLMProvider } from "./LLMProvider.js";

/**
 * OpenAI-compatible adapter. Talks to OpenAI, Ollama (`/v1`), vLLM, LM Studio —
 * whatever `LLM_BASE_URL` points at. See docs/adr/0001 and CONTEXT.md.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly defaultModel: string;
  private readonly client: OpenAI;
  private readonly embeddingModel: string;

  constructor(env: Env) {
    this.defaultModel = env.LLM_MODEL;
    this.embeddingModel = env.EMBEDDING_MODEL;
    this.client = new OpenAI({
      baseURL: env.LLM_BASE_URL,
      // Ollama ignores the key but the SDK requires a non-empty string.
      apiKey: env.LLM_API_KEY || "not-needed",
    });
  }

  chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    return this.client.chat.completions.create({ ...req, stream: false });
  }

  async chatStream(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    return this.client.chat.completions.create({ ...req, stream: true });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: texts,
    });
    return res.data.map((d) => d.embedding);
  }
}
