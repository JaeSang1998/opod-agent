import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ChatService } from "../chat/chat-service.js";
import { assembleSystemPrompt } from "../chat/system-prompt.js";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { StubMemoryStore } from "../memory/stub-memory-store.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { PersonaContextIntegrityError, personaContextHash } from "./persona-store.js";
import { PostgresPersonaStore } from "./postgres-persona-store.js";

/** Minimal fake capturing queries and returning canned rows per table. */
function fakePool(rowsByTable: Record<string, unknown[]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("character_persona_canon_links")) return { rows: rowsByTable["opod.character_persona_canon_links"] ?? [] };
      const table = Object.keys(rowsByTable).find((t) => sql.includes(t));
      return { rows: table ? rowsByTable[table] : [] };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

describe("PostgresPersonaStore", () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)("hybrid searches the scoped full set, rejects stale indexes and never fills unrelated results", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const characterId = randomUUID();
      const foreignId = randomUUID();
      for (const id of [characterId, foreignId]) await client.query(
        "INSERT INTO opod.characters(id,public_id,display_name,bio,updated_at) VALUES ($1,$2,'Synthetic','',now())", [id, `it-${id}`]);
      const vector = [1, ...Array(1023).fill(0)];
      const sourceId = randomUUID();
      const fragmentId = randomUUID();
      await client.query("INSERT INTO opod.character_personas(id,character_id,title,content,updated_at) VALUES($1,$2,'Background','부산 여행',now())", [sourceId, characterId]);
      await client.query(`INSERT INTO opod.character_persona_fragments(id,persona_id,ordinal,content,kind,injection,recall_keys,updated_at)
        VALUES($1,$2,0,'부산 여행','lore','retrieved',ARRAY['휴가'],now())`, [fragmentId, sourceId]);
      const memories = [
        { id: randomUUID(), owner: characterId, content: "오래된 관련 기억", model: "synthetic", fresh: true, deleted: false, injection: "retrieved" },
        { id: randomUUID(), owner: foreignId, content: "다른 캐릭터의 기억", model: "synthetic", fresh: true, deleted: false, injection: "retrieved" },
        { id: randomUUID(), owner: characterId, content: "색인 이후 바뀐 기억", model: "synthetic", fresh: false, deleted: false, injection: "retrieved" },
        { id: randomUUID(), owner: characterId, content: "다른 모델 기억", model: "wrong-model", fresh: true, deleted: false, injection: "retrieved" },
        { id: randomUUID(), owner: characterId, content: "삭제된 기억", model: "synthetic", fresh: true, deleted: true, injection: "retrieved" },
        { id: randomUUID(), owner: characterId, content: "상시 기억", model: "synthetic", fresh: true, deleted: false, injection: "always" },
      ];
      for (const row of memories) await client.query(`INSERT INTO opod.character_canon_memories
        (id,character_id,canon_text,authoring_category,authoring_reason,temporal_kind,context_injection_mode,updated_at,created_at,canon_embedding,embedding_model,embedded_text_sha256,deleted_at)
        VALUES($1,$2,$3,'fact','synthetic','fact',$4,now(),'2020-01-01',$5::vector,$6,$7,CASE WHEN $8 THEN now() ELSE NULL END)`,
      [row.id, row.owner, row.content, row.injection, JSON.stringify(vector), row.model,
        createHash("sha256").update(row.fresh ? row.content : "stale").digest("hex"), row.deleted]);
      await client.query(`INSERT INTO opod.character_canon_memories(id,character_id,canon_text,authoring_category,authoring_reason,temporal_kind,context_injection_mode,updated_at)
        SELECT gen_random_uuid(),$1,'무관 배경 ' || n,'fact','synthetic','fact','retrieved',now() FROM generate_series(1,520) n`, [characterId]);
      const store = new PostgresPersonaStore(client as unknown as Pool);
      const semantic = await store.retrieveContext({ characterId, queryText: "unmatched", queryEmbedding: vector, embeddingModel: "synthetic", topK: 4 });
      expect(semantic.semanticStatus).toBe("used");
      expect(semantic.canonIds).toEqual([memories[0]!.id]);
      const lexical = await store.retrieveContext({ characterId, queryText: "휴가", queryEmbedding: [], topK: 4 });
      expect(lexical.fragmentIds).toEqual([fragmentId]);
      expect(lexical.semanticStatus).toBe("query_unavailable");
      expect((await store.get(characterId))?.blocks[0]).toMatchObject({ id: sourceId, storedFragmentId: fragmentId });
      await client.query(`INSERT INTO opod.character_canon_memories(id,character_id,canon_text,authoring_category,authoring_reason,temporal_kind,context_injection_mode,retrieval_keywords,updated_at)
        VALUES($1,$2,'부산 여행','fact','synthetic','fact','retrieved',ARRAY['휴가'],now())`, [randomUUID(), characterId]);
      const deduplicated = await store.retrieveContext({ characterId, queryText: "휴가", queryEmbedding: [], topK: 4 });
      expect([...deduplicated.fragmentIds, ...deduplicated.canonIds]).toHaveLength(1);
      await client.query("UPDATE opod.character_personas SET deleted_at=now() WHERE id=$1", [sourceId]);
      expect((await store.retrieveContext({ characterId, queryText: "휴가", queryEmbedding: [], topK: 4 })).fragmentIds).toEqual([]);
      const empty = await store.retrieveContext({ characterId, queryText: "unmatched", queryEmbedding: vector, embeddingModel: "missing-model", topK: 4 });
      expect(empty).toMatchObject({ fragmentIds: [], canonIds: [], semanticStatus: "no_valid_index" });
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); await pool.end(); }
    }
  });

  it("keeps lexical matches when semantic search fails and returns source hashes for snapshot checks", async () => {
    const content = "부산의 오래된 여행";
    const hash = createHash("sha256").update(content).digest("hex");
    const pool = { query: async (sql: string) => {
      if (sql.includes("character_persona_canon_links")) return { rows: [] };
      if (sql.includes("<=>")) throw new Error("semantic unavailable");
      return { rows: [{ id: "f1", source_type: "fragment", content, source_hash: hash, kind: "lore", injection: "retrieved",
        recall_keys: [], occurred_at: null, occurred_label: null, occurred_precision: null, source_refs_sha256: null, score: 1 }] };
    } } as unknown as Pool;
    const result = await new PostgresPersonaStore(pool).retrieveContext({ characterId: "c", queryText: "부산", queryEmbedding: [1, ...Array(1023).fill(0)], embeddingModel: "test", topK: 4 });
    expect(result).toEqual({ fragmentIds: ["f1"], canonIds: [], sourceHashes: { f1: hash }, contextHashes: {
      f1: personaContextHash({ content, kind: "lore", injection: "retrieved", recallKeys: [], occurredAt: null, occurredLabel: null, occurredPrecision: null, sourceRefsSha256: null }),
    }, semanticStatus: "failed" });
  });

  it("rejects an invalid canon link before loading prompt material", async () => {
    const pool = { query: async (sql: string) => {
      if (sql.includes("character_persona_canon_links")) return { rows: [{ fragment_id: "f1", memory_id: "m1" }] };
      if (sql.includes("opod.characters")) return { rows: [{ id: "c1", display_name: "Synthetic", bio: "" }] };
      return { rows: [] };
    } } as unknown as Pool;
    const store = new PostgresPersonaStore(pool);
    await expect(store.get("c1")).rejects.toBeInstanceOf(PersonaContextIntegrityError);
    await expect(store.retrieveContext({ characterId: "c1", queryText: "x", queryEmbedding: [], topK: 4 }))
      .rejects.toBeInstanceOf(PersonaContextIntegrityError);
  });

  it("changes the context snapshot hash when only event-time metadata changes", () => {
    const base = { content: "입양했다", kind: "event", injection: "retrieved", recallKeys: ["담이"], occurredAt: null, occurredLabel: "2023-07", occurredPrecision: "month", sourceRefsSha256: null };
    expect(personaContextHash(base)).not.toBe(personaContextHash({ ...base, occurredLabel: "2023-08" }));
    expect(createHash("sha256").update(base.content).digest("hex"))
      .toBe(createHash("sha256").update(base.content).digest("hex"));
  });

  it("reads persisted fragment policy and canon routing without an external manifest", async () => {
    const { pool } = fakePool({
      "opod.characters": [{ id: "c1", display_name: "Synthetic", bio: "" }],
      "opod.character_personas": [{ id: "p1", title: "Mixed", content: "차분함.과거 사건.", fragments: [
        { id: "f1", ordinal: 0, content: "차분함.", kind: "behavior", injection: "always", recallKeys: [] },
        { id: "f2", ordinal: 1, content: "과거 사건.", kind: "lore", injection: "retrieved", recallKeys: ["과거"] },
      ] }],
      "opod.character_canon_memories": [{ id: "m1", type: "event", content: "지난 여행", reason: "authored", created_at: "t", updated_at: "t",
        kind: "event", injection: "retrieved", recall_keys: ["여행"] }],
    });
    const persona = await new PostgresPersonaStore(pool).get("c1");
    expect(persona?.blocks).toHaveLength(2);
    expect(persona?.blocks.map(b => b.storedFragmentId)).toEqual(["f1", "f2"]);
    expect(persona?.blocks[1]?.id).not.toBe("f2");
    expect(persona?.blocks[1]).toMatchObject({ content: "과거 사건.", kind: "lore", injection: "retrieved", recallKeys: ["과거"] });
    expect(persona?.canonMemories[0]).toMatchObject({ kind: "event", injection: "retrieved", recallKeys: ["여행"] });
  });

  it("rejects stale or incomplete persisted fragments instead of injecting the unsplit source", async () => {
    const { pool } = fakePool({
      "opod.characters": [{ id: "c1", display_name: "Synthetic", bio: "" }],
      "opod.character_personas": [{ id: "p1", title: "Mixed", content: "changed", fragments: [
        { ordinal: 0, content: "old", kind: "behavior", injection: "always", recallKeys: [] },
      ] }],
    });
    await expect(new PostgresPersonaStore(pool).get("c1")).rejects.toThrow(/fragment/i);
  });

  it("maps character, ordered blocks, and canon memories into a Persona", async () => {
    const { pool, calls } = fakePool({
      "opod.characters": [{ id: "c1", display_name: "한소이", bio: "필름 카메라로 계절을 줍는 사람" }],
      "opod.character_personas": [
        { id: "p1", title: "성격", content: "내향적 관찰자" },
        { id: "p2", title: "말투와 문체 가이드", content: "짧은 시적 문장" },
      ],
      "opod.character_canon_memories": [{
        id: "m1", type: "event", content: "2021년 12월 Canon AE-1을 샀다", reason: "Authored source reason.",
        created_at: "2026-07-01 00:00:00.123456+00", updated_at: "2026-07-02 00:00:00.654321+00",
      }],
    });

    const persona = await new PostgresPersonaStore(pool).get("c1");

    expect(persona).toEqual({
      characterId: "c1",
      name: "한소이",
      bio: "필름 카메라로 계절을 줍는 사람",
      blocks: [
        { id: "p1", title: "성격", content: "내향적 관찰자" },
        { id: "p2", title: "말투와 문체 가이드", content: "짧은 시적 문장" },
      ],
      canonMemories: [{
        id: "m1", type: "event", content: "2021년 12월 Canon AE-1을 샀다", reason: "Authored source reason.",
        createdAt: "2026-07-01 00:00:00.123456+00", updatedAt: "2026-07-02 00:00:00.654321+00",
      }],
    });

    // Blocks/memories are fetched for the resolved character and exclude soft-deleted rows.
    const blockCall = calls.find((c) => c.sql.includes("FROM opod.character_personas\n"));
    expect(blockCall?.params).toEqual(["c1"]);
    expect(blockCall?.sql).toContain("deleted_at IS NULL");
    expect(blockCall?.sql).toContain("sort_order ASC");
    expect(blockCall?.sql).toContain("SELECT id, title, content");
    const memoryCall = calls.find((c) => c.sql.includes("FROM opod.character_canon_memories\n"));
    expect(memoryCall?.params).toEqual(["c1"]);
    expect(memoryCall?.sql).toContain("SELECT id, authoring_category AS type, canon_text AS content");
    expect(memoryCall?.sql).toContain("created_at::text AS created_at");
    expect(memoryCall?.sql).toContain("updated_at::text AS updated_at");
    expect(memoryCall?.sql).toContain("deleted_at IS NULL");
    expect(memoryCall?.sql).toContain("ORDER BY character_canon_memories.created_at ASC, id ASC");
  });

  it("returns null when the character does not exist", async () => {
    const { pool, calls } = fakePool({ "opod.characters": [] });
    expect(await new PostgresPersonaStore(pool).get("missing")).toBeNull();
    // No follow-up queries for an unknown character.
    expect(calls).toHaveLength(1);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("preserves real DB source precision and order while excluding deleted and foreign canon", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const characterId = randomUUID();
      const foreignId = randomUUID();
      for (const id of [characterId, foreignId]) {
        await client.query("INSERT INTO opod.characters (id, public_id, display_name, bio, updated_at) VALUES ($1, $2, $3, '', now())", [id, `it-${id}`, "Synthetic character"]);
      }
      const rows = [
        { id: randomUUID(), characterId, content: "Later fact.", time: "2026-07-01 00:00:00.123457+00", deleted: false },
        { id: randomUUID(), characterId, content: "Earlier fact.", time: "2026-07-01 00:00:00.123456+00", deleted: false },
        { id: randomUUID(), characterId, content: "Deleted fact.", time: "2026-07-01 00:00:00+00", deleted: true },
        { id: randomUUID(), characterId: foreignId, content: "Foreign fact.", time: "2026-07-01 00:00:00+00", deleted: false },
      ];
      for (const row of rows) {
        await client.query(`INSERT INTO opod.character_canon_memories (id, character_id, canon_text, authoring_category, authoring_reason, created_at, updated_at, deleted_at)
          VALUES ($1, $2, $3, 'event', 'private source reason', $4::timestamptz, $4::timestamptz, CASE WHEN $5 THEN now() ELSE NULL END)`,
        [row.id, row.characterId, row.content, row.time, row.deleted]);
      }
      // Keep every read and fixture write on the same uncommitted connection.
      const persona = await new PostgresPersonaStore(client as unknown as Pool).get(characterId);
      expect(persona?.canonMemories).toEqual([rows[1], rows[0]].map((row) => ({
        id: row!.id, content: row!.content, type: "event", reason: "private source reason",
        createdAt: row!.time, updatedAt: row!.time,
      })));
      if (!persona) throw new Error("synthetic character missing");
      expect(assembleSystemPrompt({ persona })).toBe(assembleSystemPrompt({ persona: { ...persona, canonMemories: ["Earlier fact.", "Later fact."] } }));
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); await pool.end(); }
    }
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("rereads persisted fragment edits and excludes deleted or foreign source rows", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    const characterId = randomUUID();
    const foreignId = randomUUID();
    const sourceId = randomUUID();
    try {
      await client.query("BEGIN");
      for (const id of [characterId, foreignId]) await client.query(
        "INSERT INTO opod.characters(id,public_id,display_name,bio,updated_at) VALUES ($1,$2,'Synthetic','',now())", [id, `it-${id}`]);
      await client.query("INSERT INTO opod.character_personas(id,character_id,title,content,updated_at) VALUES ($1,$2,'Mixed','차분함.지난 여행.',now())", [sourceId, characterId]);
      for (const [ordinal, content, kind, injection, keys] of [
        [0, "차분함.", "behavior", "always", []], [1, "지난 여행.", "lore", "retrieved", ["여행"]],
      ]) await client.query(`INSERT INTO opod.character_persona_fragments(id,persona_id,ordinal,content,kind,injection,recall_keys,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), sourceId, ordinal, content, kind, injection, keys]);
      const store = new PostgresPersonaStore(client as unknown as Pool);
      expect((await store.get(characterId))?.blocks.map(b => b.content)).toEqual(["차분함.", "지난 여행."]);
      expect((await store.get(foreignId))?.blocks).toEqual([]);
      await client.query("UPDATE opod.character_persona_fragments SET kind='creator_note',injection='never_prompt' WHERE persona_id=$1 AND ordinal=1", [sourceId]);
      expect((await store.get(characterId))?.blocks[1]).toMatchObject({ kind: "creator_note", injection: "never_prompt" });
      await client.query("UPDATE opod.character_personas SET content='corrupted source' WHERE id=$1", [sourceId]);
      await expect(store.get(characterId)).rejects.toThrow(/fragment/);
      await client.query("UPDATE opod.character_personas SET deleted_at=now() WHERE id=$1", [sourceId]);
      expect((await store.get(characterId))?.blocks).toEqual([]);
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); await pool.end(); }
    }
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("injects one canon for multiple preserved source links and rejects invalid link policy", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const characterId = randomUUID();
      await client.query("INSERT INTO opod.characters(id,public_id,display_name,bio,updated_at) VALUES($1,$2,'Synthetic','',now())", [characterId, `it-${characterId}`]);
      const memoryId = randomUUID();
      await client.query(`INSERT INTO opod.character_canon_memories(id,character_id,canon_text,authoring_category,authoring_reason,temporal_kind,context_injection_mode,retrieval_keywords,updated_at,event_time_label,event_time_precision)
        VALUES($1,$2,'2023년 장마철에 담이를 입양했다.','event','private source','event','retrieved',ARRAY['담이'],now(),'2023-07','month')`, [memoryId, characterId]);
      const fragments: string[] = [];
      for (const content of ["담이와 산다.", "담이는 장마철에 만났다."]) {
        const personaId = randomUUID();
        const fragmentId = randomUUID();
        fragments.push(fragmentId);
        await client.query("INSERT INTO opod.character_personas(id,character_id,title,content,updated_at) VALUES($1,$2,'Source',$3,now())", [personaId, characterId, content]);
        await client.query(`INSERT INTO opod.character_persona_fragments(id,persona_id,ordinal,content,kind,injection,recall_keys,updated_at)
          VALUES($1,$2,0,$3,'lore','never_prompt',ARRAY['담이'],now())`, [fragmentId, personaId, content]);
        await client.query("INSERT INTO opod.character_persona_canon_links(fragment_id,memory_id) VALUES($1,$2)", [fragmentId, memoryId]);
      }
      const store = new PostgresPersonaStore(client as unknown as Pool);
      const context = await store.retrieveContext({ characterId, queryText: "담이", queryEmbedding: [], topK: 4 });
      expect(context.fragmentIds).toEqual([]);
      expect(context.canonIds).toEqual([memoryId]);
      const persona = await store.get(characterId);
      expect(persona?.blocks.map(block => block.content).sort()).toEqual(["담이는 장마철에 만났다.", "담이와 산다."].sort());
      expect(persona?.canonMemories).toHaveLength(1);
      await client.query("UPDATE opod.character_persona_fragments SET injection='retrieved' WHERE id=$1", [fragments[0]]);
      await expect(store.get(characterId)).rejects.toBeInstanceOf(PersonaContextIntegrityError);
      await expect(store.retrieveContext({ characterId, queryText: "담이", queryEmbedding: [], topK: 4 }))
        .rejects.toBeInstanceOf(PersonaContextIntegrityError);
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); await pool.end(); }
    }
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("preserves a PostgreSQL instant snapshot through retrieval and chat injection", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'Asia/Seoul'");
      const characterId = randomUUID();
      const memoryId = randomUUID();
      await client.query("INSERT INTO opod.characters(id,public_id,display_name,bio,updated_at) VALUES($1,$2,'Synthetic','',now())", [characterId, `it-${characterId}`]);
      await client.query(`INSERT INTO opod.character_canon_memories(id,character_id,canon_text,authoring_category,authoring_reason,temporal_kind,context_injection_mode,retrieval_keywords,updated_at,event_occurred_at,event_time_label,event_time_precision,source_references)
        VALUES($1,$2,'정확한 시각에 전시회를 열었다.','event','private source','event','retrieved',ARRAY['전시회'],now(),$3::timestamptz,'2025년 3월 1일 오후 2시','instant','[]'::jsonb)`,
      [memoryId, characterId, "2025-03-01T14:00:00+09:00"]);
      const store = new PostgresPersonaStore(client as unknown as Pool);
      const persona = await store.get(characterId);
      const memory = persona?.canonMemories[0];
      if (!memory || typeof memory === "string") throw new Error("instant canon missing");
      expect(memory.occurredAt).toMatch(/\+09$/);
      const selection = await store.retrieveContext({ characterId, queryText: "전시회", queryEmbedding: [], topK: 4 });
      expect(selection.canonIds).toEqual([memoryId]);
      expect(selection.contextHashes[memoryId]).toBe(personaContextHash({
        content: memory.content, kind: memory.kind ?? "", injection: memory.injection ?? "",
        recallKeys: memory.recallKeys ?? [], occurredAt: memory.occurredAt ?? null,
        occurredLabel: memory.occurredLabel ?? null, occurredPrecision: memory.occurredPrecision ?? null,
        sourceRefsSha256: memory.sourceRefsSha256 ?? null,
      }));
      const originalContentHash = selection.sourceHashes[memoryId];
      const originalContextHash = selection.contextHashes[memoryId];
      await client.query("UPDATE opod.character_canon_memories SET source_references=$2::jsonb WHERE id=$1", [memoryId, JSON.stringify([{ kind: "manual", quote: "approved source snapshot" }])]);
      const changedPersona = await store.get(characterId);
      const changedMemory = changedPersona?.canonMemories[0];
      if (!changedMemory || typeof changedMemory === "string") throw new Error("changed instant canon missing");
      const changedSelection = await store.retrieveContext({ characterId, queryText: "전시회", queryEmbedding: [], topK: 4 });
      expect(changedSelection.sourceHashes[memoryId]).toBe(originalContentHash);
      expect(changedSelection.contextHashes[memoryId]).not.toBe(originalContextHash);
      expect(changedMemory.sourceRefsSha256).not.toBe(memory.sourceRefsSha256);
      const chat = new ChatService(new FakeProvider(), store, new StubMemoryStore(), new StubJobQueue(), {
        retrieveTopK: 4, weights: { recency: 1, importance: 1, relevance: 1 }, recencyDecay: 0.99,
        summaryTurnThreshold: 6, integratedContext: true,
      });
      const prepared = await chat.prepare({ messages: [{ role: "user", content: "전시회" }] }, { characterId });
      expect(prepared.request.messages.at(-1)?.content).toContain("past event; time: 2025년 3월 1일 오후 2시 (instant)");
      expect(prepared.request.messages.at(-1)?.content).toContain("정확한 시각에 전시회를 열었다.");
      expect(JSON.stringify(prepared.request.messages)).not.toContain("approved source snapshot");
      expect(JSON.stringify(prepared.request.messages)).not.toContain("sourceRefs");
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); await pool.end(); }
    }
  });
});
