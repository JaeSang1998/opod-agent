import OpenAI from "openai";
import type { z } from "zod";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StructuredCompletion<T> {
  value: T;
  usage: TokenUsage;
}

export interface StructuredLlm {
  readonly model: string;
  complete<S extends z.ZodTypeAny>(options: {
    schema: S;
    system: string;
    user: string;
    temperature?: number;
    seed?: number;
  }): Promise<StructuredCompletion<z.output<S>>>;
}

export interface StructuredLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxAttempts?: number;
  /** Test/adapter seam; production uses the runtime's global fetch. */
  fetch?: typeof fetch;
}

/** OpenAI-compatible structured-output client used only by the simulator/judge. */
export class OpenAiStructuredLlm implements StructuredLlm {
  readonly model: string;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(config: StructuredLlmConfig) {
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || "not-needed",
      // The harness owns attempt accounting so one logical retry cannot fan out
      // into the SDK's hidden transport retries as well.
      maxRetries: 0,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  async complete<S extends z.ZodTypeAny>(options: {
    schema: S;
    system: string;
    user: string;
    temperature?: number;
    seed?: number;
  }): Promise<StructuredCompletion<z.output<S>>> {
    let feedback = "";
    let lastError: unknown;
    let useJsonMode = true;
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.client.chat.completions.create(
          {
            model: this.model,
            stream: false,
            temperature: options.temperature ?? 0,
            seed: options.seed,
            ...(useJsonMode ? { response_format: { type: "json_object" as const } } : {}),
            messages: [
              { role: "system", content: options.system },
              {
                role: "user",
                content: feedback ? `${options.user}\n\n${feedback}` : options.user,
              },
            ],
          },
          { signal: AbortSignal.timeout(this.timeoutMs) },
        );
        usage.promptTokens += response.usage?.prompt_tokens ?? 0;
        usage.completionTokens += response.usage?.completion_tokens ?? 0;
        usage.totalTokens += response.usage?.total_tokens ?? 0;

        const content = response.choices[0]?.message.content ?? "";
        const decoded: unknown = JSON.parse(extractJson(content));
        const parsed = options.schema.safeParse(decoded);
        if (parsed.success) return { value: parsed.data, usage };
        feedback = [
          "Your previous JSON did not match the required schema.",
          parsed.error.message,
          "Return one corrected JSON object only.",
        ].join("\n");
        lastError = parsed.error;
      } catch (error) {
        lastError = error;
        // Some otherwise OpenAI-compatible local servers reject response_format,
        // and malformed model text can fail JSON.parse. A 429/timeout/server
        // error is unrelated and must not silently change the request contract.
        if (shouldDisableJsonMode(error)) useJsonMode = false;
        feedback = error instanceof SyntaxError
          ? "The previous response was not valid JSON. Return one valid JSON object only."
          : "The previous request failed before a valid structured response was received. Retry the same JSON task.";
      }
    }

    throw new Error(`Structured completion failed after ${this.maxAttempts} attempts`, {
      cause: lastError,
    });
  }
}

function shouldDisableJsonMode(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    (status === 400 || status === 422) &&
    /response[_ -]?format|json[_ -]?object|json mode/iu.test(message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function structuredLlmConfig(
  role: "simulator" | "judge",
  env: NodeJS.ProcessEnv = process.env,
): StructuredLlmConfig {
  const prefix = role === "simulator" ? "EVAL_SIMULATOR" : "EVAL_JUDGE";
  const fallbackPrefix = role === "simulator" ? "EVAL_JUDGE" : "LLM";
  const baseUrl = firstNonEmpty(
    env[`${prefix}_BASE_URL`],
    env[`${fallbackPrefix}_BASE_URL`],
    env.LLM_BASE_URL,
  );
  const model = firstNonEmpty(
    env[`${prefix}_MODEL`],
    env[`${fallbackPrefix}_MODEL`],
    env.LLM_MODEL,
  );
  const apiKey = firstNonEmpty(
    env[`${prefix}_API_KEY`],
    env[`${fallbackPrefix}_API_KEY`],
    env.LLM_API_KEY,
  ) ?? "";
  if (!baseUrl || !model) {
    throw new Error(
      `${prefix}_BASE_URL and ${prefix}_MODEL are required (they may fall back to the judge/SUT settings)`,
    );
  }
  return {
    baseUrl,
    model,
    apiKey,
    timeoutMs: positiveInteger(env.EVAL_LLM_TIMEOUT_MS, 180_000),
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()));
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Expected a positive integer, got ${raw}`);
  return value;
}

function extractJson(content: string): string {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart < 0 || objectEnd < objectStart) {
    throw new SyntaxError("response did not contain a JSON object");
  }
  return trimmed.slice(objectStart, objectEnd + 1);
}
