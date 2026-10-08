// Schedule Work Block (SPEC §4.2, A-B-5, A-B-7, A-B-8, A-B-9, A-B-10): one calendar event linked to a reminder
// or checklist task. A reminder is never modified here. A checklist item is also placed on the block's day
// (a local day assignment, owner feedback 2026-10-04); its text and checkbox are never touched.
import { Action, ActionPanel, Color, Form, Icon, List, showToast, Toast, useNavigation } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import * as ek from "../eventkit.ts";
import { dayKeyOf, formatDay, formatTime, minutesBetween, nextQuarterHour, startOfLocalDay } from "../lib/dates.ts";
import { ALERT_OPTIONS, alertMinutes, describeAlerts, parseTimeValue, timeOptions } from "../lib/summary.ts";
import type { EventInfo } from "../lib/eventkit-protocol.ts";
import { blockRange, validateBlock, validateEvent, type FieldErrors } from "../lib/forms.ts";
import { newLinkId } from "../lib/ids.ts";
import { recordCreatedBlock } from "../lib/journal.ts";
import { notesWithMarker, notesWithoutMarker, snapshotOf } from "../lib/links.ts";
import { assignDay, linksForSource, type LinkSource, type PendingWrite } from "../lib/state.ts";
import {
  confirmOverlaps,
  defaultSource,
  failureToast,
  journaledCreate,
  useDurationField,
  writable,
  type AgendaCtx,
} from "./agenda-shared.tsx";

function sourceKey(source: LinkSource) {
  return source.kind === "task"
    ? { kind: "task" as const, taskId: source.taskId }
    : { kind: "reminder" as const, itemId: source.itemId };
}

function blockLabel(start: string, end: string): string {
  return `${formatDay(dayKeyOf(new Date(start)))} ${formatTime(new Date(start))}–${formatTime(new Date(end))}`;
}

/**
 * Entry point for "Schedule Work Block…". When the source already has blocks, offers View/Edit existing or
 * Add another (A-B-7); the choice replaces this view in place so a save returns to the caller.
 */
