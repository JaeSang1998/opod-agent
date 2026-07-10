import type OpenAI from "openai";
import type { LLMProvider } from "../provider/LLMProvider.js";
import type { MemoryStore, RelationshipKey } from "./MemoryStore.js";
import type { Summary } from "./types.js";
import type { ChatMessage } from "../openai/types.js";
import type { Reflector } from "./reflection.js";
import { parseLines } from "./reflection.js";

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

interface Observation {
  content: string;
  importance: number;
}

function transcriptOf(turns: ChatMessage[]): string {
  return turns
    .filter((m) => typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .map((m) => `${m.role}: ${m.content as string}`)
    .join("\n");
}

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
    let observationsStored = 0;
    if (observations.length > 0) {
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
      observationsStored = rows.length;
    }

    // 2. Accumulate importance; reflect autonomously when the threshold is crossed.
    let reflected = false;
    let reflectionsStored = 0;
    let coreUpdated = false;
    const sum = observations.reduce((acc, o) => acc + o.importance, 0);
    if (sum > 0) {
      const state = await this.memory.addImportance(key, sum);
      if (state.importanceSinceReflection >= this.config.reflectionThreshold) {
        const r = await this.reflector.reflect(key);
        reflectionsStored = r.reflectionsStored;
        coreUpdated = r.coreUpdated;
        await this.memory.resetImportance(key);
        reflected = true;
      }
    }

    // 3. Recursive session summary (MemGPT-style running compression).
    let summaryUpdated = false;
    if (input.refreshSummary && transcript.trim()) {
      await this.refreshSummary(input.sessionId, transcript);
      summaryUpdated = true;
    }

    return { observationsStored, reflected, reflectionsStored, coreUpdated, summaryUpdated };
  }

  /** Combined extraction + poignancy scoring in a single call. */
  private async extract(transcript: string): Promise<Observation[]> {
    if (!transcript.trim()) return [];
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          "Extract durable facts worth remembering about the USER from this conversation " +
          "(preferences, personal details, relationships, ongoing situations). Ignore the " +
          "assistant's own lines. For each, rate its importance on a scale of 1 (mundane) to " +
          "10 (deeply significant). Return a JSON array of objects {\"content\": string, " +
          '"importance": number}. If nothing is worth remembering, return [].',
      },
      { role: "user", content: transcript },
    ];
    const res = await this.provider.chat({ model: this.provider.defaultModel, messages });
    return parseObservations(res.choices[0]?.message?.content ?? "[]");
  }

  private async refreshSummary(sessionId: string, transcript: string): Promise<void> {
    const previous = await this.memory.getSummary(sessionId);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          "Maintain a concise running summary of a conversation for continuity. Merge the " +
          "previous summary with the new turns into a single short paragraph.",
      },
      {
        role: "user",
        content: `Previous summary:\n${previous?.content ?? "(none)"}\n\nNew turns:\n${transcript}`,
      },
    ];
    const res = await this.provider.chat({ model: this.provider.defaultModel, messages });
    const content = res.choices[0]?.message?.content?.trim() ?? previous?.content ?? "";

    const summary: Summary = {
      sessionId,
      content,
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

/** Tolerant parse of the extraction reply into {content, importance} records. */
export function parseObservations(text: string): Observation[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(arr)) {
        return arr
          .map((x) => normalizeObservation(x))
          .filter((o): o is Observation => o !== null);
      }
    } catch {
      // fall through
    }
  }
  // Fallback: bullet/numbered lines with a default mid importance.
  return parseLines(trimmed).map((content) => ({ content, importance: 5 }));
}

function normalizeObservation(x: unknown): Observation | null {
  if (typeof x === "string") {
    return x.trim() ? { content: x.trim(), importance: 5 } : null;
  }
  if (x && typeof x === "object" && "content" in x) {
    const content = String((x as { content: unknown }).content ?? "").trim();
    if (!content) return null;
    const rawImp = (x as { importance?: unknown }).importance;
    const importance = clampImportance(typeof rawImp === "number" ? rawImp : Number(rawImp));
    return { content, importance };
  }
  return null;
}

function clampImportance(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}
