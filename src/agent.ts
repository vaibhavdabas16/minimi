import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { config, now as clockNow } from "./config.js";
import { enrich } from "./enrich.js";
import { buildTurnContext, type Recalled } from "./memory.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { Exchange, Source, Timeline } from "./store.js";

/** Events streamed to the browser over SSE. */
export type AgentEvent =
  | { type: "context"; dateRefs: Array<{ phrase: string; label: string; matches: number }>; recalled: Recalled[] }
  | { type: "searching" }
  | { type: "search"; query: string }
  | { type: "results"; count: number; error?: string }
  | { type: "text"; delta: string }
  | { type: "cite"; refs: Array<{ n: number; url: string; title: string }> }
  | { type: "done"; exchange: Exchange }
  | { type: "memory"; claims: number; profile: string[] }
  | { type: "error"; message: string };

let client: Anthropic | null = null;
// Created lazily so the server (and UI) boots even before a key is configured.
const anthropic = () => (client ??= new Anthropic());
const MAX_CONTINUATIONS = 3;

/**
 * Ask a question; stream events; persist the exchange to the user's timeline.
 * Resolves once the answer is saved; `enrichment` settles later, when the
 * background claim/profile extraction has been written to memory.
 */
export async function runTurn(opts: {
  timeline: Timeline;
  message: string;
  tz: string;
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
  now?: Date; // injectable clock (evals); defaults to the app clock
}): Promise<{ exchange: Exchange; enrichment: Promise<void> }> {
  const { timeline, message, tz, emit, signal } = opts;
  const startedAt = Date.now();
  const askedAt = opts.now ?? clockNow();

  const ctx = buildTurnContext(timeline, message, askedAt, tz);
  emit({ type: "context", dateRefs: ctx.dateRefs, recalled: ctx.recalled });

  // Cache breakpoints: (1) end of system = instructions + profile + timeline index,
  // (2) end of the recent-history window. Both are stable between turns, so a
  // follow-up only pays full price for the new context and question.
  const history = ctx.history.map((m) => ({ ...m }));
  const last = history.at(-1);
  if (last && typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history,
    {
      role: "user",
      content: [
        { type: "text", text: ctx.preamble },
        { type: "text", text: message },
      ],
    },
  ];

  const sources: Source[] = [];
  const sourceIndex = new Map<string, number>();
  const searches: string[] = [];
  let answer = "";
  let firstTokenAt: number | null = null;
  let stopReason: string | null = null;

  const cite = (c: Anthropic.Beta.BetaTextCitation) => {
    if (c.type !== "web_search_result_location") return null;
    let n = sourceIndex.get(c.url);
    if (!n) {
      sources.push({ url: c.url, title: c.title || new URL(c.url).hostname });
      n = sources.length;
      sourceIndex.set(c.url, n);
    }
    return { n, url: c.url, title: sources[n - 1].title };
  };

  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    const stream = anthropic().beta.messages.stream(
      {
        model: config.model,
        max_tokens: config.maxOutputTokens,
        system: [
          { type: "text", text: SYSTEM_PROMPT },
          { type: "text", text: ctx.profileBlock },
          { type: "text", text: ctx.timelineBlock, cache_control: { type: "ephemeral" } },
        ],
        messages,
        tools: [
          {
            type: "web_search_20260209",
            name: "web_search",
            max_uses: config.maxSearchesPerTurn,
            user_location: { type: "approximate", timezone: tz },
          },
        ],
        output_config: { effort: config.effort },
        // If the model declines on a policy false positive, the API retries on a
        // server-chosen fallback model inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );

    stream.on("streamEvent", (ev) => {
      if (ev.type === "content_block_start" && ev.content_block.type === "server_tool_use") {
        emit({ type: "searching" });
      }
    });
    stream.on("text", (delta) => {
      firstTokenAt ??= Date.now();
      answer += delta;
      emit({ type: "text", delta });
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        const q = String((block.input as { query?: unknown }).query ?? "");
        if (q) {
          searches.push(q);
          emit({ type: "search", query: q });
        }
      } else if (block.type === "web_search_tool_result") {
        // Errors come back as a 200 with an error object instead of a list.
        if (Array.isArray(block.content)) emit({ type: "results", count: block.content.length });
        else emit({ type: "results", count: 0, error: block.content.error_code });
      } else if (block.type === "text" && block.citations?.length) {
        const refs = block.citations.map(cite).filter((r) => r !== null);
        const unique = [...new Map(refs.map((r) => [r.n, r])).values()];
        if (unique.length) {
          answer += unique.map((r) => `[${r.n}]`).join("");
          emit({ type: "cite", refs: unique });
        }
      }
    });

    const final = await stream.finalMessage();
    stopReason = final.stop_reason;
    if (final.stop_reason !== "pause_turn") break;
    // A long server-side search loop paused; send it back so the server resumes it.
    messages.push({ role: "assistant", content: final.content });
  }

  if (stopReason === "refusal" && !answer.trim()) {
    answer = "I can't help with that one.";
    emit({ type: "text", delta: answer });
  } else if (stopReason === "max_tokens") {
    const note = "\n\n_(Answer cut off at the length limit.)_";
    answer += note;
    emit({ type: "text", delta: note });
  }

  const exchange: Exchange = {
    id: randomUUID(),
    askedAt: askedAt.toISOString(),
    tz,
    question: message,
    answer: answer.trim(),
    sources,
    searches,
    model: config.model,
    ms: { firstToken: firstTokenAt ? firstTokenAt - startedAt : null, total: Date.now() - startedAt },
  };
  timeline.append(exchange);
  emit({ type: "done", exchange });

  const enrichment = config.enrich && exchange.answer
    ? enrich(exchange, timeline.profile)
        .then(({ claims, profile }) => {
          timeline.attachClaims(exchange.id, claims);
          timeline.setProfile(profile);
          emit({ type: "memory", claims: claims.length, profile: timeline.profile });
        })
        .catch((err) => console.warn("memory enrichment failed:", describeError(err)))
    : Promise.resolve();
  return { exchange, enrichment };
}

/** Map SDK errors to something a person can act on. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY in .env and restart.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API — try again in a moment.";
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your connection.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
