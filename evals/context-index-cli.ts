import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { z } from "zod";
import { OpenAICompatProvider } from "../src/provider/openai-compat-provider.js";
import { validQueryEmbedding } from "../src/memory/retrieval.js";

const Approval = z.object({
  characterIds: z.array(z.string().uuid()).min(1).max(4),
  embeddingModel: z.string().min(1),
  embeddingBaseUrl: z.string().url(),
  maxRows: z.number().int().positive().max(256),
  maxRequests: z.number().int().positive().max(256),
  maxInputBytes: z.number().int().positive().max(1_000_000),
  externalTransferApproved: z.literal(true),
}).strict();

export interface ContextIndexRow {
  id: string;
  character_id: string;
  source_type: "fragment" | "canon";
  content: string;
  source_hash: string;
}

export function assertContextIndexDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || url.hostname !== "127.0.0.1" || url.port !== "55433"
    || url.pathname !== "/opod_persona_memory_local" || url.search || url.hash) {
    throw new Error("Context indexing permits only the dedicated 127.0.0.1:55433 local database");
  }
}

/** Same statement checks ownership, current source, routing and parent liveness before writing. */
export async function persistContextEmbedding(pool: Pool, row: ContextIndexRow, vector: number[], model: string): Promise<boolean> {
  if (!validQueryEmbedding(vector) || !model) throw new Error("A named model and nonzero finite 1024-dimensional vector are required");
  if (createHash("sha256").update(row.content).digest("hex") !== row.source_hash) throw new Error("Source snapshot hash mismatch");
  const result = row.source_type === "fragment"
    ? await pool.query(`UPDATE opod.character_persona_fragments f SET embedding=$1::vector(1024),
      embedding_model=$2, embedding_source_sha256=$3, embedded_at=now()
      FROM opod.character_personas p WHERE f.id::text=$4 AND p.id=f.persona_id
        AND p.character_id::text=$5 AND p.deleted_at IS NULL AND f.injection='retrieved'
        AND encode(sha256(convert_to(f.content,'UTF8')),'hex')=$3`,
    [JSON.stringify(vector), model, row.source_hash, row.id, row.character_id])
    : await pool.query(`UPDATE opod.character_memories SET embedding=$1::vector(1024),
      embedding_model=$2, embedding_source_sha256=$3, embedded_at=now()
      WHERE id::text=$4 AND character_id::text=$5 AND deleted_at IS NULL AND injection='retrieved'
        AND encode(sha256(convert_to(content,'UTF8')),'hex')=$3`,
    [JSON.stringify(vector), model, row.source_hash, row.id, row.character_id]);
  return result.rowCount === 1;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    approval: { type: "string" }, out: { type: "string" }, execute: { type: "boolean", default: false },
  } });
  if (!values.approval || !values.out) throw new Error("Required: --approval <explicit transfer contract.json> --out <fresh private directory>; dry-run unless --execute");
  const approvalBytes = await readFile(resolve(values.approval));
  const approval = Approval.parse(JSON.parse(approvalBytes.toString("utf8")));
  const endpoint = new URL(approval.embeddingBaseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))) {
    throw new Error("Embedding endpoint must be HTTPS (or loopback HTTP), without credentials or query parameters");
  }
  const databaseUrl = process.env.CONTEXT_INDEX_DATABASE_URL;
  if (!databaseUrl) throw new Error("CONTEXT_INDEX_DATABASE_URL is required; no application or development DB fallback");
  assertContextIndexDatabase(databaseUrl);
  const outputDir = resolve(values.out);
  await mkdir(outputDir, { mode: 0o700 });
  const pool = new Pool({ connectionString: databaseUrl });
  const outcomes: Array<{ id: string; sourceType: string; sourceHash: string; status: string }> = [];
  let requests = 0;
  let totalTokens = 0;
  let status: "failed" | "dry_run" | "completed" = "failed";
  try {
    const rows = (await pool.query<ContextIndexRow>(`WITH sources AS (
      SELECT f.id::text, p.character_id::text, 'fragment'::text AS source_type, f.content
      FROM opod.character_persona_fragments f JOIN opod.character_personas p ON p.id=f.persona_id
      WHERE p.character_id::text=ANY($1::text[]) AND p.deleted_at IS NULL AND f.injection='retrieved'
      UNION ALL
      SELECT id::text, character_id::text, 'canon'::text, content FROM opod.character_memories
      WHERE character_id::text=ANY($1::text[]) AND deleted_at IS NULL AND injection='retrieved'
    ) SELECT *,encode(sha256(convert_to(content,'UTF8')),'hex') AS source_hash
      FROM sources ORDER BY source_type,id LIMIT $2`, [approval.characterIds, approval.maxRows + 1])).rows;
    if (rows.length > approval.maxRows || rows.length > approval.maxRequests) throw new Error("Selected sources exceed approved row/request bounds; no model calls made");
    if (rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.content, "utf8"), 0) > approval.maxInputBytes) {
      throw new Error("Selected source bytes exceed the approved transfer bound; no model calls made");
    }
    await writeFile(resolve(outputDir, "source-snapshot.json"), JSON.stringify(rows, null, 2), { flag: "wx", mode: 0o600 });
    if (!values.execute) { status = "dry_run"; return; }
    const provider = new OpenAICompatProvider({ baseUrl: approval.embeddingBaseUrl,
      model: "unused-chat", embeddingModel: approval.embeddingModel,
      apiKey: process.env.CONTEXT_INDEX_API_KEY ?? "", maxRetries: 0 });
    for (const row of rows) {
      requests++;
      const { embeddings, response } = await provider.embedWithResponse([row.content], { signal: AbortSignal.timeout(60_000) });
      totalTokens += response.usage.total_tokens;
      if (response.model !== approval.embeddingModel || embeddings.length !== 1 || !embeddings[0]
        || response.data[0]?.index !== 0) {
        throw new Error("Embedding response model/count differs from the explicit request");
      }
      const written = await persistContextEmbedding(pool, row, embeddings[0], approval.embeddingModel);
      outcomes.push({ id: row.id, sourceType: row.source_type, sourceHash: row.source_hash,
        status: written ? "indexed" : "source_changed_or_unavailable" });
    }
    status = "completed";
  } finally {
    await pool.end();
    await writeFile(resolve(outputDir, "index-report.json"), JSON.stringify({
      kind: "local-character-context-index", approvalSha256: createHash("sha256").update(approvalBytes).digest("hex"),
      execute: values.execute, status, requests, totalTokens, outcomes, qualityPassed: false,
    }, null, 2), { flag: "wx", mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Context indexing stopped; inspect the private report. No automatic retries."); process.exitCode = 1; });
}
