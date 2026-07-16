import { z } from "zod";
import { ChatMessage } from "./chat.js";

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
