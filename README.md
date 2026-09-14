# opod-agent

Character-chat AI Agent service for OPOD. A standalone TypeScript HTTP service that speaks the
**OpenAI Chat Completions API**, and enriches each turn with a dynamically loaded **Persona** and
layered **Memory** before calling an underlying LLM provider (OpenAI *or* a local one like Ollama).

`opod-worker` calls it the same way it would call OpenAI. See [`CONTEXT.md`](./CONTEXT.md) for the
glossary and [`docs/adr/`](./docs/adr/) for the decisions behind the design.

## Quick start

```bash
npm install
cp .env.example .env      # fill in LLM_API_KEY (OpenAI) or point at Ollama
npm run dev               # http://localhost:8787
```

The pinned 1024-dimensional Qwen embedding service also has a CPU deployment image:

```bash
docker build -f docker/Dockerfile.embedding -t opod-qwen-embedding .
docker run --rm -e QWEN_API_KEY=replace-with-a-long-random-token opod-qwen-embedding
```

Keep port 8788 private to the application network in shared environments. Set
`QWEN_HOST=127.0.0.1` for a host-local process; the container defaults to `0.0.0.0`
so sibling containers can reach it. The image pins the model revision and serves
`Qwen/Qwen3-Embedding-0.6B` with 1024 dimensions.

Point at **OpenAI**:

```
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
```

Point at **Ollama** (local) — same adapter, just a different base URL:

```
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.1
LLM_API_KEY=ollama
EMBEDDING_MODEL=nomic-embed-text
```

## API

### `POST /v1/chat/completions`

Standard OpenAI request body. Character/user/session ride in **headers** so the body stays 100%
OpenAI-compatible (missing headers ⇒ plain proxy, no persona/memory):

| Header | Meaning |
| --- | --- |
| `X-Opod-Character-Id` | which Persona to load |
| `X-Opod-User-Id` | whose Archival Memory (relationship-scoped) |
| `X-Opod-Session-Id` | which conversation Summary within that relationship |
| `X-Opod-Turn-Id` | logical user-turn id; required with full identity, stable across retries |
| `X-Opod-History-Offset` | user/assistant turns omitted before `messages` (default `0`) |
| `X-Opod-Timezone` | optional IANA timezone for time grounding |
| `X-Opod-Debug` | opt in to interleaved `event: opod` tool-activity SSE frames |
| `X-Request-Id` | optional caller correlation id; generated and echoed when absent |

Supports `stream: true` (OpenAI SSE chunks) and non-streaming JSON. After each turn the Agent
autonomously decides whether to enqueue a memory-update job.

```bash
curl localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'X-Opod-Character-Id: luna' -H 'X-Opod-User-Id: u1' -H 'X-Opod-Session-Id: s1' \
  -H 'X-Opod-Turn-Id: turn-01' -H 'X-Opod-History-Offset: 0' \
  -d '{"messages":[{"role":"user","content":"My cat is named Nova."}]}'
```

Reuse `X-Opod-Turn-Id` only when retrying the same logical turn; generate a new value for the next
user turn. A caller that truncates old messages sets `X-Opod-History-Offset` to the absolute count of
omitted user/assistant turns. This lets the Agent compare the retained window with the Summary
watermark without inferring occurrence identity from message text.

### `POST /memory/consolidate`

Called by `opod-worker`'s **memory-update** job (async). Extracts Archival Memory and optionally
refreshes the session Summary.

```json
{
  "characterId": "luna",
  "correlationId": "trace-01",
  "idempotencyKey": "worker-job-01",
  "reason": "manual",
  "refreshSummary": true,
  "sessionId": "s1",
  "turns": [{ "role": "user", "content": "..." }],
  "userId": "u1"
}
```

Set `OPOD_WORKER_TOKEN` (16+ characters) to require the worker to send
`Authorization: Bearer …`. Each request is bounded by `LLM_REQUEST_TIMEOUT_MS`, propagates client
cancellation to Provider/tool calls, and returns its correlation id in `X-Request-Id`.

### `GET /healthz`

## Architecture in one breath

