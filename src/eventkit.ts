// Raycast-side access to the bundled EventKit helper. Every call spawns the helper once; it exits when done.
import { environment } from "@raycast/api";
import { join } from "node:path";
import {
  parseAccess,
  parseCalendars,
  parseCalendarWrite,
  parseEvents,
  parseEventWrite,
  parseOk,
  parseReminders,
  parseReminderWrite,
  parseStatus,
  type AccessResult,
  type CalendarInfo,
  type CalendarsResult,
  type EventInfo,
  type HelperStatus,
  type Parsed,
  type ReminderInfo,
} from "./lib/eventkit-protocol.ts";
import { ACCESS_TIMEOUT_MS, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, runHelper, type RunResult } from "./lib/run-helper.ts";

export const helperPath = () => join(environment.assetsPath, "myday-helper");

function through<T>(run: RunResult, parse: (stdout: string) => Parsed<T>): Parsed<T> {
  return run.ok ? parse(run.stdout) : { ok: false, failure: run.failure };
}

export async function helperStatus(): Promise<Parsed<HelperStatus>> {
  return through(await runHelper(helperPath(), ["status"], { timeoutMs: READ_TIMEOUT_MS }), parseStatus);
}

/** Shows the system permission dialog (attributed to the launching app) and waits for the answer. */
export async function requestAccess(entity: "events" | "reminders"): Promise<Parsed<AccessResult>> {
  const run = await runHelper(helperPath(), ["request-access", entity, "--timeout", "170"], {
    timeoutMs: ACCESS_TIMEOUT_MS,
  });
  return through(run, parseAccess);
}

export async function listCalendars(): Promise<Parsed<CalendarsResult>> {
  return through(await runHelper(helperPath(), ["calendars"], { timeoutMs: READ_TIMEOUT_MS }), parseCalendars);
}

export async function listEvents(fromISO: string, toISO: string, calendarIds?: string[]): Promise<Parsed<EventInfo[]>> {
  const args = ["events", "--from", fromISO, "--to", toISO];
  if (calendarIds) args.push("--calendars", calendarIds.join(","));
  return through(await runHelper(helperPath(), args, { timeoutMs: READ_TIMEOUT_MS }), parseEvents);
}

export async function listReminders(listIds?: string[], includeCompleted = false): Promise<Parsed<ReminderInfo[]>> {
  const args = ["reminders"];
  if (listIds) args.push("--lists", listIds.join(","));
  if (includeCompleted) args.push("--include-completed");
  return through(await runHelper(helperPath(), args, { timeoutMs: READ_TIMEOUT_MS }), parseReminders);
}

export interface CreateEventInput {
  calendarId: string;
  title: string;
  start?: string;
  end?: string;
  day?: string;
  endDay?: string;
  isAllDay: boolean;
  location?: string;
  notes?: string;
  url?: string;
  /** Minutes before start; [] = no alerts; omitted = calendar default. */
  alarmMinutes?: number[];
}
export async function createEvent(input: CreateEventInput): Promise<Parsed<EventInfo>> {
  return through(
    await runHelper(helperPath(), ["create-event"], { timeoutMs: WRITE_TIMEOUT_MS, input }),
    parseEventWrite,
  );
}

export interface ExpectedSnapshot {
  title?: string;
  start?: string;
  end?: string;
}
export interface UpdateEventInput {
  eventId: string;
  externalId?: string | null;
  expectedLastModified?: string | null;
  expectedSnapshot?: ExpectedSnapshot;
  title?: string;
  start?: string;
  end?: string;
  day?: string;
  endDay?: string;
  isAllDay?: boolean;
  location?: string;
  notes?: string;
  url?: string;
  calendarId?: string;
  alarmMinutes?: number[];
}
export async function updateEvent(input: UpdateEventInput): Promise<Parsed<EventInfo>> {
  return through(
    await runHelper(helperPath(), ["update-event"], { timeoutMs: WRITE_TIMEOUT_MS, input }),
    parseEventWrite,
  );
}

export interface EventRef {
  eventId: string;
  externalId?: string | null;
  expectedLastModified?: string | null;
  expectedSnapshot?: ExpectedSnapshot;
}
export async function getEvent(ref: EventRef): Promise<Parsed<EventInfo>> {
  return through(
    await runHelper(helperPath(), ["get-event"], { timeoutMs: READ_TIMEOUT_MS, input: ref }),
    parseEventWrite,
  );
}
export async function deleteEvent(ref: EventRef): Promise<Parsed<string>> {
  return through(await runHelper(helperPath(), ["delete-event"], { timeoutMs: WRITE_TIMEOUT_MS, input: ref }), parseOk);
}

export interface CreateReminderInput {
  listId: string;
  title: string;
  notes?: string;
  url?: string;
  dueDay?: string | null;
  dueTime?: string | null;
}
export async function createReminder(input: CreateReminderInput): Promise<Parsed<ReminderInfo>> {
  return through(
    await runHelper(helperPath(), ["create-reminder"], { timeoutMs: WRITE_TIMEOUT_MS, input }),
    parseReminderWrite,
  );
}

export interface ReminderRef {
  itemId: string;
  externalId?: string | null;
  expectedLastModified?: string | null;
}
export async function getReminder(ref: ReminderRef): Promise<Parsed<ReminderInfo>> {
  return through(
    await runHelper(helperPath(), ["get-reminder"], { timeoutMs: READ_TIMEOUT_MS, input: ref }),
    parseReminderWrite,
  );
}
export async function completeReminder(ref: ReminderRef, completed: boolean): Promise<Parsed<ReminderInfo>> {
  const input = { ...ref, completed };
  return through(
    await runHelper(helperPath(), ["complete-reminder"], { timeoutMs: WRITE_TIMEOUT_MS, input }),
    parseReminderWrite,
  );
}
export async function setReminderDue(
  ref: ReminderRef,
  dueDay: string | null,
  dueTime: string | null,
): Promise<Parsed<ReminderInfo>> {
  const input = { ...ref, dueDay, dueTime };
  return through(
    await runHelper(helperPath(), ["set-reminder-due"], { timeoutMs: WRITE_TIMEOUT_MS, input }),
    parseReminderWrite,
  );
}
export interface UpdateReminderInput extends ReminderRef {
  title?: string;
  notes?: string;
  url?: string;
  listId?: string;
}
export async function updateReminder(input: UpdateReminderInput): Promise<Parsed<ReminderInfo>> {
  return through(
    await runHelper(helperPath(), ["update-reminder"], { timeoutMs: WRITE_TIMEOUT_MS, input }),
    parseReminderWrite,
  );
}
export async function deleteReminder(ref: ReminderRef): Promise<Parsed<string>> {
  return through(
    await runHelper(helperPath(), ["delete-reminder"], { timeoutMs: WRITE_TIMEOUT_MS, input: ref }),
    parseOk,
  );
}

/** Fixture support only: creates a dedicated calendar or reminder list that My Day owns. */
export async function createCalendar(
  title: string,
  kind: "event" | "reminder",
  sourceId?: string,
): Promise<Parsed<CalendarInfo>> {
  const input = { title, kind, sourceId };
  return through(
    await runHelper(helperPath(), ["create-calendar"], { timeoutMs: WRITE_TIMEOUT_MS, input }),
    parseCalendarWrite,
  );
}
export async function deleteCalendar(calendarId: string, expectedTitle: string): Promise<Parsed<string>> {
  const input = { calendarId, expectedTitle };
  return through(await runHelper(helperPath(), ["delete-calendar"], { timeoutMs: WRITE_TIMEOUT_MS, input }), parseOk);
}
