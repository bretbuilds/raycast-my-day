// Pure validation and option helpers for the creation forms (SPEC §4.2). No Raycast imports.
import { dayKeyOf, localDateTime, type DayKey } from "./dates.ts";
import type { CalendarInfo } from "./eventkit-protocol.ts";

export const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const;

export interface EventDraft {
  title: string;
  calendarId: string;
  isAllDay: boolean;
  day: DayKey | null;
  /** Inclusive last day of an all-day event; null or equal to `day` for one day. */
  endDay?: DayKey | null;
  start: Date | null;
  end: Date | null;
  location?: string;
  url?: string;
  notes?: string;
}

export type FieldErrors = Partial<
  Record<
    "title" | "calendarId" | "day" | "endDay" | "start" | "end" | "url" | "listId" | "dueDate" | "duration",
    string
  >
>;

export function validateEvent(d: EventDraft, calendars: CalendarInfo[]): FieldErrors {
  const errors: FieldErrors = {};
  if (!d.title.trim()) errors.title = "Title is required";
  else if (d.title.length > 1000) errors.title = "Title is too long";
  const cal = calendars.find((c) => c.id === d.calendarId);
  if (!cal) errors.calendarId = "Choose a calendar";
  else if (!cal.allowsModifications) errors.calendarId = `${cal.title} is read-only`;
  if (d.isAllDay) {
    if (!d.day) errors.day = "Choose a day";
    else if (d.endDay && d.endDay < d.day) errors.endDay = "End date must be on or after the start date";
  } else {
    if (!d.start) errors.start = "Choose a start";
    if (!d.end) errors.end = "Choose an end";
    if (d.start && d.end && d.end.getTime() <= d.start.getTime()) errors.end = "End must be after start";
    if (d.start && d.end && d.end.getTime() - d.start.getTime() > 7 * 86_400_000)
      errors.end = "Timed events longer than a week are not supported here";
  }
  if (d.url && !isSafeUrl(d.url)) errors.url = "Only http(s), mailto and obsidian links";
  return errors;
}

export function isSafeUrl(u: string): boolean {
  return /^(https?:\/\/|mailto:|obsidian:\/\/)[^\s]+$/i.test(u.trim());
}

export interface ReminderDraft {
  title: string;
  listId: string;
  dueMode: "none" | "date" | "datetime";
  due: Date | null;
}

export function validateReminder(d: ReminderDraft, lists: CalendarInfo[]): FieldErrors {
  const errors: FieldErrors = {};
  if (!d.title.trim()) errors.title = "Title is required";
  const list = lists.find((c) => c.id === d.listId);
  if (!list) errors.listId = "Choose a list";
  else if (!list.allowsModifications) errors.listId = `${list.title} is read-only`;
  if (d.dueMode !== "none" && !d.due) errors.dueDate = "Choose a date";
  return errors;
}

/** Converts a reminder draft to the helper's due fields: none / date only / date with local time. */
export function reminderDueFields(d: ReminderDraft): { dueDay: string | null; dueTime: string | null } {
  if (d.dueMode === "none" || !d.due) return { dueDay: null, dueTime: null };
  const dueDay = dayKeyOf(d.due);
  if (d.dueMode === "date") return { dueDay, dueTime: null };
  return {
    dueDay,
    dueTime: `${String(d.due.getHours()).padStart(2, "0")}:${String(d.due.getMinutes()).padStart(2, "0")}`,
  };
}

export interface BlockDraft {
  day: DayKey;
  startHour: number;
  startMinute: number;
  durationMinutes: number;
}

export function blockRange(b: BlockDraft): { start: Date; end: Date } {
  const start = localDateTime(b.day, b.startHour, b.startMinute);
  return { start, end: new Date(start.getTime() + b.durationMinutes * 60_000) };
}

export function validateBlock(b: BlockDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (!Number.isInteger(b.durationMinutes) || b.durationMinutes < 5 || b.durationMinutes > 24 * 60)
    errors.duration = "Duration must be between 5 minutes and 24 hours";
  if (b.startHour < 0 || b.startHour > 23 || b.startMinute < 0 || b.startMinute > 59)
    errors.start = "Invalid start time";
  return errors;
}

/** Parses "9:30", "09:30", "14h", "2pm", "2:15 pm" into hour/minute; null when unrecognised. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|h)?\s*$/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = m[3]?.toLowerCase();
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Parses "30", "30m", "1h", "1h30", "1:30", "90 min" into minutes; null when unrecognised. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  // Days for multi-day timed events: "2d", "2 days", "1d 4h", "1d4h30".
  const d = /^(\d+)\s*d(?:ays?)?\s*(?:(\d+)\s*h(?:ours?)?\s*(\d+)?\s*(?:m|min)?)?$/.exec(t);
  if (d) return Number(d[1]) * 24 * 60 + Number(d[2] ?? 0) * 60 + Number(d[3] ?? 0);
  let m = /^(\d+)\s*(m|min|mins|minutes)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d+)\s*h(?:ours?)?\s*(\d+)?\s*(m|min)?$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2] ?? 0);
  m = /^(\d+):(\d{2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}
