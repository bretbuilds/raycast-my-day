import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useState } from "react";

export const DOCUMENT_FORM_NOTE =
  "Plain Markdown editor. Task lines are `- [ ] title ^t-id`; keep the ^t-ids so day assignments and work blocks stay attached. The checklist's settings (pin, order, id) are kept separately. This is not Raycast Notes' editor.";

export function DocumentForm(props: {
  title: string;
  initialContent: string;
  /** Resolve true to close the form. */
  onSubmit: (content: string) => Promise<boolean>;
}) {
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);

  async function submit(values: { content: string }) {
    if (busy) return;
    setBusy(true);
    try {
      if (await props.onSubmit(values.content)) pop();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      navigationTitle={`Edit ${props.title}`}
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Document" icon={Icon.Checkmark} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description text={DOCUMENT_FORM_NOTE} />
      <Form.TextArea id="content" title="Document" enableMarkdown defaultValue={props.initialContent} />
    </Form>
  );
}
