import type OpenAI from "openai";
import type { Pool } from "pg";
import {
  LLM_LOG_TYPE,
  type LLMProvider,
  type LlmLogContext,
  type ProviderCallOptions,
} from "./llm-provider.js";

type JsonObject = Record<string, unknown>;

interface StartedLog {
  id: bigint;
  redactedPaths: string[];
}

interface FinishLog {
  responseJson?: unknown;
  redactedPaths?: string[];
  providerRequestId?: string;
  httpStatus?: number;
  errorType?: string;
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmLogStore {
  start(input: {
    type: string;
    provider: string;
    model: string;
    endpoint: string;
    isStreaming: boolean;
    context?: LlmLogContext;
    systemPromptJson: unknown;
    userPromptJson: unknown;
    requestJson: unknown;
    redactedPaths: string[];
  }): Promise<bigint>;
  succeed(log: StartedLog, result: FinishLog): Promise<void>;
  fail(log: StartedLog, error: unknown): Promise<void>;
}

export class UnavailableLlmLogStore implements LlmLogStore {
  start(): Promise<bigint> {
    return Promise.reject(new Error("DATABASE_URL is required before an external model call"));
  }

  succeed(): Promise<void> {
    return Promise.resolve();
  }

  fail(): Promise<void> {
    return Promise.resolve();
  }
}

export class PostgresLlmLogStore implements LlmLogStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async start(input: Parameters<LlmLogStore["start"]>[0]): Promise<bigint> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO opod.llm_logs
         (type, provider, model, endpoint, is_streaming, request_id, user_id,
          character_id, system_prompt_json, user_prompt_json, request_json,
          metadata_json, redacted_paths)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
               $11::jsonb, $12::jsonb, $13::text[])
       RETURNING id::text`,
      [
        input.type,
        input.provider,
        input.model,
        input.endpoint,
        input.isStreaming,
        input.context?.requestId ?? null,
        input.context?.userId ?? null,
        input.context?.characterId ?? null,
        toJson(input.systemPromptJson),
        toJson(input.userPromptJson),
        toJson(input.requestJson),
        toJson(input.context?.metadata ?? null),
        input.redactedPaths,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("LLM log insert returned no id");
    return BigInt(id);
  }

  async succeed(log: StartedLog, result: FinishLog): Promise<void> {
    await this.pool.query(
      `UPDATE opod.llm_logs
          SET status = 'succeeded',
              response_json = $2::jsonb,
              redacted_paths = $3::text[],
              provider_request_id = $4,
              http_status = $5,
              duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - created_at)) * 1000))::int,
              input_tokens = $6,
              output_tokens = $7,
              total_tokens = $8,
              completed_at = clock_timestamp()
        WHERE id = $1`,
      [
        log.id.toString(),
        toJson(result.responseJson ?? null),
        uniquePaths(log.redactedPaths, result.redactedPaths),
        result.providerRequestId ?? null,
        result.httpStatus ?? 200,
        result.inputTokens ?? null,
        result.outputTokens ?? null,
        result.totalTokens ?? null,
      ],
    );
  }

  async fail(log: StartedLog, error: unknown): Promise<void> {
    const failure = errorFields(error);
    const response = redactLlmPayload(failure.responseJson, "$.response");
    await this.pool.query(
      `UPDATE opod.llm_logs
          SET status = 'failed',
              redacted_paths = $2::text[],
              provider_request_id = $3,
              http_status = $4,
              error_type = $5,
              error_message = $6,
              response_json = $7::jsonb,
              duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - created_at)) * 1000))::int,
              completed_at = clock_timestamp()
        WHERE id = $1`,
      [
        log.id.toString(),
        uniquePaths(
          log.redactedPaths,
          response.redactedPaths,
          failure.isRedacted ? ["$.errorMessage"] : [],
        ),
        failure.providerRequestId,
        failure.httpStatus,
        failure.errorType,
        failure.errorMessage,
        toJson(response.value),
      ],
    );
  }
}

export class LoggedLlmProvider implements LLMProvider {
  readonly defaultModel: string;

  constructor(
    private readonly provider: LLMProvider,
    private readonly store: LlmLogStore,
    private readonly config: {
      provider: string;
      chatEndpoint: string;
      embeddingEndpoint: string;
      embeddingModel: string;
      onFinishWriteError?: (error: unknown) => void;
    },
  ) {
    this.defaultModel = provider.defaultModel;
  }

  async chat(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    options?: ProviderCallOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const started = await this.start(req, false, options?.log ?? { type: LLM_LOG_TYPE.chat });
    try {
      const response = await this.provider.chat(req, options);
      await this.finish(started, response, usageOf(response));
      return response;
    } catch (error) {
      await this.fail(started, error);
      throw error;
    }
  }

  async chatStream(
    req: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    options?: ProviderCallOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    const started = await this.start(req, true, options?.log ?? { type: LLM_LOG_TYPE.chat });
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await this.provider.chatStream(req, options);
    } catch (error) {
      await this.fail(started, error);
      throw error;
    }

    const self = this;
    return (async function* () {
      const accumulator = new StreamCompletionAccumulator();
      let finished = false;
      try {
        for await (const chunk of stream) {
          accumulator.add(chunk);
          yield chunk;
        }
        finished = true;
        const response = accumulator.value();
        await self.finish(started, response, usageOf(response));
      } catch (error) {
        finished = true;
        await self.fail(started, error);
        throw error;
      } finally {
        if (!finished) await self.fail(started, new Error("stream consumer disconnected"));
      }
    })();
  }

  async embed(texts: string[], options?: ProviderCallOptions): Promise<number[][]> {
    if (texts.length === 0) return [];
    const request = { model: this.config.embeddingModel, input: texts };
    const context = options?.log ?? { type: LLM_LOG_TYPE.memoryRetrieveEmbedding };
    const requestPayload = redactLlmPayload(request, "$.request");
    const metadata = redactLlmPayload(context.metadata ?? null, "$.metadata");
    const endpoint = redactLlmPayload(this.config.embeddingEndpoint, "$.endpoint");
    const redactedPaths = uniquePaths(
      requestPayload.redactedPaths,
      metadata.redactedPaths,
      endpoint.redactedPaths,
    );
    const id = await this.store.start({
      type: context.type,
      provider: this.config.provider,
      model: this.config.embeddingModel,
      endpoint: String(endpoint.value),
      isStreaming: false,
      context: {
        ...context,
        metadata: isJsonObject(metadata.value) ? metadata.value : undefined,
      },
      systemPromptJson: null,
      userPromptJson: texts,
      requestJson: requestPayload.value,
      redactedPaths,
    });
    const started = { id, redactedPaths };

    try {
      const result = this.provider.embedWithResponse
        ? await this.provider.embedWithResponse(texts, options)
        : {
            embeddings: await this.provider.embed(texts, options),
            response: undefined,
          };
      const embeddings = result.embeddings;
      const rawResponse = result.response ?? {
        object: "list",
        model: this.config.embeddingModel,
        data: embeddings.map((embedding, index) => ({
          object: "embedding",
          index,
          embedding,
        })),
      };
      const response = redactEmbeddingVectors(rawResponse);
      await this.finish(
        started,
        response.value,
        usageOf(rawResponse),
        response.redactedPaths,
      );
      return embeddings;
    } catch (error) {
      await this.fail(started, error);
      throw error;
    }
  }

  private async start(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
    isStreaming: boolean,
    context: LlmLogContext,
  ): Promise<StartedLog> {
    const requestPayload = redactLlmPayload(request, "$.request");
    const metadata = redactLlmPayload(context.metadata ?? null, "$.metadata");
    const endpoint = redactLlmPayload(this.config.chatEndpoint, "$.endpoint");
    const redactedPaths = uniquePaths(
      requestPayload.redactedPaths,
      metadata.redactedPaths,
      endpoint.redactedPaths,
    );
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const system = messages.filter((message) => message.role === "system");
    const user = messages.filter((message) => message.role === "user");
    const id = await this.store.start({
      type: context.type,
      provider: this.config.provider,
      model: request.model,
      endpoint: String(endpoint.value),
      isStreaming,
      context: {
        ...context,
        metadata: isJsonObject(metadata.value) ? metadata.value : undefined,
      },
      systemPromptJson:
        system.length > 0
          ? redactLlmPayload(system, "$.systemPrompt").value
          : null,
      userPromptJson:
        user.length > 0
          ? redactLlmPayload(user, "$.userPrompt").value
          : null,
      requestJson: requestPayload.value,
      redactedPaths,
    });
    return { id, redactedPaths };
  }

  private async finish(
    started: StartedLog,
    response: unknown,
    usage: ReturnType<typeof usageOf>,
    additionalRedactedPaths: string[] = [],
  ): Promise<void> {
    const redacted = redactLlmPayload(response, "$.response");
    try {
      await this.store.succeed(started, {
        responseJson: redacted.value,
        redactedPaths: uniquePaths(redacted.redactedPaths, additionalRedactedPaths),
        providerRequestId: providerRequestIdOf(response),
        ...usage,
      });
    } catch (error) {
      this.config.onFinishWriteError?.(error);
    }
  }

  private async fail(started: StartedLog, error: unknown): Promise<void> {
    try {
      await this.store.fail(started, error);
    } catch (writeError) {
      this.config.onFinishWriteError?.(writeError);
    }
  }
}

export function redactLlmPayload(
  input: unknown,
  rootPath = "$",
): { value: unknown; redactedPaths: string[] } {
  const redactedPaths: string[] = [];

  const visit = (value: unknown, path: string, key = ""): unknown => {
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      redactedPaths.push(path);
      return "[REDACTED]";
    }
    if (typeof value === "string") {
      if (/^data:[^;,]+;base64,/i.test(value) || (/(base64|binary|bytes)/i.test(key) && value.length > 256)) {
        redactedPaths.push(path);
        return "[REDACTED]";
      }
      return redactUrl(value, path, redactedPaths);
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`));
    if (typeof value === "object") {
      const output: JsonObject = {};
      for (const [childKey, childValue] of Object.entries(value as JsonObject)) {
        const childPath = `${path}.${childKey}`;
        if (/(authorization|api[-_]?key|cookie|secret|access[-_]?token|refresh[-_]?token|internal[-_]?token)/i.test(childKey)) {
          redactedPaths.push(childPath);
          output[childKey] = "[REDACTED]";
        } else {
          output[childKey] = visit(childValue, childPath, childKey);
        }
      }
      return output;
    }
    return String(value);
  };

  return { value: visit(input, rootPath), redactedPaths };
}

