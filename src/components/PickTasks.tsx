// Pick tasks (owner feedback 2026-10-05): one list of every open checklist item (pinned checklists first) and every
// reminder that is not already due, to build a day. ↵ puts an item on the day as a supporting task (again takes it
// off), ⌘↵ makes it the day's main task. Picking a reminder never changes it in Reminders; ⌘D is the explicit
// due-date action. Typing a name and ⌘N adds a new item to the Backlog checklist and the day, without a form.
import { Action, ActionPanel, Color, Icon, Keyboard, List, showToast, Toast, useNavigation } from "@raycast/api";
import { useState } from "react";
import type { PlanRow, ReminderRow } from "../lib/agenda.ts";
import { reminderKeywords } from "../lib/agenda-rows.ts";
import { formatDay, relativeDay, todayKey, type DayKey } from "../lib/dates.ts";
import { detailsText } from "../lib/markdown.ts";
import {
  assignDay,
  clearMain,
  pickReminder,
  sameFocus,
  setMain,
  unassignDay,
  unpickReminder,
  type FocusRef,
} from "../lib/state.ts";
import { listChecklists, saveWithOperation, type ChecklistFile } from "../lib/store.ts";
import { shortDate } from "../lib/timeline.ts";
import { addTopLevel, flatten } from "../lib/tree.ts";
import { ensureNormalized, reportSave, touchRecent } from "../lib/use-checklists.ts";
import type { AgendaCtx } from "./agenda-shared.tsx";
import { DueDateForm } from "./DueDateForm.tsx";
import { QuickTaskForm } from "./QuickTaskForm.tsx";
import { ScheduleWorkBlock } from "./ScheduleBlockForm.tsx";

/** "today", "tomorrow" or "Mon 5 Oct" for toasts and action titles. */
export function dayName(day: DayKey): string {
  const rel = relativeDay(day, todayKey());
  return rel === formatDay(day) ? formatDay(day) : rel.toLowerCase();
}

/** "Today", "Tomorrow" or "Mon 5 Oct" for tags. */
function dayTag(day: DayKey): string {
  const rel = relativeDay(day, todayKey());
  return rel === formatDay(day) ? shortDate(day) : rel;
}

/** The checklist new items go to: "Backlog" when it exists, else the first pinned, else the first. */
export function inboxChecklist(checklists: ChecklistFile[]): ChecklistFile | undefined {
  return checklists.find((c) => c.title.trim().toLowerCase() === "backlog") ?? checklists[0];
}

function readChecklists(ctx: AgendaCtx): ChecklistFile[] {
  try {
    return listChecklists(ctx.session.dir).checklists;
  } catch {
    return ctx.data?.checklists ?? [];
  }
}

/**
 * Adds a new item to the Backlog checklist (see inboxChecklist) and puts it on `day`, as the main task when `asMain`.
 * No form: used by "type a name and press ⌘N/↵" in My Day and in Pick Tasks.
 */
export async function addNewTask(ctx: AgendaCtx, title: string, day: DayKey, asMain: boolean): Promise<boolean> {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return false;
  const target = inboxChecklist(
    readChecklists(ctx)
      .filter((c) => !c.archived && !c.readOnlyReason)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order),
  );
  if (!target) {
    await showToast({ style: Toast.Style.Failure, title: "Create a checklist first (Checklists command)" });
    return false;
  }
  const ready = await ensureNormalized(ctx.session, target);
  if (!ready) return false;
  const created: { id: string | null } = { id: null };
  const r = saveWithOperation(ctx.session.dir, ready, (doc) => {
    created.id = addTopLevel(doc, clean);
    return true;
  });
  const saved = await reportSave(r);
  if (!saved || !created.id) return false;
  touchRecent(ctx.session, saved.id);
  const state = ctx.session.state;
  if (asMain) setMain(state, day, { kind: "task", taskId: created.id, checklistId: saved.id });
  else assignDay(state, created.id, saved.id, day);
  if (!ctx.session.saveState()) return false;
  await showToast({
    style: Toast.Style.Success,
    title: `Added to ${saved.title} and ${dayName(day)}${asMain ? " as the main task" : ""}`,
    message: clean,
  });
  void ctx.refresh();
  return true;
}

