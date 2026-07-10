# opod-agent — Implementation Plan (MVP)

Derived from the decisions in `CONTEXT.md` and `docs/adr/`. Stub-first: the Store interfaces ship with
in-memory implementations so the full chat path runs before the Postgres/pgvector schema is settled.

## Module structure

```
src/
├── index.ts                      # bootstrap: load config, start Hono server
├── config/
│   └── env.ts                    # zod-validated env (LLM_*, EMBEDDING_MODEL, PG_*, thresholds)
├── http/
│   ├── app.ts                    # Hono app: mounts routes + middleware
│   ├── middleware/context.ts     # parse X-Opod-{Character,User,Session}-Id → RequestContext (optional)
│   └── routes/
│       ├── chat.ts               # POST /v1/chat/completions   (stream + non-stream)
│       ├── consolidate.ts        # POST /memory/consolidate    (called by worker's memory-update job)
│       └── health.ts             # GET /healthz
├── openai/
│   └── types.ts                  # zod schemas for OpenAI ChatCompletion request/response + SSE chunk
├── provider/
│   ├── LLMProvider.ts            # interface: chat(), chatStream(), embed()
│   └── OpenAICompatProvider.ts   # `openai` SDK; baseURL/model/apiKey + embeddingModel from env
├── persona/
│   ├── Persona.ts                # structured character-card type + zod
│   ├── PersonaStore.ts           # interface: getPublished(characterId)
│   └── stub/StubPersonaStore.ts  # seeded in-memory personas
├── memory/
│   ├── types.ts                  # LongTermMemory, Summary
│   ├── MemoryStore.ts            # interface: retrieve(), upsertMany(), getSummary(), saveSummary()
│   ├── stub/StubMemoryStore.ts   # in-memory; naive similarity for retrieval
│   └── consolidation.ts          # extract facts + refresh summary (uses LLMProvider)
├── queue/
│   ├── JobQueue.ts               # interface: enqueueMemoryUpdate(job)
│   └── stub/StubJobQueue.ts      # in-memory (dev: optionally invoke consolidate inline)
├── prompt/
│   └── assemble.ts               # system prompt = persona + retrieved memory + summary
└── core/
    ├── chatService.ts            # orchestrates a turn (load → retrieve → assemble → provider → judge)
    └── consolidationDecider.ts   # autonomous "should we consolidate this turn?" judgment
```

## Key interfaces (shape, not final)

- `LLMProvider`: `chat(req) → ChatCompletion`, `chatStream(req) → AsyncIterable<Chunk>`, `embed(texts) → number[][]`.
- `PersonaStore`: `getPublished(characterId) → Persona | null`.
- `MemoryStore`: `retrieve(userId, characterId, queryEmbedding, k) → LongTermMemory[]`,
  `upsertMany(userId, characterId, memories) → void`, `getSummary(sessionId) → Summary | null`,
  `saveSummary(sessionId, summary) → void`.
- `JobQueue`: `enqueueMemoryUpdate({ userId, characterId, sessionId, turns }) → void`.

## Build order (each step leaves something runnable/testable)

1. **Scaffold** — package.json, tsconfig, `.env.example`, `config/env.ts`, `/healthz`, server bootstrap.
2. **Provider** — `LLMProvider` + `OpenAICompatProvider`; smoke-test against OpenAI and Ollama `/v1`.
3. **Context middleware** — parse `X-Opod-*` headers into an optional `RequestContext`.
4. **Persona** — type + `PersonaStore` + `StubPersonaStore` (one seed character).
5. **Prompt assembly** — `prompt/assemble.ts` (persona-only first).
6. **Chat (non-stream)** — `chatService` wires persona + provider; `POST /v1/chat/completions` returns
   OpenAI JSON; no headers ⇒ plain proxy (graceful degrade). *End-to-end milestone.*
7. **Memory retrieval** — `MemoryStore` + `StubMemoryStore`; inject long-term memory + summary into prompt.
8. **Streaming** — honor `stream:true` with OpenAI SSE chunks.
9. **Consolidation** — `consolidationDecider` + `consolidation.ts` + `POST /memory/consolidate` +
   `JobQueue`/`StubJobQueue`; agent enqueues a memory-update job when it judges one is warranted.
10. **Tests** (vitest) alongside: header parsing, prompt assembly, consolidation decider, provider (mocked).

## Deferred (post-MVP / needs input)

- **Postgres/pgvector adapters** for the three Stores — blocked on schema decision (existing in
  service-backend vs new migration here).
- Tool/function-calling passthrough, per-character model override, moderation.
```
