# opod-agent web playground

A React (Next.js) chat UI for opod-agent, built with the [AI SDK](https://ai-sdk.dev)
and [AI Elements](https://elements.ai-sdk.dev). This is the canonical local playground.

## What it does

- Streams replies from opod-agent's OpenAI-compatible endpoint via `useChat`.
- Renders the model's **thinking** (gemma is a reasoning model) in a collapsible
  `<Reasoning>` block, separate from the answer.
- Controls for **character / user / session** ids (sent as `x-opod-*` headers) so
  you can exercise persona load + memory retrieval.
- A **Consolidate memory** button that runs opod's sleep-time passes over the
  current conversation (`POST /memory/consolidate`).

## How it connects

The browser never talks to opod directly. Two server-side route handlers proxy it:

- `app/api/chat/route.ts` — translates opod's OpenAI SSE into the AI SDK UI message
  stream. mlx_lm returns reasoning in a separate `delta.reasoning` field, so this
  route maps it to `reasoning-*` chunks by hand (no provider/middleware would).
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

Attachments/image upload are intentionally absent because opod's persona/memory pipeline is text-only
today. Add that capability as a separate chat module when the backend contract supports it.
