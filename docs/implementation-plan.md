# opod-agent — Implementation Plan (MVP)

Derived from the decisions in `CONTEXT.md` and `docs/adr/`. Stub-first: the Store interfaces ship with
in-memory implementations so the full chat path runs before the Postgres/pgvector schema is settled.

## Module structure

```
src/
├── index.ts                      # load config and start the Hono server
├── bootstrap/
│   ├── env.ts                    # zod-validated runtime configuration
│   ├── logger.ts                 # runtime logging adapter
│   └── container.ts              # composition root + injectable external adapters
├── chat/
│   ├── chat-service.ts           # one turn: persona + memory + prompt + consolidation enqueue
│   ├── system-prompt.ts          # prompt assembly
│   └── http-route.ts             # POST /v1/chat/completions
├── http/
│   ├── app.ts                    # mount domain routes and shared middleware
│   ├── context.ts                # X-Opod-* headers → ChatContext
│   ├── request-lifecycle.ts      # cancellation, deadlines, safe error mapping
│   └── health.ts                 # GET /healthz
├── protocol/                     # shared chat/consolidation/header wire contracts
├── openai/messages.ts            # text extraction/transcript helpers
├── provider/
│   ├── llm-provider.ts           # interface: chat(), chatStream(), embed()
│   └── openai-compat-provider.ts # `openai` SDK; baseURL/model/apiKey + embeddingModel from env
├── persona/
│   ├── persona.ts                # structured character-card type + zod
│   ├── persona-store.ts          # interface: getPublished(characterId)
│   └── stub-persona-store.ts     # seeded in-memory personas
├── memory/
│   ├── types.ts                  # Archival/Core/Summary model and relationship/session keys
│   ├── memory-store.ts           # persistence interface
│   ├── stub-memory-store.ts      # in-memory adapter
│   ├── retrieval.ts/vector.ts    # weighted retrieval
│   ├── consolidation.ts          # Observation extraction + Summary refresh
│   ├── reflection.ts/parsing.ts  # autonomous Reflection and tolerant LLM parsing
│   ├── job-queue.ts              # memory-update producer interface
│   ├── stub-job-queue.ts         # in-memory queue adapter
│   └── http-route.ts             # POST /memory/consolidate
└── testing/
    └── fake-provider.ts          # deterministic test adapter, excluded from production build
```

## Key interfaces (shape, not final)

- `LLMProvider`: `chat(req) → ChatCompletion`, `chatStream(req) → AsyncIterable<Chunk>`, `embed(texts) → number[][]`.
- `PersonaStore`: `getPublished(characterId) → Persona | null`.
- `MemoryStore`: relationship-scoped Archival/Core operations plus Summary operations keyed by
  `(userId, characterId, sessionId)`.
- `JobQueue`: `enqueueMemoryUpdate({ userId, characterId, sessionId, turns }) → void`.

## Build order (each step leaves something runnable/testable)

1. **Scaffold** — package.json, tsconfig, `.env.example`, `bootstrap/env.ts`, `/healthz`, server bootstrap.
2. **Provider** — `LLMProvider` + `OpenAICompatProvider`; smoke-test against OpenAI and Ollama `/v1`.
3. **Context middleware** — parse `X-Opod-*` headers into an optional `RequestContext`.
4. **Persona** — type + `PersonaStore` + `StubPersonaStore` (one seed character).
5. **Prompt assembly** — `chat/system-prompt.ts` (persona-only first).
6. **Chat (non-stream)** — `chat-service` wires persona + provider; `POST /v1/chat/completions` returns
   OpenAI JSON; no headers ⇒ plain proxy (graceful degrade). *End-to-end milestone.*
7. **Memory retrieval** — `MemoryStore` + `StubMemoryStore`; inject Archival Memory + Summary into prompt.
8. **Streaming** — honor `stream:true` with OpenAI SSE chunks.
9. **Consolidation** — a domain policy enqueues memorable or Summary-stale uncovered turns;
   `consolidation.ts` performs staged, retry-safe learning off the hot path through `JobQueue`.
10. **Tests** (vitest) alongside: header parsing, prompt assembly, consolidation decider, provider (mocked).

## Deferred (post-MVP / needs input)

- **Postgres/pgvector adapters** for the three Stores — blocked on schema decision (existing in
  service-backend vs new migration here).
- Per-character model override and moderation.
```
