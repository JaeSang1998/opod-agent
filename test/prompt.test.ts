import { describe, it, expect } from "vitest";
import { assembleSystemPrompt } from "../src/prompt/assemble.js";
import type { Persona } from "../src/persona/Persona.js";

const persona: Persona = {
  characterId: "luna",
  name: "Luna",
  description: "A warm night-owl astronomer.",
  personality: "Curious and playful.",
  speakingStyle: "Cozy and short.",
  greeting: "Hi",
  exampleDialogues: [{ user: "hey", character: "hello there" }],
  guardrails: ["Stay in character.", "Do not claim to be an AI."],
};

describe("assembleSystemPrompt", () => {
  it("includes persona name, description, and guardrails", () => {
    const out = assembleSystemPrompt({ persona, memories: [], core: null, summary: null });
    expect(out).toContain("You are Luna.");
    expect(out).toContain("A warm night-owl astronomer.");
    expect(out).toContain("Do not claim to be an AI.");
  });

  it("injects the core block, retrieved memories, and summary when present", () => {
    const out = assembleSystemPrompt({
      persona,
      memories: [
        { id: "1", userId: "u", characterId: "luna", content: "User's dog is named Max.", kind: "observation", importance: 5, createdAt: "", lastAccessedAt: "" },
        { id: "2", userId: "u", characterId: "luna", content: "The user seems lonely lately.", kind: "reflection", importance: 7, createdAt: "", lastAccessedAt: "" },
      ],
      core: { userId: "u", characterId: "luna", content: "A software engineer who loves cats.", updatedAt: "" },
      summary: { sessionId: "s", content: "They talked about work.", turnsCovered: 4, updatedAt: "" },
    });
    expect(out).toContain("A software engineer who loves cats.");
    expect(out).toContain("User's dog is named Max.");
    expect(out).toContain("They talked about work.");
    // Reflections are marked distinctly from raw observations.
    expect(out).toContain("(you've come to feel) The user seems lonely lately.");
  });

  it("omits empty sections", () => {
    const bare: Persona = { ...persona, personality: "", speakingStyle: "", exampleDialogues: [], guardrails: [] };
    const out = assembleSystemPrompt({ persona: bare, memories: [], core: null, summary: null });
    expect(out).not.toContain("# Personality");
    expect(out).not.toContain("# What you know about this person");
  });
});
