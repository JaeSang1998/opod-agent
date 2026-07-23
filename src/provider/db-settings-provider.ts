import type OpenAI from "openai";
import type { Pool } from "pg";
import type { Logger } from "../bootstrap/logger.js";
import type { LLMProvider, ProviderCallOptions } from "./llm-provider.js";
import { OpenAICompatProvider, type ProviderConfig } from "./openai-compat-provider.js";

/**
 * Chat-LLM settings live in the OPOD admin console (admin_settings):
 * `agent.*` overrides fall back per-field to the planner's `planner.*` values,
 * then to this process's env config. Re-resolved on a TTL so a key/model
 * change in the console reaches chat within a minute — the chat-path
 * equivalent of the admin worker's per-job re-resolution.
 */
const SETTING_KEYS = [
  "agent.llmApiUrl",
  "agent.llmApiKey",
  "agent.llmModel",
  "agent.embeddingModel",
  "planner.llmApiUrl",
  "planner.llmApiKey",
  "planner.llmModel",
] as const;

const DEFAULT_TTL_MS = 60_000;

/** Admin stores the planner endpoint as a full chat-completions URL; the
 *  OpenAI client wants the base. Accept either and strip the suffix. */
export function baseUrlFrom(url: string): string {
  return url.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
}

export class DbSettingsProvider implements LLMProvider {
  private cached: OpenAICompatProvider;
  private fingerprint = "";
  private expiresAt = 0;
  private refreshing: Promise<void> | null = null;
  /** Defaults that were replaced by a refresh — see freshenModel(). */
  private readonly supersededDefaults = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly envConfig: ProviderConfig,
    private readonly log: Logger,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    // Until the first DB read lands, behave exactly like the env-only setup.
    this.cached = new OpenAICompatProvider(envConfig);
  }

  get defaultModel(): string {
    return this.cached.defaultModel;
  }

  async chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    options?: ProviderCallOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const provider = await this.current();
    return provider.chat(
      { ...req, model: this.freshenModel(req.model, provider) },
      options,
    );
  }

  async chatStream(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    options?: ProviderCallOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    const provider = await this.current();
    return provider.chatStream(
      { ...req, model: this.freshenModel(req.model, provider) },
      options,
    );
  }

  /**
   * Callers read `defaultModel` synchronously while building the request, so a
   * refresh landing between that read and the call would send an outdated
   * default. Any model that once WAS our default is treated as "use the
   * default" intent and upgraded; anything else is an explicit choice and
   * passes through. (Superseded defaults are remembered in a bounded set.)
   */
  private freshenModel(requested: string, provider: OpenAICompatProvider): string {
    if (requested === provider.defaultModel) return requested;
    return this.supersededDefaults.has(requested) ? provider.defaultModel : requested;
  }

  async embed(texts: string[], options?: ProviderCallOptions): Promise<number[][]> {
    return (await this.current()).embed(texts, options);
  }

  private async current(): Promise<OpenAICompatProvider> {
    if (this.now() < this.expiresAt) {
      return this.cached;
    }
    // Single-flight: concurrent turns share one refresh instead of stampeding.
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    return this.cached;
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await this.pool.query<{ key: string; value: string }>(
        "SELECT key, value FROM opod.admin_settings WHERE key = ANY($1)",
        [SETTING_KEYS as unknown as string[]],
      );
      const byKey = new Map(rows.rows.map((row) => [row.key, row.value.trim()]));
      const get = (key: string) => byKey.get(key) || undefined;

      const apiUrl = get("agent.llmApiUrl") ?? get("planner.llmApiUrl");
      const config: ProviderConfig = {
        baseUrl: apiUrl ? baseUrlFrom(apiUrl) : this.envConfig.baseUrl,
        apiKey:
          get("agent.llmApiKey") ?? get("planner.llmApiKey") ?? this.envConfig.apiKey,
        model:
          get("agent.llmModel") ?? get("planner.llmModel") ?? this.envConfig.model,
        embeddingModel:
          get("agent.embeddingModel") ?? this.envConfig.embeddingModel,
        embeddingBaseUrl: this.envConfig.embeddingBaseUrl,
        embeddingApiKey: this.envConfig.embeddingApiKey,
      };
      const fingerprint = JSON.stringify(config);
      if (fingerprint !== this.fingerprint) {
        if (this.cached.defaultModel !== config.model) {
          this.supersededDefaults.add(this.cached.defaultModel);
          this.supersededDefaults.delete(config.model);
        }
        this.cached = new OpenAICompatProvider(config);
        this.fingerprint = fingerprint;
        this.log.info("chat LLM settings applied", {
          baseUrl: config.baseUrl,
          model: config.model,
        });
      }
    } catch (err) {
      // DB 순단은 마지막으로 성공한 구성으로 버틴다.
      this.log.warn("chat LLM settings refresh failed; keeping current", {
        err: String(err),
      });
    }
    this.expiresAt = this.now() + this.ttlMs;
  }
}
