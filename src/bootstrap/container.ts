import { Pool } from "pg";
import type { Env } from "./env.js";
import { createLogger, type Logger } from "./logger.js";
import { OpenAICompatProvider } from "../provider/openai-compat-provider.js";
import { DbSettingsProvider } from "../provider/db-settings-provider.js";
import type { LLMProvider } from "../provider/llm-provider.js";
import {
  LoggedLlmProvider,
  PostgresLlmLogStore,
  UnavailableLlmLogStore,
} from "../provider/logged-llm-provider.js";
import type { PersonaStore } from "../persona/persona-store.js";
import { PostgresPersonaStore } from "../persona/postgres-persona-store.js";
import { StubPersonaStore } from "../persona/stub-persona-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { StubMemoryStore } from "../memory/stub-memory-store.js";
import { PostgresMemoryStore } from "../memory/postgres-memory-store.js";
import type { JobQueue } from "../memory/job-queue.js";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { PostgresJobQueue } from "../memory/postgres-job-queue.js";
import { ChatService } from "../chat/chat-service.js";
import { ConsolidationService } from "../memory/consolidation.js";
import { ConsolidationWorker } from "../memory/consolidation-worker.js";
import { Reflector } from "../memory/reflection.js";
import type { RetrievalWeights } from "../memory/retrieval.js";
import { type AgentTool, buildDefaultTools } from "../tools/index.js";
import type { PersonaBlockSelector } from "../persona/persona-router.js";

export interface Container {
  env: Env;
  provider: LLMProvider;
  personas: PersonaStore;
  memory: MemoryStore;
  queue: JobQueue;
  chat: ChatService;
  consolidation: ConsolidationService;
  /** Present when Postgres is configured and the worker is enabled. */
  consolidationWorker?: ConsolidationWorker;
  tools: AgentTool[];
  log: Logger;
}

/**
 * External adapters accepted at the composition root. A deployment can connect a
 * different LLM Provider or database without changing the chat or memory modules.
 */
export interface ContainerOverrides {
  provider?: LLMProvider;
  personas?: PersonaStore;
  memory?: MemoryStore;
  queue?: JobQueue;
  tools?: AgentTool[];
  log?: Logger;
  /** Optional P1 routing relevance owner; absent keeps retrievable lore closed. */
  personaBlockSelector?: PersonaBlockSelector;
  /** Fixed clocks are supplied by isolated evaluations; production uses wall time. */
  clock?: () => Date;
}

/**
 * Wires the object graph. DATABASE_URL selects the built-in Postgres adapters;
 * explicit test/deployment overrides still take precedence.
 */
