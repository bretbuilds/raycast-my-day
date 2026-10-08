// Quick scheduling (owner feedback 2026-10-04): put an item into a free gap of the day with one choice instead
// of a form. The block uses the item's estimate (else 30 min, capped by the gap), the remembered calendar and
// alert, and is undoable from the toast. "Pick Time…" still opens the full form.
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  getPreferenceValues,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import * as ek from "../eventkit.ts";
import { dayKeyOf, formatDay, usesClock24 } from "../lib/dates.ts";
import { rangeLabel, withColumn } from "../lib/columns.ts";
import type { EventInfo } from "../lib/eventkit-protocol.ts";
import { newLinkId } from "../lib/ids.ts";
import { recordCreatedBlock } from "../lib/journal.ts";
import { notesWithMarker } from "../lib/links.ts";
import { alertMinutes } from "../lib/summary.ts";
import { assignDay, linksForSource, unassignDay, type LinkSource, type PendingWrite } from "../lib/state.ts";
import { formatCountdown, formatRange, freeGaps, quickDuration, type Gap } from "../lib/timeline.ts";
import {
  confirmOverlaps,
  defaultSource,
  failureToast,
  journaledCreate,
  writable,
  type AgendaCtx,
} from "./agenda-shared.tsx";
import { BlockForm } from "./ScheduleBlockForm.tsx";

export function workingHours(): { start: number; end: number } {
  const p = getPreferenceValues<{ dayStart?: string; dayEnd?: string }>();
  const start = Number(p.dayStart ?? 9);
  const end = Number(p.dayEnd ?? 18);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : { start: 9, end: 18 };
}

/** Free gaps on the shown day, or [] when the calendar read failed (a failed read is never "free"). */
export function gapsFor(ctx: AgendaCtx, now = new Date()): Gap[] {
  const agenda = ctx.data?.agenda;
  if (!agenda || agenda.failures.some((f) => f.source === "events") || ctx.data?.staleSince) return [];
  const { start, end } = workingHours();
  return freeGaps(
    agenda.schedule.map((r) => ({ start: r.event.start, end: r.event.end, availability: r.event.availability })),
    agenda.day,
    now,
    start,
    end,
  );
}

/** Creates one linked block at `start` for `minutes`; returns the event or null (toasts explain failures). */
export async function quickBlock(
  ctx: AgendaCtx,
  source: LinkSource,
  start: Date,
  minutes: number,
  notes?: string,
): Promise<EventInfo | null> {
  const calendars = writable(ctx.data?.calendars ?? []);
  const calendarId = defaultSource(calendars, ctx.session.state.sources.defaultCalendarId);
  if (!calendarId) {
    await showToast({
      style: Toast.Style.Failure,
      title: "No writable calendar",
      message: "Open My Day Setup to check Calendar access.",
    });
    return null;
  }
  const end = new Date(start.getTime() + minutes * 60_000);
  if (!(await confirmOverlaps(ctx, start, end))) return null;
  const linkId = newLinkId();
  const pending: PendingWrite = {
    kind: "create-event",
    startedAt: new Date().toISOString(),
    probe: { title: source.title, calendarId, start: start.toISOString(), end: end.toISOString(), linkId },
    link: { source, calendarId },
  };
  const toast = await showToast({ style: Toast.Style.Animated, title: "Scheduling…", message: source.title });
  const { result } = await journaledCreate(
    ctx,
    pending,
    () =>
      ek.createEvent({
        calendarId,
        title: source.title,
        start: start.toISOString(),
        end: end.toISOString(),
        isAllDay: false,
        notes: notesWithMarker(notes, linkId),
        alarmMinutes: alertMinutes(ctx.session.state.sources.defaultAlert ?? "default"),
      }),
    (event, token) => recordCreatedBlock(ctx.session.state, token, linkId, pending, event),
  );
  if (!result) return (void toast.hide(), null);
  if (!result.ok) {
    toast.hide();
    await failureToast("Work block not scheduled", result.failure);
    return null;
  }
  const day = dayKeyOf(start);
  const previousDay = source.kind === "task" ? (ctx.session.state.assignments[source.taskId]?.day ?? null) : null;
  if (source.kind === "task") assignDay(ctx.session.state, source.taskId, source.checklistId, day);
  ctx.session.saveState();
  const event = result.value;
  toast.style = Toast.Style.Success;
  toast.title = `Scheduled ${formatRange(new Date(event.start), new Date(event.end))}`;
  toast.message = source.title;
  toast.primaryAction = {
    title: "Undo",
    shortcut: { modifiers: ["cmd"], key: "z" },
    onAction: async (t) => {
      t.hide();
      const d = await ek.deleteEvent({
        eventId: event.eventId ?? event.itemId,
        externalId: event.externalId,
        expectedSnapshot: { title: event.title, start: event.start, end: event.end },
      });
      if (!d.ok && !(d.failure.kind === "helper" && d.failure.code === "not-found")) {
        await failureToast("Undo failed", d.failure);
        return;
      }
      delete ctx.session.state.links[linkId];
      if (source.kind === "task") {
        if (previousDay) assignDay(ctx.session.state, source.taskId, source.checklistId, previousDay);
        else unassignDay(ctx.session.state, source.taskId);
      }
      ctx.session.saveState();
      await showToast({ style: Toast.Style.Success, title: "Work block removed", message: source.title });
      void ctx.refresh();
    },
  };
  void ctx.refresh();
  return event;
}

