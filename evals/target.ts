import type OpenAI from "openai";
import { createApp } from "../src/http/app.js";
import { buildContainer, type Container } from "../src/bootstrap/container.js";
import { loadEnv } from "../src/bootstrap/env.js";
import { OpenAICompatProvider } from "../src/provider/openai-compat-provider.js";
import { StubJobQueue } from "../src/memory/stub-job-queue.js";
import { StubMemoryStore } from "../src/memory/stub-memory-store.js";
import { FakeProvider } from "../src/testing/fake-provider.js";
import type { ToolLoopEvent } from "../src/chat/tool-loop.js";
import type {
  PromptContextSectionName,
  PromptDebugMetadata,
  PromptMemoryProvenance,
  PromptMemorySourceProvenance,
} from "../src/chat/chat-service.js";
import type { TokenUsage } from "./llm.js";
import type { MemoryFixture } from "./schema.js";
import type {
  PromptPersonaProvenance,
  PromptPersonaSourceProvenance,
} from "../src/persona/persona-router.js";

export type { PromptDebugMetadata, PromptMemoryProvenance };
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
  responseModel?: string;
  promptDebug?: PromptDebugMetadata;
}

export interface TargetMemoryFixtureSetup {
  schemaVersion: 1;
  seedPolicy: MemoryFixture["seedPolicy"];
  seededRecordCount: number;
  declaredCurrentStateCount: number;
  bindings: Array<{
    fixtureId: string;
    runtimeMemoryId: string;
    lifecycle: MemoryFixture["records"][number]["lifecycle"];
  }>;
}

export interface TargetSetupInput {
  runId: string;
  identity: ConversationIdentity;
  memoryFixture: MemoryFixture;
}

export interface ConversationTarget {
  readonly kind: "in-process" | "http";
  readonly model: string;
  readonly requestConfig: Record<string, unknown>;
  readonly runtimeConfig: Record<string, unknown>;
  setupMemoryFixture?(input: TargetSetupInput): Promise<TargetMemoryFixtureSetup>;
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
    const providerMode = evalTargetProviderMode(env.EVAL_TARGET_PROVIDER);
    const provider = providerMode === "deterministic"
      ? new FakeProvider("구조 검증용 합성 응답입니다.")
      : new OpenAICompatProvider({
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
    this.model = env.EVAL_TARGET_MODEL ?? provider.defaultModel;
    this.requestConfig = targetRequestConfig(env);
    this.consolidationMode = consolidationMode(env.EVAL_CONSOLIDATION_MODE);
    this.batchTurns = positiveInteger(env.EVAL_CONSOLIDATION_BATCH_TURNS, 4);
    this.runtimeConfig = {
      consolidationMode: this.consolidationMode,
      consolidationBatchTurns: this.batchTurns,
      toolsEnabled: loaded.TOOLS_ENABLED,
      providerMode,
    };
  }

  async setupMemoryFixture(input: TargetSetupInput): Promise<TargetMemoryFixtureSetup> {
    if (!(this.container.memory instanceof StubMemoryStore)) {
      throw new Error("in-process memory fixtures require StubMemoryStore");
    }
    const embeddings = await this.container.provider.embed(
      input.memoryFixture.records.map((record) => record.content),
    );
    if (embeddings.length !== input.memoryFixture.records.length) {
      throw new Error(
        `memory fixture embedding count ${embeddings.length} does not match ` +
          `record count ${input.memoryFixture.records.length}`,
      );
    }
    const stored = await this.container.memory.upsertMany(
      { userId: input.identity.userId, characterId: input.identity.characterId },
      input.memoryFixture.records.map((record, index) => ({
        content: record.content,
        kind: record.kind,
        importance: record.importance,
        embedding: embeddings[index] ?? [],
      })),
      `eval-memory-fixture:${input.runId}`,
    );
    if (stored.length !== input.memoryFixture.records.length) {
      throw new Error(
        `memory fixture seeded ${stored.length}/${input.memoryFixture.records.length} records; ` +
          "deduplication or a write failure made the fixture incomplete",
      );
    }
    return {
      schemaVersion: 1,
      seedPolicy: input.memoryFixture.seedPolicy,
      seededRecordCount: stored.length,
      declaredCurrentStateCount: input.memoryFixture.currentStateRecords.length,
      bindings: input.memoryFixture.records.map((record, index) => {
        const storedRecord = stored[index];
        if (!storedRecord) throw new Error(`memory fixture binding ${record.id} is missing`);
        return {
          fixtureId: record.id,
          runtimeMemoryId: storedRecord.id,
          lifecycle: record.lifecycle,
        };
      }),
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
      consolidationMode: "remote",
    };
  }

  async setupMemoryFixture(): Promise<TargetMemoryFixtureSetup> {
    throw new Error(
      "HTTP targets do not accept memory fixtures; use the isolated in-process target",
    );
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

export function parseChatResponse(payload: unknown): Omit<TargetTurnOutput, "latencyMs"> {
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
    responseModel: typeof payload.model === "string" ? payload.model : undefined,
    usage: {
      promptTokens: numeric(usage.prompt_tokens),
      completionTokens: numeric(usage.completion_tokens),
      totalTokens: numeric(usage.total_tokens),
    },
    toolEvents: events.filter(isToolLoopEvent),
    promptDebug: parsePromptDebug(debug.prompt),
  };
}

const PROMPT_CONTEXT_SECTION_NAMES = new Set<PromptContextSectionName>([
  "current_moment",
  "bond",
  "persona_start",
  "persona_retrieved",
  "core_memory",
  "conversation_summary",
  "retrieved_memories",
]);

function parsePromptDebug(value: unknown): PromptDebugMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("target returned invalid prompt debug metadata");
  const retrieval = isRecord(value.retrievalConfig) ? value.retrievalConfig : undefined;
  const weights = retrieval && isRecord(retrieval.weights) ? retrieval.weights : undefined;
  const sections = Array.isArray(value.contextSectionNames)
    ? value.contextSectionNames
    : undefined;
  const memoryProvenance = parseMemoryProvenance(value.memoryProvenance);
  const personaProvenance = parsePersonaProvenance(value.personaProvenance);
  const valid =
    value.schemaVersion === 1 &&
    typeof value.stablePromptSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.stablePromptSha256) &&
    isNonNegativeInteger(value.personaBlockCount) &&
    isNonNegativeInteger(value.canonCount) &&
    sections?.every(
      (section): section is PromptContextSectionName =>
        typeof section === "string" &&
        PROMPT_CONTEXT_SECTION_NAMES.has(section as PromptContextSectionName),
    ) === true &&
    isNonNegativeInteger(value.retrievedMemoryCount) &&
    value.memoryPolicyVersion === 1 &&
    retrieval !== undefined &&
    isPositiveInteger(retrieval.topK) &&
    weights !== undefined &&
    isNonNegativeNumber(weights.recency) &&
    isNonNegativeNumber(weights.importance) &&
    isNonNegativeNumber(weights.relevance) &&
    isPositiveNumber(retrieval.recencyDecay) &&
    retrieval.recencyDecay <= 1 &&
    isPositiveInteger(retrieval.summaryTurnThreshold);
  if (!valid || !retrieval || !weights || !sections) {
    throw new Error("target returned invalid prompt debug metadata");
  }
  return {
    schemaVersion: 1,
    stablePromptSha256: value.stablePromptSha256 as string,
    personaBlockCount: value.personaBlockCount as number,
    canonCount: value.canonCount as number,
    contextSectionNames: sections as PromptContextSectionName[],
    retrievedMemoryCount: value.retrievedMemoryCount as number,
    memoryProvenance,
    personaProvenance,
    memoryPolicyVersion: 1,
    retrievalConfig: {
      topK: retrieval.topK as number,
      weights: {
        recency: weights.recency as number,
        importance: weights.importance as number,
        relevance: weights.relevance as number,
      },
      recencyDecay: retrieval.recencyDecay as number,
      summaryTurnThreshold: retrieval.summaryTurnThreshold as number,
    },
  };
}

