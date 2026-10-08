// Time-based view helpers (owner feedback 2026-10-04): aligned time ranges, free gaps between busy blocks within
// the working day, the default length of a quick work block, and the countdown for Next up.
import type { Agenda } from "./agenda.ts";
import { dayKeyOf, formatTime, localDateTime, partsIn, usesClock24, type DayKey } from "./dates.ts";

const FIGURE_SPACE = " "; // as wide as a digit, so ranges line up in Raycast's proportional font

function clock(d: Date, use24: boolean, withSuffix: boolean): string {
  const p = partsIn(d);
  if (use24) return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const hh = h12 < 10 ? `${FIGURE_SPACE}${h12}` : String(h12);
  return `${hh}:${String(p.minute).padStart(2, "0")}${withSuffix ? (p.hour < 12 ? " AM" : " PM") : ""}`;
}

// " 9:00 – 10:30 AM" style: hours below 10 are padded with a figure space so ranges line up.
export function formatRange(start: Date, end: Date | null, use24 = usesClock24()): string {
  // Same shape on every row ("h:mm AM – h:mm PM"), so the titles after it start at nearly the same place.
  if (!end) return clock(start, use24, true);
  return `${clock(start, use24, true)} – ${clock(end, use24, true)}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 1 Oct" for the left date column (src/lib/columns.ts pads it). */
export function shortDate(day: DayKey): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[m - 1]}`;
}

const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Monday, Oct 5" for section headers, like Raycast's My Schedule (no year). */
export function longDate(day: DayKey): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${WEEKDAYS_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

/** Total free minutes in the gaps. */
export function freeMinutes(gaps: Gap[]): number {
  return gaps.reduce((sum, g) => sum + g.minutes, 0);
}

export interface Gap {
  start: Date;
  end: Date;
  minutes: number;
}

export interface BusyBlock {
  start: string;
  end: string;
  availability?: string;
}

/**
 * Free time on `day` between `dayStartHour` and `dayEndHour` not covered by busy timed events. Events marked
 * "free" do not block. On today, time before `now` (rounded up to 5 minutes) is not offered.
 */
export function freeGaps(
  busy: BusyBlock[],
  day: DayKey,
  now: Date,
  dayStartHour: number,
  dayEndHour: number,
  minMinutes = 15,
): Gap[] {
  let from = localDateTime(day, dayStartHour, 0).getTime();
  const to = localDateTime(day, dayEndHour, 0).getTime();
  if (dayKeyOf(now) === day) {
    const rounded = Math.ceil(now.getTime() / 300_000) * 300_000;
    from = Math.max(from, rounded);
  }
  if (from >= to) return [];
  const intervals = busy
    .filter((b) => b.availability !== "free")
    .map((b) => [Math.max(new Date(b.start).getTime(), from), Math.min(new Date(b.end).getTime(), to)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const gaps: Gap[] = [];
  let cursor = from;
  for (const [s, e] of intervals) {
    if (s > cursor) gaps.push(gap(cursor, s));
    cursor = Math.max(cursor, e);
  }
  if (cursor < to) gaps.push(gap(cursor, to));
  return gaps.filter((g) => g.minutes >= minMinutes);
}

function gap(s: number, e: number): Gap {
  return { start: new Date(s), end: new Date(e), minutes: Math.round((e - s) / 60_000) };
}

export const DEFAULT_BLOCK_MINUTES = 60;

/** A quick block uses the item's estimate, else one hour, never longer than the gap. */
export function quickDuration(estimate: number | null | undefined, gapMinutes: number): number {
  return Math.max(5, Math.min(estimate && estimate > 0 ? estimate : DEFAULT_BLOCK_MINUTES, gapMinutes));
}

export function formatCountdown(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export interface NextItem {
  /** Row id in the agenda (event or reminder row). */
  id: string;
  kind: "event" | "block" | "reminder";
  title: string;
  start: Date;
  end: Date | null;
  ongoing: boolean;
  /** "in 45 min", "now · 15 min left" or "due in 10 min". */
  countdown: string;
}

/** The current or next timed thing today: an event, a work block or a reminder with a time. */
export function nextItem(agenda: Agenda, now: Date): NextItem | null {
  if (agenda.day !== dayKeyOf(now)) return null;
  const candidates: NextItem[] = [];
  for (const row of agenda.schedule) {
    const s = new Date(row.event.start);
    const e = new Date(row.event.end);
    if (e <= now) continue;
    const ongoing = s <= now;
    candidates.push({
      id: row.id,
      kind: row.link ? "block" : "event",
      title: row.event.title || "(no title)",
      start: s,
      end: e,
      ongoing,
      countdown: ongoing
        ? `now · ${formatCountdown(e.getTime() - now.getTime())} left`
        : `in ${formatCountdown(s.getTime() - now.getTime())}`,
    });
  }
  for (const row of agenda.dueToday) {
    const r = row.reminder;
    if (!r.dueHasTime || !r.dueDateTime) continue;
    const s = new Date(r.dueDateTime);
    if (s <= now) continue;
    candidates.push({
      id: row.id,
      kind: "reminder",
      title: r.title || "(no title)",
      start: s,
      end: null,
      ongoing: false,
      countdown: `due in ${formatCountdown(s.getTime() - now.getTime())}`,
    });
  }
  candidates.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || a.start.getTime() - b.start.getTime());
  return candidates[0] ?? null;
}

export { formatTime };
