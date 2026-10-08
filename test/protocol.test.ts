import { test } from "node:test";
import assert from "node:assert/strict";
import { failureText, parseCalendars, parseEvents, parseReminders, parseStatus } from "../src/lib/eventkit-protocol.ts";

test("A-M1-3 denied, not-determined and write-only are distinct failures, never empty data", () => {
  for (const code of ["denied", "not-determined", "write-only", "restricted"]) {
    const r = parseEvents(JSON.stringify({ schema: 1, ok: false, code, message: "m" }));
    assert.ok(!r.ok);
    if (r.ok) return;
    assert.equal(r.failure.kind, "helper");
    assert.ok(failureText(r.failure).title.length > 0);
  }
  const empty = parseEvents(JSON.stringify({ schema: 1, ok: true, events: [] }));
  assert.ok(empty.ok && empty.value.length === 0);
});

test("schema mismatch and malformed JSON are bad-output", () => {
  assert.equal(parseStatus("not json").ok, false);
  const r = parseStatus(JSON.stringify({ schema: 2, ok: true }));
  assert.ok(!r.ok && r.failure.kind === "bad-output");
});

test("calendars with partial access report null for the missing side", () => {
  const r = parseCalendars(
    JSON.stringify({
      schema: 1,
      ok: true,
      eventCalendars: [
        {
          id: "c1",
          title: "Work",
          kind: "event",
          color: "#FF0000",
          source: "iCloud",
          sourceType: "caldav",
          allowsModifications: true,
          isImmutable: false,
          isSubscribed: false,
          calendarType: "caldav",
        },
      ],
      reminderLists: null,
      eventsAccess: "full-access",
      remindersAccess: "denied",
    }),
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.reminderLists, null);
  assert.equal(r.value.eventCalendars?.[0].color, "#FF0000");
  assert.equal(r.value.remindersAccess, "denied");
});

test("reminders keep date-only vs timed distinction and drop malformed entries", () => {
  const r = parseReminders(
    JSON.stringify({
      schema: 1,
      ok: true,
      reminders: [
        {
          itemId: "r1",
          listId: "l",
          title: "x",
          dueDay: "2026-10-02",
          dueDateTime: null,
          dueHasTime: false,
          isCompleted: false,
          priority: 0,
        },
        { nope: true },
      ],
    }),
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.length, 1);
  assert.equal(r.value[0].dueHasTime, false);
});
