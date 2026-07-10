import type { LLMProvider } from "../provider/LLMProvider.js";
import { completeText } from "../provider/complete.js";
import type { ChatMessage } from "../openai/types.js";
import { transcriptOf } from "../openai/messages.js";
import type { MemoryStore, RelationshipKey } from "./MemoryStore.js";
import type { Summary } from "./types.js";
import type { Reflector } from "./reflection.js";
import { parseObservations, type ParsedObservation } from "./parsing.js";

export interface ConsolidationConfig {
  /** Reflect once accumulated observation importance crosses this (GA: 150/sim-day). */
  reflectionThreshold: number;
}

export interface ConsolidateInput {
  userId: string;
  characterId: string;
  sessionId: string;
  turns: ChatMessage[];
  refreshSummary: boolean;
}

export interface ConsolidateResult {
  observationsStored: number;
  reflected: boolean;
  reflectionsStored: number;
  coreUpdated: boolean;
  summaryUpdated: boolean;
}

const EXTRACT_SYSTEM =
  "Extract durable facts worth remembering about the USER from this conversation " +
  "(preferences, personal details, relationships, ongoing situations). Ignore the " +
  "assistant's own lines. For each, rate its importance on a scale of 1 (mundane) to " +
  "10 (deeply significant). Return a JSON array of objects {\"content\": string, " +
  '"importance": number}. If nothing is worth remembering, return [].';

const SUMMARY_SYSTEM =
  "Maintain a concise running summary of a conversation for continuity. Merge the " +
  "previous summary with the new turns into a single short paragraph.";

/**
 * The consolidation pass, invoked async by opod-worker's memory-update job
 * (docs/adr/0004, 0005). Each job handles one exchange: extract observations with
 * importance, add them to archival memory, accumulate importance, and — when the
 * accumulator crosses the threshold — autonomously run a reflection pass. Also
 * keeps a recursive session summary. Runs off the chat hot path (sleep-time work).
 */
export class ConsolidationService {
  constructor(
    private readonly provider: LLMProvider,
    private readonly memory: MemoryStore,
    private readonly reflector: Reflector,
    private readonly config: ConsolidationConfig,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
    const key: RelationshipKey = { userId: input.userId, characterId: input.characterId };
    const transcript = transcriptOf(input.turns);

    // 1. Extract observations about the user, each scored for importance (1-10).
    const observations = await this.extract(transcript);
    const observationsStored = await this.storeObservations(key, observations);

    // 2. Accumulate importance; reflect autonomously when the threshold is crossed.
    const reflection = await this.maybeReflect(key, observations);

    // 3. Recursive session summary (MemGPT-style running compression).
    let summaryUpdated = false;
    if (input.refreshSummary && transcript.trim()) {
      await this.refreshSummary(input.sessionId, transcript);
      summaryUpdated = true;
    }

    return { observationsStored, ...reflection, summaryUpdated };
  }

  /** Combined extraction + poignancy scoring in a single call. */
  private async extract(transcript: string): Promise<ParsedObservation[]> {
    if (!transcript.trim()) return [];
    const text = await completeText(this.provider, EXTRACT_SYSTEM, transcript);
    return parseObservations(text);
  }

  private async storeObservations(
    key: RelationshipKey,
    observations: ParsedObservation[],
  ): Promise<number> {
    if (observations.length === 0) return 0;
    const embeddings = await this.provider.embed(observations.map((o) => o.content));
    const rows = await this.memory.upsertMany(
      key,
      observations.map((o, i) => ({
        content: o.content,
        embedding: embeddings[i] ?? [],
        importance: o.importance,
        kind: "observation" as const,
      })),
    );
    return rows.length;
  }

  private async maybeReflect(
    key: RelationshipKey,
    observations: ParsedObservation[],
  ): Promise<{ reflected: boolean; reflectionsStored: number; coreUpdated: boolean }> {
    const gained = observations.reduce((acc, o) => acc + o.importance, 0);
    if (gained === 0) return { reflected: false, reflectionsStored: 0, coreUpdated: false };

    const state = await this.memory.addImportance(key, gained);
    if (state.importanceSinceReflection < this.config.reflectionThreshold) {
      return { reflected: false, reflectionsStored: 0, coreUpdated: false };
    }

    const r = await this.reflector.reflect(key);
    await this.memory.resetImportance(key);
    return { reflected: true, reflectionsStored: r.reflectionsStored, coreUpdated: r.coreUpdated };
  }

  private async refreshSummary(sessionId: string, transcript: string): Promise<void> {
    const previous = await this.memory.getSummary(sessionId);
    const user = `Previous summary:\n${previous?.content ?? "(none)"}\n\nNew turns:\n${transcript}`;
    const text = await completeText(this.provider, SUMMARY_SYSTEM, user);

    const summary: Summary = {
      sessionId,
      content: text.trim() || previous?.content || "",
      turnsCovered: (previous?.turnsCovered ?? 0) + countTurns(transcript),
      updatedAt: this.now(),
    };
    await this.memory.saveSummary(summary);
  }
}

function countTurns(transcript: string): number {
  if (!transcript.trim()) return 0;
  return transcript.split("\n").filter((l) => l.trim().length > 0).length;
}
