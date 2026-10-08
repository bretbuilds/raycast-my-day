// Local scheduling state kept beside the documents (SPEC §5): day assignments, calendar links, estimates,
// collapsed parents, the idempotency journal and source selection. Validated on load; written atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isChecklistId, isLinkId, isTaskId } from "./ids.ts";
import { isDayKey, type DayKey } from "./dates.ts";

export interface Assignment {
  day: DayKey;
  checklistId: string;
  assignedAt: string;
}

export type LinkSource =
  | { kind: "reminder"; itemId: string; externalId: string | null; title: string }
  | { kind: "task"; taskId: string; checklistId: string; title: string };

export interface Link {
  source: LinkSource;
  eventId: string;
  externalId: string | null;
  calendarId: string;
  snapshot: { title: string; start: string; end: string; lastModified: string | null };
  createdAt: string;
  /** Set when a refresh found the event gone; the user clears the link explicitly. */
  missingSince?: string;
}

export interface PendingWrite {
  kind: "create-event" | "create-reminder";
  startedAt: string;
  /** Enough to find the item again: title, window, calendar/list and the marker line for events. */
  probe: { title: string; calendarId?: string; listId?: string; start?: string; end?: string; linkId?: string };
  /** For create-event: the link to record once the event is found. */
  link?: Omit<Link, "eventId" | "externalId" | "snapshot" | "createdAt">;
}

/** The day's main ("needle-moving") task: a checklist item or a reminder. */
export type FocusRef = { kind: "task"; taskId: string; checklistId: string } | { kind: "reminder"; itemId: string };

/** A reminder chosen for a day without changing its due date in Reminders. */
export interface ReminderPick {
  day: DayKey;
  externalId: string | null;
  title: string;
  pickedAt: string;
}

export interface Sources {
  /** null = all calendars; [] = deliberately none. */
  eventCalendarIds: string[] | null;
  reminderListIds: string[] | null;
  defaultCalendarId?: string;
  defaultListId?: string;
  /** Last alert choice in the block/event forms (an ALERT_OPTIONS value). */
  defaultAlert?: string;
}

export interface LocalState {
  schema: 1;
  assignments: Record<string, Assignment>;
  links: Record<string, Link>;
  estimates: Record<string, number>;
  collapsed: Record<string, true>;
  pendingWrites: Record<string, PendingWrite>;
  sources: Sources;
  recent: Record<string, string>;
  checklistOrder: string[];
  /** day → that day's main task. */
  main: Record<DayKey, FocusRef>;
  /** reminder itemId → the day it was picked for. */
  picks: Record<string, ReminderPick>;
}

