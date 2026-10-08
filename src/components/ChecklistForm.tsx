import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useState } from "react";

export interface ChecklistFormValues {
  title: string;
  body: string;
  alsoHeading: boolean;
}

/** New Checklist (title + optional initial Markdown) or Rename (title, optionally also the document's H1). */
export function ChecklistForm(props: {
  mode: "new" | "rename";
  initialTitle?: string;
  /** Rename only: the document has an H1, which is what the list displays. */
  hasHeading?: boolean;
  /** Resolve true to close the form. */
  onSubmit: (values: ChecklistFormValues) => Promise<boolean>;
}) {
  const { pop } = useNavigation();
  const [titleError, setTitleError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const isNew = props.mode === "new";

  async function submit(values: { title: string; body?: string; alsoHeading?: boolean }) {
    if (busy) return;
    const title = values.title.replace(/\s+/g, " ").trim();
    if (!title) {
      setTitleError("A title is required");
      return;
    }
    setBusy(true);
    try {
      if (await props.onSubmit({ title, body: values.body ?? "", alsoHeading: values.alsoHeading ?? false })) pop();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      navigationTitle={isNew ? "New Checklist" : "Rename Checklist"}
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={isNew ? "Create Checklist" : "Rename Checklist"}
            icon={isNew ? Icon.Plus : Icon.Pencil}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Title"
        placeholder="Launch checklist"
        defaultValue={props.initialTitle ?? ""}
        error={titleError}
        onChange={() => titleError && setTitleError(undefined)}
      />
      {isNew ? (
        <>
          <Form.TextArea
            id="body"
            title="Initial content"
            placeholder={"Optional Markdown, e.g.\n- [ ] First task\n  - [ ] A sub-task"}
            enableMarkdown
          />
          <Form.Description text="Optional. Task lines are `- [ ] title`; ids are added on save. Leave empty for a heading only." />
        </>
      ) : (
        <>
          <Form.Description text="The file is renamed to match the new title." />
          {props.hasHeading ? (
            <Form.Checkbox
              id="alsoHeading"
              label="Also change the document's first heading"
              info="The list shows the document's first heading when it has one, so leave this on to see the new name."
              defaultValue={true}
            />
          ) : null}
        </>
      )}
    </Form>
  );
}
