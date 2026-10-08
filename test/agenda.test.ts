import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgenda, overlappingEvents, selectedIds } from "../src/lib/agenda.ts";
import type { CalendarInfo, EventInfo, ReminderInfo } from "../src/lib/eventkit-protocol.ts";
import { assignDay, emptyState } from "../src/lib/state.ts";
import { createChecklist } from "../src/lib/store.ts";
import { allTasks } from "../src/lib/markdown.ts";

const cal = (id: string, title: string): CalendarInfo => ({
  id,
  title,
  kind: "event",
  color: "#112233",
  source: "iCloud",
  sourceType: "caldav",
  allowsModifications: true,
  isImmutable: false,
  isSubscribed: false,
  calendarType: "caldav",
});
const list = (id: string, title: string): CalendarInfo => ({ ...cal(id, title), kind: "reminder" });
const ev = (p: Partial<EventInfo> & { itemId: string; start: string; end: string; calendarId: string }): EventInfo => ({
  eventId: p.itemId,
  externalId: null,
  occurrenceDate: p.start,
  title: "Standup",
  startDay: p.start.slice(0, 10),
  endDay: p.end.slice(0, 10),
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
  lastModified: null,
  timeZone: "UTC",
  alarmMinutes: [],
  allowsModifications: true,
  ...p,
});
const rem = (p: Partial<ReminderInfo> & { itemId: string; listId: string }): ReminderInfo => ({
  externalId: null,
  title: "Standup",
  notes: null,
  url: null,
  dueDay: null,
  dueDateTime: null,
  dueHasTime: false,
  isCompleted: false,
  completionDate: null,
  priority: 0,
  isRecurring: false,
  lastModified: null,
  created: null,
  ...p,
});

const DAY = "2026-10-02";
const base = () => ({
  day: DAY,
  calendars: [cal("c1", "Work"), cal("c2", "Home")],
  lists: [list("l1", "Reminders")],
  checklists: [],
  state: emptyState(),
  failures: [],
  timeZone: "UTC" as const,
  today: DAY,
});

test("A-A-6 identical titles from different sources and calendars stay distinct rows", () => {
  const a = buildAgenda({
    ...base(),
    events: [
      ev({ itemId: "e1", start: "2026-10-02T09:00:00Z", end: "2026-10-02T09:30:00Z", calendarId: "c1" }),
      ev({ itemId: "e2", start: "2026-10-02T09:00:00Z", end: "2026-10-02T09:30:00Z", calendarId: "c2" }),
    ],
    reminders: [rem({ itemId: "r1", listId: "l1", dueDay: DAY })],
  });
  assert.equal(a.schedule.length, 2);
  assert.notEqual(a.schedule[0].id, a.schedule[1].id);
  assert.equal(a.schedule[0].calendar?.title, "Work");
  assert.equal(a.dueToday.length, 1);
  assert.equal(a.dueToday[0].id, "reminder:r1");
});

test("A-A-3 overdue, due today and other-day reminders are separated; completed are hidden; date-only sorts after timed", () => {
  const a = buildAgenda({
    ...base(),
    now: new Date(`${DAY}T08:00:00Z`),
    events: [],
    reminders: [
      rem({ itemId: "over", listId: "l1", dueDay: "2026-09-30" }),
      rem({ itemId: "today-any", listId: "l1", dueDay: DAY }),
      rem({ itemId: "today-timed", listId: "l1", dueDay: DAY, dueHasTime: true, dueDateTime: "2026-10-02T14:00:00Z" }),
      rem({ itemId: "later", listId: "l1", dueDay: "2026-10-05" }),
      rem({ itemId: "undated", listId: "l1" }),
      rem({ itemId: "done", listId: "l1", dueDay: DAY, isCompleted: true }),
    ],
  });
  assert.deepEqual(
    a.overdue.map((r) => r.reminder.itemId),
    ["over"],
  );
  assert.ok(a.overdue[0].overdue);
  assert.deepEqual(
    a.dueToday.map((r) => r.reminder.itemId),
    ["today-timed", "today-any"],
  );
  assert.deepEqual(
    a.otherReminders.map((r) => r.reminder.itemId),
    ["later", "undated"],
  );
});

