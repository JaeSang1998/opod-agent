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
| `X-Opod-User-Id` | whose Long-term Memory (relationship-scoped) |
| `X-Opod-Session-Id` | which conversation Summary |

Supports `stream: true` (OpenAI SSE chunks) and non-streaming JSON. After each turn the Agent
autonomously decides whether to enqueue a memory-update job.

```bash
curl localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'X-Opod-Character-Id: luna' -H 'X-Opod-User-Id: u1' -H 'X-Opod-Session-Id: s1' \
  -d '{"messages":[{"role":"user","content":"My cat is named Nova."}]}'
```

### `POST /memory/consolidate`

Called by `opod-worker`'s **memory-update** job (async). Extracts Long-term Memory and optionally
refreshes the session Summary.

```json
{ "userId": "u1", "characterId": "luna", "sessionId": "s1",
  "turns": [{ "role": "user", "content": "..." }], "refreshSummary": true }
```

### `GET /healthz`

## Architecture in one breath

```
opod-worker ──HTTP──▶ opod-agent /v1/chat/completions
                          │  1. load published Persona   (PersonaStore)
                          │  2. retrieve Long-term Memory (MemoryStore + pgvector)
                          │  3. + rolling Summary
                          │  4. assemble system prompt
                          │  5. call LLMProvider (OpenAI / Ollama)
                          │  6. autonomously judge → enqueue memory-update job
                          ▼
                       reply (JSON or SSE)

opod-worker ──(memory-update job)──▶ opod-agent /memory/consolidate  (async, row-locked)
```

## Persistence

Persona / Memory / Job-queue access sits behind `PersonaStore`, `MemoryStore`, and `JobQueue`
interfaces. `STORE_DRIVER=stub` (default) uses in-memory implementations so the full path runs
today; the **Postgres + pgvector** adapters land once the shared schema is confirmed
(see [ADR-0002](./docs/adr/0002-store-abstraction-direct-postgres-pgvector.md)).

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | watch-mode server (tsx) |
| `npm run build` | compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest |
