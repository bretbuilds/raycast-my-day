import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Detail,
  Icon,
  Keyboard,
  List,
  confirmAlert,
  getPreferenceValues,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { existsSync } from "node:fs";
import { useEffect, useReducer, useState } from "react";
import { dayKeyOf, formatDay, formatDuration, formatTime, relativeDay, todayKey } from "../lib/dates.ts";
import { isChecklistId } from "../lib/ids.ts";
import {
  allTasks,
  bodyText,
  detailsText,
  extractLinks,
  keepLineBreaks,
  serializeDocument,
  withOriginalFrontmatter,
  type TaskNode,
} from "../lib/markdown.ts";
import { indentBy } from "../lib/columns.ts";
import { previewMarkdown } from "../lib/preview.ts";
import { assignDay, linksForSource, pruneTasks, unassignDay } from "../lib/state.ts";
import {
  loadChecklist,
  renameChecklist,
  saveWholeDocument,
  saveWithOperation,
  type ChecklistFile,
} from "../lib/store.ts";
import {
  addChild,
  addSibling,
  addTopLevel,
  countTasks,
  flatten,
  indent,
  locate,
  moveDown,
  moveUp,
  outdent,
  removeTask,
  setChecked,
  setDetails,
  setParent,
  setTitle,
  type Row,
} from "../lib/tree.ts";
import {
  ensureNormalized,
  errorText,
  hasFirstHeading,
  reportSave,
  setFirstHeading,
  touchRecent,
  type ChecklistSession,
} from "../lib/use-checklists.ts";
import { ChecklistForm } from "./ChecklistForm.tsx";
import { DocumentForm } from "./DocumentForm.tsx";
import { TaskForm, type ParentOption, type TaskFormValues } from "./TaskForm.tsx";
import { obsidianOpenUrl, obsidianVaults, vaultFor } from "../lib/obsidian.ts";

// Indentation: measured spaces behind an invisible anchor, 16 pt per level (checked on screen 2026-10-04: two
// no-break spaces per level were too small to read the hierarchy, and plain leading spaces get trimmed).
const LEVEL_POINTS = 16;
const ESTIMATES = [15, 30, 45, 60, 90, 120];
const OPENABLE = /^(https?:|mailto:|obsidian:)/i;

export interface ChecklistViewProps {
  session: ChecklistSession;
  file: ChecklistFile;
  /**
   * Injected by both commands (My Day directly, Checklists through ScheduleFromChecklist). Without it, ⌘S explains why.
   */
  onSchedule?: (task: TaskNode, file: ChecklistFile) => void;
}

