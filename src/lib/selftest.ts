// M1 self-test: proves the EventKit integration from inside Raycast with fixtures My Day creates and removes itself.
// Writes a JSON evidence log so the result can be read from the filesystem. Never touches existing user items.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type * as EK from "../eventkit.ts";
import type { CalendarsResult } from "./eventkit-protocol.ts";

export const FIXTURE_TAG = "My Day Test";

export interface SelfTestStep {
  step: string;
  ok: boolean;
  detail: unknown;
  at: string;
}

export interface SelfTestReport {
  startedAt: string;
  finishedAt: string;
  supportPath: string;
  assetsPath: string;
  steps: SelfTestStep[];
  fixtures: { eventCalendarId?: string; reminderListId?: string; eventId?: string; reminderId?: string };
  cleanedUp: boolean;
}

type EventKitApi = typeof EK;

export async function runSelfTest(
  api: EventKitApi,
  env: { supportPath: string; assetsPath: string },
  logPath: string,
  now = new Date(),
): Promise<SelfTestReport> {
  const report: SelfTestReport = {
    startedAt: now.toISOString(),
    finishedAt: "",
    supportPath: env.supportPath,
    assetsPath: env.assetsPath,
    steps: [],
    fixtures: {},
    cleanedUp: false,
  };
  const flush = () => {
    report.finishedAt = new Date().toISOString();
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, JSON.stringify(report, null, 2));
    } catch {
      // evidence write failure is reported through the UI instead
    }
  };
  const record = (step: string, ok: boolean, detail: unknown) => {
    report.steps.push({ step, ok, detail, at: new Date().toISOString() });
    flush();
    return ok;
  };

  const status = await api.helperStatus();
  record("status", status.ok, status.ok ? status.value : status.failure);
  if (!status.ok) return report;

  // Access requests: these show the system dialogs the first time. We never toggle anything ourselves.
  for (const entity of ["events", "reminders"] as const) {
    const current = entity === "events" ? status.value.events : status.value.reminders;
    if (current === "full-access") {
      record(`access-${entity}`, true, { status: current, prompted: false });
      continue;
    }
    const r = await api.requestAccess(entity);
    record(`access-${entity}`, r.ok && r.value.granted, r.ok ? r.value : r.failure);
  }

  const cals = await api.listCalendars();
  record("calendars", cals.ok, cals.ok ? summarizeCalendars(cals.value) : cals.failure);
  if (!cals.ok) return report;

  // Remove fixtures left by an interrupted earlier run (the command is unloaded when its window closes).
  for (const c of [...(cals.value.eventCalendars ?? []), ...(cals.value.reminderLists ?? [])]) {
    if (c.title === FIXTURE_TAG) {
      const d = await api.deleteCalendar(c.id, FIXTURE_TAG);
      record(`cleanup-orphan-${c.kind}`, d.ok, d.ok ? { id: c.id } : d.failure);
    }
  }

  const evOK = cals.value.eventsAccess === "full-access";
  const rmOK = cals.value.remindersAccess === "full-access";

  // Read existing data (counts only; titles are never written to the evidence file).
  if (evOK) {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const events = await api.listEvents(from.toISOString(), to.toISOString());
    record(
      "read-events-today",
      events.ok,
      events.ok
        ? {
            count: events.value.length,
            allDay: events.value.filter((e) => e.isAllDay).length,
            recurring: events.value.filter((e) => e.isRecurring).length,
          }
        : events.failure,
    );
  } else {
    record("read-events-today", false, { skipped: true, reason: `events access is ${cals.value.eventsAccess}` });
  }
  if (rmOK) {
    const rems = await api.listReminders();
    record(
      "read-reminders",
      rems.ok,
      rems.ok
        ? {
            count: rems.value.length,
            dateOnly: rems.value.filter((r) => r.dueDay && !r.dueHasTime).length,
            withTime: rems.value.filter((r) => r.dueHasTime).length,
            noDate: rems.value.filter((r) => !r.dueDay).length,
          }
        : rems.failure,
    );
  } else {
    record("read-reminders", false, { skipped: true, reason: `reminders access is ${cals.value.remindersAccess}` });
  }

  // Fixture round trip in dedicated sources we create.
  let eventCal: EK.CreateEventInput["calendarId"] | undefined;
  let reminderList: string | undefined;
  try {
    if (evOK) {
      const c = await api.createCalendar(FIXTURE_TAG, "event");
      record("fixture-create-calendar", c.ok, c.ok ? c.value : c.failure);
      if (c.ok) {
        eventCal = c.value.id;
        report.fixtures.eventCalendarId = eventCal;
        const start = new Date(now);
        start.setHours(23, 0, 0, 0);
        const end = new Date(start.getTime() + 30 * 60_000);
        const created = await api.createEvent({
          calendarId: eventCal,
          title: `${FIXTURE_TAG} event`,
          start: start.toISOString(),
          end: end.toISOString(),
          isAllDay: false,
          notes: "Created by My Day self-test. Safe to delete.",
        });
        record("fixture-create-event", created.ok, created.ok ? created.value : created.failure);
        if (created.ok && created.value.eventId) {
          report.fixtures.eventId = created.value.eventId;
          const reread = await api.getEvent({ eventId: created.value.eventId, externalId: created.value.externalId });
          record(
            "fixture-reread-event",
            reread.ok && reread.value.title === `${FIXTURE_TAG} event`,
            reread.ok ? reread.value : reread.failure,
          );
          const updated = await api.updateEvent({
            eventId: created.value.eventId,
            externalId: created.value.externalId,
            expectedLastModified: created.value.lastModified,
            title: `${FIXTURE_TAG} event (edited)`,
          });
          record(
            "fixture-update-event",
            updated.ok && updated.value.title.endsWith("(edited)"),
            updated.ok ? updated.value : updated.failure,
          );
          const stale = await api.updateEvent({
            eventId: created.value.eventId,
            externalId: created.value.externalId,
            expectedLastModified: created.value.lastModified,
            expectedSnapshot: { title: created.value.title, start: created.value.start, end: created.value.end },
            title: "should be refused",
          });
          record(
            "fixture-stale-update-refused",
            !stale.ok && stale.failure.kind === "helper" && stale.failure.code === "conflict",
            stale.ok ? stale.value : stale.failure,
          );
          const alarmed = await api.createEvent({
            calendarId: eventCal,
            title: `${FIXTURE_TAG} alert`,
            start: start.toISOString(),
            end: end.toISOString(),
            isAllDay: false,
            alarmMinutes: [30],
          });
          record(
            "fixture-event-alert-30",
            alarmed.ok && JSON.stringify(alarmed.value.alarmMinutes) === "[30]",
            alarmed.ok ? { alarmMinutes: alarmed.value.alarmMinutes } : alarmed.failure,
          );
          if (alarmed.ok && alarmed.value.eventId) {
            const atStart = await api.updateEvent({
              eventId: alarmed.value.eventId,
              externalId: alarmed.value.externalId,
              expectedLastModified: alarmed.value.lastModified,
              expectedSnapshot: { title: alarmed.value.title, start: alarmed.value.start, end: alarmed.value.end },
              alarmMinutes: [0],
            });
            record(
              "fixture-event-alert-at-start",
              atStart.ok &&
                JSON.stringify(atStart.value.alarmMinutes) === "[0]" &&
                atStart.value.title === alarmed.value.title,
              atStart.ok ? { alarmMinutes: atStart.value.alarmMinutes } : atStart.failure,
            );
          }
          const allDay = await api.createEvent({
            calendarId: eventCal,
            title: `${FIXTURE_TAG} all-day`,
            isAllDay: true,
            day: localDay(now),
          });
          record(
            "fixture-create-allday",
            allDay.ok && allDay.value.isAllDay && allDay.value.startDay === localDay(now),
            allDay.ok ? allDay.value : allDay.failure,
          );
        }
      }
    }
    if (rmOK) {
      const l = await api.createCalendar(FIXTURE_TAG, "reminder");
      record("fixture-create-list", l.ok, l.ok ? l.value : l.failure);
      if (l.ok) {
        reminderList = l.value.id;
        report.fixtures.reminderListId = reminderList;
        const noDate = await api.createReminder({ listId: reminderList, title: `${FIXTURE_TAG} no date` });
        record(
          "fixture-reminder-nodate",
          noDate.ok && noDate.value.dueDay === null,
          noDate.ok ? noDate.value : noDate.failure,
        );
        const dateOnly = await api.createReminder({
          listId: reminderList,
          title: `${FIXTURE_TAG} date only`,
          dueDay: localDay(now),
        });
        record(
          "fixture-reminder-dateonly",
          dateOnly.ok && dateOnly.value.dueDay === localDay(now) && !dateOnly.value.dueHasTime,
          dateOnly.ok ? dateOnly.value : dateOnly.failure,
        );
        const timed = await api.createReminder({
          listId: reminderList,
          title: `${FIXTURE_TAG} timed`,
          dueDay: localDay(now),
          dueTime: "23:30",
        });
        record(
          "fixture-reminder-timed",
          timed.ok && timed.value.dueHasTime && timed.value.dueDay === localDay(now),
          timed.ok ? timed.value : timed.failure,
        );
        if (timed.ok) {
          report.fixtures.reminderId = timed.value.itemId;
          const moved = await api.setReminderDue(
            { itemId: timed.value.itemId, externalId: timed.value.externalId },
            null,
            null,
          );
          record(
            "fixture-reminder-clear-due",
            moved.ok && moved.value.dueDay === null,
            moved.ok ? moved.value : moved.failure,
          );
          const edited = await api.updateReminder({
            itemId: timed.value.itemId,
            externalId: timed.value.externalId,
            title: `${FIXTURE_TAG} timed (edited)`,
            notes: "Line one\nLine two https://example.com",
          });
          record(
            "fixture-reminder-edit",
            edited.ok &&
              edited.value.title.endsWith("(edited)") &&
              (edited.value.notes ?? "").includes("Line two") &&
              edited.value.dueDay === null,
            edited.ok
              ? { title: edited.value.title, notes: edited.value.notes, dueDay: edited.value.dueDay }
              : edited.failure,
          );
          const done = await api.completeReminder(
            { itemId: timed.value.itemId, externalId: timed.value.externalId },
            true,
          );
          record("fixture-reminder-complete", done.ok && done.value.isCompleted, done.ok ? done.value : done.failure);
          const undone = await api.completeReminder(
            { itemId: timed.value.itemId, externalId: timed.value.externalId },
            false,
          );
          record(
            "fixture-reminder-uncomplete",
            undone.ok && !undone.value.isCompleted,
            undone.ok ? undone.value : undone.failure,
          );
        }
        const inList = await api.listReminders([reminderList], true);
        record(
          "fixture-list-filter",
          inList.ok && inList.value.length === 3 && inList.value.every((r) => r.listId === reminderList),
          inList.ok ? { count: inList.value.length } : inList.failure,
        );
      }
    }
  } finally {
    let clean = true;
    if (eventCal) {
      const d = await api.deleteCalendar(eventCal, FIXTURE_TAG);
      clean = record("cleanup-event-calendar", d.ok, d.ok ? d.value : d.failure) && clean;
    }
    if (reminderList) {
      const d = await api.deleteCalendar(reminderList, FIXTURE_TAG);
      clean = record("cleanup-reminder-list", d.ok, d.ok ? d.value : d.failure) && clean;
    }
    report.cleanedUp = clean;
    flush();
  }
  return report;
}

function summarizeCalendars(c: CalendarsResult) {
  return {
    eventsAccess: c.eventsAccess,
    remindersAccess: c.remindersAccess,
    eventCalendars: c.eventCalendars?.length ?? null,
    writableEventCalendars: c.eventCalendars?.filter((x) => x.allowsModifications).length ?? null,
    reminderLists: c.reminderLists?.length ?? null,
    sources: Array.from(
      new Set((c.eventCalendars ?? []).concat(c.reminderLists ?? []).map((x) => `${x.source} [${x.sourceType}]`)),
    ),
  };
}

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
