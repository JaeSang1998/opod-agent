import type OpenAI from "openai";
import { createHash, randomUUID } from "node:crypto";
import { LLM_LOG_TYPE, type LLMProvider } from "../provider/llm-provider.js";
import { personaContextHash, PersonaContextIntegrityError, type PersonaStore } from "../persona/persona-store.js";
import type { MemoryRetrievalResult, MemoryStore } from "../memory/memory-store.js";
import type { JobQueue } from "../memory/job-queue.js";
import type { ChatCompletionRequest, ChatMessage } from "../protocol/index.js";
import { lastUserMessage, lastUserText, withTurnContext } from "../openai/messages.js";
import type { ArchivalMemory, MemoryKind, Summary } from "../memory/types.js";
import { type BondGrade, type BondSnapshot, bondSnapshot } from "../memory/bond.js";
import { validQueryEmbedding, type RetrievalWeights } from "../memory/retrieval.js";
import { type Logger, noopLogger } from "../bootstrap/logger.js";
import type { AgentTool } from "../tools/index.js";
import { decideConsolidation } from "./consolidation-policy.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import { assembleTurnContext } from "./turn-context.js";
import { contextRecallQuery, selectCharacterRecallIds } from "../persona/character-recall.js";
import { fitContextBudget, type ContextBudgetResult } from "./context-budget.js";
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
  minMemoryRelevance?: number;
  integratedContext?: boolean;
  contextMaxBytes?: number;
  /** Set only for a fixed provider whose embedding model identity is verified. */
  embeddingModel?: string;
}

export type PromptContextSectionName =
  | "current_moment"
  | "bond"
  | "persona_start"
  | "persona_retrieved"
  | "character_memories"
  | "always_memories"
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
  retrievalReason: "selected_top_k" | "outside_top_k" | "below_relevance_threshold" | "legacy_store_selected" | "duplicate_content";
  injected: boolean;
  injectionReason: "retrieved_memories_section" | "not_retrieved";
}

