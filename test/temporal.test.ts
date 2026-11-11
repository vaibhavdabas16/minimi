import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDateRefs } from "../src/temporal.js";

// Wednesday 11 Nov 2026, 17:00 in Bengaluru
const NOW = new Date("2026-11-11T11:30:00Z");
const TZ = "Asia/Kolkata";
const labels = (q: string, tz = TZ) => resolveDateRefs(q, NOW, tz).map((r) => r.label);

test("explicit day without a year resolves to the most recent past one", () => {
  const [r] = resolveDateRefs("What did I ask you on 3 November?", NOW, TZ);
  assert.equal(r.label, "Tue, 3 Nov 2026");
  // the local day in IST, as UTC instants
  assert.equal(r.start.toISOString(), "2026-11-02T18:30:00.000Z");
  assert.equal(r.end.toISOString(), "2026-11-03T18:30:00.000Z");
  assert.deepEqual(labels("on 25 December"), ["Thu, 25 Dec 2025"]);
});

test("'last Tuesday' on a Wednesday is ambiguous: both readings are offered", () => {
  assert.deepEqual(labels("Last Tuesday I asked you about Postgres hosting"), [
    "Tue, 10 Nov 2026",
    "Tue, 3 Nov 2026 (alternative reading)",
  ]);
});

test("weekdays, yesterday and N days ago", () => {
  assert.deepEqual(labels("On Monday we shortlisted 5 CRM tools"), ["Mon, 9 Nov 2026"]);
  assert.deepEqual(labels("what about Friday?"), ["Fri, 6 Nov 2026"]);
  assert.deepEqual(labels("what did we talk about yesterday"), ["Tue, 10 Nov 2026"]);
  assert.deepEqual(labels("2 days ago"), ["Mon, 9 Nov 2026"]);
});

test("spans: last week, this week, a month", () => {
  assert.deepEqual(labels("anything I asked last week"), ["Mon, 2 Nov 2026 – Sun, 8 Nov 2026"]);
  assert.deepEqual(labels("so far this week"), ["Mon, 9 Nov 2026 – Wed, 11 Nov 2026"]);
  assert.deepEqual(labels("in October"), ["Thu, 1 Oct 2026 – Sat, 31 Oct 2026"]);
});

test("future and time-only references are ignored", () => {
  assert.deepEqual(labels("remind me next Friday"), []);
  assert.deepEqual(labels("meet at 5pm"), []);
  assert.deepEqual(labels("what is the capital of France"), []);
});

test("day boundaries follow the user's timezone", () => {
  // 11 Nov 05:00Z is 10:30 on 11 Nov in Bengaluru but 21:00 on 10 Nov in Los Angeles.
  const early = new Date("2026-11-11T05:00:00Z");
  assert.equal(resolveDateRefs("yesterday", early, TZ)[0].label, "Tue, 10 Nov 2026");
  const [r] = resolveDateRefs("yesterday", early, "America/Los_Angeles");
  assert.equal(r.label, "Mon, 9 Nov 2026");
  assert.equal(r.start.toISOString(), "2026-11-09T08:00:00.000Z");
});