export function ScheduleWorkBlock(props: { ctx: AgendaCtx; source: LinkSource; defaultNotes?: string }) {
  const existing = linksForSource(props.ctx.session.state, sourceKey(props.source));
  const [choice, setChoice] = useState<string | "new" | null>(existing.length ? null : "new");
  if (choice === "new") return <BlockForm ctx={props.ctx} source={props.source} defaultNotes={props.defaultNotes} />;
  if (choice) return <BlockForm ctx={props.ctx} source={props.source} linkId={choice} />;
  return (
    <List navigationTitle={`Schedule: ${props.source.title}`}>
      <List.Section title="Already scheduled">
        {existing.map(([id, link]) => (
          <List.Item
            key={id}
            icon={link.missingSince ? { source: Icon.Warning, tintColor: Color.Orange } : Icon.Calendar}
            title={`View/Edit existing block (${blockLabel(link.snapshot.start, link.snapshot.end)})`}
            subtitle={link.missingSince ? "deleted outside My Day" : link.snapshot.title}
            actions={
              <ActionPanel>
                <Action title="View/Edit Existing Block" icon={Icon.Pencil} onAction={() => setChoice(id)} />
                <Action title="Add Another Block" icon={Icon.Plus} onAction={() => setChoice("new")} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      <List.Section title="New">
        <List.Item
          icon={Icon.Plus}
          title="Add another block"
          actions={
            <ActionPanel>
              <Action title="Add Another Block" icon={Icon.Plus} onAction={() => setChoice("new")} />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}

interface Values {
  title: string;
  calendarId: string;
  day: Date | null;
  start: string;
  alert: string;
  notes: string;
}

type EditLoad = { status: "loading" } | { status: "ready"; event: EventInfo } | { status: "gone" };

export function BlockForm(props: {
  ctx: AgendaCtx;
  source: LinkSource;
  defaultNotes?: string;
  linkId?: string;
  /** Preset start (e.g. a free gap); its day becomes the block's day. */
  initialStart?: Date;
  initialMinutes?: number;
}) {
  const { ctx, linkId } = props;
  const { pop } = useNavigation();
  const editing = linkId !== undefined;
  const [load, setLoad] = useState<EditLoad>(editing ? { status: "loading" } : { status: "gone" });
  const [reloadKey, setReloadKey] = useState(0);

  // Edit mode: always prefill from a fresh read, never from the stored snapshot (A-D-3).
  useEffect(() => {
    if (!linkId) return;
    let cancelled = false;
    const link = ctx.session.state.links[linkId];
    if (!link) {
      void showToast({ style: Toast.Style.Failure, title: "This link no longer exists" });
      pop();
      return;
    }
    setLoad({ status: "loading" });
    void ek.getEvent({ eventId: link.eventId, externalId: link.externalId }).then(async (r) => {
      if (cancelled) return;
      if (!r.ok) {
        if (r.failure.kind === "helper" && r.failure.code === "not-found") {
          delete ctx.session.state.links[linkId];
          ctx.session.saveState();
          await showToast({
            style: Toast.Style.Failure,
            title: "Block was deleted outside My Day",
            message: "The link is cleared; nothing was recreated.",
          });
        } else await failureToast("Could not read the block", r.failure);
        pop();
        void ctx.refresh();
        return;
      }
      if (r.value.isRecurring) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Recurring event",
          message: "My Day does not edit recurring events. Change it in Calendar.",
        });
        pop();
        return;
      }
      setLoad({ status: "ready", event: r.value });
    });
    return () => {
      cancelled = true;
    };
  }, [linkId, reloadKey]);

  if (editing && load.status !== "ready") return <Form isLoading navigationTitle="Edit Work Block" />;
  const fresh = load.status === "ready" ? load.event : null;
  return (
    <BlockFields
      key={`${reloadKey}-${fresh?.lastModified ?? ""}`}
      {...props}
      fresh={fresh}
      onConflict={() => setReloadKey((k) => k + 1)}
    />
  );
}

function BlockFields(props: {
  ctx: AgendaCtx;
  source: LinkSource;
  defaultNotes?: string;
  linkId?: string;
  initialStart?: Date;
  initialMinutes?: number;
  fresh: EventInfo | null;
  onConflict: () => void;
}) {
  const { ctx, source, fresh, linkId } = props;
  const { pop } = useNavigation();
  const calendars = writable(ctx.data?.calendars ?? []);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const duration = useDurationField(fresh ? minutesBetween(fresh.start, fresh.end) : (props.initialMinutes ?? 60));
  const clear = (k: keyof FieldErrors) => () => errors[k] && setErrors({ ...errors, [k]: undefined });

  const q = nextQuarterHour();
  const initialStart = fresh ? new Date(fresh.start) : (props.initialStart ?? q);
  const initialDay = fresh
    ? dayKeyOf(new Date(fresh.start))
    : props.initialStart
      ? dayKeyOf(props.initialStart)
      : ctx.day;
  const startExtra = { hour: initialStart.getHours(), minute: initialStart.getMinutes() };
  const startValue = `${String(startExtra.hour).padStart(2, "0")}:${String(startExtra.minute).padStart(2, "0")}`;
  const initialCalendar = fresh?.calendarId ?? defaultSource(calendars, ctx.session.state.sources.defaultCalendarId);

  async function submit(v: Values) {
    if (inFlight.current) return;
    const errs: FieldErrors = {};
    const clock = parseTimeValue(v.start);
    if (!clock) errs.start = "Choose a start time";
    const minutes = duration.minutes();
    if (minutes === null) duration.setError("Enter minutes, e.g. 50 or 1h30");
    if (!v.day) errs.day = "Choose a day";
    if (Object.keys(errs).length || minutes === null || !clock || !v.day) {
      setErrors(errs);
      return;
    }
    const block = { day: dayKeyOf(v.day), startHour: clock.hour, startMinute: clock.minute, durationMinutes: minutes };
    const blockErrs = validateBlock(block);
    const { start, end } = blockRange(block);
    const evErrs = validateEvent(
      { title: v.title, calendarId: v.calendarId, isAllDay: false, day: block.day, start, end },
      fresh ? [...calendars, ...(ctx.data?.calendars ?? []).filter((c) => c.id === fresh.calendarId)] : calendars,
    );
    const all = { ...evErrs, ...blockErrs };
    if (Object.keys(all).length) {
      if (all.duration) duration.setError(all.duration);
      setErrors(all);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      if (!(await confirmOverlaps(ctx, start, end, fresh?.eventId ?? undefined))) return;
      const title = v.title.trim();
      if (fresh && linkId) await saveEdit(fresh, linkId, title, start, end, v);
      else await saveNew(title, start, end, v);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** Puts a checklist item on the block's day; returns the toast suffix. Reminders are left alone. */
  function placeOnDay(day: string): string {
    if (source.kind !== "task") return "";
    const previous = ctx.session.state.assignments[source.taskId]?.day;
    if (previous === day) return "";
    assignDay(ctx.session.state, source.taskId, source.checklistId, day);
    return previous ? ` · moved to ${formatDay(day)}` : ` · added to ${formatDay(day)}`;
  }

  async function saveNew(title: string, start: Date, end: Date, v: Values) {
    const newId = newLinkId();
    const pending: PendingWrite = {
      kind: "create-event",
      startedAt: new Date().toISOString(),
      probe: { title, calendarId: v.calendarId, start: start.toISOString(), end: end.toISOString(), linkId: newId },
      link: { source, calendarId: v.calendarId },
    };
    const toast = await showToast({ style: Toast.Style.Animated, title: "Scheduling…" });
    const { result } = await journaledCreate(
      ctx,
      pending,
      () =>
        ek.createEvent({
          calendarId: v.calendarId,
          title,
          start: start.toISOString(),
          end: end.toISOString(),
          isAllDay: false,
          notes: notesWithMarker(v.notes, newId),
          alarmMinutes: alertMinutes(v.alert),
        }),
      (event, token) => recordCreatedBlock(ctx.session.state, token, newId, pending, event),
    );
    if (!result) return void toast.hide();
    if (!result.ok) {
      toast.hide();
      await failureToast("Work block not scheduled", result.failure);
      return;
    }
    ctx.session.state.sources.defaultCalendarId = v.calendarId;
    ctx.session.state.sources.defaultAlert = v.alert;
    const placed = placeOnDay(dayKeyOf(start));
    ctx.session.saveState();
    toast.style = Toast.Style.Success;
    toast.title = `Scheduled ${blockLabel(result.value.start, result.value.end)}${placed}`;
    toast.message = source.title;
    pop();
    void ctx.refresh();
  }

  async function saveEdit(event: EventInfo, id: string, title: string, start: Date, end: Date, v: Values) {
    const link = ctx.session.state.links[id];
    const toast = await showToast({ style: Toast.Style.Animated, title: "Updating block…" });
    const r = await ek.updateEvent({
      eventId: event.eventId ?? link?.eventId ?? event.itemId,
      externalId: event.externalId,
      expectedLastModified: event.lastModified,
      expectedSnapshot: { title: event.title, start: event.start, end: event.end },
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      notes: notesWithMarker(v.notes, id),
      ...(v.calendarId !== event.calendarId ? { calendarId: v.calendarId } : {}),
      ...(alertMinutes(v.alert) !== undefined ? { alarmMinutes: alertMinutes(v.alert) } : {}),
    });
    if (!r.ok) {
      toast.hide();
      if (r.failure.kind === "helper" && r.failure.code === "conflict") {
        await showToast({
          style: Toast.Style.Failure,
          title: "Changed in Calendar — reload",
          message: "The block was edited outside My Day. Reloaded its current version; nothing was changed.",
        });
        props.onConflict();
        return;
      }
      if (r.failure.kind === "helper" && r.failure.code === "not-found") {
        delete ctx.session.state.links[id];
        ctx.session.saveState();
        await showToast({
          style: Toast.Style.Failure,
          title: "Block was deleted outside My Day",
          message: "The link is cleared; nothing was recreated.",
        });
        pop();
        void ctx.refresh();
        return;
      }
      await failureToast("Block not updated", r.failure);
      return;
    }
    if (link) {
      link.snapshot = snapshotOf(r.value);
      link.calendarId = r.value.calendarId;
      if (r.value.eventId) link.eventId = r.value.eventId;
      link.externalId = r.value.externalId ?? link.externalId;
      delete link.missingSince;
    }
    const placed = placeOnDay(dayKeyOf(start));
    ctx.session.saveState();
    toast.style = Toast.Style.Success;
    toast.title = `Block moved to ${blockLabel(r.value.start, r.value.end)}${placed}`;
    toast.message = title;
    pop();
    void ctx.refresh();
  }

  const editing = Boolean(fresh);
  if (!editing && calendars.length === 0) {
    return (
      <Form navigationTitle="Schedule Work Block">
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
      navigationTitle={editing ? "Edit Work Block" : "Schedule Work Block"}
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={editing ? "Save Work Block" : "Schedule Work Block"}
            icon={Icon.Calendar}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="For"
        text={`${source.kind === "task" ? "Checklist item" : "Reminder"}: ${source.title}. ${
          source.kind === "task"
            ? "The item is also placed on the block's day; its text and checkbox are not changed."
            : "The reminder itself (due date, completion) is not changed."
        }`}
      />
      <Form.TextField
        id="title"
        title="Title"
        defaultValue={fresh?.title ?? source.title}
        error={errors.title}
        onChange={clear("title")}
      />
      <Form.Dropdown
        id="calendarId"
        title="Calendar"
        defaultValue={initialCalendar}
        error={errors.calendarId}
        onChange={clear("calendarId")}
      >
        {fresh && !calendars.some((c) => c.id === fresh.calendarId) ? (
          <Form.Dropdown.Item value={fresh.calendarId} title="(current calendar)" />
        ) : null}
        {calendars.map((c) => (
          <Form.Dropdown.Item key={c.id} value={c.id} title={`${c.title} (${c.source})`} />
        ))}
      </Form.Dropdown>
      <Form.DatePicker
        id="day"
        title="Day"
        type={Form.DatePicker.Type.Date}
        defaultValue={startOfLocalDay(initialDay)}
        error={errors.day}
        onChange={clear("day")}
      />
      <Form.Dropdown
        id="start"
        title="Start"
        info="Type to jump, e.g. 2:30pm or 14:30."
        defaultValue={startValue}
        error={errors.start}
        onChange={clear("start")}
      >
        {timeOptions(15, startExtra).map((o) => (
          <Form.Dropdown.Item key={o.value} value={o.value} title={o.title} keywords={o.keywords} />
        ))}
      </Form.Dropdown>
      {duration.fields}
      <Form.Dropdown
        id="alert"
        title="Alert"
        defaultValue={
          fresh
            ? fresh.alarmMinutes.length
              ? "default"
              : "none"
            : (ctx.session.state.sources.defaultAlert ?? "default")
        }
        info={
          fresh ? `Current: ${describeAlerts(fresh.alarmMinutes)}. "Calendar default" keeps it unchanged.` : undefined
        }
      >
        {ALERT_OPTIONS.map((o) => (
          <Form.Dropdown.Item
            key={o.value}
            value={o.value}
            title={fresh && o.value === "default" ? "Keep current" : o.title}
          />
        ))}
      </Form.Dropdown>
      <Form.TextArea
        id="notes"
        title="Notes"
        enableMarkdown
        defaultValue={fresh ? notesWithoutMarker(fresh.notes) : (props.defaultNotes ?? "")}
      />
    </Form>
  );
}
