// Change Due Date (SPEC §4.2, A-B-6): writes only the reminder's due components. Deliberately separate from
// Schedule Work Block, which never touches a due date.
import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from "@raycast/api";
import { useRef, useState } from "react";
import * as ek from "../eventkit.ts";
import { formatDay, startOfLocalDay } from "../lib/dates.ts";
import type { ReminderInfo } from "../lib/eventkit-protocol.ts";
import { reminderDueFields } from "../lib/forms.ts";
import { failureToast, type AgendaCtx } from "./agenda-shared.tsx";
import { defaultStartOn } from "./EventForm.tsx";
import { DueFields, type DueMode } from "./ReminderForm.tsx";

export function DueDateForm(props: {
  ctx: AgendaCtx;
  reminder: ReminderInfo;
  /** Called with the updated reminder (e.g. so a picker list can update its row). */
  onChanged?: (updated: ReminderInfo) => void;
}) {
  const { ctx, reminder } = props;
  const { pop } = useNavigation();
  const initialMode: DueMode = reminder.dueDay ? (reminder.dueHasTime ? "datetime" : "date") : "none";
  const [mode, setMode] = useState<DueMode>(initialMode);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const baseDay = reminder.dueDay ?? ctx.day;
  const defaultDateTime =
    reminder.dueHasTime && reminder.dueDateTime ? new Date(reminder.dueDateTime) : defaultStartOn(baseDay);

  async function submit(v: { due?: Date | null }) {
    if (inFlight.current) return;
    const draft = { title: reminder.title, listId: reminder.listId, dueMode: mode, due: v.due ?? null };
    if (mode !== "none" && !draft.due) {
      setError("Choose a date");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const { dueDay, dueTime } = reminderDueFields(draft);
      const r = await ek.setReminderDue(
        { itemId: reminder.itemId, externalId: reminder.externalId, expectedLastModified: reminder.lastModified },
        dueDay,
        dueTime,
      );
      if (!r.ok) {
        if (r.failure.kind === "helper" && r.failure.code === "conflict") {
          await showToast({
            style: Toast.Style.Failure,
            title: "Changed in Reminders — reload",
            message: "The reminder was edited outside My Day. Nothing was changed.",
            primaryAction: { title: "Reload", onAction: () => void ctx.refresh() },
          });
          pop();
          void ctx.refresh();
          return;
        }
        await failureToast("Due date not changed", r.failure);
        return;
      }
      await showToast({
        style: Toast.Style.Success,
        title: dueDay ? `Due ${formatDay(dueDay)}${dueTime ? ` ${dueTime}` : ""}` : "Due date removed",
        message: reminder.title,
      });
      props.onChanged?.(r.value);
      pop();
      void ctx.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Form
      navigationTitle="Change Due Date"
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Change Due Date" icon={Icon.Calendar} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Reminder"
        text={`${reminder.title}\nChanges only this reminder's due date. To block time in Calendar, use Schedule Work Block instead.`}
      />
      <DueFields
        mode={mode}
        onModeChange={(m) => {
          setMode(m);
          setError(undefined);
        }}
        defaultDate={startOfLocalDay(baseDay)}
        defaultDateTime={defaultDateTime}
        error={error}
        onDateChange={() => setError(undefined)}
      />
    </Form>
  );
}