export function PickTasks(props: { ctx: AgendaCtx; mode?: "support" | "main" }) {
  const { ctx } = props;
  const mainMode = props.mode === "main";
  const { push, pop } = useNavigation();
  const day: DayKey = ctx.day;
  const name = dayName(day);
  const [search, setSearch] = useState("");
  const [, bump] = useState(0);
  const refresh = () => bump((n) => n + 1);
  const state = ctx.session.state;
  // Read here rather than from the agenda snapshot, so an item created in this view shows up at once.
  const [files, setFiles] = useState<ChecklistFile[]>(() => readChecklists(ctx));
  const checklists = files
    .filter((c) => !c.archived && !c.readOnlyReason)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || a.title.localeCompare(b.title));

  // Reminders that are not due today or overdue (those are already on the day as "has to happen").
  const agenda = ctx.data?.agenda;
  const planned: PlanRow[] = [...(agenda?.supporting ?? []), ...(agenda?.main ? [agenda.main] : [])];
  const reminderRows: ReminderRow[] = [
    ...(agenda?.otherReminders ?? []),
    ...planned.filter((r): r is ReminderRow => r.kind === "reminder" && !r.overdue && r.reminder.dueDay !== day),
  ];
  const seen = new Set<string>();
  const reminders = reminderRows.filter((r) => !seen.has(r.id) && seen.add(r.id));

  const save = () => ctx.session.saveState();
  const toast = (title: string, message: string) => showToast({ style: Toast.Style.Success, title, message });

  async function taskRef(file: ChecklistFile, taskId: string): Promise<FocusRef | null> {
    const ready = await ensureNormalized(ctx.session, file);
    return ready ? { kind: "task", taskId, checklistId: ready.id } : null;
  }

  async function toggle(ref: FocusRef, title: string, reminder?: ReminderRow) {
    const on = ref.kind === "task" ? state.assignments[ref.taskId]?.day === day : state.picks[ref.itemId]?.day === day;
    if (on) {
      clearMain(state, day, ref);
      if (ref.kind === "task") unassignDay(state, ref.taskId);
      else unpickReminder(state, ref.itemId);
      if (save()) await toast(`Removed from ${name}`, title);
    } else {
      if (ref.kind === "task") assignDay(state, ref.taskId, ref.checklistId, day);
      else pickReminder(state, ref.itemId, day, { externalId: reminder?.reminder.externalId ?? null, title });
      if (save()) await toast(`Added to ${name}`, title);
    }
    refresh();
  }

  async function makeMain(ref: FocusRef, title: string, reminder?: ReminderRow) {
    const previous = state.main[day];
    setMain(state, day, ref, reminder ? { externalId: reminder.reminder.externalId, title } : undefined);
    if (!save()) return;
    await toast(previous && !sameFocus(previous, ref) ? `New main task for ${name}` : `Main task for ${name}`, title);
    if (mainMode) pop();
    else refresh();
  }

  async function quickCreate(title: string) {
    const ok = await addNewTask(ctx, title, day, mainMode);
    if (!ok) return;
    setFiles(readChecklists(ctx));
    if (mainMode) pop();
  }

  const createActions = (
    <ActionPanel.Section title="New">
      <Action
        title={search.trim() ? `Add “${search.trim()}”` : "Add New Item (Type Its Name First)"}
        icon={Icon.Plus}
        shortcut={Keyboard.Shortcut.Common.New}
        onAction={() => void quickCreate(search)}
      />
      <Action.Push
        title="New Item in a Checklist…"
        icon={Icon.NewDocument}
        shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
        target={<QuickTaskForm ctx={ctx} defaultTitle={search.trim()} onDone={refresh} />}
      />
    </ActionPanel.Section>
  );

  /** Status tag: Main, Today, Tomorrow, Mon 5 Oct. */
  function statusTag(ref: FocusRef, assigned: DayKey | undefined): List.Item.Accessory[] {
    if (sameFocus(state.main[day], ref)) return [{ tag: { value: "Main", color: Color.Yellow } }];
    if (assigned)
      return [{ tag: { value: dayTag(assigned), color: assigned === day ? Color.Blue : Color.SecondaryText } }];
    return [];
  }

  return (
    <List
      navigationTitle={mainMode ? `Main task for ${formatDay(day)}` : `Pick tasks for ${formatDay(day)}`}
      searchBarPlaceholder={
        mainMode ? "Find the main task, or type a new one and press ⌘N…" : "Find tasks, or type a new one and press ⌘N…"
      }
      onSearchTextChange={setSearch}
      filtering={{ keepSectionOrder: true }}
    >
      <List.EmptyView
        icon={Icon.CheckList}
        title={search.trim() ? `⌘N adds “${search.trim()}”` : "Nothing open"}
        description={`New items go to ${inboxChecklist(checklists)?.title ?? "your first checklist"} and onto ${name}.`}
        actions={<ActionPanel>{createActions}</ActionPanel>}
      />
      {checklists.map((file) => {
        const rows = flatten(file.doc, new Set()).filter((r) => !r.node.checked);
        if (!rows.length) return null;
        return (
          <List.Section
            key={file.id}
            title={file.title}
            subtitle={`${file.pinned ? "pinned · " : ""}${rows.length} open`}
          >
            {rows.map((row) => {
              const n = row.node;
              const ref: FocusRef = { kind: "task", taskId: n.id, checklistId: file.id };
              const assigned = state.assignments[n.id]?.day;
              const onDay = assigned === day;
              const isMain = sameFocus(state.main[day], ref);
              const add = (
                <Action
                  key="toggle"
                  title={onDay ? `Remove from ${name}` : `Add to ${name}`}
                  icon={onDay ? Icon.MinusCircle : Icon.PlusCircle}
                  onAction={async () => {
                    const r = await taskRef(file, n.id);
                    if (r) await toggle(r, n.title);
                  }}
                />
              );
              const main = (
                <Action
                  key="main"
                  title={isMain ? "Already the Main Task" : `Make Main Task for ${name}`}
                  icon={Icon.Star}
                  onAction={async () => {
                    const r = await taskRef(file, n.id);
                    if (r) await makeMain(r, n.title);
                  }}
                />
              );
              return (
                <List.Item
                  key={n.id}
                  id={n.id}
                  icon={
                    isMain
                      ? { source: Icon.Star, tintColor: Color.Yellow }
                      : { source: Icon.Circle, tintColor: Color.SecondaryText }
                  }
                  title={n.title || "(untitled)"}
                  keywords={[file.title, ...row.parentChain]}
                  accessories={[
                    ...statusTag(ref, assigned),
                    ...(row.parentChain.length
                      ? [
                          {
                            text: { value: row.parentChain.at(-1)!, color: Color.SecondaryText },
                            tooltip: row.parentChain.join(" › "),
                          },
                        ]
                      : []),
                  ]}
                  actions={
                    <ActionPanel title={n.title}>
                      {mainMode ? [main, add] : [add, main]}
                      <Action
                        title="Schedule Work Block…"
                        icon={Icon.Clock}
                        // eslint-disable-next-line @raycast/prefer-common-shortcut -- ⌘S is Schedule Work Block throughout My Day
                        shortcut={{ modifiers: ["cmd"], key: "s" }}
                        onAction={async () => {
                          const ready = await ensureNormalized(ctx.session, file);
                          if (!ready) return;
                          push(
                            <ScheduleWorkBlock
                              ctx={ctx}
                              source={{ kind: "task", taskId: n.id, checklistId: ready.id, title: n.title }}
                              defaultNotes={detailsText(n)}
                            />,
                            refresh,
                          );
                        }}
                      />
                      {createActions}
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}
      {/* Reminders are added to the day's Reminders section; only checklist tasks can be the main task. */}
      {(mainMode
        ? []
        : [
            { title: "Reminders without a date", rows: reminders.filter((r) => !r.reminder.dueDay) },
            { title: "Reminders due later", rows: reminders.filter((r) => r.reminder.dueDay) },
          ]
      ).map((sec) =>
        sec.rows.length ? (
          <List.Section key={sec.title} title={sec.title} subtitle={`${sec.rows.length}`}>
            {sec.rows.map((row) => {
              const r = row.reminder;
              const ref: FocusRef = { kind: "reminder", itemId: r.itemId };
              const picked = state.picks[r.itemId]?.day;
              const onDay = picked === day;
              const isMain = sameFocus(state.main[day], ref);
              const add = (
                <Action
                  key="toggle"
                  title={onDay ? `Remove from ${name}` : `Add to ${name}`}
                  icon={onDay ? Icon.MinusCircle : Icon.PlusCircle}
                  onAction={() => void toggle(ref, r.title, row)}
                />
              );
              return (
                <List.Item
                  key={row.id}
                  id={row.id}
                  icon={
                    isMain
                      ? { source: Icon.Star, tintColor: Color.Yellow }
                      : { source: Icon.Bell, tintColor: row.list?.color ?? undefined }
                  }
                  title={r.title || "(no title)"}
                  keywords={reminderKeywords(row)}
                  accessories={[
                    ...statusTag(ref, picked),
                    ...(r.dueDay ? [{ text: `due ${shortDate(r.dueDay)}` }] : []),
                    { text: { value: row.list?.title ?? "Reminders", color: Color.SecondaryText } },
                  ]}
                  actions={
                    <ActionPanel title={r.title}>
                      {add}
                      <Action.Push
                        title="Schedule Work Block…"
                        icon={Icon.Clock}
                        // eslint-disable-next-line @raycast/prefer-common-shortcut -- ⌘S is Schedule Work Block throughout My Day
                        shortcut={{ modifiers: ["cmd"], key: "s" }}
                        target={
                          <ScheduleWorkBlock
                            ctx={ctx}
                            source={{ kind: "reminder", itemId: r.itemId, externalId: r.externalId, title: r.title }}
                            defaultNotes={r.notes ?? ""}
                          />
                        }
                      />
                      <Action.Push
                        title="Change Due Date…"
                        icon={Icon.Calendar}
                        shortcut={{ modifiers: ["cmd"], key: "d" }}
                        target={
                          <DueDateForm ctx={ctx} reminder={r} onChanged={() => void ctx.refresh().then(refresh)} />
                        }
                      />
                      {createActions}
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        ) : null,
      )}
    </List>
  );
}
