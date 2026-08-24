import type OpenAI from "openai";
import { createApp } from "../src/http/app.js";
import { buildContainer, type Container } from "../src/bootstrap/container.js";
import { loadEnv } from "../src/bootstrap/env.js";
import { OpenAICompatProvider } from "../src/provider/openai-compat-provider.js";
import { StubJobQueue } from "../src/memory/stub-job-queue.js";
import type { ToolLoopEvent } from "../src/chat/tool-loop.js";
import type { TokenUsage } from "./llm.js";

export interface ConversationIdentity {
  characterId: string;
  userId: string;
  sessionId: string;
  timezone: string;
}

export interface TargetTurnInput {
  runId: string;
  userTurn: number;
  historyOffset: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  identity: ConversationIdentity;
}

export interface TargetTurnOutput {
  text: string;
  latencyMs: number;
  usage: TokenUsage;
  toolEvents: ToolLoopEvent[];
  responseId?: string;
}

export interface ConversationTarget {
  readonly kind: "in-process" | "http";
  readonly model: string;
  readonly requestConfig: Record<string, unknown>;
  readonly runtimeConfig: Record<string, unknown>;
  reply(input: TargetTurnInput): Promise<TargetTurnOutput>;
  close(): Promise<void>;
}

type ConsolidationMode = "quiescent" | "batched" | "none";

class InProcessTarget implements ConversationTarget {
  readonly kind = "in-process" as const;
  readonly model: string;
  readonly requestConfig: Record<string, unknown>;
  readonly runtimeConfig: Record<string, unknown>;
  private readonly app: ReturnType<typeof createApp>;
  private readonly queue: StubJobQueue;
  private readonly container: Container;
  private readonly consolidationMode: ConsolidationMode;
  private readonly batchTurns: number;
  private queueCursor = 0;

  constructor(env: NodeJS.ProcessEnv) {
    const loaded = loadEnv({
      ...env,
      DATABASE_URL: undefined,
      OPOD_ADAPTER_MODULE: undefined,
      OPOD_WORKER_TOKEN: undefined,
      MEMORY_WORKER_ENABLED: "false",
      TOOLS_ENABLED: env.EVAL_TARGET_TOOLS === "true" ? "true" : "false",
      LOG_LEVEL: env.EVAL_LOG_LEVEL ?? "warn",
    });
    const provider = new OpenAICompatProvider({
      baseUrl: loaded.LLM_BASE_URL,
      apiKey: loaded.LLM_API_KEY,
      model: loaded.LLM_MODEL,
      embeddingModel: loaded.EMBEDDING_MODEL,
      embeddingBaseUrl: loaded.EMBEDDING_BASE_URL,
      embeddingApiKey: loaded.EMBEDDING_API_KEY,
    });
    // Supplying the raw provider deliberately bypasses the deployment LLM-log
    // decorator: a self-contained eval must work without DATABASE_URL.
    this.container = buildContainer(loaded, { provider });
    if (!(this.container.queue instanceof StubJobQueue)) {
      throw new Error("in-process evaluation requires StubJobQueue");
    }
    this.queue = this.container.queue;
    this.app = createApp(this.container);
    this.model = env.EVAL_TARGET_MODEL ?? loaded.LLM_MODEL;
    this.requestConfig = targetRequestConfig(env);
    this.consolidationMode = consolidationMode(env.EVAL_CONSOLIDATION_MODE);
    this.batchTurns = positiveInteger(env.EVAL_CONSOLIDATION_BATCH_TURNS, 4);
    this.runtimeConfig = {
      consolidationMode: this.consolidationMode,
      consolidationBatchTurns: this.batchTurns,
      toolsEnabled: loaded.TOOLS_ENABLED,
    };
  }

  async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    const started = performance.now();
    const response = await this.app.request("/v1/chat/completions", {
      method: "POST",
      headers: requestHeaders(input),
      body: JSON.stringify(requestBody(this.model, input.messages, this.requestConfig)),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw responseError(response.status, payload);
    const parsed = parseChatResponse(payload);
    const latencyMs = performance.now() - started;
    if (
      this.consolidationMode === "quiescent" ||
      (this.consolidationMode === "batched" && input.userTurn % this.batchTurns === 0)
    ) {
      await this.drainQueue(this.consolidationMode === "batched");
    }
    return { ...parsed, latencyMs };
  }

  async close(): Promise<void> {
    if (this.consolidationMode !== "none") {
      await this.drainQueue(this.consolidationMode === "batched");
    }
  }

  private async drainQueue(coalesceOverlapping: boolean): Promise<void> {
    if (coalesceOverlapping) {
      const pending = this.queue.enqueued.slice(this.queueCursor);
      if (pending.length === 0) return;
      this.queueCursor = this.queue.enqueued.length;
      // While the async worker is delayed, every request sees the same stale
      // Summary and can enqueue an overlapping prefix. The latest summary job
      // supersedes earlier prefixes. Preserve later archival-only jobs because
      // they may represent memorable turns after a history gap.
      const latestSummaryIndex = pending.findLastIndex((job) => job.refreshSummary);
      const selected = latestSummaryIndex < 0
        ? pending
        : [
            pending[latestSummaryIndex],
            ...pending.slice(latestSummaryIndex + 1).filter((job) => !job.refreshSummary),
          ];
      for (const job of selected) {
        if (job) await this.container.consolidation.consolidate(job);
      }
      return;
    }
    while (this.queueCursor < this.queue.enqueued.length) {
      const job = this.queue.enqueued[this.queueCursor];
      if (!job) break;
      this.queueCursor += 1;
      await this.container.consolidation.consolidate(job);
    }
  }
}

class HttpTarget implements ConversationTarget {
  readonly kind = "http" as const;
  readonly model: string;
  readonly requestConfig: Record<string, unknown>;
  readonly runtimeConfig: Record<string, unknown>;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly settleMs: number;

