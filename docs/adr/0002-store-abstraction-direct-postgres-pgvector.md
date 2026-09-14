# Persona/Memory via Store interfaces, default to direct Postgres + pgvector

## Context

`opod-service-backend` is the canonical schema owner, yet the Agent needs to load Personas and
read/write Memory (including pgvector embeddings). Reaching into that database from a second service is
a boundary decision worth recording, since a future reader will reasonably ask why the Agent talks to
Postgres directly instead of going through service-backend's API.

## Decision

The Agent defines `PersonaStore` / `MemoryStore` (and a job-queue) interfaces. The default
implementations connect directly to the existing Postgres + pgvector — matching the pattern
`opod-worker` already uses (direct Postgres with row-locking). service-backend remains schema owner.

## Considered options

- **Access via service-backend HTTP API** — strictest ownership boundary, but requires new persona/memory
  endpoints and adds latency; rejected for MVP.
- **Stateless Agent, caller injects persona+memory** — simplest, but moves the persona/memory *features*
  out of the Agent, which contradicts the product goal.

## Consequences

The Store seam keeps schema coupling swappable (a later move to service-backend's API, or Redis, is an
implementation change, not a rewrite). The trade-off is that two services now know the memory/persona
schema, so schema changes must be coordinated.

## Build sequencing

The direct Postgres + pgvector adapter is the intended production default, but the concrete DB schema
(whether it already exists in service-backend or is new) is not yet decided. Scaffolding therefore
starts against in-memory **stub** implementations of the Store interfaces so the end-to-end chat path
is exercisable; the Postgres adapter lands once the schema is confirmed.

## Resolution (2026-07-20)

The persona schema question is settled: there is no separate Agent-side persona
schema. The Agent reads the OPOD rows as-is — `characters` +
`character_personas` (ordered free-text blocks) + `character_canon_memories` (canon)
— via the built-in `PostgresPersonaStore`, wired whenever `DATABASE_URL` is
set. Blocks are the single source of truth shared with the content pipeline;
active rows are the serving truth (no publish state). Memory/queue remain on
stubs until their pgvector adapters land.

## P1 routing addendum (2026-09-07)

`PostgresPersonaStore` remains the raw-content adapter and now also returns each block's stable row ID.
ADR 0008 adds an optional DDL-free read decorator and a shared prompt router after this boundary. The
router decides whether a block is stable, turn-scoped, retrieval-gated, or excluded; it does not alter
the authored content. Without an explicit manifest, the legacy serving behavior is preserved.
