import type { ChatMessage } from "../protocol/index.js";

/** A ChatMessage whose content is a plain text string (not multimodal/null). */
type TextMessage = ChatMessage & { content: string };

/** Narrows a message to one carrying plain string content. */
function isTextMessage(m: ChatMessage): m is TextMessage {
  return typeof m.content === "string";
}

/** Index of the latest user message with non-empty text content, or -1. */
function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && isTextMessage(m) && m.content.trim().length > 0) {
      return i;
    }
  }
  return -1;
}

/** The latest user message whose content is non-empty text, or null. */
export function lastUserMessage(messages: ChatMessage[]): TextMessage | null {
  const index = lastUserIndex(messages);
  return index < 0 ? null : (messages[index] as TextMessage);
}

/**
 * `messages` with per-turn context before the text of the last user message.
 *
 * Keep the block behind unchanged history for prefix caching, but finish the
 * target message with what the person actually typed, not runtime guidance.
 * Reuse the existing user-message envelope rather than adding a trailing
 * system/developer role that OpenAI-compatible chat templates may not support.
 *
 * Never mutates: the caller's array is what Consolidation later learns from,
 * and it must keep the words the person actually typed and nothing else.
 */
export function withTurnContext(messages: ChatMessage[], block: string | null): ChatMessage[] {
  if (!block) return messages;
  const index = lastUserIndex(messages);
  // A history with no user turn at all cannot be answered anyway; carrying the
  // block on its own message is still better than dropping it silently.
  if (index < 0) return [...messages, { role: "user", content: block }];

  const target = messages[index] as TextMessage;
  const copy = [...messages];
  copy[index] = { ...target, content: `${block}\n\n${target.content}` };
  return copy;
}

/** The text of the latest user message, or null. */
export function lastUserText(messages: ChatMessage[]): string | null {
  const m = lastUserMessage(messages);
  return m ? m.content : null;
}

/** Render user/assistant turns as a plain `role: content` transcript. */
export function transcriptOf(messages: ChatMessage[]): string {
  return messages
    .filter((m): m is TextMessage => isTextMessage(m) && (m.role === "user" || m.role === "assistant"))
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}
