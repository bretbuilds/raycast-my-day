import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  allDayEventOnDay,
  dayKeyOf,
  dayWindow,
  formatDay,
  isDayKey,
  overlaps,
  relativeDay,
  timedEventOnDay,
  nextQuarterHour,
} from "../src/lib/dates.ts";

test("A-D-5 day keys come from the local zone, not UTC", () => {
  // 2026-10-02T03:30Z is 23:30 on Oct 1 in Toronto and 05:30 on Oct 2 in Berlin.
  const instant = new Date("2026-10-02T03:30:00Z");
  assert.equal(dayKeyOf(instant, "America/Toronto"), "2026-10-01");
  assert.equal(dayKeyOf(instant, "Europe/Berlin"), "2026-10-02");
  assert.equal(dayKeyOf(instant, "UTC"), "2026-10-02");
});

test("A-D-5 DST transition days are single days and arithmetic is calendar-based", () => {
  // North America fall-back 2026-11-01 (25-hour day in Toronto).
  assert.equal(addDays("2026-11-01", 1), "2026-11-02");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09"); // spring-forward
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  const w = dayWindow("2026-11-01");
  assert.equal(w.from.getDate(), 1);
  assert.equal(w.to.getDate(), 2);
  assert.equal(w.to.getHours(), 0);
});

test("A-D-8 a timed appointment keeps its instant and shows on the local day of the viewing zone", () => {
  const start = "2026-10-02T23:30:00Z"; // 19:30 Toronto, 01:30 next day Berlin
  const end = "2026-10-03T00:30:00Z";
  assert.ok(timedEventOnDay(start, end, "2026-10-02", "America/Toronto"));
  assert.ok(!timedEventOnDay(start, end, "2026-10-02", "Europe/Berlin"));
  assert.ok(timedEventOnDay(start, end, "2026-10-03", "Europe/Berlin"));
  // Event ending exactly at midnight does not spill into the next day.
  assert.ok(!timedEventOnDay("2026-10-02T22:00:00Z", "2026-10-03T04:00:00Z", "2026-10-03", "America/Toronto"));
  // Multi-day event appears on each day it covers.
  assert.ok(timedEventOnDay("2026-10-01T12:00:00Z", "2026-10-04T12:00:00Z", "2026-10-02", "America/Toronto"));
});

test("A-D-7 all-day events and day assignments are plain calendar dates", () => {
  assert.ok(allDayEventOnDay("2026-10-02", "2026-10-02", "2026-10-02"));
  assert.ok(allDayEventOnDay("2026-10-01", "2026-10-03", "2026-10-02"));
  assert.ok(!allDayEventOnDay("2026-10-03", "2026-10-03", "2026-10-02"));
});

test("formatting and validation", () => {
  assert.equal(formatDay("2026-10-02"), "Fri 2 Oct 2026");
  assert.equal(relativeDay("2026-10-03", "2026-10-02"), "Tomorrow");
  assert.equal(relativeDay("2026-10-01", "2026-10-02"), "Yesterday");
  assert.ok(isDayKey("2026-02-28") && !isDayKey("2026-02-30") && !isDayKey("2026-2-3"));
  assert.ok(overlaps("2026-10-02T13:00:00Z", "2026-10-02T14:00:00Z", "2026-10-02T13:30:00Z", "2026-10-02T15:00:00Z"));
  assert.ok(!overlaps("2026-10-02T13:00:00Z", "2026-10-02T14:00:00Z", "2026-10-02T14:00:00Z", "2026-10-02T15:00:00Z"));
  const q = nextQuarterHour(new Date(2026, 9, 2, 14, 7));
  assert.equal(q.getMinutes(), 15);
  assert.equal(nextQuarterHour(new Date(2026, 9, 2, 14, 45)).getMinutes(), 45);
});