```
opod-worker ──HTTP──▶ opod-agent /v1/chat/completions
                          │  1. load published Persona   (PersonaStore)
                          │  2. retrieve Archival Memory (MemoryStore)
                          │  3. + rolling Summary
                          │  4. assemble the cached system prompt (character only)
                          │     + a per-turn context block at the tail (ADR 0007)
                          │  5. call LLMProvider (OpenAI / Ollama)
                          │  6. strip the closing Bond tag → move the Bond
                          │  7. autonomously judge → enqueue memory-update job
                          ▼
                       reply (JSON or SSE)

opod-worker ──(memory-update job)──▶ opod-agent /memory/consolidate  (async, row-locked)
```

## Persistence

Persona / Memory / Job-queue access sits behind `PersonaStore`, `MemoryStore`, and `JobQueue`
interfaces. `DATABASE_URL` automatically enables the built-in Postgres persona,
memory, and queue implementations; DB-less tests use in-memory stores.

When pgvector is installed in PostgreSQL's `public` schema, keep both application and extension
schemas in the connection search path (for example, `options=-c search_path=opod,public`). Semantic
retrieval uses pgvector operators and falls back to lexical retrieval if those operators are not
resolvable.

## Connecting another LLM Provider or database

All environment-specific construction is concentrated in `src/bootstrap/`. The normal `npm run dev`
and `npm start` entrypoints can load a deployment-owned module, so connecting a database does not
require a second application entrypoint:

```env
DATABASE_URL=postgres://user:pass@localhost:5432/opod
OPOD_ADAPTER_MODULE=./deployment/adapters.js
OPOD_WORKER_TOKEN=replace-with-a-long-random-token
```

That module exports a factory. It receives the fully validated environment, including
`DATABASE_URL`, and returns any Provider/Store/queue overrides:

```ts
export async function createAdapters(env) {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  return {
    provider: new MyProvider(providerClient),
    personas: new PostgresPersonaStore(pool),
    memory: new PostgresMemoryStore(pool),
    queue: new PostgresJobQueue(pool),
  };
}
```

`OPOD_ADAPTER_MODULE` accepts a package name, absolute path, or path relative to the process working
directory. The built-in executable supplies the OpenAI-compatible Provider and in-memory adapters.
Any non-`stub` store driver must return all three persistence adapters; startup fails instead of
silently falling back to volatile memory. A `MemoryStore` adapter must preserve the relationship +
session Summary key and atomically implement its revision/idempotency guard.

## Playground

The canonical local UI is the Next.js app in [`web/`](./web/). It has one outbound backend seam
(`web/backend/opod.ts`), validates requests against shared contracts from `src/protocol/`, preserves
request cancellation/correlation, and can point at any opod-agent deployment through `OPOD_URL`.

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | watch-mode server (tsx) |
| `npm run build` | compile to `dist/` |
| `npm run build:web` | production-build the canonical Next.js playground |
| `npm run lint` | Biome static analysis |
| `npm run dead-code` | Knip dead file/export/dependency analysis |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | root Vitest suite |
| `npm run test:coverage` | root suite with enforced 90% line / 80% branch floor |
| `npm run typecheck:web` | strict Next.js playground typecheck |
| `npm run test:web` | playground route/SSE/contract/IME tests with enforced coverage floors |
| `npm run eval:validate` | validate the eight H30 long-conversation fixtures without model calls |
| `npm run eval:smoke` | run a short two-scenario connectivity check (not an H30 certificate) |
| `npm run eval:long` | run the full 8 × 24-exchange H30 suite with LLM judging |
| `npm run eval:confidence` | repeat every H30 scenario three times and gate release on per-scenario variance |
| `npm run eval:harbor:validate` | validate the local task against pinned Harbor 0.20.0 |
| `npm run test:eval:coverage` | run H30 contract tests with false-certificate coverage floors |
| `npm run check` | full local quality gate used by CI |

The operational definition, scoring gates, scenarios, ATIF artifacts, and Harbor wrapper are documented
in [docs/long-conversation-eval.md](./docs/long-conversation-eval.md) and [evals/README.md](./evals/README.md).
