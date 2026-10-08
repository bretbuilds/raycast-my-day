// Add Event (SPEC §4.2, A-B-1, A-B-8, A-B-10). Creates one new event; never touches existing ones.
import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from "@raycast/api";
import { useRef, useState } from "react";
import * as ek from "../eventkit.ts";
import { dayKeyOf, localDateTime, nextQuarterHour, startOfLocalDay, todayKey } from "../lib/dates.ts";
import { ALERT_OPTIONS, alertMinutes, parseTimeValue, timeOptions } from "../lib/summary.ts";
import { endWrite } from "../lib/journal.ts";
import { validateEvent, type FieldErrors } from "../lib/forms.ts";
import type { PendingWrite } from "../lib/state.ts";
import {
  confirmOverlaps,
  defaultSource,
  failureToast,
  journaledCreate,
  useDurationField,
  writable,
  type AgendaCtx,
} from "./agenda-shared.tsx";

interface Values {
  title: string;
  calendarId: string;
  allDay: boolean;
  day: Date | null;
  endDate: Date | null;
  startTime: string;
  alert: string;
  location: string;
  url: string;
  notes: string;
}

/** Next quarter hour on the selected day (today: from now; other days: the same clock time). */
export function defaultStartOn(day: string): Date {
  const q = nextQuarterHour();
  if (day === todayKey()) return q;
  return localDateTime(day, q.getHours(), q.getMinutes());
}

