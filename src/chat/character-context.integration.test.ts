import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { noopLogger } from "../bootstrap/logger.js";
import { ConsolidationService } from "../memory/consolidation.js";
import { PostgresMemoryStore } from "../memory/postgres-memory-store.js";
import { Reflector } from "../memory/reflection.js";
import { StubJobQueue } from "../memory/stub-job-queue.js";
import { PostgresPersonaStore } from "../persona/postgres-persona-store.js";
import type { ChatMessage } from "../protocol/index.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { ChatService } from "./chat-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const fixture = JSON.parse(readFileSync(new URL("../../evals/cases/character-context-integration.json", import.meta.url), "utf8")).scenarios[0] as {
  scriptedTurns: Array<{ message: string }>;
  memoryFixture: { records: Array<{ content: string; importance: number; kind: "observation" }> };
};
const config = { retrieveTopK: 4, weights: { recency: 0, importance: 0, relevance: 1 }, recencyDecay: 0.99, summaryTurnThreshold: 4 };
const clock = () => new Date("2026-09-11T06:00:00Z");

describe.skipIf(!databaseUrl)("integrated character context (real PostgreSQL, synthetic provider)", () => {
  it("compares baseline selection with grounded retrieval, then persists and reloads raw evidence idempotently", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const userId = `context-it-${randomUUID()}`;
    const foreignUserId = `context-it-${randomUUID()}`;
    const characterId = randomUUID();
    const foreignCharacterId = randomUUID();
    const key = { userId, characterId, sessionId: randomUUID(), historyOffset: 0, turnId: randomUUID() };
    const ownUsers = [userId, foreignUserId];
    const ownCharacters = [characterId, foreignCharacterId];
    const firstUserText = fixture.scriptedTurns[0]!.message;
    const history: ChatMessage[] = [
      { role: "user", content: firstUserText },
      { role: "assistant", content: "부산에 갈 준비 중이구나." },
      { role: "user", content: fixture.scriptedTurns[1]!.message },
    ];
    const fact = "사용자는 부산 여행 준비 중이라고 말했다.";
    const reply = "응, 기억할게.";
    const provider = new FakeProvider(reply, JSON.stringify([
      { content: fact, importance: 5, memoryType: "user_fact", sourceIndices: [0] },
    ]));
    // Deterministic summary of this fixture only; no remote provider is constructed.
    const chat = provider.chat.bind(provider);
    provider.chat = async (request) => {
      const response = await chat(request);
      if (String(request.messages[0]?.content).includes("running summary")) response.choices[0]!.message.content = fact;
      return response;
    };
    try {
      for (const id of ownCharacters) await pool.query(
        "INSERT INTO opod.characters(id,public_id,display_name,bio,updated_at) VALUES($1,$2,'Synthetic','',now())",
        [id, `context-${id}`],
      );
      const lore = "부산에서는 느린 산책을 좋아한다.";
      const sourceId = randomUUID();
      await pool.query("INSERT INTO opod.character_personas(id,character_id,title,content,updated_at) VALUES($1,$2,'성격과 배경',$3,now())", [sourceId, characterId, `차분하게 반응한다.${lore}`]);
      for (const [ordinal, content, kind, injection] of [[0, "차분하게 반응한다.", "behavior", "always"], [1, lore, "lore", "retrieved"]]) {
        await pool.query("INSERT INTO opod.character_persona_fragments(id,persona_id,ordinal,content,kind,injection,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())", [randomUUID(), sourceId, ordinal, content, kind, injection]);
      }
      const past = "2021년 부산 바다를 방문했다.";
      for (const [owner, content] of [[characterId, past], [foreignCharacterId, "부산 비밀 표식은 외부캐릭터다."]]) {
        await pool.query("INSERT INTO opod.character_canon_memories(id,character_id,canon_text,authoring_category,authoring_reason,temporal_kind,context_injection_mode,updated_at) VALUES($1,$2,$3,'event','synthetic','event','retrieved',now())", [randomUUID(), owner, content]);
      }
      const store = new PostgresMemoryStore(pool);
      await store.upsertMany(key, fixture.memoryFixture.records.map(record => ({ ...record, embedding: [] })));
      await store.upsertMany({ userId: foreignUserId, characterId }, [{ content: "부산 비밀 표식은 외부사용자다.", kind: "observation", importance: 10, embedding: [] }]);
      await store.upsertMany({ userId, characterId: foreignCharacterId }, [{ content: "부산 비밀 표식은 외부관계다.", kind: "observation", importance: 10, embedding: [] }]);
      const personas = new PostgresPersonaStore(pool);
      const queue = new StubJobQueue();
      const baseline = await new ChatService(provider, personas, store, new StubJobQueue(), config, noopLogger, [], clock).prepare({ messages: history }, key);
      const prepared = await new ChatService(provider, personas, store, queue, { ...config, integratedContext: true, contextMaxBytes: 32_000 }, noopLogger, [], clock).prepare({ messages: history }, key);
      const baselineText = JSON.stringify(baseline.request.messages);
      const text = JSON.stringify(prepared.request.messages);
      expect(baselineText).not.toContain(lore);
      expect(baselineText).not.toContain(past);
      expect(text).toContain(lore);
      expect(text).toContain(past);
      expect(text).toContain("Past events are not current activity");
      expect(text).toContain(fixture.memoryFixture.records[0]!.content);
      for (const excluded of [fixture.memoryFixture.records[1]!.content, "외부캐릭터", "외부사용자", "외부관계"]) expect(text).not.toContain(excluded);
      expect(prepared.request.messages.slice(1, -1)).toEqual(history.slice(0, -1));
      expect(String(prepared.request.messages.at(-1)?.content)).toMatch(/그거 기억해 줘\.$/u);
      expect(prepared.promptDebug?.characterRetrieval?.semanticStatus).toBe("query_unavailable");
      expect(prepared.promptDebug?.contextBudget?.status).toBe("within_budget");
      const completion = await provider.chat({ ...prepared.request, stream: false });
      expect(completion.choices[0]?.message.content).toBe(reply);
      await prepared.postTurn(reply);
      expect(queue.enqueued).toHaveLength(1);
      const job = queue.enqueued[0]!;
      expect(job.turns).toEqual([...history, { role: "assistant", content: reply }]);
      expect(JSON.stringify(job.turns)).not.toContain("<context>");
      const reflector = new Reflector(provider, store, { ...config, recentN: 10, questionsPerPass: 1, reflectionsPerQuestion: 1, reflectionImportance: 5, coreCharLimit: 1000 });
      const consolidation = new ConsolidationService(provider, store, reflector, { reflectionThreshold: 1000, integratedContext: true });
      expect(await consolidation.consolidate(job)).toMatchObject({ observationsStored: 1, summaryUpdated: true, reflected: false });
      const beforeRetry = await store.getRelationshipState(key);
      await consolidation.consolidate(job);
      expect((await store.getRelationshipState(key)).importanceSinceReflection).toBe(beforeRetry.importanceSinceReflection);
      const reloadedPool = new Pool({ connectionString: databaseUrl });
      try {
        const reloaded = new PostgresMemoryStore(reloadedPool);
        const learned = (await reloaded.recentObservations(key, 10)).filter(memory => memory.content === fact);
        expect(learned).toHaveLength(1);
        expect(learned[0]).toMatchObject({ memoryType: "user_fact", sourceSessionId: key.sessionId,
          sourceMessages: [{ role: "user", content: firstUserText, position: 0, sha256: hash(firstUserText) }] });
        expect(learned[0]?.occurredAt).toBeUndefined();
        expect(await reloaded.getSummary(key)).toMatchObject({ content: fact, turnsCovered: 4, revision: 1 });
        const next = await new ChatService(provider, new PostgresPersonaStore(reloadedPool), reloaded, new StubJobQueue(), { ...config, integratedContext: true, contextMaxBytes: 32_000 }).prepare({ messages: [{ role: "user", content: "부산 준비 얘기 기억나?" }] }, { ...key, sessionId: randomUUID(), turnId: randomUUID() });
        expect(JSON.stringify(next.request.messages)).toContain(fact);
        expect(JSON.stringify(next.request.messages)).toContain(hash(firstUserText));
        const topicCut = await new ChatService(provider, new PostgresPersonaStore(reloadedPool), reloaded, new StubJobQueue(), { ...config, integratedContext: true, contextMaxBytes: 32_000 }).prepare({ messages: [
          ...history, { role: "assistant", content: reply },
          { role: "user", content: fixture.scriptedTurns[4]!.message },
        ] }, { ...key, sessionId: randomUUID(), turnId: randomUUID() });
        const cutContext = String(topicCut.request.messages.at(-1)?.content);
        for (const excluded of [lore, past, fact, fixture.memoryFixture.records[0]!.content]) expect(cutContext).not.toContain(excluded);
        expect(topicCut.promptDebug?.retrievedMemoryCount).toBe(0);
      } finally { await reloadedPool.end(); }
    } finally {
      // Store transactions must commit for the reload test. Undo only this test's generated IDs.
      try {
        for (const table of ["chat_memory_entries", "chat_relationship_states", "chat_memory_session_summaries", "chat_applied_state_changes"]) await pool.query(`DELETE FROM opod.${table} WHERE user_id = ANY($1::text[])`, [ownUsers]);
        await pool.query("DELETE FROM opod.characters WHERE id = ANY($1::uuid[])", [ownCharacters]);
      } finally { await pool.end(); }
    }
  });
});
