import type {
  Persona,
  PersonaBlock,
  PersonaBlockKind,
  PersonaInjection,
  CharacterCanonMemory,
} from "./persona.js";

type PersonaPromptDestination = "system_prompt" | "turn_context" | "excluded";

type PersonaRoutingReason =
  | "always_in_system_prompt"
  | "start_only_first_turn"
  | "start_only_after_first_turn"
  | "retrieved_for_turn"
  | "not_retrieved"
  | "never_prompt"
  | "legacy_default_always"
  | "legacy_reactive_greeting_excluded";

export interface PromptPersonaSourceProvenance {
  /** Stable DB/fixture id, or a content-free positional id for a legacy adapter. */
  id: string;
  kind: PersonaBlockKind | null;
  injection: PersonaInjection;
  mapping: "explicit" | "legacy";
  destination: PersonaPromptDestination;
  reason: PersonaRoutingReason;
}

export interface PromptPersonaProvenance {
  schemaVersion: 1;
  policyVersion: 1;
  sources: PromptPersonaSourceProvenance[];
  canonSources?: Array<{
    id: string; kind: "fact" | "event" | null; destination: PersonaPromptDestination;
    reason: "always_in_system_prompt" | "retrieved_for_turn" | "not_retrieved";
  }>;
}

export interface RoutedPersona {
  /** Stable identity view. Only this view may enter the cached system prompt. */
  stablePersona: Persona;
  /** Dynamic first-contact material for this turn only. */
  startOnlyBlocks: PersonaBlock[];
  /** Dynamic lore selected by a separate relevance owner for this turn. */
  retrievedBlocks: PersonaBlock[];
  retrievedCanonMemories: CharacterCanonMemory[];
  provenance: PromptPersonaProvenance;
}

export interface RoutePersonaInput {
  persona: Persona;
  isConversationStart: boolean;
  /** Selection is deliberately external: P1-1 routes; P1-2 owns retrieval quality. */
  retrievedBlockIds: readonly string[];
  retrievedCanonIds?: readonly string[];
}

interface PersonaBlockSelectorInput {
  characterId: string;
  /** Only blocks already classified as `retrieved`; excluded material never crosses this seam. */
  blocks: readonly PersonaBlock[];
  query: string;
  /** At most the preceding user turn; optional for existing custom selectors. */
  previousQuery?: string;
}

/** Retrieval-quality implementations are supplied outside the router. */
export interface PersonaBlockSelector {
  selectRelevantBlockIds(
    input: PersonaBlockSelectorInput,
    signal?: AbortSignal,
  ): Promise<readonly string[]>;
}

/**
 * Projects one raw Persona into cache-stable and per-turn prompt channels.
 *
 * Explicit policies are keyed before this function by stable block id. An
 * unmapped adapter stays on the pre-P1 behavior so deploying the router alone
 * cannot silently rewrite existing characters. The one historical exception —
 * exact English `greeting` exclusion for reactive replies — lives here as the
 * centralized compatibility rule instead of remaining hidden in the renderer.
 */
export function routePersona(input: RoutePersonaInput): RoutedPersona {
  const selected = new Set(input.retrievedBlockIds);
  const stableBlocks: PersonaBlock[] = [];
  const startOnlyBlocks: PersonaBlock[] = [];
  const retrievedBlocks: PersonaBlock[] = [];
  const sources: PromptPersonaSourceProvenance[] = [];

  input.persona.blocks.forEach((block, index) => {
    const id = block.id ?? `legacy-block-${index + 1}`;
    if (!block.injection) {
      const isLegacyGreeting = block.title.trim().toLowerCase() === "greeting";
      if (!isLegacyGreeting) stableBlocks.push(block);
      sources.push({
        id,
        kind: block.kind ?? null,
        injection: isLegacyGreeting ? "never_prompt" : "always",
        mapping: "legacy",
        destination: isLegacyGreeting ? "excluded" : "system_prompt",
        reason: isLegacyGreeting
          ? "legacy_reactive_greeting_excluded"
          : "legacy_default_always",
      });
      return;
    }

    const base = {
      id,
      kind: block.kind ?? null,
      injection: block.injection,
      mapping: "explicit" as const,
    };
    switch (block.injection) {
      case "always":
        stableBlocks.push(block);
        sources.push({
          ...base,
          destination: "system_prompt",
          reason: "always_in_system_prompt",
        });
        return;
      case "start_only":
        if (input.isConversationStart) startOnlyBlocks.push(block);
        sources.push({
          ...base,
          destination: input.isConversationStart ? "turn_context" : "excluded",
          reason: input.isConversationStart
            ? "start_only_first_turn"
            : "start_only_after_first_turn",
        });
        return;
      case "retrieved": {
        const isRetrieved = selected.has(id);
        if (isRetrieved) retrievedBlocks.push(block);
        sources.push({
          ...base,
          destination: isRetrieved ? "turn_context" : "excluded",
          reason: isRetrieved ? "retrieved_for_turn" : "not_retrieved",
        });
        return;
      }
      case "never_prompt":
        sources.push({ ...base, destination: "excluded", reason: "never_prompt" });
        return;
    }
  });

  const selectedCanon = new Set(input.retrievedCanonIds ?? []);
  const stableCanon: Persona["canonMemories"] = [];
  const retrievedCanonMemories: CharacterCanonMemory[] = [];
  const canonSources: NonNullable<PromptPersonaProvenance["canonSources"]> = [];
  for (const memory of input.persona.canonMemories) {
    if (typeof memory === "string" || !memory.injection) {
      stableCanon.push(memory);
      continue;
    }
    const persistent = memory.injection === "always";
    const recalled = !persistent && selectedCanon.has(memory.id);
    if (persistent) stableCanon.push(memory);
    else if (recalled) retrievedCanonMemories.push(memory);
    canonSources.push({ id: memory.id, kind: memory.kind ?? null,
      destination: persistent ? "system_prompt" : recalled ? "turn_context" : "excluded",
      reason: persistent ? "always_in_system_prompt" : recalled ? "retrieved_for_turn" : "not_retrieved" });
  }
  return {
    stablePersona: { ...input.persona, blocks: stableBlocks, canonMemories: stableCanon },
    startOnlyBlocks,
    retrievedBlocks,
    retrievedCanonMemories,
    provenance: { schemaVersion: 1, policyVersion: 1, sources,
      ...(canonSources.length > 0 ? { canonSources } : {}) },
  };
}
