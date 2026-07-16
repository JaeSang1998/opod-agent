# Autonomous-learning memory: importance-weighted retrieval, reflection, and a self-edited core block

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
  threshold (150/sim-day in the paper), synthesizing higher-level insights (with
  evidence citations) that are appended back into the stream.
- **MemGPT / Letta** (Packer et al. 2023, arXiv:2310.08560; sleep-time compute
  arXiv:2504.13171): a compact, **self-rewritten core memory block** kept always
  in-context (the character's mental model of the user), plus archival vector memory;
  consolidation runs as **background/"sleep-time" work** off the live turn.

## Decision

Memory has four tiers: **Short-term** (caller-passed turns), **Archival**
(observations + reflections in pgvector, importance-weighted), **Core** (a compact,
self-rewritten relationship digest, always injected), and **Summary** (session-scoped within the
user/Character relationship, so a reused session id cannot cross relationship data).

- **Retrieval** uses the Generative-Agents weighted score (recency·importance·relevance,
  normalized), implemented as a pure function so a pgvector adapter can mirror it.
- **Consolidation** (already async via opod-worker — ADR-0004 — which *is* the
  sleep-time substrate) extracts observations from every turn after the current Summary
  watermark, scores importance, and accumulates it in per-relationship state.
- **Reflection is the autonomous trigger**: when accumulated importance crosses
  `REFLECTION_IMPORTANCE_THRESHOLD`, the Agent runs a reflection pass (salient
  questions → weighted retrieval → cited insights appended as reflections) and
  **self-rewrites the Core block** (MemGPT-style), then resets the accumulator.

The hot-path Consolidation Policy enqueues memorable content immediately. Transient
short exchanges wait until the uncovered-turn threshold makes the Summary stale; that
job carries the complete uncovered suffix. The decision of *when to inspect* is thus
content-aware without dropping quiet turns, while the decision of *what to learn* and
whether to reflect remains importance- and salience-driven.

## Consequences

- Honors the "the agent decides autonomously" intent with a mechanism grounded in
  published work, not an ad-hoc rule.
- The Core block gives cross-session "it remembers me" continuity at a small, fixed
  token cost; reflections let the character form higher-level views, not just store facts.
- Consolidation now makes several LLM calls per reflection (extract, importance,
  questions, insights, core rewrite, summary). This is deliberately off the hot path;
  a fast local MoE (e.g. `qwen3:30b-a3b`) or a cheap model suits it. Importance-gating
  keeps reflection infrequent.
- Similarity-dedup on write depends on embedding quality; a weak embedding model can
  over-merge distinct facts (observed with crude test embeddings).
