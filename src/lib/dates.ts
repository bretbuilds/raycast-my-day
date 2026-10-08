// Local-day arithmetic. Day keys are "YYYY-MM-DD" in the device's current zone (or an injected zone for tests).
// Never does `start + 24h`: DST days are 23 or 25 hours long.

export type DayKey = string; // YYYY-MM-DD

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDayKey(s: unknown): s is DayKey {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Parts of an instant in a time zone (Intl-based so tests can pin a zone). */
export function partsIn(
  instant: Date,
  timeZone?: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  if (!timeZone) {
    return {
      year: instant.getFullYear(),
      month: instant.getMonth() + 1,
      day: instant.getDate(),
      hour: instant.getHours(),
      minute: instant.getMinutes(),
    };
  }
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(instant)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
  };
}

export function dayKeyOf(instant: Date, timeZone?: string): DayKey {
  const p = partsIn(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function todayKey(now = new Date(), timeZone?: string): DayKey {
  return dayKeyOf(now, timeZone);
}

/** Adds calendar days to a day key (pure calendar arithmetic, zone-independent). */
export function addDays(day: DayKey, n: number): DayKey {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function compareDays(a: DayKey, b: DayKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Local midnight that starts `day` in the device zone (used for helper queries in the device zone only). */
export function startOfLocalDay(day: DayKey): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** Query window for a day: [local midnight, next local midnight). DST-safe because it uses calendar fields. */
export function dayWindow(day: DayKey): { from: Date; to: Date } {
  return { from: startOfLocalDay(day), to: startOfLocalDay(addDays(day, 1)) };
}

/** A timed event belongs to a day when its [start, end) overlaps the day's local window. */
export function timedEventOnDay(startISO: string, endISO: string, day: DayKey, timeZone?: string): boolean {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const startDay = dayKeyOf(start, timeZone);
  // Zero-length or end exactly at a midnight: the end instant itself is excluded.
  const endAdjusted = end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : end;
  const endDay = dayKeyOf(endAdjusted, timeZone);
  return compareDays(startDay, day) <= 0 && compareDays(endDay, day) >= 0;
}

/** All-day events carry their local day span from the helper (startDay..endDay inclusive). */
export function allDayEventOnDay(startDay: DayKey, endDay: DayKey, day: DayKey): boolean {
  return compareDays(startDay, day) <= 0 && compareDays(endDay, day) >= 0;
}

let clock24 = true;
/** Display style for times: the Mac's 12/24-hour setting or the extension preference (set once per launch). */
export function setClock24(value: boolean): void {
  clock24 = value;
}
export function usesClock24(): boolean {
  return clock24;
}

/** "14:05" or "2:05 PM" depending on the display style. */
export function formatClock(hour: number, minute: number, use24 = clock24): string {
  if (use24) return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export function formatTime(instant: Date, timeZone?: string, use24 = clock24): string {
  const p = partsIn(instant, timeZone);
  return formatClock(p.hour, p.minute, use24);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Fri 2 Oct 2026" */
export function formatDay(day: DayKey): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[dt.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** "Today", "Tomorrow", "Yesterday" or the formatted day. */
export function relativeDay(day: DayKey, today: DayKey): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  if (day === addDays(today, -1)) return "Yesterday";
  return formatDay(day);
}

export function minutesBetween(startISO: string, endISO: string): number {
  return Math.round((new Date(endISO).getTime() - new Date(startISO).getTime()) / 60_000);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Overlap of two [start, end) intervals. */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

/** Next quarter hour at or after `now`, in local time. */
export function nextQuarterHour(now = new Date()): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  const q = Math.ceil(d.getMinutes() / 15) * 15;
  d.setMinutes(q);
  return d;
}

/** Combines a day key with local hour/minute into a local Date. */
export function localDateTime(day: DayKey, hour: number, minute: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute, 0, 0);
}
