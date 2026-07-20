import type { Persona } from "./persona.js";

/**
 * Data-access seam for personas. The default (stub) implementation is in-memory;
 * production reads the live OPOD rows via PostgresPersonaStore (docs/adr/0002).
 * Active rows are the serving truth — there is no separate publish state.
 */
export interface PersonaStore {
  /** The persona for a character (active blocks + canon memories), or null if unknown. */
  get(characterId: string): Promise<Persona | null>;
}
