import type { Persona } from "../persona/persona.js";
import { BOND_SIGNAL_INSTRUCTION } from "./turn-context.js";

export interface PromptInputs {
  persona: Persona;
  /** When the server tool loop runs, tell the character it can act on the world. */
  toolsEnabled?: boolean;
  /** Names of the server tools actually wired this turn. Scopes the abilities text
   *  to what the character can really do (e.g. no web search without web_search).
   *  When absent but toolsEnabled is set, the full generic abilities text is used. */
  toolNames?: string[];
  /**
   * Whether this relationship's Bond is being tracked, which is what makes the
   * closing-tag rule apply. Derived from identity rather than from a loaded
   * snapshot on purpose: a transient store failure must not silently rewrite
   * the prefix (and cost a cache hit) for one turn.
   */
  tracksBond?: boolean;
}

/**
 * The stable half of the prompt: who the character is, where the conversation
 * is happening, what it can do, and the rules it must hold to. Everything here
 * is a property of the *character*, not of this turn.
 *
 * Nothing that changes between turns may enter this string. It is the prefix
 * every Provider caches — the clock, the memories, the summary and where the
 * relationship stands all move with the conversation, so they ride in the
 * per-turn block instead (`turn-context.ts`). Putting them here would rewrite
 * the first token of the prompt on every message and throw the whole KV cache
 * away for the sake of one line about the weather.
 */
export function assembleSystemPrompt(inputs: PromptInputs): string {
  const { persona, toolsEnabled, toolNames, tracksBond } = inputs;
  const sections: string[] = [];

  sections.push(
    [
      `You are ${persona.name}.`,
      persona.bio,
    ]
      .filter(Boolean)
      .join(" "),
  );

  // The channel is fixed for this product — the Agent's only chat route is what
  // the backend calls to answer a DM — so this is stated unconditionally rather
  // than passed in. It goes *before* the authored blocks on purpose: a "말투"
  // block then reads as "how I type", not "how I speak". Without it the model
  // turns the persona's physical beats ("판을 한 장 더 건다", "말수가 준다")
  // into stage direction and answers as if the two were in the same room.
  sections.push(CONVERSATION_CHANNEL);

  // The Persona Router owns inclusion policy. The renderer deliberately uses
  // every block in the stable view it receives, without guessing from titles.
  for (const block of persona.blocks) {
    if (block.content.trim()) sections.push(`# ${block.title}\n${block.content}`);
  }

  if (persona.canonMemories.length > 0) {
    const facts = persona.canonMemories.map((m) => `- ${m}`).join("\n");
    sections.push(
      `# Established facts of your life\n${facts}\nThese are canon: whatever you say must stay consistent with them.`,
    );
  }

  if (toolsEnabled) sections.push(buildAbilitiesSection(toolNames));

  // Authored character material defines identity, but it must not become a
  // checklist the model performs at the user. Keep this shared policy after
  // Persona, canon and abilities so it governs how all of those sources are
  // used in the actual reply, without adding character-specific exceptions.
  sections.push(NATURAL_REPLY_POLICY);

  // Repeated at the end because this is the constraint the model drops first
  // once the persona and memory sections have piled up in between.
  sections.push(
    `Always stay in character as ${persona.name}. Reply with a single chat message, the way you would actually type it — natural and concise.`,
  );

  // Dead last, and only when a bond is being tracked. The rubric itself never
  // changes, so it belongs to the cached prefix; only the state it grades moves
  // per turn.
  if (tracksBond) sections.push(BOND_SIGNAL_INSTRUCTION);

  return sections.join("\n\n");
}

/**
 * The medium the conversation is actually happening in.
 *
 * Personas describe how a character behaves in person; nothing in them says the
 * exchange is typed. The app renders each reply as one plain-text bubble
 * (`whitespace-pre-wrap`, no Markdown), so anything the model formats or
 * narrates lands in the thread verbatim.
 */
const CONVERSATION_CHANNEL = [
  "# Where this conversation is happening",
  "You and this person are trading direct messages inside opod, a social app. You are typing to each other — the two of you are not in the same room.",
  "- You cannot see or hear them. Everything you know about this moment is what they typed.",
  "- Text the way people actually text: one short message, a sentence or two. Say one thing and let them answer.",
  "- Never narrate actions or surroundings — no asterisked gestures, no parenthetical stage directions, no scene setting. If what you are doing matters, say it in words, the way you would type it.",
  "- Plain text only. Markdown is not rendered here, so asterisks, bullets and headings would show up as literal characters.",
].join("\n");

/**
 * Shared reply behavior distilled from the user's naturalness review. Persona
 * stays the source of voice and judgment, while relevance decides what enters
 * a particular turn. This is deliberately principle-based: canned good-answer
 * examples would become another phrase template for the model to imitate.
 */
const NATURAL_REPLY_POLICY = [
  "# How to keep each reply natural",
  "- Respond to what they actually wrote first, and stay with its local meaning unless they clearly invite a new topic. Do not assume their location, reason for writing, situation, or intent.",
  "- Persona, canon, memories, profiles, posts, work and hobbies are background that shapes your reaction, not a checklist or a source of topics. Use a detail only when their message or supplied context makes it relevant; never display details just to prove who you are. Do not keep returning to the same signature topic after the conversation has moved elsewhere.",
  "- If no current activity is supplied, keep any answer about your present moment ordinary and low-specificity; do not invent a specific activity by turning background material into a current fact.",
  "- Do not default to interviewing or counseling them. A question is optional and must follow directly from what they said; a brief reaction or opinion is often enough.",
  "- When chatting in Korean, prefer ordinary Korean chat phrasing over translated prose, catalog copy, or unexplained workplace jargon.",
  "- Follow the persona and relationship for speech level. Mixing speech levels is not automatically a mistake, but a shift should feel characteristic and intentional.",
].join("\n");

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
