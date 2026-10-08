// Add Checklist Item from My Day (SPEC §4.2, A-B-3): checklist, optional parent, title, Markdown details and
// "Also add to <day>". The Checklists command's TaskForm has no checklist picker or day option, hence this form.
import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useRef, useState } from "react";
import { formatDay } from "../lib/dates.ts";
import { assignDay } from "../lib/state.ts";
import { saveWithOperation, type ChecklistFile } from "../lib/store.ts";
import { addChild, addTopLevel, flatten } from "../lib/tree.ts";
import { ensureNormalized, reportSave, touchRecent } from "../lib/use-checklists.ts";
import type { AgendaCtx } from "./agenda-shared.tsx";

const TOP = "__top__";
const INDENT = "  "; // no-break spaces, as in the Checklists view

interface Values {
  checklistId: string;
  parentId?: string;
  title: string;
  details: string;
  addToDay: boolean;
}

export function QuickTaskForm({
  ctx,
  defaultChecklistId,
  defaultTitle,
  onDone,
}: {
  ctx: AgendaCtx;
  defaultChecklistId?: string;
  defaultTitle?: string;
  onDone?: () => void;
}) {
  const { pop } = useNavigation();
  const checklists = (ctx.data?.checklists ?? []).filter((c) => !c.archived && !c.readOnlyReason);
  const [checklistId, setChecklistId] = useState(
    checklists.find((c) => c.id === defaultChecklistId)?.id ?? checklists[0]?.id ?? "",
  );
  const [titleError, setTitleError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const file: ChecklistFile | undefined = checklists.find((c) => c.id === checklistId);
  const parentRows = file ? flatten(file.doc, new Set()) : [];

  async function submit(v: Values) {
    if (inFlight.current) return;
    const title = v.title.replace(/\s+/g, " ").trim();
    if (!title) {
      setTitleError("A short title is required");
      return;
    }
    if (!file) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const ready = await ensureNormalized(ctx.session, file);
      if (!ready) return;
      const parentId = v.parentId && v.parentId !== TOP ? v.parentId : null;
      const created: { id: string | null } = { id: null };
      const r = saveWithOperation(ctx.session.dir, ready, (doc) => {
        created.id = parentId ? addChild(doc, parentId, title, v.details) : addTopLevel(doc, title, v.details);
        return created.id !== null;
      });
      const saved = await reportSave(r, {
        title: v.addToDay ? `Added to ${ready.title} and ${formatDay(ctx.day)}` : `Added to ${ready.title}`,
        message: title,
      });
      const newId = created.id;
      if (!saved || !newId) return;
      touchRecent(ctx.session, saved.id);
      if (v.addToDay) assignDay(ctx.session.state, newId, saved.id, ctx.day);
      ctx.session.saveState();
      pop();
      onDone?.();
      void ctx.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (checklists.length === 0) {
    return (
      <Form navigationTitle="Add Checklist Item">
        <Form.Description
          title="No checklist yet"
          text="Create a checklist in the Checklists command first, then add items here."
        />
      </Form>
    );
  }

  return (
    <Form
      navigationTitle="Add Checklist Item"
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add Checklist Item" icon={Icon.Plus} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="checklistId" title="Checklist" value={checklistId} onChange={setChecklistId}>
        {checklists.map((c) => (
          <Form.Dropdown.Item key={c.id} value={c.id} title={c.title} icon={c.pinned ? Icon.Pin : Icon.CheckList} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown key={checklistId} id="parentId" title="Parent" defaultValue={TOP}>
        <Form.Dropdown.Item value={TOP} title="(Top level)" />
        {parentRows.map((row) => (
          <Form.Dropdown.Item
            key={row.node.id}
            value={row.node.id}
            title={`${INDENT.repeat(row.depth)}${row.node.title || "(untitled)"}`}
          />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="title"
        title="Title"
        placeholder="Short title"
        defaultValue={defaultTitle ?? ""}
        autoFocus
        error={titleError}
        onChange={() => titleError && setTitleError(undefined)}
      />
      <Form.TextArea
        id="details"
        title="Details"
        placeholder="Optional notes: paragraphs, pasted text, links, Markdown"
        enableMarkdown
      />
      <Form.Checkbox id="addToDay" label={`Also add to ${formatDay(ctx.day)}`} defaultValue={true} />
    </Form>
  );
}
