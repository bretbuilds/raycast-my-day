// Types and validation for the myday-helper JSON protocol (schema 1). Pure, no Raycast imports.
import type { RunFailure } from "./run-helper.ts";

export const HELPER_SCHEMA = 1;

export type AccessStatus = "not-determined" | "restricted" | "denied" | "full-access" | "write-only" | "unknown";

export interface HelperStatus {
  helper: string;
  macos: string;
  events: AccessStatus;
  reminders: AccessStatus;
  timeZone: string;
  pid: number;
  parentPid: number;
  /** The Mac's clock style (System Settings → Date & Time), as the helper's locale reports it. */
  uses24HourClock: boolean | null;
}

export interface CalendarInfo {
  id: string;
  title: string;
  kind: "event" | "reminder";
  color: string | null;
  source: string;
  sourceType: string;
  allowsModifications: boolean;
  isImmutable: boolean;
  isSubscribed: boolean;
  calendarType: string;
}

export interface CalendarsResult {
  eventCalendars: CalendarInfo[] | null;
  reminderLists: CalendarInfo[] | null;
  eventsAccess: AccessStatus;
  remindersAccess: AccessStatus;
}

export interface EventInfo {
  eventId: string | null;
  itemId: string;
  externalId: string | null;
  occurrenceDate: string | null;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  startDay: string;
  endDay: string;
  isAllDay: boolean;
  isRecurring: boolean;
  isDetached: boolean;
  location: string | null;
  notes: string | null;
  url: string | null;
  status: string;
  availability: string;
  hasAttendees: boolean;
  organizer: string | null;
  lastModified: string | null;
  timeZone: string | null;
  /** Relative alerts in minutes before start (0 = at start). */
  alarmMinutes: number[];
  allowsModifications: boolean;
}

export interface ReminderInfo {
  itemId: string;
  externalId: string | null;
  listId: string;
  title: string;
  notes: string | null;
  url: string | null;
  dueDay: string | null;
  dueDateTime: string | null;
  dueHasTime: boolean;
  isCompleted: boolean;
  completionDate: string | null;
  priority: number;
  isRecurring: boolean;
  lastModified: string | null;
  created: string | null;
}

export interface AccessResult {
  entity: "events" | "reminders";
  granted: boolean;
  status: AccessStatus;
  timedOut: boolean;
  error: string | null;
}

/** Structured failure reported by the helper itself (exit code 2/3 with a JSON body). */
export interface HelperFailure {
  kind: "helper";
  code: string;
  message: string;
}
export type Failure = RunFailure | HelperFailure | { kind: "bad-output"; detail: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; failure: Failure };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses a helper document, separating transport errors, helper-reported failures and malformed output. */
export function parseHelperOutput(stdout: string): Parsed<Record<string, unknown>> {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      failure: { kind: "bad-output", detail: `Helper printed invalid JSON: ${stdout.slice(0, 200)}` },
    };
  }
  if (!isRecord(doc)) return { ok: false, failure: { kind: "bad-output", detail: "Helper output is not an object" } };
  if (doc.schema !== HELPER_SCHEMA) {
    return { ok: false, failure: { kind: "bad-output", detail: `Unexpected helper schema ${String(doc.schema)}` } };
  }
  if (doc.ok !== true) {
    const code = typeof doc.code === "string" ? doc.code : "unknown";
    const message = typeof doc.message === "string" ? doc.message : "Helper reported a failure";
    return { ok: false, failure: { kind: "helper", code, message } };
  }
  return { ok: true, value: doc };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

const ACCESS_VALUES: AccessStatus[] = [
  "not-determined",
  "restricted",
  "denied",
  "full-access",
  "write-only",
  "unknown",
];
function access(v: unknown): AccessStatus {
  return typeof v === "string" && (ACCESS_VALUES as string[]).includes(v) ? (v as AccessStatus) : "unknown";
}

export function parseStatus(stdout: string): Parsed<HelperStatus> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  const d = p.value;
  return {
    ok: true,
    value: {
      helper: str(d.helper),
      macos: str(d.macos),
      events: access(d.events),
      reminders: access(d.reminders),
      timeZone: str(d.timeZone, "UTC"),
      pid: num(d.pid),
      parentPid: num(d.parentPid),
      uses24HourClock: typeof d.uses24HourClock === "boolean" ? d.uses24HourClock : null,
    },
  };
}

export function parseAccess(stdout: string): Parsed<AccessResult> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  const d = p.value;
  return {
    ok: true,
    value: {
      entity: d.entity === "reminders" ? "reminders" : "events",
      granted: bool(d.granted),
      status: access(d.status),
      timedOut: bool(d.timedOut),
      error: strOrNull(d.error),
    },
  };
}

function calendarInfo(v: unknown): CalendarInfo | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.title !== "string") return null;
  return {
    id: v.id,
    title: v.title,
    kind: v.kind === "reminder" ? "reminder" : "event",
    color: strOrNull(v.color),
    source: str(v.source),
    sourceType: str(v.sourceType, "other"),
    allowsModifications: bool(v.allowsModifications),
    isImmutable: bool(v.isImmutable),
    isSubscribed: bool(v.isSubscribed),
    calendarType: str(v.calendarType, "other"),
  };
}

function list<T>(v: unknown, map: (x: unknown) => T | null): T[] {
  return Array.isArray(v) ? v.map(map).filter((x): x is T => x !== null) : [];
}

