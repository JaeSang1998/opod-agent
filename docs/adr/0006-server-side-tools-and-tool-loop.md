# Server-side tools with per-turn time grounding and an agent-side tool loop

## Context

A character with no sense of the current time drifts: it guesses dates, fumbles "tomorrow", and gives
stale answers to anything time-, weather-, or web-sensitive. A single "what time is it" tool only covers
the turns where the model *decides* to ask. At the same time the OpenAI-compatible surface must stay pure
(ADR 0003): tool execution and clock context cannot leak into the request body, and a plain proxy client
must keep working.

## Decision

- **Time is injected into the system prompt every turn**, not merely exposed as a tool. Grounding the
  clock unconditionally anchors *all* time-sensitive talk — greetings, "it's getting late", "next week" —
  not just explicit time questions. The user's zone rides in the `X-Opod-Timezone` header, consistent with
  ADR 0003; the body stays 100% standard OpenAI.
- **A server-side `AgentTool` registry** provides `get_time`, `get_weather` (Open-Meteo, no key), and
  `web_search` (Tavily, registered only when `WEB_SEARCH_API_KEY` is set). Tools are OpenAI function-tool
  definitions executed by the Agent, never round-tripped to the client.
- **An agent-side tool loop** runs the model, executes any tool calls, feeds the results back, and repeats
  up to 5 iterations; the last iteration is forced with `tool_choice: "none"` so the turn always ends in
  text. Each call is defensive — unknown tool, malformed JSON args, or a thrown `execute()` becomes a
  short error string handed back to the model in-character rather than a 500.
- **Streaming holds chunks back until the turn is known to be text.** Because a turn may open with
  `tool_call` deltas, the stream buffers until it can distinguish a tool turn from a text turn; tool-call
  deltas are never forwarded, so the client sees only assistant prose (and reasoning) — no tool plumbing.
- **Client-supplied `tools` disable the server loop entirely.** When the request body carries its own
  tools, the Agent is a pure pass-through proxy (ADR 0003) and neither injects nor executes anything.
- **Immersion is enforced in the prompt.** An abilities section tells the character it simply *knows* the
  time, weather, and real-world information; it must never mention tools, functions, APIs, or being an AI.

## Considered options

- **Time as a tool only** — misses every turn where the model doesn't think to call it, so the character
  still greets you at the wrong hour.
- **Client-driven tools (return `tool_calls`, let the caller execute)** — the standard OpenAI shape, but
  the character's abilities would then depend on each client re-implementing them, and streaming would
  expose the machinery. Kept as the passthrough path only when the client *opts in* with its own tools.
- **Timezone in the body** — rejected; violates the pure-OpenAI-body rule of ADR 0003.

## Consequences

- The character stays grounded and in-character: correct time/weather/web awareness with no mention of the
  mechanism. Clients need only set an `X-Opod-Timezone` default header.
- A heavy tool turn can add up to 5 model round-trips; the cap bounds cost and guarantees termination.
  Most turns make zero or one tool call.
- Streaming first-token latency rises slightly, since output is withheld until the turn's type is decided —
  the price of never leaking tool-call deltas.
- A missing `WEB_SEARCH_API_KEY` silently drops `web_search` from the registry; `get_time`/`get_weather`
  always work (Open-Meteo is keyless). Tool failures degrade to in-character error text, not HTTP errors.

## Addendum: an opt-in debug channel and streamed reasoning

The default OpenAI-compatible surface stays byte-identical, but two things made the loop hard to observe from
a client and are now addressed behind a single transport-level opt-in, the `x-opod-debug` request header (any
non-empty value). It is read from the raw request only and never enters `RequestContext`/`ChatContext` — it
carries no identity, only "show me the plumbing". When set, the tool loop's `onEvent` hook surfaces
`{type:"tool_call"|"tool_result", iteration, tool, …}` events: on the streaming path each is written as an
SSE `event: opod` frame (all writes serialized through one promise chain so event and chunk frames never
interleave), and on the non-streaming path they are collected into an `opod_debug: { events }` field on the
JSON body. Without the header there are zero extra frames and no extra field — a strict client sees exactly
the completion it saw before. `onEvent` is best-effort: a throwing listener is swallowed and can never break a
reply.

Separately, the streaming loop now passes a turn's nonstandard `reasoning` deltas straight through instead of
buffering them. Local reasoning models (live-verified gemma) emit `delta.reasoning` fragments — with
`delta.role` on every chunk — for minutes before any `delta.content`; the earlier buffer-until-known logic
dropped all but one of them, leaving clients looking dead until the final answer. Reasoning can never
retroactively become content, so forwarding it immediately is safe. A tool turn's early reasoning (before its
`tool_calls` fragment settles the turn) streams too; the field is nonstandard and ignored by strict OpenAI
clients, and the alternative — withholding minutes of thinking — is worse. Once a turn is known to be a tool
turn, everything from it (reasoning included) is suppressed, and at most one `role` delta ever reaches the
client across the whole multi-turn stream.
