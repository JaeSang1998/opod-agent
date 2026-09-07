import type OpenAI from "openai";
import { createHash, randomUUID } from "node:crypto";
import { LLM_LOG_TYPE, type LLMProvider } from "../provider/llm-provider.js";
import type { PersonaStore } from "../persona/persona-store.js";
import type { MemoryRetrievalResult, MemoryStore } from "../memory/memory-store.js";
import type { JobQueue } from "../memory/job-queue.js";
import type { ChatCompletionRequest, ChatMessage } from "../protocol/index.js";
import { lastUserText, withTurnContext } from "../openai/messages.js";
import type { ArchivalMemory, CoreMemory, MemoryKind, Summary } from "../memory/types.js";
import { type BondGrade, type BondSnapshot, bondSnapshot } from "../memory/bond.js";
import type { RetrievalWeights } from "../memory/retrieval.js";
import { type Logger, noopLogger } from "../bootstrap/logger.js";
import type { AgentTool } from "../tools/index.js";
import { decideConsolidation } from "./consolidation-policy.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import { assembleTurnContext } from "./turn-context.js";
import {
  type PersonaBlockSelector,
  type PromptPersonaProvenance,
  routePersona,
} from "../persona/persona-router.js";

export interface ChatContext {
  characterId?: string;
  historyOffset?: number;
  userId?: string;
  sessionId?: string;
  timezone?: string;
  requestId?: string;
  turnId?: string;
}

export interface ChatServiceConfig {
  retrieveTopK: number;
  weights: RetrievalWeights;
  recencyDecay: number;
  summaryTurnThreshold: number;
}

export type PromptContextSectionName =
  | "current_moment"
  | "bond"
  | "persona_start"
  | "persona_retrieved"
  | "core_memory"
  | "conversation_summary"
  | "retrieved_memories";

export interface PromptMemorySourceProvenance {
  id: string;
  kind: MemoryKind;
  rank: number | null;
  score: number | null;
  rawRelevance: number | null;
  retrieval: "selected" | "excluded";
  retrievalReason: "selected_top_k" | "outside_top_k" | "legacy_store_selected";
  injected: boolean;
  injectionReason: "retrieved_memories_section" | "not_retrieved";
}

export interface PromptMemoryProvenance {
  status: "completed" | "skipped" | "failed";
  reason:
    | "retrieval_completed"
    | "missing_identity"
    | "empty_query"
    | "embedding_unavailable"
    | "retrieval_failed";
  sources: PromptMemorySourceProvenance[];
}

/** Content-free prompt provenance exposed only through the opt-in debug channel. */
export interface PromptDebugMetadata {
  schemaVersion: 1;
  stablePromptSha256: string;
  /** Active authored blocks loaded for the character, including non-reactive blocks. */
  personaBlockCount: number;
  canonCount: number;
  contextSectionNames: PromptContextSectionName[];
  retrievedMemoryCount: number;
  /** Optional on the wire so older remote deployments remain parseable. */
  memoryProvenance?: PromptMemoryProvenance;
  /** Optional on the wire so older remote deployments remain parseable. */
  personaProvenance?: PromptPersonaProvenance;
  memoryPolicyVersion: 1;
  retrievalConfig: {
    topK: number;
    weights: RetrievalWeights;
    recencyDecay: number;
    summaryTurnThreshold: number;
  };
}

