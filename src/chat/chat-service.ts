import type OpenAI from "openai";
import { createHash, randomUUID } from "node:crypto";
import type { LLMProvider } from "../provider/llm-provider.js";
import type { PersonaStore } from "../persona/persona-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { JobQueue } from "../memory/job-queue.js";
import type { ChatCompletionRequest, ChatMessage } from "../protocol/index.js";
import { lastUserText } from "../openai/messages.js";
import type { ArchivalMemory, CoreMemory, Summary } from "../memory/types.js";
import type { RetrievalWeights } from "../memory/retrieval.js";
import { type Logger, noopLogger } from "../bootstrap/logger.js";
import type { AgentTool } from "../tools/index.js";
import { decideConsolidation } from "./consolidation-policy.js";
import { assembleSystemPrompt } from "./system-prompt.js";

export interface ChatContext {
  characterId?: string;
  userId?: string;
  sessionId?: string;
  timezone?: string;
  requestId?: string;
}

export interface ChatServiceConfig {
  retrieveTopK: number;
  weights: RetrievalWeights;
  recencyDecay: number;
  summaryTurnThreshold: number;
}

export interface PreparedTurn {
  /** The provider request with the persona/memory system prompt prepended. */
  request: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, "stream">;
  /** Run after the reply is known: enqueue the per-turn consolidation job. */
  postTurn(assistantContent: string): Promise<void>;
  /** Present only when the server-side tool loop should run for this turn. */
  tools?: AgentTool[];
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
    private readonly log: Logger = noopLogger,
    private readonly tools: AgentTool[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async prepare(
    body: ChatCompletionRequest,
    ctx: ChatContext,
    signal?: AbortSignal,
  ): Promise<PreparedTurn> {
    const model = body.model ?? this.provider.defaultModel;
    const messages = body.messages as ChatMessage[];
    const clientSuppliedTools = (body as Record<string, unknown>).tools != null;

    // A caller that supplies OpenAI tools owns the full tool protocol. Do not
    // inject Persona/Memory, execute server tools, or learn from that exchange.
    if (clientSuppliedTools) {
      return {
        request: { ...body, model, stream: undefined } as PreparedTurn["request"],
        postTurn: async () => {},
      };
    }

    // No character → plain OpenAI-compatible proxy (docs/adr/0003).
    const persona = ctx.characterId
      ? await this.personas.getPublished(ctx.characterId)
      : null;

    if (!persona) {
      if (ctx.characterId) {
        this.log.info("no published persona; degrading to proxy", { characterId: ctx.characterId });
      }
      return {
        request: { ...body, model, stream: undefined } as PreparedTurn["request"],
        postTurn: async () => {},
      };
    }

    const lastUser = lastUserText(messages);
    const [memories, core, summary] = await Promise.all([
      this.retrieveMemories(ctx, lastUser, signal),
      this.getCore(ctx),
      this.getSummary(ctx),
    ]);

    // Client-supplied tools mean pure passthrough (docs/adr/0003): the server tool
    // loop only runs for persona turns whose body carries no tools of its own.
    const serverToolsActive = this.tools.length > 0;

    const systemPrompt = assembleSystemPrompt({
      persona,
      memories,
      core,
      summary,
      now: this.clock(),
      timezone: ctx.timezone,
      toolsEnabled: serverToolsActive,
      toolNames: serverToolsActive ? this.tools.map((t) => t.definition.function.name) : undefined,
    });
    const augmented: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...messages];

    return {
      request: {
        ...body,
        model,
        messages: augmented as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        stream: undefined,
      } as PreparedTurn["request"],
      postTurn: (assistantContent) =>
        this.enqueueConsolidation(ctx, messages, assistantContent, summary),
      tools: serverToolsActive ? this.tools : undefined,
    };
  }

  private async retrieveMemories(
    ctx: ChatContext,
    query: string | null,
    signal?: AbortSignal,
  ): Promise<ArchivalMemory[]> {
    if (!ctx.userId || !ctx.characterId || !query) return [];
    try {
      const [embedding] = await this.provider.embed([query], { signal });
      if (!embedding) return [];
      return await this.memory.retrieve(
        { userId: ctx.userId, characterId: ctx.characterId },
        embedding,
        this.config.retrieveTopK,
        { weights: this.config.weights, recencyDecay: this.config.recencyDecay },
      );
    } catch (err) {
      // Retrieval must never break a reply.
      this.log.warn("memory retrieval failed; continuing without it", { err: String(err) });
      return [];
    }
  }

  private async getCore(ctx: ChatContext): Promise<CoreMemory | null> {
    if (!ctx.userId || !ctx.characterId) return null;
    try {
      return await this.memory.getCoreMemory({ userId: ctx.userId, characterId: ctx.characterId });
    } catch (err) {
      this.log.warn("core memory fetch failed; continuing without it", { err: String(err) });
      return null;
    }
  }

  private async getSummary(ctx: ChatContext): Promise<Summary | null> {
    if (!ctx.userId || !ctx.characterId || !ctx.sessionId) return null;
    try {
      return await this.memory.getSummary({
        userId: ctx.userId,
        characterId: ctx.characterId,
        sessionId: ctx.sessionId,
      });
    } catch (err) {
      this.log.warn("summary fetch failed; continuing without it", { err: String(err) });
      return null;
    }
  }

  /** Enqueue a memory-update job for the current exchange (docs/adr/0004, 0005). */
  private async enqueueConsolidation(
    ctx: ChatContext,
    priorMessages: ChatMessage[],
    assistantContent: string,
    summary: Summary | null,
  ): Promise<void> {
    if (!ctx.userId || !ctx.characterId || !ctx.sessionId) return;

    const decision = decideConsolidation(
      { messages: priorMessages, assistantContent, summary },
      { summaryTurnThreshold: this.config.summaryTurnThreshold },
    );
    if (!decision.enqueue) {
      this.log.debug("Consolidation skipped", { requestId: ctx.requestId, reason: decision.reason });
      return;
    }

    try {
      const correlationId = ctx.requestId ?? randomUUID();
      const idempotencyKey = createHash("sha256")
        .update(
          JSON.stringify({
            characterId: ctx.characterId,
            reason: decision.reason,
            sessionId: ctx.sessionId,
            summaryRevision: summary?.revision ?? 0,
            turns: decision.turns,
            userId: ctx.userId,
          }),
        )
        .digest("hex");
      await this.queue.enqueueMemoryUpdate({
        correlationId,
        idempotencyKey,
        userId: ctx.userId,
        characterId: ctx.characterId,
        sessionId: ctx.sessionId,
        turns: decision.turns,
        reason: decision.reason,
        refreshSummary: decision.refreshSummary,
      });
    } catch (err) {
      this.log.warn("failed to enqueue memory-update job", { err: String(err) });
    }
  }
}
