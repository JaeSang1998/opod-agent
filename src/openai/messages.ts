import type { ChatMessage } from "./types.js";

/** The latest user message whose content is non-empty text, or null. */
export function lastUserMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0) {
      return m;
    }
  }
  return null;
}

/** The text of the latest user message, or null. */
export function lastUserText(messages: ChatMessage[]): string | null {
  const m = lastUserMessage(messages);
  return m ? (m.content as string) : null;
}

/** Render user/assistant turns as a plain `role: content` transcript. */
export function transcriptOf(messages: ChatMessage[]): string {
  return messages
    .filter((m) => typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .map((m) => `${m.role}: ${m.content as string}`)
    .join("\n");
}
