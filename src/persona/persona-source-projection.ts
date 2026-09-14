import { createHash } from "node:crypto";
import { z } from "zod";
import { Persona, PersonaBlockKind, PersonaInjection } from "./persona.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Fragment = z.object({
  startByte: z.number().int().safe().nonnegative(),
  endByte: z.number().int().safe().positive(),
  kind: PersonaBlockKind,
  injection: PersonaInjection,
  recallKeys: z.array(z.string().trim().min(1)).optional(),
}).strict();

export const PersonaSourceProjection = z.object({
  schemaVersion: z.literal(1),
  offsetUnit: z.literal("utf8_bytes"),
  sources: z.array(z.object({
    blockId: z.string().min(1),
    sourceSha256: Sha256,
    fragments: z.array(Fragment).min(2),
  }).strict()).min(1),
}).strict();

interface SourceSpan extends Omit<z.infer<typeof Fragment>, "recallKeys"> {
  id: string;
  sourceId: string;
  characterId: string;
  sourceSha256: string;
  fragmentSha256: string;
}

/**
 * Lossless source slicing shared by the serving adapter and evaluations.
 * Inclusion policy remains owned by routePersona.
 * Unlisted blocks, including examples, retain their existing content and policy.
 * The content-free sidecar maps each projected ID back to an exact source version.
 */
export function projectPersonaSources(input: readonly Persona[], rawProjection: unknown): {
  personas: Persona[];
  sourceSpans: SourceSpan[];
} {
  const personas = Persona.array().parse(input);
  const projection = PersonaSourceProjection.parse(rawProjection);
  const sourceSpans: SourceSpan[] = [];
  const sourceIds = new Set<string>();
  const characterIds = new Set<string>();
  for (const persona of personas) {
    if (characterIds.has(persona.characterId)) throw new Error("duplicate character ID");
    characterIds.add(persona.characterId);
    for (const block of persona.blocks) {
      if (!block.id) continue;
      if (sourceIds.has(block.id)) throw new Error("duplicate source block ID");
      sourceIds.add(block.id);
    }
  }
  const plans = new Map<string, typeof projection.sources[number]>();
  for (const source of projection.sources) {
    if (!sourceIds.has(source.blockId)) throw new Error("projection references an unknown source");
    if (plans.has(source.blockId)) throw new Error("duplicate projection source");
    plans.set(source.blockId, source);
  }

  for (const persona of personas) {
    persona.blocks = persona.blocks.flatMap((block) => {
      const plan = block.id ? plans.get(block.id) : undefined;
      if (!plan) return [block];
      const bytes = Buffer.from(block.content, "utf8");
      if (createHash("sha256").update(bytes).digest("hex") !== plan.sourceSha256) {
        throw new Error("source content changed since projection approval");
      }
      let cursor = 0;
      const fragments = plan.fragments.map((fragment) => {
        if (fragment.startByte !== cursor || fragment.endByte <= cursor || fragment.endByte > bytes.length) {
          throw new Error("projection must be contiguous, ordered and within the source");
        }
        const slice = bytes.subarray(fragment.startByte, fragment.endByte);
        const content = slice.toString("utf8");
        if (!Buffer.from(content, "utf8").equals(slice)) {
          throw new Error("projection cuts a UTF-8 character");
        }
        cursor = fragment.endByte;
        const id = `span:${encodeURIComponent(plan.blockId)}:${plan.sourceSha256}:${fragment.startByte}-${fragment.endByte}`;
        if (sourceIds.has(id)) throw new Error("projected block ID collides with another source");
        sourceIds.add(id);
        const { recallKeys, ...span } = fragment;
        sourceSpans.push({
          ...span, id, sourceId: plan.blockId, characterId: persona.characterId,
          sourceSha256: plan.sourceSha256,
          fragmentSha256: createHash("sha256").update(slice).digest("hex"),
        });
        return { ...block, id, content, kind: fragment.kind, injection: fragment.injection,
          recallKeys };
      });
      if (cursor !== bytes.length || fragments.map((f) => f.content).join("") !== block.content) {
        throw new Error("projection does not preserve the complete source");
      }
      return fragments;
    });
  }
  return { personas, sourceSpans };
}
