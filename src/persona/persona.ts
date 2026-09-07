import { z } from "zod";

/**
 * One authored persona block, exactly as operators write it in the OPOD admin
 * (character_personas.title/content). Blocks arrive in assembly order.
 */
export const PersonaBlockKind = z.enum([
  "identity",
  "behavior",
  "voice",
  "example",
  "greeting",
  "lore",
  "creator_note",
]);

export const PersonaInjection = z.enum([
  "always",
  "start_only",
  "retrieved",
  "never_prompt",
]);

export const PersonaBlock = z.object({
  /** Stable source-row id. Legacy/custom stores may omit it until routed. */
  id: z.string().min(1).optional(),
  title: z.string(),
  content: z.string(),
  /** Experimental P1 read-model fields; the schema owner has not added DDL. */
  kind: PersonaBlockKind.optional(),
  injection: PersonaInjection.optional(),
});

/**
 * A Persona is the character as authored in the OPOD admin: the character row,
 * ordered free-text blocks, and canonical character memories. Raw stores keep
 * that content verbatim. An optional DDL-free read adapter can attach typed
 * routing metadata before the shared Persona Router projects prompt channels
 * (docs/adr/0002, 0008).
 */
export const Persona = z.object({
  characterId: z.string(),
  name: z.string(),
  bio: z.string().default(""),
  /** Ordered persona blocks (sort_order asc), optionally decorated for routing. */
  blocks: z.array(PersonaBlock).default([]),
  /** Canonical facts of the character's life; replies must never contradict them. */
  canonMemories: z.array(z.string()).default([]),
});

export type Persona = z.infer<typeof Persona>;
export type PersonaBlock = z.infer<typeof PersonaBlock>;
export type PersonaBlockKind = z.infer<typeof PersonaBlockKind>;
export type PersonaInjection = z.infer<typeof PersonaInjection>;
