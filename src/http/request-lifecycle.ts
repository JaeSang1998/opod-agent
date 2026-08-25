import { LlmConfigUnavailableError } from "../provider/db-settings-provider.js";

export interface ClassifiedRequestError {
  message: string;
  status: 408 | 500 | 503 | 504;
  type:
    | "llm_config_unavailable"
    | "request_cancelled"
    | "server_error"
    | "timeout_error";
}

/** One cancellation signal for client disconnect and the configured deadline. */
export function createRequestSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

function errorName(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const named = current as { name?: unknown; cause?: unknown };
    if (typeof named.name === "string" && named.name !== "Error") return named.name;
    current = named.cause;
  }
  return undefined;
}

/** Convert internal/provider errors into the only safe HTTP error variants. */
export function classifyRequestError(error: unknown): ClassifiedRequestError {
  if (error instanceof LlmConfigUnavailableError) {
    return {
      message: "LLM configuration unavailable",
      status: 503,
      type: "llm_config_unavailable",
    };
  }
  const name = errorName(error);
  if (name === "TimeoutError") {
    return { message: "upstream request timed out", status: 504, type: "timeout_error" };
  }
  if (name === "AbortError") {
    return { message: "request cancelled", status: 408, type: "request_cancelled" };
  }
  return { message: "internal server error", status: 500, type: "server_error" };
}