function subtreeIds(node: TaskNode): string[] {
  const out: string[] = [];
  const walk = (n: TaskNode) => {
    out.push(n.id);
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

function displayTitle(node: TaskNode): string {
  return node.title || "(untitled)";
}

function stableChecklistId(file: ChecklistFile): boolean {
  return isChecklistId(file.doc.frontmatter?.values.id);
}

export function ChecklistView({ session, file: initialFile, onSchedule }: ChecklistViewProps) {
  const [file, setFile] = useState(initialFile);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Off by default so titles get the full width (owner feedback 2026-10-05); ⌘⇧I shows the pane.
  const [showDetail, setShowDetail] = useState(false);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const { push } = useNavigation();
  const state = session.state;
  const canEdit = !file.readOnlyReason;
  const today = todayKey();

  // Lazy normalization on open: persist generated ids before anything in state.json can reference them.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const f = await ensureNormalized(session, initialFile);
      if (cancelled) return;
      const current = f ?? initialFile;
      if (f && f !== initialFile) setFile(f);
      if (stableChecklistId(current)) {
        touchRecent(session, current.id);
        session.saveState();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const collapsedSet = new Set(Object.keys(state.collapsed));
  const rows = flatten(file.doc, collapsedSet);
  const counts = countTasks(file.doc.blocks);

  // ---- write helpers ------------------------------------------------------------------------------------------

  function adopt(f: ChecklistFile) {
    setFile(f);
    session.onFilesChanged();
  }

  /** Every document mutation goes through saveWithOperation; nothing is written when the result is not ok. */
  async function mutate(
    op: (doc: ChecklistFile["doc"]) => boolean,
    success?: { title: string; message?: string },
  ): Promise<ChecklistFile | null> {
    let r;
    try {
      r = saveWithOperation(session.dir, file, op);
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Could not save", message: errorText(e) });
      return null;
    }
    const f = await reportSave(r, success);
    if (f) adopt(f);
    return f;
  }

  /** For state writes keyed by task id: make sure the ids are on disk and the task still exists. */
  async function readyForState(taskId: string): Promise<ChecklistFile | null> {
    const f = await ensureNormalized(session, file);
    if (!f) return null;
    if (f !== file) setFile(f);
    if (!locate(f.doc, taskId)) {
      await showToast({
        style: Toast.Style.Failure,
        title: "That item changed outside My Day",
        message: "Refresh (⌘R)",
      });
      return null;
    }
    return f;
  }

  function saveStateAndRender() {
    session.saveState();
    rerender();
  }

  // ---- task actions -------------------------------------------------------------------------------------------

  async function toggleComplete(node: TaskNode) {
    const next = !node.checked;
    await mutate((doc) => setChecked(doc, node.id, next), { title: next ? "Completed" : "Marked as not done" });
    setSelectedId(node.id);
  }

  function parentOptions(node: TaskNode): ParentOption[] {
    const excluded = new Set(subtreeIds(node));
    return flatten(file.doc, new Set())
      .filter((r) => !excluded.has(r.node.id))
      .map((r) => ({ id: r.node.id, label: `${"  ".repeat(r.depth)}${displayTitle(r.node)}` }));
  }

  function editTask(row: Row, focus: "title" | "details" = "title") {
    const node = row.node;
    const l = locate(file.doc, node.id);
    const currentParent = l?.parent?.id ?? null;
    push(
      <TaskForm
        navigationTitle={`Edit ${displayTitle(node)}`}
        submitTitle="Save Item"
        focus={focus}
        initial={{ title: node.title, details: detailsText(node), parentId: currentParent }}
        parentOptions={parentOptions(node)}
        onSubmit={async (v: TaskFormValues) => {
          let cycle = false;
          const f = await mutate(
            (doc) => {
              if (!setTitle(doc, node.id, v.title)) return false;
              if (!setDetails(doc, node.id, v.details)) return false;
              const nowParent = locate(doc, node.id)?.parent?.id ?? null;
              if (v.parentId !== nowParent) {
                if (!setParent(doc, node.id, v.parentId)) {
                  cycle = true;
                  return false;
                }
              }
              return true;
            },
            { title: "Item saved" },
          );
          if (!f && cycle) {
            await showToast({
              style: Toast.Style.Failure,
              title: "Can't move an item under itself",
              message: "Choose a parent outside this item's own sub-items.",
            });
          }
          if (f) setSelectedId(node.id);
          return f !== null;
        }}
      />,
    );
  }

  function addTask(kind: "sibling" | "child" | "top", anchor?: TaskNode) {
    const label = kind === "child" ? `Add Child to ${anchor ? displayTitle(anchor) : ""}` : "Add Item";
    push(
      <TaskForm
        navigationTitle={label}
        submitTitle="Add Item"
        onSubmit={async (v) => {
          let newId: string | null = null;
          const f = await mutate(
            (doc) => {
              if (kind === "top" || !anchor) newId = addTopLevel(doc, v.title, v.details);
              else if (kind === "sibling") newId = addSibling(doc, anchor.id, v.title, v.details);
              else newId = addChild(doc, anchor.id, v.title, v.details);
              return newId !== null;
            },
            { title: "Item added" },
          );
          if (!f) return false;
          if (kind === "child" && anchor && state.collapsed[anchor.id]) {
            delete state.collapsed[anchor.id]; // show the new child
            session.saveState();
          }
          if (newId) setSelectedId(newId);
          return true;
        }}
      />,
    );
  }

  async function structural(
    node: TaskNode,
    op: typeof indent,
    precheck: string | null,
    success: string,
  ): Promise<void> {
    if (precheck) {
      await showToast({ style: Toast.Style.Failure, title: precheck });
      return;
    }
    await mutate((doc) => op(doc, node.id), { title: success });
    setSelectedId(node.id);
  }

  async function deleteItem(row: Row) {
    const node = row.node;
    const removed = subtreeIds(node);
    const sub = removed.length - 1;
    const ok = await confirmAlert({
      title: `Delete “${displayTitle(node)}”?`,
      message: `This removes the item${sub ? ` and its ${sub} sub-item${sub === 1 ? "" : "s"}` : ""} from the document. A snapshot of the file is kept in the .myday/snapshots folder, so it can be recovered.`,
      icon: Icon.Trash,
      primaryAction: { title: "Delete Item", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    const index = rows.findIndex((r) => r.node.id === node.id);
    const removedSet = new Set(removed);
    const next = rows.slice(index + 1).find((r) => !removedSet.has(r.node.id)) ?? rows[index - 1];
    const f = await mutate((doc) => removeTask(doc, node.id) !== null, { title: "Item deleted" });
    if (!f) return;
    const live = new Set(allTasks(f.doc.blocks).map((t) => t.id));
    pruneTasks(state, f.id, live);
    for (const id of removed) {
      if (live.has(id)) continue;
      delete state.estimates[id];
      delete state.collapsed[id];
    }
    saveStateAndRender();
    setSelectedId(next?.node.id);
  }

  // ---- plan actions (state.json) ------------------------------------------------------------------------------

  async function addToDay(node: TaskNode, date: Date | null) {
    if (!date) return;
    const f = await readyForState(node.id);
    if (!f) return;
    const day = dayKeyOf(date);
    const previous = assignDay(state, node.id, f.id, day);
    saveStateAndRender();
    await showToast({
      style: Toast.Style.Success,
      title: previous ? `Moved from ${relativeDay(previous, today)}` : `Added to ${relativeDay(day, today)}`,
      message: previous ? `Now on ${formatDay(day)}` : undefined,
    });
  }

  async function removeFromDay(node: TaskNode) {
    if (unassignDay(state, node.id)) {
      saveStateAndRender();
      await showToast({ style: Toast.Style.Success, title: "Removed from day" });
    }
  }

  async function setEstimate(node: TaskNode, minutes: number | null) {
    const f = await readyForState(node.id);
    if (!f) return;
    if (minutes === null) delete state.estimates[node.id];
    else state.estimates[node.id] = minutes;
    saveStateAndRender();
  }

  async function setCollapsed(node: TaskNode, collapsed: boolean) {
    if (canEdit) {
      const f = await readyForState(node.id);
      if (!f) return;
    }
    if (collapsed) state.collapsed[node.id] = true;
    else delete state.collapsed[node.id];
    saveStateAndRender();
    setSelectedId(node.id);
  }

  async function schedule(node: TaskNode) {
    if (onSchedule) {
      const f = await readyForState(node.id);
      if (f) onSchedule(node, f);
      return;
    }
    await showToast({ style: Toast.Style.Failure, title: "Scheduling is not available in this view" });
  }

  // ---- document actions ---------------------------------------------------------------------------------------

  async function refresh(quiet = false) {
    if (!existsSync(file.path)) {
      await showToast({
        style: Toast.Style.Failure,
        title: "File not found",
        message: "It was moved, renamed or trashed outside this view.",
      });
      return;
    }
    let fresh: ChecklistFile;
    try {
      fresh = loadChecklist(file.path);
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Could not read the file", message: errorText(e) });
      return;
    }
    if (!stableChecklistId(fresh)) fresh.id = file.id;
    const changed = fresh.hash !== file.hash;
    setFile(fresh);
    session.onFilesChanged();
    if (changed) await showToast({ style: Toast.Style.Success, title: "Reloaded: edited outside My Day" });
    else if (!quiet) await showToast({ style: Toast.Style.Success, title: "Up to date" });
    if (fresh.needsNormalize) {
      const f = await ensureNormalized(session, fresh);
      if (f) setFile(f);
    }
  }

  function editWholeDocument() {
    push(
      <DocumentForm
        title={file.title}
        initialContent={bodyText(file.doc)}
        onSubmit={async (content) => {
          let r;
          try {
            // The settings block (frontmatter) is hidden in the editor and re-attached unchanged here.
            r = saveWholeDocument(session.dir, file, withOriginalFrontmatter(file.doc, content));
          } catch (e) {
            await showToast({ style: Toast.Style.Failure, title: "Could not save", message: errorText(e) });
            return false;
          }
          const f = await reportSave(r, { title: "Document saved" });
          if (f) {
            adopt(f);
            return true;
          }
          if (!r.ok && r.reason === "conflict") {
            // Ours is safe in the conflict copy; show theirs, which stayed in place.
            await refresh(true);
            session.onFilesChanged();
            return true;
          }
          return false;
        }}
      />,
    );
  }

  function previewDocument() {
    const content = serializeDocument(file.doc);
    push(
      <Detail
        navigationTitle={`Preview: ${file.title}`}
        markdown={previewMarkdown(content)}
        metadata={
          <Detail.Metadata>
            <Detail.Metadata.Label title="File" text={file.path} />
            <Detail.Metadata.Label title="Items" text={`${counts.done} of ${counts.total} done`} />
            {file.readOnlyReason ? <Detail.Metadata.Label title="Read-only" text={file.readOnlyReason} /> : null}
          </Detail.Metadata>
        }
        actions={
          <ActionPanel>
            <OpenInEditorAction path={file.path} />
            <Action.ShowInFinder path={file.path} />
            <Action.CopyToClipboard title="Copy File Path" content={file.path} />
          </ActionPanel>
        }
      />,
    );
  }

  function renameThisChecklist() {
    push(
      <ChecklistForm
        mode="rename"
        initialTitle={file.title}
        hasHeading={hasFirstHeading(file.doc)}
        onSubmit={async (v) => {
          let r;
          try {
            r = renameChecklist(session.dir, file, v.title);
          } catch (e) {
            await showToast({ style: Toast.Style.Failure, title: "Could not rename", message: errorText(e) });
            return false;
          }
          let f = await reportSave(r, v.alsoHeading ? undefined : { title: "Renamed" });
          if (!f) return false;
          if (v.alsoHeading) {
            f =
              (await reportSave(
                saveWithOperation(session.dir, f, (doc) => setFirstHeading(doc, v.title)),
                { title: "Renamed" },
              )) ?? f;
          }
          adopt(f);
          return true;
        }}
      />,
    );
  }

  // ---- rendering ----------------------------------------------------------------------------------------------

  const docActions = (
    <>
      <ActionPanel.Section title="Document">
        {canEdit ? (
          <Action
            title="Edit Whole Document"
            icon={Icon.Document}
            shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
            onAction={editWholeDocument}
          />
        ) : null}
        <Action
          title="Preview Document"
          icon={Icon.Eye}
          shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
          onAction={previewDocument}
        />
        <OpenInEditorAction path={file.path} />
        <Action.ShowInFinder path={file.path} />
        <Action
          title={showDetail ? "Hide Details" : "Show Details"}
          icon={Icon.Sidebar}
          shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
          onAction={() => setShowDetail((v) => !v)}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="Checklist">
        {canEdit && rows.length === 0 ? (
          <Action
            title="Add Item"
            icon={Icon.Plus}
            shortcut={Keyboard.Shortcut.Common.New}
            onAction={() => addTask("top")}
          />
        ) : null}
        {canEdit ? <Action title="Rename Checklist" icon={Icon.Pencil} onAction={renameThisChecklist} /> : null}
        <Action
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={() => void refresh()}
        />
      </ActionPanel.Section>
    </>
  );

  function rowActions(row: Row) {
    const node = row.node;
    const l = locate(file.doc, node.id);
    const links = extractLinks(node);
    const assigned = state.assignments[node.id];
    const completeAction = canEdit ? (
      <Action
        title={node.checked ? "Mark Not Done" : "Complete"}
        icon={node.checked ? Icon.CheckList : Icon.Checkmark}
        onAction={() => void toggleComplete(node)}
      />
    ) : null;
    const editDetailsAction = canEdit ? (
      <Action title="Edit Details…" icon={Icon.Text} onAction={() => editTask(row, "details")} />
    ) : null;
    const editAction = canEdit ? (
      <Action
        title="Edit…"
        icon={Icon.Pencil}
        shortcut={Keyboard.Shortcut.Common.Edit}
        onAction={() => editTask(row)}
      />
    ) : null;

    return (
      <ActionPanel title={displayTitle(node)}>
        <ActionPanel.Section title="Task">
          {/* ↵ always opens the item's details for editing; ⌘↵ always completes (owner feedback 2026-10-04). */}
          {editDetailsAction}
          {completeAction}
          {editAction}
          {links.length === 1 ? <LinkAction link={links[0]} shortcut={Keyboard.Shortcut.Common.Open} /> : null}
          {links.length > 1 ? (
            <ActionPanel.Submenu title="Open Links" icon={Icon.Link} shortcut={Keyboard.Shortcut.Common.Open}>
              {links.map((lk) => (
                <LinkAction key={lk.url} link={lk} />
              ))}
            </ActionPanel.Submenu>
          ) : null}
          {canEdit ? (
            <Action
              title="Delete Item"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.Remove}
              onAction={() => void deleteItem(row)}
            />
          ) : null}
        </ActionPanel.Section>
        <ActionPanel.Section title="Structure">
          {canEdit ? (
            <>
              <Action
                title="Add Sibling"
                icon={Icon.Plus}
                shortcut={Keyboard.Shortcut.Common.New}
                onAction={() => addTask("sibling", node)}
              />
              <Action
                title="Add Child"
                icon={Icon.Plus}
                shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
                onAction={() => addTask("child", node)}
              />
              <Action
                title="Indent"
                icon={Icon.ArrowRight}
                shortcut={{ modifiers: ["cmd"], key: "]" }}
                onAction={() =>
                  void structural(
                    node,
                    indent,
                    l && l.index === 0 ? "Can't indent: no item above at this level" : null,
                    "Indented",
                  )
                }
              />
              <Action
                title="Outdent"
                icon={Icon.ArrowLeft}
                shortcut={{ modifiers: ["cmd"], key: "[" }}
                onAction={() =>
                  void structural(node, outdent, l && !l.parent ? "Already at the top level" : null, "Outdented")
                }
              />
              <Action
                title="Move up"
                icon={Icon.ArrowUp}
                shortcut={Keyboard.Shortcut.Common.MoveUp}
                onAction={() =>
                  void structural(node, moveUp, l && l.index === 0 ? "Already first at this level" : null, "Moved up")
                }
              />
              <Action
                title="Move Down"
                icon={Icon.ArrowDown}
                shortcut={Keyboard.Shortcut.Common.MoveDown}
                onAction={() =>
                  void structural(
                    node,
                    moveDown,
                    l && l.index >= l.siblings.length - 1 ? "Already last at this level" : null,
                    "Moved down",
                  )
                }
              />
            </>
          ) : null}
          {row.hasChildren && !row.collapsed ? (
            <Action
              title="Collapse"
              icon={Icon.ChevronDown}
              shortcut={{ modifiers: ["cmd", "shift"], key: "arrowLeft" }}
              onAction={() => void setCollapsed(node, true)}
            />
          ) : null}
          {row.hasChildren && row.collapsed ? (
            <Action
              title="Expand"
              icon={Icon.ChevronRight}
              shortcut={{ modifiers: ["cmd", "shift"], key: "arrowRight" }}
              onAction={() => void setCollapsed(node, false)}
            />
          ) : null}
        </ActionPanel.Section>
        {canEdit ? (
          <ActionPanel.Section title="Plan">
            <Action.PickDate
              title={assigned ? "Move to Day…" : "Add to Day…"}
              type={Action.PickDate.Type.Date}
              shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
              onChange={(d) => void addToDay(node, d)}
            />
            {assigned ? (
              <Action title="Remove from Day" icon={Icon.XMarkCircle} onAction={() => void removeFromDay(node)} />
            ) : null}
            <ActionPanel.Submenu title="Set Estimate…" icon={Icon.Stopwatch}>
              {ESTIMATES.map((m) => (
                <Action key={m} title={formatDuration(m)} onAction={() => void setEstimate(node, m)} />
              ))}
              <Action title="None" onAction={() => void setEstimate(node, null)} />
            </ActionPanel.Submenu>
            <Action
              title="Schedule Work Block…"
              icon={Icon.Clock}
              shortcut={Keyboard.Shortcut.Common.Save}
              onAction={() => void schedule(node)}
            />
          </ActionPanel.Section>
        ) : null}
        {docActions}
      </ActionPanel>
    );
  }

  function rowDetail(row: Row) {
    const node = row.node;
    const assigned = state.assignments[node.id];
    const blocks = linksForSource(state, { kind: "task", taskId: node.id });
    const links = extractLinks(node);
    const details = detailsText(node);
    const estimate = state.estimates[node.id];
    let blockText = "None";
    if (blocks.length) {
      const first = blocks[0][1];
      const start = new Date(first.snapshot.start);
      const when = Number.isNaN(start.getTime())
        ? ""
        : ` · ${relativeDay(dayKeyOf(start), today)} ${formatTime(start)}`;
      blockText = `${blocks.length} · ${first.snapshot.title || "(untitled)"}${when}`;
    }
    return (
      <List.Item.Detail
        markdown={`## ${displayTitle(node)}\n\n${keepLineBreaks(details)}`}
        metadata={
          <List.Item.Detail.Metadata>
            <List.Item.Detail.Metadata.Label title="Checklist" text={file.title} />
            <List.Item.Detail.Metadata.Label
              title="Parent"
              text={row.parentChain.length ? row.parentChain.join(" › ") : "Top level"}
            />
            <List.Item.Detail.Metadata.Label
              title="Status"
              text={node.checked ? "Done" : "Open"}
              icon={node.checked ? { source: Icon.Checkmark, tintColor: Color.Green } : Icon.CheckList}
            />
            <List.Item.Detail.Metadata.Label
              title="Day"
              text={assigned ? `${relativeDay(assigned.day, today)} (${formatDay(assigned.day)})` : "Not assigned"}
            />
            {estimate ? <List.Item.Detail.Metadata.Label title="Estimate" text={formatDuration(estimate)} /> : null}
            <List.Item.Detail.Metadata.Label title="Linked work blocks" text={blockText} />
            {links.length ? (
              <List.Item.Detail.Metadata.TagList title="Links">
                {links.map((lk) => (
                  <List.Item.Detail.Metadata.TagList.Item
                    key={lk.url}
                    text={lk.title.length > 40 ? `${lk.title.slice(0, 39)}…` : lk.title}
                  />
                ))}
              </List.Item.Detail.Metadata.TagList>
            ) : null}
            <List.Item.Detail.Metadata.Separator />
            <List.Item.Detail.Metadata.Label title="Task id" text={node.id} />
          </List.Item.Detail.Metadata>
        }
      />
    );
  }

  function accessories(row: Row): List.Item.Accessory[] {
    const node = row.node;
    const out: List.Item.Accessory[] = [];
    const estimate = state.estimates[node.id];
    if (estimate) out.push({ text: formatDuration(estimate), tooltip: "Estimate" });
    const assigned = state.assignments[node.id];
    if (assigned) {
      const color = assigned.day < today ? Color.Red : assigned.day === today ? Color.Blue : Color.SecondaryText;
      out.push({ tag: { value: relativeDay(assigned.day, today), color }, tooltip: formatDay(assigned.day) });
    }
    const blocks = linksForSource(state, { kind: "task", taskId: node.id });
    if (blocks.length)
      out.push({ icon: Icon.Calendar, tooltip: `${blocks.length} linked work block${blocks.length === 1 ? "" : "s"}` });
    const links = extractLinks(node);
    if (links.length) out.push({ icon: Icon.Link, tooltip: `${links.length} link${links.length === 1 ? "" : "s"}` });
    return out;
  }

  const sectionTitle = file.readOnlyReason
    ? `Read-only: ${file.readOnlyReason}`
    : `${counts.done} of ${counts.total} done`;

  return (
    <List
      navigationTitle={file.readOnlyReason ? `${file.title} (read-only)` : file.title}
      isShowingDetail={showDetail && rows.length > 0}
      selectedItemId={selectedId}
      onSelectionChange={(id) => setSelectedId(id ?? undefined)}
      searchBarPlaceholder={`Search ${file.title}`}
    >
      <List.EmptyView
        icon={Icon.CheckList}
        title={file.readOnlyReason ? "Read-only checklist" : "No items yet"}
        description={
          file.readOnlyReason
            ? `${file.readOnlyReason}. Open it in your editor to fix it.`
            : "Add the first item with ⌘N, or edit the whole document with ⌘⇧E."
        }
        actions={<ActionPanel>{docActions}</ActionPanel>}
      />
      <List.Section title={sectionTitle}>
        {rows.map((row) => {
          const node = row.node;
          const twisty = row.hasChildren ? (row.collapsed ? "▸ " : "▾ ") : "";
          return (
            <List.Item
              key={node.id}
              id={node.id}
              // Status glyphs, not checkboxes: Raycast list rows cannot be clicked to toggle.
              icon={
                node.checked
                  ? { source: Icon.Checkmark, tintColor: Color.Green }
                  : { source: Icon.CheckList, tintColor: Color.SecondaryText }
              }
              title={`${indentBy(row.depth * LEVEL_POINTS)}${twisty}${displayTitle(node)}`}
              keywords={[...row.parentChain, node.id]}
              accessories={accessories(row)}
              detail={rowDetail(row)}
              actions={rowActions(row)}
            />
          );
        })}
      </List.Section>
    </List>
  );
}

function LinkAction(props: { link: { title: string; url: string }; title?: string; shortcut?: Keyboard.Shortcut }) {
  const { link } = props;
  if (OPENABLE.test(link.url)) {
    return (
      <Action.OpenInBrowser title={props.title ?? `Open ${link.title}`} url={link.url} shortcut={props.shortcut} />
    );
  }
  return <Action.CopyToClipboard title="Copy Link (Unsupported Scheme)" content={link.url} shortcut={props.shortcut} />;
}

export function OpenInEditorAction(props: { path: string }) {
  const prefs = getPreferenceValues<Preferences>();
  const shortcut = Keyboard.Shortcut.Common.OpenWith;
  // Inside an Obsidian vault, Obsidian is the editor unless another app was chosen in the preferences.
  if (!prefs.editorApp && vaultFor(props.path, obsidianVaults())) {
    return (
      <Action.Open
        title="Open in Obsidian"
        icon={Icon.Document}
        target={obsidianOpenUrl(props.path)}
        shortcut={shortcut}
      />
    );
  }
  if (prefs.editorApp) {
    return (
      <Action.Open
        title={`Open in ${prefs.editorApp.name}`}
        icon={Icon.Document}
        target={props.path}
        application={prefs.editorApp}
        shortcut={shortcut}
      />
    );
  }
  return <Action.OpenWith title="Open in Editor…" path={props.path} shortcut={shortcut} />;
}
