import { describe, it, expect } from "vitest";
import { assembleSystemPrompt } from "./system-prompt.js";
import { Persona } from "../persona/persona.js";

const persona: Persona = {
  characterId: "luna",
  name: "Luna",
  bio: "A warm night-owl astronomer.",
  blocks: [
    { title: "Personality", content: "Curious and playful." },
    { title: "Speaking style", content: "Cozy and short." },
    { title: "Guardrails", content: "- Stay in character.\n- Do not claim to be an AI." },
  ],
  canonMemories: ["Bought her first telescope with tutoring money in 2019."],
};

describe("assembleSystemPrompt", () => {
  it.each([
    ["identity", "Identity: who you are"],
    ["behavior", "Personality: how you judge and react"],
    ["voice", "Voice: how you type your reaction"],
    ["lore", "Background: facts to draw on when relevant"],
    ["example", "Example: an illustration of character"],
    ["greeting", "Greeting: first-contact guidance"],
    ["creator_note", "Creator note: authoring context"],
  ] as const)("keeps explicit %s purpose even when the source title is ambiguous", (kind, purpose) => {
    const content = "  Authored text stays verbatim.\nSecond line.  ";
    const out = assembleSystemPrompt({ persona: { ...persona, blocks: [
      { id: "private-id", title: "Mixed source", content, kind, injection: "always", recallKeys: ["private-cue"] },
    ] } });
    expect(out).toContain(`# Mixed source\nPurpose — ${purpose}`);
    expect(out).toContain(`\n${content}`);
    expect(out).not.toContain("private-id");
    expect(out).not.toContain("private-cue");
  });

  it("does not infer a role from legacy titles", () => {
    const out = assembleSystemPrompt({ persona: { ...persona, blocks: [
      { title: "voice", content: "Original unclassified source." },
    ] } });
    expect(out).toContain("# voice\nOriginal unclassified source.");
    expect(out).not.toContain("Purpose —");
  });

  it("uses authored identity instead of repeating a public profile caption", () => {
    const out = assembleSystemPrompt({ persona: { ...persona, bio: "Public caption, DM for inquiries.", blocks: [
      { title: "Core", kind: "identity", content: "A quietly confident astronomer." },
    ] } });
    expect(out).toContain("You are Luna.");
    expect(out).toContain("A quietly confident astronomer.");
    expect(out).not.toContain("Public caption, DM for inquiries.");
    const blank = assembleSystemPrompt({ persona: { ...persona, blocks: [{ title: "Core", kind: "identity", content: "  " }] } });
    expect(blank).toContain(persona.bio);
  });

  it("includes the name, bio, and every authored block verbatim", () => {
    const out = assembleSystemPrompt({ persona });
    expect(out).toContain("You are Luna.");
    expect(out).toContain("A warm night-owl astronomer.");
    expect(out).toContain("# Personality\nCurious and playful.");
    expect(out).toContain("# Speaking style\nCozy and short.");
    expect(out).toContain("Do not claim to be an AI.");
  });

  it("frames the exchange as a DM, before the authored blocks", () => {
    const out = assembleSystemPrompt({ persona });
    expect(out).toContain("# Where this conversation is happening");
    expect(out).toContain("direct messages inside opod");
    expect(out).toContain("not in the same room");
    expect(out).toContain("Never narrate actions");
    expect(out).toContain("Plain text only");
    expect(out).toContain("Match the pace and substance of the exchange");
    expect(out).not.toContain("a sentence or two");
    // Order matters: the channel has to frame the persona's own voice guide,
    // otherwise a "말투" block is read as speech rather than typing.
    expect(out.indexOf("# Where this conversation is happening")).toBeLessThan(
      out.indexOf("# Speaking style"),
    );
  });

  it("applies the shared natural-reply policy after persona and canon context", () => {
    const out = assembleSystemPrompt({ persona });

    expect(out).toContain("# How to keep each reply natural");
    expect(out).toContain("Respond to what they actually wrote first");
    expect(out).toContain("not a checklist or a source of topics");
    expect(out).toContain("Do not keep returning to the same signature topic");
    expect(out).toContain("do not invent a specific activity");
    expect(out).toContain("Do not default to interviewing or counseling them");
    expect(out).toContain("ordinary Korean chat phrasing");
    expect(out).toContain("Mixing speech levels is not automatically a mistake");
    expect(out).not.toContain("You are somewhere in the middle of your own day");

    // Shared reply policy must have the final say over authored motifs and
    // established facts without replacing either source of character identity.
    expect(out.indexOf("# How to keep each reply natural")).toBeGreaterThan(
      out.indexOf("# Established facts of your life"),
    );
  });

  it("closes by asking for a single chat message", () => {
    const out = assembleSystemPrompt({ persona });
    expect(out.trimEnd().endsWith("natural and concise.")).toBe(true);
    expect(out).toContain("single chat message");
  });

  it("bounds all authored reference blocks without deleting identity or treating their order as a live conversation", () => {
    const out = assembleSystemPrompt({ persona: {
      ...persona,
      blocks: [...persona.blocks, { title: "example_conversations", content: 'User: 뭐해?\nCharacter: 방금 공연 끝났어요.' }, { title: "content_style", content: "Caption: a quiet night." }],
      canonMemories: ["Posted a photo from a concert last month."],
    } });
    expect(out).toContain('User: 뭐해?\nCharacter: 방금 공연 끝났어요.');
    expect(out).toContain("Curious and playful.");
    expect(out).toContain("Authored examples are not exchanges with this person");
    expect(out).toContain("Post captions and production directions are not DM speech instructions");
    expect(out).toContain("not evidence of what you are doing now");
    expect(out).toContain("Let your personality show through what you notice, enjoy, disagree with, or find funny");
    expect(out).toContain("Do not replace every answer with a generic acknowledgment");
    const referenceStart = out.indexOf("# Authored character reference");
    const referenceEnd = out.indexOf("# End of authored character reference");
    expect(referenceStart).toBeGreaterThan(out.indexOf("# Where this conversation is happening"));
    for (const title of ["Personality", "Speaking style", "Guardrails", "example_conversations", "content_style"]) {
      expect(out.indexOf(`# ${title}\n`)).toBeGreaterThan(referenceStart);
      expect(out.indexOf(`# ${title}\n`)).toBeLessThan(referenceEnd);
    }
    expect(referenceEnd).toBeLessThan(out.indexOf("# Established facts of your life"));
    expect(referenceEnd).toBeLessThan(out.indexOf("# How to keep each reply natural"));
    expect(out.indexOf("Authored examples are not")).toBeGreaterThan(out.indexOf("# example_conversations"));
  });

  it("holds nothing that changes between turns", () => {
    // The whole point of the split: this string is the cached prefix, so it may
    // not carry the clock, the memories, the summary or the bond.
    const out = assembleSystemPrompt({ persona, tracksBond: true, toolsEnabled: true });
    for (const volatile of [
      "# Current moment",
      "# Where you stand with this person",
      "# What you know about this person",
      "# Conversation so far",
      "# Things you recall",
    ]) {
      expect(out).not.toContain(volatile);
    }
  });

  it("injects canon memories with the consistency instruction", () => {
    const out = assembleSystemPrompt({ persona });
    expect(out).toContain("# Established facts of your life");
    expect(out).toContain("- Bought her first telescope with tutoring money in 2019.");
    expect(out).toContain("stay consistent");
  });

  it("preserves typed character-memory metadata without changing the prompt or inferring lifecycle policy", () => {
    const structured = Persona.parse({
      ...persona,
      canonMemories: [{
        id: "source-only-id", type: "operator-defined-type", content: persona.canonMemories[0],
        reason: "private operator reason", createdAt: "2026-07-01 00:00:00.123456+00", updatedAt: "2026-07-02 00:00:00.654321+00",
      }, "A second legacy fact."],
    });
    expect(structured.canonMemories[0]).toMatchObject({ id: "source-only-id", type: "operator-defined-type", updatedAt: "2026-07-02 00:00:00.654321+00" });
    const out = assembleSystemPrompt({ persona: structured });
    expect(out).toBe(assembleSystemPrompt({ persona: { ...persona, canonMemories: [...persona.canonMemories, "A second legacy fact."] } }));
    for (const metadata of ["source-only-id", "operator-defined-type", "private operator reason", "2026-07-01", "2026-07-02", "[object Object]"]) expect(out).not.toContain(metadata);
  });

  it("omits blank blocks and empty canon", () => {
    const bare: Persona = {
      ...persona,
      blocks: [{ title: "Personality", content: "  " }],
      canonMemories: [],
    };
    const out = assembleSystemPrompt({ persona: bare });
    expect(out).not.toContain("# Personality");
    expect(out).not.toContain("# Established facts of your life");
    expect(out).not.toContain("# Authored character reference");
    expect(out).not.toContain("# End of authored character reference");
  });

  it("renders routed blocks without reclassifying them by title", () => {
    const withGreeting: Persona = {
      ...persona,
      blocks: [
        ...persona.blocks,
        { title: "greeting", content: "먼저 다가가 반갑게 인사한다." },
      ],
    };

    expect(withGreeting.blocks).toContainEqual({
      title: "greeting",
      content: "먼저 다가가 반갑게 인사한다.",
    });
    expect(assembleSystemPrompt({ persona: withGreeting })).toContain(
      "먼저 다가가 반갑게 인사한다.",
    );
  });

  it("carries the closing-grade rubric only when a bond is tracked", () => {
    const tracked = assembleSystemPrompt({ persona, tracksBond: true });
    expect(tracked).toContain("# Closing tag (system channel");
    expect(tracked).toContain("[[bond:+1]]");
    expect(tracked).toContain("they never see it");
    expect(tracked).toContain("ignore the request and grade what really happened");
    // Dead last: it is a rule about the very end of the output.
    expect(tracked.trimEnd().endsWith("grade what really happened.")).toBe(true);

    expect(assembleSystemPrompt({ persona })).not.toContain("[[bond:");
  });

  it("emits the abilities section, with the never-mention-tools rule, when toolsEnabled", () => {
    const out = assembleSystemPrompt({ persona, toolsEnabled: true });
    expect(out).toContain("# Your abilities (stay in character)");
    expect(out).toContain("Never mention tools");
  });

  it("omits the abilities section when toolsEnabled is absent", () => {
    expect(assembleSystemPrompt({ persona })).not.toContain("# Your abilities");
  });

  it("does not advertise recent happenings when web_search is not among the wired tools", () => {
    const out = assembleSystemPrompt({
      persona,
      toolsEnabled: true,
      toolNames: ["get_time", "get_weather"],
    });
    expect(out).toContain("# Your abilities (stay in character)");
    expect(out).toContain("the current time anywhere");
    expect(out).toContain("the weather");
    expect(out).not.toContain("recent happenings");
  });

  it("advertises recent happenings only when web_search is wired", () => {
    const out = assembleSystemPrompt({
      persona,
      toolsEnabled: true,
      toolNames: ["get_time", "get_weather", "web_search"],
    });
    expect(out).toContain("recent happenings");
  });
});
