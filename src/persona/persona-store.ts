import type { Persona } from "./persona.js";
import { createHash } from "node:crypto";

export interface PersonaContextQuery {
  characterId: string;
  queryText: string;
  queryEmbedding: number[];
  embeddingModel?: string;
  topK: number;
}

export interface PersonaContextSelection {
  fragmentIds: string[];
  canonIds: string[];
  /** Current source hash per stored row; consumers recheck it against their read snapshot. */
  sourceHashes: Record<string, string>;
  /** Routing/time-aware snapshot hash; distinct from the content-only embedding hash. */
  contextHashes: Record<string, string>;
  semanticStatus: "used" | "no_valid_index" | "query_unavailable" | "failed";
}

export class PersonaContextIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaContextIntegrityError";
  }
}

export interface PersonaContextSnapshot {
  content: string;
  kind: string;
  injection: string;
  recallKeys: readonly string[];
  occurredAt: string | null;
  occurredLabel: string | null;
  occurredPrecision: string | null;
  sourceRefsSha256: string | null;
}

export function personaContextHash(value: PersonaContextSnapshot): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Data-access seam for personas. The default (stub) implementation is in-memory;
 * production reads the live OPOD rows via PostgresPersonaStore (docs/adr/0002).
 * Active rows are the serving truth — there is no separate publish state.
 */
export interface PersonaStore {
  /** The persona for a character (active blocks + canon memories), or null if unknown. */
  get(characterId: string): Promise<Persona | null>;
  retrieveContext?(input: PersonaContextQuery): Promise<PersonaContextSelection>;
}
