import type OpenAI from "openai";
import type { LLMProvider } from "../provider/LLMProvider.js";
import type { MemoryStore, RelationshipKey } from "./MemoryStore.js";
import type { LongTermMemory } from "./types.js";
import type { RetrievalWeights } from "./retrieval.js";

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

  async reflect(key: RelationshipKey): Promise<ReflectResult> {
    const recent = await this.memory.recentObservations(key, this.config.recentN);
    if (recent.length === 0) return { reflectionsStored: 0, coreUpdated: false };

    const questions = await this.salientQuestions(recent);

    const insights: { content: string; evidence: string[] }[] = [];
    for (const q of questions) {
      const [qEmbedding] = await this.provider.embed([q]);
      const evidence = await this.memory.retrieve(key, qEmbedding ?? [], this.config.retrieveTopK, {
        weights: this.config.weights,
        recencyDecay: this.config.recencyDecay,
      });
      insights.push(...(await this.synthesize(evidence)));
    }

    let reflectionsStored = 0;
    if (insights.length > 0) {
      const embeddings = await this.provider.embed(insights.map((i) => i.content));
      const rows = await this.memory.upsertMany(
        key,
        insights.map((ins, i) => ({
          content: ins.content,
          embedding: embeddings[i] ?? [],
          importance: this.config.reflectionImportance,
          kind: "reflection" as const,
          evidence: ins.evidence,
        })),
      );
      reflectionsStored = rows.length;
    }

    const coreUpdated = await this.rewriteCore(key, recent, insights.map((i) => i.content));
    return { reflectionsStored, coreUpdated };
  }

  /** GA generate_focal_pt: the most salient high-level questions about the user. */
  private async salientQuestions(recent: LongTermMemory[]): Promise<string[]> {
    const statements = recent.map((m) => `- ${m.content}`).join("\n");
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          `Given only the statements below, what are the ${this.config.questionsPerPass} ` +
          "most salient high-level questions we can answer about the person? " +
          "Return one question per line, no numbering.",
      },
      { role: "user", content: statements },
    ];
    const res = await this.provider.chat({ model: this.provider.defaultModel, messages });
    return parseLines(res.choices[0]?.message?.content ?? "").slice(0, this.config.questionsPerPass);
  }

  /** GA insight_and_evidence: infer cited high-level insights from evidence. */
  private async synthesize(
    evidence: LongTermMemory[],
  ): Promise<{ content: string; evidence: string[] }[]> {
    if (evidence.length === 0) return [];
    const numbered = evidence.map((m, i) => `${i + 1}. ${m.content}`).join("\n");
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          `What ${this.config.insightsPerQuestion} high-level insights can you infer about the ` +
          "person from the statements below? Format each as: insight (because of 1, 3). " +
          "The numbers refer to the statements. One insight per line.",
      },
      { role: "user", content: numbered },
    ];
    const res = await this.provider.chat({ model: this.provider.defaultModel, messages });
    return parseInsights(res.choices[0]?.message?.content ?? "", evidence).slice(
      0,
      this.config.insightsPerQuestion,
    );
  }

  /** MemGPT self-edit: rewrite the compact core digest of the user. */
  private async rewriteCore(
    key: RelationshipKey,
    recent: LongTermMemory[],
    insights: string[],
  ): Promise<boolean> {
    const current = await this.memory.getCoreMemory(key);
    const material = [
      ...recent.map((m) => `- ${m.content}`),
      ...insights.map((i) => `- (insight) ${i}`),
    ].join("\n");
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          "You maintain a compact profile of a person that a character keeps in mind across " +
          `conversations. Rewrite the profile below, integrating the new material. Keep it under ` +
          `${this.config.coreCharLimit} characters, factual, and free of contradictions — correct ` +
          "outdated facts in place. Return only the profile text.",
      },
      {
        role: "user",
        content: `Current profile:\n${current?.content ?? "(empty)"}\n\nNew material:\n${material}`,
      },
    ];
    const res = await this.provider.chat({ model: this.provider.defaultModel, messages });
    const content = (res.choices[0]?.message?.content ?? "").trim();
    if (!content) return false;
    await this.memory.saveCoreMemory({
      userId: key.userId,
      characterId: key.characterId,
      content: content.slice(0, this.config.coreCharLimit),
      updatedAt: this.now(),
    });
    return true;
  }
}

/** Split a model reply into clean lines, stripping bullets/numbering. */
export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*\d]+[).]?\s*/, "").trim())
    .filter((l) => l.length > 0);
}

/**
 * Parse "insight (because of 1, 3)" lines, mapping the 1-based statement numbers
 * to the evidence memories' ids.
 */
export function parseInsights(
  text: string,
  evidence: LongTermMemory[],
): { content: string; evidence: string[] }[] {
  return parseLines(text).map((line) => {
    const match = line.match(/\(([^)]*\d[^)]*)\)\s*$/);
    let ids: string[] = [];
    let content = line;
    if (match) {
      content = line.slice(0, match.index).trim();
      const nums = ((match[1] ?? "").match(/\d+/g) ?? []).map((n) => parseInt(n, 10));
      ids = nums
        .map((n) => evidence[n - 1]?.id)
        .filter((id): id is string => Boolean(id));
    }
    return { content, evidence: ids };
  });
}
