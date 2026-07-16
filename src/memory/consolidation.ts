import type { LLMProvider } from "../provider/llm-provider.js";
import { completeText } from "./complete-text.js";
import type { ConsolidationRequest } from "../protocol/index.js";
import { transcriptOf } from "../openai/messages.js";
import type { MemoryStore } from "./memory-store.js";
import type { LongTermMemory, RelationshipKey, SessionKey, Summary } from "./types.js";
import type { Reflector } from "./reflection.js";
import { parseObservations, type ParsedObservation } from "./parsing.js";

export interface ConsolidationConfig {
  /** Reflect once accumulated observation importance crosses this (GA: 150/sim-day). */
  reflectionThreshold: number;
}

export type ConsolidateInput = ConsolidationRequest;

export interface ConsolidateResult {
  observationsStored: number;
  reflected: boolean;
  reflectionsStored: number;
  coreUpdated: boolean;
  summaryUpdated: boolean;
  stages: {
    observations: "completed";
    reflection: "completed" | "skipped";
    summary: "completed" | "duplicate" | "skipped";
  };
}

type ConsolidationStage = "observations" | "reflection" | "summary";

class ConsolidationStageError extends Error {
  override readonly name = "ConsolidationStageError";

  constructor(
    readonly stage: ConsolidationStage,
    readonly correlationId: string,
    override readonly cause: unknown,
  ) {
    super(`Consolidation failed during ${stage}`, { cause });
  }
}

async function atStage<T>(
  stage: ConsolidationStage,
  input: ConsolidateInput,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ConsolidationStageError(stage, input.correlationId, error);
  }
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

  async consolidate(input: ConsolidateInput, signal?: AbortSignal): Promise<ConsolidateResult> {
    const key: RelationshipKey = { userId: input.userId, characterId: input.characterId };
    const transcript = transcriptOf(input.turns);

    // 1. Extract observations about the user, each scored for importance (1-10).
    const stored = await atStage("observations", input, async () => {
      const observations = await this.extract(transcript, signal);
      const rows = await this.storeObservations(key, observations, input.idempotencyKey, signal);
      const gained = rows.reduce((sum, row) => sum + row.importance, 0);
      if (gained > 0) {
        await this.memory.addImportance(
          key,
          gained,
          `${input.idempotencyKey}:importance`,
        );
      }
      return rows;
    });
    const observationsStored = stored.length;

    // 2. Accumulate importance; reflect autonomously when the threshold is crossed.
    const reflection = await atStage("reflection", input, () =>
      this.maybeReflect(key, input.idempotencyKey, signal),
    );

    // 3. Recursive session summary (MemGPT-style running compression).
    let summaryUpdated = false;
    if (input.refreshSummary && transcript.trim()) {
      summaryUpdated = await atStage("summary", input, () =>
        this.refreshSummary(
          { ...key, sessionId: input.sessionId },
          transcript,
          input.turns.length,
          input.idempotencyKey,
          signal,
        ),
      );
    }

    return {
      observationsStored,
      ...reflection,
      summaryUpdated,
      stages: {
        observations: "completed",
        reflection: reflection.reflected ? "completed" : "skipped",
        summary: !input.refreshSummary
          ? "skipped"
          : summaryUpdated
            ? "completed"
            : "duplicate",
      },
    };
  }

  /** Combined extraction + poignancy scoring in a single call. */
  private async extract(transcript: string, signal?: AbortSignal): Promise<ParsedObservation[]> {
    if (!transcript.trim()) return [];
    const text = await completeText(this.provider, EXTRACT_SYSTEM, transcript, signal);
    return parseObservations(text);
  }

  private async storeObservations(
    key: RelationshipKey,
    observations: ParsedObservation[],
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<LongTermMemory[]> {
    if (observations.length === 0) return [];
    const embeddings = await this.provider.embed(observations.map((o) => o.content), { signal });
    return this.memory.upsertMany(
      key,
      observations.map((o, i) => ({
        content: o.content,
        embedding: embeddings[i] ?? [],
        importance: o.importance,
        kind: "observation" as const,
      })),
      `${idempotencyKey}:observations`,
    );
  }

  private async maybeReflect(
    key: RelationshipKey,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ reflected: boolean; reflectionsStored: number; coreUpdated: boolean }> {
    const consumed = await this.memory.consumeReflectionBudget(key, this.config.reflectionThreshold);
    if (consumed === null) return { reflected: false, reflectionsStored: 0, coreUpdated: false };

    try {
      const r = await this.reflector.reflect(key, idempotencyKey, signal);
      return { reflected: true, reflectionsStored: r.reflectionsStored, coreUpdated: r.coreUpdated };
    } catch (error) {
      // The worker retries failed jobs. Restore the consumed threshold so a retry
      // can reflect even though its observations are deduplicated on re-insert.
      await this.memory.addImportance(key, this.config.reflectionThreshold);
      throw error;
    }
  }

  private async refreshSummary(
    session: SessionKey,
    transcript: string,
    turnCount: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Recompute against the latest Summary after a concurrent writer wins. The
    // Store performs the revision check and idempotency insert atomically.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const previous = await this.memory.getSummary(session);
      const expectedRevision = previous?.revision ?? 0;
      const user = `Previous summary:\n${previous?.content ?? "(none)"}\n\nNew turns:\n${transcript}`;
      const text = await completeText(this.provider, SUMMARY_SYSTEM, user, signal);

      const summary: Summary = {
        ...session,
        content: text.trim() || previous?.content || "",
        turnsCovered: (previous?.turnsCovered ?? 0) + turnCount,
        revision: expectedRevision + 1,
        updatedAt: this.now(),
      };
      const result = await this.memory.saveSummary(summary, {
        idempotencyKey,
        expectedRevision,
      });
      if (result === "saved") return true;
      if (result === "duplicate") return false;
    }
    throw new Error("Summary update conflicted repeatedly");
  }
}
