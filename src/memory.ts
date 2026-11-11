import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Exchange, Timeline } from "./store.js";
import { resolveDateRefs, type DateRef } from "./temporal.js";
import { daysAgo, formatDateTime, formatDay } from "./time.js";

/**
 * Memory is context engineering, not a tool.
 *
 * The rules allow exactly one tool (web search), and a "recall" tool would cost
 * a full model round-trip before the agent could even start answering. Instead,
 * every turn is assembled deterministically from three layers:
 *
 *   1. Timeline index   — every older question, one line each, with its date.
 *                         Lives in the system prompt and only changes every
 *                         `historyStep` turns, so it stays prompt-cached.
 *   2. Recent window    — the last 6–12 exchanges as real user/assistant turns,
 *                         each user turn stamped with when it was asked.
 *   3. Recalled detail  — full Q+A+sources for older exchanges that match a date
 *                         the user mentioned ("on 3 November", "last Tuesday")
 *                         or the topic (BM25 over past exchanges).
 *
 * Plus the current time and the resolved date references, so the model never
 * has to do calendar arithmetic.
 */

export interface Recalled {
  id: string;
  askedAt: string;
  question: string;
  why: string[];
}

export interface TurnContext {
  timelineBlock: string; // system block 2 (cached)
  history: Anthropic.Beta.BetaMessageParam[]; // recent window (cached prefix)
  preamble: string; // volatile per-turn context, sent with the user message
  dateRefs: Array<{ phrase: string; label: string; matches: number }>;
  recalled: Recalled[];
}

const MAX_TIMELINE_LINES = 400;
const MAX_RECALLED = 10;
const MAX_PER_DATE = 12;
const ANSWER_CHARS_RECALLED = 2500;

/** Where the recent window starts. Moves in steps so the cached prefix is stable between steps. */
export function windowStart(n: number): number {
  const { historyMax, historyStep } = config;
  if (n <= historyMax) return 0;
  return Math.ceil((n - historyMax) / historyStep) * historyStep;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function sourcesList(e: Exchange, max = 8): string {
  return e.sources
    .slice(0, max)
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`)
    .join("\n");
}

function renderAnswerForHistory(e: Exchange): string {
  const parts = [e.answer.trim() || "(no answer recorded)"];
  if (e.sources.length) parts.push(`Sources:\n${sourcesList(e)}`);
  if (e.searches.length) parts.push(`(Searched: ${e.searches.map((q) => `"${q}"`).join(", ")})`);
  return parts.join("\n\n");
}

export function buildTurnContext(
  timeline: Timeline,
  message: string,
  now: Date,
  tz: string,
): TurnContext {
  const all = timeline.exchanges;
  const n = all.length;
  const s = windowStart(n);

  // 1. Timeline index of everything before the window.
  const older = all.slice(Math.max(0, s - MAX_TIMELINE_LINES), s);
  const timelineBlock = older.length
    ? [
        `<timeline note="Every earlier question the user asked you, oldest first. Times are in ${tz}.${
          s > older.length ? ` ${s - older.length} even older questions omitted.` : ""
        }">`,
        ...older.map((e) => `- ${formatDateTime(new Date(e.askedAt), tz)} — ${oneLine(e.question, 180)}`),
        `</timeline>`,
      ].join("\n")
    : "<timeline>No earlier conversations beyond the recent ones below.</timeline>";

  // 2. Recent window as real turns, user turns stamped with their time.
  const history: Anthropic.Beta.BetaMessageParam[] = [];
  for (const e of all.slice(s)) {
    history.push({ role: "user", content: `[${formatDateTime(new Date(e.askedAt), tz)}]\n${e.question}` });
    history.push({ role: "assistant", content: renderAnswerForHistory(e) });
  }

  // 3. Recall older exchanges by date and by topic.
  const why = new Map<number, string[]>();
  const note = (i: number, reason: string) => {
    if (i >= s) return; // already visible in the recent window
    const r = why.get(i) ?? [];
    r.push(reason);
    why.set(i, r);
  };

  const refs: DateRef[] = resolveDateRefs(message, now, tz);
  const dateRefs = refs.map((ref) => {
    const hits = timeline.between(ref.start, ref.end);
    for (const i of hits.slice(-MAX_PER_DATE)) note(i, `asked on the date the user referred to ("${ref.phrase}")`);
    return { phrase: ref.phrase, label: ref.label, matches: hits.length };
  });

  const topical = timeline.index.search(message, 8);
  if (topical.length) {
    const top = topical[0].score;
    for (const h of topical) if (h.score >= top * 0.35) note(h.id, "same topic as the current message");
  }

  // Date matches first (the user asked for them explicitly), then best topical.
  const ranked = [...why.entries()]
    .sort((a, b) => {
      const da = a[1].some((r) => r.startsWith("asked on")) ? 1 : 0;
      const db = b[1].some((r) => r.startsWith("asked on")) ? 1 : 0;
      return db - da || b[1].length - a[1].length;
    })
    .slice(0, MAX_RECALLED)
    .map(([i]) => i)
    .sort((a, b) => a - b); // present chronologically

  const recalled: Recalled[] = ranked.map((i) => ({
    id: all[i].id,
    askedAt: all[i].askedAt,
    question: all[i].question,
    why: why.get(i)!,
  }));

  // Volatile per-turn context.
  const lines: string[] = [];
  lines.push(`Current time: ${formatDateTime(now, tz)} (${tz})`);
  lines.push(
    n
      ? `Memory: ${n} past exchanges with this user, the first on ${formatDay(new Date(all[0].askedAt), tz)}.`
      : "Memory: this is the first conversation with this user; there is no earlier history.",
  );
  if (dateRefs.length) {
    lines.push("Dates the user mentioned, resolved in their timezone:");
    for (const d of dateRefs) {
      lines.push(
        `- "${d.phrase}" → ${d.label}: ${
          d.matches ? `${d.matches} exchange(s) on record` : "NO conversation on record for this date"
        }`,
      );
    }
  }
  if (recalled.length) {
    lines.push("", "<recalled_exchanges>");
    for (const i of ranked) {
      const e = all[i];
      const at = new Date(e.askedAt);
      lines.push(
        `<exchange asked="${formatDateTime(at, tz)} (${daysAgo(at, now, tz)})" why="${why
          .get(i)!
          .join("; ")}">`,
        `<question>${e.question}</question>`,
        `<answer>${oneLineKeepBreaks(e.answer, ANSWER_CHARS_RECALLED)}</answer>`,
        e.sources.length ? `<sources>\n${sourcesList(e)}\n</sources>` : "",
        "</exchange>",
      );
    }
    lines.push("</recalled_exchanges>");
  }

  return {
    timelineBlock,
    history,
    preamble: `<context>\n${lines.filter((l) => l !== "").join("\n")}\n</context>`,
    dateRefs,
    recalled,
  };
}

function oneLineKeepBreaks(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
