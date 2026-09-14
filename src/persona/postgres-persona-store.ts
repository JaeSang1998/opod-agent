import { Pool } from "pg";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Persona, PersonaBlockKind, PersonaInjection } from "./persona.js";
import { personaContextHash, PersonaContextIntegrityError, type PersonaContextQuery, type PersonaContextSelection, type PersonaStore } from "./persona-store.js";
import { projectPersonaSources } from "./persona-source-projection.js";
import { lexicalQueryTerms, validQueryEmbedding } from "../memory/retrieval.js";

interface ContextCandidate {
  id: string;
  source_type: "fragment" | "canon";
  content: string;
  source_hash: string;
  kind: string;
  injection: string;
  recall_keys: string[];
  occurred_at: string | null;
  occurred_label: string | null;
  occurred_precision: string | null;
  source_refs_sha256: string | null;
  score: number;
}

// Scope and routing are applied before either ranking path; no recency pre-limit.
const contextScope = `WITH scoped AS MATERIALIZED (
  SELECT f.id::text, 'fragment'::text AS source_type, f.content, f.kind, f.injection, f.recall_keys,
    NULL::text AS occurred_at, NULL::text AS occurred_label, NULL::text AS occurred_precision,
    NULL::text AS source_refs_sha256,
    f.embedding, f.embedding_model, f.embedding_source_sha256
  FROM opod.character_persona_fragments f
  JOIN opod.character_personas p ON p.id = f.persona_id
  WHERE p.character_id::text = $1 AND p.deleted_at IS NULL AND f.injection = 'retrieved'
  UNION ALL
  SELECT m.id::text, 'canon'::text, m.canon_text,
    m.temporal_kind, m.context_injection_mode, m.retrieval_keywords,
    m.event_occurred_at::text, m.event_time_label, m.event_time_precision,
    CASE WHEN m.source_references IS NULL THEN NULL ELSE encode(sha256(convert_to(m.source_references::text, 'UTF8')), 'hex') END,
    m.canon_embedding, m.embedding_model, m.embedded_text_sha256
  FROM opod.character_canon_memories m
  WHERE m.character_id::text = $1 AND m.deleted_at IS NULL AND m.context_injection_mode = 'retrieved'
), sources AS (
  SELECT *, encode(sha256(convert_to(content, 'UTF8')), 'hex') AS source_hash FROM scoped
)`;

const StoredFragments = z.array(z.object({
  id: z.string().min(1).optional(),
  ordinal: z.number().int().nonnegative(),
  content: z.string().min(1),
  kind: PersonaBlockKind,
  injection: PersonaInjection,
  recallKeys: z.array(z.string().trim().min(1)),
}));

interface CharacterRow {
  id: string;
  display_name: string;
  bio: string;
}

interface BlockRow {
  id: string;
  title: string;
  content: string;
  fragments?: unknown;
}

interface MemoryRow {
  id: string;
  type: string;
  content: string;
  reason: string;
  created_at: string;
  updated_at: string;
  occurred_at?: string | null;
  occurred_label?: string | null;
  occurred_precision?: string | null;
  source_refs_sha256?: string | null;
  kind?: string | null;
  injection?: string | null;
  recall_keys?: string[];
}

/**
 * Reads the persona straight from the OPOD Postgres schema (docs/adr/0002):
 * the character row, its active persona blocks in assembly order, and the
 * canonical character memories. Persisted fragments replace their source only
 * when they reconstruct it exactly; unclassified legacy rows keep their policy.
 * This adapter never infers policy from a title. Block/memory ordering
 * mirrors the admin's ([sort_order, created_at, id] / [created_at, id]).
 */
export class PostgresPersonaStore implements PersonaStore {
  constructor(private readonly pool: Pool) {}

  static fromUrl(databaseUrl: string): PostgresPersonaStore {
    return new PostgresPersonaStore(new Pool({ connectionString: databaseUrl }));
  }

