import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accessFailure,
  acceptCalendarVersion,
  buildKeywords,
  calendarEventUrl,
  findLinkedEvent,
  KEYWORD_NOTES_LIMIT,
  reminderUrl,
  showsSource,
  verifyLinks,
} from "../src/lib/agenda-rows.ts";
import type { EventInfo } from "../src/lib/eventkit-protocol.ts";
import { failureText } from "../src/lib/eventkit-protocol.ts";
import { localDateTime } from "../src/lib/dates.ts";
import { markerLine } from "../src/lib/links.ts";
import { emptyState, type Link } from "../src/lib/state.ts";

const DAY = "2026-10-02";
const at = (h: number, m = 0) => localDateTime(DAY, h, m).toISOString();

const ev = (p: Partial<EventInfo> & { itemId: string }): EventInfo => ({
  eventId: p.itemId,
  externalId: null,
  occurrenceDate: null,
  calendarId: "c1",
  title: "Focus",
  start: at(9),
  end: at(10),
  startDay: DAY,
  endDay: DAY,
  isAllDay: false,
  isRecurring: false,
  isDetached: false,
  location: null,
  notes: null,
  url: null,
  status: "none",
  availability: "busy",
  hasAttendees: false,
  organizer: null,
  lastModified: null,
  timeZone: null,
  alarmMinutes: [],
  allowsModifications: true,
  ...p,
});

const link = (p: Partial<Link> = {}): Link => ({
  source: { kind: "reminder", itemId: "r1", externalId: null, title: "Write report" },
  eventId: "e1",
  externalId: null,
  calendarId: "c1",
  snapshot: { title: "Focus", start: at(9), end: at(10), lastModified: null },
  createdAt: at(8),
  ...p,
});

test("A-A-8 keywords: whole strings and words; notes limited to the first 500 characters", () => {
  const long = "a".repeat(KEYWORD_NOTES_LIMIT - 5) + " zzzzz-tail beyond";
  const k = buildKeywords(["Weekly sync", null, "Room 4, Building B"], [long]);
  assert.ok(k.includes("Weekly sync"));
  assert.ok(k.includes("sync"));
  assert.ok(k.includes("Building"));
  assert.ok(!k.some((w) => w.includes("beyond")), "text after 500 characters is not searchable");
  assert.ok(!k.includes(""), "no empty keywords");
});

test("open-in-app URLs carry identifiers only and refuse anything else", () => {
  const e = ev({ itemId: "ABC-123:XYZ", start: localDateTime("2026-10-05", 9, 0).toISOString() });
  assert.equal(calendarEventUrl(e), "ical://ekevent/20261005/ABC-123:XYZ?method=show&options=more");
  const occ = ev({ itemId: "R1", occurrenceDate: localDateTime("2026-10-07", 9, 0).toISOString() });
  assert.match(calendarEventUrl(occ)!, /^ical:\/\/ekevent\/20261007\/R1\?/);
  assert.equal(calendarEventUrl(ev({ itemId: "bad id&x=1" })), null);
  assert.equal(reminderUrl("x-coredata://1/REM/p2"), null);
  assert.equal(reminderUrl("5A1B-2C3D"), "x-apple-reminderkit://REMCDReminder/5A1B-2C3D");
});

test("A-A-9 access states map to distinct helper failures, never 'no items'", () => {
  for (const s of ["denied", "not-determined", "write-only", "restricted"] as const) {
    const f = accessFailure(s, "events");
    assert.equal(f.code, s);
    assert.notEqual(failureText(f).title, "");
  }
  assert.equal(failureText(accessFailure("denied", "reminders")).title, "Access denied");
});

test("source filter", () => {
  assert.ok(showsSource("all", "events"));
  assert.ok(showsSource("tasks", "tasks"));
  assert.ok(!showsSource("events", "reminders"));
});

test("A-B-9 verifyLinks: ok, edited externally, found by marker, missing on its day, unavailable source", () => {
  const state = emptyState();
  state.links["lk-aaaa0001"] = link();
  state.links["lk-aaaa0002"] = link({ eventId: "e2" });
  state.links["lk-aaaa0003"] = link({ eventId: "gone" });
  state.links["lk-aaaa0004"] = link({
    eventId: "other-day",
    snapshot: {
      title: "x",
      start: localDateTime("2026-10-09", 9, 0).toISOString(),
      end: localDateTime("2026-10-09", 10, 0).toISOString(),
      lastModified: null,
    },
  });
  state.links["lk-aaaa0005"] = link({ eventId: "old-id" });
  const events = [
    ev({ itemId: "e1" }),
    ev({ itemId: "e2", title: "Renamed in Calendar" }),
    ev({ itemId: "new-id", notes: `hi\n\n${markerLine("lk-aaaa0005")}` }),
  ];
  const now = new Date(at(12));
  const v = verifyLinks(state, events, DAY, now);
  assert.deepEqual(v.edited, { "lk-aaaa0002": ["title"] });
  assert.deepEqual(
    v.missing.map(([id]) => id),
    ["lk-aaaa0003"],
  );
  assert.equal(state.links["lk-aaaa0003"].missingSince, now.toISOString());
  assert.equal(state.links["lk-aaaa0004"].missingSince, undefined, "a block on another day is not judged");
  assert.ok(v.changed);
  assert.equal(findLinkedEvent("lk-aaaa0005", state.links["lk-aaaa0005"], events)?.itemId, "new-id");

  // Second pass is idempotent: missingSince stays, nothing new to save.
  const again = verifyLinks(state, events, DAY, new Date(at(13)));
  assert.equal(again.changed, false);
  assert.equal(state.links["lk-aaaa0003"].missingSince, now.toISOString());

  // A failed read concludes nothing.
  const none = verifyLinks(state, null, DAY);
  assert.deepEqual(none, { edited: {}, missing: [], changed: false });

  // The block reappears (e.g. sync caught up): missingSince is cleared.
  const back = verifyLinks(state, [...events, ev({ itemId: "gone" })], DAY);
  assert.ok(back.changed);
  assert.equal(state.links["lk-aaaa0003"].missingSince, undefined);

  acceptCalendarVersion(state.links["lk-aaaa0002"], events[1]);
  assert.deepEqual(verifyLinks(state, events, DAY).edited, {});
});
