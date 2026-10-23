# Server-side tools with per-turn time grounding and an agent-side tool loop

## Context

A character with no sense of the current time drifts: it guesses dates, fumbles "tomorrow", and gives
stale answers to anything time-, weather-, or web-sensitive. A single "what time is it" tool only covers
the turns where the model *decides* to ask. At the same time the OpenAI-compatible surface must stay pure
(ADR 0003): tool execution and clock context cannot leak into the request body, and a plain proxy client
must keep working.

## Decision

- **Time is injected into the prompt every turn**, not merely exposed as a tool. (Originally into the
  system prompt; ADR 0007 moved it to the per-turn block at the tail, unchanged in every other respect.)
  Grounding the
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
  deltas are never forwarded, so the client sees assistant prose and explicit public character events — no native reasoning or tool plumbing.
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

## Addendum: opt-in tool debugging

The `x-opod-debug` request header (any non-empty value) independently enables tool-activity
observations. It carries no identity and never enters `RequestContext`/`ChatContext`.
The loop's best-effort `onEvent` hook emits `{type:"tool_call"|"tool_result", callId, iteration, tool, …}`.
Streaming writes serialize `event: opod` frames with chat frames; JSON replies collect events
alongside content-free prompt provenance in `opod_debug`. Without the header there is no debug data.
This channel is not the public character experience and is never requested by the product web.


## Addendum: public character expressions, private native reasoning

The earlier native-reasoning passthrough is removed. The streaming filter allowlists role, content,
refusal and completion metadata; personalized JSON messages also use an allowlist. Provider
`reasoning`, `reasoning_content`, `reasoning_details`, unknown fields and logprobs never become
character thoughts. Opening-frame buffering is bounded even when a local model repeats its role
on every native-reasoning fragment.

Persona turns bind per-turn `express_thought` and `share_photo` tools. The first publishes an
optional short fictional feeling, with operational narration rejected. The second asks JEV
Decisions to choose an eligible server-owned sample scene or no photo, with no fallback on failure.
Public JSON `opod` and streaming `event: character` carry only thought/photo/relationship fields,
independently of the debug flag. Atomic persisted bond deltas determine relationship feedback,
including caps, losses and replay no-ops; the final update precedes `[DONE]`.

The playground discards native reasoning even from older agents and hides raw public-expression
tool chips. Client-supplied tools and plain proxy requests retain ADR 0003 passthrough semantics.
