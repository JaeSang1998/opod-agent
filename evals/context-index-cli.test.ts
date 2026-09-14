import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertContextIndexDatabase, persistContextEmbedding } from "./context-index-cli.js";

describe("context index execution boundary", () => {
  it("rejects development/other local databases and connection-option redirects", () => {
    for (const url of ["postgres://u@dev.example:55433/opod_persona_memory_local",
      "postgres://u@127.0.0.1:5433/opod_persona_memory_local", "postgres://u@127.0.0.1:55433/other",
      "postgres://u@127.0.0.1:55433/opod_persona_memory_local?host=dev.example"]) {
      expect(() => assertContextIndexDatabase(url)).toThrow(/dedicated/);
    }
    expect(() => assertContextIndexDatabase("postgres://u@127.0.0.1:55433/opod_persona_memory_local")).not.toThrow();
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("only indexes unchanged live sources belonging to the snapshot character", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const characterId = randomUUID();
      const memoryId = randomUUID();
      const sourceId = randomUUID();
      const fragmentId = randomUUID();
      const content = "합성 배경";
      const hash = createHash("sha256").update(content).digest("hex");
      const vector = [1, ...Array(1023).fill(0)];
      await client.query("INSERT INTO opod.characters(id,public_id,display_name,bio,updated_at) VALUES($1,$2,'Synthetic','',now())", [characterId, `it-${characterId}`]);
      await client.query("INSERT INTO opod.character_memories(id,character_id,content,type,reason,kind,injection,updated_at) VALUES($1,$2,$3,'fact','synthetic','fact','retrieved',now())", [memoryId, characterId, content]);
      await client.query("INSERT INTO opod.character_personas(id,character_id,title,content,updated_at) VALUES($1,$2,'Background',$3,now())", [sourceId, characterId, content]);
      await client.query("INSERT INTO opod.character_persona_fragments(id,persona_id,ordinal,content,kind,injection,updated_at) VALUES($1,$2,0,$3,'lore','retrieved',now())", [fragmentId, sourceId, content]);
      const db = client as unknown as Pool;
      const canon = { id: memoryId, character_id: characterId, source_type: "canon" as const, content, source_hash: hash };
      const fragment = { ...canon, id: fragmentId, source_type: "fragment" as const };
      expect(await persistContextEmbedding(db, canon, vector, "synthetic")).toBe(true);
      expect(await persistContextEmbedding(db, fragment, vector, "synthetic")).toBe(true);
      expect(await persistContextEmbedding(db, { ...canon, character_id: randomUUID() }, vector, "synthetic")).toBe(false);
      await client.query("UPDATE opod.character_memories SET content='변경된 기억' WHERE id=$1", [memoryId]);
      expect(await persistContextEmbedding(db, canon, vector, "stale-model")).toBe(false);
      await client.query("UPDATE opod.character_personas SET deleted_at=now() WHERE id=$1", [sourceId]);
      expect(await persistContextEmbedding(db, fragment, vector, "stale-model")).toBe(false);
      expect((await client.query("SELECT embedding_model FROM opod.character_memories WHERE id=$1", [memoryId])).rows[0]?.embedding_model).toBe("synthetic");
      await expect(persistContextEmbedding(db, canon, [1, 0], "bad-dimension")).rejects.toThrow(/1024/);
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); await pool.end(); }
    }
  });
});
