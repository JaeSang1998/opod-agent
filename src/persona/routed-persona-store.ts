import { z } from "zod";
import { createHash } from "node:crypto";
import { PersonaBlockKind, PersonaInjection, type Persona } from "./persona.js";
import type { PersonaStore } from "./persona-store.js";
import { PersonaSourceProjection, projectPersonaSources } from "./persona-source-projection.js";

const PersonaRoutingEntry = z.object({
  blockId: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  kind: PersonaBlockKind,
  injection: PersonaInjection,
  recallKeys: z.array(z.string().trim().min(1)).optional(),
});

const StructuredCharacter = z.object({
  characterId: z.string().min(1),
  projection: PersonaSourceProjection.optional(),
  canon: z.array(z.object({
    memoryId: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["fact", "event"]), injection: z.enum(["always", "retrieved"]),
    recallKeys: z.array(z.string().trim().min(1)).optional(),
  })).superRefine((entries, ctx) => {
    if (new Set(entries.map(e => e.memoryId)).size !== entries.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate canon mapping" });
    }
    if (entries.some(e => e.kind === "event" && e.injection === "always")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "events must be retrieved, not persistent current state" });
    }
  }),
});

export const PersonaRoutingManifest = z
  .object({
    schemaVersion: z.literal(1),
    mappingMode: z.literal("explicit_block_id"),
    blocks: z.array(PersonaRoutingEntry).min(1),
    structuredCharacters: z.array(StructuredCharacter).optional(),
  })
  .superRefine((manifest, ctx) => {
    const ids = manifest.blocks.map((block) => block.blockId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocks"],
        message: "routing manifest block ids must be unique",
      });
    }
    const characterIds = manifest.structuredCharacters?.map(c => c.characterId) ?? [];
    if (new Set(characterIds).size !== characterIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate structured character mapping" });
    }
  });

export type PersonaRoutingManifest = z.infer<typeof PersonaRoutingManifest>;

/**
 * DDL-free P1 read adapter. It decorates raw Persona rows with an explicit,
 * versioned routing manifest keyed by source id. Strict completeness is
 * intentional: an unclassified block must not fall back to `always` inside a
 * claimed routed experiment.
 */
export class RoutedPersonaStore implements PersonaStore {
  private readonly routes: Map<
    string,
    PersonaRoutingManifest["blocks"][number]
  >;
  private readonly structured: Map<string, z.infer<typeof StructuredCharacter>>;

  constructor(
    private readonly source: PersonaStore,
    manifest: PersonaRoutingManifest,
  ) {
    const parsed = PersonaRoutingManifest.parse(manifest);
    this.routes = new Map(parsed.blocks.map((route) => [route.blockId, route]));
    this.structured = new Map(parsed.structuredCharacters?.map(c => [c.characterId, c]) ?? []);
  }

  async get(characterId: string): Promise<Persona | null> {
    const persona = await this.source.get(characterId);
    if (!persona) return null;

    let result: Persona = {
      ...persona,
      blocks: persona.blocks.map((block, index) => {
        if (!block.id) {
          throw new Error(
            `persona ${characterId} block ${index + 1} has no stable id for explicit routing`,
          );
        }
        const route = this.routes.get(block.id);
        if (!route) {
          throw new Error(`routing manifest is missing an explicit route for block ${block.id}`);
        }
        if (route.sourceSha256 && createHash("sha256").update(block.content).digest("hex") !== route.sourceSha256) {
          throw new Error("persona source changed since classification");
        }
        return { ...block, kind: route.kind, injection: route.injection,
          recallKeys: route.recallKeys };
      }),
    };
    const profile = this.structured.get(characterId);
    if (!profile) return result;
    if (profile.projection) {
      const projected = projectPersonaSources([result], profile.projection).personas[0];
      if (!projected) throw new Error("structured persona projection missing");
      result = projected;
    }
    const canon = new Map(profile.canon.map(c => [c.memoryId, c]));
    const rawIds = result.canonMemories.map(memory => typeof memory === "string" ? undefined : memory.id);
    if (canon.size !== rawIds.length || new Set(rawIds).size !== rawIds.length ||
      rawIds.some(id => !id || !canon.has(id))) throw new Error("canon mapping must cover every source exactly once");
    result.canonMemories = result.canonMemories.map(memory => {
      const route = typeof memory === "string" ? undefined : canon.get(memory.id);
      if (typeof memory === "string" || !route) throw new Error("canon mapping must cover every source");
      if (createHash("sha256").update(memory.content).digest("hex") !== route.sourceSha256) {
        throw new Error("canon source changed since classification");
      }
      return { ...memory, kind: route.kind, injection: route.injection,
        recallKeys: route.recallKeys };
    });
    return result;
  }
}
