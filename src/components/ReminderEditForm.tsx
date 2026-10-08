// Edit Reminder: title, notes, link, list and due date of one existing reminder (owner 2026-10-05: a separate
// Change Due Date item was redundant). The due date is written only when it was actually changed.
import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from "@raycast/api";
import { useRef, useState } from "react";
import * as ek from "../eventkit.ts";
import { startOfLocalDay } from "../lib/dates.ts";
import type { ReminderInfo } from "../lib/eventkit-protocol.ts";
import { isSafeUrl, reminderDueFields } from "../lib/forms.ts";
import { failureToast, writable, type AgendaCtx } from "./agenda-shared.tsx";
import { defaultStartOn } from "./EventForm.tsx";
import { DueFields, type DueMode } from "./ReminderForm.tsx";

interface Values {
  title: string;
  notes: string;
  url: string;
  listId: string;
  due?: Date | null;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function ReminderEditForm(props: { ctx: AgendaCtx; reminder: ReminderInfo; focus?: "title" | "notes" }) {
  const { ctx, reminder: r } = props;
  const { pop } = useNavigation();
  const lists = writable(ctx.data?.lists ?? []);
  const current = (ctx.data?.lists ?? []).find((l) => l.id === r.listId);
  const [errors, setErrors] = useState<{ title?: string; url?: string }>({});
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [mode, setMode] = useState<DueMode>(r.dueDay ? (r.dueHasTime ? "datetime" : "date") : "none");
  const [dueError, setDueError] = useState<string | undefined>();
  const baseDay = r.dueDay ?? ctx.day;
  const oldTime = r.dueHasTime && r.dueDateTime ? hhmm(new Date(r.dueDateTime)) : null;

  async function submit(v: Values) {
    if (inFlight.current) return;
    const title = v.title.replace(/\s+/g, " ").trim();
    const errs: typeof errors = {};
    if (!title) errs.title = "Title is required";
    if (v.url.trim() && !isSafeUrl(v.url)) errs.url = "Only http(s), mailto and obsidian links";
    if (Object.keys(errs).length) return setErrors(errs);
    if (mode !== "none" && !v.due) return setDueError("Choose a date");
    const { dueDay, dueTime } = reminderDueFields({ title, listId: v.listId, dueMode: mode, due: v.due ?? null });
    const dueChanged = dueDay !== (r.dueDay ?? null) || dueTime !== oldTime;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await ek.updateReminder({
        itemId: r.itemId,
        externalId: r.externalId,
        expectedLastModified: r.lastModified,
        title,
        notes: v.notes,
        url: v.url.trim(),
        ...(v.listId && v.listId !== r.listId ? { listId: v.listId } : {}),
      });
      if (!res.ok) {
        if (res.failure.kind === "helper" && res.failure.code === "conflict") {
          await showToast({
            style: Toast.Style.Failure,
            title: "Changed in Reminders — nothing saved",
            message: "The reminder was edited elsewhere. Press ⌘R in My Day and edit again.",
          });
        } else await failureToast("Reminder not saved", res.failure);
        return;
      }
      if (dueChanged) {
        const d = await ek.setReminderDue(
          { itemId: r.itemId, externalId: r.externalId, expectedLastModified: res.value.lastModified },
          dueDay,
          dueTime,
        );
        if (!d.ok) {
          await failureToast("Saved, but the due date was not changed", d.failure);
          pop();
          void ctx.refresh();
          return;
        }
      }
      await showToast({ style: Toast.Style.Success, title: "Reminder saved", message: title });
      pop();
      void ctx.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const readOnly = current ? !current.allowsModifications : false;
  return (
    <Form
      navigationTitle="Edit Reminder"
      isLoading={busy}
      actions={
        readOnly ? undefined : (
          <ActionPanel>
            <Action.SubmitForm title="Save Reminder" icon={Icon.Checkmark} onSubmit={submit} />
          </ActionPanel>
        )
      }
    >
      {readOnly ? <Form.Description title="Read-only" text={`${current?.title} does not allow changes.`} /> : null}
      <Form.TextField
        id="title"
        title="Title"
        defaultValue={r.title}
        autoFocus={props.focus !== "notes"}
        error={errors.title}
        onChange={() => errors.title && setErrors({ ...errors, title: undefined })}
      />
      <Form.TextArea id="notes" title="Notes" defaultValue={r.notes ?? ""} autoFocus={props.focus === "notes"} />
      <Form.TextField
        id="url"
        title="URL"
        placeholder="https://…"
        defaultValue={r.url ?? ""}
        error={errors.url}
        onChange={() => errors.url && setErrors({ ...errors, url: undefined })}
      />
      <Form.Dropdown id="listId" title="List" defaultValue={r.listId}>
        {current && !lists.some((l) => l.id === current.id) ? (
          <Form.Dropdown.Item value={current.id} title={`${current.title} (current)`} />
        ) : null}
        {lists.map((l) => (
          <Form.Dropdown.Item key={l.id} value={l.id} title={l.title} />
        ))}
      </Form.Dropdown>
      <DueFields
        mode={mode}
        onModeChange={(m) => {
          setMode(m);
          setDueError(undefined);
        }}
        defaultDate={startOfLocalDay(baseDay)}
        defaultDateTime={r.dueHasTime && r.dueDateTime ? new Date(r.dueDateTime) : defaultStartOn(baseDay)}
        error={dueError}
        onDateChange={() => setDueError(undefined)}
      />
    </Form>
  );
}
