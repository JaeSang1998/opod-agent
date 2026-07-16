# Character/user/session context rides in HTTP headers, body stays pure OpenAI

## Context

The Agent needs `character_id`, `user_id`, and `session_id` to load Persona and Memory, but a standard
`/v1/chat/completions` body carries only `messages` and `model`. Where that context travels determines
how faithfully a stock OpenAI client can point at the Agent unmodified.

## Decision

Context travels in `X-Opod-Character-Id` / `X-Opod-User-Id` / `X-Opod-Session-Id` headers. A
personalized learning request also carries `X-Opod-Turn-Id`, a caller-stable occurrence identity that
is reused only for retries of the same logical turn. `X-Opod-History-Offset` gives the absolute number
of user/assistant turns omitted before the retained `messages` window and defaults to zero. The request
body remains a 100% standard OpenAI chat request. When relationship headers are absent, the Agent
degrades gracefully to a plain OpenAI-compatible proxy (no persona/memory).

## Considered options

- **Extra body fields** — discoverable via `extra_body`, but the body is no longer pure OpenAI.
- **Encode in `model`/`user` fields** — spec-pure-ish but hacky and leaves `session` homeless.

## Consequences

Any OpenAI SDK works by setting per-request headers; the body schema is untouched, so response parsing
and tooling stay standard. Callers that omit relationship headers get a working (but memoryless) reply.
Callers that provide the full relationship identity must also provide a logical turn id, preventing
correlation ids or content hashes from being mistaken for retry identity.
