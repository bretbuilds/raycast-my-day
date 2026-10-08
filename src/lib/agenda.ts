// Pure assembly of one day's agenda from the sources (SPEC §4.1). Nothing here talks to the helper or the
// filesystem; the My Day command feeds it the results of the reads, including per-source failures.
import { addDays, allDayEventOnDay, compareDays, dayKeyOf, timedEventOnDay, todayKey, type DayKey } from "./dates.ts";
import type { CalendarInfo, EventInfo, Failure, ReminderInfo } from "./eventkit-protocol.ts";
import { linkIdFromNotes } from "./links.ts";
import { detailsText } from "./markdown.ts";
import type { Link, LocalState } from "./state.ts";
import type { ChecklistFile } from "./store.ts";
import { locate } from "./tree.ts";

export interface SourceFailure {
  source: "events" | "reminders" | "checklists";
  failure: Failure | { kind: "store"; detail: string };
}

export interface EventRow {
  kind: "event";
  id: string; // event:<itemId>:<occurrenceDate>
  event: EventInfo;
  calendar: CalendarInfo | null;
  link: { id: string; link: Link } | null;
}

export interface ReminderRow {
  kind: "reminder";
  id: string; // reminder:<itemId>
  reminder: ReminderInfo;
  list: CalendarInfo | null;
  overdue: boolean;
  links: [string, Link][];
  /** Picked for this day (or carried from an earlier day's pick) without a due date on it. */
  picked?: boolean;
  /** Set on today's agenda for picks from an earlier day that are still open. */
  carriedFrom?: DayKey;
}

export interface TaskRow {
  kind: "task";
  id: string; // task:<taskId>
  taskId: string;
  checklist: ChecklistFile;
  title: string;
  checked: boolean;
  parentChain: string[];
  details: string;
  estimate: number | null;
  links: [string, Link][];
  missing: boolean; // assignment points at a task no longer in the file
  /** Set on today's agenda for open items assigned to an earlier day. */
  carriedFrom?: DayKey;
}

export type PlanRow = TaskRow | ReminderRow;

export interface Agenda {
  day: DayKey;
  overdue: ReminderRow[];
  allDay: EventRow[];
  schedule: EventRow[];
  dueToday: ReminderRow[];
  /** Every checklist item on the day (main included). */
  tasks: TaskRow[];
  /** The day's main task (pulled out of the other lists). */
  main: PlanRow | null;
  /** Checklist items on the day, except the main task. Open items first. */
  supporting: PlanRow[];
  /** Reminders picked from the backlog for the day (carried onto today while open). Shown with the reminders. */
  picked: ReminderRow[];
  pinned: ChecklistFile[];
  failures: SourceFailure[];
  /** Reminders not shown for this day (undated or due on other days, incomplete) for the picker. */
  otherReminders: ReminderRow[];
}

export interface AgendaInputs {
  day: DayKey;
  events: EventInfo[] | null;
  reminders: ReminderInfo[] | null;
  calendars: CalendarInfo[];
  lists: CalendarInfo[];
  checklists: ChecklistFile[];
  state: LocalState;
  failures: SourceFailure[];
  timeZone?: string;
  /** The real current day; overdue means "due before today", shown on today's agenda only. */
  today?: DayKey;
  /** The current time; a timed reminder due earlier today counts as overdue (as in Reminders). */
  now?: Date;
}

/**
 * Same-titled all-day events on the same day collapse to one (owner 2026-10-05: four holiday calendars listed
 * "Halloween" four times). Timed events are never merged.
 */