class StreamCompletionAccumulator {
  private id = "";
  private created = 0;
  private model = "";
  private usage: unknown;
  private readonly choices = new Map<number, {
    content: string;
    reasoning: string;
    finishReason: string | null;
    role: string;
    toolCalls: Map<number, { id: string; type: string; name: string; arguments: string }>;
  }>();

  add(chunk: OpenAI.Chat.Completions.ChatCompletionChunk): void {
    this.id ||= chunk.id;
    this.created ||= chunk.created;
    this.model ||= chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    for (const choice of chunk.choices) {
      const current = this.choices.get(choice.index) ?? {
        content: "",
        reasoning: "",
        finishReason: null,
        role: "assistant",
        toolCalls: new Map(),
      };
      current.content += choice.delta.content ?? "";
      const reasoning = (choice.delta as { reasoning?: string }).reasoning;
      if (reasoning) current.reasoning += reasoning;
      current.finishReason = choice.finish_reason ?? current.finishReason;
      current.role = choice.delta.role ?? current.role;
      for (const fragment of choice.delta.tool_calls ?? []) {
        const tool = current.toolCalls.get(fragment.index) ?? {
          id: "",
          type: "function",
          name: "",
          arguments: "",
        };
        tool.id += fragment.id ?? "";
        tool.type = fragment.type ?? tool.type;
        tool.name += fragment.function?.name ?? "";
        tool.arguments += fragment.function?.arguments ?? "";
        current.toolCalls.set(fragment.index, tool);
      }
      this.choices.set(choice.index, current);
    }
  }