  async retrieveContext(input: PersonaContextQuery): Promise<PersonaContextSelection> {
    await this.assertCanonLinks(input.characterId);
    const topK = Number.isFinite(input.topK) ? Math.max(0, Math.min(32, Math.floor(input.topK))) : 0;
    const result: PersonaContextSelection = {
      fragmentIds: [], canonIds: [], sourceHashes: {}, contextHashes: {}, semanticStatus: "query_unavailable",
    };
    if (!topK) return result;
    const terms = lexicalQueryTerms(input.queryText);
    const lexical = terms.length ? (await this.pool.query<ContextCandidate>(`${contextScope}, ranked AS (
      SELECT id, source_type, content, source_hash, kind, injection, recall_keys,
        occurred_at, occurred_label, occurred_precision, source_refs_sha256,
        (SELECT count(*) FROM unnest($2::text[]) term
         WHERE strpos(lower(normalize(content, NFKC)), term) > 0
           OR EXISTS (SELECT 1 FROM unnest(recall_keys) cue
                      WHERE strpos(lower(normalize(cue, NFKC)), term) > 0)) AS score
      FROM sources
    ) SELECT * FROM ranked WHERE score > 0 ORDER BY score DESC, id ASC LIMIT $3`,
    [input.characterId, terms, topK * 4])).rows : [];
    let semantic: ContextCandidate[] = [];
    if (input.embeddingModel && validQueryEmbedding(input.queryEmbedding)) {
      try {
        const rows = (await this.pool.query<ContextCandidate>(`${contextScope}
          SELECT id, source_type, content, source_hash, kind, injection, recall_keys,
            occurred_at, occurred_label, occurred_precision, source_refs_sha256,
            1 - (embedding <=> $2::vector(1024)) AS score
          FROM sources WHERE embedding IS NOT NULL AND embedding_model = $3
            AND embedding_source_sha256 = source_hash AND vector_norm(embedding) > 0
          ORDER BY embedding <=> $2::vector(1024), id ASC LIMIT $4`,
        [input.characterId, JSON.stringify(input.queryEmbedding), input.embeddingModel, topK * 4])).rows;
        result.semanticStatus = rows.length ? "used" : "no_valid_index";
        semantic = rows.filter(row => Number.isFinite(Number(row.score)) && Number(row.score) > 0.2);
      } catch {
        result.semanticStatus = "failed";
      }
    }
    const merged = new Map<string, { candidate: ContextCandidate; rankScore: number }>();
    for (const stream of [lexical, semantic]) stream.forEach((candidate, i) => {
      const key = `${candidate.source_type}:${candidate.id}`;
      const previous = merged.get(key);
      // Reject a source changed between lexical and semantic reads.
      if (previous && previous.candidate.source_hash !== candidate.source_hash) {
        previous.rankScore = -Infinity;
      } else if (previous) previous.rankScore += 1 / (61 + i);
      else merged.set(key, { candidate, rankScore: 1 / (61 + i) });
    });
    const seen = new Set<string>();
    for (const { candidate, rankScore } of [...merged.values()].sort((a, b) =>
      b.rankScore - a.rankScore || a.candidate.id.localeCompare(b.candidate.id))) {
      const content = candidate.content.normalize("NFKC").trim();
      if (rankScore <= 0 || seen.has(content)) continue;
      seen.add(content);
      (candidate.source_type === "fragment" ? result.fragmentIds : result.canonIds).push(candidate.id);
      result.sourceHashes[candidate.id] = candidate.source_hash;
      result.contextHashes[candidate.id] = personaContextHash({
        content: candidate.content, kind: candidate.kind, injection: candidate.injection,
        recallKeys: candidate.recall_keys, occurredAt: candidate.occurred_at,
        occurredLabel: candidate.occurred_label, occurredPrecision: candidate.occurred_precision,
        sourceRefsSha256: candidate.source_refs_sha256,
      });
      if (seen.size >= topK) break;
    }
    return result;
  }

