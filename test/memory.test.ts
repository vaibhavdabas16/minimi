import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildTurnContext, windowStart } from "../src/memory.js";
import { Timeline, type Exchange } from "../src/store.js";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-11T11:30:00Z"); // Wed 11 Nov, 17:00 IST

function tmpTimeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-test-"));
  return new Timeline(path.join(dir, "u.jsonl"));
}

let seq = 0;
function ex(askedAt: string, question: string, answer = "ok"): Exchange {
  return { id: `e${++seq}`, askedAt, tz: TZ, question, answer, sources: [], searches: [] };
}

function seeded() {
  const t = tmpTimeline();
  t.append(ex("2026-11-03T08:32:00Z", "Compare Neon, Supabase and RDS for Postgres hosting pricing", "Neon starts at $19/mo [1]"));
  t.append(ex("2026-11-03T09:10:00Z", "What's a good name for a cat?", "Miso."));
  t.append(ex("2026-11-09T05:00:00Z", "Shortlist CRM tools for a 20-person sales team", "HubSpot, Pipedrive, Attio, Close, Salesforce"));
  // filler so the early exchanges fall out of the recent window
  for (let i = 0; i < 14; i++) t.append(ex(`2026-11-10T0${i % 10}:00:00Z`, `Unrelated question number ${i} about baking`));
  return t;
}

test("window start moves in steps so the cached prefix stays stable", () => {
  assert.equal(windowStart(5), 0);
  assert.equal(windowStart(12), 0);
  assert.equal(windowStart(13), 6);
  assert.equal(windowStart(18), 6);
  assert.equal(windowStart(19), 12);
});

test("asking about a date recalls what was asked that day, even out of the window", () => {
  const ctx = buildTurnContext(seeded(), "What did I ask you on 3 November? Is it still correct?", NOW, TZ);
  const qs = ctx.recalled.map((r) => r.question);
  assert.ok(qs.some((q) => q.includes("Postgres hosting")));
  assert.ok(qs.some((q) => q.includes("name for a cat")));
  assert.match(ctx.preamble, /"on 3 November" → Tue, 3 Nov 2026: 2 exchange\(s\) on record/);
  assert.match(ctx.preamble, /Neon starts at \$19\/mo/);
});

test("topic recall by keyword when the date is wrong or missing", () => {
  // Said on Wed 11 Nov: "last Tuesday" = 10 Nov (only baking) or 3 Nov (Postgres).
  const ctx = buildTurnContext(seeded(), "Last Tuesday I asked you about Postgres hosting. Has pricing changed?", NOW, TZ);
  assert.ok(ctx.recalled.some((r) => r.question.includes("Postgres")));
  assert.equal(ctx.dateRefs.length, 2);
});

test("dates with no conversation are flagged explicitly (so the model can't invent one)", () => {
  const ctx = buildTurnContext(seeded(), "what did I ask on 1 November?", NOW, TZ);
  assert.match(ctx.preamble, /NO conversation on record for this date/);
});

test("older questions appear in the timeline index; recent ones as timestamped turns", () => {
  const t = seeded();
  const ctx = buildTurnContext(t, "hi", NOW, TZ);
  assert.match(ctx.timelineBlock, /Tue, 3 Nov 2026, 14:02 — Compare Neon, Supabase and RDS/);
  assert.equal(ctx.history.length, (t.exchanges.length - windowStart(t.exchanges.length)) * 2);
  assert.match(String(ctx.history[0].content), /^\[\w{3}, \d+ Nov 2026, \d\d:\d\d\]\n/);
});

test("timeline survives a restart (JSONL on disk)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-test-"));
  const file = path.join(dir, "u.jsonl");
  const a = new Timeline(file);
  a.append(ex("2026-11-03T08:32:00Z", "Postgres hosting prices?"));
  fs.appendFileSync(file, '{"torn": '); // simulate a crash mid-write
  const b = new Timeline(file);
  assert.equal(b.exchanges.length, 1);
  assert.equal(b.index.search("postgres", 3)[0].id, 0);
});
