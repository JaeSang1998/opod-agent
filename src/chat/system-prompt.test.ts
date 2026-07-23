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
    const out = assembleSystemPrompt({ persona, memories: [], core: null, summary: null });
    expect(out).toContain("You are Luna.");
    expect(out).toContain("A warm night-owl astronomer.");
    expect(out).toContain("# Personality\nCurious and playful.");
    expect(out).toContain("# Speaking style\nCozy and short.");
    expect(out).toContain("Do not claim to be an AI.");
  });

  it("injects canon memories with the consistency instruction", () => {
    const out = assembleSystemPrompt({ persona, memories: [], core: null, summary: null });
    expect(out).toContain("# Established facts of your life");
    expect(out).toContain("- Bought her first telescope with tutoring money in 2019.");
    expect(out).toContain("stay consistent");
  });

  it("injects the core block, retrieved memories, and summary when present", () => {
    const out = assembleSystemPrompt({
      persona,
      memories: [
        { id: "1", userId: "u", characterId: "luna", content: "User's dog is named Max.", kind: "observation", importance: 5, createdAt: "", lastAccessedAt: "" },
        { id: "2", userId: "u", characterId: "luna", content: "The user seems lonely lately.", kind: "reflection", importance: 7, createdAt: "", lastAccessedAt: "" },
      ],
      core: { userId: "u", characterId: "luna", content: "A software engineer who loves cats.", updatedAt: "" },
      summary: {
        userId: "u",
        characterId: "luna",
        sessionId: "s",
        content: "They talked about work.",
        turnsCovered: 4,
        revision: 1,
        updatedAt: "",
      },
    });
    expect(out).toContain("A software engineer who loves cats.");
    expect(out).toContain("User's dog is named Max.");
    expect(out).toContain("They talked about work.");
    // Reflections are marked distinctly from raw observations.
    expect(out).toContain("(you've come to feel) The user seems lonely lately.");
  });

  it("omits blank blocks, empty canon, and absent memory sections", () => {
    const bare: Persona = {
      ...persona,
      blocks: [{ title: "Personality", content: "  " }],
      canonMemories: [],
    };
    const out = assembleSystemPrompt({ persona: bare, memories: [], core: null, summary: null });
    expect(out).not.toContain("# Personality");
    expect(out).not.toContain("# Established facts of your life");
    expect(out).not.toContain("# What you know about this person");
  });

  it("omits the Current moment section when no `now` is given", () => {
    const out = assembleSystemPrompt({ persona, memories: [], core: null, summary: null });
    expect(out).not.toContain("# Current moment");
  });

  it("renders the user's local time when `now` and a valid timezone are given", () => {
    const out = assembleSystemPrompt({
      persona,
      memories: [],
      core: null,
      summary: null,
      now: new Date("2026-07-16T08:42:00Z"),
      timezone: "Europe/Zurich",
    });
    expect(out).toContain("# Current moment");
    // 08:42 UTC in July is 10:42 CEST.
    expect(out).toContain("10:42");
    expect(out).toContain("Europe/Zurich");
    expect(out).toContain("where the user is");
  });

  it("falls back to UTC when the timezone is invalid", () => {
    const out = assembleSystemPrompt({
      persona,
      memories: [],
      core: null,
      summary: null,
      now: new Date("2026-07-16T08:42:00Z"),
      timezone: "Not/AZone",
    });
    expect(out).toContain("# Current moment");
    // 08:42 UTC stays 08:42 in UTC.
    expect(out).toContain("8:42");
    expect(out).toContain("the user's local timezone is unknown");
    expect(out).not.toContain("Not/AZone");
  });

  it("emits the abilities section, with the never-mention-tools rule, when toolsEnabled", () => {
    const out = assembleSystemPrompt({
      persona,
      memories: [],
      core: null,
      summary: null,
      toolsEnabled: true,
    });
    expect(out).toContain("# Your abilities (stay in character)");
    expect(out).toContain("Never mention tools");
  });

  it("omits the abilities section when toolsEnabled is absent", () => {
    const out = assembleSystemPrompt({ persona, memories: [], core: null, summary: null });
    expect(out).not.toContain("# Your abilities");
  });

  it("does not advertise recent happenings when web_search is not among the wired tools", () => {
    const out = assembleSystemPrompt({
      persona,
      memories: [],
      core: null,
      summary: null,
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
      memories: [],
      core: null,
      summary: null,
      toolsEnabled: true,
      toolNames: ["get_time", "get_weather", "web_search"],
    });
    expect(out).toContain("recent happenings");
  });
});
