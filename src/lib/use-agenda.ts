// Data flow for the My Day command (SPEC §4.1, §7.3, §7.4). Every refresh re-reads local state, reconciles
// journaled writes, then reads each source independently so one failure never erases the others. The last
// good result per source is kept and labelled stale when a later read fails.
import { showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import * as ek from "../eventkit.ts";
import {
  buildAgenda,
  UPCOMING_DAYS,
  upcomingEvents,
  type Agenda,
  type SourceFailure,
  type UpcomingEvent,
} from "./agenda.ts";
import { accessFailure, verifyLinks } from "./agenda-rows.ts";
import { addDays, dayWindow, formatTime, setClock24, todayKey, type DayKey } from "./dates.ts";
import { applyClockPreference } from "./clock.ts";
import type { CalendarInfo, EventInfo, ReminderInfo } from "./eventkit-protocol.ts";
import { reconcilePending, type ReconcileOutcome } from "./journal.ts";
import { prunePicks, type Link, type PendingWrite } from "./state.ts";
import { listChecklists, type ChecklistFile } from "./store.ts";
import { createSession, errorText, type ChecklistSession } from "./use-checklists.ts";

/** How often the open view re-reads Calendar, Reminders and the checklists. */
export const BACKGROUND_REFRESH_MS = 30_000;

export interface AgendaData {
  agenda: Agenda;
  /** The following day (for the "Tomorrow" section and pushing work to it). */
  next: Agenda;
  /** Events from the day after next through UPCOMING_DAYS ahead (Coming up). */
  upcoming: UpcomingEvent[];
  /** All event calendars / reminder lists the helper reported (not filtered by the source selection). */
  calendars: CalendarInfo[];
  lists: CalendarInfo[];
  /** Every checklist in the folder (archived included; forms filter). */
  checklists: ChecklistFile[];
  /** True when the calendar/list inventory is from this refresh (forms may offer them). */
  calendarsKnown: boolean;
  listsKnown: boolean;
  /** linkId → changed fields for blocks edited in Calendar since My Day last wrote them. */
  editedLinks: Record<string, string[]>;
  /** Links whose block was expected on this day and is gone. */
  missingLinks: [string, Link][];
  /** "HH:MM" of the oldest stale source shown, or null when everything shown is from this refresh. */
  staleSince: string | null;
}

export interface AgendaController {
  session: ChecklistSession;
  day: DayKey;
  setDay: (day: DayKey) => void;
  data: AgendaData | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

interface LastGood {
  events?: { day: DayKey; value: EventInfo[]; at: Date };
  reminders?: { value: ReminderInfo[]; at: Date };
  calendars?: CalendarInfo[];
  lists?: CalendarInfo[];
  checklists?: ChecklistFile[];
}

function outcomeToast(o: ReconcileOutcome, pending: PendingWrite | undefined): Promise<Toast> {
  const what = pending ? `“${pending.probe.title}”` : "an earlier write";
  const kind = o.kind === "create-event" ? "event" : "reminder";
  switch (o.result) {
    case "found-and-recorded":
      return showToast({
        style: Toast.Style.Success,
        title: `Recovered ${kind} ${what}`,
        message: "It was created before My Day was interrupted; nothing was written again.",
      });
    case "still-pending":
      return showToast({
        style: Toast.Style.Failure,
        title: `Could not check ${kind} ${what} yet`,
        message: "The source is unavailable; My Day will check again on the next refresh.",
      });
    default:
      // Plain events carry no marker; the journal searched by calendar, title and exact times.
      if (o.kind === "create-event" && !pending?.probe.linkId)
        return showToast({
          style: Toast.Style.Failure,
          title: `Event ${what} was not found in Calendar`,
          message: "The interrupted write most likely did not happen. Check Calendar before adding it again.",
        });
      return showToast({
        style: Toast.Style.Failure,
        title: `${kind === "event" ? "Event" : "Reminder"} ${what} was not created`,
        message:
          o.result === "expired-dropped" ? "The interrupted write expired." : "The interrupted write did not happen.",
      });
  }
}

export function useAgenda(): AgendaController {
  const sessionRef = useRef<ChecklistSession | null>(null);
  if (!sessionRef.current) sessionRef.current = createSession();
  const session = sessionRef.current;
  const [day, setDay] = useState<DayKey>(() => todayKey());
  const [data, setData] = useState<AgendaData | null>(null);
  const [isLoading, setLoading] = useState(true);
  const lastGood = useRef<LastGood>({});
  const generation = useRef(0);
  const firstLoad = useRef(true);
  const dayRef = useRef(day);
  dayRef.current = day;

  const load = useCallback(
    async (forDay: DayKey, quiet = false) => {
      const gen = ++generation.current;
      if (!quiet) setLoading(true);
      const failures: SourceFailure[] = [];
      const now = new Date();
      let stale: Date | null = null;

      // 1. Local state (createSession already loaded and reported it once on mount).
      if (!firstLoad.current) {
        try {
          const loaded = session.store.load();
          session.state = loaded.state;
          if (loaded.dropped.length)
            void showToast({
              style: Toast.Style.Failure,
              title: loaded.corrupt ? "Local state was unreadable" : "Some local state was invalid",
              message: loaded.dropped.slice(0, 5).join("; "),
            });
        } catch (e) {
          void showToast({ style: Toast.Style.Failure, title: "Could not read local state", message: errorText(e) });
        }
      }
      firstLoad.current = false;
      const state = session.state;

      // 2. Journaled writes with an unknown outcome (A-B-10, A-B-11).
      const pendingBefore = { ...state.pendingWrites };
      if (Object.keys(pendingBefore).length) {
        const outcomes = await reconcilePending(state, ek);
        for (const o of outcomes) void outcomeToast(o, pendingBefore[o.token]);
        session.saveState();
      }

      // 3. Sources.
      const status = await ek.helperStatus();
      applyClockPreference(status.ok ? status.value.uses24HourClock : null, setClock24);
      let events: EventInfo[] | null = null;
      let reminders: ReminderInfo[] | null = null;
      let calendars: CalendarInfo[] = lastGood.current.calendars ?? [];
      let lists: CalendarInfo[] = lastGood.current.lists ?? [];
      let calendarsKnown = false;
      let listsKnown = false;
      let freshEvents: EventInfo[] | null = null;

      if (!status.ok) {
        failures.push({ source: "events", failure: status.failure }, { source: "reminders", failure: status.failure });
      } else {
        const evOk = status.value.events === "full-access";
        const remOk = status.value.reminders === "full-access";
        let inventoryFailure: SourceFailure["failure"] | null = null;
        if (evOk || remOk) {
          const cals = await ek.listCalendars();
          if (cals.ok) {
            if (cals.value.eventCalendars) {
              calendars = cals.value.eventCalendars;
              calendarsKnown = true;
              lastGood.current.calendars = calendars;
            }
            if (cals.value.reminderLists) {
              lists = cals.value.reminderLists;
              listsKnown = true;
              lastGood.current.lists = lists;
            }
          } else inventoryFailure = cals.failure;
        }
        if (!evOk) failures.push({ source: "events", failure: accessFailure(status.value.events, "events") });
        else if (inventoryFailure) failures.push({ source: "events", failure: inventoryFailure });
        else {
          const { from } = dayWindow(forDay);
          const { to } = dayWindow(addDays(forDay, UPCOMING_DAYS));
          const r = await ek.listEvents(from.toISOString(), to.toISOString());
          if (r.ok) {
            events = r.value;
            freshEvents = r.value;
            lastGood.current.events = { day: forDay, value: r.value, at: now };
          } else failures.push({ source: "events", failure: r.failure });
        }
        if (!remOk) failures.push({ source: "reminders", failure: accessFailure(status.value.reminders, "reminders") });
        else if (inventoryFailure) failures.push({ source: "reminders", failure: inventoryFailure });
        else {
          const r = await ek.listReminders(undefined, false);
          if (r.ok) {
            reminders = r.value;
            lastGood.current.reminders = { value: r.value, at: now };
            // Picks and main tasks for reminders completed or deleted elsewhere (only on a fresh, full read).
            if (prunePicks(state, new Set(r.value.filter((x) => !x.isCompleted).map((x) => x.itemId))))
              session.saveState();
          } else failures.push({ source: "reminders", failure: r.failure });
        }
      }
      // Stale fallbacks: the last good read is shown, labelled with its time, beside the failure row.
      if (events === null && lastGood.current.events?.day === forDay) {
        events = lastGood.current.events.value;
        stale = lastGood.current.events.at;
      }
      if (reminders === null && lastGood.current.reminders) {
        reminders = lastGood.current.reminders.value;
        if (!stale || lastGood.current.reminders.at < stale) stale = lastGood.current.reminders.at;
      }

      let checklists: ChecklistFile[] = [];
      try {
        const r = listChecklists(session.dir);
        checklists = r.checklists;
        lastGood.current.checklists = checklists;
        for (const p of r.problems)
          failures.push({ source: "checklists", failure: { kind: "store", detail: `${p.fileName}: ${p.reason}` } });
      } catch (e) {
        failures.push({ source: "checklists", failure: { kind: "store", detail: errorText(e) } });
        checklists = lastGood.current.checklists ?? [];
      }

      // 4. Work-block verification against this refresh's read only (never against stale data).
      const verification = verifyLinks(state, freshEvents, forDay, now);
      if (verification.changed) session.saveState();

      const inputs = { events, reminders, calendars, lists, checklists, state, failures };
      const agenda = buildAgenda({ ...inputs, day: forDay });
      const next = buildAgenda({ ...inputs, day: addDays(forDay, 1), failures: [] });
      const upcoming = upcomingEvents(inputs, addDays(forDay, 2), addDays(forDay, UPCOMING_DAYS));
      if (gen !== generation.current) return; // a newer refresh (e.g. another day) superseded this one
      setData({
        agenda,
        next,
        upcoming,
        calendars,
        lists,
        checklists,
        calendarsKnown,
        listsKnown,
        editedLinks: verification.edited,
        missingLinks: verification.missing,
        staleSince: stale ? formatTime(stale) : null,
      });
      setLoading(false);
    },
    [session],
  );

  useEffect(() => {
    void load(day);
  }, [day, load]);

  // Raycast keeps a closed command alive for a while (Settings → Advanced → Pop to Root Search), so reopening it
  // can show the old view. Re-read quietly every 30 s while the view exists; nothing runs once it is unloaded.
  useEffect(() => {
    const t = setInterval(() => void load(dayRef.current, true), BACKGROUND_REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const refresh = useCallback(() => load(dayRef.current), [load]);
  return { session, day, setDay, data, isLoading, refresh };
}
