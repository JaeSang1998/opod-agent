import { z } from "zod";

/** OpenAI Chat Completions wire contract. OPOD context always rides in headers. */
const ChatRole = z.enum(["system", "user", "assistant", "tool", "developer", "function"]);

export const ChatMessage = z
  .object({
    role: ChatRole,
    content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
    name: z.string().optional(),
  })
  .passthrough();
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatCompletionRequest = z
  .object({
    model: z.string().optional(),
    messages: z.array(ChatMessage).min(1),
    stream: z.boolean().nullable().optional(),
    temperature: z.number().nullable().optional(),
    top_p: z.number().nullable().optional(),
    max_tokens: z.number().int().positive().nullable().optional(),
    stop: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  })
  .passthrough();
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

export const ConsolidationReason = z.enum(["memorable-content", "summary-stale", "manual"]);
export type ConsolidationReason = z.infer<typeof ConsolidationReason>;

export const ConsolidationRequest = z.object({
  characterId: z.string().min(1),
  correlationId: z.string().min(1).max(128),
  idempotencyKey: z.string().min(1).max(256),
  reason: ConsolidationReason,
  refreshSummary: z.boolean().default(false),
  sessionId: z.string().min(1),
  turns: z.array(ChatMessage).min(1),
  userId: z.string().min(1),
});
export type ConsolidationRequest = z.infer<typeof ConsolidationRequest>;

export const OPOD_HEADERS = {
  characterId: "x-opod-character-id",
  debug: "x-opod-debug",
  historyOffset: "x-opod-history-offset",
  requestId: "x-request-id",
  sessionId: "x-opod-session-id",
  timezone: "x-opod-timezone",
  turnId: "x-opod-turn-id",
  userId: "x-opod-user-id",
} as const;