export function parseCalendars(stdout: string): Parsed<CalendarsResult> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  const d = p.value;
  return {
    ok: true,
    value: {
      eventCalendars:
        d.eventCalendars === null || d.eventCalendars === undefined ? null : list(d.eventCalendars, calendarInfo),
      reminderLists:
        d.reminderLists === null || d.reminderLists === undefined ? null : list(d.reminderLists, calendarInfo),
      eventsAccess: access(d.eventsAccess),
      remindersAccess: access(d.remindersAccess),
    },
  };
}

export function eventInfo(v: unknown): EventInfo | null {
  if (!isRecord(v) || typeof v.itemId !== "string" || typeof v.start !== "string" || typeof v.end !== "string")
    return null;
  return {
    eventId: strOrNull(v.eventId),
    itemId: v.itemId,
    externalId: strOrNull(v.externalId),
    occurrenceDate: strOrNull(v.occurrenceDate),
    calendarId: str(v.calendarId),
    title: str(v.title),
    start: v.start,
    end: v.end,
    startDay: str(v.startDay),
    endDay: str(v.endDay),
    isAllDay: bool(v.isAllDay),
    isRecurring: bool(v.isRecurring),
    isDetached: bool(v.isDetached),
    location: strOrNull(v.location),
    notes: strOrNull(v.notes),
    url: strOrNull(v.url),
    status: str(v.status, "none"),
    availability: str(v.availability, "not-supported"),
    hasAttendees: bool(v.hasAttendees),
    organizer: strOrNull(v.organizer),
    lastModified: strOrNull(v.lastModified),
    timeZone: strOrNull(v.timeZone),
    alarmMinutes: Array.isArray(v.alarmMinutes) ? v.alarmMinutes.filter((m): m is number => typeof m === "number") : [],
    allowsModifications: v.allowsModifications !== false,
  };
}

export function parseEvents(stdout: string): Parsed<EventInfo[]> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  return { ok: true, value: list(p.value.events, eventInfo) };
}

export function parseEventWrite(stdout: string): Parsed<EventInfo> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  const e = eventInfo(p.value.event);
  return e
    ? { ok: true, value: e }
    : { ok: false, failure: { kind: "bad-output", detail: "Helper returned no event" } };
}

export function reminderInfo(v: unknown): ReminderInfo | null {
  if (!isRecord(v) || typeof v.itemId !== "string") return null;
  return {
    itemId: v.itemId,
    externalId: strOrNull(v.externalId),
    listId: str(v.listId),
    title: str(v.title),
    notes: strOrNull(v.notes),
    url: strOrNull(v.url),
    dueDay: strOrNull(v.dueDay),
    dueDateTime: strOrNull(v.dueDateTime),
    dueHasTime: bool(v.dueHasTime),
    isCompleted: bool(v.isCompleted),
    completionDate: strOrNull(v.completionDate),
    priority: num(v.priority),
    isRecurring: bool(v.isRecurring),
    lastModified: strOrNull(v.lastModified),
    created: strOrNull(v.created),
  };
}

export function parseReminders(stdout: string): Parsed<ReminderInfo[]> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  return { ok: true, value: list(p.value.reminders, reminderInfo) };
}

export function parseReminderWrite(stdout: string): Parsed<ReminderInfo> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  const r = reminderInfo(p.value.reminder);
  return r
    ? { ok: true, value: r }
    : { ok: false, failure: { kind: "bad-output", detail: "Helper returned no reminder" } };
}

export function parseCalendarWrite(stdout: string): Parsed<CalendarInfo> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  const c = calendarInfo(p.value.calendar);
  return c
    ? { ok: true, value: c }
    : { ok: false, failure: { kind: "bad-output", detail: "Helper returned no calendar" } };
}

export function parseOk(stdout: string): Parsed<string> {
  const p = parseHelperOutput(stdout);
  if (!p.ok) return p;
  return { ok: true, value: str(p.value.detail, "ok") };
}

/** User-facing wording for each failure class. Never hides a denied or unavailable source as "nothing". */
export function failureText(f: Failure): { title: string; description: string } {
  switch (f.kind) {
    case "helper-missing":
      return {
        title: "Helper not installed",
        description: "Run `npm run dev` in the project folder, wait for the build, then stop it.",
      };
    case "helper-not-executable":
      return { title: "Helper not executable", description: "Rebuild and re-import with `npm run dev`." };
    case "timeout":
      return { title: "Calendar helper timed out", description: f.detail };
    case "bad-output":
      return { title: "Helper returned unexpected output", description: f.detail };
    case "helper-error":
      return { title: "Helper failed", description: f.detail };
    case "helper":
      switch (f.code) {
        case "denied":
          return {
            title: "Access denied",
            description:
              "System Settings → Privacy & Security → Calendars / Reminders → turn on Raycast. Quit Raycast first if you change it.",
          };
        case "not-determined":
          return { title: "Access not requested yet", description: "Open My Day Setup and request access." };
        case "write-only":
          return {
            title: "Only write access granted",
            description: "Full Calendar access is needed to show events. Change it in System Settings.",
          };
        case "restricted":
          return {
            title: "Access restricted",
            description: "This Mac's policy restricts Calendar or Reminders access.",
          };
        case "conflict":
          return { title: "Changed outside My Day", description: f.message };
        case "not-found":
          return { title: "Item no longer exists", description: f.message };
        case "read-only":
          return { title: "Read-only calendar or list", description: f.message };
        case "recurring":
          return { title: "Recurring item", description: f.message };
        default:
          return { title: `Helper error (${f.code})`, description: f.message };
      }
  }
}
