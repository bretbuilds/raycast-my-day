// My Day (redesign 2026-10-05, D-012): one day in four parts. "Has to happen" = overdue and due reminders, all-day
// and timed events. "Main task" = the day's needle-moving task. "Supporting" = the other checklist items and
// reminders picked for the day (open items from earlier days are carried onto today). Then the next day, so work
// pushed to it stays in sight. Reads happen on open and on ⌘R only; nothing polls while the command is closed.
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  Keyboard,
  LaunchType,
  List,
  confirmAlert,
  launchCommand,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { getProgressIcon, useCachedState } from "@raycast/utils";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import * as ek from "./eventkit.ts";
import {
  upcomingGroup,
  type EventRow,
  type PlanRow,
  type ReminderRow,
  type SourceFailure,
  type TaskRow,
} from "./lib/agenda.ts";
import {
  acceptCalendarVersion,
  calendarEventUrl,
  eventKeywords,
  reminderKeywords,
  reminderUrl,
  taskKeywords,
} from "./lib/agenda-rows.ts";
import {
  addDays,
  dayKeyOf,
  formatDay,
  formatDuration,
  formatTime,
  relativeDay,
  todayKey,
  usesClock24,
  type DayKey,
} from "./lib/dates.ts";
import { rangeLabel, withColumn } from "./lib/columns.ts";
import { failureText, type EventInfo, type ReminderInfo } from "./lib/eventkit-protocol.ts";
import { allTasks, detailsText, keepLineBreaks } from "./lib/markdown.ts";
import { notesWithoutMarker } from "./lib/links.ts";
import { dayCounts, daySummary, freeUntil, overdueLabel, spanLabel } from "./lib/summary.ts";
import { formatCountdown, formatRange, longDate, nextItem, shortDate, type NextItem } from "./lib/timeline.ts";
import { ScheduleSubmenu, SlotPicker } from "./components/QuickSchedule.tsx";
import {
  clearMain,
  moveFocusItem,
  pruneTasks,
  sameFocus,
  setMain,
  unassignDay,
  unpickReminder,
  type FocusRef,
  type Link,
  type LinkSource,
} from "./lib/state.ts";
import { saveWithOperation, type ChecklistFile } from "./lib/store.ts";
import { locate, removeTask, setChecked, setDetails, setTitle } from "./lib/tree.ts";
import { useAgenda } from "./lib/use-agenda.ts";
import { reportSave } from "./lib/use-checklists.ts";
import { failureToast, writable, type AgendaCtx } from "./components/agenda-shared.tsx";
import { ChecklistView } from "./components/ChecklistView.tsx";
import { EventForm } from "./components/EventForm.tsx";
import { QuickTaskForm } from "./components/QuickTaskForm.tsx";
import { ReminderForm } from "./components/ReminderForm.tsx";
import { BlockForm } from "./components/ScheduleBlockForm.tsx";
import { SourcesForm } from "./components/SourcesForm.tsx";
import { SetAlertSubmenu } from "./components/AlertActions.tsx";
import { addNewTask, dayName, inboxChecklist, PickTasks } from "./components/PickTasks.tsx";
import { ReminderEditForm } from "./components/ReminderEditForm.tsx";
import { TaskForm } from "./components/TaskForm.tsx";

const SOURCE_NAME: Record<SourceFailure["source"], string> = {
  events: "Calendar",
  reminders: "Reminders",
  checklists: "Checklists",
};

function sourceFailureText(f: SourceFailure): { title: string; description: string } {
  if (f.failure.kind === "store") return { title: "a checklist file could not be read", description: f.failure.detail };
  return failureText(f.failure);
}

function openCommand(name: "my-day-setup" | "checklists") {
  void launchCommand({ name, type: LaunchType.UserInitiated }).catch((e: unknown) =>
    showToast({ style: Toast.Style.Failure, title: "Could not open the command", message: String(e) }),
  );
}

function blockTimes(link: Link): string {
  const s = new Date(link.snapshot.start);
  return `${formatDay(dayKeyOf(s))} ${formatTime(s)}–${formatTime(new Date(link.snapshot.end))}`;
}

const ANY_TIME = "Any time";
/** Title with the shared left date/time column (measured padding, see src/lib/columns.ts). */
const col = (label: string, title: string) => withColumn(label, title, usesClock24());
const range = (start: Date, end: Date | null) => rangeLabel(start, end, usesClock24());

function md(text: string | null | undefined): string {
  return text?.trim() ? keepLineBreaks(text) : "";
}

