# Autonomous-learning memory: importance-weighted retrieval and reflection

## Status

accepted (supersedes the thin turn-count heuristic in the first cut of consolidation)

## Context

The first consolidation used a turn-count heuristic to decide when to write memory,
with a watermark that only advanced on summary refresh — so it re-extracted the
whole history each turn, and "autonomous" was really just a rule. We researched how
autonomous/self-learning agents actually implement memory and adopted two proven
lines of work:

- **Generative Agents** (Park et al. 2023, arXiv:2304.03442): an append-only memory
  stream where each item carries an **importance/poignancy** score (1-10); retrieval
  ranks by a weighted, min-max-normalized sum of **recency · importance · relevance**;
  and **reflection** fires when the summed importance of recent observations crosses a
  threshold (150/sim-day in the paper), synthesizing higher-level Reflections (with
  evidence citations) that are appended back into the stream.
- **MemGPT / Letta** (Packer et al. 2023, arXiv:2310.08560; sleep-time compute
  arXiv:2504.13171): a compact, **self-rewritten core memory block** kept always
  in-context (the character's mental model of the user), plus archival vector memory;
  consolidation runs as **background/"sleep-time" work** off the live turn.

## Decision

Memory has three tiers: **Short-term** (caller-passed turns), **Archival**
(relationship-scoped observations and cited reflections, importance-weighted), and **Summary**
(session-scoped within the user/Character relationship, so a reused session id cannot cross
relationship data). Archival records carry explicit `always` or `retrieved` injection policy;
stable grounded memories may be included independently of the current query. The serving path does
not load a separate Core block. Legacy Core accessors are compatibility facades over memory records,
not a separate persistence tier.

- **Retrieval** uses the Generative-Agents weighted score (recency·importance·relevance,
  normalized), implemented as a pure function so a pgvector adapter can mirror it.
- **Consolidation** runs off the chat hot path through the Postgres job queue. When Postgres is
  configured and `MEMORY_WORKER_ENABLED` is enabled, the Agent hosts the consumer in-process.
  It extracts observations from every turn after the current Summary
  watermark, scores importance, and accumulates it in per-relationship state.
- **Reflection is the autonomous trigger**: when accumulated importance crosses
  `REFLECTION_IMPORTANCE_THRESHOLD`, the Agent consumes the reflection budget and runs a pass
  (salient questions → weighted retrieval → cited Reflections appended to Archival Memory).
  The current `Reflector` does not rewrite Core in either mode and returns `coreUpdated: false`.
  A failed reflection restores the consumed budget for the existing retry path.

The hot-path Consolidation Policy enqueues memorable content immediately. Transient
short exchanges wait until the uncovered-turn threshold makes the Summary stale; that
job carries the complete uncovered suffix. The decision of *when to inspect* is thus
content-aware without dropping quiet turns, while the decision of *what to learn* and
whether to reflect remains importance- and salience-driven.

## Consequences

- Honors the "the agent decides autonomously" intent with a mechanism grounded in
  published work, not an ad-hoc rule.
- Query-independent `always` memories and retrieved records provide relationship continuity;
  cited Reflections retain higher-level interpretations alongside Observations. The policy is an
  input contract, not evidence that recall or dialogue quality has improved.
- Consolidation and reflection make model calls for extraction, salient questions, cited
  Reflections and Summary updates. They do not add a Core rewrite call. This is off the hot path;
  a fast local MoE (e.g. `qwen3:30b-a3b`) or a cheap model suits it. Importance-gating
  keeps reflection infrequent.
- Similarity-dedup on write depends on embedding quality; a weak embedding model can
  over-merge distinct Observations (observed with crude test embeddings).