export interface PromptMemoryProvenance {
  hybrid?: MemoryRetrievalResult["hybrid"];
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
  /** Loaded canon sources, not the number injected into the stable prefix. */
  canonCount: number;
  contextSectionNames: PromptContextSectionName[];
  retrievedMemoryCount: number;
  /** Optional on the wire so older remote deployments remain parseable. */
  memoryProvenance?: PromptMemoryProvenance;
  contextBudget?: Omit<ContextBudgetResult, "messages">;
  characterRetrieval?: { semanticStatus: string };
  /** Optional on the wire so older remote deployments remain parseable. */
  personaProvenance?: PromptPersonaProvenance;
  memoryPolicyVersion: 1 | 2;
  retrievalConfig: {
    topK: number;
    weights: RetrievalWeights;
    recencyDecay: number;
    summaryTurnThreshold: number;
    minRelevance?: number;
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

    const latest = lastUserMessage(messages);
    const lastUser = latest?.content ?? null;
    const latestIndex = latest ? messages.lastIndexOf(latest) : -1;
    const previousUser = lastUserText(messages.slice(Math.max(0, latestIndex - 2), Math.max(0, latestIndex))) ?? undefined;
    const retrievalQuery = this.config.integratedContext ? contextRecallQuery(messages) : lastUser;
    let contextEmbedding: number[] = [];
    let embeddingModel = this.config.embeddingModel;
    if (this.config.integratedContext && retrievalQuery && (this.provider.embedQuery || embeddingModel)) {
      try {
        if (this.provider.embedQuery) {
          const result = await this.provider.embedQuery([retrievalQuery], { signal,
            log: { type: LLM_LOG_TYPE.memoryRetrieveEmbedding, requestId: ctx.requestId, userId: ctx.userId, characterId: ctx.characterId } });
          embeddingModel = result.model;
          contextEmbedding = result.embeddings[0] ?? [];
        } else {
          contextEmbedding = (await this.provider.embed([retrievalQuery], { signal }))[0] ?? [];
        }
        if (!embeddingModel || !validQueryEmbedding(contextEmbedding)) throw new Error("incompatible query embedding");
      } catch {
        contextEmbedding = []; embeddingModel = undefined;
        this.log.warn("context embedding unavailable; using lexical retrieval");
      }
    }
    const [fallbackBlockIds, retrieval, alwaysMemories, summary, bond, characterRetrieval] = await Promise.all([
      this.selectPersonaBlocks(persona, lastUser, signal, previousUser),
      this.retrieveMemories(ctx, retrievalQuery, signal, contextEmbedding, embeddingModel),
      this.getAlwaysMemories(ctx),
      this.getSummary(ctx),
      this.getBond(ctx),
      this.config.integratedContext && this.personas.retrieveContext && retrievalQuery
        ? this.personas.retrieveContext({ characterId: persona.characterId, queryText: retrievalQuery,
          queryEmbedding: contextEmbedding, embeddingModel, topK: 4 })
          .catch((error: unknown) => {
            if (error instanceof PersonaContextIntegrityError) throw error;
            return { fragmentIds: [] as string[], canonIds: [] as string[], sourceHashes: {} as Record<string, string>, contextHashes: {} as Record<string, string>, semanticStatus: "failed" as const };
          })
        : Promise.resolve(null),
    ]);
    let memories = [
      ...alwaysMemories,
      ...retrieval.memories.filter(
        (memory) => !alwaysMemories.some((always) => always.id === memory.id),
      ),
    ];
    const freshBlock = (id: string, block: typeof persona.blocks[number]) => characterRetrieval?.contextHashes[id] === personaContextHash({
      content: block.content, kind: block.kind ?? "", injection: block.injection ?? "", recallKeys: block.recallKeys ?? [], occurredAt: null, occurredLabel: null, occurredPrecision: null, sourceRefsSha256: null,
    });
    const freshCanon = (id: string, memory: Exclude<typeof persona.canonMemories[number], string>) => characterRetrieval?.contextHashes[id] === personaContextHash({
      content: memory.content, kind: memory.kind ?? "", injection: memory.injection ?? "", recallKeys: memory.recallKeys ?? [], occurredAt: memory.occurredAt ?? null, occurredLabel: memory.occurredLabel ?? null, occurredPrecision: memory.occurredPrecision ?? null, sourceRefsSha256: memory.sourceRefsSha256 ?? null,
    });
    const retrievedPersonaBlockIds = characterRetrieval ? persona.blocks.flatMap(block =>
      block.id && block.storedFragmentId && characterRetrieval.fragmentIds.includes(block.storedFragmentId) && freshBlock(block.storedFragmentId, block) ? [block.id] : []) : fallbackBlockIds;
    const routedPersona = routePersona({
      persona,
      isConversationStart: isConversationStart(messages, ctx.historyOffset ?? 0),
      retrievedBlockIds: retrievedPersonaBlockIds,
      retrievedCanonIds: characterRetrieval ? persona.canonMemories.flatMap(memory => typeof memory !== "string" && characterRetrieval.canonIds.includes(memory.id) && freshCanon(memory.id, memory) ? [memory.id] : []) : selectCharacterRecallIds(lastUser ?? "", persona.canonMemories.flatMap(memory =>
        typeof memory !== "string" && memory.injection === "retrieved" ? [memory] : []), previousUser),
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
    // bond, memory, summary — rides in the last user message, behind the whole
    // unchanged history but before the person's actual text.
    const systemPrompt = assembleSystemPrompt({
      persona: routedPersona.stablePersona,
      toolsEnabled: serverToolsActive,
      toolNames: serverToolsActive ? this.tools.map((t) => t.definition.function.name) : undefined,
      tracksBond,
    });
    const now = this.clock();
    // Omit only a summary fully covered by the raw prefix supplied in this request.
    const contextSummary = this.config.integratedContext && (ctx.historyOffset ?? 0) === 0 && summary && summary.turnsCovered <= latestIndex ? null : summary;
    const turnInputs = {
      bond,
      core: null,
      summary: contextSummary,
      memories,
      personaStartBlocks: routedPersona.startOnlyBlocks,
      personaRetrievedBlocks: routedPersona.retrievedBlocks,
      characterMemories: routedPersona.retrievedCanonMemories,
      now,
      timezone: ctx.timezone,
      integratedContext: this.config.integratedContext,
    };
    const turnContext = assembleTurnContext(turnInputs);
    let augmented: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...withTurnContext(messages, turnContext),
    ];
    let budgetTrace: Omit<ContextBudgetResult, "messages"> | undefined;
    if (this.config.integratedContext) {
      const entries = [
        ...routedPersona.startOnlyBlocks.map((value, i) => ({ id: `start:${i}`, priority: 90, value: { type: "start" as const, value } })),
        ...routedPersona.retrievedBlocks.map((value, i) => ({ id: `persona:${i}`, priority: 60 - i, value: { type: "persona" as const, value } })),
        ...routedPersona.retrievedCanonMemories.map((value, i) => ({ id: `canon:${i}`, priority: 50 - i, value: { type: "canon" as const, value } })),
        ...memories.map((value, i) => ({
          id: `memory:${value.id}`,
          priority: value.contextInjectionMode === "always" ? 80 - i : 40 - i,
          value: { type: "memory" as const, value },
        })),
      ];
      const seen = new Set<string>();
      const fingerprint = (text: string) => text.normalize("NFKC").trim().replace(/\s+/gu, " ");
      const optionalEntries = entries.filter(entry => {
        const content = fingerprint(entry.value.value.content);
        const owner = entry.value.type === "memory" ? `memory:${entry.value.value.kind}:${entry.value.value.memoryType ?? "legacy_unknown"}` : entry.value.type;
        const key = `${owner}:${content}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      const budget = fitContextBudget<(typeof optionalEntries)[number]["value"]>({ system: systemPrompt, messages, optionalEntries,
        maxBytes: this.config.contextMaxBytes ?? 32_000,
        requestOverheadBytes: Buffer.byteLength(JSON.stringify({ ...body, model, messages: [], stream: false,
          ...(serverToolsActive ? { tools: this.tools.map(t => t.definition) } : {}) }), "utf8") - 2,
        assembleTurnContext: values => assembleTurnContext({ ...turnInputs,
          memories: values.flatMap(v => v.type === "memory" ? [v.value] : []),
          personaStartBlocks: values.flatMap(v => v.type === "start" ? [v.value] : []),
          personaRetrievedBlocks: values.flatMap(v => v.type === "persona" ? [v.value] : []),
          characterMemories: values.flatMap(v => v.type === "canon" ? [v.value] : []),
        }),
      });
      if (budget.status === "overflow") throw new Error(`context byte budget exceeded: ${budget.bytes} > ${budget.maxBytes}; raw conversation retained, no request sent`);
      const { messages: fittedMessages, ...trace } = budget;
      augmented = fittedMessages; budgetTrace = trace;
      const retained = new Set(budget.retainedIds);
      memories = memories.filter(m => retained.has(`memory:${m.id}`));
      routedPersona.startOnlyBlocks = routedPersona.startOnlyBlocks.filter((_, i) => retained.has(`start:${i}`));
      routedPersona.retrievedBlocks = routedPersona.retrievedBlocks.filter((_, i) => retained.has(`persona:${i}`));
      routedPersona.retrievedCanonMemories = routedPersona.retrievedCanonMemories.filter((_, i) => retained.has(`canon:${i}`));
      for (const source of retrieval.provenance.sources) {
        if (source.injected && !memories.some(m => m.id === source.id)) { source.injected = false; source.injectionReason = "not_retrieved"; }
      }
      for (const source of routedPersona.provenance.sources) {
        if (source.destination === "turn_context" && ![...routedPersona.startOnlyBlocks, ...routedPersona.retrievedBlocks].some(b => b.id === source.id)) {
          source.destination = "excluded"; source.reason = "not_retrieved";
        }
      }
      for (const source of routedPersona.provenance.canonSources ?? []) {
        if (source.destination === "turn_context" && !routedPersona.retrievedCanonMemories.some(m => m.id === source.id)) {
          source.destination = "excluded"; source.reason = "not_retrieved";
        }
      }
    }
    const contextSectionNames: PromptContextSectionName[] = ["current_moment"];
    if (bond) contextSectionNames.push("bond");
    if (routedPersona.startOnlyBlocks.length > 0) contextSectionNames.push("persona_start");
    if (routedPersona.retrievedBlocks.length > 0) {
      contextSectionNames.push("persona_retrieved");
    }
    if (routedPersona.retrievedCanonMemories.length > 0) contextSectionNames.push("character_memories");
    if (memories.some((memory) => memory.contextInjectionMode === "always")) {
      contextSectionNames.push("always_memories");
    }
    if (contextSummary?.content) contextSectionNames.push("conversation_summary");
    if (memories.some((memory) => memory.contextInjectionMode !== "always")) {
      contextSectionNames.push("retrieved_memories");
    }

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
        ...(budgetTrace ? { contextBudget: budgetTrace } : {}),
        ...(characterRetrieval ? { characterRetrieval: { semanticStatus: characterRetrieval.semanticStatus } } : {}),
        personaProvenance: routedPersona.provenance,
        memoryPolicyVersion: this.config.minMemoryRelevance === undefined ? 1 : 2,
        retrievalConfig: {
          topK: this.config.retrieveTopK,
          weights: { ...this.config.weights },
          recencyDecay: this.config.recencyDecay,
          summaryTurnThreshold: this.config.summaryTurnThreshold,
          ...(this.config.minMemoryRelevance !== undefined ? { minRelevance: this.config.minMemoryRelevance } : {}),
        },
      },
    };
  }

  private async selectPersonaBlocks(
    persona: Parameters<typeof routePersona>[0]["persona"],
    query: string | null,
    signal?: AbortSignal,
    previousQuery?: string,
  ): Promise<readonly string[]> {
    const blocks = persona.blocks.filter((block) => block.injection === "retrieved");
    if (!query || !this.personaBlockSelector || blocks.length === 0) {
      return [];
    }
    try {
      return await this.personaBlockSelector.selectRelevantBlockIds(
        { characterId: persona.characterId, blocks, query, ...(previousQuery ? { previousQuery } : {}) },
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
    contextEmbedding: number[] = [],
    embeddingModel?: string,
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
      const [embedding] = this.config.integratedContext ? [contextEmbedding] : await this.provider.embed([query], {
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
      const opts = { weights: this.config.weights, recencyDecay: this.config.recencyDecay,
        minRelevance: this.config.minMemoryRelevance,
        ...(this.config.integratedContext ? { hybrid: { queryText: query, embeddingModel } } : {}) };
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
      ...(result.hybrid ? { hybrid: result.hybrid } : {}),
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

  private async getAlwaysMemories(ctx: ChatContext): Promise<ArchivalMemory[]> {
    if (!ctx.userId || !ctx.characterId) return [];
    try {
      return await this.memory.alwaysMemories({
        userId: ctx.userId,
        characterId: ctx.characterId,
      });
    } catch (err) {
      this.log.warn("always memory fetch failed; continuing without it", {
        err: String(err),
      });
      return [];
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
        turnsStartOffset: decision.turnsStartOffset,
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
