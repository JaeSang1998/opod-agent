# Agent judges consolidation autonomously, then enqueues to the existing queue

## Context

Extracting Long-term Memory and refreshing the Summary are extra LLM calls that must not delay the chat
reply. The open question was who decides *when* they run — an external scheduler (e.g. the worker firing
a job every turn / every N turns) or the Agent itself. We want the Agent to own that judgment, but we
also want the durability the existing Postgres job queue already provides (row-locking, retries).

## Decision

After each turn the Agent autonomously decides whether Consolidation is warranted (memorable content
present, or Summary stale by turn/token threshold). When warranted, the Agent **enqueues a
"memory-update" job** onto the existing Postgres queue. `opod-worker` executes it asynchronously by
calling the Agent's consolidation endpoint. Timing judgment lives in the Agent; execution substrate
stays on the shared queue.

## Considered options

- **Worker-scheduled cadence (every turn / every N turns)** — simple, but the Agent can't decide based on
  what was actually said; the user explicitly wanted the Agent to decide autonomously.
- **Agent does it fully in-process (background task)** — most self-contained, but re-implements
  row-lock/retry/crash-recovery that the queue already provides.

## Consequences

The Agent becomes a producer for the existing queue (a new coupling), but the chat path stays fast, the
decision is content-aware, and durability is inherited rather than rebuilt.