export function emptyState(): LocalState {
  return {
    schema: 1,
    assignments: {},
    links: {},
    estimates: {},
    collapsed: {},
    pendingWrites: {},
    sources: { eventCalendarIds: null, reminderListIds: null },
    recent: {},
    checklistOrder: [],
    main: {},
    picks: {},
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

export interface ValidationResult {
  state: LocalState;
  dropped: string[];
}

/** Validates an untrusted object into a LocalState, dropping invalid entries and reporting them. */
export function validateState(raw: unknown): ValidationResult {
  const dropped: string[] = [];
  const state = emptyState();
  if (!isRecord(raw)) return { state, dropped: ["root is not an object"] };
  if (raw.schema !== 1) dropped.push(`unknown schema ${String(raw.schema)}`);

  if (isRecord(raw.assignments)) {
    for (const [taskId, a] of Object.entries(raw.assignments)) {
      if (isTaskId(taskId) && isRecord(a) && isDayKey(a.day) && isChecklistId(a.checklistId)) {
        state.assignments[taskId] = {
          day: a.day,
          checklistId: a.checklistId,
          assignedAt: str(a.assignedAt) ? a.assignedAt : "",
        };
      } else dropped.push(`assignment ${taskId}`);
    }
  }
  if (isRecord(raw.links)) {
    for (const [linkId, l] of Object.entries(raw.links)) {
      if (
        !isLinkId(linkId) ||
        !isRecord(l) ||
        !isRecord(l.source) ||
        !str(l.eventId) ||
        !str(l.calendarId) ||
        !isRecord(l.snapshot)
      ) {
        dropped.push(`link ${linkId}`);
        continue;
      }
      const s = l.source;
      let source: LinkSource | null = null;
      if (s.kind === "reminder" && str(s.itemId))
        source = {
          kind: "reminder",
          itemId: s.itemId,
          externalId: strOrNull(s.externalId) ? s.externalId : null,
          title: str(s.title) ? s.title : "",
        };
      if (s.kind === "task" && isTaskId(s.taskId) && isChecklistId(s.checklistId))
        source = { kind: "task", taskId: s.taskId, checklistId: s.checklistId, title: str(s.title) ? s.title : "" };
      const snap = l.snapshot;
      if (!source || !str(snap.start) || !str(snap.end)) {
        dropped.push(`link ${linkId}`);
        continue;
      }
      state.links[linkId] = {
        source,
        eventId: l.eventId,
        externalId: strOrNull(l.externalId) ? l.externalId : null,
        calendarId: l.calendarId,
        snapshot: {
          title: str(snap.title) ? snap.title : "",
          start: snap.start,
          end: snap.end,
          lastModified: strOrNull(snap.lastModified) ? snap.lastModified : null,
        },
        createdAt: str(l.createdAt) ? l.createdAt : "",
        ...(str(l.missingSince) ? { missingSince: l.missingSince } : {}),
      };
    }
  }
  if (isRecord(raw.estimates)) {
    for (const [taskId, m] of Object.entries(raw.estimates)) {
      if (isTaskId(taskId) && typeof m === "number" && Number.isInteger(m) && m > 0 && m <= 24 * 60)
        state.estimates[taskId] = m;
      else dropped.push(`estimate ${taskId}`);
    }
  }
  if (isRecord(raw.collapsed)) for (const k of Object.keys(raw.collapsed)) if (isTaskId(k)) state.collapsed[k] = true;
  if (isRecord(raw.pendingWrites)) {
    for (const [token, p] of Object.entries(raw.pendingWrites)) {
      if (
        isRecord(p) &&
        (p.kind === "create-event" || p.kind === "create-reminder") &&
        isRecord(p.probe) &&
        str(p.probe.title) &&
        str(p.startedAt)
      ) {
        state.pendingWrites[token] = p as unknown as PendingWrite;
      } else dropped.push(`pendingWrite ${token}`);
    }
  }
  if (isRecord(raw.sources)) {
    const s = raw.sources;
    const ids = (v: unknown): string[] | null => (v === null ? null : Array.isArray(v) ? v.filter(str) : null);
    state.sources = {
      eventCalendarIds: "eventCalendarIds" in s ? ids(s.eventCalendarIds) : null,
      reminderListIds: "reminderListIds" in s ? ids(s.reminderListIds) : null,
      ...(str(s.defaultCalendarId) ? { defaultCalendarId: s.defaultCalendarId } : {}),
      ...(str(s.defaultListId) ? { defaultListId: s.defaultListId } : {}),
      ...(str(s.defaultAlert) ? { defaultAlert: s.defaultAlert } : {}),
    };
  }
  if (isRecord(raw.recent))
    for (const [k, v] of Object.entries(raw.recent)) if (isChecklistId(k) && str(v)) state.recent[k] = v;
  if (Array.isArray(raw.checklistOrder)) state.checklistOrder = raw.checklistOrder.filter(isChecklistId);
  if (isRecord(raw.main)) {
    for (const [day, m] of Object.entries(raw.main)) {
      if (isDayKey(day) && isRecord(m) && m.kind === "task" && isTaskId(m.taskId) && isChecklistId(m.checklistId))
        state.main[day] = { kind: "task", taskId: m.taskId, checklistId: m.checklistId };
      else if (isDayKey(day) && isRecord(m) && m.kind === "reminder" && str(m.itemId) && m.itemId)
        state.main[day] = { kind: "reminder", itemId: m.itemId };
      else dropped.push(`main ${day}`);
    }
  }
  if (isRecord(raw.picks)) {
    for (const [itemId, p] of Object.entries(raw.picks)) {
      if (itemId && isRecord(p) && isDayKey(p.day))
        state.picks[itemId] = {
          day: p.day,
          externalId: strOrNull(p.externalId) ? p.externalId : null,
          title: str(p.title) ? p.title : "",
          pickedAt: str(p.pickedAt) ? p.pickedAt : "",
        };
      else dropped.push(`pick ${itemId}`);
    }
  }
  return { state, dropped };
}

export interface StateStore {
  path: string;
  load(): { state: LocalState; dropped: string[]; corrupt: boolean };
  save(state: LocalState): void;
}

/** File-backed store. A corrupt file is preserved as `state.json.corrupt-<ts>` and an empty state is used. */
export function createStateStore(path: string): StateStore {
  return {
    path,
    load() {
      if (!existsSync(path)) return { state: emptyState(), dropped: [], corrupt: false };
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        try {
          copyFileSync(path, `${path}.corrupt-${Date.now()}`);
        } catch {
          // best effort
        }
        return {
          state: emptyState(),
          dropped: ["state.json was not valid JSON; preserved as .corrupt copy"],
          corrupt: true,
        };
      }
      const { state, dropped } = validateState(raw);
      return { state, dropped, corrupt: false };
    },
    save(state: LocalState) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = join(dirname(path), `.state.json.tmp-${process.pid}`);
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, path);
    },
  };
}

