import { z } from "zod";

/**
 * A Persona is the structured character card the Agent composes into a system
 * prompt (docs/adr and CONTEXT.md). Only published personas are served.
 */
export const Persona = z.object({
  characterId: z.string(),
  name: z.string(),
  description: z.string(),
  /** Personality traits / voice — free text or short bullet lines. */
  personality: z.string().default(""),
  speakingStyle: z.string().default(""),
  /** Optional opening line, used when the conversation is empty. */
  greeting: z.string().optional(),
  /** Few-shot example exchanges to anchor voice. */
  exampleDialogues: z
    .array(z.object({ user: z.string(), character: z.string() }))
    .default([]),
  /** Hard constraints the character must respect. */
  guardrails: z.array(z.string()).default([]),
});

export type Persona = z.infer<typeof Persona>;
