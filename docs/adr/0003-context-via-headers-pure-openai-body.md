# Character/user/session context rides in HTTP headers, body stays pure OpenAI

## Context

The Agent needs `character_id`, `user_id`, and `session_id` to load Persona and Memory, but a standard
`/v1/chat/completions` body carries only `messages` and `model`. Where that context travels determines
how faithfully a stock OpenAI client can point at the Agent unmodified.

## Decision

Context travels in `X-Opod-Character-Id` / `X-Opod-User-Id` / `X-Opod-Session-Id` headers. The request
body remains a 100% standard OpenAI chat request. When the headers are absent, the Agent degrades
gracefully to a plain OpenAI-compatible proxy (no persona/memory).

## Considered options

- **Extra body fields** — discoverable via `extra_body`, but the body is no longer pure OpenAI.
- **Encode in `model`/`user` fields** — spec-pure-ish but hacky and leaves `session` homeless.

## Consequences

Any OpenAI SDK works by setting default headers; the body schema is untouched, so response parsing and
tooling stay standard. Callers that forget the headers get a working (but memoryless) reply rather than
an error.