const PERSONA_KINDS = new Set([
  "identity",
  "behavior",
  "voice",
  "example",
  "greeting",
  "lore",
  "creator_note",
]);
const PERSONA_INJECTIONS = new Set([
  "always",
  "start_only",
  "retrieved",
  "never_prompt",
]);
const PERSONA_DESTINATIONS = new Set(["system_prompt", "turn_context", "excluded"]);
const PERSONA_REASONS = new Set([
  "always_in_system_prompt",
  "start_only_first_turn",
  "start_only_after_first_turn",
  "retrieved_for_turn",
  "not_retrieved",
  "never_prompt",
  "legacy_default_always",
  "legacy_reactive_greeting_excluded",
]);

function parsePersonaProvenance(value: unknown): PromptPersonaProvenance | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.policyVersion !== 1 ||
    !Array.isArray(value.sources)
  ) {
    throw new Error("target returned invalid persona provenance metadata");
  }
  return {
    schemaVersion: 1,
    policyVersion: 1,
    sources: value.sources.map(parsePersonaSourceProvenance),
  };
}

function parsePersonaSourceProvenance(value: unknown): PromptPersonaSourceProvenance {
  if (!isRecord(value)) throw new Error("target returned invalid persona provenance metadata");
  const validShape =
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.kind === null || (typeof value.kind === "string" && PERSONA_KINDS.has(value.kind))) &&
    typeof value.injection === "string" &&
    PERSONA_INJECTIONS.has(value.injection) &&
    (value.mapping === "explicit" || value.mapping === "legacy") &&
    typeof value.destination === "string" &&
    PERSONA_DESTINATIONS.has(value.destination) &&
    typeof value.reason === "string" &&
    PERSONA_REASONS.has(value.reason) &&
    personaRouteFieldsAgree(value);
  if (!validShape) throw new Error("target returned invalid persona provenance metadata");
  return {
    id: value.id as string,
    kind: value.kind as PromptPersonaSourceProvenance["kind"],
    injection: value.injection as PromptPersonaSourceProvenance["injection"],
    mapping: value.mapping as PromptPersonaSourceProvenance["mapping"],
    destination: value.destination as PromptPersonaSourceProvenance["destination"],
    reason: value.reason as PromptPersonaSourceProvenance["reason"],
  };
}

