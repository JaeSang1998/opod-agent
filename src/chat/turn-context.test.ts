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
    const out = assembleTurnContext({ ...empty, bond: { level: 2, progress: 0, recency: "close" } })!;
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
    expect(out).toContain("(inference, not a confirmed fact) The user seems lonely lately.");
    expect(out).toContain("Recent messages take precedence over a summary or inferred impression");
    // The last instruction must return attention to the live exchange, not
    // leave the recalled topic as the final prompt material to continue.
    expect(out.indexOf("Return to the person's latest message")).toBeGreaterThan(
      out.indexOf("The user seems lonely lately."),
    );
  });

  it("omits the Current moment section when no `now` is given", () => {
    const out = assembleTurnContext({ ...empty, bond: { level: 1, progress: 0, recency: "close" } })!;
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
    expect(out).toContain("not evidence of weather, anyone's schedule, or current activity");
    expect(out).not.toContain('greetings, "yesterday", seasons');
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

  it("renders validated canon time as a past event without private source fields", () => {
    const out = assembleTurnContext({ ...empty, characterMemories: [{
      id: "event", content: "장마철에 담이를 입양했다.", type: "event", reason: "never render this",
      createdAt: "2026-01-01", updatedAt: "2026-01-01", kind: "event", injection: "retrieved",
      occurredLabel: "2023-07", occurredPrecision: "month",
    }] })!;
    expect(out).toContain("(past event; time: 2023-07 (month)) 장마철에 담이를 입양했다.");
    expect(out).not.toContain("never render this");
    expect(out).not.toContain("sourceRefs");
  });
});

