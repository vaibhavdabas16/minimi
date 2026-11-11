# DESIGN

A chat agent with one tool, web search, that answers fast, gets things right, and remembers what you asked and when.

## How it works

```
browser ──POST /api/chat──▶ server.ts ──▶ memory.ts: build this turn's context (no LLM calls, ~1 ms)
   ▲                                       • resolve "on 3 Nov" / "last Tuesday" to local days (temporal.ts)
   │                                       • pull older exchanges on those days + by topic (BM25)
   │                                       • timeline index of every older question + recent turns
   │                                    ▶ agent.ts: one streamed Claude call, web_search as a server tool
   └────── SSE: searching… / query / text / citations / done ◀─┘
                                         ▶ store.ts: append {question, answer, sources, searches, askedAt, tz} to data/<user>.jsonl
```

Each request to Claude has this layout, ordered from most stable to most volatile so the prompt cache does its job:

1. **System prompt**: fixed instructions with no date or user data, so it is byte-identical on every request.
2. **Timeline index** (cache breakpoint): one line per older question with its timestamp. It covers only the questions before the recent window, so it changes once every 6 turns.
3. **Recent window** (cache breakpoint): the last 6–12 exchanges as real turns. Each user turn is stamped `[Tue, 3 Nov 2026, 14:02]`, and each answer keeps its sources and search queries. The window start moves in steps of 6, so the prefix stays the same between steps.
4. **This turn**: a `<context>` block holding the current time, the dates the user mentioned (already resolved), and older exchanges recalled in full. The user's message comes after it.

## Why it's built this way

- **Memory is assembled context.** The rules allow one tool, and a "recall" tool would add a full model round-trip before the answer could start. Retrieval here is deterministic and runs locally, so the model starts with what it needs.
- **The model doesn't do calendar maths.** `chrono-node` parses the dates and `Intl` handles timezones, resolving "last Tuesday" to the user's local day *before* the call. "Last Tuesday" said on a Wednesday is ambiguous (yesterday, or a week earlier?), so both days are retrieved and the stored memory settles which one the user meant.
- **The context records negative results.** "`3 Nov → NO conversation on record`" is written into the context. That turns "don't invent past conversations" from a hope into a checkable fact, which matters when the test dataset makes claims like "On Monday we shortlisted…" that may not be in memory.
- **The memory unit is an exchange: question + answer + sources + queries + timestamp + timezone.** "Is your answer still correct?" needs to know what was said, when, and from which pages. With all of that stored, the agent re-checks those pages and reports what changed, what didn't, and what it couldn't verify.
- **Search uses Anthropic's server-side `web_search`.** Search, result filtering and citations all happen inside one streamed call, with no hop back through this server per query, and one API key. Citations are kept as `[n]` links and saved with the answer.
- **Speed choices:** everything streams over SSE, the cache layout above, no pre-pass LLM calls, `effort: medium`, at most 5 searches per turn, and a prompt that says when *not* to search. Live status chips ("Searched '…'") show progress during the wait.
- **Storage is append-only JSONL per user**, loaded into memory with a small BM25 index. It needs no native modules or database, so `npm install && npm run dev` works on any Node ≥ 20. You can inspect it with `cat`, and a write torn by a crash is skipped on load.

## Considered and rejected

- **Memory as a second tool, or the memory tool:** breaks the one-tool rule and costs a round-trip on every recall question.
- **Embeddings + vector DB:** needs another key or service. Recall here is mostly by date and proper noun ("Postgres", "HubSpot"), where lexical matching is precise. Fuzzy matches are still covered because the model sees *every* older question in the timeline index.
- **An LLM pre-pass to rewrite or route the query:** adds 0.5–1 s before the first token, and the deterministic resolver handles the date cases that matter.
- **External search API (Tavily/Exa/Brave) with my own fetch loop:** gives more control (result caching, parallel fan-out), but adds a second key and a round-trip per search. This is the first thing I'd revisit if search quality became the bottleneck.
- **Summarising old conversations:** lossy. Answers are kept verbatim, because the agent is later asked whether *exactly that* answer is still true.
- **SQLite / a framework (LangChain etc.):** native-build or Node-version risk for no gain at this scale. The whole agent loop is one ~170-line file.

## With another week

1. **An eval harness first.** Scripted multi-day conversations (use `AGENT_NOW` to fake the dates), graded on recall accuracy, factual correctness against fixed sources, and refusals to invent memory, plus latency at p50/p90 and cache-hit rate. Every change below should be measured against it.
2. **Effort routing:** low effort for chit-chat and memory-only turns, higher effort for research across several products. Use a cheap heuristic, not an extra model call.
3. **Claim tracking:** extract `(entity, attribute, value, as-of, source)` from each answer, so "has anything changed?" becomes a diff, and so that change can trigger a proactive nudge (very on-brand for minimi).
4. **A user profile:** durable facts ("20-person sales team", "we chose Neon") pulled out of conversations and pinned into the cached prefix.
5. **Fan-out search:** for questions about N products, run per-entity searches in parallel, and cache results per URL per day.
6. Real auth instead of a cookie id, and SQLite once there are many users.
