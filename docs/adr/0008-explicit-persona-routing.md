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
- P1-1 left canon in the stable prompt in full. The D28 extension below adds an opt-in authored
  canon read model; unmapped legacy canon still follows that original contract.

## D28 extension — source slicing and authored memory recall (2026-09-08)

Implemented and locally verified after the user's request to research references and modify both
structures. **Verified; human review required before merge.** No DDL or deployment in this slice.

- `src/persona/persona-source-projection.ts` owns lossless source slicing for serving and evals.
  Plans pin each split block's SHA256 and contiguous UTF-8 byte spans; reconstruction must match the
  whole source. Fragment IDs encode source ID/version/span. Fragment recall keys do not inherit from
  the parent. Content-free sidecars preserve provenance, not cue text or source content.
- The existing manifest retains its v1 legacy block mapping and optionally adds `structuredCharacters`:
  per-character projection plus complete ID/hash-pinned canon metadata. Original source fields remain
  intact. Duplicate/missing canon mappings or a changed source fail rather than silently injecting it.
  Generated D28 manifests also pin every unsplit block's content hash.
- Canon routing separates persistent authored facts from retrievable facts/events. Source `type`,
  `reason`, `createdAt` and `updatedAt` are not event time or retrieval policy. An explicitly classified
  event cannot be `always`. Legacy unclassified records/strings retain their old behavior.
- `character-recall.ts` implements authored keyphrase selection over current-character eligible lore
  and canon. NFKC/case-normalized literal substring matches only the latest user text. Maximum four
  lore and four canon entries, source-order ties, zero when unmatched. This is a bounded first selector,
  not semantic retrieval or pronoun/topic-state resolution; it can miss paraphrases or overmatch cues.
- `routePersona` remains the sole channel owner. Recalled canon enters a separate turn-context section
  from user observations/reflections. No dynamic selection changes the stable system prefix.
  Debug `canonSources` reports ID/kind/destination/reason, not content. Existing `personaBlockCount`
  and `canonCount` count loaded sources, **not injected stable items**; use provenance for destinations.
- `PERSONA_ROUTING_MANIFEST_PATH` loads the reviewed private mapping at container creation. Missing
  path keeps legacy Persona behavior. A mapping covering only four characters must not be activated
  for an unrestricted character population: unmapped blocks fail. Source updates require mapping
  regeneration/review and a container restart. Unset the path to roll back Persona routing.
- Separately, the common archival ranking owner accepts `minRelevance`; built-in stores pass the
  configured raw cosine floor before selecting/touching top-K. Container default `MEMORY_MIN_RELEVANCE=0`
  excludes nonpositive similarity. It is not a calibrated semantic threshold. Legacy direct callers
  omitting the option retain the old helper behavior; custom stores must implement the optional
  retrieval contract. `memoryPolicyVersion=2` records the requested configured policy, not proof a
  third-party adapter enforced it. Metadata with no gate remains v1.