test("A-A-4 source selection: null = all, [] = deliberately none, unknown ids ignored", () => {
  const events = [
    ev({ itemId: "e1", start: "2026-10-02T09:00:00Z", end: "2026-10-02T09:30:00Z", calendarId: "c1" }),
    ev({ itemId: "e2", start: "2026-10-02T10:00:00Z", end: "2026-10-02T10:30:00Z", calendarId: "c2" }),
  ];
  const all = buildAgenda({ ...base(), events, reminders: [] });
  assert.equal(all.schedule.length, 2);
  const none = base();
  none.state.sources.eventCalendarIds = [];
  assert.equal(buildAgenda({ ...none, events, reminders: [] }).schedule.length, 0);
  const some = base();
  some.state.sources.eventCalendarIds = ["c2", "ghost"];
  assert.deepEqual(
    buildAgenda({ ...some, events, reminders: [] }).schedule.map((r) => r.event.itemId),
    ["e2"],
  );
  assert.deepEqual([...selectedIds(["c2", "ghost"], some.calendars)!], ["c2"]);
});

test("A-A-9 a failed source keeps the others and is reported, never shown as empty", () => {
  const a = buildAgenda({
    ...base(),
    events: null,
    reminders: [rem({ itemId: "r1", listId: "l1", dueDay: DAY })],
    failures: [{ source: "events", failure: { kind: "helper", code: "denied", message: "no" } }],
  });
  assert.equal(a.failures.length, 1);
  assert.equal(a.dueToday.length, 1);
  assert.equal(a.schedule.length, 0);
});

test("A-A-2 all-day and multi-day events land on each covered local day; schedule is sorted by start", () => {
  const events = [
    ev({
      itemId: "allday",
      start: "2026-10-02T00:00:00Z",
      end: "2026-10-02T23:59:59Z",
      calendarId: "c1",
      isAllDay: true,
      startDay: DAY,
      endDay: DAY,
    }),
    ev({ itemId: "span", start: "2026-10-01T22:00:00Z", end: "2026-10-03T02:00:00Z", calendarId: "c1", title: "Trip" }),
    ev({ itemId: "late", start: "2026-10-02T15:00:00Z", end: "2026-10-02T16:00:00Z", calendarId: "c1" }),
    ev({ itemId: "early", start: "2026-10-02T08:00:00Z", end: "2026-10-02T08:30:00Z", calendarId: "c1" }),
    ev({ itemId: "tomorrow", start: "2026-10-03T08:00:00Z", end: "2026-10-03T08:30:00Z", calendarId: "c1" }),
  ];
  const a = buildAgenda({ ...base(), events, reminders: [] });
  assert.deepEqual(
    a.allDay.map((r) => r.event.itemId),
    ["allday"],
  );
  assert.deepEqual(
    a.schedule.map((r) => r.event.itemId),
    ["span", "early", "late"],
  );
});

test("A-A-5 assigned checklist tasks show checklist and parent context; pinned checklists always listed; vanished tasks flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "myday-agenda-"));
  const c = createChecklist(dir, "Launch", "- [ ] Parent ^t-agen0001\n  - [x] Child ^t-agen0002\n");
  const p = createChecklist(dir, "Pinned one");
  const pinned = { ...p, pinned: true };
  const state = emptyState();
  assignDay(state, "t-agen0002", c.id, DAY);
  assignDay(state, "t-agen0001", c.id, "2026-10-03");
  assignDay(state, "t-gone0001", c.id, DAY);
  state.estimates["t-agen0002"] = 45;
  const a = buildAgenda({ ...base(), events: [], reminders: [], checklists: [c, pinned], state });
  assert.equal(a.tasks.length, 2);
  const child = a.tasks.find((t) => t.taskId === "t-agen0002")!;
  assert.equal(child.title, "Child");
  assert.equal(child.checked, true);
  assert.deepEqual(child.parentChain, ["Parent"]);
  assert.equal(child.estimate, 45);
  assert.equal(child.checklist.title, "Launch");
  assert.ok(a.tasks.find((t) => t.taskId === "t-gone0001")!.missing);
  assert.deepEqual(
    a.pinned.map((x) => x.title),
    ["Pinned one"],
  );
  void allTasks;
});

