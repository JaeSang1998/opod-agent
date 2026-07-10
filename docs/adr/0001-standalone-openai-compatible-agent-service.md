# Standalone OpenAI-compatible Agent service, called by opod-worker

## Status

accepted

## Context

The existing architecture already assigns "chat replies" and "memory updates" to `opod-worker`, so a
new character-chat capability could plausibly live as a library inside the worker or replace the
worker's chat path entirely. We instead build the Agent as its own TypeScript HTTP service that
exposes an OpenAI-compatible chat API, and `opod-worker` calls it the same way it would call OpenAI.

## Decision

The Agent is a separate deployable service. It owns persona + memory assembly and provider routing;
`opod-service-backend` keeps DB ownership, credits, and SSE; `opod-worker` remains the caller/queue.

## Considered options

- **Embedded library in opod-worker** — simplest deploy, no network hop, but weakens the "OpenAI-compatible
  interface" goal and makes the capability hard for other services to reuse.
- **Replace the worker's chat/memory path** — large blast radius on a working system.

## Consequences

Being a drop-in for "an OpenAI endpoint" is the core contract: anything that can call OpenAI can call
the Agent. The cost is one extra network hop and a new service to operate.
