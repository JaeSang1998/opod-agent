import { z } from "zod";

/**
 * All runtime configuration is env-driven. The same LLM_* variables point the
 * single OpenAI-compatible adapter at either OpenAI or a local provider (Ollama,
 * vLLM, LM Studio) — see docs/adr/0001 and CONTEXT.md.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().min(1).default("gpt-4o-mini"),
  // Optional so the server can boot for health checks / tests without a key;
  // provider calls will fail loudly if it is missing at request time.
  LLM_API_KEY: z.string().default(""),
  EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),

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

  STORE_DRIVER: z.enum(["stub", "postgres"]).default("stub"),
  DATABASE_URL: z.string().optional(),
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
