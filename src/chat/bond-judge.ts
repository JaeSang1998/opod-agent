import type { BondGrade } from "../memory/bond.js";
import type { ChatMessage } from "../protocol/index.js";

export interface BondJudgeInput {
  /** Selected, budgeted character and relationship references, not instructions. */
  persona: string;
  relationship: string | null;
  /** Actual conversation only; no injected context, client system messages or tool output. */
  recentTurns: { role: "user" | "assistant"; content: string }[];
}

export type BondJudgeFailure = "configuration" | "context-too-large" | "authentication" | "rate-limit" | "unavailable" | "network" | "timeout" | "invalid-response";
export type BondJudgement = { ok: true; grade: BondGrade } | { ok: false; reason: BondJudgeFailure };

export interface BondJudge {
  judge(input: BondJudgeInput): Promise<BondJudgement>;
}

/** Direct ChatService users must inject a judge to award XP; missing is never neutral. */
export const unconfiguredBondJudge: BondJudge = {
  async judge() { return { ok: false, reason: "configuration" }; },
};

/** UTF-8 serialized byte budgets match the prepared-context budget convention.
 * Never cut an utterance mid-sentence: remove older turns, or decline an oversized
 * latest exchange. Reference text is bounded independently and visibly abbreviated.
 */
export function prepareBondJudgeInput(
  persona: string,
  relationship: string | null,
  messages: readonly ChatMessage[],
  assistant: string,
): BondJudgeInput | null {
  const recentTurns: BondJudgeInput["recentTurns"] = messages.flatMap(message =>
    (message.role === "user" || message.role === "assistant") && typeof message.content === "string"
      ? [{ role: message.role, content: message.content }] : []).slice(-7);
  recentTurns.push({ role: "assistant", content: assistant });
  while (recentTurns.length > 2 && Buffer.byteLength(JSON.stringify(recentTurns), "utf8") > 12_000) recentTurns.shift();
  if (Buffer.byteLength(JSON.stringify(recentTurns), "utf8") > 12_000) return null;
  return { persona: boundedReference(persona), relationship: relationship === null ? null : boundedReference(relationship), recentTurns };
}

function boundedReference(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= 6_000) return text;
  // Keep UTF-8 code points intact. The annotation is reference data, not a rule.
  const bytes = Buffer.from(text, "utf8");
  let end = 6_000;
  while ((bytes.readUInt8(end) & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n[reference abbreviated]`;
}