/** Assigns a task to a day; returns the previous day when it moved. */
export function assignDay(
  state: LocalState,
  taskId: string,
  checklistId: string,
  day: DayKey,
  now = new Date(),
): DayKey | null {
  const previous = state.assignments[taskId]?.day ?? null;
  state.assignments[taskId] = { day, checklistId, assignedAt: now.toISOString() };
  return previous && previous !== day ? previous : null;
}

export function unassignDay(state: LocalState, taskId: string): boolean {
  if (!state.assignments[taskId]) return false;
  delete state.assignments[taskId];
  return true;
}

export function linksForSource(
  state: LocalState,
  source: { kind: "task"; taskId: string } | { kind: "reminder"; itemId: string },
): [string, Link][] {
  return Object.entries(state.links).filter(([, l]) =>
    source.kind === "task"
      ? l.source.kind === "task" && l.source.taskId === source.taskId
      : l.source.kind === "reminder" && l.source.itemId === source.itemId,
  );
}

/**
 * Removes assignments and links for tasks of a checklist that no longer exist in `liveTaskIds`. Estimates and
 * collapsed flags are not keyed by checklist, so callers remove those for the task ids they deleted.
 */
export function pruneTasks(state: LocalState, checklistId: string, liveTaskIds: Set<string>): number {
  let removed = 0;
  for (const [taskId, a] of Object.entries(state.assignments)) {
    if (a.checklistId === checklistId && !liveTaskIds.has(taskId)) {
      delete state.assignments[taskId];
      removed++;
    }
  }
  for (const [linkId, l] of Object.entries(state.links)) {
    if (l.source.kind === "task" && l.source.checklistId === checklistId && !liveTaskIds.has(l.source.taskId)) {
      delete state.links[linkId];
      removed++;
    }
  }
  return removed;
}

export function sameFocus(a: FocusRef | undefined, b: FocusRef): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === "task" ? a.taskId === (b as typeof a).taskId : a.itemId === (b as typeof a).itemId;
}

/** Makes `ref` the day's main task. A checklist item is also put on the day; a reminder is picked for it. */
export function setMain(
  state: LocalState,
  day: DayKey,
  ref: FocusRef,
  reminder?: { externalId: string | null; title: string },
  now = new Date(),
): void {
  state.main[day] = ref;
  if (ref.kind === "task") {
    if (state.assignments[ref.taskId]?.day !== day) assignDay(state, ref.taskId, ref.checklistId, day, now);
  } else if (reminder && state.picks[ref.itemId]?.day !== day) {
    pickReminder(state, ref.itemId, day, reminder, now);
  }
}

/** Clears the main task when it is `ref` (or unconditionally without `ref`); the item stays on the day. */
export function clearMain(state: LocalState, day: DayKey, ref?: FocusRef): boolean {
  const current = state.main[day];
  if (!current || (ref && !sameFocus(current, ref))) return false;
  delete state.main[day];
  return true;
}

export function pickReminder(
  state: LocalState,
  itemId: string,
  day: DayKey,
  reminder: { externalId: string | null; title: string },
  now = new Date(),
): DayKey | null {
  const previous = state.picks[itemId]?.day ?? null;
  state.picks[itemId] = { day, externalId: reminder.externalId, title: reminder.title, pickedAt: now.toISOString() };
  return previous && previous !== day ? previous : null;
}

export function unpickReminder(state: LocalState, itemId: string): boolean {
  if (!state.picks[itemId]) return false;
  delete state.picks[itemId];
  return true;
}

/**
 * Moves a planned item (checklist item or picked reminder) to another day. A main task stays main on the new day
 * when that day has none yet; otherwise it becomes a supporting task there.
 */
export function moveFocusItem(state: LocalState, from: DayKey, to: DayKey, ref: FocusRef, now = new Date()): boolean {
  if (ref.kind === "task") {
    const a = state.assignments[ref.taskId];
    assignDay(state, ref.taskId, a?.checklistId ?? ref.checklistId, to, now);
  } else {
    const p = state.picks[ref.itemId];
    if (!p) return false;
    p.day = to;
  }
  if (sameFocus(state.main[from], ref)) {
    delete state.main[from];
    if (!state.main[to]) state.main[to] = ref;
  }
  return true;
}

/** Drops picks and main entries for reminders that are no longer open (completed or deleted). */
export function prunePicks(state: LocalState, openReminderIds: Set<string>): boolean {
  let changed = false;
  for (const id of Object.keys(state.picks))
    if (!openReminderIds.has(id)) {
      delete state.picks[id];
      changed = true;
    }
  for (const [day, m] of Object.entries(state.main))
    if (m.kind === "reminder" && !openReminderIds.has(m.itemId)) {
      delete state.main[day];
      changed = true;
    }
  return changed;
}
