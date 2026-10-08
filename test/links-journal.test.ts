import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLink, linkIdFromNotes, notesWithMarker, notesWithoutMarker } from "../src/lib/links.ts";
import { beginWrite, reconcilePending, recordCreatedBlock } from "../src/lib/journal.ts";
import { emptyState, type PendingWrite } from "../src/lib/state.ts";
import type { EventInfo, Parsed, ReminderInfo } from "../src/lib/eventkit-protocol.ts";

const ev = (p: Partial<EventInfo> & { itemId: string }): EventInfo => ({
  eventId: p.itemId,
  externalId: null,
  occurrenceDate: null,
  calendarId: "c1",
  title: "Block",
  start: "2026-10-02T13:00:00Z",
  end: "2026-10-02T13:30:00Z",
  startDay: "2026-10-02",
  endDay: "2026-10-02",
  isAllDay: false,
  isRecurring: false,
  isDetached: false,
  location: null,
  notes: null,
  url: null,
  status: "confirmed",
  availability: "busy",
  hasAttendees: false,
  organizer: null,
  lastModified: "2026-10-02T12:00:00Z",
  timeZone: null,
  alarmMinutes: [],
  allowsModifications: true,
  ...p,
});

test("D-009 marker round trip and removal for display", () => {
  const notes = notesWithMarker("Prep slides\n", "lk-abcd1234");
  assert.equal(notes, "Prep slides\n\nMy Day link: lk-abcd1234");
  assert.equal(linkIdFromNotes(notes), "lk-abcd1234");
  assert.equal(linkIdFromNotes("random My Day link: lk-abcd1234 in the middle"), null);
  assert.equal(notesWithoutMarker(notes), "Prep slides");
  assert.equal(notesWithMarker(undefined, "lk-abcd1234"), "My Day link: lk-abcd1234");
});

test("A-B-9 link check reports missing and externally edited blocks", () => {
  const link = {
    source: { kind: "task" as const, taskId: "t-aaaa0001", checklistId: "cl-aaaa0001", title: "T" },
    eventId: "e1",
    externalId: null,
    calendarId: "c1",
    snapshot: {
      title: "Block",
      start: "2026-10-02T13:00:00Z",
      end: "2026-10-02T13:30:00Z",
      lastModified: "2026-10-02T12:00:00Z",
    },
    createdAt: "",
  };
  assert.equal(checkLink(link, null).status, "missing");
  assert.equal(checkLink(link, ev({ itemId: "e1" })).status, "ok");
  const moved = checkLink(link, ev({ itemId: "e1", start: "2026-10-02T14:00:00Z", end: "2026-10-02T14:30:00Z" }));
  assert.equal(moved.status, "edited-externally");
  if (moved.status === "edited-externally") assert.deepEqual(moved.changes, ["start", "end"]);
  const notesOnly = checkLink(link, ev({ itemId: "e1", lastModified: "2026-10-02T12:30:00Z" }));
  assert.equal(notesOnly.status, "edited-externally");
});

function api(events: EventInfo[], reminders: ReminderInfo[] = []) {
  const calls: string[] = [];
  return {
    calls,
    async listEvents(): Promise<Parsed<EventInfo[]>> {
      calls.push("events");
      return { ok: true, value: events };
    },
    async listReminders(): Promise<Parsed<ReminderInfo[]>> {
      calls.push("reminders");
      return { ok: true, value: reminders };
    },
  };
}

const pending = (startedAt: string): PendingWrite => ({
  kind: "create-event",
  startedAt,
  probe: {
    title: "Block",
    calendarId: "c1",
    start: "2026-10-02T13:00:00Z",
    end: "2026-10-02T13:30:00Z",
    linkId: "lk-pend0001",
  },
  link: { source: { kind: "task", taskId: "t-aaaa0001", checklistId: "cl-aaaa0001", title: "T" }, calendarId: "c1" },
});

test("A-B-10/A-B-11 an ambiguous event write is found by its marker and recorded exactly once", async () => {
  const state = emptyState();
  beginWrite(state, "tok1", pending("2026-10-02T13:00:00Z"));
  const found = ev({ itemId: "e-found", notes: "My Day link: lk-pend0001" });
  const out = await reconcilePending(state, api([ev({ itemId: "other" }), found]), new Date("2026-10-02T13:05:00Z"));
  assert.equal(out[0].result, "found-and-recorded");
  assert.equal(state.links["lk-pend0001"].eventId, "e-found");
  assert.deepEqual(state.pendingWrites, {});
  // Running again does nothing (no duplicate link, no second write).
  const again = await reconcilePending(state, api([found]));
  assert.deepEqual(again, []);
  assert.equal(Object.keys(state.links).length, 1);
});

test("A-B-10 a write that never happened is dropped and reported; an unavailable source keeps it pending", async () => {
  const state = emptyState();
  beginWrite(state, "tok2", pending("2026-10-02T13:00:00Z"));
  const out = await reconcilePending(state, api([]), new Date("2026-10-02T13:05:00Z"));
  assert.equal(out[0].result, "not-found-dropped");
  assert.deepEqual(state.pendingWrites, {});
  beginWrite(state, "tok3", pending("2026-10-02T13:00:00Z"));
  const failing = {
    async listEvents(): Promise<Parsed<EventInfo[]>> {
      return { ok: false, failure: { kind: "timeout", detail: "x" } };
    },
    async listReminders(): Promise<Parsed<ReminderInfo[]>> {
      return { ok: true, value: [] };
    },
  };
  const out2 = await reconcilePending(state, failing);
  assert.equal(out2[0].result, "still-pending");
  assert.ok(state.pendingWrites.tok3);
});

test("recordCreatedBlock stores the snapshot and clears the journal", () => {
  const state = emptyState();
  const p = pending("2026-10-02T13:00:00Z");
  beginWrite(state, "tok4", p);
  const link = recordCreatedBlock(state, "tok4", "lk-pend0001", p, ev({ itemId: "e9", externalId: "x9" }));
  assert.equal(link.externalId, "x9");
  assert.equal(link.snapshot.start, "2026-10-02T13:00:00Z");
  assert.deepEqual(state.pendingWrites, {});
});

test("A-B-10 a plain event write (no marker) is confirmed by calendar, title and exact times", async () => {
  const state = emptyState();
  const plain: PendingWrite = {
    kind: "create-event",
    startedAt: "2026-10-02T13:00:00Z",
    probe: { title: "Dentist", calendarId: "c1", start: "2026-10-02T15:00:00Z", end: "2026-10-02T15:30:00Z" },
  };
  beginWrite(state, "tok5", plain);
  const match = ev({
    itemId: "e-dentist",
    title: "Dentist",
    start: "2026-10-02T15:00:00Z",
    end: "2026-10-02T15:30:00Z",
  });
  const out = await reconcilePending(state, api([ev({ itemId: "other", title: "Dentist" }), match]));
  assert.equal(out[0].result, "found-and-recorded");
  assert.deepEqual(state.pendingWrites, {});
  assert.deepEqual(state.links, {});
  beginWrite(state, "tok6", plain);
  const out2 = await reconcilePending(state, api([]), new Date("2026-10-02T13:05:00Z"));
  assert.equal(out2[0].result, "not-found-dropped");
});
