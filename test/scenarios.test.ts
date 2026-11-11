import assert from "node:assert/strict";
import { test } from "node:test";
import { scenarios, TZ } from "../eval/scenarios.js";
import { localParts } from "../src/time.js";

test("eval scenarios are dated correctly for any 'today'", () => {
  // every day of a week, so weekday maths is exercised from each starting point
  for (let d = 0; d < 7; d++) {
    const now = new Date(Date.UTC(2026, 10, 9 + d, 6, 0));
    for (const sc of scenarios(now)) {
      let prev = 0;
      for (const t of sc.turns) {
        assert.ok(t.at.getTime() <= now.getTime(), `${sc.name}: turn in the future`);
        assert.ok(t.at.getTime() >= prev, `${sc.name}: turns out of order`);
        prev = t.at.getTime();
      }
    }
    const [pg] = scenarios(now);
    assert.equal(localParts(pg.turns[0].at, TZ).weekday, 2, "the 'last Tuesday' turn is on a Tuesday");
    const crm = scenarios(now).find((s) => s.name === "crm-remembered")!;
    assert.equal(localParts(crm.turns[0].at, TZ).weekday, 1, "the 'Monday' turn is on a Monday");
  }
});
