import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertMinutes,
  dayCounts,
  daySummary,
  describeAlerts,
  greeting,
  nextUp,
  parseTimeValue,
  spanLabel,
  timeOptions,
} from "../src/lib/summary.ts";
import { formatClock, setClock24 } from "../src/lib/dates.ts";
import type { Agenda, EventRow } from "../src/lib/agenda.ts";

const emptyAgenda = (day: string): Agenda => ({
  day,
  overdue: [],
  allDay: [],
  schedule: [],
  dueToday: [],
  tasks: [],
  main: null,
  supporting: [],
  picked: [],
  pinned: [],
  failures: [],
  otherReminders: [],
});
const row = (start: Date, end: Date, title: string, link = false): EventRow =>
  ({
    kind: "event",
    id: title,
    event: { title, start: start.toISOString(), end: end.toISOString() },
    calendar: null,
    link: link ? { id: "lk-x", link: {} } : null,
  }) as unknown as EventRow;

test("greeting follows the local hour", () => {
  assert.equal(greeting(new Date(2026, 9, 4, 9)), "Good morning");
  assert.equal(greeting(new Date(2026, 9, 4, 14)), "Good afternoon");
  assert.equal(greeting(new Date(2026, 9, 4, 20)), "Good evening");
});

test("day summary counts only non-empty sources and separates work blocks", () => {
  const a = emptyAgenda("2026-10-04");
  assert.equal(daySummary(a), "Nothing planned yet");
  const now = new Date(2026, 9, 4, 9);
  a.schedule = [row(now, new Date(2026, 9, 4, 10), "A"), row(now, new Date(2026, 9, 4, 10), "B", true)];
  a.overdue = [{} as never];
  assert.equal(daySummary(a), "1 event · 1 work block · 1 overdue");
});

test("next up shows the ongoing item, then the next one; never on another day", () => {
  setClock24(true);
  const a = emptyAgenda("2026-10-04");
  a.schedule = [
    row(new Date(2026, 9, 4, 9), new Date(2026, 9, 4, 10), "Past"),
    row(new Date(2026, 9, 4, 14, 15), new Date(2026, 9, 4, 15), "Next"),
  ];
  assert.deepEqual(nextUp(a, new Date(2026, 9, 4, 13, 30)), {
    id: "Next",
    short: "next · in 45 min",
    title: "Next",
    label: "in 45 min at 14:15",
    isBlock: false,
  });
  assert.equal(nextUp(a, new Date(2026, 9, 4, 14, 30))?.label, "now, until 15:00");
  assert.equal(nextUp(a, new Date(2026, 9, 5, 9)), null);
});

test("multi-day spans show the range and the day number", () => {
  assert.equal(
    spanLabel({ isAllDay: true, start: "", end: "", startDay: "2026-10-28", endDay: "2026-11-19" }, "2026-10-30"),
    "Wed 28 Oct – Thu 19 Nov · day 3 of 23",
  );
  assert.equal(
    spanLabel({ isAllDay: true, start: "", end: "", startDay: "2026-10-28", endDay: "2026-10-28" }, "2026-10-28"),
    null,
  );
});

test("owner item 1: start times offer both clock styles and keep a stable 24-hour value", () => {
  const opts12 = timeOptions(15, undefined, false);
  assert.equal(opts12.length, 96);
  const twoThirty = opts12.find((o) => o.value === "14:30")!;
  assert.equal(twoThirty.title, "2:30 PM");
  assert.ok(twoThirty.keywords.includes("14:30") && twoThirty.keywords.includes("2:30pm"));
  assert.equal(timeOptions(15, undefined, true).find((o) => o.value === "00:00")!.title, "00:00");
  assert.equal(timeOptions(15, undefined, false)[0].title, "12:00 AM");
  assert.ok(timeOptions(15, { hour: 9, minute: 7 }).some((o) => o.value === "09:07"));
  assert.deepEqual(parseTimeValue("09:07"), { hour: 9, minute: 7 });
  assert.equal(formatClock(12, 5, false), "12:05 PM");
});

test("owner item 8: alert choices map to minutes; default leaves the calendar alone", () => {
  assert.equal(alertMinutes("default"), undefined);
  assert.deepEqual(alertMinutes("none"), []);
  assert.deepEqual(alertMinutes("30"), [30]);
  assert.equal(describeAlerts([0]), "At time of event");
  assert.equal(describeAlerts([]), "No alert");
});

test("header counts stay numeric so the row fits one line", () => {
  const a = emptyAgenda("2026-10-04");
  const now = new Date(2026, 9, 4, 9);
  a.schedule = [row(now, new Date(2026, 9, 4, 10), "A"), row(now, new Date(2026, 9, 4, 10), "B", true)];
  a.tasks = [{ checked: true } as never, { checked: false } as never];
  assert.deepEqual(dayCounts(a), { events: 1, blocks: 1, remindersDue: 0, overdue: 0, items: 2, itemsDone: 1 });
});

test("free until the next event; busy through overlapping and back-to-back events; clear when nothing is left", async () => {
  const { freeUntil } = await import("../src/lib/summary.ts");
  const at = (h: number, m = 0) => new Date(2026, 9, 5, h, m);
  const ev = (a: Date, b: Date) => ({ start: a.toISOString(), end: b.toISOString() });
  const events = [ev(at(9), at(10)), ev(at(10), at(10, 30)), ev(at(10, 15), at(11)), ev(at(14, 15), at(15))];
  assert.deepEqual(freeUntil(events, at(9, 30)), { kind: "busy", until: at(11) });
  assert.deepEqual(freeUntil(events, at(12, 45)), { kind: "free", until: at(14, 15), minutes: 90 });
  assert.deepEqual(freeUntil(events, at(16)), { kind: "clear" });
});

test("overdue label says how late a reminder is", async () => {
  const { overdueLabel } = await import("../src/lib/summary.ts");
  assert.equal(overdueLabel("2026-10-04", "2026-10-05", null), "1 day overdue");
  assert.equal(overdueLabel("2026-10-01", "2026-10-05", null), "4 days overdue");
  assert.match(overdueLabel("2026-10-05", "2026-10-05", new Date(2026, 9, 5, 9, 0)), /^overdue since 0?9:00/);
});