The 45-block/79-canon snapshot produced 15 split sources/40 fragments and 48 synthetic HTTP captures.
No actual model replies, user-quality verdicts, or shared-persona writes from learned user memory.
Core/summary persistence, current-scene generation, correction/forgetting and semantic indexing remain
out of scope. Source-backed behavioral quotations inside blocks remain; excluding standalone examples
is an experiment, not a blanket product prohibition on examples. See the existing
[research D28](../character-chat-products-persona-memory-research-2026-09-03.md#1123-d28--공식-레퍼런스-재확인과-실제-personamemory-읽기-구조-변경)
and [verification report](../reports/character-chat-direct-naturalness-2026-09-08.md#d28--레퍼런스-기반-실제-personamemory-분리).

## D29 extension — persisted authored context (2026-09-08)

The user explicitly approved local DB implementation/testing and DDL. Verified on an isolated local
DB; human review required before merge. No development DB changes or deployment.

- Canonical schema/migration is owned by opod-service-backend; opod-admin mirrors it. Migration
  `20260908093302_persist_character_context` adds child `character_persona_fragments` rows (source FK,
  ordinal, content, kind, injection, recall_keys, timestamps) and nullable canon kind/injection with
  non-null recall_keys. Database checks reject explicit always-injected events. Existing learned
  user memory tables and scope keys remain separate and unchanged.
- The authenticated admin structure API locks the source row, checks its SHA-256, and atomically
  replaces source/fragments plus audit log. Concatenation must exactly preserve the new source.
  Source-only legacy PATCH on a structured row returns 409. Classification-only writes preserve
  source timestamps. The hash protects source-content changes, not concurrent policy-only editing.
- PostgresPersonaStore reads source and fragments in one SQL snapshot, validates completeness,
  and reuses projectPersonaSources for multiple fragments. Malformed/stale nonempty fragment sets
  fail closed. No child rows means legacy: deleting every child through direct SQL is indistinguishable
  from an unclassified source. The API rejects empty splits and commits replacements atomically.
  Router/recall still own prompt selection.
- Migration must precede this reader/admin code. A persisted structured character needs no manifest;
  do not layer its old manifest onto already projected blocks. Removing a manifest no longer rolls
  back persisted routing. Old code can still read original rows. Dropping new tables/columns loses
  structure metadata without a backup; down/up was tested only in a disposable DB transaction.
- Four frozen characters, 45 original sources, 70 fragments and 79 canon entries were saved by real
  admin HTTP APIs and reread through the agent. Twelve synthetic prompt captures were repeated after
  a DB restart. This is persistence evidence, not actual conversation-quality evidence. A visual
  structure editor, semantic recall, correction/forgetting and current-scene state are not included.

See [D29 evidence and rollout limits](../reports/character-context-local-db-2026-09-08.md).

## D30 extension — preserve authored purpose at the prompt boundary (2026-09-08)

Repo-evidenced; verified, human review required before merge. The router still owns selection.
`src/chat/persona-reference.ts` is the shared owner for rendering each selected block in both the
stable system prompt and the per-turn reference. It uses explicit `kind` to describe how the source
should be used: identity, reactions, typing style, relevant background, illustrative example,
first-contact guidance or creator context. Titles do not determine purpose. Untyped legacy blocks
retain their original formatting; source title/content/order are preserved and IDs/recall keys are
not rendered. This closes a reproduced information-loss gap, not a proven dialogue-quality cause.

The isolated local DB now holds D30 candidate edits to eight sources (five text rewrites and three
content-preserving preference reclassifications/splits), totaling 72 fragments. Frozen D29 originals,
canon and existing human reviews remain unchanged. No character-specific runtime branches, new
canon, retrieval algorithm changes or schema changes were added. Actual replies remain unverified.
See [D30 implementation, four-condition input evidence and rollback boundary](../reports/character-personality-local-2026-09-08.md).

## D31 extension — bounded recall and edited local context (2026-09-09)

Repo-evidenced; local verification passed, human review required before merge. No schema change,
deployment or change to learned user-memory storage/retrieval in this slice. The D28 selector description
above is historical; the common owner remains `src/persona/character-recall.ts`.

- Authored cue matching now prioritizes the longest matching key, preserving source-order ties.
  Each lore/canon selection independently admits at most four items and 1,200 content Unicode code
  points. Oversized items are skipped whole, not truncated; normalized identical content is deduplicated
  within each list. This is not a tokenizer budget, semantic deduplication or a cross-owner quota.
- A small Korean topic-cut heuristic searches only the suffix after the last recognized cut marker.
  Without a direct cue or cut, a short deictic follow-up can fall back to the preceding user's topic.
  ChatService supplies at most one user turn from the immediately preceding two messages; the selector
  bounds latest text to 120 and previous text to its last 256 code points for this fallback. Assistant
  output never seeds the recall query. `previousQuery` is optional for custom selectors. Current-only
  learned-memory retrieval, proxy behavior and router channel ownership remain unchanged.
- `assembleSystemPrompt` omits public bio only when the stable Persona contains a nonempty explicit
  identity block. Untyped cards and blank/missing identity preserve legacy bio behavior. The stored
  profile is not edited. Turn selection still cannot change the stable prefix.
- This is a limited literal/heuristic experiment, not full negation, paraphrase, multi-turn reference
  resolution, or semantic relevance. A prior-user subject can be the wrong referent; quoted cut markers
  can overfilter. Important entries without a key or exceeding the budget can be missed.

The isolated four-character candidate edits 23 sources and 20 canon bodies, keeps 45 parents/79 canon
rows/17 excluded fragments, and moves the remaining 11 always-canon rows to conditional routing.
Identity/behavior already supplying a fact can own it without a second memory prompt copy; seven
redundant memory rows retain their data with empty recall keys. Final structure: 78 fragments (31 always,
30 retrieved, 17 excluded). Source-specific edits are experiment data, not character-specific serving
branches or universal rules requiring all future canon to be conditional.

128 four-condition captures plus 36 final checks validate input inclusion, not naturalness. Content-only
and selector-only conditions each leave a different coffee-context defect; combined inputs retain the
preference on a deictic follow-up and omit additional coffee recall after a cut in all four tested
characters. Actual model replies and new human verdicts are zero. See
[D31 scope, primary references, evidence, authorization and recovery](../reports/character-context-optimization-2026-09-09.md).

## Canonical-source extension — local verification (2026-09-11)

User-approved including DDL; verified locally, human review required before merge. No development
DB changes, real-model calls or new human-quality verdicts. This supersedes the D29 policy-only
last-write-wins description for linked records, not the original-content preservation contract.

- Backend migration `20260911074900_character_canon_sources` owns one source-fragment/canon link
  table and nullable canon source/time metadata. Admin owns authenticated transactional link writes,
  same-character active-record validation, structure/memory CAS and linked-delete conflicts.
- Migrated fragments retain their exact text as `never_prompt`. A link is audit provenance, not a
  retrieval cue. The existing canon reader/router remains the serving owner; multiple source links
  do not duplicate a canon entry. Invalid links raise `PersonaContextIntegrityError`; ChatService
  must not turn that error into a permissive retrieval fallback.
- `PostgresPersonaStore` and `personaContextHash` track content, policy, recall keys, event time and
  an internal SHA-256 of `source_refs`. Source snapshots never enter prompts. Content-only
  `sourceHashes`/embedding hashes remain separate so metadata changes do not require re-embedding.
  `turn-context.ts` renders known event labels with their precision as past reference, never as
  current activity. PostgreSQL's abbreviated timestamp offsets remain valid on the read path.
- Existing conversation history, relationship scope, summary coverage and learned-memory write
  owners remain unchanged. The end-to-end memory test uses a fresh session and real DB with a
  synthetic provider; it is not semantic-model quality evidence.
- The Han Soi rehearsal used a restored, isolated copy of local DB55433. It preserved all45 original
  sources, linked14 of her fragments, captured five queries and three other-character greeting
  controls, and actually restored source policies/active canon via admin APIs. Twelve new canon
  rows and one edited event were candidates in that copy only. Exact-byte preservation and the
  tested duplicate's single injection do not certify all semantic merges or conversational quality.
- `manual` provenance is rejected by admin until a trusted approval-record owner exists. A new
  visual editor, new character personalities, real embeddings and rollout remain separate work.

Evidence owners: `src/persona/postgres-persona-store.test.ts`, `src/chat/chat-service.test.ts`,
`src/chat/turn-context.test.ts`, `src/chat/character-context.integration.test.ts`, plus backend/admin
DB tests. The approved scope and execution ledger are in the sibling backend plan
`.codex/pave/plans/2026-09-11-character-context-canonical-design.md`. Original local DB55433 is not
automatically migrated by this rehearsal, and removing a manifest does not undo persisted links.

## Local semantic-query connection (2026-09-13)

Repo-evidenced; verified locally, human review required before merge. DB5433 only; no new DDL.
`DbSettingsProvider.embedQuery` resolves the DB provider and model in one snapshot and returns
the model identity alongside the vectors. `ChatService.prepare` passes that pair to both retrieval
owners; a mutable global/default model must not label vectors produced by another configuration.
The fixed `ChatServiceConfig.embeddingModel` remains for explicitly fixed evaluation providers.
Absent/unavailable/invalid 1024-dimensional query vectors fall back to lexical retrieval.

Query instructions are distinct from authored documents. The currently supported local
`Qwen/Qwen3-Embedding-0.6B` query path uses the official Instruct/Query convention; ordinary
`embed` calls preserve document text. Character context eligibility, source hashes, top-K/fusion,
and persona routing are unchanged. This connection does not activate the consolidation worker
or certify relevance/naturalness. See [the local Qwen report](../reports/local-qwen-embedding-2026-09-13.md)
for verification, the pinned local server, exact scope and remaining retrieval-quality issues.