export function dedupeAllDay<T extends { event: EventInfo }>(rows: T[], dayOf: (r: T) => string = () => ""): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!r.event.isAllDay) return true;
    const k = `${dayOf(r)}|${r.event.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Applies the user's source selection: null = all, [] = deliberately none. */
export function selectedIds(selection: string[] | null, available: CalendarInfo[]): Set<string> | null {
  if (selection === null) return null;
  const ok = new Set(available.map((c) => c.id));
  return new Set(selection.filter((id) => ok.has(id)));
}

export function buildAgenda(input: AgendaInputs): Agenda {
  const { day, state } = input;
  const today = input.today ?? todayKey();
  const now = input.now ?? new Date();
  const calById = new Map(input.calendars.map((c) => [c.id, c]));
  const listById = new Map(input.lists.map((c) => [c.id, c]));
  const linkByEvent = new Map<string, { id: string; link: Link }>();
  for (const [id, link] of Object.entries(state.links)) {
    linkByEvent.set(link.eventId, { id, link });
    if (link.externalId) linkByEvent.set(`ext:${link.externalId}`, { id, link });
  }
  const linksBySource = { task: new Map<string, [string, Link][]>(), reminder: new Map<string, [string, Link][]>() };
  for (const [id, link] of Object.entries(state.links)) {
    const key = link.source.kind === "task" ? link.source.taskId : link.source.itemId;
    const map = link.source.kind === "task" ? linksBySource.task : linksBySource.reminder;
    map.set(key, [...(map.get(key) ?? []), [id, link]]);
  }

  const calSel = selectedIds(state.sources.eventCalendarIds, input.calendars);
  const listSel = selectedIds(state.sources.reminderListIds, input.lists);

  const allDay: EventRow[] = [];
  const schedule: EventRow[] = [];
  for (const e of input.events ?? []) {
    if (calSel && !calSel.has(e.calendarId)) continue;
    const onDay = e.isAllDay
      ? allDayEventOnDay(e.startDay, e.endDay, day)
      : timedEventOnDay(e.start, e.end, day, input.timeZone);
    if (!onDay) continue;
    const marker = linkIdFromNotes(e.notes);
    const link =
      (e.eventId && linkByEvent.get(e.eventId)) ||
      (e.externalId && linkByEvent.get(`ext:${e.externalId}`)) ||
      (marker && state.links[marker] ? { id: marker, link: state.links[marker] } : null) ||
      null;
    const row: EventRow = {
      kind: "event",
      id: `event:${e.itemId}:${e.occurrenceDate ?? e.start}`,
      event: e,
      calendar: calById.get(e.calendarId) ?? null,
      link,
    };
    (e.isAllDay ? allDay : schedule).push(row);
  }
  schedule.sort(
    (a, b) =>
      a.event.start.localeCompare(b.event.start) ||
      a.event.end.localeCompare(b.event.end) ||
      a.event.title.localeCompare(b.event.title) ||
      a.id.localeCompare(b.id),
  );
  allDay.sort((a, b) => a.event.title.localeCompare(b.event.title) || a.id.localeCompare(b.id));

  const overdue: ReminderRow[] = [];
  const dueToday: ReminderRow[] = [];
  const otherReminders: ReminderRow[] = [];
  const picked: ReminderRow[] = [];
  for (const r of input.reminders ?? []) {
    if (listSel && !listSel.has(r.listId)) continue;
    if (r.isCompleted) continue;
    const row: ReminderRow = {
      kind: "reminder",
      id: `reminder:${r.itemId}`,
      reminder: r,
      list: listById.get(r.listId) ?? null,
      overdue: false,
      links: linksBySource.reminder.get(r.itemId) ?? [],
    };
    // Overdue = due before the real today, listed on today's agenda. Looking at another day never turns a
    // reminder that is merely due earlier than that day into "overdue" (owner test 2026-10-04).
    const pick = state.picks[r.itemId];
    const pastTimeToday =
      day === today && r.dueDay === today && r.dueHasTime && r.dueDateTime && new Date(r.dueDateTime) < now;
    if (pastTimeToday) {
      row.overdue = true;
      overdue.push(row);
    } else if (r.dueDay === day) dueToday.push(row);
    else if (r.dueDay && compareDays(r.dueDay, today) < 0 && day === today) {
      row.overdue = true;
      overdue.push(row);
    } else if (pick && (pick.day === day || (day === today && compareDays(pick.day, today) < 0))) {
      // Picked from the backlog for this day; shown with the day's reminders, never as a task (owner 2026-10-05).
      row.picked = true;
      if (pick.day !== day) row.carriedFrom = pick.day;
      picked.push(row);
    } else if (!(r.dueDay && compareDays(r.dueDay, today) < 0)) otherReminders.push(row);
  }
  const byDue = (a: ReminderRow, b: ReminderRow) =>
    (a.reminder.dueDay ?? "").localeCompare(b.reminder.dueDay ?? "") ||
    (a.reminder.dueDateTime ?? "").localeCompare(b.reminder.dueDateTime ?? "") ||
    a.reminder.title.localeCompare(b.reminder.title) ||
    a.id.localeCompare(b.id);
  overdue.sort(byDue);
  dueToday.sort((a, b) => Number(!a.reminder.dueHasTime) - Number(!b.reminder.dueHasTime) || byDue(a, b));
  otherReminders.sort((a, b) => Number(!a.reminder.dueDay) - Number(!b.reminder.dueDay) || byDue(a, b));

  const tasks: TaskRow[] = [];
  const byChecklist = new Map(input.checklists.map((c) => [c.id, c]));
  for (const [taskId, a] of Object.entries(state.assignments)) {
    const carried = a.day !== day && day === today && compareDays(a.day, today) < 0;
    if (a.day !== day && !carried) continue;
    const checklist = byChecklist.get(a.checklistId);
    if (!checklist || checklist.archived) continue;
    const loc = locate(checklist.doc, taskId);
    if (carried && (!loc || loc.node.checked)) continue;
    if (!loc) {
      tasks.push({
        kind: "task",
        id: `task:${taskId}`,
        taskId,
        checklist,
        title: "(task no longer in the checklist)",
        checked: false,
        parentChain: [],
        details: "",
        estimate: null,
        links: [],
        missing: true,
      });
      continue;
    }
    tasks.push({
      kind: "task",
      id: `task:${taskId}`,
      taskId,
      checklist,
      title: loc.node.title,
      checked: loc.node.checked,
      parentChain: loc.chain.map((n) => n.title),
      details: detailsText(loc.node),
      estimate: state.estimates[taskId] ?? null,
      links: linksBySource.task.get(taskId) ?? [],
      missing: false,
      ...(carried ? { carriedFrom: a.day } : {}),
    });
  }
  const order = new Map(input.checklists.map((c, i) => [c.id, i]));
  tasks.sort(
    (a, b) => (order.get(a.checklist.id) ?? 0) - (order.get(b.checklist.id) ?? 0) || positionIn(a) - positionIn(b),
  );

  picked.sort((a, b) => (a.carriedFrom ?? "").localeCompare(b.carriedFrom ?? "") || byDue(a, b));

  // The main task is pulled out of whichever list it landed in, so every item shows once.
  let main: PlanRow | null = null;
  const focus = state.main[day];
  // Main and Supporting hold checklist tasks only; an older reminder "main" is ignored (owner 2026-10-05).
  if (focus?.kind === "task") main = tasks.find((t) => t.taskId === focus.taskId && !t.missing) ?? null;
  const supporting: PlanRow[] = tasks.filter((t) => t !== main);
  const isDone = (r: PlanRow) => r.kind === "task" && r.checked;
  supporting.sort((a, b) => Number(isDone(a)) - Number(isDone(b)));

  return {
    day,
    overdue,
    allDay: dedupeAllDay(allDay),
    schedule,
    dueToday,
    tasks,
    main,
    supporting,
    picked,
    pinned: input.checklists.filter((c) => c.pinned && !c.archived),
    failures: input.failures,
    otherReminders,
  };
}

function positionIn(row: TaskRow): number {
  // Document order: index among all tasks of the checklist.
  let i = 0;
  const walk = (nodes: { id: string; children: unknown[] }[]): number => {
    for (const n of nodes) {
      if (n.id === row.taskId) return i;
      i++;
      const r = walk(n.children as { id: string; children: unknown[] }[]);
      if (r >= 0) return r;
    }
    return -1;
  };
  return walk(row.checklist.doc.blocks.filter((b): b is Extract<typeof b, { kind: "task" }> => b.kind === "task"));
}

/** Overlap check for a proposed block against the day's timed events (never across failed sources). */
export function overlappingEvents(
  schedule: EventRow[],
  startISO: string,
  endISO: string,
  excludeEventId?: string,
): EventRow[] {
  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();
  return schedule.filter((row) => {
    if (excludeEventId && row.event.eventId === excludeEventId) return false;
    const rs = new Date(row.event.start).getTime();
    const re = new Date(row.event.end).getTime();
    return rs < e && s < re;
  });
}

/** How far ahead the "Coming up" section looks (owner 2026-10-05: holidays and events beyond tomorrow). */
export const UPCOMING_DAYS = 31;

export interface UpcomingEvent {
  /** The first day of the window the event touches (an event already under way shows on `from`). */
  day: DayKey;
  row: EventRow;
}

/**
 * Events touching [from, to] for the Coming up section: each event once, on its first visible day, ordered by
 * that day, all-day before timed, then start time. Respects the calendar selection.
 */
export function upcomingEvents(
  input: Pick<AgendaInputs, "events" | "calendars" | "state" | "timeZone">,
  from: DayKey,
  to: DayKey,
): UpcomingEvent[] {
  const calById = new Map(input.calendars.map((c) => [c.id, c]));
  const calSel = selectedIds(input.state.sources.eventCalendarIds, input.calendars);
  const out: UpcomingEvent[] = [];
  for (const e of input.events ?? []) {
    if (calSel && !calSel.has(e.calendarId)) continue;
    const first = e.isAllDay ? e.startDay : dayKeyOf(new Date(e.start), input.timeZone);
    const last = e.isAllDay ? e.endDay : dayKeyOf(new Date(new Date(e.end).getTime() - 1), input.timeZone);
    if (!first || !last || compareDays(last, from) < 0 || compareDays(first, to) > 0) continue;
    out.push({
      day: compareDays(first, from) < 0 ? from : first,
      row: {
        kind: "event",
        id: `event:${e.itemId}:${e.occurrenceDate ?? e.start}`,
        event: e,
        calendar: calById.get(e.calendarId) ?? null,
        link: null,
      },
    });
  }
  out.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      Number(!a.row.event.isAllDay) - Number(!b.row.event.isAllDay) ||
      a.row.event.start.localeCompare(b.row.event.start) ||
      a.row.event.title.localeCompare(b.row.event.title),
  );
  return dedupeAllDay(
    out.map((u) => ({ ...u, event: u.row.event })),
    (u) => u.day,
  ).map(({ day, row }) => ({ day, row }));
}

/** My Schedule-style groups for Coming up: "Later this week", "Next week", "Rest of October", "November". */
export function upcomingGroup(day: DayKey, today: DayKey): string {
  const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const dow = (d: DayKey) => {
    const [y, m, dd] = d.split("-").map(Number);
    return (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7; // Monday = 0
  };
  const endOfWeek = addDays(today, 6 - dow(today));
  if (compareDays(day, endOfWeek) <= 0) return "Later this week";
  if (compareDays(day, addDays(endOfWeek, 7)) <= 0) return "Next week";
  const month = Number(day.slice(5, 7)) - 1;
  return day.slice(0, 7) === today.slice(0, 7) ? `Rest of ${MONTHS[month]}` : MONTHS[month];
}
