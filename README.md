# minimi chat agent

A chat agent with one tool, web search. It answers fast, cites its sources, and remembers what you asked and when. You can come back days later and ask *"What did I ask you on 3 November? Is that still correct?"*

How it works and why: **[DESIGN.md](./DESIGN.md)**.

## Run it

Requires Node 20+ and an Anthropic API key. That one key covers both the model and its web search, so no separate search key is needed.

```bash
npm install
```

```bash
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

```bash
npm run dev
```

Then open http://localhost:3000.

## Try the memory

To build up dated history without waiting days, start the server with a fake clock, ask something, then restart it normally and ask about that date:

```bash
AGENT_NOW=2026-11-03T10:00:00Z npm run dev
```

Ask *"What do Neon, Supabase and RDS charge for Postgres hosting?"*. Then stop the server, run `npm run dev` again, and ask *"What did I ask you on 3 November? Is your answer still correct today?"*.

Each browser gets its own memory (via a cookie). It is stored as JSONL in `./data/`. **Clear memory** in the header wipes it.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | |
| `MODEL` | `claude-opus-5-5` | any Claude model with server-side web search |
| `EFFORT` | `medium` | `low` is faster, `high` is more thorough |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | |
| `AGENT_NOW` | (unset) | start the clock at this instant (for testing dated memory) |
| `ENRICH_MODEL` | `claude-haiku-5-5` | small model for background memory enrichment |
| `ENRICH` | on | `off` disables claim/profile extraction |

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

Evals against the real API (costs tokens; needs `ANTHROPIC_API_KEY`):

```bash
npm run eval
```

The tests cover date resolution (timezones, ambiguous "last Tuesday", spans), retrieval and context assembly, persistence, and one full agent turn against a fake streaming API: search, citations, cache breakpoints, the stored exchange, and background enrichment.

## Layout

```
src/server.ts    HTTP + SSE, per-user cookie, one turn at a time per user
src/agent.ts     the Claude call: streaming, web search, citations, pause_turn, persistence
src/memory.ts    builds each turn's context: timeline index, recent window, recalled exchanges
src/temporal.ts  "on 3 Nov" / "last Tuesday" / "last week" → local-day windows in the user's timezone
src/enrich.ts    background extraction of each answer's claims + the user profile
src/store.ts     append-only JSONL timeline per user + BM25 index (src/bm25.ts)
src/prompt.ts    the system prompt
eval/            multi-day scenarios + runner with LLM judge (npm run eval)
public/          the chat UI (vanilla JS, markdown via marked, raw HTML escaped)
```
