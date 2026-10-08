import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCountdown,
  formatRange,
  freeGaps,
  freeMinutes,
  nextItem,
  quickDuration,
  shortDate,
} from "../src/lib/timeline.ts";
import type { Agenda } from "../src/lib/agenda.ts";

const F = " ";
const at = (h: number, m = 0) => new Date(2026, 9, 4, h, m);
const iso = (h: number, m = 0) => at(h, m).toISOString();

test("ranges have one stable shape: both times carry AM/PM, hours padded with a figure space", () => {
  assert.equal(formatRange(at(9), at(10, 30), false), `${F}9:00 AM – 10:30 AM`);
  assert.equal(formatRange(at(11, 30), at(13), false), `11:30 AM – ${F}1:00 PM`);
  assert.equal(formatRange(at(14, 15), at(14, 45), false), `${F}2:15 PM – ${F}2:45 PM`);
  assert.equal(formatRange(at(9), at(10, 30), true), "09:00 – 10:30");
  assert.equal(formatRange(at(16), null, false), `${F}4:00 PM`);
  assert.equal(shortDate("2026-10-01"), "Thu 1 Oct");
  assert.equal(shortDate("2026-10-28"), "Wed 28 Oct");
});

test("free gaps fill the working day around busy events, ignore free-marked events, and start from now today", () => {
  const busy = [
    { start: iso(10), end: iso(11) },
    { start: iso(10, 30), end: iso(12) }, // overlaps: merged
    { start: iso(14), end: iso(14, 10), availability: "free" }, // does not block
    { start: iso(15), end: iso(15, 10) },
  ];
  const yesterdayNow = new Date(2026, 9, 3, 12);
  const gaps = freeGaps(busy, "2026-10-04", yesterdayNow, 9, 18);
  assert.deepEqual(
    gaps.map((g) => [g.start.getHours(), g.start.getMinutes(), g.minutes]),
    [
      [9, 0, 60],
      [12, 0, 180],
      [15, 10, 170],
    ],
  );
  const today = freeGaps(busy, "2026-10-04", at(12, 2), 9, 18);
  assert.equal(today[0].start.getMinutes(), 5); // 12:02 rounds up to 12:05
  assert.deepEqual(freeGaps(busy, "2026-10-04", at(19), 9, 18), []);
  assert.deepEqual(freeGaps([{ start: iso(9), end: iso(9, 50) }], "2026-10-04", yesterdayNow, 9, 10).length, 0); // 10 min < 15
});

test("quick block length: estimate, else one hour, capped by the gap", () => {
  assert.equal(quickDuration(null, 120), 60);
  assert.equal(quickDuration(null, 45), 45);
  assert.equal(quickDuration(90, 120), 90);
  assert.equal(quickDuration(90, 45), 45);
});

test("next item: ongoing first, then the soonest event, block or timed reminder; countdown text", () => {
  const a = {
    day: "2026-10-04",
    schedule: [
      { id: "e1", event: { title: "Past", start: iso(9), end: iso(10) }, link: null },
      { id: "b1", event: { title: "Block", start: iso(14, 15), end: iso(14, 45) }, link: { id: "lk" } },
    ],
    dueToday: [{ id: "r1", reminder: { title: "Call", dueHasTime: true, dueDateTime: iso(14) } }],
  } as unknown as Agenda;
  const n = nextItem(a, at(13, 30))!;
  assert.equal(n.id, "r1");
  assert.equal(n.countdown, "due in 30 min");
  const ongoing = nextItem(a, at(14, 20))!;
  assert.equal(ongoing.id, "b1");
  assert.equal(ongoing.kind, "block");
  assert.equal(ongoing.countdown, "now · 25 min left");
  assert.equal(nextItem(a, at(15)), null);
  assert.equal(formatCountdown(150 * 60_000), "2 h 30 min");
});

test("free minutes add up the gaps", () => {
  const gaps = freeGaps([{ start: iso(10), end: iso(11) }], "2026-10-04", new Date(2026, 9, 3), 9, 12);
  assert.equal(freeMinutes(gaps), 120);
});

test("section header dates read like My Schedule, without the year", async () => {
  const { longDate } = await import("../src/lib/timeline.ts");
  assert.equal(longDate("2026-10-05"), "Monday, Oct 5");
  assert.equal(longDate("2026-10-06"), "Tuesday, Oct 6");
});