/** ⌘S on an item: free gaps of the shown day as one-step choices, then Pick Time… and existing blocks. */
export function ScheduleSubmenu(props: {
  ctx: AgendaCtx;
  source: LinkSource;
  notes?: string | null;
  estimate?: number | null;
}) {
  const { ctx, source } = props;
  const { push } = useNavigation();
  const gaps = gapsFor(ctx).slice(0, 8);
  const existing = linksForSource(
    ctx.session.state,
    source.kind === "task" ? { kind: "task", taskId: source.taskId } : { kind: "reminder", itemId: source.itemId },
  );
  return (
    <ActionPanel.Submenu
      title="Schedule…"
      icon={Icon.Clock}
      // eslint-disable-next-line @raycast/prefer-common-shortcut -- ⌘S is Schedule throughout My Day
      shortcut={{ modifiers: ["cmd"], key: "s" }}
    >
      {gaps.length ? (
        <ActionPanel.Section title={`Free time ${formatDay(ctx.day)}`}>
          {gaps.map((g) => {
            const minutes = quickDuration(props.estimate, g.minutes);
            const start = g.start;
            return (
              <Action
                key={g.start.toISOString()}
                title={`${formatRange(start, new Date(start.getTime() + minutes * 60_000))} · ${formatCountdown(minutes * 60_000)}`}
                icon={Icon.Clock}
                onAction={() => void quickBlock(ctx, source, start, minutes, props.notes ?? undefined)}
              />
            );
          })}
        </ActionPanel.Section>
      ) : null}
      <ActionPanel.Section>
        <Action
          title="Pick Time…"
          icon={Icon.Calendar}
          onAction={() =>
            push(
              <BlockForm
                ctx={ctx}
                source={source}
                defaultNotes={props.notes ?? ""}
                initialMinutes={props.estimate ?? undefined}
              />,
            )
          }
        />
        {existing.map(([id, link]) => (
          <Action
            key={id}
            title={`Edit Block ${formatRange(new Date(link.snapshot.start), new Date(link.snapshot.end))}`}
            icon={Icon.Pencil}
            onAction={() => push(<BlockForm ctx={ctx} source={source} linkId={id} />)}
          />
        ))}
      </ActionPanel.Section>
    </ActionPanel.Submenu>
  );
}

interface Candidate {
  id: string;
  source: LinkSource;
  title: string;
  subtitle: string;
  notes: string;
  estimate: number | null;
  icon: List.Item.Props["icon"];
}

/** ↵ on a free-time row: choose what to work on in that gap. */
export function FillGap(props: { ctx: AgendaCtx; gap: Gap }) {
  const { ctx, gap } = props;
  const { pop, push } = useNavigation();
  const agenda = ctx.data?.agenda;
  const today: Candidate[] = (agenda?.tasks ?? [])
    .filter((t) => !t.checked && !t.missing)
    .map((t) => ({
      id: `task:${t.taskId}`,
      source: { kind: "task", taskId: t.taskId, checklistId: t.checklist.id, title: t.title },
      title: t.title,
      subtitle: [t.checklist.title, ...t.parentChain].join(" › "),
      notes: t.details,
      estimate: t.estimate,
      icon: { source: Icon.CheckList, tintColor: Color.SecondaryText },
    }));
  const reminders: Candidate[] = [...(agenda?.overdue ?? []), ...(agenda?.dueToday ?? [])].map((r) => ({
    id: r.id,
    source: { kind: "reminder", itemId: r.reminder.itemId, externalId: r.reminder.externalId, title: r.reminder.title },
    title: r.reminder.title,
    subtitle: r.overdue ? "overdue" : (r.list?.title ?? ""),
    notes: r.reminder.notes ?? "",
    estimate: null,
    icon: { source: Icon.Bell, tintColor: r.overdue ? Color.Red : (r.list?.color ?? undefined) },
  }));
  const render = (c: Candidate) => {
    const minutes = quickDuration(c.estimate, gap.minutes);
    const end = new Date(gap.start.getTime() + minutes * 60_000);
    return (
      <List.Item
        key={c.id}
        id={c.id}
        icon={c.icon}
        title={c.title || "(untitled)"}
        accessories={[
          { text: formatCountdown(minutes * 60_000), icon: Icon.Clock },
          ...(c.subtitle ? [{ text: { value: c.subtitle, color: Color.SecondaryText } }] : []),
        ]}
        actions={
          <ActionPanel>
            <Action
              title={`Schedule ${formatRange(gap.start, end)}`}
              icon={Icon.Clock}
              onAction={async () => {
                if (await quickBlock(ctx, c.source, gap.start, minutes, c.notes)) pop();
              }}
            />
            <Action
              title="Pick Time and Length…"
              icon={Icon.Calendar}
              onAction={() =>
                push(
                  <BlockForm
                    ctx={ctx}
                    source={c.source}
                    defaultNotes={c.notes}
                    initialStart={gap.start}
                    initialMinutes={minutes}
                  />,
                )
              }
            />
          </ActionPanel>
        }
      />
    );
  };
  return (
    <List navigationTitle={`Free ${formatRange(gap.start, gap.end)}`} searchBarPlaceholder="What will you work on?">
      <List.EmptyView
        icon={Icon.CheckList}
        title="Nothing planned for this day yet"
        description="Add checklist items to the day first (↵ on the header row, Plan…)."
      />
      {today.length ? <List.Section title="Checklist items for this day">{today.map(render)}</List.Section> : null}
      {reminders.length ? <List.Section title="Reminders">{reminders.map(render)}</List.Section> : null}
    </List>
  );
}

