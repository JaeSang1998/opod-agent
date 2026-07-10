import type OpenAI from "openai";
import type { LLMProvider } from "../provider/LLMProvider.js";
import type { PersonaStore } from "../persona/PersonaStore.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import type { JobQueue } from "../queue/JobQueue.js";
import type { RequestContext } from "../http/middleware/context.js";
import type { ChatCompletionRequest, ChatMessage } from "../openai/types.js";
import type { CoreMemory, LongTermMemory, Summary } from "../memory/types.js";
import type { RetrievalWeights } from "../memory/retrieval.js";
import { assembleSystemPrompt } from "../prompt/assemble.js";
import { buildTurnExchange } from "./consolidationDecider.js";

export interface ChatServiceConfig {
  retrieveTopK: number;
  weights: RetrievalWeights;
  recencyDecay: number;
}

export interface PreparedTurn {
  /** The provider request with the persona/memory system prompt prepended. */
  request: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, "stream">;
  /** Run after the reply is known: enqueue the per-turn consolidation job. */
  postTurn(assistantContent: string): Promise<void>;
}

/**
 * Orchestrates one chat turn: load persona, retrieve memory (weighted) + the core
 * block, assemble the prompt, and after the reply enqueue a memory-update job for
 * the current exchange. The autonomous learning (reflection) happens off the hot
 * path in consolidation. See CONTEXT.md and docs/adr/0004, 0005.
 */
export class ChatService {
  constructor(
    private readonly provider: LLMProvider,
    private readonly personas: PersonaStore,
    private readonly memory: MemoryStore,
    private readonly queue: JobQueue,
    private readonly config: ChatServiceConfig,
    private readonly log: (msg: string, meta?: unknown) => void = () => {},
  ) {}

  async prepare(body: ChatCompletionRequest, ctx: RequestContext): Promise<PreparedTurn> {
    const model = body.model ?? this.provider.defaultModel;
    const messages = body.messages as ChatMessage[];

    // No character → plain OpenAI-compatible proxy (docs/adr/0003).
    const persona = ctx.characterId
      ? await this.personas.getPublished(ctx.characterId)
      : null;

    if (!persona) {
      if (ctx.characterId) {
        this.log("no published persona; degrading to proxy", { characterId: ctx.characterId });
      }
      return {
        request: { ...body, model, stream: undefined } as PreparedTurn["request"],
        postTurn: async () => {},
      };
    }

    const lastUser = lastUserText(messages);
    const [memories, core, summary] = await Promise.all([
      this.retrieveMemories(ctx, lastUser),
      this.getCore(ctx),
      this.getSummary(ctx),
    ]);

    const systemPrompt = assembleSystemPrompt({ persona, memories, core, summary });
    const augmented: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...messages];

    return {
      request: {
        ...body,
        model,
        messages: augmented as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        stream: undefined,
      } as PreparedTurn["request"],
      postTurn: (assistantContent) => this.enqueueConsolidation(ctx, messages, assistantContent),
    };
  }

  private async retrieveMemories(
    ctx: RequestContext,
    query: string | null,
  ): Promise<LongTermMemory[]> {
    if (!ctx.userId || !ctx.characterId || !query) return [];
    try {
      const [embedding] = await this.provider.embed([query]);
      if (!embedding) return [];
      return await this.memory.retrieve(
        { userId: ctx.userId, characterId: ctx.characterId },
        embedding,
        this.config.retrieveTopK,
        { weights: this.config.weights, recencyDecay: this.config.recencyDecay },
      );
    } catch (err) {
      // Retrieval must never break a reply.
      this.log("memory retrieval failed; continuing without it", { err: String(err) });
      return [];
    }
  }

  private async getCore(ctx: RequestContext): Promise<CoreMemory | null> {
    if (!ctx.userId || !ctx.characterId) return null;
    try {
      return await this.memory.getCoreMemory({ userId: ctx.userId, characterId: ctx.characterId });
    } catch (err) {
      this.log("core memory fetch failed; continuing without it", { err: String(err) });
      return null;
    }
  }

  private async getSummary(ctx: RequestContext): Promise<Summary | null> {
    if (!ctx.sessionId) return null;
    try {
      return await this.memory.getSummary(ctx.sessionId);
    } catch (err) {
      this.log("summary fetch failed; continuing without it", { err: String(err) });
      return null;
    }
  }

  /** Enqueue a memory-update job for the current exchange (docs/adr/0004, 0005). */
  private async enqueueConsolidation(
    ctx: RequestContext,
    priorMessages: ChatMessage[],
    assistantContent: string,
  ): Promise<void> {
    if (!ctx.userId || !ctx.characterId || !ctx.sessionId) return;

    const exchange = buildTurnExchange(priorMessages, assistantContent);
    if (!exchange) return;

    try {
      await this.queue.enqueueMemoryUpdate({
        userId: ctx.userId,
        characterId: ctx.characterId,
        sessionId: ctx.sessionId,
        turns: exchange,
        refreshSummary: true,
      });
    } catch (err) {
      this.log("failed to enqueue memory-update job", { err: String(err) });
    }
  }
}

function lastUserText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.content === "string") return m.content;
  }
  return null;
}
