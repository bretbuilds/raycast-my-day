// Add Reminder (SPEC §4.2, A-B-2): optional due as none / date only / date and time. Journaled like events.
import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from "@raycast/api";
import { useRef, useState } from "react";
import * as ek from "../eventkit.ts";
import { startOfLocalDay } from "../lib/dates.ts";
import { endWrite } from "../lib/journal.ts";
import { isSafeUrl, reminderDueFields, validateReminder, type FieldErrors, type ReminderDraft } from "../lib/forms.ts";
import { defaultSource, failureToast, journaledCreate, writable, type AgendaCtx } from "./agenda-shared.tsx";
import { defaultStartOn } from "./EventForm.tsx";

export type DueMode = ReminderDraft["dueMode"];

/** Mode dropdown + date picker whose type follows the mode. Shared with Change Due Date. */
export function DueFields(props: {
  mode: DueMode;
  onModeChange: (m: DueMode) => void;
  defaultDate: Date;
  defaultDateTime: Date;
  error?: string;
  onDateChange?: () => void;
}) {
  return (
    <>
      <Form.Dropdown id="dueMode" title="Due" value={props.mode} onChange={(v) => props.onModeChange(v as DueMode)}>
        <Form.Dropdown.Item value="none" title="None" />
        <Form.Dropdown.Item value="date" title="Date only" />
        <Form.Dropdown.Item value="datetime" title="Date and time" />
      </Form.Dropdown>
      {props.mode === "date" ? (
        <Form.DatePicker
          key="date"
          id="due"
          title="Due Date"
          type={Form.DatePicker.Type.Date}
          defaultValue={props.defaultDate}
          error={props.error}
          onChange={props.onDateChange}
        />
      ) : null}
      {props.mode === "datetime" ? (
        <Form.DatePicker
          key="datetime"
          id="due"
          title="Due Date and Time"
          type={Form.DatePicker.Type.DateTime}
          defaultValue={props.defaultDateTime}
          error={props.error}
          onChange={props.onDateChange}
        />
      ) : null}
    </>
  );
}

interface Values {
  title: string;
  listId: string;
  due?: Date | null;
  notes: string;
  url: string;
}

export function ReminderForm({
  ctx,
  defaultTitle,
  onDone,
}: {
  ctx: AgendaCtx;
  defaultTitle?: string;
  onDone?: () => void;
}) {
  const { pop } = useNavigation();
  const lists = writable(ctx.data?.lists ?? []);
  const [mode, setMode] = useState<DueMode>("date");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const clear = (k: keyof FieldErrors) => () => errors[k] && setErrors({ ...errors, [k]: undefined });

  async function submit(v: Values) {
    if (inFlight.current) return;
    const draft: ReminderDraft = { title: v.title, listId: v.listId, dueMode: mode, due: v.due ?? null };
    const errs = validateReminder(draft, lists);
    if (v.url.trim() && !isSafeUrl(v.url)) errs.url = "Only http(s), mailto and obsidian links";
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const title = v.title.trim();
      const { dueDay, dueTime } = reminderDueFields(draft);
      const toast = await showToast({ style: Toast.Style.Animated, title: "Adding reminder…" });
      const { result } = await journaledCreate(
        ctx,
        { kind: "create-reminder", startedAt: new Date().toISOString(), probe: { title, listId: v.listId } },
        () =>
          ek.createReminder({
            listId: v.listId,
            title,
            notes: v.notes.trim() ? v.notes : undefined,
            url: v.url.trim() || undefined,
            dueDay,
            dueTime,
          }),
        (_r, token) => endWrite(ctx.session.state, token),
      );
      if (!result) {
        toast.hide();
        return;
      }
      if (!result.ok) {
        toast.hide();
        await failureToast("Reminder not added", result.failure);
        return;
      }
      ctx.session.state.sources.defaultListId = v.listId;
      ctx.session.saveState();
      toast.style = Toast.Style.Success;
      toast.title = "Reminder added";
      toast.message = title;
      pop();
      onDone?.();
      void ctx.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!ctx.data?.listsKnown || lists.length === 0) {
    return (
      <Form navigationTitle="Add Reminder">
        <Form.Description
          title="No writable list"
          text={
            ctx.data?.listsKnown
              ? "Every reminder list My Day can see is read-only."
              : "Reminders is not available right now. Open My Day Setup to check access, then refresh."
          }
        />
      </Form>
    );
  }

  return (
    <Form
      navigationTitle="Add Reminder"
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Reminder" icon={Icon.CheckCircle} onSubmit={submit} />
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
        id="listId"
        title="List"
        defaultValue={defaultSource(lists, ctx.session.state.sources.defaultListId)}
        error={errors.listId}
        onChange={clear("listId")}
      >
        {lists.map((c) => (
          <Form.Dropdown.Item key={c.id} value={c.id} title={`${c.title} (${c.source})`} />
        ))}
      </Form.Dropdown>
      <DueFields
        mode={mode}
        onModeChange={(m) => {
          setMode(m);
          clear("dueDate")();
        }}
        defaultDate={startOfLocalDay(ctx.day)}
        defaultDateTime={defaultStartOn(ctx.day)}
        error={errors.dueDate}
        onDateChange={clear("dueDate")}
      />
      <Form.Separator />
      <Form.TextArea id="notes" title="Notes" enableMarkdown />
      <Form.TextField id="url" title="URL" placeholder="https://…" error={errors.url} onChange={clear("url")} />
    </Form>
  );
}
