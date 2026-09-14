import type { ChatMessage } from "../protocol/index.js";
import { withTurnContext } from "../openai/messages.js";

interface ContextBudgetEntry<T> {
  id: string;
  /** Larger values are retained ahead of smaller values. */
  priority: number;
  value: T;
}

export interface ContextBudgetInputs<T> {
  system: string;
  messages: readonly ChatMessage[];
  optionalEntries: readonly ContextBudgetEntry<T>[];
  /** With no optional entries, returns only mandatory per-turn context. */
  assembleTurnContext: (values: readonly T[]) => string | null;
  maxBytes: number;
  /** Caller-measured fixed request fields, framing and tool definitions; default 0. */
  requestOverheadBytes?: number;
}

interface ContextBudgetTrace {
  maxBytes: number;
  bytes: number;
  retainedIds: string[];
  droppedIds: string[];
}

export type ContextBudgetResult =
  | (ContextBudgetTrace & { status: "within_budget"; messages: ChatMessage[] })
  | (ContextBudgetTrace & { status: "overflow" });

/**
 * Bounds UTF-8 bytes of the serialized messages plus caller-measured fixed
 * request overhead, not model tokens. The assembler must be pure and leave
 * mandatory context in place when called with no entries. Only optional entries may be removed:
 * system text and every raw message remain complete, even on overflow.
 */
export function fitContextBudget<T>(inputs: ContextBudgetInputs<T>): ContextBudgetResult {
  const removalOrder = inputs.optionalEntries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.priority - b.entry.priority || b.index - a.index);
  const removed = new Set<number>();
  const droppedIds: string[] = [];

  for (;;) {
    const retained = inputs.optionalEntries.filter((_, index) => !removed.has(index));
    const context = inputs.assembleTurnContext(retained.map((entry) => entry.value));
    const messages: ChatMessage[] = [
      { role: "system", content: inputs.system },
      ...withTurnContext([...inputs.messages], context),
    ];
    const trace: ContextBudgetTrace = {
      bytes: Buffer.byteLength(JSON.stringify(messages), "utf8") + (inputs.requestOverheadBytes ?? 0),
      maxBytes: inputs.maxBytes,
      retainedIds: retained.map((entry) => entry.id),
      droppedIds: [...droppedIds],
    };
    if (trace.bytes <= inputs.maxBytes) return { status: "within_budget", messages, ...trace };

    const next = removalOrder[removed.size];
    if (!next) return { status: "overflow", ...trace };
    removed.add(next.index);
    droppedIds.push(next.entry.id);
  }
}
