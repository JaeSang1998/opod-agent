import type { Persona } from "./persona.js";

/**
 * Data-access seam for personas. The default (stub) implementation is in-memory;
 * a Postgres adapter reading the currently *published* persona lands once the
 * schema is confirmed (docs/adr/0002).
 */
export interface PersonaStore {
  /** The currently published persona for a character, or null if none. */
  getPublished(characterId: string): Promise<Persona | null>;
}
