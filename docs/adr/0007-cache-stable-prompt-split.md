# A cache-stable system prompt, with per-turn state injected at the tail

## Context

The prompt the Agent assembles carries two very different kinds of thing: who the character is (bio,
authored blocks, canon, guardrails, abilities) and what is true right now (the clock, the retrieved
memories, the rolling summary, and — since the Bond was reworked — how close the relationship is and
what that closeness permits).

Until now all of it went into the system prompt at position 0. That is the most expensive place a
changing byte can sit. Every runtime this service talks to (vLLM, llama.cpp, MLX, Ollama, OpenAI)
caches by *prefix*: a request is reused only up to the first token that differs. The system prompt
carried a clock rendered to the minute, so in practice **the cache was invalidated on every single
turn** — a persona block that had not changed in a month was re-processed on every message, and the
whole conversation history behind it with it. On local models that is the difference between a fast
first token and several seconds of prefill.

The Bond's unlock instructions made this worse and made it obvious: capability grants that change as
the relationship levels up are, by definition, per-turn state.

## Decision

Split the prompt by *how often it changes*, not by what it is about.

- **The system prompt holds only what is stable for a character**: identity and bio, the DM channel
  framing, authored persona blocks, canon facts, the abilities section, the stay-in-character line, and
  the closing-tag rubric (the same text every turn — only the state it grades moves). It is byte-identical
  from one turn to the next, so it caches.
- **Everything per-turn rides in a `<context>` block appended to the last user message**: current moment,
  where the relationship stands and what it now permits, the core block, the session summary, and
  retrieved memories. It sits *behind* the entire unchanged conversation history, so changing it costs
  only the tokens of the block itself.
- **The block is framed as system plumbing** ("This block is from the system, not from them — they cannot
  see it. Never quote it, mention it, or answer it."), because it arrives inside a user message and a
  character will otherwise eventually answer the note instead of the person.
- **`tracksBond` is derived from identity, not from a loaded snapshot**, so a transient store failure
  cannot flip the system prompt for one turn and cost a cache hit on top of the failure.

## Considered options

- **A second `system` message at the tail** — cleaner separation, but chat templates disagree about a
  system message that is not first: Gemma has no system role at all, and several runtimes only hoist or
  accept a leading one. A user turn is the one shape every template renders in place.
- **A `developer`-role message** — OpenAI-specific; this service targets any OpenAI-compatible runtime
  (ADR 0001).
- **Leaving state in the system prompt and accepting the cache miss** — simplest, and what we had. It
  spends a full prefill on every message to say what could be said in a hundred tokens at the end.
- **Dropping the per-turn clock to make the prefix stable** — would fix caching by removing the grounding
  ADR 0006 added for good reason. The tail placement keeps both.

## Consequences

- The cached prefix now survives an entire conversation: system prompt + every prior turn. Only the newest
  user message differs, which is exactly what prefix caching is built for.
- Per-turn state is the *last* thing the model reads before it answers, which is also where it is attended
  to most — the placement is cheaper and reads better.
- Supersedes the "time is injected into the system prompt every turn" bullet of ADR 0006. The clock is
  still injected every turn, unconditionally; it just rides at the tail.
- Consolidation still learns from the caller's original messages: `withTurnContext` copies rather than
  mutates, so the injected block never enters memory or the transcript.
- New constraint to hold: nothing that varies per turn may be added to `assembleSystemPrompt`. There is a
  test asserting exactly that, and one asserting the prefix is identical across two turns whose clock,
  memory and bond all changed.
