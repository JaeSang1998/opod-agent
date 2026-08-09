import { describe, it, expect } from "vitest";
import { assembleSystemPrompt } from "./system-prompt.js";
import type { Persona } from "../persona/persona.js";

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
    // Order matters: the channel has to frame the persona's own voice guide,
    // otherwise a "말투" block is read as speech rather than typing.
    expect(out.indexOf("# Where this conversation is happening")).toBeLessThan(
      out.indexOf("# Speaking style"),
    );
  });

  it("closes by asking for a single chat message", () => {
    const out = assembleSystemPrompt({ persona });
    expect(out.trimEnd().endsWith("natural and concise.")).toBe(true);
    expect(out).toContain("single chat message");
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

  it("omits blank blocks and empty canon", () => {
    const bare: Persona = {
      ...persona,
      blocks: [{ title: "Personality", content: "  " }],
      canonMemories: [],
    };
    const out = assembleSystemPrompt({ persona: bare });
    expect(out).not.toContain("# Personality");
    expect(out).not.toContain("# Established facts of your life");
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