test("A-B-7 linked blocks are recognised by stored id or by the notes marker", () => {
  const state = emptyState();
  state.links["lk-link0001"] = {
    source: { kind: "task", taskId: "t-agen0001", checklistId: "cl-agen0001", title: "Parent" },
    eventId: "old-id",
    externalId: "ext-1",
    calendarId: "c1",
    snapshot: { title: "Parent", start: "2026-10-02T09:00:00Z", end: "2026-10-02T09:30:00Z", lastModified: null },
    createdAt: "",
  };
  state.links["lk-link0002"] = {
    source: { kind: "reminder", itemId: "r9", externalId: null, title: "R" },
    eventId: "nope",
    externalId: null,
    calendarId: "c1",
    snapshot: { title: "R", start: "2026-10-02T11:00:00Z", end: "2026-10-02T11:30:00Z", lastModified: null },
    createdAt: "",
  };
  const events = [
    ev({
      itemId: "e1",
      eventId: "new-id",
      externalId: "ext-1",
      start: "2026-10-02T09:00:00Z",
      end: "2026-10-02T09:30:00Z",
      calendarId: "c1",
    }),
    ev({
      itemId: "e2",
      eventId: "e2",
      start: "2026-10-02T11:00:00Z",
      end: "2026-10-02T11:30:00Z",
      calendarId: "c1",
      notes: "Work on R\n\nMy Day link: lk-link0002",
    }),
    ev({
      itemId: "e3",
      eventId: "e3",
      start: "2026-10-02T12:00:00Z",
      end: "2026-10-02T12:30:00Z",
      calendarId: "c1",
      notes: "My Day link: lk-unknown1",
    }),
  ];
  const a = buildAgenda({ ...base(), events, reminders: [], state });
  assert.equal(a.schedule[0].link?.id, "lk-link0001");
  assert.equal(a.schedule[1].link?.id, "lk-link0002");
  assert.equal(a.schedule[2].link, null);
  assert.equal(overlappingEvents(a.schedule, "2026-10-02T09:15:00Z", "2026-10-02T09:45:00Z").length, 1);
  assert.equal(overlappingEvents(a.schedule, "2026-10-02T09:15:00Z", "2026-10-02T09:45:00Z", "new-id").length, 0);
});

test("A-A-5 task rows carry the task's details (dedented) for the detail pane", () => {
  const dir = mkdtempSync(join(tmpdir(), "myday-agenda-"));
  const c = createChecklist(dir, "Notes", "- [ ] Write it ^t-agen0003\n  First line\n  https://example.com\n");
  const state = emptyState();
  assignDay(state, "t-agen0003", c.id, DAY);
  const a = buildAgenda({ ...base(), events: [], reminders: [], checklists: [c], state });
  assert.equal(a.tasks[0].details, "First line\nhttps://example.com");
});

test("owner test: on a future day, reminders due today are not overdue; on a past day nothing is overdue", () => {
  const reminders = [
    rem({ itemId: "due-today", listId: "l1", dueDay: DAY }),
    rem({ itemId: "older", listId: "l1", dueDay: "2026-09-30" }),
    rem({ itemId: "tomorrow", listId: "l1", dueDay: "2026-10-03" }),
  ];
  const future = buildAgenda({ ...base(), day: "2026-10-03", events: [], reminders });
  assert.deepEqual(future.overdue, []);
  assert.deepEqual(
    future.dueToday.map((r) => r.reminder.itemId),
    ["tomorrow"],
  );
  assert.deepEqual(
    future.otherReminders.map((r) => r.reminder.itemId),
    ["due-today"],
  );
  const past = buildAgenda({ ...base(), day: "2026-09-30", events: [], reminders });
  assert.deepEqual(past.overdue, []);
  assert.deepEqual(
    past.dueToday.map((r) => r.reminder.itemId),
    ["older"],
  );
  const now = buildAgenda({ ...base(), events: [], reminders });
  assert.deepEqual(
    now.overdue.map((r) => r.reminder.itemId),
    ["older"],
  );
});

// ---- D-012: main task, supporting tasks, picks and carry-over ------------------------------------------------------
import { moveFocusItem, pickReminder, prunePicks, setMain } from "../src/lib/state.ts";

