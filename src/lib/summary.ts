// Pure presentation helpers for the My Day header, start-time and alert pickers, and multi-day labels.
import type { Agenda } from "./agenda.ts";
import { compareDays, dayKeyOf, formatClock, formatTime, type DayKey } from "./dates.ts";
import type { EventInfo } from "./eventkit-protocol.ts";

export function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 events · 1 work block · 3 reminders due · 1 overdue · 4 checklist items (1 done)" — only non-zero parts. */
export function daySummary(agenda: Agenda): string {
  const events = agenda.allDay.length + agenda.schedule.filter((r) => !r.link).length;
  const blocks = agenda.schedule.filter((r) => r.link).length;
  const done = agenda.tasks.filter((t) => t.checked).length;
  const parts = [
    events ? plural(events, "event") : null,
    blocks ? plural(blocks, "work block") : null,
    agenda.dueToday.length ? `${plural(agenda.dueToday.length, "reminder")} due` : null,
    agenda.overdue.length ? `${agenda.overdue.length} overdue` : null,
    agenda.tasks.length ? `${plural(agenda.tasks.length, "checklist item")}${done ? ` (${done} done)` : ""}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing planned yet";
}

export interface DayCounts {
  events: number;
  blocks: number;
  remindersDue: number;
  overdue: number;
  items: number;
  itemsDone: number;
}

export function dayCounts(agenda: Agenda): DayCounts {
  return {
    events: agenda.allDay.length + agenda.schedule.filter((r) => !r.link).length,
    blocks: agenda.schedule.filter((r) => r.link).length,
    remindersDue: agenda.dueToday.length,
    overdue: agenda.overdue.length,
    items: agenda.tasks.length,
    itemsDone: agenda.tasks.filter((t) => t.checked).length,
  };
}

export interface NextUp {
  /** Row id of the event, so the agenda can tag that row instead of repeating it. */
  id: string;
  title: string;
  label: string;
  /** Short form for a row tag: "now" or "next · in 45 min". */
  short: string;
  isBlock: boolean;
}

/** The current or next timed item today: "now, until 3:00 PM" or "in 45 min at 2:15 PM". */
export function nextUp(agenda: Agenda, now: Date): NextUp | null {
  if (agenda.day !== dayKeyOf(now)) return null;
  for (const row of agenda.schedule) {
    const s = new Date(row.event.start);
    const e = new Date(row.event.end);
    if (e <= now) continue;
    const title = row.event.title || "(no title)";
    if (s <= now)
      return { id: row.id, title, label: `now, until ${formatTime(e)}`, short: "now", isBlock: Boolean(row.link) };
    const mins = Math.round((s.getTime() - now.getTime()) / 60_000);
    const inText =
      mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min` : ""}`.trim();
    return {
      id: row.id,
      title,
      label: `${inText} at ${formatTime(s)}`,
      short: `next · ${inText}`,
      isBlock: Boolean(row.link),
    };
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Wed 28 Oct": weekday first, like every other date in My Day (owner 2026-10-05). */
function shortDay(day: DayKey): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[m - 1]}`;
}
export function daysBetween(a: DayKey, b: DayKey): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** For an event spanning several local days: "Wed 28 Oct – Thu 19 Nov · day 3 of 23". Null for single-day events. */
export function spanLabel(
  e: Pick<EventInfo, "isAllDay" | "start" | "end" | "startDay" | "endDay">,
  day: DayKey,
): string | null {
  const first = e.isAllDay ? e.startDay : dayKeyOf(new Date(e.start));
  const endInstant = new Date(new Date(e.end).getTime() - 1);
  const last = e.isAllDay ? e.endDay : dayKeyOf(endInstant);
  if (!first || !last || compareDays(first, last) >= 0) return null;
  const total = daysBetween(first, last) + 1;
  const n = daysBetween(first, day) + 1;
  return `${shortDay(first)} – ${shortDay(last)} · day ${n} of ${total}`;
}

export interface TimeOption {
  value: string; // "HH:MM" 24-hour, stable
  title: string; // in the display style
  keywords: string[]; // both styles, so typing "14", "2pm" or "2:30" finds it
}

