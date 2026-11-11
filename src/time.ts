/**
 * Timezone helpers built on Intl only (no tz library). Memory is stored in UTC,
 * but people talk in local calendar days ("on Monday", "3 November"), so every
 * day boundary is computed in the user's IANA timezone.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

export function safeTimeZone(tz: unknown): string {
  if (typeof tz === "string" && tz.length < 64) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      /* fall through */
    }
  }
  return "UTC";
}

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(instant: Date, tz: string): LocalParts & { second: number } {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(instant)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday),
  };
}

/** Offset of `tz` from UTC at `instant`, in minutes (IST → +330). */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** UTC instant at which local midnight of y-m-d begins in `tz` (DST-safe). */
export function startOfLocalDay(year: number, month: number, day: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - tzOffsetMinutes(new Date(guess), tz) * 60000;
  t = guess - tzOffsetMinutes(new Date(t), tz) * 60000; // re-check across DST transitions
  return new Date(t);
}

/** Add whole calendar days to a y-m-d triple. */
export function addDays(y: number, m: number, d: number, n: number): [number, number, number] {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

/** "Tue, 3 Nov 2026" */
export function formatDay(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(instant);
}

/** "Tue, 3 Nov 2026, 14:02" */
export function formatDateTime(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

/** Human "how long ago" in local calendar days: "today", "yesterday", "8 days ago". */
export function daysAgo(then: Date, now: Date, tz: string): string {
  const a = localParts(then, tz);
  const b = localParts(now, tz);
  const diff = Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000,
  );
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return `${diff} days ago`;
}
