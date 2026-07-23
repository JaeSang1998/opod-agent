import { z } from "zod";

/**
 * One authored persona block, exactly as operators write it in the OPOD admin
 * (character_personas.title/content). Blocks arrive in assembly order.
 */
const PersonaBlock = z.object({
  title: z.string(),
  content: z.string(),
});

/**
 * A Persona is the character exactly as authored in the OPOD admin: the
 * character row plus its ordered free-text persona blocks and the canonical
 * character memories. The Agent injects all of it verbatim — the blocks are the
 * same single source of truth the content pipeline reads, with no structured
 * card and no transform in between (docs/adr/0002).
 */
export const Persona = z.object({
  characterId: z.string(),
  name: z.string(),
  bio: z.string().default(""),
  /** Ordered persona blocks (sort_order asc): 성격, 말투, 첫인사, 대화 예시, … */
  blocks: z.array(PersonaBlock).default([]),
  /** Canonical facts of the character's life; replies must never contradict them. */
  canonMemories: z.array(z.string()).default([]),
});

export type Persona = z.infer<typeof Persona>;
