import type { ChatMessage } from "../protocol/index.js";

/** A ChatMessage whose content is a plain text string (not multimodal/null). */
type TextMessage = ChatMessage & { content: string };

/** Narrows a message to one carrying plain string content. */
function isTextMessage(m: ChatMessage): m is TextMessage {
  return typeof m.content === "string";
}

/** The latest user message whose content is non-empty text, or null. */
export function lastUserMessage(messages: ChatMessage[]): TextMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && isTextMessage(m) && m.content.trim().length > 0) {
      return m;
    }
  }
  return null;
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
