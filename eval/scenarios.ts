import { addDays, formatDay, localParts, startOfLocalDay } from "../src/time.js";

/**
 * Multi-day conversations modelled on the challenge's examples. Each scenario
 * starts with empty memory; turns run in order on an injected clock, so
 * "last Tuesday" really is a Tuesday in the past and memory has to bridge it.
 */

export const TZ = "Asia/Kolkata";

export interface Check {
  /** Must (true) / must not (false) run at least one web search. */
  searched?: boolean;
  mustMatch?: RegExp[];
  mustNotMatch?: RegExp[];
  /** Rubric for an LLM judge; it sees the conversation so far. */
  judge?: string;
}

export interface Turn {
  at: Date;
  message: string;
  check: Check;
}

export interface Scenario {
  name: string;
  about: string;
  turns: Turn[];
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Local `hh:mm` on the day `n` days before today, in TZ. */
function daysAgo(n: number, hh = 10, mm = 0, now = new Date()): Date {
  if (n === 0) return now;
  const p = localParts(now, TZ);
  const day = addDays(p.year, p.month, p.day, -n);
  return new Date(startOfLocalDay(...day, TZ).getTime() + (hh * 60 + mm) * 60000);
}

/** The most recent past `weekday` strictly before today, at 10:00 local. */
function lastWeekday(name: string, now = new Date()): Date {
  const today = localParts(now, TZ).weekday;
  const target = WEEKDAYS.indexOf(name);
  const back = (today - target + 7) % 7 || 7;
  return daysAgo(back, 10, 0, now);
}

const dayName = (d: Date) => formatDay(d, TZ).replace(/^\w+, /, ""); // "3 Nov 2026"

export function scenarios(now = new Date()): Scenario[] {
  const tue = lastWeekday("tuesday", now);
  const mon = lastWeekday("monday", now);
  const sourdough = daysAgo(3, 19, 30, now);
  const emptyDay = daysAgo(5, 12, 0, now);

  return [
    {
      name: "postgres-recheck",
      about: "Answer a pricing question, then days later re-verify it by date and by weekday.",
      turns: [
        {
          at: tue,
          message: "What do Neon, Supabase and AWS RDS charge for a small production Postgres database?",
          check: { searched: true, mustMatch: [/neon/i, /supabase/i, /rds/i] },
        },
        {
          at: now,
          message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
          check: {
            searched: true,
            judge:
              "Recalls that the earlier question was about Neon, Supabase and AWS RDS pricing, and for each provider says whether pricing changed since then (or that it couldn't verify), citing current sources. Fails if it doesn't connect to the earlier answer.",
          },
        },
        {
          at: now,
          message: `What did I ask you on ${dayName(tue)}? Is your answer still correct today?`,
          check: {
            searched: true,
            judge: `Correctly says that on ${dayName(tue)} the user asked about Postgres hosting pricing for Neon, Supabase and AWS RDS, summarises what was answered, and says whether it is still correct based on a fresh check.`,
          },
        },
      ],
    },
    {
      name: "no-invented-memory",
      about: "Asked about a day with no conversation, the agent must say so, not invent one.",
      turns: [
        { at: sourdough, message: "What's a good beginner sourdough recipe?", check: {} },
        {
          at: now,
          message: `What did I ask you on ${dayName(emptyDay)}?`,
          check: {
            searched: false,
            judge: `States plainly that there was no conversation on ${dayName(emptyDay)} and does NOT invent one. Mentioning the sourdough question from ${dayName(sourdough)} as the nearest conversation is good. Fails if it claims the user asked anything on ${dayName(emptyDay)}.`,
          },
        },
      ],
    },
    {
      name: "crm-not-in-memory",
      about: "The user refers to a shortlist made elsewhere; the agent mustn't pretend to remember it.",
      turns: [
        {
          at: now,
          message:
            "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
          check: {
            judge:
              "Does not pretend to know which 5 tools were shortlisted. Either asks the user to list them, or clearly labels any tools it checks as an assumption. Fails if it presents a specific shortlist as if remembered.",
          },
        },
      ],
    },
    {
      name: "crm-remembered",
      about: "The shortlist was made with the agent on Monday; later it re-checks exactly those tools.",
      turns: [
        {
          at: mon,
          message: "We're a 20-person sales team. Shortlist 5 CRM tools for us, with current pricing.",
          check: { searched: true },
        },
        {
          at: now,
          message:
            "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
          check: {
            searched: true,
            judge:
              "Uses the same 5 CRM tools the assistant recommended earlier (from the conversation), and for each reports any pricing change or major launch since that Monday, or that nothing notable changed, citing sources.",
          },
        },
      ],
    },
    {
      name: "no-needless-search",
      about: "Stable knowledge and small talk should be answered directly, fast.",
      turns: [
        {
          at: now,
          message: "What's the difference between a mutex and a semaphore?",
          check: { searched: false, mustMatch: [/mutex/i, /semaphore/i] },
        },
        { at: now, message: "thanks, that's clear", check: { searched: false } },
      ],
    },
  ];
}
