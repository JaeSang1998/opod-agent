import type { ChatMessage } from "../protocol/index.js";
import type { PhotoScene } from "./photo-catalog.js";

export interface PhotoSelectorInput {
  persona: string;
  recentTurns: { role: "user" | "assistant"; content: string }[];
  intent: string;
  eligiblePhotos: readonly PhotoScene[];
}

export interface PhotoSelector {
  /** Returns a server catalog id, or null when no photo fits or selection fails. */
  select(input: PhotoSelectorInput): Promise<string | null>;
}

export const unconfiguredPhotoSelector: PhotoSelector = {
  async select() { return null; },
};

/** No system/tool messages enter selection. Preserve complete recent utterances;
 * an oversized latest utterance declines sharing rather than hiding its context.
 */
export function preparePhotoSelectorInput(
  persona: string,
  messages: readonly ChatMessage[],
  intent: string,
  eligiblePhotos: readonly PhotoScene[],
): PhotoSelectorInput | null {
  const recentTurns: PhotoSelectorInput["recentTurns"] = messages.flatMap(message =>
    (message.role === "user" || message.role === "assistant") && typeof message.content === "string"
      ? [{ role: message.role, content: message.content }] : []).slice(-8);
  while (recentTurns.length > 1 && Buffer.byteLength(JSON.stringify(recentTurns), "utf8") > 12_000) recentTurns.shift();
  if (Buffer.byteLength(JSON.stringify(recentTurns), "utf8") > 12_000 || !recentTurns.length) return null;
  const bytes = Buffer.from(persona, "utf8");
  let end = Math.min(bytes.length, 6_000);
  while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    persona: end === bytes.length ? persona : `${bytes.subarray(0, end).toString("utf8")}\n[reference abbreviated]`,
    recentTurns,
    intent,
    eligiblePhotos,
  };
}