export function buildContainer(env: Env, overrides: ContainerOverrides = {}): Container {
  const log = overrides.log ?? createLogger(env.LOG_LEVEL);
  const suppliedPersistence = [overrides.personas, overrides.memory, overrides.queue];
  const hasAllPersistenceAdapters = suppliedPersistence.every(Boolean);
  const builtinPostgres = Boolean(env.DATABASE_URL) && !hasAllPersistenceAdapters;

  // An idle client's connection dying (DB restart, failover, network reset)
  // surfaces as a pool-level 'error' event; with no listener Node escalates it
  // and kills the process. pg already discards the dead client and reconnects
  // on the next query, so the listener's only job is to log instead of crash.
  const trackedPool = (role: string): Pool => {
    const p = new Pool({ connectionString: env.DATABASE_URL });
    p.on("error", (err) => {
      log.warn(`postgres ${role} pool idle-client error`, { err: String(err) });
    });
    return p;
  };
  const pool = builtinPostgres && env.DATABASE_URL ? trackedPool("store") : null;
  const llmLogPool = env.DATABASE_URL ? (pool ?? trackedPool("llm-log")) : null;
  const logStore = llmLogPool
    ? new PostgresLlmLogStore(llmLogPool)
    : new UnavailableLlmLogStore();
  const logConfig = (baseUrl: string, embeddingBaseUrl: string, embeddingModel: string) => ({
    provider: "openai-compatible",
    chatEndpoint: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
    embeddingEndpoint: `${embeddingBaseUrl.replace(/\/$/, "")}/embeddings`,
    embeddingModel,
    onFinishWriteError: (error: unknown) =>
      log.error("failed to finalize LLM log", { err: String(error) }),
  });

  const provider = overrides.provider
    ? llmLogPool
      ? new LoggedLlmProvider(
          overrides.provider,
          logStore,
          logConfig("injected://provider", "injected://provider", "injected"),
        )
      : overrides.provider
    : new DbSettingsProvider(
        llmLogPool ?? {
          query: async () => {
            throw new Error("DATABASE_URL is not configured");
          },
        },
        log,
        (config) => {
          const raw = new OpenAICompatProvider(config);
          return new LoggedLlmProvider(
            raw,
            logStore,
            logConfig(
              config.baseUrl,
              config.embeddingBaseUrl ?? "unconfigured://embedding",
              config.embeddingModel,
            ),
          );
        },
      );

  // All built-in persistence becomes durable together when DATABASE_URL exists.
  const personas =
    overrides.personas ??
    (pool
      ? new PostgresPersonaStore(pool)
      : env.DATABASE_URL
        ? new PostgresPersonaStore(trackedPool("persona"))
        : new StubPersonaStore());
  const memory = overrides.memory ?? (pool ? new PostgresMemoryStore(pool) : new StubMemoryStore());
  const queue = overrides.queue ?? (pool ? new PostgresJobQueue(pool) : new StubJobQueue(log));

  const weights: RetrievalWeights = {
    recency: env.MEMORY_WEIGHT_RECENCY,
    importance: env.MEMORY_WEIGHT_IMPORTANCE,
    relevance: env.MEMORY_WEIGHT_RELEVANCE,
  };

  const tools =
    overrides.tools ??
    (env.TOOLS_ENABLED
      ? buildDefaultTools({
          webSearch: env.WEB_SEARCH_API_KEY
            ? { apiKey: env.WEB_SEARCH_API_KEY, baseUrl: env.WEB_SEARCH_BASE_URL }
            : undefined,
        })
      : []);

  const chat = new ChatService(
    provider,
    personas,
    memory,
    queue,
    {
      retrieveTopK: env.MEMORY_RETRIEVE_TOP_K,
      weights,
      recencyDecay: env.MEMORY_RECENCY_DECAY,
      summaryTurnThreshold: env.CONSOLIDATION_SUMMARY_TURN_THRESHOLD,
    },
    log,
    tools,
    overrides.clock,
    overrides.personaBlockSelector,
  );

  const reflector = new Reflector(provider, memory, {
    recentN: env.REFLECTION_RECENT_N,
    questionsPerPass: env.REFLECTION_QUESTIONS_PER_PASS,
    reflectionsPerQuestion: env.REFLECTIONS_PER_QUESTION,
    retrieveTopK: env.MEMORY_RETRIEVE_TOP_K,
    reflectionImportance: env.REFLECTION_IMPORTANCE,
    coreCharLimit: env.CORE_MEMORY_CHAR_LIMIT,
    weights,
    recencyDecay: env.MEMORY_RECENCY_DECAY,
  });

  const consolidation = new ConsolidationService(provider, memory, reflector, {
    reflectionThreshold: env.REFLECTION_IMPORTANCE_THRESHOLD,
  });

  // With a durable queue the Agent hosts the consolidation consumer in-process. The caller
  // (index.ts) starts/stops it around the HTTP server's lifetime.
  const consolidationWorker =
    pool && env.MEMORY_WORKER_ENABLED
      ? new ConsolidationWorker(
          pool,
          consolidation,
          {
            intervalMs: env.MEMORY_WORKER_INTERVAL_MS,
            leaseMs: env.MEMORY_WORKER_LEASE_MS,
            maxAttempts: env.MEMORY_WORKER_MAX_ATTEMPTS,
            retryDelayMs: env.MEMORY_WORKER_RETRY_DELAY_MS,
          },
          log,
        )
      : undefined;

  return {
    env,
    provider,
    personas,
    memory,
    queue,
    chat,
    consolidation,
    ...(consolidationWorker ? { consolidationWorker } : {}),
    tools,
    log,
  };
}
