import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresPersonaStore } from "./postgres-persona-store.js";

/** Minimal fake capturing queries and returning canned rows per table. */
function fakePool(rowsByTable: Record<string, unknown[]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const table = Object.keys(rowsByTable).find((t) => sql.includes(t));
      return { rows: table ? rowsByTable[table] : [] };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

describe("PostgresPersonaStore", () => {
  it("maps character, ordered blocks, and canon memories into a Persona", async () => {
    const { pool, calls } = fakePool({
      "opod.characters": [{ id: "c1", display_name: "한소이", bio: "필름 카메라로 계절을 줍는 사람" }],
      "opod.character_personas": [
        { title: "성격", content: "내향적 관찰자" },
        { title: "말투와 문체 가이드", content: "짧은 시적 문장" },
      ],
      "opod.character_memories": [{ content: "2021년 12월 Canon AE-1을 샀다" }],
    });

    const persona = await new PostgresPersonaStore(pool).get("c1");

    expect(persona).toEqual({
      characterId: "c1",
      name: "한소이",
      bio: "필름 카메라로 계절을 줍는 사람",
      blocks: [
        { title: "성격", content: "내향적 관찰자" },
        { title: "말투와 문체 가이드", content: "짧은 시적 문장" },
      ],
      canonMemories: ["2021년 12월 Canon AE-1을 샀다"],
    });

    // Blocks/memories are fetched for the resolved character and exclude soft-deleted rows.
    const blockCall = calls.find((c) => c.sql.includes("character_personas"));
    expect(blockCall?.params).toEqual(["c1"]);
    expect(blockCall?.sql).toContain("deleted_at IS NULL");
    expect(blockCall?.sql).toContain("sort_order ASC");
  });

  it("returns null when the character does not exist", async () => {
    const { pool, calls } = fakePool({ "opod.characters": [] });
    expect(await new PostgresPersonaStore(pool).get("missing")).toBeNull();
    // No follow-up queries for an unknown character.
    expect(calls).toHaveLength(1);
  });
});