export interface PreparedTurn {
  /** The provider request with the persona/memory system prompt prepended. */
  request: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, "stream">;
  /**
   * Run after the reply is known: move the Bond by the grade the character
   * reported and enqueue the per-turn consolidation job. `assistantContent`
   * must already have the closeness tag stripped out of it.
   */
  postTurn(assistantContent: string, grade?: BondGrade | null): Promise<void>;
  /** Present only when the server-side tool loop should run for this turn. */
  tools?: AgentTool[];
  /**
   * True when the prompt asked for a closing closeness tag, and therefore when
   * the transport must redact one out of the reply. False for proxy turns,
   * whose bytes are passed through untouched (docs/adr/0003) — stripping a
   * bracket sequence out of somebody else's passthrough traffic would be a bug.
   */
  expectsBondSignal: boolean;
  /** Present only for a served Persona; contains no prompt or memory text. */
  promptDebug?: PromptDebugMetadata;
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
    private readonly personaBlockSelector?: PersonaBlockSelector,
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
        expectsBondSignal: false,
      };
    }

    // No character → plain OpenAI-compatible proxy (docs/adr/0003).
    const persona = ctx.characterId
      ? await this.personas.get(ctx.characterId)
      : null;

    if (!persona) {
      if (ctx.characterId) {
        this.log.info("no persona for character; degrading to proxy", { characterId: ctx.characterId });
      }
      return {
        request: { ...body, model, stream: undefined } as PreparedTurn["request"],
        postTurn: async () => {},
        expectsBondSignal: false,
      };
    }

    const lastUser = lastUserText(messages);
    const [retrievedPersonaBlockIds, retrieval, core, summary, bond] = await Promise.all([
      this.selectPersonaBlocks(persona, lastUser, signal),
      this.retrieveMemories(ctx, lastUser, signal),
      this.getCore(ctx),
      this.getSummary(ctx),
      this.getBond(ctx),
    ]);
    const memories = retrieval.memories;
    const routedPersona = routePersona({
      persona,
      isConversationStart: isConversationStart(messages, ctx.historyOffset ?? 0),
      retrievedBlockIds: retrievedPersonaBlockIds,
    });

    // Client-supplied tools mean pure passthrough (docs/adr/0003): the server tool
    // loop only runs for persona turns whose body carries no tools of its own.
    const serverToolsActive = this.tools.length > 0;
    // Identity, not a loaded snapshot: a store hiccup must not flip the system
    // prompt for one turn and cost the prefix cache with it.
    const tracksBond = Boolean(ctx.userId && ctx.characterId);

    // Two halves, split by how often they change (docs/adr/0007). The system
    // prompt is the character and holds still, so every Provider between here
    // and the GPU can keep it cached; everything that moves per turn — clock,
    // bond, memory, summary — is appended to the last user message, behind the
    // whole unchanged history.
    const systemPrompt = assembleSystemPrompt({
      persona: routedPersona.stablePersona,
      toolsEnabled: serverToolsActive,
      toolNames: serverToolsActive ? this.tools.map((t) => t.definition.function.name) : undefined,
      tracksBond,
    });
    const turnContext = assembleTurnContext({
      bond,
      core,
      summary,
      memories,
      personaStartBlocks: routedPersona.startOnlyBlocks,
      personaRetrievedBlocks: routedPersona.retrievedBlocks,
      now: this.clock(),
      timezone: ctx.timezone,
    });
    const augmented: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...withTurnContext(messages, turnContext),
    ];
    const contextSectionNames: PromptContextSectionName[] = ["current_moment"];
    if (bond) contextSectionNames.push("bond");
    if (routedPersona.startOnlyBlocks.length > 0) contextSectionNames.push("persona_start");
    if (routedPersona.retrievedBlocks.length > 0) {
      contextSectionNames.push("persona_retrieved");
    }
    if (core?.content) contextSectionNames.push("core_memory");
    if (summary?.content) contextSectionNames.push("conversation_summary");
    if (memories.length > 0) contextSectionNames.push("retrieved_memories");

    return {
      request: {
        ...body,
        model,
        messages: augmented as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        stream: undefined,
      } as PreparedTurn["request"],
      postTurn: async (assistantContent, grade) => {
        // Independent of each other: the Bond must move on every exchange,
        // while Consolidation skips the ones with nothing to learn from.
        await Promise.all([
          this.grantBond(ctx, grade ?? null),
          this.enqueueConsolidation(ctx, messages, assistantContent, summary),
        ]);
      },
      tools: serverToolsActive ? this.tools : undefined,
      // Exactly when the prompt carries the rule that asks for the tag.
      expectsBondSignal: tracksBond,
      promptDebug: {
        schemaVersion: 1,
        stablePromptSha256: createHash("sha256").update(systemPrompt, "utf8").digest("hex"),
        personaBlockCount: persona.blocks.length,
        canonCount: persona.canonMemories.length,
        contextSectionNames,
        retrievedMemoryCount: memories.length,
        memoryProvenance: retrieval.provenance,
        personaProvenance: routedPersona.provenance,
        memoryPolicyVersion: 1,
        retrievalConfig: {
          topK: this.config.retrieveTopK,
          weights: { ...this.config.weights },
          recencyDecay: this.config.recencyDecay,
          summaryTurnThreshold: this.config.summaryTurnThreshold,
        },
      },
    };
  }

  private async selectPersonaBlocks(
    persona: Parameters<typeof routePersona>[0]["persona"],
    query: string | null,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const blocks = persona.blocks.filter((block) => block.injection === "retrieved");
    if (!query || !this.personaBlockSelector || blocks.length === 0) {
      return [];
    }
    try {
      return await this.personaBlockSelector.selectRelevantBlockIds(
        { characterId: persona.characterId, blocks, query },
        signal,
      );
    } catch (err) {
      this.log.warn("persona block selection failed; continuing without optional lore", {
        err: String(err),
      });
      return [];
    }
  }

  private async retrieveMemories(
    ctx: ChatContext,
    query: string | null,
    signal?: AbortSignal,
  ): Promise<{ memories: ArchivalMemory[]; provenance: PromptMemoryProvenance }> {
    if (!ctx.userId || !ctx.characterId) {
      return {
        memories: [],
        provenance: { status: "skipped", reason: "missing_identity", sources: [] },
      };
    }
    if (!query) {
      return {
        memories: [],
        provenance: { status: "skipped", reason: "empty_query", sources: [] },
      };
    }
    try {
      const [embedding] = await this.provider.embed([query], {
        signal,
        log: {
          type: LLM_LOG_TYPE.memoryRetrieveEmbedding,
          requestId: ctx.requestId,
          userId: ctx.userId,
          characterId: ctx.characterId,
        },
      });
      if (!embedding) {
        return {
          memories: [],
          provenance: { status: "skipped", reason: "embedding_unavailable", sources: [] },
        };
      }
      const key = { userId: ctx.userId, characterId: ctx.characterId };
      const opts = { weights: this.config.weights, recencyDecay: this.config.recencyDecay };
      if (this.memory.retrieveWithTrace) {
        const result = await this.memory.retrieveWithTrace(
          key,
          embedding,
          this.config.retrieveTopK,
          opts,
        );
        return {
          memories: result.memories,
          provenance: this.provenanceForTracedRetrieval(result),
        };
      }

      const memories = await this.memory.retrieve(key, embedding, this.config.retrieveTopK, opts);
      return {
        memories,
        provenance: {
          status: "completed",
          reason: "retrieval_completed",
          sources: memories.map((memory, index) => ({
            id: memory.id,
            kind: memory.kind,
            rank: index + 1,
            score: null,
            rawRelevance: null,
            retrieval: "selected",
            retrievalReason: "legacy_store_selected",
            injected: true,
            injectionReason: "retrieved_memories_section",
          })),
        },
      };
    } catch (err) {
      // Retrieval must never break a reply.
      this.log.warn("memory retrieval failed; continuing without it", { err: String(err) });
      return {
        memories: [],
        provenance: { status: "failed", reason: "retrieval_failed", sources: [] },
      };
    }
  }

  private provenanceForTracedRetrieval(
    result: MemoryRetrievalResult,
  ): PromptMemoryProvenance {
    const injectedIds = new Set(result.memories.map((memory) => memory.id));
    return {
      status: "completed",
      reason: "retrieval_completed",
      sources: result.candidates.map((candidate) => {
        const injected = injectedIds.has(candidate.id);
        return {
          id: candidate.id,
          kind: candidate.kind,
          rank: candidate.rank,
          score: candidate.score,
          rawRelevance: candidate.rawRelevance,
          retrieval: candidate.decision,
          retrievalReason: candidate.reason,
          injected,
          injectionReason: injected ? "retrieved_memories_section" : "not_retrieved",
        };
      }),
    };
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

  /**
   * Pure read — recency is derived from the stored last-exchange stamp rather
   * than recomputed and written back, so the chat hot path stays read-only. A
   * store failure degrades to no bond section at all, which reads as a neutral
   * first meeting; that is a better failure than guessing at a closeness we
   * can't verify.
   */
  private async getBond(ctx: ChatContext): Promise<BondSnapshot | null> {
    if (!ctx.userId || !ctx.characterId) return null;
    try {
      const state = await this.memory.getRelationshipState({
        userId: ctx.userId,
        characterId: ctx.characterId,
      });
      return bondSnapshot(
        { bondXp: state.bondXp, lastExchangeAtMs: Date.parse(state.lastExchangeAt) },
        this.clock().getTime(),
      );
    } catch (err) {
      this.log.warn("relationship state fetch failed; continuing without bond", {
        err: String(err),
      });
      return null;
    }
  }

  /**
   * Move the Bond by the grade the character reported for this exchange.
   *
   * A missing grade counts as 0, never as a skip: the write is also what marks
   * the relationship as touched just now, and a model that forgot its tag must
   * not leave the character acting distant with someone it was mid-conversation
   * with. `turnId` gates it because the operation key is what makes a retried
   * turn idempotent — without one, a client retry would grade the same exchange
   * twice.
   */
  private async grantBond(ctx: ChatContext, grade: BondGrade | null): Promise<void> {
    if (!ctx.userId || !ctx.characterId || !ctx.turnId) return;
    if (grade === null) {
      this.log.debug("no closeness grade in reply; treating as neutral", {
        requestId: ctx.requestId,
      });
    }
    try {
      await this.memory.grantBond(
        { userId: ctx.userId, characterId: ctx.characterId },
        { grade: grade ?? 0, nowMs: this.clock().getTime() },
        `${ctx.sessionId ?? ""}:${ctx.turnId}`,
      );
    } catch (err) {
      // A relationship that failed to move is not a failed reply.
      this.log.warn("bond grant failed", { err: String(err), requestId: ctx.requestId });
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
      {
        messages: priorMessages,
        assistantContent,
        historyOffset: ctx.historyOffset ?? 0,
        summary,
      },
      { summaryTurnThreshold: this.config.summaryTurnThreshold },
    );
    if (!decision.enqueue) {
      this.log.debug("Consolidation skipped", { requestId: ctx.requestId, reason: decision.reason });
      return;
    }
    if (!ctx.turnId) {
      this.log.warn("Consolidation skipped without a logical turn id", {
        requestId: ctx.requestId,
      });
      return;
    }

    try {
      const correlationId = ctx.requestId ?? randomUUID();
      const idempotencyKey = createHash("sha256")
        .update(
          JSON.stringify({
            characterId: ctx.characterId,
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
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

function isConversationStart(messages: readonly ChatMessage[], historyOffset: number): boolean {
  return historyOffset === 0 && !messages.some((message) => message.role === "assistant");
}
