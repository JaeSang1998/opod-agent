import type { ChatMessage, ConsolidationReason as EnqueueReason } from "../protocol/index.js";
import type { Summary } from "../memory/types.js";
import { lastUserText } from "../openai/messages.js";

export interface ConsolidationPolicyConfig {
  summaryTurnThreshold: number;
}

export interface ConsolidationPolicyInput {
  messages: ChatMessage[];
  assistantContent: string;
  summary: Summary | null;
}

export type ConsolidationDecision =
  | {
      enqueue: false;
      reason: "not-needed" | "unverifiable-gap";
      refreshSummary: false;
      turns: [];
    }
  | { enqueue: true; reason: EnqueueReason; refreshSummary: true; turns: ChatMessage[] };

const ENGLISH_MEMORY_CUE =
  /\b(?:i am|i'm|i have|i've|i live|i work|i study|i like|i love|i hate|i prefer|i need|i want|i plan|my\s+[\p{L}\p{N}_' -]{1,60}\s+(?:is|are|was|were))\b/iu;
const KOREAN_MEMORY_CUE =
  /(?:나는|저는|제가|내\s|제\s|우리\s|좋아(?:해|한다)|싫어(?:해|한다)|살고\s*있|일하고\s*있|다니고\s*있|계획|기억해|생일|가족)/u;

/**
 * Decide whether a completed turn warrants asynchronous Consolidation. The
 * module also selects every conversation turn not yet covered by the Summary,
 * so callers cannot accidentally create gaps while batching quiet exchanges.
 */
export function decideConsolidation(
  input: ConsolidationPolicyInput,
  config: ConsolidationPolicyConfig,
): ConsolidationDecision {
  const conversation = input.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (input.assistantContent.trim()) {
    conversation.push({ role: "assistant", content: input.assistantContent });
  }

  // A Summary may describe more turns than a truncated client window contains.
  // Without absolute turn ids we cannot prove that window contains the complete
  // uncovered suffix, so reject it instead of persisting a gap.
  const latestExchangeSize = input.assistantContent.trim() ? 2 : 1;
  const maxSafeCovered = Math.max(0, conversation.length - latestExchangeSize);
  const claimedCovered = input.summary?.turnsCovered ?? 0;
  if (claimedCovered > maxSafeCovered) {
    return {
      enqueue: false,
      reason: "unverifiable-gap",
      refreshSummary: false,
      turns: [],
    };
  }
  const turns = conversation.slice(claimedCovered);
  const latestUser = lastUserText(input.messages) ?? "";

  const memorable = ENGLISH_MEMORY_CUE.test(latestUser) || KOREAN_MEMORY_CUE.test(latestUser);
  const summaryStale = turns.length >= config.summaryTurnThreshold;
  const reason: EnqueueReason | "not-needed" = memorable
    ? "memorable-content"
    : summaryStale
      ? "summary-stale"
      : "not-needed";

  if (reason === "not-needed") {
    return { enqueue: false, reason, refreshSummary: false, turns: [] };
  }
  return { enqueue: true, reason, refreshSummary: true, turns };
}
