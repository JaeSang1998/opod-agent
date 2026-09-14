import type { PersonaBlock, PersonaBlockKind } from "../persona/persona.js";

const PURPOSE: Readonly<Record<PersonaBlockKind, string>> = {
  identity: "Identity: who you are, not an introduction to recite.",
  behavior: "Personality: how you judge and react to this exchange, not a topic to introduce.",
  voice: "Voice: how you type your reaction with this person, not a fixed answer to copy.",
  lore: "Background: facts to draw on when relevant, not evidence of your current activity.",
  example: "Example: an illustration of character, not this person's history or a script to continue.",
  greeting: "Greeting: first-contact guidance, not proof of a reunion or shared past.",
  creator_note: "Creator note: authoring context, not words or production directions to send in a DM.",
};

/** The router owns selection; render only explicit roles, preserving source text. */
export function renderPersonaBlock(block: PersonaBlock, headingLevel: 1 | 2): string {
  return [
    `${"#".repeat(headingLevel)} ${block.title}`,
    ...(block.kind ? [`Purpose — ${PURPOSE[block.kind]}`] : []),
    block.content,
  ].join("\n");
}
