// Pure helpers for the My Day list: search keywords, best-effort "open in app" URLs, failure mapping for
// access states and work-block link verification on refresh (A-B-9). No Raycast imports; tested by node --test.
import type { EventRow, ReminderRow, TaskRow } from "./agenda.ts";
import { dayKeyOf, timedEventOnDay, type DayKey } from "./dates.ts";
import type { AccessStatus, EventInfo, HelperFailure } from "./eventkit-protocol.ts";
import { checkLink, linkIdFromNotes, notesWithoutMarker, snapshotOf } from "./links.ts";
import type { Link, LocalState } from "./state.ts";

export const KEYWORD_NOTES_LIMIT = 500;

export type SourceFilter = "all" | "events" | "reminders" | "tasks";
export const SOURCE_FILTERS: { value: SourceFilter; title: string }[] = [
  { value: "all", title: "All" },
  { value: "events", title: "Events" },
  { value: "reminders", title: "Reminders" },
  { value: "tasks", title: "Checklist items" },
];

export function isSourceFilter(v: unknown): v is SourceFilter {
  return v === "all" || v === "events" || v === "reminders" || v === "tasks";
}

/** True when a section of `kind` is visible under `filter`. */
export function showsSource(filter: SourceFilter, kind: "events" | "reminders" | "tasks"): boolean {
  return filter === "all" || filter === kind;
}

/**
 * Raycast matches the search text against the title and each keyword. Whole strings and their individual
 * words are both offered so a word in the middle of a location or a note still matches. Notes and details
 * contribute only their first KEYWORD_NOTES_LIMIT characters (the documented search scope).
 */
export function buildKeywords(parts: (string | null | undefined)[], longParts: (string | null | undefined)[] = []) {
  const out = new Set<string>();
  const add = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return;
    out.add(t);
    for (const w of t.split(/[\s,.;:!?()[\]{}"'<>/\\|]+/)) if (w.length > 1) out.add(w);
  };
  for (const p of parts) if (p) add(p);
  for (const p of longParts) if (p) add(p.slice(0, KEYWORD_NOTES_LIMIT));
  return [...out];
}

export function eventKeywords(row: EventRow): string[] {
  return buildKeywords(
    [row.event.title, row.calendar?.title, row.event.location, row.link?.link.source.title],
    [notesWithoutMarker(row.event.notes)],
  );
}

export function reminderKeywords(row: ReminderRow): string[] {
  return buildKeywords([row.reminder.title, row.list?.title], [row.reminder.notes]);
}

export function taskKeywords(row: TaskRow): string[] {
  return buildKeywords([row.title, row.checklist.title, ...row.parentChain], [row.details]);
}

// EventKit identifiers are opaque ASCII (UUIDs, sometimes with ":" or "@"). Anything else is refused rather
// than encoded, so no user text can ever reach a URL (SPEC §7.5).
const SAFE_ID = /^[A-Za-z0-9:._@-]{1,200}$/;

/** `ical://ekevent/<yyyyMMdd>/<itemId>?method=show&options=more` (SPEC §3.4, best effort), or null. */
export function calendarEventUrl(event: Pick<EventInfo, "itemId" | "occurrenceDate" | "start">): string | null {
  if (!SAFE_ID.test(event.itemId)) return null;
  const when = new Date(event.occurrenceDate ?? event.start);
  if (Number.isNaN(when.getTime())) return null;
  const day = dayKeyOf(when).replace(/-/g, "");
  return `ical://ekevent/${day}/${event.itemId}?method=show&options=more`;
}

/** `x-apple-reminderkit://REMCDReminder/<itemId>` (best effort), or null. */
export function reminderUrl(itemId: string): string | null {
  return SAFE_ID.test(itemId) ? `x-apple-reminderkit://REMCDReminder/${itemId}` : null;
}

/** A non-full access state reported by `status`, expressed like the helper's own failure codes. */
export function accessFailure(status: AccessStatus, entity: "events" | "reminders"): HelperFailure {
  const what = entity === "events" ? "Calendar" : "Reminders";
  return { kind: "helper", code: status, message: `${what} access is ${status}.` };
}

/** Finds the event a link points at among events already read (id, external id, then the notes marker). */
export function findLinkedEvent(linkId: string, link: Link, events: EventInfo[]): EventInfo | null {
  return (
    events.find((e) => e.eventId === link.eventId) ??
    (link.externalId ? events.find((e) => e.externalId === link.externalId) : undefined) ??
    events.find((e) => linkIdFromNotes(e.notes) === linkId) ??
    null
  );
}

export interface LinkVerification {
  /** linkId → changed fields, for blocks whose event differs from the stored snapshot. */
  edited: Record<string, string[]>;
  /** Links whose block was expected on this day and is not there (missingSince is set on them). */
  missing: [string, Link][];
  /** True when `state` was modified (missingSince set or cleared) and should be saved. */
  changed: boolean;
}

/**
 * Compares every link whose snapshot falls on `day` with the events read for that day. No helper calls:
 * `events` must be the unfiltered result of the day's read, or null when that read failed (then nothing is
 * concluded, because an unavailable source never means "deleted").
 */
export function verifyLinks(
  state: LocalState,
  events: EventInfo[] | null,
  day: DayKey,
  now = new Date(),
  timeZone?: string,
): LinkVerification {
  const result: LinkVerification = { edited: {}, missing: [], changed: false };
  if (!events) return result;
  for (const [linkId, link] of Object.entries(state.links)) {
    const fresh = findLinkedEvent(linkId, link, events);
    const expectedHere = timedEventOnDay(link.snapshot.start, link.snapshot.end, day, timeZone);
    if (fresh) {
      if (link.missingSince) {
        delete link.missingSince;
        result.changed = true;
      }
      const check = checkLink(link, fresh);
      if (check.status === "edited-externally") result.edited[linkId] = check.changes;
      continue;
    }
    if (!expectedHere) continue;
    if (!link.missingSince) {
      link.missingSince = now.toISOString();
      result.changed = true;
    }
    result.missing.push([linkId, link]);
  }
  return result;
}

/** Accepts the calendar's version of a linked block as the new snapshot (after the user acknowledges). */
export function acceptCalendarVersion(link: Link, fresh: EventInfo): void {
  link.snapshot = snapshotOf(fresh);
  delete link.missingSince;
}
