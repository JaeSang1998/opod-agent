import type { Persona } from "../persona/persona.js";
import type { ArchivalMemory, CoreMemory, Summary } from "../memory/types.js";

export interface PromptInputs {
  persona: Persona;
  memories: ArchivalMemory[];
  /** MemGPT-style compact digest of the user, always kept in mind. */
  core: CoreMemory | null;
  summary: Summary | null;
  /** Wall-clock instant to ground the character's sense of time. */
  now?: Date;
  /** IANA timezone of the user, when known; invalid/absent falls back to UTC. */
  timezone?: string;
  /** When the server tool loop runs, tell the character it can act on the world. */
  toolsEnabled?: boolean;
  /** Names of the server tools actually wired this turn. Scopes the abilities text
   *  to what the character can really do (e.g. no web search without web_search).
   *  When absent but toolsEnabled is set, the full generic abilities text is used. */
  toolNames?: string[];
}

/**
 * Builds the system-prompt string from a persona plus retrieved memory and the
 * rolling summary. This is the Agent-owned assembly template (docs/adr / persona
 * decision). Empty sections are omitted so a memoryless turn stays clean.
 */
export function assembleSystemPrompt(inputs: PromptInputs): string {
  const { persona, memories, core, summary, now, timezone, toolsEnabled, toolNames } = inputs;
  const sections: string[] = [];

  sections.push(
    [
      `You are ${persona.name}.`,
      persona.description,
    ]
      .filter(Boolean)
      .join(" "),
  );

  if (persona.personality) sections.push(`# Personality\n${persona.personality}`);
  if (persona.speakingStyle) sections.push(`# Speaking style\n${persona.speakingStyle}`);

  if (persona.exampleDialogues.length > 0) {
    const examples = persona.exampleDialogues
      .map((d) => `User: ${d.user}\n${persona.name}: ${d.character}`)
      .join("\n\n");
    sections.push(`# Example exchanges\n${examples}`);
  }

  if (now) sections.push(currentMomentSection(now, timezone));

  if (core?.content) {
    sections.push(`# What you know about this person\n${core.content}`);
  }

  if (summary?.content) {
    sections.push(`# Conversation so far (summary)\n${summary.content}`);
  }

  if (memories.length > 0) {
    // Reflections are higher-level; mark them so the model weighs them as insight.
    const observations = memories
      .map((m) => (m.kind === "reflection" ? `- (you've come to feel) ${m.content}` : `- ${m.content}`))
      .join("\n");
    sections.push(`# Things you recall\n${observations}`);
  }

  if (toolsEnabled) sections.push(buildAbilitiesSection(toolNames));

  if (persona.guardrails.length > 0) {
    const rules = persona.guardrails.map((g) => `- ${g}`).join("\n");
    sections.push(`# Rules you must follow\n${rules}`);
  }

  sections.push(
    `Always stay in character as ${persona.name}. Reply naturally and concisely.`,
  );

  return sections.join("\n\n");
}

/**
 * Grounds the character in wall-clock time. An invalid/absent timezone throws a
 * RangeError from Intl; we swallow it and present the moment in UTC instead.
 */
function currentMomentSection(now: Date, timezone?: string): string {
  let zone = "UTC";
  let known = false;
  if (timezone) {
    try {
      // Construction validates the zone; an unknown zone throws RangeError.
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      zone = timezone;
      known = true;
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
    }
  }

  const formatted = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: zone,
  }).format(now);

  const line = known
    ? `It is ${formatted} where the user is (${zone}).`
    : `It is ${formatted} (UTC); the user's local timezone is unknown.`;

  return [
    "# Current moment",
    line,
    'Ground your sense of time (greetings, "yesterday", seasons, time of day) in this naturally; don\'t recite the exact time unless it fits the conversation.',
  ].join("\n");
}

/** Maps a wired tool name to the real-world thing it lets the character find out.
 *  Only capabilities actually wired are advertised, so the character never claims
 *  an ability (e.g. web search) whose tool is absent and would fabricate answers. */
const ABILITY_BY_TOOL: Record<string, string> = {
  get_time: "the current time anywhere",
  get_weather: "the weather",
  web_search: "recent happenings",
};

/** The generic set used when the caller does not name the wired tools. */
const DEFAULT_ABILITIES = ["the current time anywhere", "the weather", "recent happenings"];

function buildAbilitiesSection(toolNames?: string[]): string {
  const abilities = toolNames
    ? toolNames.map((n) => ABILITY_BY_TOOL[n]).filter((a): a is string => Boolean(a))
    : DEFAULT_ABILITIES;
  const list = abilities.length > 0 ? abilities.join(", ") : "some real-world information";

  return [
    "# Your abilities (stay in character)",
    `- You can find out real-world information — ${list} — through your own abilities.`,
    '- Never mention tools, functions, APIs, "searching the web", or being an AI; you simply know it, checked it, or heard about it.',
    "- Weave whatever you learn into your reply in your own voice, as if it were any other thought.",
    "- If an ability fails or comes back empty, don't explain the mechanics — deflect gracefully in character and offer what you do know.",
  ].join("\n");
}