function planFixture() {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  const file = createChecklist(dir, "Website", "- [ ] Ship pricing page\n- [ ] Reply to Anna\n- [x] Old done thing\n");
  const [ship, reply, old] = allTasks(file.doc.blocks).map((t) => t.id);
  return { file, ship, reply, old };
}

test("D-012 the main task is pulled out once; supporting holds the other tasks, open first; picks stay reminders", () => {
  const { file, ship, reply, old } = planFixture();
  const state = emptyState();
  assignDay(state, reply, file.id, DAY);
  assignDay(state, old, file.id, DAY);
  setMain(state, DAY, { kind: "task", taskId: ship, checklistId: file.id });
  pickReminder(state, "r-undated", DAY, { externalId: null, title: "Book car service" });
  const a = buildAgenda({
    ...base(),
    checklists: [file],
    state,
    events: [],
    reminders: [rem({ itemId: "r-undated", listId: "l1", title: "Book car service" })],
  });
  assert.equal(a.main?.kind === "task" && a.main.title, "Ship pricing page");
  assert.deepEqual(
    a.supporting.map((r) => (r.kind === "task" ? r.title : r.reminder.title)),
    ["Reply to Anna", "Old done thing"],
  );
  assert.deepEqual(
    a.picked.map((r) => r.reminder.title),
    ["Book car service"],
    "picked reminders stay with the reminders",
  );
  assert.equal(a.tasks.length, 3, "setMain also put the main task on the day");
  assert.equal(a.otherReminders.length, 0, "a picked reminder is not offered again as 'other'");
});

test("D-013b reminders are never the main task or supporting; a due reminder stays due even when picked", () => {
  const state = emptyState();
  pickReminder(state, "r1", DAY, { externalId: null, title: "Call bank" });
  setMain(state, DAY, { kind: "reminder", itemId: "r1" });
  const a = buildAgenda({
    ...base(),
    state,
    events: [],
    reminders: [rem({ itemId: "r1", listId: "l1", title: "Call bank", dueDay: DAY })],
  });
  assert.equal(a.main, null);
  assert.equal(a.supporting.length, 0);
  assert.equal(a.dueToday.length, 1);
  assert.equal(a.picked.length, 0);
});

test("D-012 open items from earlier days are carried onto today only; done ones are not", () => {
  const { file, ship, old } = planFixture();
  const state = emptyState();
  assignDay(state, ship, file.id, "2026-09-30");
  assignDay(state, old, file.id, "2026-09-30");
  pickReminder(state, "r1", "2026-10-01", { externalId: null, title: "Old pick" });
  const input = {
    ...base(),
    checklists: [file],
    state,
    events: [],
    reminders: [rem({ itemId: "r1", listId: "l1", title: "Old pick" })],
  };
  const today = buildAgenda(input);
  const carried = [...today.supporting, ...today.picked].map((r) => [
    r.kind === "task" ? r.title : r.reminder.title,
    r.carriedFrom,
  ]);
  assert.deepEqual(carried, [
    ["Ship pricing page", "2026-09-30"],
    ["Old pick", "2026-10-01"],
  ]);
  const tomorrow = buildAgenda({ ...input, day: "2026-10-03" });
  assert.equal(tomorrow.supporting.length + tomorrow.picked.length, 0, "carry-over only shows on today");
});

test("D-012 pushing moves the item and its main role when the next day has none; prune drops finished picks", () => {
  const { file, ship, reply } = planFixture();
  const state = emptyState();
  const shipRef = { kind: "task" as const, taskId: ship, checklistId: file.id };
  setMain(state, DAY, shipRef);
  moveFocusItem(state, DAY, "2026-10-03", shipRef);
  assert.equal(state.assignments[ship].day, "2026-10-03");
  assert.deepEqual(state.main["2026-10-03"], shipRef);
  assert.equal(state.main[DAY], undefined);
  // The next day already has a main task: the pushed one becomes supporting there.
  const replyRef = { kind: "task" as const, taskId: reply, checklistId: file.id };
  setMain(state, DAY, replyRef);
  moveFocusItem(state, DAY, "2026-10-03", replyRef);
  assert.deepEqual(state.main["2026-10-03"], shipRef);
  assert.equal(state.assignments[reply].day, "2026-10-03");

  pickReminder(state, "gone", DAY, { externalId: null, title: "x" });
  setMain(state, "2026-10-04", { kind: "reminder", itemId: "gone" });
  assert.equal(prunePicks(state, new Set(["other"])), true);
  assert.equal(state.picks.gone, undefined);
  assert.equal(state.main["2026-10-04"], undefined);
});

