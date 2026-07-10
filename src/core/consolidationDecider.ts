import type { ChatMessage } from "../openai/types.js";
import { lastUserMessage } from "../openai/messages.js";

/**
 * Hot-path gate (docs/adr/0005). A memory-update job is enqueued every turn, so
 * each job only needs to carry the *current exchange* — the latest user message
 * plus the assistant's reply. This deliberately avoids re-processing the whole
 * history each turn (the "how much is new?" watermark problem): prior turns were
 * already consolidated by their own jobs. The heavy salience decision (whether to
 * reflect) lives off the hot path in consolidation, driven by accumulated
 * importance — not by a turn count here.
 */
export function buildTurnExchange(
  messages: ChatMessage[],
  assistantContent: string,
): ChatMessage[] | null {
  const lastUser = lastUserMessage(messages);
  if (!lastUser) return null;

  const exchange: ChatMessage[] = [lastUser];
  if (assistantContent.trim()) {
    exchange.push({ role: "assistant", content: assistantContent });
  }
  return exchange;
}
