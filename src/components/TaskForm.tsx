import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useState } from "react";

export interface TaskFormValues {
  title: string;
  details: string;
  /** null = top level. Only meaningful when parent options were offered. */
  parentId: string | null;
}

export interface ParentOption {
  id: string;
  label: string;
}

const TOP = "__top__";

export function TaskForm(props: {
  navigationTitle: string;
  submitTitle: string;
  /** Which field gets keyboard focus when the form opens. */
  focus?: "title" | "details";
  initial?: Partial<TaskFormValues>;
  /** Offered only when editing; must already exclude the task itself and its descendants. */
  parentOptions?: ParentOption[];
  /** Resolve true to close the form. */
  onSubmit: (values: TaskFormValues) => Promise<boolean>;
}) {
  const { pop } = useNavigation();
  const [titleError, setTitleError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(values: { title: string; details: string; parent?: string }) {
    if (busy) return;
    const title = values.title.replace(/\s+/g, " ").trim();
    if (!title) {
      setTitleError("A short title is required");
      return;
    }
    setBusy(true);
    try {
      const parentId = values.parent === undefined || values.parent === TOP ? null : values.parent;
      if (await props.onSubmit({ title, details: values.details, parentId })) pop();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      navigationTitle={props.navigationTitle}
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={props.submitTitle} icon={Icon.Checkmark} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Title"
        placeholder="Short title"
        defaultValue={props.initial?.title ?? ""}
        autoFocus={props.focus !== "details"}
        error={titleError}
        onChange={() => titleError && setTitleError(undefined)}
      />
      <Form.TextArea
        id="details"
        title="Details"
        placeholder="Optional notes: paragraphs, pasted text, links, Markdown"
        enableMarkdown
        autoFocus={props.focus === "details"}
        defaultValue={props.initial?.details ?? ""}
      />
      {props.parentOptions ? (
        <Form.Dropdown id="parent" title="Parent" defaultValue={props.initial?.parentId ?? TOP}>
          <Form.Dropdown.Item value={TOP} title="(Top level)" />
          {props.parentOptions.map((o) => (
            <Form.Dropdown.Item key={o.id} value={o.id} title={o.label} />
          ))}
        </Form.Dropdown>
      ) : null}
    </Form>
  );
}
