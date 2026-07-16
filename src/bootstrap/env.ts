import { z } from "zod";

/**
 * All runtime configuration is env-driven. The LLM_* variables point the
 * OpenAI-compatible adapter at either OpenAI or a local provider (Ollama, vLLM,
 * LM Studio, MLX). Embeddings can be split onto a separate endpoint via
 * EMBEDDING_BASE_URL when the chat Provider can't serve them (e.g. an MLX chat
 * model + Ollama embeddings) — see docs/adr/0001 and CONTEXT.md.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(1_048_576),

  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  // Optional so the server can boot for health checks / tests without a key;
  // provider calls will fail loudly if it is missing at request time.
  LLM_API_KEY: z.string().default(""),
  EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  // Optional separate embeddings endpoint. Falls back to LLM_BASE_URL/LLM_API_KEY.
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

  // Retrieval (Generative-Agents weighted scoring; docs/adr/0005)
  MEMORY_RETRIEVE_TOP_K: z.coerce.number().int().positive().default(6),
  MEMORY_RECENCY_DECAY: z.coerce.number().positive().max(1).default(0.99),
  MEMORY_WEIGHT_RECENCY: z.coerce.number().nonnegative().default(1),
  MEMORY_WEIGHT_IMPORTANCE: z.coerce.number().nonnegative().default(1),
  MEMORY_WEIGHT_RELEVANCE: z.coerce.number().nonnegative().default(1),

  // Autonomous reflection (Generative-Agents importance trigger; docs/adr/0005)
  REFLECTION_IMPORTANCE_THRESHOLD: z.coerce.number().positive().default(25),
  REFLECTION_RECENT_N: z.coerce.number().int().positive().default(20),
  REFLECTION_QUESTIONS_PER_PASS: z.coerce.number().int().positive().default(3),
  REFLECTION_INSIGHTS_PER_QUESTION: z.coerce.number().int().positive().default(2),
  REFLECTION_IMPORTANCE: z.coerce.number().int().min(1).max(10).default(7),
  CORE_MEMORY_CHAR_LIMIT: z.coerce.number().int().positive().default(2000),
  CONSOLIDATION_SUMMARY_TURN_THRESHOLD: z.coerce.number().int().positive().default(8),

  // Server-side tools (get_time, get_weather, and — with a key — web_search). The
  // model calls these in a loop, invisibly, to ground replies in the real world.
  // NOTE: z.coerce.boolean() reads the string "false" as truthy, so parse the flag
  // explicitly instead. web_search uses Tavily; without a key it is simply omitted.
  TOOLS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  WEB_SEARCH_API_KEY: z.string().optional(),
  WEB_SEARCH_BASE_URL: z.string().url().default("https://api.tavily.com"),

  // Any non-stub name is allowed; deployment modules own vendor-specific setup.
  STORE_DRIVER: z.string().min(1).default("stub"),
  DATABASE_URL: z.string().optional(),
  OPOD_ADAPTER_MODULE: z.string().min(1).optional(),
  OPOD_WORKER_TOKEN: z.string().min(16).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
