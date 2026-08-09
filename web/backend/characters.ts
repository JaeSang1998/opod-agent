import "server-only";
import type { CharacterOption } from "@/chat/character-option";

/**
 * The playground talks to opod-agent by `character_id`, but the agent has no
 * listing route — it resolves a persona from the OPOD Postgres per request
 * (docs/adr/0002) and exposes only chat + consolidate. So the id has to come
 * from the schema owner: service-backend's public `GET /characters`.
 *
 * Optional on purpose: without SERVICE_BACKEND_URL (or when it is down) the
 * playground still runs as a pure agent client and the character field stays a
 * free-text input.
 */
const SERVICE_BACKEND_URL = process.env.SERVICE_BACKEND_URL?.replace(/\/$/, "");

interface CharacterRow {
  id?: unknown;
  publicId?: unknown;
  displayName?: unknown;
}

export async function listCharacters(): Promise<CharacterOption[]> {
  if (!SERVICE_BACKEND_URL) return [];

  try {
    // Uncached by default in Next 16 — a seed run mid-session shows up on reload.
    const res = await fetch(`${SERVICE_BACKEND_URL}/characters`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return [];

    return rows.flatMap((row: CharacterRow) =>
      typeof row?.id === "string" && typeof row?.displayName === "string"
        ? [
            {
              id: row.id,
              publicId: typeof row.publicId === "string" ? row.publicId : row.id,
              displayName: row.displayName,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}
