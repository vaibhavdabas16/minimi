import * as chrono from "chrono-node";
import { addDays, formatDay, localParts, startOfLocalDay, tzOffsetMinutes } from "./time.js";

/**
 * A time window the user referred to, resolved against *their* clock and
 * timezone. "last Tuesday" said on Wed 11 Nov in Bengaluru → the local day
 * Tue 10 Nov 00:00–24:00 IST, expressed as UTC instants.
 */
export interface DateRef {
  phrase: string;
  label: string;
  start: Date; // inclusive
  end: Date; // exclusive
}

type YMD = [number, number, number];

function dayWindow(phrase: string, from: YMD, toInclusive: YMD, tz: string): DateRef {
  const start = startOfLocalDay(...from, tz);
  const end = startOfLocalDay(...addDays(...toInclusive, 1), tz);
  const a = formatDay(start, tz);
  const b = formatDay(startOfLocalDay(...toInclusive, tz), tz);
  return { phrase, label: a === b ? a : `${a} – ${b}`, start, end };
}

function cmp(a: YMD, b: YMD): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Phrases chrono resolves to a single day but people mean as a span. */
const SPAN_PATTERNS: Array<{
  re: RegExp;
  resolve: (today: YMD, weekday: number) => [YMD, YMD];
}> = [
  {
    re: /\b(?:last|previous|past)\s+week\b/gi,
    // Monday–Sunday of the previous calendar week
    resolve: (t, wd) => {
      const thisMon = addDays(...t, -((wd + 6) % 7));
      return [addDays(...thisMon, -7), addDays(...thisMon, -1)];
    },
  },
  {
    re: /\b(?:this|earlier this)\s+week\b/gi,
    resolve: (t, wd) => [addDays(...t, -((wd + 6) % 7)), t],
  },
  {
    re: /\b(?:last|past|previous)\s+(\d+|few|couple of)\s+days\b/gi,
    resolve: (t) => [addDays(...t, -7), t],
  },
  {
    re: /\b(?:last|previous)\s+month\b/gi,
    resolve: (t) => {
      const firstThis: YMD = [t[0], t[1], 1];
      const lastPrev = addDays(...firstThis, -1);
      return [[lastPrev[0], lastPrev[1], 1], lastPrev];
    },
  },
  {
    re: /\bthis\s+month\b/gi,
    resolve: (t) => [[t[0], t[1], 1], t],
  },
];

/**
 * Pull every past-time reference out of a message. Deterministic and local:
 * no LLM call, so it adds ~0ms to time-to-first-token, and it means the model
 * receives "last Tuesday = Tue, 10 Nov 2026" instead of doing calendar maths.
 */
export function resolveDateRefs(text: string, now: Date, tz: string): DateRef[] {
  const p = localParts(now, tz);
  const today: YMD = [p.year, p.month, p.day];
  const refs: DateRef[] = [];
  const claimed: Array<[number, number]> = [];

  for (const { re, resolve } of SPAN_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const [from, to] = resolve(today, p.weekday);
      refs.push(dayWindow(m[0], from, to, tz));
      claimed.push([m.index!, m.index! + m[0].length]);
    }
  }

  const results = chrono.en.GB.parse(
    text,
    { instant: now, timezone: tzOffsetMinutes(now, tz) },
    { forwardDate: false },
  );

  for (const r of results) {
    if (claimed.some(([a, b]) => r.index < b && r.index + r.text.length > a)) continue;
    const s = r.start;
    const knowsDay = s.isCertain("day") || s.isCertain("weekday");
    const knowsMonthOnly = !knowsDay && s.isCertain("month");
    const isRelative = /\b(today|yesterday|tonight|morning|afternoon|evening|ago|earlier)\b/i.test(
      r.text,
    );
    if (!knowsDay && !knowsMonthOnly && !isRelative) continue; // bare times like "at 5pm"
    if (/\b(next|tomorrow|coming|upcoming)\b/i.test(r.text)) continue; // the future isn't in memory

    let from: YMD = [s.get("year")!, s.get("month")!, knowsMonthOnly ? 1 : s.get("day")!];

    // Memory lives in the past: a weekday or a date without a year that lands in
    // the future almost always means the most recent past occurrence.
    if (cmp(from, today) > 0) {
      if (knowsMonthOnly || (!s.isCertain("year") && s.isCertain("month"))) {
        from = [from[0] - 1, from[1], from[2]];
      } else if (s.isCertain("weekday") && !s.isCertain("day")) {
        from = addDays(...from, -7);
      } else {
        continue; // genuinely in the future ("next Friday") — nothing to recall
      }
    }

    let to: YMD = from;
    if (knowsMonthOnly) {
      const lastDay = addDays(from[0], from[1] + 1, 1, -1);
      to = cmp(lastDay, today) > 0 ? today : lastDay;
    } else if (r.end) {
      to = [r.end.get("year")!, r.end.get("month")!, r.end.get("day")!];
      if (cmp(to, from) < 0) to = from;
    }
    refs.push(dayWindow(r.text, from, to, tz));

    // "last Tuesday" said on a Wednesday: yesterday, or the week before? People
    // use it both ways. Offer both windows; the memory that actually exists in
    // them disambiguates (and the model is told it's ambiguous).
    if (/\blast\s+(mon|tue|wed|thu|fri|sat|sun)/i.test(r.text) && s.isCertain("weekday")) {
      const back = (p.weekday - s.get("weekday")! + 7) % 7 || 7;
      if (back < 7) {
        const earlier = addDays(...from, -7);
        const alt = dayWindow(r.text, earlier, earlier, tz);
        alt.label += " (alternative reading)";
        refs.push(alt);
      }
    }
  }

  // De-duplicate identical windows ("Monday ... on Monday")
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.start.getTime()}-${r.end.getTime()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
