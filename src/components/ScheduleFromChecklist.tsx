// Bridges the Checklists command to Schedule Work Block: the agenda controller (calendar reads, journal,
// overlap checks) is created lazily, only when the user asks to schedule, so opening a checklist never
// touches the calendar helper.
import { List } from "@raycast/api";
import { useEffect, type ReactNode } from "react";
import { detailsText, type TaskNode } from "../lib/markdown.ts";
import type { ChecklistFile } from "../lib/store.ts";
import { useAgenda } from "../lib/use-agenda.ts";
import type { ChecklistSession } from "../lib/use-checklists.ts";
import { SlotPicker } from "./QuickSchedule.tsx";

export function ScheduleFromChecklist(props: { task: TaskNode; file: ChecklistFile }) {
  const ctl = useAgenda();
  if (!ctl.data) return <List isLoading navigationTitle={`Schedule: ${props.task.title}`} />;
  return (
    <SlotPicker
      ctx={ctl}
      source={{ kind: "task", taskId: props.task.id, checklistId: props.file.id, title: props.task.title }}
      notes={detailsText(props.task)}
      estimate={ctl.session.state.estimates[props.task.id] ?? null}
    />
  );
}

/** Re-reads state.json into a session after another controller wrote to it (links, journal). */
export function reloadSessionState(session: ChecklistSession): void {
  const fresh = session.store.load().state;
  for (const key of Object.keys(session.state) as (keyof typeof session.state)[]) delete session.state[key];
  Object.assign(session.state, fresh);
}

/** Reloads the parent session's state when the pushed scheduling view unmounts (pop). */
export function ReloadSessionAfterPop(props: { session: ChecklistSession; children: ReactNode }) {
  useEffect(() => () => reloadSessionState(props.session), [props.session]);
  return <>{props.children}</>;
}
