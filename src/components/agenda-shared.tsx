// Shared plumbing for the My Day forms: the context they receive, writable-source filtering, the journaled
// create path (SPEC §7.3), the overlap confirmation (A-B-8) and the duration field.
import { Alert, Form, confirmAlert, showToast, Toast } from "@raycast/api";
import { useState } from "react";
import * as ek from "../eventkit.ts";
import { overlappingEvents, type EventRow } from "../lib/agenda.ts";
import { dayKeyOf, dayWindow, formatDuration, formatTime, type DayKey } from "../lib/dates.ts";
import { failureText, type CalendarInfo, type Failure, type Parsed } from "../lib/eventkit-protocol.ts";
import { DURATION_OPTIONS, parseDuration } from "../lib/forms.ts";
import { beginWrite, endWrite } from "../lib/journal.ts";
import { newToken } from "../lib/ids.ts";
import type { PendingWrite } from "../lib/state.ts";
import type { AgendaController } from "../lib/use-agenda.ts";

export type AgendaCtx = AgendaController;

export function writable(cals: CalendarInfo[]): CalendarInfo[] {
  return cals.filter((c) => c.allowsModifications && !c.isImmutable);
}

/** The remembered default when it is still writable, else the first writable one. */
export function defaultSource(cals: CalendarInfo[], remembered: string | undefined): string | undefined {
  return cals.find((c) => c.id === remembered)?.id ?? cals[0]?.id;
}

export function failureToast(title: string, failure: Failure | { kind: "store"; detail: string }) {
  if (failure.kind === "store") return showToast({ style: Toast.Style.Failure, title, message: failure.detail });
  const t = failureText(failure);
  return showToast({ style: Toast.Style.Failure, title: `${title}: ${t.title}`, message: t.description });
}

/** Outcomes where the helper may have written before failing: the journal entry is kept for reconciliation. */
export function isAmbiguous(f: Failure): boolean {
  return f.kind === "timeout" || f.kind === "helper-error" || f.kind === "bad-output";
}

export interface JournaledResult<T> {
  result: Parsed<T> | null;
  token: string;
}

/**
 * Journals `pending`, saves state, runs `call`, then resolves the entry via `onOk` (which must clear it) or
 * clears it on a definite failure. An ambiguous failure leaves the entry for the next refresh to reconcile.
 * Returns result null when the journal itself could not be saved (nothing was written).
 */
export async function journaledCreate<T>(
  ctx: AgendaCtx,
  pending: PendingWrite,
  call: () => Promise<Parsed<T>>,
  onOk: (value: T, token: string) => void,
): Promise<JournaledResult<T>> {
  const token = newToken();
  const state = ctx.session.state;
  beginWrite(state, token, pending);
  if (!ctx.session.saveState()) {
    endWrite(state, token);
    return { result: null, token };
  }
  const result = await call();
  if (result.ok) onOk(result.value, token);
  else if (!isAmbiguous(result.failure)) endWrite(state, token);
  ctx.session.saveState();
  if (!result.ok && isAmbiguous(result.failure)) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Outcome unknown",
      message: `${failureText(result.failure).title}. My Day will check on the next refresh before anything is written again.`,
    });
  }
  return { result, token };
}

function asRows(events: Awaited<ReturnType<typeof ek.listEvents>>): EventRow[] | null {
  if (!events.ok) return null;
  return events.value
    .filter((e) => !e.isAllDay)
    .map((e) => ({ kind: "event", id: e.itemId, event: e, calendar: null, link: null }));
}

/**
 * Overlap check for a proposed timed range. Uses the agenda's schedule when the range is on the shown day and
 * the calendar read succeeded; otherwise reads that day once. An unavailable read is never taken as "free".
 * Resolves true when the user wants to proceed.
 */
export async function confirmOverlaps(
  ctx: AgendaCtx,
  start: Date,
  end: Date,
  excludeEventId?: string,
): Promise<boolean> {
  const day: DayKey = dayKeyOf(start);
  const agenda = ctx.data?.agenda;
  const eventsFailed = agenda?.failures.some((f) => f.source === "events") ?? true;
  let rows: EventRow[] | null;
  if (agenda && agenda.day === day && !eventsFailed && !ctx.data?.staleSince) rows = agenda.schedule;
  else {
    const { from, to } = dayWindow(day);
    rows = asRows(await ek.listEvents(from.toISOString(), to.toISOString()));
  }
  if (!rows) {
    return confirmAlert({
      title: "Could not check for overlaps",
      message: "Calendar could not be read for that day, so it may not be free. Create anyway?",
      primaryAction: { title: "Create Anyway" },
    });
  }
  const hits = overlappingEvents(rows, start.toISOString(), end.toISOString(), excludeEventId);
  if (!hits.length) return true;
  const titles = hits
    .slice(0, 5)
    .map((r) => `${formatTime(new Date(r.event.start))} ${r.event.title}`)
    .join(", ");
  return confirmAlert({
    title: `Overlaps with ${hits.length} event${hits.length === 1 ? "" : "s"}`,
    message: `Overlaps with ${hits.length} event(s): ${titles}${hits.length > 5 ? ", …" : ""}. Create anyway?`,
    primaryAction: { title: "Create Anyway", style: Alert.ActionStyle.Default },
  });
}

export const CUSTOM = "custom";

/** Duration dropdown (preset minutes or Custom…) with a free-text field for the custom value. */
export function useDurationField(initialMinutes: number) {
  const preset = (DURATION_OPTIONS as readonly number[]).includes(initialMinutes);
  const [choice, setChoice] = useState(preset ? String(initialMinutes) : CUSTOM);
  const [custom, setCustom] = useState(preset ? "" : String(initialMinutes));
  const [error, setError] = useState<string | undefined>();
  const minutes = (): number | null => (choice === CUSTOM ? parseDuration(custom) : Number(choice));
  const fields = (
    <>
      <Form.Dropdown
        id="durationChoice"
        title="Duration"
        value={choice}
        error={choice === CUSTOM ? undefined : error}
        onChange={(v) => {
          setChoice(v);
          setError(undefined);
        }}
      >
        {DURATION_OPTIONS.map((m) => (
          <Form.Dropdown.Item key={m} value={String(m)} title={formatDuration(m)} />
        ))}
        <Form.Dropdown.Item value={CUSTOM} title="Custom…" />
      </Form.Dropdown>
      {choice === CUSTOM ? (
        <Form.TextField
          id="durationCustom"
          title="Custom Duration"
          placeholder="e.g. 50, 1h30, 1:15"
          value={custom}
          error={error}
          onChange={(v) => {
            setCustom(v);
            setError(undefined);
          }}
        />
      ) : null}
    </>
  );
  return { fields, minutes, setError, error };
}