/** Start-time choices every `step` minutes, plus `extra` (e.g. an existing odd start), titled in the display style. */
export function timeOptions(step = 15, extra?: { hour: number; minute: number }, use24?: boolean): TimeOption[] {
  const slots: { hour: number; minute: number }[] = [];
  for (let m = 0; m < 24 * 60; m += step) slots.push({ hour: Math.floor(m / 60), minute: m % 60 });
  if (extra && !slots.some((s) => s.hour === extra.hour && s.minute === extra.minute)) {
    slots.push(extra);
    slots.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  }
  return slots.map(({ hour, minute }) => {
    const v24 = formatClock(hour, minute, true);
    const v12 = formatClock(hour, minute, false);
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    const ampm = hour < 12 ? "am" : "pm";
    return {
      value: v24,
      title: use24 === undefined ? formatClock(hour, minute) : use24 ? v24 : v12,
      keywords: [v24, v12, `${h12}${ampm}`, `${h12}:${String(minute).padStart(2, "0")}${ampm}`, v24.replace(":", "")],
    };
  });
}

export function parseTimeValue(v: string): { hour: number; minute: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** Alert choices for events and work blocks. "default" leaves the calendar's own default alert alone. */
export const ALERT_OPTIONS: { value: string; title: string; minutes: number[] | null }[] = [
  { value: "default", title: "Calendar default", minutes: null },
  { value: "none", title: "No alert", minutes: [] },
  { value: "0", title: "At time of event", minutes: [0] },
  { value: "5", title: "5 minutes before", minutes: [5] },
  { value: "10", title: "10 minutes before", minutes: [10] },
  { value: "15", title: "15 minutes before", minutes: [15] },
  { value: "30", title: "30 minutes before", minutes: [30] },
  { value: "60", title: "1 hour before", minutes: [60] },
  { value: "120", title: "2 hours before", minutes: [120] },
  { value: "1440", title: "1 day before", minutes: [1440] },
];

export function alertMinutes(value: string): number[] | undefined {
  const o = ALERT_OPTIONS.find((x) => x.value === value);
  return o ? (o.minutes ?? undefined) : undefined;
}

export function describeAlerts(minutes: number[]): string {
  if (!minutes.length) return "No alert";
  return minutes
    .map(
      (m) => ALERT_OPTIONS.find((o) => o.minutes?.length === 1 && o.minutes[0] === m)?.title ?? `${m} minutes before`,
    )
    .join(", ");
}

export type FreeState =
  { kind: "busy"; until: Date } | { kind: "free"; until: Date; minutes: number } | { kind: "clear" };

/**
 * Time until the next timed event (owner feedback 2026-10-05: "free until the next scheduled item", not until the
 * end of the working day). During an event, busy until the end of it and of anything overlapping or back to back.
 */
export function freeUntil(events: { start: string; end: string }[], now: Date): FreeState {
  const t = now.getTime();
  const spans = events
    .map((e) => ({ s: new Date(e.start).getTime(), e: new Date(e.end).getTime() }))
    .filter((x) => x.e > t && x.e > x.s)
    .sort((a, b) => a.s - b.s);
  if (spans.some((x) => x.s <= t)) {
    let until = Math.max(...spans.filter((x) => x.s <= t).map((x) => x.e));
    for (const x of spans) if (x.s <= until && x.e > until) until = x.e;
    return { kind: "busy", until: new Date(until) };
  }
  const next = spans[0];
  if (!next) return { kind: "clear" };
  return { kind: "free", until: new Date(next.s), minutes: Math.round((next.s - t) / 60_000) };
}

/** Tag text for an overdue reminder: "overdue 9:00 AM" today, "1 day overdue", "3 days overdue". */
export function overdueLabel(dueDay: DayKey, today: DayKey, dueTime: Date | null): string {
  const days = daysBetween(dueDay, today);
  if (days <= 0) return dueTime ? `overdue since ${formatTime(dueTime)}` : "overdue";
  return `${days} day${days === 1 ? "" : "s"} overdue`;
}
