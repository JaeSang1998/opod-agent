import { z } from "zod";
import { PersonaBlockKind, PersonaInjection, type Persona } from "./persona.js";
import type { PersonaStore } from "./persona-store.js";

const PersonaRoutingEntry = z.object({
  blockId: z.string().min(1),
  kind: PersonaBlockKind,
  injection: PersonaInjection,
});

export const PersonaRoutingManifest = z
  .object({
    schemaVersion: z.literal(1),
    mappingMode: z.literal("explicit_block_id"),
    blocks: z.array(PersonaRoutingEntry).min(1),
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

  constructor(
    private readonly source: PersonaStore,
    manifest: PersonaRoutingManifest,
  ) {
    const parsed = PersonaRoutingManifest.parse(manifest);
    this.routes = new Map(parsed.blocks.map((route) => [route.blockId, route]));
  }

  async get(characterId: string): Promise<Persona | null> {
    const persona = await this.source.get(characterId);
    if (!persona) return null;

    return {
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
        return { ...block, kind: route.kind, injection: route.injection };
      }),
    };
  }
}
