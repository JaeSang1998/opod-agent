import { Pool } from "pg";
import type { Persona } from "./persona.js";
import type { PersonaStore } from "./persona-store.js";

interface CharacterRow {
  id: string;
  display_name: string;
  bio: string;
}

interface BlockRow {
  title: string;
  content: string;
}

interface MemoryRow {
  content: string;
}

/**
 * Reads the persona straight from the OPOD Postgres schema (docs/adr/0002):
 * the character row, its active persona blocks in assembly order, and the
 * canonical character memories. No transform — what operators author in the
 * admin is exactly what the character is. Block/memory ordering mirrors the
 * admin's ([sort_order, created_at, id] / [created_at, id]).
 */
export class PostgresPersonaStore implements PersonaStore {
  constructor(private readonly pool: Pool) {}

  static fromUrl(databaseUrl: string): PostgresPersonaStore {
    return new PostgresPersonaStore(new Pool({ connectionString: databaseUrl }));
  }

  async get(characterId: string): Promise<Persona | null> {
    // id::text sidesteps the uuid cast error a malformed header value would raise.
    const character = await this.pool.query<CharacterRow>(
      "SELECT id, display_name, bio FROM opod.characters WHERE id::text = $1",
      [characterId],
    );
    const row = character.rows[0];
    if (!row) return null;

    const [blocks, memories] = await Promise.all([
      this.pool.query<BlockRow>(
        `SELECT title, content FROM opod.character_personas
         WHERE character_id = $1 AND deleted_at IS NULL
         ORDER BY sort_order ASC, created_at ASC, id ASC`,
        [row.id],
      ),
      this.pool.query<MemoryRow>(
        `SELECT content FROM opod.character_memories
         WHERE character_id = $1 AND deleted_at IS NULL
         ORDER BY created_at ASC, id ASC`,
        [row.id],
      ),
    ]);

    return {
      characterId: row.id,
      name: row.display_name,
      bio: row.bio,
      blocks: blocks.rows.map((b) => ({ title: b.title, content: b.content })),
      canonMemories: memories.rows.map((m) => m.content),
    };
  }
}
