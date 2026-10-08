import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignDay,
  createStateStore,
  emptyState,
  linksForSource,
  pruneTasks,
  unassignDay,
  validateState,
} from "../src/lib/state.ts";

test("A-C-15 invalid state entries are dropped and reported, valid ones kept", () => {
  const raw = {
    schema: 1,
    assignments: {
      "t-good0001": { day: "2026-10-02", checklistId: "cl-good0001" },
      "bad id": { day: "2026-10-02", checklistId: "cl-x" },
      "t-bad00002": { day: "2026-13-40", checklistId: "cl-good0001" },
    },
    links: {
      "lk-good0001": {
        source: { kind: "task", taskId: "t-good0001", checklistId: "cl-good0001", title: "t" },
        eventId: "E",
        externalId: null,
        calendarId: "C",
        snapshot: { title: "t", start: "2026-10-02T13:00:00Z", end: "2026-10-02T13:30:00Z", lastModified: null },
        createdAt: "",
      },
      "lk-bad00001": { eventId: 5 },
    },
    estimates: { "t-good0001": 30, "t-good0002": -5 },
    sources: { eventCalendarIds: [], reminderListIds: null },
    checklistOrder: ["cl-good0001", "nope"],
  };
  const { state, dropped } = validateState(raw);
  assert.deepEqual(Object.keys(state.assignments), ["t-good0001"]);
  assert.deepEqual(Object.keys(state.links), ["lk-good0001"]);
  assert.deepEqual(state.estimates, { "t-good0001": 30 });
  assert.deepEqual(state.sources.eventCalendarIds, []); // deliberately empty stays empty (A-A-4)
  assert.equal(state.sources.reminderListIds, null);
  assert.deepEqual(state.checklistOrder, ["cl-good0001"]);
  assert.equal(dropped.length, 4);
});

test("A-B-4 assigning a day moves an existing assignment explicitly and unassign is reversible", () => {
  const s = emptyState();
  assert.equal(assignDay(s, "t-aaaa0001", "cl-aaaa0001", "2026-10-02"), null);
  assert.equal(assignDay(s, "t-aaaa0001", "cl-aaaa0001", "2026-10-03"), "2026-10-02");
  assert.equal(Object.keys(s.assignments).length, 1);
  assert.equal(s.assignments["t-aaaa0001"].day, "2026-10-03");
  assert.ok(unassignDay(s, "t-aaaa0001"));
  assert.equal(unassignDay(s, "t-aaaa0001"), false);
});

test("corrupt state file is preserved and replaced by an empty state", () => {
  const dir = mkdtempSync(join(tmpdir(), "myday-state-"));
  const path = join(dir, "state.json");
  writeFileSync(path, "{not json");
  const store = createStateStore(path);
  const r = store.load();
  assert.ok(r.corrupt);
  const s = r.state;
  assignDay(s, "t-aaaa0001", "cl-aaaa0001", "2026-10-02");
  store.save(s);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).assignments["t-aaaa0001"].day, "2026-10-02");
  assert.equal(store.load().corrupt, false);
});

test("pruneTasks removes assignments and links of deleted tasks only for that checklist", () => {
  const s = emptyState();
  assignDay(s, "t-aaaa0001", "cl-aaaa0001", "2026-10-02");
  assignDay(s, "t-aaaa0002", "cl-aaaa0001", "2026-10-02");
  assignDay(s, "t-bbbb0001", "cl-bbbb0001", "2026-10-02");
  s.links["lk-aaaa0001"] = {
    source: { kind: "task", taskId: "t-aaaa0002", checklistId: "cl-aaaa0001", title: "" },
    eventId: "E",
    externalId: null,
    calendarId: "C",
    snapshot: { title: "", start: "", end: "", lastModified: null },
    createdAt: "",
  };
  const removed = pruneTasks(s, "cl-aaaa0001", new Set(["t-aaaa0001"]));
  assert.equal(removed, 2);
  assert.deepEqual(Object.keys(s.assignments).sort(), ["t-aaaa0001", "t-bbbb0001"]);
  assert.equal(linksForSource(s, { kind: "task", taskId: "t-aaaa0002" }).length, 0);
});