function personaRouteFieldsAgree(value: Record<string, unknown>): boolean {
  switch (value.reason) {
    case "always_in_system_prompt":
      return value.mapping === "explicit" && value.injection === "always" && value.destination === "system_prompt";
    case "start_only_first_turn":
      return value.mapping === "explicit" && value.injection === "start_only" && value.destination === "turn_context";
    case "start_only_after_first_turn":
      return value.mapping === "explicit" && value.injection === "start_only" && value.destination === "excluded";
    case "retrieved_for_turn":
      return value.mapping === "explicit" && value.injection === "retrieved" && value.destination === "turn_context";
    case "not_retrieved":
      return value.mapping === "explicit" && value.injection === "retrieved" && value.destination === "excluded";
    case "never_prompt":
      return value.mapping === "explicit" && value.injection === "never_prompt" && value.destination === "excluded";
    case "legacy_default_always":
      return value.mapping === "legacy" && value.injection === "always" && value.destination === "system_prompt";
    case "legacy_reactive_greeting_excluded":
      return value.mapping === "legacy" && value.injection === "never_prompt" && value.destination === "excluded";
    default:
      return false;
  }
}

const MEMORY_PROVENANCE_STATUSES = new Set(["completed", "skipped", "failed"]);
const MEMORY_PROVENANCE_REASONS = new Set([
  "retrieval_completed",
  "missing_identity",
  "empty_query",
  "embedding_unavailable",
  "retrieval_failed",
]);
const MEMORY_RETRIEVAL_REASONS = new Set([
  "selected_top_k",
  "outside_top_k",
  "legacy_store_selected",
]);

function parseMemoryProvenance(value: unknown): PromptMemoryProvenance | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !MEMORY_PROVENANCE_STATUSES.has(value.status) ||
    typeof value.reason !== "string" ||
    !MEMORY_PROVENANCE_REASONS.has(value.reason) ||
    !Array.isArray(value.sources)
  ) {
    throw new Error("target returned invalid memory provenance metadata");
  }
  const sources = value.sources.map(parseMemorySourceProvenance);
  const statusMatchesReason =
    (value.status === "completed" && value.reason === "retrieval_completed") ||
    (value.status === "failed" && value.reason === "retrieval_failed") ||
    (value.status === "skipped" &&
      (value.reason === "missing_identity" ||
        value.reason === "empty_query" ||
        value.reason === "embedding_unavailable"));
  if (!statusMatchesReason || (value.status !== "completed" && sources.length > 0)) {
    throw new Error("target returned invalid memory provenance metadata");
  }
  return {
    status: value.status as PromptMemoryProvenance["status"],
    reason: value.reason as PromptMemoryProvenance["reason"],
    sources,
  };
}

function parseMemorySourceProvenance(value: unknown): PromptMemorySourceProvenance {
  if (!isRecord(value)) throw new Error("target returned invalid memory provenance metadata");
  const rank = value.rank === null ? null : value.rank;
  const score = value.score === null ? null : value.score;
  const rawRelevance = value.rawRelevance === null ? null : value.rawRelevance;
  const valid =
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.kind === "observation" || value.kind === "reflection") &&
    (rank === null || isPositiveInteger(rank)) &&
    (score === null || isNonNegativeNumber(score)) &&
    (rawRelevance === null ||
      (typeof rawRelevance === "number" && Number.isFinite(rawRelevance))) &&
    (value.retrieval === "selected" || value.retrieval === "excluded") &&
    typeof value.retrievalReason === "string" &&
    MEMORY_RETRIEVAL_REASONS.has(value.retrievalReason) &&
    (value.retrievalReason === "outside_top_k"
      ? value.retrieval === "excluded"
      : value.retrieval === "selected") &&
    typeof value.injected === "boolean" &&
    (value.injectionReason === "retrieved_memories_section" ||
      value.injectionReason === "not_retrieved") &&
    (!value.injected || value.retrieval === "selected") &&
    (value.injected
      ? value.injectionReason === "retrieved_memories_section"
      : value.injectionReason === "not_retrieved");
  if (!valid) throw new Error("target returned invalid memory provenance metadata");
  return {
    id: value.id as string,
    kind: value.kind as PromptMemorySourceProvenance["kind"],
    rank: rank as number | null,
    score: score as number | null,
    rawRelevance: rawRelevance as number | null,
    retrieval: value.retrieval as PromptMemorySourceProvenance["retrieval"],
    retrievalReason:
      value.retrievalReason as PromptMemorySourceProvenance["retrievalReason"],
    injected: value.injected as boolean,
    injectionReason:
      value.injectionReason as PromptMemorySourceProvenance["injectionReason"],
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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

function evalTargetProviderMode(raw: string | undefined): "configured" | "deterministic" {
  const value = raw ?? "configured";
  if (value === "configured" || value === "deterministic") return value;
  throw new Error(`EVAL_TARGET_PROVIDER must be configured or deterministic; got ${value}`);
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
