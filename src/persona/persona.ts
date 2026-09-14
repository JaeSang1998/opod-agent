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
  /** Persisted fragment primary key; never interchangeable with a projected block id. */
  storedFragmentId: z.string().min(1).optional(),
  title: z.string(),
  content: z.string(),
  /** Explicit routing from persisted fragments or a compatible read adapter. */
  kind: PersonaBlockKind.optional(),
  injection: PersonaInjection.optional(),
  /** Explicit recall cues, kept out of rendered content. */
  recallKeys: z.array(z.string().trim().min(1)).optional(),
});

/** Authored character memory, distinct from learned user observations. */
export const CharacterCanonMemory = z.object({
  id: z.string().min(1),
  content: z.string(),
  /** Operator classification; never interpreted here as routing or validity. */
  type: z.string(),
  reason: z.string(),
  /** Opaque source timestamps, not event time or expiry. Preserve DB precision. */
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Authored event time, only when explicitly known (not the row creation time). */
  occurredAt: z.string().optional(),
  /** Human-authored event-time label. Kept separate from row timestamps. */
  occurredLabel: z.string().min(1).optional(),
  occurredPrecision: z.enum(["year", "month", "day", "instant", "approximate"]).optional(),
  /** Internal snapshot only; source_refs themselves never enter prompt data. */
  sourceRefsSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Authored routing policy; an event is never a current-state claim. */
  kind: z.enum(["fact", "event"]).optional(),
  injection: z.enum(["always", "retrieved"]).optional(),
  recallKeys: z.array(z.string().trim().min(1)).optional(),
}).superRefine((memory, ctx) => {
  if (memory.kind === "event" && memory.injection !== "retrieved") ctx.addIssue({
    code: z.ZodIssueCode.custom, message: "authored events must not be persistent current state",
  });
  const labelPatterns = {
    year: /^\d{4}$/,
    month: /^\d{4}-(0[1-9]|1[0-2])$/,
    day: /^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/,
  } as const;
  if (!memory.occurredPrecision) {
    if (memory.occurredLabel) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "event time label requires precision" });
    return;
  }
  if (!memory.occurredLabel) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "event time precision requires a label" });
  if (memory.occurredPrecision === "instant") {
    if (!memory.occurredAt || !/(Z|[+-]\d{2}(?::?\d{2})?)$/.test(memory.occurredAt) || !Number.isFinite(Date.parse(memory.occurredAt))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "instant event time requires occurredAt with timezone" });
  } else if (memory.occurredAt) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "partial event time must not invent an instant" });
  if (memory.occurredLabel && memory.occurredPrecision in labelPatterns) {
    const precision = memory.occurredPrecision as keyof typeof labelPatterns;
    if (!labelPatterns[precision].test(memory.occurredLabel)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid ${precision} event time label` });
    if (precision === "day") {
      const parts = memory.occurredLabel.split("-");
      const year = Number(parts[0]);
      const month = Number(parts[1]);
      const day = Number(parts[2]);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid calendar event date" });
    }
  }
});

export type CharacterCanonMemory = z.infer<typeof CharacterCanonMemory>;

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
  /** Source-backed canon; legacy/custom adapters may still supply plain text. */
  canonMemories: z.array(z.union([z.string(), CharacterCanonMemory])).default([]),
});

export type Persona = z.infer<typeof Persona>;
export type PersonaBlock = z.infer<typeof PersonaBlock>;
export type PersonaBlockKind = z.infer<typeof PersonaBlockKind>;
export type PersonaInjection = z.infer<typeof PersonaInjection>;
