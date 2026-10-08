import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfTest } from "../src/lib/selftest.ts";
import type * as EK from "../src/eventkit.ts";
import type { Parsed } from "../src/lib/eventkit-protocol.ts";

function fakeApi(opts: { events: "full-access" | "denied"; failEventCreate?: boolean }) {
  const calls: string[] = [];
  const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
  const cal = (id: string, kind: "event" | "reminder") => ({
    id,
    title: "My Day Test",
    kind,
    color: null,
    source: "iCloud",
    sourceType: "caldav",
    allowsModifications: true,
    isImmutable: false,
    isSubscribed: false,
    calendarType: "caldav",
  });
  const api = {
    helperStatus: async () => (
      calls.push("status"),
      ok({
        helper: "t",
        macos: "27",
        events: opts.events,
        reminders: "full-access" as const,
        timeZone: "UTC",
        pid: 1,
        parentPid: 0,
      })
    ),
    requestAccess: async (entity: "events" | "reminders") => (
      calls.push(`request-${entity}`),
      ok({ entity, granted: false, status: "denied" as const, timedOut: false, error: null })
    ),
    listCalendars: async () => (
      calls.push("calendars"),
      ok({
        eventCalendars: opts.events === "full-access" ? [] : null,
        reminderLists: [],
        eventsAccess: opts.events,
        remindersAccess: "full-access" as const,
      })
    ),
    listEvents: async () => (calls.push("events"), ok([])),
    listReminders: async () => (calls.push("reminders"), ok([])),
    createCalendar: async (_t: string, kind: "event" | "reminder") => (
      calls.push(`create-calendar-${kind}`),
      ok(cal(`cal-${kind}`, kind))
    ),
    deleteCalendar: async (id: string) => (calls.push(`delete-calendar-${id}`), ok("deleted")),
    createEvent: async () => {
      calls.push("create-event");
      if (opts.failEventCreate) throw new Error("boom");
      return { ok: false as const, failure: { kind: "helper" as const, code: "store-error", message: "x" } };
    },
    createReminder: async () => (
      calls.push("create-reminder"),
      { ok: false as const, failure: { kind: "helper" as const, code: "store-error", message: "x" } }
    ),
    listRemindersInList: undefined,
  } as unknown as typeof EK;
  return { api, calls };
}

test("A-M1-3 with events denied the self-test never reads events and still cleans up its reminder list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "myday-selftest-"));
  const { api, calls } = fakeApi({ events: "denied" });
  const r = await runSelfTest(api, { supportPath: dir, assetsPath: dir }, join(dir, "log.json"));
  assert.ok(!calls.includes("events"));
  assert.ok(calls.includes("request-events"));
  assert.ok(calls.includes("delete-calendar-cal-reminder"));
  assert.ok(!calls.includes("create-calendar-event"));
  const stepNames = r.steps.map((s) => s.step);
  assert.ok(stepNames.includes("read-events-today"));
  assert.equal(r.steps.find((s) => s.step === "read-events-today")?.ok, false);
  assert.ok(r.cleanedUp);
  assert.ok(JSON.parse(readFileSync(join(dir, "log.json"), "utf8")).steps.length > 0);
});

test("A-M1-5 a crash in the middle of the fixture run still deletes the fixture calendar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "myday-selftest-"));
  const { api, calls } = fakeApi({ events: "full-access", failEventCreate: true });
  await assert.rejects(() => runSelfTest(api, { supportPath: dir, assetsPath: dir }, join(dir, "log.json")));
  assert.ok(calls.includes("delete-calendar-cal-event"));
});