  constructor(baseUrl: string, model: string, env: NodeJS.ProcessEnv) {
    this.endpoint = new URL("v1/chat/completions", withTrailingSlash(baseUrl));
    this.model = model;
    this.requestConfig = targetRequestConfig(env);
    this.timeoutMs = positiveInteger(env.EVAL_TARGET_TIMEOUT_MS, 300_000);
    this.settleMs = nonNegativeInteger(env.EVAL_REMOTE_SETTLE_MS, 0);
    this.runtimeConfig = {
      endpoint: this.endpoint.origin,
      responseTimeoutMs: this.timeoutMs,
      remoteSettleMs: this.settleMs,
    };
  }

  async reply(input: TargetTurnInput): Promise<TargetTurnOutput> {
    const started = performance.now();
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: requestHeaders(input),
      body: JSON.stringify(requestBody(this.model, input.messages, this.requestConfig)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw responseError(response.status, payload);
    const parsed = parseChatResponse(payload);
    const latencyMs = performance.now() - started;
    if (this.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    return { ...parsed, latencyMs };
  }

  async close(): Promise<void> {}
}

export function createConversationTarget(env: NodeJS.ProcessEnv = process.env): ConversationTarget {
  const targetUrl = env.EVAL_TARGET_URL;
  if (targetUrl) {
    const model = env.EVAL_TARGET_MODEL ?? env.LLM_MODEL;
    if (!model) throw new Error("EVAL_TARGET_MODEL or LLM_MODEL is required for an HTTP target");
    return new HttpTarget(targetUrl, model, env);
  }
  return new InProcessTarget(env);
}

function requestHeaders(input: TargetTurnInput): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-opod-character-id": input.identity.characterId,
    "x-opod-user-id": input.identity.userId,
    "x-opod-session-id": input.identity.sessionId,
    "x-opod-turn-id": `${input.runId}:turn-${input.userTurn}`,
    "x-opod-history-offset": String(input.historyOffset),
    "x-opod-timezone": input.identity.timezone,
    "x-opod-debug": "1",
    "x-request-id": `eval:${input.runId}:${input.userTurn}`,
  };
}

function requestBody(
  model: string,
  messages: TargetTurnInput["messages"],
  requestConfig: Record<string, unknown>,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return {
    ...requestConfig,
    model,
    messages,
    stream: false,
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}

function targetRequestConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const config: Record<string, unknown> = {
    // Match the current playground's portable sampling fields by default. The
    // server-specific thinking/top_k fields remain opt-in below.
    temperature: finiteNumber(env.EVAL_TARGET_TEMPERATURE, 1),
    top_p: finiteNumber(env.EVAL_TARGET_TOP_P, 0.95),
    max_tokens: positiveInteger(env.EVAL_TARGET_MAX_TOKENS, 8192),
  };
  if (env.EVAL_TARGET_TOP_K) config.top_k = positiveInteger(env.EVAL_TARGET_TOP_K, 64);
  if (env.EVAL_TARGET_REASONING_EFFORT) {
    config.reasoning_effort = env.EVAL_TARGET_REASONING_EFFORT;
  }
  if (env.EVAL_TARGET_ENABLE_THINKING) {
    if (env.EVAL_TARGET_ENABLE_THINKING !== "true" && env.EVAL_TARGET_ENABLE_THINKING !== "false") {
      throw new Error("EVAL_TARGET_ENABLE_THINKING must be true or false");
    }
    config.chat_template_kwargs = {
      enable_thinking: env.EVAL_TARGET_ENABLE_THINKING === "true",
    };
  }
  if (env.EVAL_TARGET_SEED) config.seed = positiveInteger(env.EVAL_TARGET_SEED, 1729);
  return config;
}

function parseChatResponse(payload: unknown): Omit<TargetTurnOutput, "latencyMs"> {
  if (!isRecord(payload)) throw new Error("target returned a non-object response");
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : undefined;
  const message = first && isRecord(first.message) ? first.message : undefined;
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  if (!text) throw new Error("target returned an empty assistant message");
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const debug = isRecord(payload.opod_debug) ? payload.opod_debug : {};
  const events = Array.isArray(debug.events) ? debug.events : [];
  return {
    text,
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage: {
      promptTokens: numeric(usage.prompt_tokens),
      completionTokens: numeric(usage.completion_tokens),
      totalTokens: numeric(usage.total_tokens),
    },
    toolEvents: events.filter(isToolLoopEvent),
  };
}

function isToolLoopEvent(value: unknown): value is ToolLoopEvent {
  if (
    !isRecord(value) ||
    typeof value.callId !== "string" ||
    typeof value.iteration !== "number" ||
    !Number.isSafeInteger(value.iteration) ||
    typeof value.tool !== "string"
  ) {
    return false;
  }
  if (value.type === "tool_call") return typeof value.args === "string";
  return value.type === "tool_result" && typeof value.ms === "number" && typeof value.result === "string";
}

function responseError(status: number, payload: unknown): Error {
  const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
    ? payload.error.message
    : JSON.stringify(payload);
  return new Error(`target returned HTTP ${status}: ${message}`);
}

function consolidationMode(raw: string | undefined): ConsolidationMode {
  const value = raw ?? "quiescent";
  if (value === "quiescent" || value === "batched" || value === "none") return value;
  throw new Error(`EVAL_CONSOLIDATION_MODE must be quiescent, batched, or none; got ${value}`);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Expected a positive integer, got ${raw}`);
  return value;
}

function nonNegativeInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Expected a non-negative integer, got ${raw}`);
  return value;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`Expected a finite number, got ${raw}`);
  return value;
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