test("a timed reminder due earlier today is overdue (as in Reminders); later today it is just due", () => {
  const a = buildAgenda({
    ...base(),
    now: new Date(`${DAY}T12:00:00Z`),
    events: [],
    reminders: [
      rem({ itemId: "past", listId: "l1", dueDay: DAY, dueHasTime: true, dueDateTime: `${DAY}T09:00:00Z` }),
      rem({ itemId: "later", listId: "l1", dueDay: DAY, dueHasTime: true, dueDateTime: `${DAY}T15:00:00Z` }),
      rem({ itemId: "anytime", listId: "l1", dueDay: DAY }),
    ],
  });
  assert.deepEqual(
    a.overdue.map((r) => r.reminder.itemId),
    ["past"],
  );
  assert.deepEqual(
    a.dueToday.map((r) => r.reminder.itemId),
    ["later", "anytime"],
  );
});

test("Coming up lists each event once on its first visible day, all-day first, grouped like My Schedule", async () => {
  const { upcomingEvents, upcomingGroup } = await import("../src/lib/agenda.ts");
  const events = [
    ev({
      itemId: "thx",
      start: "2026-10-12T00:00:00Z",
      end: "2026-10-13T00:00:00Z",
      calendarId: "c2",
      title: "Thanksgiving",
      isAllDay: true,
      startDay: "2026-10-12",
      endDay: "2026-10-12",
    }),
    ev({
      itemId: "physio",
      start: "2026-10-08T12:00:00Z",
      end: "2026-10-08T13:00:00Z",
      calendarId: "c1",
      title: "Physio",
    }),
    ev({
      itemId: "trip",
      start: "2026-10-01T00:00:00Z",
      end: "2026-10-20T00:00:00Z",
      calendarId: "c2",
      title: "Trip",
      isAllDay: true,
      startDay: "2026-10-01",
      endDay: "2026-10-19",
    }),
    ev({
      itemId: "late",
      start: "2026-11-20T12:00:00Z",
      end: "2026-11-20T13:00:00Z",
      calendarId: "c1",
      title: "Too late",
    }),
  ];
  const up = upcomingEvents(
    { events, calendars: base().calendars, state: emptyState(), timeZone: "UTC" },
    "2026-10-07",
    "2026-11-06",
  );
  assert.deepEqual(
    up.map((u) => [u.day, u.row.event.title]),
    [
      ["2026-10-07", "Trip"],
      ["2026-10-08", "Physio"],
      ["2026-10-12", "Thanksgiving"],
    ],
  );
  // Today Monday 5 Oct 2026.
  assert.equal(upcomingGroup("2026-10-08", "2026-10-05"), "Later this week");
  assert.equal(upcomingGroup("2026-10-12", "2026-10-05"), "Next week");
  assert.equal(upcomingGroup("2026-10-26", "2026-10-05"), "Rest of October");
  assert.equal(upcomingGroup("2026-11-02", "2026-10-05"), "November");
});

test("same-titled all-day events from several holiday calendars show once per day; timed events never merge", async () => {
  const { dedupeAllDay } = await import("../src/lib/agenda.ts");
  const mk = (id: string, title: string, allDay = true) => ({
    event: ev({
      itemId: id,
      start: "2026-10-31T00:00:00Z",
      end: "2026-11-01T00:00:00Z",
      calendarId: "c1",
      title,
      isAllDay: allDay,
    }),
  });
  const rows = [
    mk("a", "Halloween"),
    mk("b", "Halloween "),
    mk("c", "halloween"),
    mk("d", "Standup", false),
    mk("e", "Standup", false),
  ];
  assert.deepEqual(
    dedupeAllDay(rows).map((r) => r.event.itemId),
    ["a", "d", "e"],
  );
});
