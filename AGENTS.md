<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# VoiceTodo Agent

A voice-controlled to-do list web app. You manage tasks by speaking: tap the mic,
say something like "Add buy some coffee" or "Complete task 1", and the agent
transcribes your speech, mutates the list via tool calls, replies in text, and
speaks the reply back. Tasks can also be added/completed/deleted manually in the UI.

## Stack

- **Next.js 16** (App Router) — see the warning above; this is a non-standard build.
- **React 19** + **Tailwind CSS v4** (via `@tailwindcss/postcss`).
- **OpenAI SDK** (`openai`) for transcription, chat/tool-calling, and TTS.
- **lucide-react** for icons.
- Deployed on **Vercel** (`vercel.json` pins the `nextjs` framework + `next build`).

## Architecture

A three-stage voice pipeline. State (the todo list) lives in the client; the
server is stateless and receives/returns the full list on each request.

1. **Client** (`app/page.tsx`, `"use client"`) — records mic audio with
   `MediaRecorder` into a `webm` blob, then POSTs it plus the current todos
   (as JSON) to the backend as `multipart/form-data`.
2. **API route** (`app/api/voice-agent/route.ts`, `POST`) runs three OpenAI calls:
   - **Speech → text**: `openai.audio.transcriptions.create` (transcribe model).
   - **Text → action**: `openai.chat.completions.create` with three
     function-calling tools — `addTask`, `completeTask`, `deleteTask`. The route
     executes whichever tool the model selects (mutating `currentTodos`), pushes
     the tool results back, then makes a second chat call to get a short
     conversational reply suitable for TTS.
   - **Text → speech**: `openai.audio.speech.create` (TTS model, voice `ash`),
     returned as base64 MP3.
   - Responds with `{ transcript, todos, assistantText, audioBase64 }`.
3. **Client** updates the recognized-speech panel, agent-response panel, and todo
   list, and auto-plays the spoken reply.

## Bring-your-own API key

There is **no server-side OpenAI key**. The user pastes their `sk-...` key into a
Settings modal; it is stored in `localStorage` (`openai_api_key`) and sent on
every request via the `x-openai-key` header. The route reads it at the top of
`POST` and returns **401** if missing/invalid — the client reopens Settings on 401.
On first load with no key, the Settings modal opens automatically.

## Knowledge base (RAG over Chroma Cloud)

All three agents (chained voice, avatar, realtime) can answer questions from a
knowledge base via a `searchKnowledge` tool. Knowledge is stored in **Chroma
Cloud**, sharded one collection per namespace (`knowledge_<namespace>`; the demo
uses a single `default` namespace). Dense vectors are produced by OpenAI
**`text-embedding-3-small`** and stored as pre-computed embeddings (no
Chroma-side embedding function). Documents over Chroma's 16 KiB limit are
line-chunked; search de-duplicates chunks of the same source via **GroupBy**.

- `app/lib/chroma.ts` — CloudClient, get-or-create collection, chunking,
  `indexDocuments`, `searchKnowledge`, `listKnowledgeSources`.
- `app/api/knowledge/route.ts` — `POST` add knowledge, `GET` list sources.
- `app/api/knowledge/search/route.ts` — `POST` search (used by the realtime
  agent, whose tool calls run in the browser).
- The chained/avatar routes call `searchKnowledge` server-side; the realtime
  client (`app/lib/realtime.ts`) calls `/api/knowledge/search`.
- `scripts/migrate-to-chroma.mjs` — seed/migrate: `node --env-file=.env.local
  scripts/migrate-to-chroma.mjs` (reads `scripts/seed-knowledge/*.{txt,md}` or a
  built-in sample corpus).
- Env: `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE` in `.env.local`.

## Key files

- `app/page.tsx` — entire client UI: mic recording, manual task CRUD, Settings
  modal (key entry/show/clear), recognized-speech/agent-response panels,
  Knowledge Base add/list section.
- `app/api/voice-agent/route.ts` — the voice pipeline (transcribe → tool-call → TTS).
- `app/layout.tsx` — root layout, Geist fonts.
- `vercel.json` — Vercel framework/build pin.
- `playwright-test.js` — headless smoke test (fake media devices; seeds a dummy
  key, checks header, adds a manual task, verifies the mic toggles to recording).

## Conventions & gotchas

- Tools run server-side; the model never mutates state directly — it only emits
  tool calls that the route applies to `currentTodos`.
- Todo IDs are random base-36 strings generated both client- and server-side.
- TTS failure is non-fatal: the route still returns text if speech generation throws.
- The user's key transits this server in plaintext headers en route to OpenAI —
  acceptable for a personal/demo app; don't add server-side key persistence.

## Commands

- `npm run dev` — dev server at http://localhost:3000
- `npm run build` / `npm run start` — production build / serve
- `npm run lint` — ESLint
- `node playwright-test.js` — smoke test (requires the dev server running)
