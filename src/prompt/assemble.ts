import type { Persona } from "../persona/Persona.js";
import type { CoreMemory, LongTermMemory, Summary } from "../memory/types.js";

export interface PromptInputs {
  persona: Persona;
  memories: LongTermMemory[];
  /** MemGPT-style compact digest of the user, always kept in mind. */
  core: CoreMemory | null;
  summary: Summary | null;
  /** Display name of the user, if known, for direct address. */
  userName?: string;
}

/**
 * Builds the system-prompt string from a persona plus retrieved memory and the
 * rolling summary. This is the Agent-owned assembly template (docs/adr / persona
 * decision). Empty sections are omitted so a memoryless turn stays clean.
 */
export function assembleSystemPrompt(inputs: PromptInputs): string {
  const { persona, memories, core, summary } = inputs;
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

  if (core?.content) {
    sections.push(`# What you know about this person\n${core.content}`);
  }

  if (summary?.content) {
    sections.push(`# Conversation so far (summary)\n${summary.content}`);
  }

  if (memories.length > 0) {
    // Reflections are higher-level; mark them so the model weighs them as insight.
    const facts = memories
      .map((m) => (m.kind === "reflection" ? `- (you've come to feel) ${m.content}` : `- ${m.content}`))
      .join("\n");
    sections.push(`# Things you recall\n${facts}`);
  }

  if (persona.guardrails.length > 0) {
    const rules = persona.guardrails.map((g) => `- ${g}`).join("\n");
    sections.push(`# Rules you must follow\n${rules}`);
  }

  sections.push(
    `Always stay in character as ${persona.name}. Reply naturally and concisely.`,
  );

  return sections.join("\n\n");
}