  async get(characterId: string): Promise<Persona | null> {
    // id::text sidesteps the uuid cast error a malformed header value would raise.
    const character = await this.pool.query<CharacterRow>(
      "SELECT id, display_name, bio FROM opod.characters WHERE id::text = $1",
      [characterId],
    );
    const row = character.rows[0];
    if (!row) return null;
    await this.assertCanonLinks(row.id);

    const [blocks, memories] = await Promise.all([
      this.pool.query<BlockRow>(
        `SELECT id, title, content,
         (SELECT json_agg(json_build_object(
           'id', f.id, 'ordinal', f.ordinal, 'content', f.content, 'kind', f.kind,
           'injection', f.injection, 'recallKeys', f.recall_keys) ORDER BY f.ordinal)
          FROM opod.character_persona_fragments f WHERE f.persona_id = character_personas.id) AS fragments
         FROM opod.character_personas
         WHERE character_id = $1 AND deleted_at IS NULL
         ORDER BY sort_order ASC, created_at ASC, id ASC`,
        [row.id],
      ),
      this.pool.query<MemoryRow>(
        `SELECT id, authoring_category AS type, canon_text AS content,
         authoring_reason AS reason,
         created_at::text AS created_at, updated_at::text AS updated_at,
         temporal_kind AS kind, context_injection_mode AS injection,
         retrieval_keywords AS recall_keys, event_occurred_at::text AS occurred_at,
         event_time_label AS occurred_label, event_time_precision AS occurred_precision,
         CASE WHEN source_references IS NULL THEN NULL ELSE encode(sha256(convert_to(source_references::text, 'UTF8')), 'hex') END AS source_refs_sha256
         FROM opod.character_canon_memories
         WHERE character_id = $1 AND deleted_at IS NULL
         ORDER BY character_canon_memories.created_at ASC, id ASC`,
        [row.id],
      ),
    ]);

    const persona = Persona.parse({
      characterId: row.id,
      name: row.display_name,
      bio: row.bio,
      blocks: blocks.rows.map((b) => ({ id: b.id, title: b.title, content: b.content })),
      canonMemories: memories.rows.map((m) => ({
        id: m.id, type: m.type, content: m.content, reason: m.reason,
        createdAt: m.created_at, updatedAt: m.updated_at,
        ...(m.occurred_at == null ? {} : { occurredAt: m.occurred_at }),
        ...(m.occurred_label == null ? {} : { occurredLabel: m.occurred_label }),
        ...(m.occurred_precision == null ? {} : { occurredPrecision: m.occurred_precision }),
        ...(m.source_refs_sha256 == null ? {} : { sourceRefsSha256: m.source_refs_sha256 }),
        ...(m.kind == null ? {} : { kind: m.kind, injection: m.injection, recallKeys: m.recall_keys }),
      })),
    });
    for (const block of blocks.rows) {
      if (block.fragments == null) continue;
      const fragments = StoredFragments.parse(block.fragments);
      const first = fragments[0];
      if (!first || fragments.some((f, i) => f.ordinal !== i)
        || fragments.map((f) => f.content).join("") !== block.content) {
        throw new Error("persisted persona fragments do not preserve their source");
      }
      if (fragments.length === 1) {
        const { kind, injection, recallKeys } = first;
        persona.blocks = persona.blocks.map(b => b.id === block.id
          ? { ...b, kind, injection, recallKeys, ...(first.id ? { storedFragmentId: first.id } : {}) } : b);
        continue;
      }
      let cursor = 0;
      const projected = projectPersonaSources([persona], {
        schemaVersion: 1, offsetUnit: "utf8_bytes", sources: [{
          blockId: block.id,
          sourceSha256: createHash("sha256").update(block.content).digest("hex"),
          fragments: fragments.map((f) => {
            const startByte = cursor;
            cursor += Buffer.byteLength(f.content, "utf8");
            return { startByte, endByte: cursor, kind: f.kind, injection: f.injection, recallKeys: f.recallKeys };
          }),
        }],
      });
      const fragmentIds = new Map(projected.sourceSpans.map((span, i) => [span.id, fragments[i]?.id]));
      persona.blocks = projected.personas.flatMap(p => p.blocks).map(b => {
        const storedFragmentId = b.id ? fragmentIds.get(b.id) : undefined;
        return storedFragmentId ? { ...b, storedFragmentId } : b;
      });
    }
    return persona;
  }

  private async assertCanonLinks(characterId: string): Promise<void> {
    const invalid = await this.pool.query<{ fragment_id: string; memory_id: string }>(`
      SELECT l.fragment_id::text, l.memory_id::text
      FROM opod.character_persona_canon_links l
      LEFT JOIN opod.character_persona_fragments f ON f.id = l.fragment_id
      LEFT JOIN opod.character_personas p ON p.id = f.persona_id
      LEFT JOIN opod.character_canon_memories m ON m.id = l.memory_id
      WHERE (p.character_id::text = $1 OR m.character_id::text = $1)
        AND (f.id IS NULL OR p.id IS NULL OR p.deleted_at IS NOT NULL
          OR m.id IS NULL OR m.deleted_at IS NOT NULL
          OR p.character_id <> m.character_id OR p.character_id::text <> $1
          OR f.injection <> 'never_prompt')
      LIMIT 1`, [characterId]);
    if (invalid.rows.length) throw new PersonaContextIntegrityError("invalid character persona canon link");
  }
}
