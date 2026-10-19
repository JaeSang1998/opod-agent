import type OpenAI from "openai";
import type { Pool } from "pg";
import type { Logger } from "../bootstrap/logger.js";
import type { LLMProvider, ProviderCallOptions } from "./llm-provider.js";
import { OpenAICompatProvider, type ProviderConfig } from "./openai-compat-provider.js";

const SETTING_KEYS = [
  "ai.management.v1",
  "agent.llmApiUrl",
  "agent.llmApiKey",
  "agent.llmModel",
  "agent.embeddingApiUrl",
  "agent.embeddingApiKey",
  "agent.embeddingModel",
  "planner.llmApiUrl",
  "planner.llmApiKey",
  "planner.llmModel",
] as const;

const UNRESOLVED_MODEL = "db-config-required";

function selectedChat(raw: string | undefined, value: (key: string) => string | undefined) {
  if (!raw) return null;
  try {
    const config = JSON.parse(raw) as {
      version: number;
      connections: { id: string; type: string; provider: string; apiUrl: string; apiKey?: string; legacyKey?: string; models: { id: string; model: string }[] }[];
      bindings: Record<string, { connectionId: string; modelId: string }>;
    };
    if (config.version !== 1 || !Array.isArray(config.connections) || !config.bindings) throw new Error();
    const binding = config.bindings["chat.response"];
    if (!binding) return null;
    const connection = config.connections.find(c => c.id === binding.connectionId);
    const model = connection?.models.find(m => m.id === binding.modelId);
    if (connection?.type !== "llm" || connection.provider !== "openai-compatible" || !model?.model || !connection.apiUrl) throw new Error();
    const apiKey = connection.apiKey || (connection.legacyKey === "planner" ? value("planner.llmApiKey") : connection.legacyKey === "chat" ? value("agent.llmApiKey") ?? value("planner.llmApiKey") : undefined);
    if (!apiKey) throw new Error();
    return { apiUrl: `${connection.apiUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`, apiKey, model: model.model };
  } catch {
    throw new LlmConfigUnavailableError("Chat model assignment is invalid or incomplete");
  }
}

export class LlmConfigUnavailableError extends Error {
  override readonly name = "LlmConfigUnavailableError";

  constructor(message = "LLM configuration unavailable") {
    super(message);
  }
}

/** Admin stores full operation URLs; the OpenAI client wants their `/v1` base. */
export function baseUrlFrom(url: string, operation: "chat/completions" | "embeddings"): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LlmConfigUnavailableError("LLM DB configuration contains an invalid API URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new LlmConfigUnavailableError("LLM DB configuration contains an invalid API URL");
  }
  const operationPath = `/${operation}`;
  const pathname = parsed.pathname.replace(/\/$/, "");
  if (!pathname.endsWith(operationPath)) {
    throw new LlmConfigUnavailableError("LLM DB configuration contains an invalid API URL");
  }
  parsed.pathname = pathname.slice(0, -operationPath.length) || "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export type DbProviderFactory = (config: ProviderConfig) => LLMProvider;

/**
 * Resolves product LLM credentials from admin_settings for every call. A
 * successfully constructed provider may be reused, but a later DB error never
 * falls back to that provider or to process environment values.
 */
