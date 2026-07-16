import type { Env } from "./env.js";
import { createLogger, type Logger } from "./logger.js";
import { OpenAICompatProvider } from "../provider/openai-compat-provider.js";
import type { LLMProvider } from "../provider/llm-provider.js";
import type { PersonaStore } from "../persona/persona-store.js";
import { StubPersonaStore } from "../persona/stub-persona-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { StubMemoryStore } from "../memory/stub-memory-store.js";
import type { JobQueue } from "../memory/job-queue.js";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { ChatService } from "../chat/chat-service.js";
import { ConsolidationService } from "../memory/consolidation.js";
import { Reflector } from "../memory/reflection.js";
import type { RetrievalWeights } from "../memory/retrieval.js";
import { type AgentTool, buildDefaultTools } from "../tools/index.js";

export interface Container {
  env: Env;
  provider: LLMProvider;
  personas: PersonaStore;
  memory: MemoryStore;
  queue: JobQueue;
  chat: ChatService;
  consolidation: ConsolidationService;
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
}

/**
 * Wires the object graph from env. Built-in persistence defaults to in-memory
 * adapters; non-stub deployments load concrete adapters here (docs/adr/0002).
 */
export function buildContainer(env: Env, overrides: ContainerOverrides = {}): Container {
  const log = overrides.log ?? createLogger(env.LOG_LEVEL);
  const provider =
    overrides.provider ??
    new OpenAICompatProvider({
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingBaseUrl: env.EMBEDDING_BASE_URL,
      embeddingApiKey: env.EMBEDDING_API_KEY,
    });

  const suppliedPersistence = [overrides.personas, overrides.memory, overrides.queue];
  const hasAllPersistenceAdapters = suppliedPersistence.every(Boolean);
  if (env.STORE_DRIVER !== "stub" && !hasAllPersistenceAdapters) {
    throw new Error(
      `STORE_DRIVER="${env.STORE_DRIVER}" needs injected PersonaStore, MemoryStore, and JobQueue adapters.`,
    );
  }

  const personas = overrides.personas ?? new StubPersonaStore();
  const memory = overrides.memory ?? new StubMemoryStore();
  const queue = overrides.queue ?? new StubJobQueue(log);

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
  );

  const reflector = new Reflector(provider, memory, {
    recentN: env.REFLECTION_RECENT_N,
    questionsPerPass: env.REFLECTION_QUESTIONS_PER_PASS,
    insightsPerQuestion: env.REFLECTION_INSIGHTS_PER_QUESTION,
    retrieveTopK: env.MEMORY_RETRIEVE_TOP_K,
    reflectionImportance: env.REFLECTION_IMPORTANCE,
    coreCharLimit: env.CORE_MEMORY_CHAR_LIMIT,
    weights,
    recencyDecay: env.MEMORY_RECENCY_DECAY,
  });

  const consolidation = new ConsolidationService(provider, memory, reflector, {
    reflectionThreshold: env.REFLECTION_IMPORTANCE_THRESHOLD,
  });

  return { env, provider, personas, memory, queue, chat, consolidation, tools, log };
}