/** ⌘S from inside a checklist: the shown day's free slots as one-step choices, plus Pick Time… */
export function SlotPicker(props: { ctx: AgendaCtx; source: LinkSource; notes?: string; estimate?: number | null }) {
  const { ctx, source } = props;
  const { pop, push } = useNavigation();
  const gaps = gapsFor(ctx);
  const existing = linksForSource(
    ctx.session.state,
    source.kind === "task" ? { kind: "task", taskId: source.taskId } : { kind: "reminder", itemId: source.itemId },
  );
  const calendarProblem = ctx.data?.agenda.failures.some((f) => f.source === "events") || Boolean(ctx.data?.staleSince);
  const pickTime = (
    <Action
      title="Pick Day and Time…"
      icon={Icon.Calendar}
      onAction={() =>
        push(
          <BlockForm
            ctx={ctx}
            source={source}
            defaultNotes={props.notes ?? ""}
            initialMinutes={props.estimate ?? undefined}
          />,
        )
      }
    />
  );
  return (
    <List isLoading={!ctx.data} navigationTitle={`Schedule: ${source.title}`} searchBarPlaceholder="Filter free times…">
      {ctx.data && !gaps.length ? (
        <List.EmptyView
          icon={Icon.Calendar}
          title={calendarProblem ? "Calendar could not be read" : `No free time left ${formatDay(ctx.day)}`}
          description="↵ picks a day and time yourself."
          actions={<ActionPanel>{pickTime}</ActionPanel>}
        />
      ) : null}
      {gaps.length ? (
        <List.Section title={`Free time ${formatDay(ctx.day)}`} subtitle="↵ schedules it there">
          {gaps.map((g) => {
            const minutes = quickDuration(props.estimate, g.minutes);
            const end = new Date(g.start.getTime() + minutes * 60_000);
            return (
              <List.Item
                key={g.start.toISOString()}
                icon={{ source: Icon.Clock, tintColor: Color.Blue }}
                title={withColumn(
                  rangeLabel(g.start, end, usesClock24()),
                  `${formatCountdown(minutes * 60_000)} block`,
                  usesClock24(),
                )}
                accessories={[
                  { text: { value: `${formatCountdown(g.minutes * 60_000)} free`, color: Color.SecondaryText } },
                ]}
                actions={
                  <ActionPanel>
                    <Action
                      title={`Schedule ${formatRange(g.start, end)}`}
                      icon={Icon.Clock}
                      onAction={async () => {
                        if (await quickBlock(ctx, source, g.start, minutes, props.notes)) pop();
                      }}
                    />
                    <Action
                      title="Change Length or Time…"
                      icon={Icon.Calendar}
                      onAction={() =>
                        push(
                          <BlockForm
                            ctx={ctx}
                            source={source}
                            defaultNotes={props.notes ?? ""}
                            initialStart={g.start}
                            initialMinutes={minutes}
                          />,
                        )
                      }
                    />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      ) : null}
      {gaps.length || existing.length ? (
        <List.Section title="Other">
          <List.Item icon={Icon.Calendar} title="Pick day and time…" actions={<ActionPanel>{pickTime}</ActionPanel>} />
          {existing.map(([id, link]) => (
            <List.Item
              key={id}
              icon={Icon.Pencil}
              title={`Edit existing block ${formatRange(new Date(link.snapshot.start), new Date(link.snapshot.end))}`}
              subtitle={formatDay(dayKeyOf(new Date(link.snapshot.start)))}
              actions={
                <ActionPanel>
                  <Action
                    title="Edit Block"
                    icon={Icon.Pencil}
                    onAction={() => push(<BlockForm ctx={ctx} source={source} linkId={id} />)}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}