export class DbSettingsProvider implements LLMProvider {
  private cached: LLMProvider | null = null;
  private fingerprint = "";
  private readonly supersededDefaults = new Set<string>([UNRESOLVED_MODEL]);

  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly log: Logger,
    private readonly createProvider: DbProviderFactory = (config) =>
      new OpenAICompatProvider(config),
  ) {}

  get defaultModel(): string {
    return this.cached?.defaultModel ?? UNRESOLVED_MODEL;
  }

  async chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    options?: ProviderCallOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const { provider } = await this.current(false);
    return provider.chat({ ...req, model: this.freshenModel(req.model, provider) }, options);
  }

  async chatStream(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    options?: ProviderCallOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    const { provider } = await this.current(false);
    return provider.chatStream(
      { ...req, model: this.freshenModel(req.model, provider) },
      options,
    );
  }

  async embed(texts: string[], options?: ProviderCallOptions): Promise<number[][]> {
    return (await this.current(true)).provider.embed(texts, options);
  }

  async embedQuery(texts: string[], options?: ProviderCallOptions): Promise<{ embeddings: number[][]; model: string }> {
    const { provider, embeddingModel: model } = await this.current(true);
    // Qwen's retrieval instruction belongs to queries, never stored documents.
    const input = model === "Qwen/Qwen3-Embedding-0.6B"
      ? texts.map(text => `Instruct: Given a message in a character conversation, retrieve relevant facts or memories that help answer it.\nQuery: ${text}`)
      : texts;
    return { embeddings: await provider.embed(input, options), model };
  }

  private freshenModel(requested: string, provider: LLMProvider): string {
    if (requested === provider.defaultModel) return requested;
    return this.supersededDefaults.has(requested) ? provider.defaultModel : requested;
  }

  private async current(requireEmbedding: boolean): Promise<{ provider: LLMProvider; embeddingModel: string }> {
    let rows: { key: string; value: string }[];
    try {
      const result = await this.pool.query<{ key: string; value: string }>(
        "SELECT key, value FROM opod.admin_settings WHERE key = ANY($1)",
        [SETTING_KEYS as unknown as string[]],
      );
      rows = result.rows;
    } catch (error) {
      this.log.warn("LLM settings DB lookup failed", { err: String(error) });
      throw new LlmConfigUnavailableError();
    }

    const byKey = new Map(rows.map((row) => [row.key, row.value.trim()]));
    const value = (key: string) => byKey.get(key) || undefined;
    const selected = selectedChat(value("ai.management.v1"), value);
    const chatUrl = selected?.apiUrl ?? value("agent.llmApiUrl") ?? value("planner.llmApiUrl");
    const chatKey = selected?.apiKey ?? value("agent.llmApiKey") ?? value("planner.llmApiKey");
    const chatModel = selected?.model ?? value("agent.llmModel") ?? value("planner.llmModel");
    if (!chatUrl || !chatKey || !chatModel) {
      throw new LlmConfigUnavailableError("Chat LLM DB configuration is incomplete");
    }

    const embeddingUrl = value("agent.embeddingApiUrl");
    const embeddingKey = value("agent.embeddingApiKey");
    const embeddingModel = value("agent.embeddingModel");
    if (requireEmbedding && (!embeddingUrl || !embeddingKey || !embeddingModel)) {
      throw new LlmConfigUnavailableError("Embedding DB configuration is incomplete");
    }

    const config: ProviderConfig = {
      baseUrl: baseUrlFrom(chatUrl, "chat/completions"),
      apiKey: chatKey,
      model: chatModel,
      embeddingModel: embeddingModel ?? "",
      ...(embeddingUrl
        ? { embeddingBaseUrl: baseUrlFrom(embeddingUrl, "embeddings") }
        : {}),
      ...(embeddingKey ? { embeddingApiKey: embeddingKey } : {}),
    };
    const fingerprint = JSON.stringify(config);
    if (!this.cached || fingerprint !== this.fingerprint) {
      if (this.cached && this.cached.defaultModel !== config.model) {
        this.supersededDefaults.add(this.cached.defaultModel);
        this.supersededDefaults.delete(config.model);
      }
      this.cached = this.createProvider(config);
      this.fingerprint = fingerprint;
      this.log.info("DB LLM settings applied", {
        baseUrl: config.baseUrl,
        model: config.model,
        embeddingBaseUrl: config.embeddingBaseUrl,
        embeddingModel: config.embeddingModel,
      });
    }
    return { provider: this.cached, embeddingModel: config.embeddingModel };
  }
}
