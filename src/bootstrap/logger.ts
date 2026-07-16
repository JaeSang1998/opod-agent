export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Minimal leveled logger. Each method emits only when its level is at or above
 * the configured threshold, so `LOG_LEVEL=warn` keeps warnings and errors while
 * dropping the chatter — without silencing the app entirely.
 */
export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** A logger that discards everything — the default for optional-logging seams. */
export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SENSITIVE_KEY = /(?:api.?key|authorization|cookie|password|secret|token|database.?url)/i;

function redactText(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[REDACTED]");
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, seen),
    ]),
  );
}

export function createLogger(level: LogLevel): Logger {
  const threshold = RANK[level];
  const emit = (lvl: LogLevel, msg: string, meta?: unknown) => {
    if (RANK[lvl] < threshold) return;
    const line = meta === undefined ? msg : `${msg} ${JSON.stringify(sanitize(meta))}`;
    console.log(`[opod-agent] ${lvl}: ${line}`);
  };
  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}
