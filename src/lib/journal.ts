// Idempotent native writes (SPEC §7.3). Before a create call the intent is journaled; after a clear outcome the
// entry is resolved. Ambiguous outcomes (timeout, crash between the write and the state save) are reconciled on
// the next launch by searching for the item, never by writing again blindly.
import type { EventInfo, Parsed, ReminderInfo } from "./eventkit-protocol.ts";
import { linkIdFromNotes, snapshotOf } from "./links.ts";
import type { Link, LocalState, PendingWrite } from "./state.ts";
import { addDays, dayKeyOf, dayWindow } from "./dates.ts";

export const RECONCILE_WINDOW_MINUTES = 30;

export function beginWrite(state: LocalState, token: string, pending: PendingWrite): void {
  state.pendingWrites[token] = pending;
}

export function endWrite(state: LocalState, token: string): void {
  delete state.pendingWrites[token];
}

/** Records the link for a created block and clears the journal entry. */
export function recordCreatedBlock(
  state: LocalState,
  token: string,
  linkId: string,
  pending: PendingWrite,
  event: EventInfo,
  now = new Date(),
): Link {
  const link: Link = {
    source: pending.link!.source,
    calendarId: event.calendarId,
    eventId: event.eventId ?? event.itemId,
    externalId: event.externalId,
    snapshot: snapshotOf(event),
    createdAt: now.toISOString(),
  };
  state.links[linkId] = link;
  endWrite(state, token);
  return link;
}

export interface ReconcileApi {
  listEvents(fromISO: string, toISO: string, calendarIds?: string[]): Promise<Parsed<EventInfo[]>>;
  listReminders(listIds?: string[], includeCompleted?: boolean): Promise<Parsed<ReminderInfo[]>>;
}

export interface ReconcileOutcome {
  token: string;
  kind: PendingWrite["kind"];
  result: "found-and-recorded" | "not-found-dropped" | "still-pending" | "expired-dropped";
  detail?: string;
}

/**
 * For every journaled write whose outcome was unknown, looks for the item it would have created.
 * Events are matched by the marker line in their notes; reminders by exact title in the target list created
 * after the write started. Entries older than RECONCILE_WINDOW_MINUTES without a match are dropped.
 */
export async function reconcilePending(
  state: LocalState,
  api: ReconcileApi,
  now = new Date(),
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  for (const [token, p] of Object.entries(state.pendingWrites)) {
    const ageMin = (now.getTime() - new Date(p.startedAt).getTime()) / 60_000;
    if (p.kind === "create-event" && p.probe.start && p.probe.end && !(p.probe.linkId && p.link)) {
      // Plain event (no work-block marker): match by calendar, exact title and exact times in the surrounding days.
      const day = dayKeyOf(new Date(p.probe.start));
      const { from } = dayWindow(addDays(day, -1));
      const { to } = dayWindow(addDays(day, 1));
      const r = await api.listEvents(
        from.toISOString(),
        to.toISOString(),
        p.probe.calendarId ? [p.probe.calendarId] : undefined,
      );
      if (!r.ok) {
        outcomes.push({ token, kind: p.kind, result: "still-pending", detail: "source unavailable" });
        continue;
      }
      const s = new Date(p.probe.start).getTime();
      const e = new Date(p.probe.end).getTime();
      const found = r.value.find(
        (x) => x.title === p.probe.title && new Date(x.start).getTime() === s && new Date(x.end).getTime() === e,
      );
      if (found) {
        endWrite(state, token);
        outcomes.push({ token, kind: p.kind, result: "found-and-recorded", detail: found.title });
        continue;
      }
    } else if (p.kind === "create-event" && p.probe.linkId && p.probe.start && p.probe.end && p.link) {
      const day = dayKeyOf(new Date(p.probe.start));
      const { from } = dayWindow(addDays(day, -1));
      const { to } = dayWindow(addDays(day, 1));
      const r = await api.listEvents(
        from.toISOString(),
        to.toISOString(),
        p.probe.calendarId ? [p.probe.calendarId] : undefined,
      );
      if (!r.ok) {
        outcomes.push({ token, kind: p.kind, result: "still-pending", detail: "source unavailable" });
        continue;
      }
      const found = r.value.find((e) => linkIdFromNotes(e.notes) === p.probe.linkId);
      if (found) {
        recordCreatedBlock(state, token, p.probe.linkId, p, found, now);
        outcomes.push({ token, kind: p.kind, result: "found-and-recorded", detail: found.title });
        continue;
      }
    } else if (p.kind === "create-reminder" && p.probe.listId) {
      const r = await api.listReminders([p.probe.listId], false);
      if (!r.ok) {
        outcomes.push({ token, kind: p.kind, result: "still-pending", detail: "source unavailable" });
        continue;
      }
      const started = new Date(p.startedAt).getTime() - 5_000;
      const found = r.value.find(
        (x) => x.title === p.probe.title && x.created && new Date(x.created).getTime() >= started,
      );
      if (found) {
        endWrite(state, token);
        outcomes.push({ token, kind: p.kind, result: "found-and-recorded", detail: found.title });
        continue;
      }
    }
    if (ageMin > RECONCILE_WINDOW_MINUTES) {
      endWrite(state, token);
      outcomes.push({ token, kind: p.kind, result: "expired-dropped" });
    } else {
      endWrite(state, token);
      outcomes.push({ token, kind: p.kind, result: "not-found-dropped", detail: "the write did not happen" });
    }
  }
  return outcomes;
}