function hhmm(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

function focusRef(row: PlanRow): FocusRef {
  return row.kind === "task"
    ? { kind: "task", taskId: row.taskId, checklistId: row.checklist.id }
    : { kind: "reminder", itemId: row.reminder.itemId };
}

/** A reminder whose day comes from its due date (not from a pick): pushing it changes the due date. */
function isDueReminder(row: PlanRow, rowDay: DayKey): row is ReminderRow {
  return row.kind === "reminder" && (row.overdue || row.reminder.dueDay === rowDay);
}

type Role = "must" | "main" | "support" | "next" | "upcoming";

export default function Command() {
  const ctl = useAgenda();
  const ctx: AgendaCtx = ctl;
  const { push } = useNavigation();
  const [showDetail, setShowDetail] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showUpcoming, setShowUpcoming] = useCachedState("my-day.showUpcoming", true);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [search, setSearch] = useState("");

  const today = todayKey();
  const { day, data } = ctl;
  const agenda = data?.agenda ?? null;
  const nextAgenda = data?.next ?? null;
  const nextDay = addDays(day, 1);
  const isToday = day === today;
  const rel = relativeDay(day, today);
  const relNext = relativeDay(nextDay, today);
  const navigationTitle = [
    "My Day",
    rel,
    rel === formatDay(day) ? null : formatDay(day),
    data?.staleSince ? `showing data from ${data.staleSince}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000); // countdown only; stops when the view closes
    return () => clearInterval(t);
  }, []);
  const next: NextItem | null = agenda && isToday ? nextItem(agenda, now) : null;
  const refresh = () => void ctl.refresh();
  const save = () => ctx.session.saveState();
  const state = ctx.session.state;
  /** The current or next timed item today carries its countdown (owner likes "Next up" with a timer). */
  const countdownTag = (rowId: string, role: Role): List.Item.Accessory[] =>
    next && role === "must" && next.id === rowId
      ? [{ tag: { value: next.countdown, color: next.ongoing ? Color.Green : Color.Blue } }]
      : [];

  // ---- Day-level actions on every row: navigation and picking tasks ---------------------------------------------
  const pickAction = (mode: "support" | "main" = "support", primary = false) => (
    <Action.Push
      key={`pick-${mode}`}
      title={mode === "main" ? `Choose Main Task for ${dayName(day)}…` : `Pick Tasks for ${dayName(day)}…`}
      icon={mode === "main" ? Icon.Star : Icon.CheckList}
      shortcut={primary || mode === "main" ? undefined : { modifiers: ["cmd", "shift"], key: "p" }}
      target={<PickTasks ctx={ctx} mode={mode} />}
      onPop={refresh}
    />
  );
  const navActions = (
    <ActionPanel.Section title="Day">
      {pickAction()}
      <Action
        title="Previous Day"
        icon={Icon.ArrowLeft}
        shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }}
        onAction={() => ctl.setDay(addDays(day, -1))}
      />
      <Action
        title="Next Day"
        icon={Icon.ArrowRight}
        shortcut={{ modifiers: ["cmd"], key: "arrowRight" }}
        onAction={() => ctl.setDay(nextDay)}
      />
      <Action
        title="Today"
        icon={Icon.Calendar}
        shortcut={{ modifiers: ["cmd"], key: "t" }}
        onAction={() => ctl.setDay(todayKey())}
      />
      <Action.PickDate
        title="Go to Date…"
        type={Action.PickDate.Type.Date}
        shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
        onChange={(d) => d && ctl.setDay(dayKeyOf(d))}
      />
      <Action
        title="Refresh"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={refresh}
      />
      <Action
        title={showUpcoming ? "Hide Upcoming Events" : "Show Upcoming Events"}
        icon={Icon.Calendar}
        shortcut={{ modifiers: ["cmd", "shift"], key: "u" }}
        onAction={() => setShowUpcoming(!showUpcoming)}
      />
      <Action
        title={showDetail ? "Hide Details Pane" : "Show Details Pane"}
        icon={Icon.Sidebar}
        shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
        onAction={() => setShowDetail((v) => !v)}
      />
    </ActionPanel.Section>
  );
  // ---- Creating (owner feedback 2026-10-05: no easy way to add from the main view) -------------------------------
  // Type in the search bar: a "New" section appears first and ↵ adds the text to the day as a supporting task.
  // ⌘N / ⌘⇧N / ⌘⌥N work on every row: task, reminder, event (prefilled with what was typed).
  const typed = search.trim();
  const inboxName =
    inboxChecklist((data?.checklists ?? []).filter((c) => !c.archived && !c.readOnlyReason))?.title ??
    "first checklist";
  const afterCreate = () => {
    setSearch("");
    refresh();
  };
  const addTask = async (asMain: boolean) => {
    if (await addNewTask(ctx, typed, day, asMain)) setSearch("");
  };
  const createActions = (
    <ActionPanel.Section title="Add">
      {typed ? (
        <Action
          title={`Add “${typed}” to ${dayName(day)}`}
          icon={Icon.PlusCircle}
          shortcut={Keyboard.Shortcut.Common.New}
          onAction={() => void addTask(false)}
        />
      ) : (
        <Action.Push
          title="New Task…"
          icon={Icon.PlusCircle}
          shortcut={Keyboard.Shortcut.Common.New}
          target={<QuickTaskForm ctx={ctx} />}
          onPop={refresh}
        />
      )}
      <Action.Push
        title={typed ? `New Reminder “${typed}”…` : "New Reminder…"}
        icon={Icon.Bell}
        shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
        target={<ReminderForm ctx={ctx} defaultTitle={typed} onDone={afterCreate} />}
      />
      <Action.Push
        title={typed ? `New Event “${typed}”…` : "New Event…"}
        icon={Icon.Calendar}
        shortcut={{ modifiers: ["cmd", "opt"], key: "n" }}
        target={<EventForm ctx={ctx} defaultTitle={typed} onDone={afterCreate} />}
      />
    </ActionPanel.Section>
  );
  const settingsActions = (
    <ActionPanel.Section title="More">
      <Action title="Open Checklists" icon={Icon.List} onAction={() => openCommand("checklists")} />
      <Action.Push
        title="Choose Calendars and Lists…"
        icon={Icon.Filter}
        // eslint-disable-next-line @raycast/prefer-common-shortcut -- ⌘⇧S opens the calendar/list selection here
        shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
        target={<SourcesForm ctx={ctx} />}
      />
      <Action title="Open My Day Setup" icon={Icon.Gear} onAction={() => openCommand("my-day-setup")} />
    </ActionPanel.Section>
  );
  const panel = (...rowActions: ReactNode[]) => (
    <ActionPanel>
      {rowActions}
      {createActions}
      {navActions}
    </ActionPanel>
  );

  // ---- Shared row actions --------------------------------------------------------------------------------------
  const openChecklist = (file: ChecklistFile) => (
    <Action.Push
      key="open-checklist"
      title="Open Checklist"
      icon={Icon.CheckList}
      shortcut={Keyboard.Shortcut.Common.Open}
      target={
        <ChecklistView
          session={ctx.session}
          file={file}
          onSchedule={(task, f) =>
            push(
              <SlotPicker
                ctx={ctx}
                source={{ kind: "task", taskId: task.id, checklistId: f.id, title: task.title }}
                notes={detailsText(task)}
                estimate={state.estimates[task.id] ?? null}
              />,
            )
          }
        />
      }
      onPop={refresh}
    />
  );

  async function deleteBlock(linkId: string, link: Link) {
    const ok = await confirmAlert({
      title: "Delete Work Block?",
      message: `Deletes the calendar event "${link.snapshot.title}" (${blockTimes(link)}). The ${
        link.source.kind === "task" ? "checklist item" : "reminder"
      } it was scheduled for is not changed.`,
      primaryAction: { title: "Delete Work Block", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    const r = await ek.deleteEvent({
      eventId: link.eventId,
      externalId: link.externalId,
      expectedLastModified: link.snapshot.lastModified,
      expectedSnapshot: { title: link.snapshot.title, start: link.snapshot.start, end: link.snapshot.end },
    });
    if (r.ok) {
      delete state.links[linkId];
      save();
      await showToast({ style: Toast.Style.Success, title: "Work block deleted", message: link.source.title });
    } else if (r.failure.kind === "helper" && r.failure.code === "conflict") {
      await showToast({
        style: Toast.Style.Failure,
        title: "Changed in Calendar — reload",
        message: "The block was edited outside My Day; nothing was deleted.",
        primaryAction: { title: "Reload", onAction: refresh },
      });
    } else if (r.failure.kind === "helper" && r.failure.code === "not-found") {
      delete state.links[linkId];
      save();
      await showToast({
        style: Toast.Style.Failure,
        title: "Block was already deleted outside My Day",
        message: "The link is cleared; nothing was recreated.",
      });
    } else {
      await failureToast("Block not deleted", r.failure);
      return;
    }
    refresh();
  }

  /** Hides one calendar from My Day only (Calendar itself is unchanged); ⌘⇧S Choose Calendars shows it again. */
  function hideCalendar(id: string, title: string) {
    const before = state.sources.eventCalendarIds;
    const all = (data?.calendars ?? []).map((c) => c.id);
    state.sources.eventCalendarIds = (before ?? all).filter((c) => c !== id);
    if (!save()) return;
    void showToast({
      style: Toast.Style.Success,
      title: `Hid ${title} in My Day`,
      message: "Choose Calendars (⌘⇧S on the top row) shows it again.",
      primaryAction: {
        title: "Undo",
        onAction: (t) => {
          t.hide();
          state.sources.eventCalendarIds = before;
          save();
          refresh();
        },
      },
    });
    refresh();
  }

  async function deleteEvent(e: EventInfo) {
    const span = spanLabel(e, day)?.split(" · ")[0];
    const when = e.isAllDay
      ? (span ?? `all day ${formatDay(e.startDay)}`)
      : `${formatDay(dayKeyOf(new Date(e.start)))} ${formatTime(new Date(e.start))} – ${formatDay(dayKeyOf(new Date(e.end)))} ${formatTime(new Date(e.end))}`;
    const ok = await confirmAlert({
      title: "Delete Event?",
      message: `Deletes "${e.title || "(no title)"}" (${when}) from Calendar on all your devices.`,
      primaryAction: { title: "Delete Event", style: Alert.ActionStyle.Destructive },
    });
    if (!ok || !e.eventId) return;
    const r = await ek.deleteEvent({
      eventId: e.eventId,
      externalId: e.externalId,
      expectedLastModified: e.lastModified,
      expectedSnapshot: { title: e.title, start: e.start, end: e.end },
    });
    if (r.ok) await showToast({ style: Toast.Style.Success, title: "Event deleted", message: e.title });
    else if (r.failure.kind === "helper" && r.failure.code === "conflict")
      await showToast({
        style: Toast.Style.Failure,
        title: "Changed in Calendar — reload",
        message: "The event was edited outside My Day; nothing was deleted.",
        primaryAction: { title: "Reload", onAction: refresh },
      });
    else await failureToast("Event not deleted", r.failure);
    refresh();
  }

  async function deleteReminder(row: ReminderRow) {
    const r = row.reminder;
    const ok = await confirmAlert({
      title: "Delete Reminder?",
      message: `Deletes "${r.title || "(no title)"}" from Reminders on all your devices.${
        r.isRecurring ? " It repeats: the whole reminder goes, not just this time." : ""
      }`,
      primaryAction: { title: "Delete Reminder", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    const res = await ek.deleteReminder({
      itemId: r.itemId,
      externalId: r.externalId,
      expectedLastModified: r.lastModified,
    });
    if (res.ok) {
      unpickReminder(state, r.itemId);
      for (const [d, m] of Object.entries(state.main))
        if (m.kind === "reminder" && m.itemId === r.itemId) delete state.main[d];
      save();
      await showToast({ style: Toast.Style.Success, title: "Reminder deleted", message: r.title });
    } else if (res.failure.kind === "helper" && res.failure.code === "conflict")
      await showToast({
        style: Toast.Style.Failure,
        title: "Changed in Reminders — reload",
        message: "The reminder was edited outside My Day; nothing was deleted.",
        primaryAction: { title: "Reload", onAction: refresh },
      });
    else await failureToast("Reminder not deleted", res.failure);
    refresh();
  }

  async function deleteTask(row: TaskRow) {
    const loc = locate(row.checklist.doc, row.taskId);
    const sub = loc ? allTasks(loc.node.children).length : 0;
    const ok = await confirmAlert({
      title: "Delete Task?",
      message: `Deletes "${row.title}"${sub ? ` and its ${sub} sub-item${sub === 1 ? "" : "s"}` : ""} from ${row.checklist.title}. A snapshot of the file is kept in .myday/snapshots, so it can be recovered.`,
      primaryAction: { title: "Delete Task", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    const r = saveWithOperation(ctx.session.dir, row.checklist, (doc) => removeTask(doc, row.taskId) !== null);
    const saved = await reportSave(r, { title: "Task deleted", message: row.title });
    if (saved) {
      const live = new Set(allTasks(saved.doc.blocks).map((t) => t.id));
      pruneTasks(state, saved.id, live);
      for (const [d, m] of Object.entries(state.main))
        if (m.kind === "task" && !live.has(m.taskId) && m.checklistId === saved.id) delete state.main[d];
      save();
    }
    refresh();
  }

  async function completeReminder(r: ReminderInfo) {
    const ref = { itemId: r.itemId, externalId: r.externalId };
    const res = await ek.completeReminder({ ...ref, expectedLastModified: r.lastModified }, true);
    if (!res.ok) {
      if (res.failure.kind === "helper" && res.failure.code === "conflict")
        await showToast({
          style: Toast.Style.Failure,
          title: "Changed in Reminders — reload",
          message: "The reminder was edited outside My Day; it was not completed.",
          primaryAction: { title: "Reload", onAction: refresh },
        });
      else await failureToast("Not completed", res.failure);
      return;
    }
    const done = res.value;
    await showToast({
      style: Toast.Style.Success,
      title: "Reminder completed",
      message: r.title,
      primaryAction: {
        title: "Undo",
        shortcut: { modifiers: ["cmd"], key: "z" },
        onAction: async (toast) => {
          toast.hide();
          const undo = await ek.completeReminder({ ...ref, expectedLastModified: done.lastModified }, false);
          if (undo.ok) await showToast({ style: Toast.Style.Success, title: "Reminder reopened", message: r.title });
          else await failureToast("Undo failed", undo.failure);
          refresh();
        },
      },
    });
    refresh();
  }

  async function toggleTask(row: TaskRow) {
    const r = saveWithOperation(ctx.session.dir, row.checklist, (doc) => setChecked(doc, row.taskId, !row.checked));
    await reportSave(r, { title: row.checked ? "Marked not done" : "Completed", message: row.title });
    refresh();
  }

  /** Moves a planned item between two days (push to the next day, or bring it back), with Undo. */
  async function moveItem(row: PlanRow, from: DayKey, to: DayKey) {
    const title = row.kind === "task" ? row.title : row.reminder.title;
    const verb = to > from ? `Pushed to ${dayName(to)}` : `Moved to ${dayName(to)}`;
    const ref = focusRef(row);
    if (isDueReminder(row, from)) {
      const r = row.reminder;
      const res = await ek.setReminderDue(
        { itemId: r.itemId, externalId: r.externalId, expectedLastModified: r.lastModified },
        to,
        r.dueHasTime ? hhmm(r.dueDateTime) : null,
      );
      if (!res.ok) return void failureToast("Not moved", res.failure);
      const wasMain = sameFocus(state.main[from], ref);
      const pickedOn = state.picks[r.itemId]?.day ?? null;
      if (wasMain) {
        delete state.main[from];
        if (!state.main[to]) state.main[to] = ref;
      }
      // A due reminder moved to supporting goes with its due date, so it stays a supporting task on the new day.
      if (pickedOn) state.picks[r.itemId].day = to;
      if (wasMain || pickedOn) save();
      const moved = res.value;
      await showToast({
        style: Toast.Style.Success,
        title: `${verb} (due date changed)`,
        message: title,
        primaryAction: {
          title: "Undo",
          shortcut: { modifiers: ["cmd"], key: "z" },
          onAction: async (toast) => {
            toast.hide();
            const undo = await ek.setReminderDue(
              { itemId: r.itemId, externalId: r.externalId, expectedLastModified: moved.lastModified },
              r.dueDay,
              r.dueHasTime ? hhmm(r.dueDateTime) : null,
            );
            if (!undo.ok) await failureToast("Undo failed", undo.failure);
            else {
              if (wasMain) {
                if (sameFocus(state.main[to], ref)) delete state.main[to];
                state.main[from] = ref;
              }
              if (pickedOn && state.picks[r.itemId]) state.picks[r.itemId].day = pickedOn;
              save();
            }
            refresh();
          },
        },
      });
      return refresh();
    }
    const key = ref.kind === "task" ? ref.taskId : ref.itemId;
    const before = JSON.stringify({
      a: state.assignments[key] ?? null,
      p: state.picks[key] ?? null,
      mf: state.main[from] ?? null,
      mt: state.main[to] ?? null,
    });
    if (!moveFocusItem(state, from, to, ref) || !save()) return;
    await showToast({
      style: Toast.Style.Success,
      title: verb,
      message: title,
      primaryAction: {
        title: "Undo",
        shortcut: { modifiers: ["cmd"], key: "z" },
        onAction: (toast) => {
          toast.hide();
          const b = JSON.parse(before);
          const put = <T,>(rec: Record<string, T>, k: string, v: T | null) => (v ? (rec[k] = v) : delete rec[k]);
          put(state.assignments, key, b.a);
          put(state.picks, key, b.p);
          put(state.main, from, b.mf);
          put(state.main, to, b.mt);
          save();
          refresh();
        },
      },
    });
    refresh();
  }

  function makeMain(row: PlanRow, rowDay: DayKey) {
    const title = row.kind === "task" ? row.title : row.reminder.title;
    setMain(
      state,
      rowDay,
      focusRef(row),
      row.kind === "reminder" ? { externalId: row.reminder.externalId, title } : undefined,
    );
    if (save())
      void showToast({ style: Toast.Style.Success, title: `Main task for ${dayName(rowDay)}`, message: title });
    refresh();
  }

  function makeSupporting(row: PlanRow, rowDay: DayKey) {
    if (clearMain(state, rowDay, focusRef(row)) && save())
      void showToast({ style: Toast.Style.Success, title: "Now a supporting task" });
    refresh();
  }

  function removeFromDay(row: PlanRow, rowDay: DayKey) {
    const ref = focusRef(row);
    clearMain(state, rowDay, ref);
    const removed = ref.kind === "task" ? unassignDay(state, ref.taskId) : unpickReminder(state, ref.itemId);
    if (removed && save())
      void showToast({
        style: Toast.Style.Success,
        title: `Removed from ${dayName(rowDay)}`,
        message: row.kind === "task" ? row.title : row.reminder.title,
      });
    refresh();
  }

  /** Push to the next day, or (in the Tomorrow section) bring back to the day shown. */
  function moveAction(row: PlanRow, role: Role, rowDay: DayKey): ReactNode {
    return role === "next" ? (
      <Action
        title={`Move to ${dayName(day)}`}
        icon={Icon.ArrowLeft}
        shortcut={{ modifiers: ["cmd", "shift"], key: "arrowLeft" }}
        onAction={() => void moveItem(row, rowDay, day)}
      />
    ) : (
      <Action
        title={`Push to ${dayName(addDays(rowDay, 1))}`}
        icon={Icon.ArrowRight}
        shortcut={{ modifiers: ["cmd", "shift"], key: "arrowRight" }}
        onAction={() => void moveItem(row, rowDay, addDays(rowDay, 1))}
      />
    );
  }

  // ---- Multi-select (owner 2026-10-05). Raycast lists select one row; this keeps its own set of marked rows. ⌘⇧A
  // marks or unmarks a reminder or task; on a marked row the menu acts on every marked row at once.
  const planIndex = new Map<string, { row: PlanRow; rowDay: DayKey }>();
  const selKey = (row: PlanRow, rowDay: DayKey) => `${rowDay}|${row.id}`;
  const isSelected = (row: PlanRow, rowDay: DayKey) => selected.has(selKey(row, rowDay));
  const selectedTargets = () =>
    [...selected].map((k) => planIndex.get(k)).filter((t): t is { row: PlanRow; rowDay: DayKey } => Boolean(t));
  const rowTitle = (row: PlanRow) => (row.kind === "task" ? row.title : row.reminder.title);
  const toggleSelected = (row: PlanRow, rowDay: DayKey) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = selKey(row, rowDay);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  function selectedTag(row: PlanRow, rowDay: DayKey): List.Item.Accessory[] {
    return isSelected(row, rowDay)
      ? [{ icon: { source: Icon.CheckCircle, tintColor: Color.Blue }, tag: { value: "selected", color: Color.Blue } }]
      : [];
  }

  function selectToggle(row: PlanRow, rowDay: DayKey): ReactNode {
    return (
      <>
        <Action
          title={isSelected(row, rowDay) ? "Unselect" : "Select (for Several at Once)"}
          icon={Icon.CheckCircle}
          shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
          onAction={() => toggleSelected(row, rowDay)}
        />
        {selected.size ? (
          <Action
            title="Clear Selection"
            icon={Icon.XMarkCircle}
            shortcut={{ modifiers: ["cmd", "opt"], key: "a" }}
            onAction={clearSelection}
          />
        ) : null}
      </>
    );
  }

  /** The menu of a marked row: actions for all marked rows, then unmark/clear, then Add and Day. */
  function selectedPanel(row: PlanRow, rowDay: DayKey): ReactElement | null {
    if (!isSelected(row, rowDay)) return null;
    // Counted from the keys (rows below this one are not rendered yet); the handlers resolve the rows when run.
    const n = selected.size;
    const reminderCount = [...selected].filter((k) => k.includes("|reminder:")).length;
    const ts = () => selectedTargets();
    const reminders = () => selectedTargets().filter((t) => t.row.kind === "reminder");
    const lists = writable(data?.lists ?? []);
    return panel(
      <ActionPanel.Section key="bulk" title={`${n} selected`}>
        <Action title={`Complete ${n}`} icon={Icon.Checkmark} onAction={() => void bulkComplete(ts())} />
        <Action
          title={`Push ${n} to Next Day`}
          icon={Icon.ArrowRight}
          shortcut={{ modifiers: ["cmd", "shift"], key: "arrowRight" }}
          onAction={() => void bulkMove(ts(), (t) => addDays(t.rowDay, 1))}
        />
        <Action.PickDate
          title={`Move ${n} to Date…`}
          type={Action.PickDate.Type.Date}
          onChange={(d) => d && void bulkMove(ts(), () => dayKeyOf(d))}
        />
        {reminderCount && lists.length ? (
          <ActionPanel.Submenu title={`Move ${reminderCount} Reminders to List…`} icon={Icon.List}>
            {lists.map((l) => (
              <Action key={l.id} title={l.title} onAction={() => void bulkToList(reminders(), l.id, l.title)} />
            ))}
          </ActionPanel.Submenu>
        ) : null}
        <Action
          title={`Delete ${n}`}
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={Keyboard.Shortcut.Common.Remove}
          onAction={() => void bulkDelete(ts())}
        />
      </ActionPanel.Section>,
      <ActionPanel.Section key="sel">{selectToggle(row, rowDay)}</ActionPanel.Section>,
    );
  }

  type Target = { row: PlanRow; rowDay: DayKey };
  /** "3", or "2 of 3" when some failed (e.g. changed elsewhere). */
  const count = (done: number, total: number) => (done === total ? `${done}` : `${done} of ${total}`);
  const undoToast = async (title: string, undo: (() => Promise<void> | void)[]) => {
    clearSelection();
    await showToast({
      style: Toast.Style.Success,
      title,
      primaryAction: undo.length
        ? {
            title: "Undo",
            shortcut: { modifiers: ["cmd"], key: "z" },
            onAction: async (toast) => {
              toast.hide();
              for (const u of undo.reverse()) await u();
              save();
              refresh();
            },
          }
        : undefined,
    });
    refresh();
  };

  async function bulkComplete(ts: Target[]) {
    const undo: (() => Promise<void> | void)[] = [];
    let done = 0;
    const byFile = new Map<string, { file: ChecklistFile; ids: string[] }>();
    for (const { row } of ts) {
      if (row.kind === "reminder") {
        const r = row.reminder;
        const res = await ek.completeReminder(
          { itemId: r.itemId, externalId: r.externalId, expectedLastModified: r.lastModified },
          true,
        );
        if (!res.ok) continue;
        done++;
        const lm = res.value.lastModified;
        undo.push(
          async () =>
            void (await ek.completeReminder(
              { itemId: r.itemId, externalId: r.externalId, expectedLastModified: lm },
              false,
            )),
        );
      } else if (!row.checked) {
        const g = byFile.get(row.checklist.id) ?? { file: row.checklist, ids: [] };
        g.ids.push(row.taskId);
        byFile.set(row.checklist.id, g);
      }
    }
    for (const g of byFile.values()) {
      const r = saveWithOperation(ctx.session.dir, g.file, (doc) =>
        g.ids.map((id) => setChecked(doc, id, true)).some(Boolean),
      );
      if (!r.ok) continue;
      done += g.ids.length;
      undo.push(
        () =>
          void saveWithOperation(ctx.session.dir, r.file, (doc) =>
            g.ids.map((id) => setChecked(doc, id, false)).some(Boolean),
          ),
      );
    }
    await undoToast(`Completed ${count(done, ts.length)}`, undo);
  }

  /** Moves each item to the day `to(target)`: due reminders change their due date; tasks and picks move in My Day. */
  async function bulkMove(ts: Target[], to: (t: Target) => DayKey) {
    const undo: (() => Promise<void> | void)[] = [];
    let moved = 0;
    for (const t of ts) {
      const { row, rowDay } = t;
      const dest = to(t);
      if (dest === rowDay) continue;
      if (row.kind === "reminder" && row.reminder.dueDay) {
        const r = row.reminder;
        const time = r.dueHasTime ? hhmm(r.dueDateTime) : null;
        const res = await ek.setReminderDue(
          { itemId: r.itemId, externalId: r.externalId, expectedLastModified: r.lastModified },
          dest,
          time,
        );
        if (!res.ok) continue;
        const lm = res.value.lastModified;
        undo.push(
          async () =>
            void (await ek.setReminderDue(
              { itemId: r.itemId, externalId: r.externalId, expectedLastModified: lm },
              r.dueDay,
              time,
            )),
        );
      } else {
        const ref = focusRef(row);
        const key = ref.kind === "task" ? ref.taskId : ref.itemId;
        const before = {
          a: state.assignments[key],
          p: state.picks[key] ? { ...state.picks[key] } : undefined,
          mf: state.main[rowDay],
          mt: state.main[dest],
        };
        if (!moveFocusItem(state, rowDay, dest, ref)) continue;
        undo.push(() => {
          const put = <T,>(rec: Record<string, T>, k: string, v: T | undefined) => (v ? (rec[k] = v) : delete rec[k]);
          put(state.assignments, key, before.a);
          put(state.picks, key, before.p);
          put(state.main, rowDay, before.mf);
          put(state.main, dest, before.mt);
        });
      }
      moved++;
    }
    save();
    await undoToast(`Moved ${count(moved, ts.length)}`, undo);
  }

  async function bulkToList(ts: Target[], listId: string, listTitle: string) {
    const undo: (() => Promise<void> | void)[] = [];
    let moved = 0;
    for (const { row } of ts) {
      if (row.kind !== "reminder" || row.reminder.listId === listId) continue;
      const r = row.reminder;
      const res = await ek.updateReminder({
        itemId: r.itemId,
        externalId: r.externalId,
        expectedLastModified: r.lastModified,
        listId,
      });
      if (!res.ok) continue;
      moved++;
      const lm = res.value.lastModified;
      undo.push(
        async () =>
          void (await ek.updateReminder({
            itemId: r.itemId,
            externalId: r.externalId,
            expectedLastModified: lm,
            listId: r.listId,
          })),
      );
    }
    await undoToast(`Moved ${moved} to ${listTitle}`, undo);
  }

  async function bulkDelete(ts: Target[]) {
    const names = ts
      .slice(0, 5)
      .map((t) => `• ${rowTitle(t.row)}`)
      .join("\n");
    const ok = await confirmAlert({
      title: `Delete ${ts.length} items?`,
      message: `${names}${ts.length > 5 ? `\n…and ${ts.length - 5} more` : ""}\n\nReminders are deleted from Reminders on all your devices; tasks from their checklists (a snapshot is kept).`,
      primaryAction: { title: `Delete ${ts.length}`, style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    let gone = 0;
    const byFile = new Map<string, { file: ChecklistFile; ids: string[] }>();
    for (const { row } of ts) {
      if (row.kind === "reminder") {
        const r = row.reminder;
        const res = await ek.deleteReminder({
          itemId: r.itemId,
          externalId: r.externalId,
          expectedLastModified: r.lastModified,
        });
        if (!res.ok) continue;
        gone++;
        unpickReminder(state, r.itemId);
      } else {
        const g = byFile.get(row.checklist.id) ?? { file: row.checklist, ids: [] };
        g.ids.push(row.taskId);
        byFile.set(row.checklist.id, g);
      }
    }
    for (const g of byFile.values()) {
      const r = saveWithOperation(ctx.session.dir, g.file, (doc) =>
        g.ids.map((id) => removeTask(doc, id) !== null).some(Boolean),
      );
      if (!r.ok) continue;
      gone += g.ids.length;
      const live = new Set(allTasks(r.file.doc.blocks).map((t) => t.id));
      pruneTasks(state, r.file.id, live);
      for (const [d, m] of Object.entries(state.main))
        if (m.kind === "task" && !live.has(m.taskId) && m.checklistId === r.file.id) delete state.main[d];
    }
    save();
    await undoToast(`Deleted ${count(gone, ts.length)}`, []);
  }

  // ---- Rows --------------------------------------------------------------------------------------------------
  const ids: string[] = [];
  const sections: ReactNode[] = [];
  // Own filtering (not Raycast's fuzzy ranking): every typed word must appear in the row's title, subtitle or
  // keywords, rows keep their order, and the New rows always come first, so ↵ after typing always adds.
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const item = (id: string, node: ReactNode) => {
    if (words.length && !id.startsWith("new:")) {
      const p = (node as ReactElement<{ title?: string; subtitle?: string; keywords?: string[] }>).props;
      const hay = [p.title, p.subtitle, ...(p.keywords ?? [])].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
    }
    ids.push(id);
    return node;
  };
  const section = (key: string, title: string | undefined, subtitle: string | undefined, rows: ReactNode[]) => {
    const shown = rows.filter(Boolean);
    if (shown.length)
      sections.push(
        <List.Section key={key} title={title} subtitle={subtitle}>
          {shown}
        </List.Section>,
      );
  };

  function eventItem(row: EventRow, rowDay: DayKey, role: Role) {
    const e = row.event;
    const color = row.calendar?.color ?? Color.SecondaryText;
    const edited = row.link ? data?.editedLinks[row.link.id] : undefined;
    const url = (() => {
      try {
        return calendarEventUrl(e);
      } catch {
        return null;
      }
    })();
    const span = spanLabel(e, rowDay);
    const [spanRange, spanPos] = span ? span.split(" · ") : [null, null];
    const accessories: List.Item.Accessory[] = [...countdownTag(row.id, role)];
    if (edited) accessories.push({ tag: { value: "edited in Calendar", color: Color.Orange } });
    // Multi-day events (a trip, a conference): the closest Raycast lists get to My Schedule's colour bar is a
    // progress ring in the calendar's colour (how far through the span today is) and a tag in that colour.
    const progress = spanPos && role !== "upcoming" ? /day (\d+) of (\d+)/.exec(spanPos) : null;
    // The range is too wide for the date column, so the end date goes in the tag: "day 2 of 23 · until Thu 19 Nov".
    const until = spanRange ? `until ${spanRange.split(" – ")[1]}` : null;
    if (spanPos || until)
      accessories.push({
        tag: {
          value: role === "upcoming" ? (until ?? "") : [spanPos, until].filter(Boolean).join(" · "),
          color: row.calendar?.color ?? Color.Blue,
        },
      });
    if (e.isRecurring) accessories.push({ icon: Icon.Repeat, tooltip: "Recurring" });
    accessories.push({ text: { value: row.calendar?.title ?? "Calendar", color: Color.SecondaryText } });
    const notes = notesWithoutMarker(e.notes);
    const id = role === "next" ? `next:${row.id}` : role === "upcoming" ? `up:${row.id}` : row.id;
    return item(
      id,
      <List.Item
        key={id}
        id={id}
        icon={
          progress
            ? getProgressIcon(Number(progress[1]) / Number(progress[2]), color)
            : { source: row.link ? Icon.Clock : Icon.Calendar, tintColor: color }
        }
        title={col(
          role === "upcoming"
            ? // Coming up: the date leads, like My Schedule ("Mon 12 Oct", "Thu 8 Oct 8:00 AM"); a range ends in the tag.
              e.isAllDay
              ? shortDate(rowDay)
              : `${shortDate(rowDay)} ${formatTime(new Date(e.start))}`
            : e.isAllDay
              ? "All day"
              : progress
                ? // A timed event over several days: when it starts, that it runs all day, or when it ends.
                  progress[1] === "1"
                  ? `from ${formatTime(new Date(e.start))}`
                  : progress[1] === progress[2]
                    ? `until ${formatTime(new Date(e.end))}`
                    : "All day"
                : range(new Date(e.start), new Date(e.end)),
          e.title || "(no title)",
        )}
        subtitle={row.link && row.link.link.source.title !== e.title ? `⤷ ${row.link.link.source.title}` : undefined}
        keywords={eventKeywords(row)}
        accessories={showDetail ? [] : accessories}
        detail={
          <List.Item.Detail
            markdown={`## ${e.title || "(no title)"}\n\n${md(notes)}`}
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label title="Calendar" text={row.calendar?.title ?? e.calendarId} />
                <List.Item.Detail.Metadata.Label
                  title="When"
                  text={
                    e.isAllDay
                      ? e.startDay === e.endDay
                        ? `All day ${formatDay(e.startDay)}`
                        : `All day ${formatDay(e.startDay)} – ${formatDay(e.endDay)}`
                      : `${formatDay(dayKeyOf(new Date(e.start)))} ${formatRange(new Date(e.start), new Date(e.end))}`
                  }
                />
                {e.location ? <List.Item.Detail.Metadata.Label title="Location" text={e.location} /> : null}
                {e.url ? <List.Item.Detail.Metadata.Label title="URL" text={e.url} /> : null}
                {row.link ? (
                  <List.Item.Detail.Metadata.Label
                    title="Work block for"
                    text={`${row.link.link.source.kind === "task" ? "Checklist item" : "Reminder"}: ${row.link.link.source.title}`}
                    icon={Icon.Link}
                  />
                ) : null}
                {edited ? (
                  <List.Item.Detail.Metadata.Label title="Edited in Calendar" text={edited.join(", ")} />
                ) : null}
              </List.Item.Detail.Metadata>
            }
          />
        }
        actions={panel(
          url ? (
            <Action.Open
              key="open"
              title="Open in Calendar"
              icon={Icon.Calendar}
              target={url}
              shortcut={Keyboard.Shortcut.Common.Open}
            />
          ) : null,
          row.link && !e.isRecurring ? (
            <Action
              key="delete-block"
              title="Delete Work Block"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.Remove}
              onAction={() => void deleteBlock(row.link!.id, state.links[row.link!.id] ?? row.link!.link)}
            />
          ) : null,
          !row.link && e.eventId && e.allowsModifications && !e.isRecurring ? (
            <Action
              key="delete-event"
              title="Delete Event"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.Remove}
              onAction={() => void deleteEvent(e)}
            />
          ) : null,
          !row.link && e.isRecurring && url ? (
            <Action.Open key="delete-in-calendar" title="Delete in Calendar…" icon={Icon.Trash} target={url} />
          ) : null,
          <SetAlertSubmenu key="alert" event={e} onDone={refresh} />,
          row.calendar ? (
            <Action
              key="hide-calendar"
              title={`Hide Calendar “${row.calendar.title}”`}
              icon={Icon.EyeDisabled}
              onAction={() => hideCalendar(row.calendar!.id, row.calendar!.title)}
            />
          ) : null,
          <Action.CopyToClipboard
            key="copy"
            title="Copy Title"
            content={e.title}
            shortcut={Keyboard.Shortcut.Common.Copy}
          />,
          row.link && !e.isRecurring ? (
            <Action.Push
              key="edit-block"
              title="Edit Work Block…"
              icon={Icon.Pencil}
              shortcut={Keyboard.Shortcut.Common.Edit}
              target={<BlockForm ctx={ctx} source={row.link.link.source} linkId={row.link.id} />}
            />
          ) : null,
          row.link && edited ? (
            <Action
              key="accept"
              title="Accept Calendar Changes"
              icon={Icon.Checkmark}
              onAction={() => {
                const l = state.links[row.link!.id];
                if (l) acceptCalendarVersion(l, e);
                save();
                refresh();
              }}
            />
          ) : null,
        )}
      />,
    );
  }

  function reminderItem(row: ReminderRow, rowDay: DayKey, role: Role, star = false) {
    planIndex.set(selKey(row, rowDay), { row, rowDay });
    const r = row.reminder;
    const url = reminderUrl(r.itemId);
    const label = row.carriedFrom
      ? `from ${shortDate(row.carriedFrom)}`
      : row.overdue && r.dueDay && r.dueDay !== rowDay
        ? shortDate(r.dueDay)
        : r.dueHasTime && r.dueDateTime && r.dueDay === rowDay
          ? range(new Date(r.dueDateTime), null)
          : r.dueDay && r.dueDay !== rowDay
            ? `due ${shortDate(r.dueDay)}`
            : row.picked && !r.dueDay
              ? "No date"
              : role === "must"
                ? ANY_TIME
                : "";
    const isMain = role === "main" || star;
    const accessories: List.Item.Accessory[] = [...countdownTag(row.id, role)];
    // Past-due is the one thing that must stand out: red bell plus a red tag saying how late it is.
    if (row.overdue && r.dueDay)
      accessories.push({
        tag: {
          value: overdueLabel(r.dueDay, today, r.dueHasTime && r.dueDateTime ? new Date(r.dueDateTime) : null),
          color: Color.Red,
        },
      });
    if (row.links.length)
      accessories.push({
        icon: Icon.Link,
        tooltip: `Work block: ${row.links.map(([, l]) => blockTimes(l)).join(", ")}`,
      });
    if (r.isRecurring) accessories.push({ icon: Icon.Repeat, tooltip: "Recurring" });
    accessories.push({ text: { value: row.list?.title ?? "Reminders", color: Color.SecondaryText } });
    const source: LinkSource = { kind: "reminder", itemId: r.itemId, externalId: r.externalId, title: r.title };
    const id = `${role}:${row.id}`;
    return item(
      id,
      <List.Item
        key={id}
        id={id}
        icon={
          isMain
            ? { source: Icon.Star, tintColor: Color.Yellow }
            : { source: Icon.Bell, tintColor: row.overdue ? Color.Red : (row.list?.color ?? undefined) }
        }
        title={col(label, r.title || "(no title)")}
        keywords={reminderKeywords(row)}
        accessories={showDetail ? selectedTag(row, rowDay) : [...selectedTag(row, rowDay), ...accessories]}
        detail={
          <List.Item.Detail
            markdown={`## ${r.title || "(no title)"}\n\n${md(r.notes)}`}
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label title="List" text={row.list?.title ?? r.listId} />
                <List.Item.Detail.Metadata.Label
                  title="Due"
                  text={
                    r.dueDay
                      ? `${formatDay(r.dueDay)}${r.dueHasTime && r.dueDateTime ? ` ${formatTime(new Date(r.dueDateTime))}` : ""}`
                      : "No due date"
                  }
                />
                {row.picked ? (
                  <List.Item.Detail.Metadata.Label
                    title="Picked for"
                    text={formatDay(state.picks[r.itemId]?.day ?? rowDay)}
                  />
                ) : null}
                {r.url ? <List.Item.Detail.Metadata.Label title="URL" text={r.url} /> : null}
              </List.Item.Detail.Metadata>
            }
          />
        }
        actions={
          selectedPanel(row, rowDay) ??
          panel(
            <ActionPanel.Section key="do">
              <Action title="Complete Reminder" icon={Icon.Checkmark} onAction={() => void completeReminder(r)} />
              <Action.Push
                title="Edit Reminder…"
                icon={Icon.Pencil}
                shortcut={{ modifiers: ["cmd"], key: "return" }}
                target={<ReminderEditForm ctx={ctx} reminder={r} />}
                onPop={refresh}
              />
              <Action
                title="Delete Reminder"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={() => void deleteReminder(row)}
              />
            </ActionPanel.Section>,
            <ActionPanel.Section key="plan">
              {role !== "next" ? <ScheduleSubmenu ctx={ctx} source={source} notes={r.notes} estimate={null} /> : null}
              {moveAction(row, role, rowDay)}
              {url ? (
                <Action.Open
                  title="Open in Reminders"
                  icon={Icon.Bell}
                  target={url}
                  shortcut={Keyboard.Shortcut.Common.Open}
                />
              ) : null}
              {row.picked ? (
                <Action
                  title={`Remove from ${dayName(rowDay)}`}
                  icon={Icon.MinusCircle}
                  shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                  onAction={() => removeFromDay(row, rowDay)}
                />
              ) : null}
              {selectToggle(row, rowDay)}
            </ActionPanel.Section>,
          )
        }
      />,
    );
  }

  function taskItem(row: TaskRow, rowDay: DayKey, role: Role, star = false) {
    if (!row.missing) planIndex.set(selKey(row, rowDay), { row, rowDay });
    const id = `${role}:${row.id}`;
    if (row.missing) {
      return item(
        id,
        <List.Item
          key={id}
          id={id}
          icon={{ source: Icon.Warning, tintColor: Color.Orange }}
          title="Checklist item no longer in its checklist"
          subtitle={row.checklist.title}
          actions={panel(
            <Action
              key="remove"
              title="Remove from Day"
              icon={Icon.MinusCircle}
              onAction={() => removeFromDay(row, rowDay)}
            />,
            openChecklist(row.checklist),
          )}
        />,
      );
    }
    const isMain = role === "main" || star;
    const block = row.links.map(([, l]) => l).find((l) => dayKeyOf(new Date(l.snapshot.start)) === rowDay);
    const label = block
      ? range(new Date(block.snapshot.start), new Date(block.snapshot.end))
      : row.carriedFrom
        ? `from ${shortDate(row.carriedFrom)}`
        : "";
    const accessories: List.Item.Accessory[] = [];
    if (row.estimate) accessories.push({ text: formatDuration(row.estimate), icon: Icon.Clock });
    accessories.push({
      text: {
        value: row.parentChain.length ? `${row.checklist.title} › ${row.parentChain.at(-1)}` : row.checklist.title,
        color: Color.SecondaryText,
      },
      tooltip: [row.checklist.title, ...row.parentChain].join(" › "),
    });
    const source: LinkSource = { kind: "task", taskId: row.taskId, checklistId: row.checklist.id, title: row.title };
    return item(
      id,
      <List.Item
        key={id}
        id={id}
        // Status glyphs, not checkboxes: list rows cannot be clicked; ↵ completes, ⌘↵ edits.
        icon={
          row.checked
            ? { source: Icon.CheckCircle, tintColor: Color.Green }
            : isMain
              ? { source: Icon.Star, tintColor: Color.Yellow }
              : { source: Icon.Circle, tintColor: Color.SecondaryText }
        }
        title={col(label, row.title || "(untitled)")}
        keywords={taskKeywords(row)}
        accessories={showDetail ? selectedTag(row, rowDay) : [...selectedTag(row, rowDay), ...accessories]}
        detail={
          <List.Item.Detail
            markdown={`## ${row.checked ? "☑" : "☐"} ${row.title || "(untitled)"}\n\n${md(row.details)}`}
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label title="Checklist" text={row.checklist.title} />
                {row.parentChain.length ? (
                  <List.Item.Detail.Metadata.Label title="Parent" text={row.parentChain.join(" › ")} />
                ) : null}
                <List.Item.Detail.Metadata.Label title="Status" text={row.checked ? "Done" : "Open"} />
                {row.links.map(([lid, l]) => (
                  <List.Item.Detail.Metadata.Label key={lid} title="Work block" text={blockTimes(l)} icon={Icon.Link} />
                ))}
              </List.Item.Detail.Metadata>
            }
          />
        }
        actions={
          selectedPanel(row, rowDay) ??
          panel(
            <ActionPanel.Section key="do">
              <Action
                title={row.checked ? "Mark Not Done" : "Complete Task"}
                icon={row.checked ? Icon.Circle : Icon.Checkmark}
                onAction={() => void toggleTask(row)}
              />
              <Action.Push
                title="Edit Task…"
                icon={Icon.Pencil}
                shortcut={{ modifiers: ["cmd"], key: "return" }}
                target={
                  <TaskForm
                    navigationTitle={`Edit ${row.title}`}
                    submitTitle="Save Item"
                    focus="details"
                    initial={{ title: row.title, details: row.details }}
                    onSubmit={async (v) => {
                      const r = saveWithOperation(
                        ctx.session.dir,
                        row.checklist,
                        (doc) => setTitle(doc, row.taskId, v.title) && setDetails(doc, row.taskId, v.details),
                      );
                      const ok = await reportSave(r, { title: "Item saved", message: v.title });
                      refresh();
                      return Boolean(ok);
                    }}
                  />
                }
              />
              <Action
                title="Delete Task"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={() => void deleteTask(row)}
              />
            </ActionPanel.Section>,
            <ActionPanel.Section key="plan">
              {role !== "next" ? (
                <ScheduleSubmenu ctx={ctx} source={source} notes={row.details} estimate={row.estimate} />
              ) : null}
              {moveAction(row, role, rowDay)}
              {openChecklist(row.checklist)}
              {role === "main" ? (
                <Action
                  title="Make Supporting Task"
                  icon={Icon.StarDisabled}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
                  onAction={() => makeSupporting(row, rowDay)}
                />
              ) : role === "support" ? (
                <Action
                  title="Make Main Task"
                  icon={Icon.Star}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
                  onAction={() => makeMain(row, rowDay)}
                />
              ) : null}
              <Action
                title={`Remove from ${dayName(rowDay)}`}
                icon={Icon.MinusCircle}
                shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                onAction={() => removeFromDay(row, rowDay)}
              />
              {selectToggle(row, rowDay)}
            </ActionPanel.Section>,
          )
        }
      />,
    );
  }

  const planItem = (row: PlanRow, rowDay: DayKey, role: Role, star = false) =>
    row.kind === "task" ? taskItem(row, rowDay, role, star) : reminderItem(row, rowDay, role, star);

  function failureItem(f: SourceFailure, i: number) {
    const t = sourceFailureText(f);
    const id = `failure:${f.source}:${i}`;
    return item(
      id,
      <List.Item
        key={id}
        id={id}
        icon={{ source: Icon.Warning, tintColor: Color.Red }}
        title={`${SOURCE_NAME[f.source]}: ${t.title}`}
        subtitle={t.description}
        actions={panel(
          <Action key="setup" title="Open Setup" icon={Icon.Gear} onAction={() => openCommand("my-day-setup")} />,
        )}
      />,
    );
  }

  function missingLinkItem([linkId, link]: [string, Link]) {
    const id = `linkmissing:${linkId}`;
    return item(
      id,
      <List.Item
        key={id}
        id={id}
        icon={{ source: Icon.Warning, tintColor: Color.Orange }}
        title={`Work block for ${link.source.title || "an item"} was deleted outside My Day`}
        subtitle={blockTimes(link)}
        actions={panel(
          <Action
            key="clear"
            title="Clear Link"
            icon={Icon.XMarkCircle}
            onAction={() => {
              delete state.links[linkId];
              if (save()) void showToast({ style: Toast.Style.Success, title: "Link cleared" });
              refresh();
            }}
          />,
          <ScheduleSubmenu key="schedule" ctx={ctx} source={link.source} notes={null} estimate={null} />,
        )}
      />,
    );
  }

  function headerItem() {
    const c = agenda ? dayCounts(agenda) : null;
    const eventsOk = agenda ? !agenda.failures.some((f) => f.source === "events") && !data?.staleSince : false;
    let status: string;
    if (!agenda) status = "Loading…";
    else if (!isToday) status = daySummary(agenda);
    else if (!eventsOk) status = "Calendar unavailable";
    else {
      const f = freeUntil(
        agenda.schedule.map((r) => r.event),
        now,
      );
      status =
        f.kind === "busy"
          ? `busy until ${formatTime(f.until)}`
          : f.kind === "free"
            ? `free until ${formatTime(f.until)} (${formatCountdown(f.minutes * 60_000)})`
            : "nothing else scheduled today";
    }
    const counts: List.Item.Accessory[] = [];
    if (selected.size) counts.push({ tag: { value: `${selected.size} selected`, color: Color.Blue } });
    if (c?.overdue) counts.push({ tag: { value: `${c.overdue} overdue`, color: Color.Red } });
    if (c?.items)
      counts.push({ text: { value: `${c.itemsDone} of ${c.items} tasks done`, color: Color.SecondaryText } });
    const title = rel === formatDay(day) ? longDate(day) : `${rel} · ${longDate(day)}`;
    const id = "header";
    return item(
      id,
      <List.Item
        key={id}
        id={id}
        icon={isToday ? Icon.Sun : Icon.Calendar}
        title={title}
        subtitle={status}
        accessories={showDetail ? [] : counts}
        keywords={["plan", "pick", "add", "new", "settings"]}
        actions={
          <ActionPanel>
            {pickAction("support", true)}
            {!state.main[day] ? pickAction("main") : null}
            {createActions}
            {settingsActions}
            {navActions}
          </ActionPanel>
        }
      />,
    );
  }

  function chooseMainItem() {
    const id = "choose-main";
    return item(
      id,
      <List.Item
        key={id}
        id={id}
        icon={{ source: Icon.Star, tintColor: Color.SecondaryText }}
        title={col("", `What's the needle-moving task${isToday ? " today" : ` for ${dayName(day)}`}?`)}
        accessories={[{ text: { value: "↵ choose", color: Color.SecondaryText } }]}
        keywords={["main", "needle"]}
        actions={panel(pickAction("main", true))}
      />,
    );
  }

  function newItems() {
    const when = dayName(day);
    const row = (id: string, icon: Icon, title: string, hint: string, primary: ReactNode) =>
      item(
        id,
        <List.Item
          key={id}
          id={id}
          icon={{ source: icon, tintColor: Color.Blue }}
          title={title}
          keywords={[typed]}
          accessories={[{ text: { value: hint, color: Color.SecondaryText } }]}
          actions={
            <ActionPanel>
              {primary}
              {createActions}
              {navActions}
            </ActionPanel>
          }
        />,
      );
    return [
      row(
        "new:today",
        Icon.PlusCircle,
        `Add “${typed}” to ${when}`,
        `supporting task · ${inboxName}`,
        <Action key="a" title={`Add to ${when}`} icon={Icon.PlusCircle} onAction={() => void addTask(false)} />,
      ),
      row(
        "new:main",
        Icon.Star,
        `Make “${typed}” the main task`,
        `main task · ${inboxName}`,
        <Action key="m" title="Add as Main Task" icon={Icon.Star} onAction={() => void addTask(true)} />,
      ),
      row(
        "new:reminder",
        Icon.Bell,
        `New reminder “${typed}”…`,
        "Reminders",
        <Action.Push
          key="r"
          title="New Reminder…"
          icon={Icon.Bell}
          target={<ReminderForm ctx={ctx} defaultTitle={typed} onDone={afterCreate} />}
        />,
      ),
      row(
        "new:event",
        Icon.Calendar,
        `New event “${typed}”…`,
        "Calendar",
        <Action.Push
          key="e"
          title="New Event…"
          icon={Icon.Calendar}
          target={<EventForm ctx={ctx} defaultTitle={typed} onDone={afterCreate} />}
        />,
      ),
    ];
  }

  // ---- Assemble ----------------------------------------------------------------------------------------------
  if (typed) section("new", "New", undefined, newItems());
  section("header", undefined, undefined, [headerItem()]);
  if (agenda) {
    section("problems", "Problems", undefined, agenda.failures.map(failureItem));
    // Calendar (events, work blocks) then Reminders (overdue, due, picked from the backlog); the first of the two
    // carries the date ("Monday, Oct 5") like My Schedule. Main task and Supporting Tasks hold checklist tasks only.
    const calendarRows = [
      ...agenda.allDay.map((r) => eventItem(r, day, "must")),
      ...(data?.missingLinks ?? []).map(missingLinkItem),
      ...agenda.schedule.map((r) => eventItem(r, day, "must")),
    ].filter(Boolean);
    section("calendar", "Calendar", longDate(day), calendarRows);
    section("reminders", "Reminders", calendarRows.length ? undefined : longDate(day), [
      ...agenda.overdue.map((r) => reminderItem(r, day, "must")),
      ...agenda.dueToday.map((r) => reminderItem(r, day, "must")),
      ...agenda.picked.map((r) => reminderItem(r, day, "must")),
    ]);
    const showMainPrompt = !agenda.main && day >= today;
    section("main", "Main task", undefined, [
      agenda.main ? planItem(agenda.main, day, "main") : showMainPrompt ? chooseMainItem() : null,
    ]);
    section(
      "support",
      "Supporting Tasks",
      words.length ? undefined : "↵ done · ⌘⇧→ push · ⌘⇧M main",
      agenda.supporting.map((r) => planItem(r, day, "support")),
    );
  }
  if (nextAgenda)
    section(
      "tomorrow",
      relNext === formatDay(nextDay) ? longDate(nextDay) : relNext,
      relNext === formatDay(nextDay) ? undefined : longDate(nextDay),
      [
        ...nextAgenda.allDay.map((r) => eventItem(r, nextDay, "next")),
        ...nextAgenda.schedule.map((r) => eventItem(r, nextDay, "next")),
        ...nextAgenda.dueToday.map((r) => reminderItem(r, nextDay, "next")),
        ...nextAgenda.picked.map((r) => reminderItem(r, nextDay, "next")),
        ...(nextAgenda.main ? [planItem(nextAgenda.main, nextDay, "next", true)] : []),
        ...nextAgenda.supporting.map((r) => planItem(r, nextDay, "next")),
      ],
    );

  // Coming up (owner 2026-10-05): the next month's events and holidays, grouped like My Schedule, under the plan.
  if (showUpcoming && data?.upcoming.length) {
    const groups = new Map<string, ReactNode[]>();
    for (const u of data.upcoming) {
      const g = upcomingGroup(u.day, day);
      groups.set(g, [...(groups.get(g) ?? []), eventItem(u.row, u.day, "upcoming")]);
    }
    for (const [g, rows] of groups) section(`up:${g}`, g, undefined, rows);
  }

  return (
    <List
      isLoading={ctl.isLoading}
      isShowingDetail={showDetail}
      navigationTitle={navigationTitle}
      searchBarPlaceholder="Search, or type something new and press ↵…"
      searchText={search}
      onSearchTextChange={(t) => {
        // Typing selects "Add to today" so ↵ adds it; ↓ still reaches the matching rows below.
        if (t.trim() !== search.trim()) setSelectedId(t.trim() ? "new:today" : undefined);
        setSearch(t);
      }}
      filtering={false}
      selectedItemId={
        typed && (!selectedId || !ids.includes(selectedId))
          ? "new:today"
          : selectedId && ids.includes(selectedId)
            ? selectedId
            : undefined
      }
      onSelectionChange={(id) => id && setSelectedId(id)}
    >
      {sections}
    </List>
  );
}
