import type { Env } from "../config/env.js";
import { OpenAICompatProvider } from "../provider/OpenAICompatProvider.js";
import type { LLMProvider } from "../provider/LLMProvider.js";
import type { PersonaStore } from "../persona/PersonaStore.js";
import { StubPersonaStore } from "../persona/stub/StubPersonaStore.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { StubMemoryStore } from "../memory/stub/StubMemoryStore.js";
import type { JobQueue } from "../queue/JobQueue.js";
import { StubJobQueue } from "../queue/stub/StubJobQueue.js";
import { ChatService } from "./chatService.js";
import { ConsolidationService } from "../memory/consolidation.js";
import { Reflector } from "../memory/reflection.js";
import type { RetrievalWeights } from "../memory/retrieval.js";

export interface Container {
  env: Env;
  provider: LLMProvider;
  personas: PersonaStore;
  memory: MemoryStore;
  queue: JobQueue;
  chat: ChatService;
  consolidation: ConsolidationService;
  log: (msg: string, meta?: unknown) => void;
}

/**
 * Wires the object graph from env. STORE_DRIVER selects the persistence layer;
 * only "stub" exists today — the Postgres adapters land once the schema is fixed
 * (docs/adr/0002).
 */
export function buildContainer(env: Env): Container {
  const log = makeLogger(env.LOG_LEVEL);
  const provider = new OpenAICompatProvider(env);

  if (env.STORE_DRIVER !== "stub") {
    throw new Error(
      `STORE_DRIVER="${env.STORE_DRIVER}" is not implemented yet; use "stub" until the Postgres adapter lands.`,
    );
  }

  const personas: PersonaStore = new StubPersonaStore();
  const memory: MemoryStore = new StubMemoryStore();
  const queue: JobQueue = new StubJobQueue(log);

  const weights: RetrievalWeights = {
    recency: env.MEMORY_WEIGHT_RECENCY,
    importance: env.MEMORY_WEIGHT_IMPORTANCE,
    relevance: env.MEMORY_WEIGHT_RELEVANCE,
  };

  const chat = new ChatService(
    provider,
    personas,
    memory,
    queue,
    {
      retrieveTopK: env.MEMORY_RETRIEVE_TOP_K,
      weights,
      recencyDecay: env.MEMORY_RECENCY_DECAY,
    },
    log,
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

  return { env, provider, personas, memory, queue, chat, consolidation, log };
}

function makeLogger(level: Env["LOG_LEVEL"]) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const threshold = order[level];
  return (msg: string, meta?: unknown) => {
    if (order.info < threshold) return;
    const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    console.log(`[opod-agent] ${line}`);
  };
}
