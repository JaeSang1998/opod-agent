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

export function createLogger(level: LogLevel): Logger {
  const threshold = RANK[level];
  const emit = (lvl: LogLevel, msg: string, meta?: unknown) => {
    if (RANK[lvl] < threshold) return;
    const line = meta === undefined ? msg : `${msg} ${JSON.stringify(meta)}`;
    console.log(`[opod-agent] ${lvl}: ${line}`);
  };
  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}
