import type { LLMProvider } from "../provider/llm-provider.js";
import { completeText } from "./complete-text.js";
import type { MemoryStore } from "./memory-store.js";
import type { ArchivalMemory, RelationshipKey } from "./types.js";
import type { RetrievalWeights } from "./retrieval.js";
import { parseLines, parseInsights, type ParsedInsight } from "./parsing.js";

export interface ReflectionConfig {
  /** How many recent observations seed the salient-question generation. */
  recentN: number;
  /** Salient questions to generate per reflection pass (GA uses 3). */
  questionsPerPass: number;
  /** Insights to synthesize per question. */
  insightsPerQuestion: number;
  /** How many memories to retrieve as evidence per question. */
  retrieveTopK: number;
  /** Importance assigned to synthesized reflections (they are high-level). */
  reflectionImportance: number;
  /** Max characters for the self-rewritten core block (MemGPT block limit). */
  coreCharLimit: number;
  weights: RetrievalWeights;
  recencyDecay: number;
}

export interface ReflectResult {
  reflectionsStored: number;
  coreUpdated: boolean;
}

/**
 * The autonomous learning pass (docs/adr/0005). Combines Generative Agents'
 * reflection (salient questions → retrieve evidence → synthesize cited insights,
 * appended back into the stream) with MemGPT's self-editing core block (rewrite a
 * compact, always-in-context digest of the user). Runs off the chat hot path.
 */
export class Reflector {
  constructor(
    private readonly provider: LLMProvider,
    private readonly memory: MemoryStore,
    private readonly config: ReflectionConfig,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async reflect(
    key: RelationshipKey,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<ReflectResult> {
    const recent = await this.memory.recentObservations(key, this.config.recentN);
    if (recent.length === 0) return { reflectionsStored: 0, coreUpdated: false };

    const questions = await this.salientQuestions(recent, signal);
    const insights = await this.insightsFor(key, questions, signal);

    const reflectionsStored = await this.storeInsights(key, insights, idempotencyKey, signal);
    const coreUpdated = await this.rewriteCore(
      key,
      recent,
      insights.map((i) => i.content),
      idempotencyKey,
      signal,
    );
    return { reflectionsStored, coreUpdated };
  }

  /** GA generate_focal_pt: the most salient high-level questions about the user. */
  private async salientQuestions(
    recent: ArchivalMemory[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const system =
      `Given only the statements below, what are the ${this.config.questionsPerPass} ` +
      "most salient high-level questions we can answer about the person? " +
      "Return one question per line, no numbering.";
    const statements = recent.map((m) => `- ${m.content}`).join("\n");
    const text = await completeText(this.provider, system, statements, signal);
    return parseLines(text).slice(0, this.config.questionsPerPass);
  }

  /** Retrieve evidence for each question and synthesize cited insights from it. */
  private async insightsFor(
    key: RelationshipKey,
    questions: string[],
    signal?: AbortSignal,
  ): Promise<ParsedInsight[]> {
    const insights: ParsedInsight[] = [];
    for (const q of questions) {
      const [qEmbedding] = await this.provider.embed([q], { signal });
      const evidence = await this.memory.retrieve(key, qEmbedding ?? [], this.config.retrieveTopK, {
        weights: this.config.weights,
        recencyDecay: this.config.recencyDecay,
      });
      insights.push(...(await this.synthesize(evidence, signal)));
    }
    return insights;
  }

  /** GA insight_and_evidence: infer cited high-level insights from evidence. */
  private async synthesize(
    evidence: ArchivalMemory[],
    signal?: AbortSignal,
  ): Promise<ParsedInsight[]> {
    if (evidence.length === 0) return [];
    const system =
      `What ${this.config.insightsPerQuestion} high-level insights can you infer about the ` +
      "person from the statements below? Format each as: insight (because of 1, 3). " +
      "The numbers refer to the statements. One insight per line.";
    const numbered = evidence.map((m, i) => `${i + 1}. ${m.content}`).join("\n");
    const text = await completeText(this.provider, system, numbered, signal);
    return parseInsights(text, evidence).slice(0, this.config.insightsPerQuestion);
  }

  private async storeInsights(
    key: RelationshipKey,
    insights: ParsedInsight[],
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<number> {
    if (insights.length === 0) return 0;
    const embeddings = await this.provider.embed(insights.map((i) => i.content), { signal });
    const rows = await this.memory.upsertMany(
      key,
      insights.map((ins, i) => ({
        content: ins.content,
        embedding: embeddings[i] ?? [],
        importance: this.config.reflectionImportance,
        kind: "reflection" as const,
        evidence: ins.evidence,
      })),
      idempotencyKey ? `${idempotencyKey}:reflections` : undefined,
    );
    return rows.length;
  }

  /** MemGPT self-edit: rewrite the compact core digest of the user. */
  private async rewriteCore(
    key: RelationshipKey,
    recent: ArchivalMemory[],
    insights: string[],
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const current = await this.memory.getCoreMemory(key);
    const system =
      "You maintain compact Core Memory that a Character keeps in mind across conversations. " +
      "Rewrite the Core Memory below, integrating the new material. Keep it under " +
      `${this.config.coreCharLimit} characters, factual, and free of contradictions — correct ` +
      "outdated Observations in place. Return only the Core Memory text.";
    const material = [
      ...recent.map((m) => `- ${m.content}`),
      ...insights.map((i) => `- (insight) ${i}`),
    ].join("\n");
    const user = `Current Core Memory:\n${current?.content ?? "(empty)"}\n\nNew material:\n${material}`;

    const content = (await completeText(this.provider, system, user, signal)).trim();
    if (!content) return false;
    await this.memory.saveCoreMemory(
      {
        userId: key.userId,
        characterId: key.characterId,
        content: content.slice(0, this.config.coreCharLimit),
        updatedAt: this.now(),
      },
      idempotencyKey ? `${idempotencyKey}:core` : undefined,
    );
    return true;
  }
}
