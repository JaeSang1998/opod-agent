# OPOD Agent

The character-chat AI Agent service for OPOD. A standalone TypeScript HTTP service that exposes an
OpenAI-compatible chat API and enriches each turn with a character Persona and layered Memory before
calling an underlying LLM Provider. It sits alongside the existing `opod-service-backend`,
`admin-backend`, and `opod-worker`; `opod-worker` is its primary caller.

## Language

**Agent**:
This service. Turns an OpenAI chat request plus a character/user/session context into a
persona-and-memory-grounded reply.
_Avoid_: Bot, assistant service

**Character**:
A chat persona a user talks to. Identified by a `character_id`. Its behavioural definition is a Persona.
_Avoid_: Bot, NPC, agent (reserved for the service)

**Persona**:
The behavioural definition of a Character — name, background, speaking style, and system-prompt
material — loaded dynamically per request by `character_id`.
_Avoid_: Profile, prompt, template

**Memory**:
What the Character retains about a user across turns. Four tiers: Short-term, Archival, Core, and
Summary (see docs/adr/0005).
_Avoid_: History (reserved for the raw transcript), context

**Short-term Memory**:
The recent conversation turns. Owned by the caller and passed in the request `messages`; the Agent
does not persist it.
_Avoid_: Working memory, context window

**Archival Memory**:
Durable items about the user/relationship — Observations and Reflections — retrieved by weighted score
(recency · importance · relevance) each turn. Scoped to the (user, Character) relationship.
_Avoid_: Long-term memory, vector memory, knowledge

**Observation**:
A single durable fact extracted from a conversation ("the user is training for a marathon"), scored for
Importance at creation. The raw material of Archival Memory.
_Avoid_: Fact, note

**Reflection**:
A higher-level insight the Agent synthesizes from Observations ("the user is disciplined"), citing the
Observations it was inferred from. Stored alongside Observations and itself retrievable.
_Avoid_: Insight, thought

**Importance**:
A 1-10 poignancy score on each Observation. Drives retrieval ranking and, once accumulated past a
threshold, triggers Reflection.
_Avoid_: Weight, score, salience

**Core Memory**:
A compact, self-rewritten digest of the user that is always injected into the prompt — the Character's
standing mental model of this person. Relationship-scoped; rewritten during Reflection (MemGPT-style).
_Avoid_: Profile, bio, working context

**Summary**:
A rolling episodic compression of one conversation, keyed by session within a (user, Character)
relationship, refreshed to preserve continuity without unbounded token growth.
_Avoid_: Digest, recap

**Consolidation**:
The asynchronous learning pass. The Agent extracts Observations (with Importance) from uncovered turns
and, when accumulated Importance crosses the threshold, runs Reflection and rewrites Core Memory.
_Avoid_: Memory write, indexing

**Consolidation Policy**:
The rule that decides whether a completed exchange should enter Consolidation now or wait. Memorable
content enters immediately; otherwise uncovered turns accumulate until the Summary is stale.
_Avoid_: Scheduler, consolidation decider

**Memory-update Job**:
The handoff that asks a worker to run Consolidation for a relationship and session. It contains every
turn not yet covered by the Summary so learning never creates gaps.
_Avoid_: Memory event, background task

**LLM Provider**:
The swappable component that generates completions and embeddings (OpenAI, or a local endpoint like
Ollama), reached through one OpenAI-compatible adapter selected by environment configuration.
_Avoid_: Model, backend, engine

**PersonaStore / MemoryStore**:
The Agent's ports for loading Persona and reading or changing Memory without tying domain behavior to
a particular persistence system.
_Avoid_: Repository, DAO (use the Store names)
