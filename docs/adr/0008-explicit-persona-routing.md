# Explicit Persona routing before prompt assembly

## Status

Accepted for the P1-1 runtime experiment. Production Persona rows remain on the legacy fallback until
an explicit mapping is supplied; no schema migration is part of this decision.

## Context

`PostgresPersonaStore` historically returned ordered `title/content` blocks and
`assembleSystemPrompt` injected every active block except an exact English `greeting`. The serving
path could not express that identity and voice should stay present, an introduction should expire,
background should be recalled only when relevant, or a content-production note should never enter a
DM prompt. Block titles are operator-authored text and differ by language and character, so treating
title spelling as a permanent runtime contract would make the policy implicit and brittle.

The cache-stable split in ADR 0007 adds another constraint: a turn-dependent choice cannot rewrite the
leading system prompt without invalidating prefix caching.

## Decision

- A raw Persona block may carry a stable source `id` plus the P1 read-model fields `kind` and
  `injection`. The four P1-1 injection values are `always`, `start_only`, `retrieved`, and
  `never_prompt`.
- `RoutedPersonaStore` is a strict, DDL-free decorator. It joins a versioned manifest to raw blocks by
  block ID, never by title. Every block returned by a routed experiment must have one explicit entry;
  a missing route is an error rather than an implicit `always`.
- `routePersona` is the single owner of channel projection:
  - `always` enters the stable system Persona;
  - `start_only` enters the per-turn tail context only for the first assistant reply;
  - a separately selected `retrieved` block enters that same tail context for the current turn;
  - `never_prompt` is excluded.
- Relevance selection is an injected seam, not a title or content heuristic in the router. Only the
  character ID, current query, and blocks already classified as `retrieved` cross that seam;
  `never_prompt` material is not exposed to a future selector. The P1-1 fixture uses explicit
  test-only match rules. Retrieval quality and production indexing belong to a later slice.
- Persona provenance exposed through debug contains only source ID, kind, policy, mapping mode,
  destination, and reason. It contains no block title or content.
- An unmapped Store keeps the pre-P1 behavior so adding the router alone does not silently change
  production characters. The old exact-English-`greeting` exclusion remains only as a centralized
  legacy compatibility rule.

## Consequences

- Dynamic Persona material obeys ADR 0007: it changes the tail context while the leading prompt hash
  remains byte-stable across turns.
- The same code applies to every character. Character IDs, names, professions, motifs, and block-title
  vocabularies do not appear in routing logic.
- The runtime now supports a causal fixture/read-adapter experiment without DDL, but this does **not**
  mean current development or production Persona rows are classified. Activating the candidate for
  real characters requires a complete external mapping and a real-model, human-reviewed A/B.
- Character canon memories are unchanged and still enter the stable prompt in full. Their lifecycle
  and relevance are outside P1-1.