  value(): JsonObject {
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [...this.choices.entries()].map(([index, choice]) => ({
        index,
        message: {
          role: choice.role,
          content: choice.content || null,
          ...(choice.reasoning ? { reasoning: choice.reasoning } : {}),
          ...(choice.toolCalls.size
            ? {
                tool_calls: [...choice.toolCalls.values()].map((tool) => ({
                  id: tool.id,
                  type: tool.type,
                  function: { name: tool.name, arguments: tool.arguments },
                })),
              }
            : {}),
        },
        finish_reason: choice.finishReason,
      })),
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

function redactUrl(value: string, path: string, redactedPaths: string[]): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(x-amz-|x-goog-)|signature|credential|security-token|(^|_)token$|^sig$/i.test(key)) {
        url.searchParams.delete(key);
        redactedPaths.push(`${path}.query.${key}`);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function usageOf(value: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const usage = (value as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return {};
  const input = numberOf(usage.prompt_tokens ?? usage.input_tokens);
  const output = numberOf(usage.completion_tokens ?? usage.output_tokens);
  const total = numberOf(usage.total_tokens) ?? ((input ?? 0) + (output ?? 0) || undefined);
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function providerRequestIdOf(value: unknown): string | undefined {
  const record = value as { _request_id?: unknown; id?: unknown } | null;
  const requestId = record?._request_id ?? record?.id;
  return typeof requestId === "string" ? requestId : undefined;
}

function errorFields(error: unknown): {
  providerRequestId: string | null;
  httpStatus: number | null;
  errorType: string;
  errorMessage: string;
  isRedacted: boolean;
  responseJson: unknown;
} {
  const record = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    request_id?: unknown;
    headers?: { get?(name: string): string | null };
  } | null;
  const rawMessage =
    typeof record?.message === "string"
      ? record.message
      : error instanceof Error
        ? error.message
        : String(error);
  const errorMessage = redactErrorMessage(rawMessage);
  return {
    providerRequestId:
      typeof record?.request_id === "string"
        ? record.request_id
        : record?.headers?.get?.("x-request-id") ?? null,
    httpStatus: typeof record?.status === "number" ? record.status : null,
    errorType: typeof record?.name === "string" ? record.name : "Error",
    errorMessage,
    isRedacted: errorMessage !== rawMessage,
    responseJson:
      record && "error" in record
        ? (record as { error?: unknown }).error
        : record && "body" in record
          ? (record as { body?: unknown }).body
          : null,
  };
}

function redactErrorMessage(value: string): string {
  return value
    .replace(/\b(Bearer|Key)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
      redactUrl(url, "$.errorMessage", []).replace(/[?&]$/, ""),
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|cookie)=([^&\s]+)/gi,
      "$1=[REDACTED]",
    );
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniquePaths(...groups: (string[] | undefined)[]): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function redactEmbeddingVectors(input: unknown): {
  value: unknown;
  redactedPaths: string[];
} {
  const copy = redactLlmPayload(input, "$.response");
  if (!isJsonObject(copy.value) || !Array.isArray(copy.value.data)) return copy;
  const paths: string[] = [];
  const data = copy.value.data.map((item, index) => {
    if (!isJsonObject(item) || !Array.isArray(item.embedding)) return item;
    paths.push(`$.response.data[${index}].embedding`);
    return {
      ...item,
      dimensions: item.embedding.length,
      embedding: "[REDACTED]",
    };
  });
  return {
    value: { ...copy.value, data },
    redactedPaths: uniquePaths(copy.redactedPaths, paths),
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
