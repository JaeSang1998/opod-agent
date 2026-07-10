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
