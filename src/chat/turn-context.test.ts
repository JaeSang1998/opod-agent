import { describe, it, expect } from "vitest";
import { assembleTurnContext } from "./turn-context.js";
import type { ArchivalMemory } from "../memory/types.js";

const empty = { core: null, summary: null, memories: [] as ArchivalMemory[] };

const memories: ArchivalMemory[] = [
  { id: "1", userId: "u", characterId: "luna", content: "User's dog is named Max.", kind: "observation", importance: 5, createdAt: "", lastAccessedAt: "" },
  { id: "2", userId: "u", characterId: "luna", content: "The user seems lonely lately.", kind: "reflection", importance: 7, createdAt: "", lastAccessedAt: "" },
];

describe("assembleTurnContext", () => {
  it("is absent entirely when the turn has nothing to add", () => {
    expect(assembleTurnContext(empty)).toBeNull();
  });

  it("frames itself as system plumbing the person cannot see", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 2, recency: "close" } })!;
    expect(out.startsWith("<context>")).toBe(true);
    expect(out.trimEnd().endsWith("</context>")).toBe(true);
    expect(out).toContain("Never quote it, mention it, or answer it");
  });

  it("injects the core block, retrieved memories, and summary when present", () => {
    const out = assembleTurnContext({
      memories,
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
    })!;
    expect(out).toContain("A software engineer who loves cats.");
    expect(out).toContain("User's dog is named Max.");
    expect(out).toContain("They talked about work.");
    // Reflections are marked distinctly from raw observations.
    expect(out).toContain("(you've come to feel) The user seems lonely lately.");
  });

  it("omits the Current moment section when no `now` is given", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 1, recency: "close" } })!;
    expect(out).not.toContain("# Current moment");
  });

  it("renders the user's local time when `now` and a valid timezone are given", () => {
    const out = assembleTurnContext({
      ...empty,
      now: new Date("2026-07-16T08:42:00Z"),
      timezone: "Europe/Zurich",
    })!;
    expect(out).toContain("# Current moment");
    // 08:42 UTC in July is 10:42 CEST.
    expect(out).toContain("10:42");
    expect(out).toContain("Europe/Zurich");
    expect(out).toContain("where the user is");
  });

  it("falls back to UTC when the timezone is invalid", () => {
    const out = assembleTurnContext({
      ...empty,
      now: new Date("2026-07-16T08:42:00Z"),
      timezone: "Not/AZone",
    })!;
    expect(out).toContain("# Current moment");
    // 08:42 UTC stays 08:42 in UTC.
    expect(out).toContain("8:42");
    expect(out).toContain("the user's local timezone is unknown");
    expect(out).not.toContain("Not/AZone");
  });
});

describe("the bond block", () => {
  it("omits it when no bond is given", () => {
    const out = assembleTurnContext({ ...empty, now: new Date("2026-07-16T08:42:00Z") })!;
    expect(out).not.toContain("# Where you stand with this person");
  });

  it("states the bond as behaviour and never as a number", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 1, recency: "steady" } })!;
    expect(out).toContain("# Where you stand with this person");
    expect(out).toContain("first real exchange");
    expect(out).toContain("never mention or imply a level, score, percentage or number");
    // The raw level must not leak into the prompt in any form.
    expect(out).not.toMatch(/level\s*[:=]?\s*\d/i);
  });

  it("crosses depth with recency — an old friendship gone quiet", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 7, recency: "cool" } })!;
    expect(out).toContain("go a long way back");
    expect(out).toContain("been a while since you last talked");
  });

  it("grants nothing beyond the depth line at a first meeting", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 1, recency: "close" } })!;
    expect(out).not.toContain("What that lets you do now:");
    expect(out).toContain("Not yet, at this closeness: using their name");
    // No history yet for a recency line to be about.
    expect(out).not.toContain("talking often lately");
  });

  it("opens new behaviour as the level rises, cumulatively", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 3, recency: "close" } })!;
    expect(out).toContain("What that lets you do now:");
    expect(out).toContain("- Use their name"); // still granted from level 2
    expect(out).toContain("- Bring up your own day without being asked first");
    expect(out).not.toContain("반말"); // level 4's grant is still shut
    expect(out).toContain("Not yet, at this closeness: informality");
  });

  it("stops naming what is still shut once nothing is", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 5, recency: "close" } })!;
    expect(out).toContain("Use shorthand and old references");
    expect(out).not.toContain("Not yet");
  });

  it("keeps the unlocks out of the character's mouth", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 4, recency: "close" } })!;
    expect(out).toContain("never tell them what you can or can't do yet");
  });

  it("sits ahead of the memory sections it governs", () => {
    const out = assembleTurnContext({
      ...empty,
      bond: { level: 2, recency: "close" },
      core: { userId: "u", characterId: "luna", content: "Loves cats.", updatedAt: "" },
    })!;
    expect(out.indexOf("# Where you stand with this person")).toBeLessThan(
      out.indexOf("# What you know about this person"),
    );
  });
});
