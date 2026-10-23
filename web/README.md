# opod-agent web playground

A React (Next.js) chat UI for opod-agent, built with the [AI SDK](https://ai-sdk.dev)
and [AI Elements](https://elements.ai-sdk.dev). This is the canonical local playground.

## What it does

- Streams replies from opod-agent's OpenAI-compatible endpoint via `useChat`.
- Shows optional **fictional character feelings** as a small `속마음` aside, never native reasoning.
- Displays selected scene photos with alt text and explicit mock-photo labeling.
- Shows a restrained relationship label, with progress and change behind an expandable detail.
- Shows lookup-tool activity via opt-in `event: opod`; public expression tools are not duplicated as raw tool chips.
- Controls for **character / user / session** ids (sent as `x-opod-*` headers) so
  you can exercise persona load + memory retrieval.
- A **Consolidate memory** button that runs opod's sleep-time passes over the
  current conversation (`POST /memory/consolidate`).

## How it connects

The browser never talks to opod directly. Two server-side route handlers proxy it:

- `app/api/chat/route.ts` — translates text and validated `event: character` metadata into AI SDK
  UI parts. Native `reasoning` fields are ignored even when talking to an older upstream agent.
  Public thought, photo and relationship updates merge into one stable character data part.
- `app/api/consolidate/route.ts` — thin proxy to `POST /memory/consolidate`.

Set the backend URL in `.env.local` (defaults to `http://localhost:8787`):

```
OPOD_URL=http://localhost:8787
OPOD_WORKER_TOKEN=replace-with-the-same-token-as-opod-agent
```

## Run

opod-agent must be running first (see `../scripts/dev-gemma.sh`). Then:

```bash
pnpm dev      # http://localhost:3000
```

## Structure

- `chat/` owns the playground state, controls, message feed, text prompt, and SSE parser.
- `backend/opod.ts` is the single outbound backend seam; change `OPOD_URL` or replace this adapter.
- `app/api/` contains only Next.js route handlers.

The playground sends a fresh `turnId` for each user submission and reuses that request body on
transport retries. It currently retains the whole browser transcript, so `historyOffset` is `0`; a
backend that trims messages must send the number of omitted user/assistant turns instead.

User image upload is intentionally absent. Character-selected sample album photos are supported;
their metadata is not sent back as user text or used as evidence of a real shared experience.
