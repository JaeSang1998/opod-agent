import { describe, expect, it } from "vitest";
import type { Persona } from "./persona.js";
import { routePersona } from "./persona-router.js";

const persona: Persona = {
  characterId: "fixture-one",
  name: "Fixture One",
  bio: "A synthetic character used only to verify shared routing.",
  blocks: [
    {
      id: "identity",
      title: "Core",
      content: "Keeps a dry sense of humor.",
      kind: "identity",
      injection: "always",
    },
    {
      id: "voice",
      title: "Typing",
      content: "Uses short, direct sentences.",
      kind: "voice",
      injection: "always",
    },
    {
      id: "intro",
      title: "Arrival",
      content: "At first contact, be reserved rather than familiar.",
      kind: "example",
      injection: "start_only",
    },
    {
      id: "lore",
      title: "Background",
      content: "Restores old radios as a hobby.",
      kind: "lore",
      injection: "retrieved",
    },
    {
      id: "creator",
      title: "Production note",
      content: "Use amber colors in feed images.",
      kind: "creator_note",
      injection: "never_prompt",
    },
  ],
  canonMemories: [],
};

describe("routePersona", () => {
  it("routes explicit policies without consulting a block title", () => {
    const routed = routePersona({
      persona,
      isConversationStart: true,
      retrievedBlockIds: ["lore"],
    });

    expect(routed.stablePersona.blocks.map((block) => block.id)).toEqual([
      "identity",
      "voice",
    ]);
    expect(routed.startOnlyBlocks.map((block) => block.id)).toEqual(["intro"]);
    expect(routed.retrievedBlocks.map((block) => block.id)).toEqual(["lore"]);
    expect(routed.provenance.sources).toEqual([
      expect.objectContaining({
        id: "identity",
        injection: "always",
        destination: "system_prompt",
        reason: "always_in_system_prompt",
      }),
      expect.objectContaining({ id: "voice", destination: "system_prompt" }),
      expect.objectContaining({
        id: "intro",
        destination: "turn_context",
        reason: "start_only_first_turn",
      }),
      expect.objectContaining({
        id: "lore",
        destination: "turn_context",
        reason: "retrieved_for_turn",
      }),
      expect.objectContaining({
        id: "creator",
        destination: "excluded",
        reason: "never_prompt",
      }),
    ]);
  });

  it("drops start-only and unselected retrieved blocks after the first turn", () => {
    const routed = routePersona({
      persona,
      isConversationStart: false,
      retrievedBlockIds: [],
    });

    expect(routed.startOnlyBlocks).toEqual([]);
    expect(routed.retrievedBlocks).toEqual([]);
    expect(routed.provenance.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "intro", reason: "start_only_after_first_turn" }),
        expect.objectContaining({ id: "lore", reason: "not_retrieved" }),
      ]),
    );
  });

  it("preserves the old fallback for unmapped stores while centralizing greeting exclusion", () => {
    const legacy: Persona = {
      characterId: "legacy",
      name: "Legacy",
      bio: "",
      blocks: [
        { title: "Personality", content: "Quiet." },
        { title: " Greeting ", content: "A canned opening." },
      ],
      canonMemories: [],
    };

    const routed = routePersona({
      persona: legacy,
      isConversationStart: true,
      retrievedBlockIds: [],
    });

    expect(routed.stablePersona.blocks.map((block) => block.title)).toEqual(["Personality"]);
    expect(routed.provenance.sources).toEqual([
      expect.objectContaining({
        id: "legacy-block-1",
        mapping: "legacy",
        destination: "system_prompt",
        reason: "legacy_default_always",
      }),
      expect.objectContaining({
        id: "legacy-block-2",
        mapping: "legacy",
        destination: "excluded",
        reason: "legacy_reactive_greeting_excluded",
      }),
    ]);
  });
});