export function EventForm({
  ctx,
  defaultTitle,
  onDone,
}: {
  ctx: AgendaCtx;
  defaultTitle?: string;
  onDone?: () => void;
}) {
  const { pop } = useNavigation();
  const calendars = writable(ctx.data?.calendars ?? []);
  const [allDay, setAllDay] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const duration = useDurationField(60);
  const clear = (k: keyof FieldErrors) => () => errors[k] && setErrors({ ...errors, [k]: undefined });
  const ds = defaultStartOn(ctx.day);
  const startDefault = `${String(ds.getHours()).padStart(2, "0")}:${String(ds.getMinutes()).padStart(2, "0")}`;

  async function submit(v: Values) {
    if (inFlight.current) return; // re-entrant submit (double ⌘↵) is ignored
    const minutes = allDay ? 0 : duration.minutes();
    if (!allDay && (minutes === null || minutes < 5 || minutes > 7 * 24 * 60)) {
      duration.setError("Enter a length, e.g. 50, 1h30, 2d or 1d 4h (up to 7 days)");
      return;
    }
    const clock = parseTimeValue(v.startTime ?? "");
    const start = allDay || !v.day || !clock ? null : localDateTime(dayKeyOf(v.day), clock.hour, clock.minute);
    const end = start && minutes ? new Date(start.getTime() + minutes * 60_000) : null;
    const day = allDay && v.day ? dayKeyOf(v.day) : null;
    // Multi-day all-day events: an optional End date (inclusive); empty means the same day.
    const endDay = allDay && day ? (v.endDate ? dayKeyOf(v.endDate) : day) : null;
    const draft = {
      title: v.title,
      calendarId: v.calendarId,
      isAllDay: allDay,
      day,
      endDay,
      start,
      end,
      location: v.location,
      url: v.url.trim() || undefined,
      notes: v.notes,
    };
    const errs = validateEvent(draft, calendars);
    if (Object.keys(errs).length) {
      setErrors(errs);
      if (errs.end) duration.setError(errs.end);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      if (start && end && !(await confirmOverlaps(ctx, start, end))) return;
      const title = v.title.trim();
      const pending: PendingWrite = {
        kind: "create-event",
        startedAt: new Date().toISOString(),
        probe: {
          title,
          calendarId: v.calendarId,
          ...(start && end ? { start: start.toISOString(), end: end.toISOString() } : {}),
        },
      };
      const toast = await showToast({ style: Toast.Style.Animated, title: "Adding event…" });
      const { result } = await journaledCreate(
        ctx,
        pending,
        () =>
          ek.createEvent({
            calendarId: v.calendarId,
            title,
            isAllDay: allDay,
            ...(allDay && day && endDay ? { day, endDay } : {}),
            ...(start && end ? { start: start.toISOString(), end: end.toISOString() } : {}),
            location: v.location.trim() || undefined,
            url: draft.url,
            notes: v.notes.trim() ? v.notes : undefined,
            alarmMinutes: alertMinutes(v.alert),
          }),
        (_event, token) => endWrite(ctx.session.state, token),
      );
      if (!result) {
        toast.hide();
        return;
      }
      if (!result.ok) {
        toast.hide();
        await failureToast("Event not added", result.failure);
        return;
      }
      ctx.session.state.sources.defaultCalendarId = v.calendarId;
      ctx.session.state.sources.defaultAlert = v.alert;
      ctx.session.saveState();
      toast.style = Toast.Style.Success;
      toast.title = "Event added";
      toast.message = title;
      pop();
      onDone?.();
      void ctx.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!ctx.data?.calendarsKnown || calendars.length === 0) {
    return (
      <Form navigationTitle="Add Event">
        <Form.Description
          title="No writable calendar"
          text={
            ctx.data?.calendarsKnown
              ? "Every calendar My Day can see is read-only."
              : "Calendar is not available right now. Open My Day Setup to check access, then refresh."
          }
        />
      </Form>
    );
  }

  return (
    <Form
      navigationTitle="Add Event"
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Event" icon={Icon.Calendar} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Title"
        autoFocus
        defaultValue={defaultTitle}
        error={errors.title}
        onChange={clear("title")}
      />
      <Form.Dropdown
        id="calendarId"
        title="Calendar"
        defaultValue={defaultSource(calendars, ctx.session.state.sources.defaultCalendarId)}
        error={errors.calendarId}
        onChange={clear("calendarId")}
      >
        {calendars.map((c) => (
          <Form.Dropdown.Item key={c.id} value={c.id} title={`${c.title} (${c.source})`} />
        ))}
      </Form.Dropdown>
      <Form.Checkbox id="allDay" label="All-day" value={allDay} onChange={setAllDay} />
      <Form.DatePicker
        id="day"
        title="Date"
        type={Form.DatePicker.Type.Date}
        defaultValue={startOfLocalDay(ctx.day)}
        error={errors.day}
        onChange={clear("day")}
      />
      {allDay ? (
        <Form.DatePicker
          id="endDate"
          title="End Date"
          type={Form.DatePicker.Type.Date}
          info="For an event over several days, e.g. a trip. Leave empty for one day."
          error={errors.endDay}
          onChange={clear("endDay")}
        />
      ) : null}
      {allDay ? null : (
        <>
          <Form.Dropdown
            id="startTime"
            title="Start"
            info="Type to jump, e.g. 2:30pm or 14:30."
            defaultValue={startDefault}
            error={errors.start}
            onChange={clear("start")}
          >
            {timeOptions(15).map((o) => (
              <Form.Dropdown.Item key={o.value} value={o.value} title={o.title} keywords={o.keywords} />
            ))}
          </Form.Dropdown>
          {duration.fields}
        </>
      )}
      <Form.Dropdown id="alert" title="Alert" defaultValue={ctx.session.state.sources.defaultAlert ?? "default"}>
        {ALERT_OPTIONS.map((o) => (
          <Form.Dropdown.Item key={o.value} value={o.value} title={o.title} />
        ))}
      </Form.Dropdown>
      <Form.Separator />
      <Form.TextField id="location" title="Location" />
      <Form.TextField id="url" title="URL" placeholder="https://…" error={errors.url} onChange={clear("url")} />
      <Form.TextArea id="notes" title="Notes" enableMarkdown />
    </Form>
  );
}
