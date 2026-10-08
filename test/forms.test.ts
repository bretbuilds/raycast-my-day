import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockRange,
  parseClock,
  parseDuration,
  reminderDueFields,
  validateBlock,
  validateEvent,
  validateReminder,
} from "../src/lib/forms.ts";
import type { CalendarInfo } from "../src/lib/eventkit-protocol.ts";

const cal = (id: string, writable = true): CalendarInfo => ({
  id,
  title: id,
  kind: "event",
  color: null,
  source: "s",
  sourceType: "caldav",
  allowsModifications: writable,
  isImmutable: false,
  isSubscribed: false,
  calendarType: "caldav",
});

test("A-B-1 event validation: title, writable calendar, time range", () => {
  const start = new Date(2026, 9, 2, 10, 0);
  const ok = validateEvent(
    { title: "x", calendarId: "w", isAllDay: false, day: null, start, end: new Date(2026, 9, 2, 10, 30) },
    [cal("w"), cal("ro", false)],
  );
  assert.deepEqual(ok, {});
  const bad = validateEvent(
    { title: " ", calendarId: "ro", isAllDay: false, day: null, start, end: start, url: "javascript:alert(1)" },
    [cal("w"), cal("ro", false)],
  );
  assert.equal(bad.title, "Title is required");
  assert.ok(bad.calendarId?.includes("read-only"));
  assert.equal(bad.end, "End must be after start");
  assert.ok(bad.url);
  const allDay = validateEvent({ title: "x", calendarId: "w", isAllDay: true, day: null, start: null, end: null }, [
    cal("w"),
  ]);
  assert.equal(allDay.day, "Choose a day");
});

test("A-B-2 reminder due semantics: none, date only, date with time", () => {
  const due = new Date(2026, 9, 2, 14, 5);
  assert.deepEqual(reminderDueFields({ title: "t", listId: "l", dueMode: "none", due }), {
    dueDay: null,
    dueTime: null,
  });
  assert.deepEqual(reminderDueFields({ title: "t", listId: "l", dueMode: "date", due }), {
    dueDay: "2026-10-02",
    dueTime: null,
  });
  assert.deepEqual(reminderDueFields({ title: "t", listId: "l", dueMode: "datetime", due }), {
    dueDay: "2026-10-02",
    dueTime: "14:05",
  });
  const e = validateReminder({ title: "", listId: "l", dueMode: "date", due: null }, [
    { ...cal("l"), kind: "reminder" },
  ]);
  assert.equal(e.title, "Title is required");
  assert.equal(e.dueDate, "Choose a date");
  assert.deepEqual(
    validateReminder({ title: "t", listId: "l", dueMode: "none", due: null }, [{ ...cal("l"), kind: "reminder" }]),
    {},
  );
});

test("A-B-5 block range and validation; DST day keeps calendar fields", () => {
  const { start, end } = blockRange({ day: "2026-11-01", startHour: 9, startMinute: 30, durationMinutes: 45 });
  assert.equal(start.getHours(), 9);
  assert.equal(start.getMinutes(), 30);
  assert.equal(end.getTime() - start.getTime(), 45 * 60_000);
  assert.equal(
    validateBlock({ day: "2026-11-01", startHour: 9, startMinute: 30, durationMinutes: 45 }).duration,
    undefined,
  );
  assert.ok(validateBlock({ day: "2026-11-01", startHour: 9, startMinute: 30, durationMinutes: 2 }).duration);
});

test("clock and duration parsing", () => {
  assert.deepEqual(parseClock("9:30"), { hour: 9, minute: 30 });
  assert.deepEqual(parseClock("2pm"), { hour: 14, minute: 0 });
  assert.deepEqual(parseClock("12 am"), { hour: 0, minute: 0 });
  assert.deepEqual(parseClock("14h"), { hour: 14, minute: 0 });
  assert.equal(parseClock("25:00"), null);
  assert.equal(parseDuration("30"), 30);
  assert.equal(parseDuration("1h30"), 90);
  assert.equal(parseDuration("1:15"), 75);
  assert.equal(parseDuration("2 hours"), 120);
  assert.equal(parseDuration("soon"), null);
});

test("durations accept days for multi-day timed events; all-day end date must not be before the start", async () => {
  const { parseDuration, validateEvent } = await import("../src/lib/forms.ts");
  assert.equal(parseDuration("2d"), 2880);
  assert.equal(parseDuration("2 days"), 2880);
  assert.equal(parseDuration("1d 4h"), 1680);
  assert.equal(parseDuration("1d4h30"), 1710);
  assert.equal(parseDuration("1h30"), 90);
  const cal = { id: "c", title: "Work", allowsModifications: true } as never;
  const base = { title: "Trip", calendarId: "c", isAllDay: true, day: "2026-10-28", start: null, end: null };
  assert.deepEqual(validateEvent({ ...base, endDay: "2026-11-19" }, [cal]), {});
  assert.ok(validateEvent({ ...base, endDay: "2026-10-27" }, [cal]).endDay);
});
