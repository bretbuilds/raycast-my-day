import { useCachedState } from "@raycast/utils";
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Detail,
  Form,
  Icon,
  Keyboard,
  LaunchType,
  List,
  confirmAlert,
  launchCommand,
  showInFinder,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { ChecklistForm } from "./components/ChecklistForm.tsx";
import { ReloadingChecklistView } from "./components/ReloadingChecklistView.tsx";
import { isChecklistId } from "./lib/ids.ts";
import { allTasks } from "./lib/markdown.ts";
import { backupDefaultDir, statePath } from "./lib/paths.ts";
import { pruneTasks } from "./lib/state.ts";
import {
  compareChecklists,
  createChecklist,
  deleteFromTrash,
  duplicateChecklist,
  exportBackup,
  importBackup,
  loadChecklist,
  renameChecklist,
  restoreFromTrash,
  saveWithOperation,
  setChecklistMeta,
  trashChecklist,
  type ChecklistFile,
  type ImportReport,
  type TrashEntry,
} from "./lib/store.ts";
import { countTasks } from "./lib/tree.ts";
import {
  errorText,
  hasFirstHeading,
  reportSave,
  setFirstHeading,
  useChecklistSession,
  useChecklists,
  type ChecklistSession,
} from "./lib/use-checklists.ts";

type ViewValue = "active:manual" | "active:recent" | "archived:manual" | "trash";

export default function Command() {
  const session = useChecklistSession();
  const { list, trash, isLoading, reload } = useChecklists(session);
  // Controlled, so creating a checklist from Trash or Archived can switch back to Active. Only the Active sort
  // is remembered: reopening on Trash or Archived looked as if every checklist had disappeared.
  const [activeSort, setActiveSort] = useCachedState<ViewValue>("my-day.checklists.view", "active:manual");
  const [view, setViewState] = useState<ViewValue>(activeSort.startsWith("active") ? activeSort : "active:manual");
  const setView = (v: ViewValue) => {
    setViewState(v);
    if (v.startsWith("active")) setActiveSort(v);
  };
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const { push } = useNavigation();
  const dir = session.dir;

  const mode = view === "trash" ? "trash" : view.startsWith("archived") ? "archived" : "active";
  const recent = view === "active:recent";

  const visible = list.checklists.filter((c) => (mode === "archived" ? c.archived : !c.archived));
  const sorted = recent
    ? [...visible].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const ra = session.state.recent[a.id] ?? "";
        const rb = session.state.recent[b.id] ?? "";
        if (ra !== rb) return ra < rb ? 1 : -1;
        return b.mtimeMs - a.mtimeMs;
      })
    : [...visible].sort(compareChecklists);
  const pinned = mode === "active" ? sorted.filter((c) => c.pinned) : [];
  const others = mode === "active" ? sorted.filter((c) => !c.pinned) : sorted;

  // ---- helpers ------------------------------------------------------------------------------------------------

  function afterWrite(id?: string) {
    reload();
    if (id) setSelectedId(id);
  }

  async function guarded<T>(label: string, fn: () => T | Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: label, message: errorText(e) });
      return null;
    }
  }

  function newChecklist() {
    push(
      <ChecklistForm
        mode="new"
        onSubmit={async (v) => {
          const f = await guarded("Could not create the checklist", () => createChecklist(dir, v.title, v.body));
          if (!f) return false;
          await showToast({ style: Toast.Style.Success, title: `Created ${f.title}` });
          // A new checklist is active: show it even if Trash or Archived was open (owner test 2026-10-04).
          if (!view.startsWith("active")) setView("active:manual");
          afterWrite(f.id);
          return true;
        }}
      />,
    );
  }

  function rename(c: ChecklistFile) {
    push(
      <ChecklistForm
        mode="rename"
        initialTitle={c.title}
        hasHeading={hasFirstHeading(c.doc)}
        onSubmit={async (v) => {
          const r = await guarded("Could not rename", () => renameChecklist(dir, c, v.title));
          if (!r) return false;
          let f = await reportSave(r, v.alsoHeading ? undefined : { title: "Renamed" });
          if (!f) return false;
          if (v.alsoHeading) {
            const r2 = await guarded("Could not update the heading", () =>
              saveWithOperation(dir, f as ChecklistFile, (doc) => setFirstHeading(doc, v.title)),
            );
            if (r2) f = (await reportSave(r2, { title: "Renamed" })) ?? f;
          }
          afterWrite(f.id);
          return true;
        }}
      />,
    );
  }

  async function setMeta(
    c: ChecklistFile,
    patch: Partial<Pick<ChecklistFile, "pinned" | "archived" | "order">>,
    success?: { title: string; message?: string },
  ): Promise<ChecklistFile | null> {
    const r = await guarded("Could not save", () => setChecklistMeta(dir, c, patch));
    if (!r) return null;
    return reportSave(r, success);
  }

  async function togglePin(c: ChecklistFile) {
    const f = await setMeta(c, { pinned: !c.pinned }, { title: c.pinned ? "Unpinned" : "Pinned" });
    if (f) afterWrite(f.id);
  }

  async function toggleArchive(c: ChecklistFile) {
    const f = await setMeta(
      c,
      { archived: !c.archived },
      c.archived
        ? { title: "Restored from archive" }
        : { title: "Shelved", message: "Moved to the Shelved folder; find it under Archived in the dropdown." },
    );
    if (f) afterWrite();
  }

  /** Swaps the manual position with the neighbour in the same section (pinned or not). */
  async function move(c: ChecklistFile, delta: -1 | 1) {
    const group = list.checklists.filter((x) => !x.archived && x.pinned === c.pinned).sort(compareChecklists);
    const i = group.findIndex((x) => x.id === c.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= group.length) {
      await showToast({ style: Toast.Style.Failure, title: delta < 0 ? "Already first" : "Already last" });
      return;
    }
    const orders = group.map((x) => x.order);
    const distinct = new Set(orders).size === orders.length && orders.every((o) => o !== Number.MAX_SAFE_INTEGER);
    const writes: [ChecklistFile, number][] = [];
    if (distinct) {
      writes.push([group[i], group[j].order], [group[j], group[i].order]);
    } else {
      // Orders tie or are missing: renumber the whole section once, with the pair swapped.
      const arranged = [...group];
      [arranged[i], arranged[j]] = [arranged[j], arranged[i]];
      const base = Math.min(...orders.filter((o) => o !== Number.MAX_SAFE_INTEGER), 1);
      arranged.forEach((x, k) => {
        if (x.order !== base + k) writes.push([x, base + k]);
      });
    }
    for (const [file, order] of writes) {
      const f = await setMeta(file, { order });
      if (!f) break;
    }
    afterWrite(c.id);
  }

  async function duplicate(c: ChecklistFile, reset: boolean) {
    const result = await guarded("Could not duplicate", () => duplicateChecklist(dir, c, reset));
    if (!result) return;
    let f = result.file;
    // The copy's frontmatter title is "<title> copy"; the H1 would otherwise show the same name as the original.
    if (hasFirstHeading(f.doc)) {
      const r = await guarded("Could not update the copy's heading", () =>
        saveWithOperation(dir, f, (doc) => setFirstHeading(doc, `${c.title} copy`)),
      );
      if (r?.ok) f = r.file;
    }
    // Day assignments and links are keyed by task id; the copy has fresh ids, so nothing is copied (A-C-10).
    await showToast({
      style: Toast.Style.Success,
      title: `Duplicated as ${f.title}`,
      message: reset ? "Checkboxes reset" : "Checkbox state kept",
    });
    afterWrite(f.id);
  }

  async function moveToTrash(c: ChecklistFile) {
    const ok = await confirmAlert({
      title: `Move “${c.title}” to Trash?`,
      message: "It stays recoverable from Trash in the dropdown. Day assignments are kept in case you restore it.",
      icon: Icon.Trash,
      primaryAction: { title: "Move to Trash", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    const entry = await guarded("Could not move to Trash", () => trashChecklist(dir, c));
    if (!entry) return;
    // State is deliberately left alone so a restore keeps assignments; it is pruned only on permanent delete.
    afterWrite();
    await showToast({
      style: Toast.Style.Success,
      title: "Moved to Trash",
      primaryAction: {
        title: "Undo",
        onAction: async (toast) => {
          const f = await guarded("Could not restore", () => restoreFromTrash(dir, entry));
          if (f) {
            await toast.hide();
            afterWrite(f.id);
          }
        },
      },
    });
  }

  async function restore(entry: TrashEntry) {
    const f = await guarded("Could not restore", () => restoreFromTrash(dir, entry));
    if (!f) return;
    await showToast({ style: Toast.Style.Success, title: `Restored ${f.title}` });
    afterWrite();
  }

  async function deletePermanently(entry: TrashEntry) {
    const ok = await confirmAlert({
      title: `Delete “${trashTitle(entry)}” permanently?`,
      message:
        "The file is removed from the Trash folder and its day assignments and links are cleared. This cannot be undone.",
      icon: Icon.Trash,
      primaryAction: { title: "Delete Permanently", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    let checklistId: string | null = null;
    let taskIds: string[] = [];
    try {
      const f = loadChecklist(entry.path);
      if (isChecklistId(f.doc.frontmatter?.values.id)) checklistId = f.id;
      taskIds = allTasks(f.doc.blocks).map((t) => t.id);
    } catch {
      // unreadable: nothing in state can be matched to it
    }
    const done = await guarded("Could not delete", () => {
      deleteFromTrash(entry);
      return true;
    });
    if (!done) return;
    if (checklistId) {
      pruneTasks(session.state, checklistId, new Set());
      delete session.state.recent[checklistId];
    }
    for (const id of taskIds) {
      delete session.state.estimates[id];
      delete session.state.collapsed[id];
    }
    session.saveState();
    await showToast({ style: Toast.Style.Success, title: "Deleted permanently" });
    afterWrite();
  }

  function exportBackupForm() {
    push(<ExportBackupForm session={session} />);
  }

  function importBackupForm() {
    push(<ImportBackupForm session={session} onImported={() => afterWrite()} />);
  }

  async function openSetup() {
    await guarded("Could not open My Day Setup", () =>
      launchCommand({ name: "my-day-setup", type: LaunchType.UserInitiated }),
    );
  }

  // ---- rendering ----------------------------------------------------------------------------------------------

  const generalActions = (
    <>
      <ActionPanel.Section title="Create">
        <Action
          title="New Checklist"
          icon={Icon.Plus}
          shortcut={Keyboard.Shortcut.Common.New}
          onAction={newChecklist}
        />
      </ActionPanel.Section>
      <ActionPanel.Section title="Folder and Backup">
        <Action.Open title="Open Folder in Finder" icon={Icon.Finder} target={dir} application="Finder" />
        <Action title="Export Backup…" icon={Icon.Upload} onAction={exportBackupForm} />
        <Action title="Import Backup…" icon={Icon.Download} onAction={importBackupForm} />
        <Action title="Open Setup" icon={Icon.Gear} onAction={() => void openSetup()} />
        <Action
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={() => reload()}
        />
      </ActionPanel.Section>
    </>
  );

  function checklistItem(c: ChecklistFile) {
    const { total, done } = countTasks(c.doc.blocks);
    const accessories: List.Item.Accessory[] = [];
    if (c.readOnlyReason)
      accessories.push({ tag: { value: "read-only", color: Color.Orange }, tooltip: c.readOnlyReason });
    if (c.archived) accessories.push({ tag: { value: "archived", color: Color.SecondaryText } });
    if (c.pinned) accessories.push({ text: "📌", tooltip: "Pinned" });
    const canEdit = !c.readOnlyReason;
    const manual = !recent && mode === "active";
    return (
      <List.Item
        key={c.id}
        id={c.id}
        icon={Icon.CheckList}
        title={c.title}
        subtitle={`${done} of ${total} done`}
        keywords={[c.fileName]}
        accessories={accessories}
        actions={
          <ActionPanel title={c.title}>
            <ActionPanel.Section title="Checklist">
              <Action.Push
                title="Open"
                icon={Icon.ArrowRight}
                target={<ReloadingChecklistView session={session} file={c} />}
              />
              {canEdit ? (
                <>
                  <Action
                    title="Rename"
                    icon={Icon.Pencil}
                    shortcut={Keyboard.Shortcut.Common.Edit}
                    onAction={() => rename(c)}
                  />
                  <Action
                    title={c.pinned ? "Unpin" : "Pin"}
                    icon={c.pinned ? Icon.PinDisabled : Icon.Pin}
                    shortcut={Keyboard.Shortcut.Common.Pin}
                    onAction={() => void togglePin(c)}
                  />
                  <Action
                    title={c.archived ? "Restore from Archive" : "Archive"}
                    icon={Icon.Box}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
                    onAction={() => void toggleArchive(c)}
                  />
                </>
              ) : null}
              {canEdit ? (
                <ActionPanel.Submenu
                  title="Duplicate…"
                  icon={Icon.Duplicate}
                  shortcut={Keyboard.Shortcut.Common.Duplicate}
                >
                  <Action title="Keep Checkbox State" onAction={() => void duplicate(c, false)} />
                  <Action title="Reset Checkboxes" onAction={() => void duplicate(c, true)} />
                </ActionPanel.Submenu>
              ) : null}
              <Action.ShowInFinder path={c.path} />
              <Action
                title="Move to Trash"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={() => void moveToTrash(c)}
              />
            </ActionPanel.Section>
            {manual && canEdit ? (
              <ActionPanel.Section title="Order">
                <Action
                  title="Move up"
                  icon={Icon.ArrowUp}
                  shortcut={Keyboard.Shortcut.Common.MoveUp}
                  onAction={() => void move(c, -1)}
                />
                <Action
                  title="Move Down"
                  icon={Icon.ArrowDown}
                  shortcut={Keyboard.Shortcut.Common.MoveDown}
                  onAction={() => void move(c, 1)}
                />
              </ActionPanel.Section>
            ) : null}
            {generalActions}
          </ActionPanel>
        }
      />
    );
  }

  const dropdown = (
    <List.Dropdown tooltip="View and sort" value={view} onChange={(v) => setView(v as ViewValue)}>
      <List.Dropdown.Section title="Active">
        <List.Dropdown.Item title="Active · Manual Order" value="active:manual" icon={Icon.List} />
        <List.Dropdown.Item title="Active · Recent First" value="active:recent" icon={Icon.Clock} />
      </List.Dropdown.Section>
      <List.Dropdown.Section title="Other">
        <List.Dropdown.Item title="Archived" value="archived:manual" icon={Icon.Box} />
        <List.Dropdown.Item title="Trash" value="trash" icon={Icon.Trash} />
      </List.Dropdown.Section>
    </List.Dropdown>
  );

  const emptyView =
    mode === "trash" ? (
      <List.EmptyView icon={Icon.Trash} title="Trash is empty" actions={<ActionPanel>{generalActions}</ActionPanel>} />
    ) : mode === "archived" ? (
      <List.EmptyView
        icon={Icon.Box}
        title="No archived checklists"
        description="Archive a checklist with ⌘⇧A to keep it out of the way without deleting it."
        actions={<ActionPanel>{generalActions}</ActionPanel>}
      />
    ) : (
      <List.EmptyView
        icon={Icon.CheckList}
        title="No checklists yet"
        description={`Checklists are Markdown files in ${dir}. Create one with ⌘N, or change the folder in the extension preferences.`}
        actions={<ActionPanel>{generalActions}</ActionPanel>}
      />
    );

  return (
    <List
      navigationTitle="Checklists"
      isLoading={isLoading}
      searchBarPlaceholder="Search checklists"
      searchBarAccessory={dropdown}
      selectedItemId={selectedId}
      onSelectionChange={(id) => setSelectedId(id ?? undefined)}
    >
      {emptyView}
      {mode === "trash" ? (
        <List.Section title="Trash" subtitle={trash.length ? String(trash.length) : undefined}>
          {trash.map((entry) => (
            <List.Item
              key={entry.fileName}
              id={`trash:${entry.fileName}`}
              icon={Icon.Trash}
              title={trashTitle(entry)}
              subtitle={trashedWhen(entry)}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action title="Restore from Trash" icon={Icon.Undo} onAction={() => void restore(entry)} />
                    <Action.ShowInFinder path={entry.path} />
                    <Action
                      title="Delete Permanently"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={Keyboard.Shortcut.Common.Remove}
                      onAction={() => void deletePermanently(entry)}
                    />
                  </ActionPanel.Section>
                  {generalActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : (
        <>
          {pinned.length ? <List.Section title="Pinned">{pinned.map(checklistItem)}</List.Section> : null}
          <List.Section title={mode === "archived" ? "Archived" : "Checklists"}>
            {others.map(checklistItem)}
          </List.Section>
        </>
      )}
      {list.problems.length && mode !== "trash" ? (
        <List.Section title="Could not open">
          {list.problems.map((p) => (
            <List.Item
              key={p.fileName}
              id={`problem:${p.fileName}`}
              icon={{ source: Icon.Warning, tintColor: Color.Orange }}
              title={p.fileName}
              subtitle={p.reason}
              actions={
                <ActionPanel>
                  <Action.ShowInFinder path={join(dir, p.fileName)} />
                  {generalActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}

function trashTitle(entry: TrashEntry): string {
  return entry.originalName.replace(/\.md$/i, "");
}

/** "2026-10-02T09-15-00-000Z" (timestamp() in store.ts) → local date and time. */
function trashedWhen(entry: TrashEntry): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(entry.trashedAt);
  if (!m) return "Trashed";
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(d.getTime()) ? "Trashed" : `Trashed ${d.toLocaleString()}`;
}

function ExportBackupForm(props: { session: ChecklistSession }) {
  const { pop } = useNavigation();
  const defaultDir = backupDefaultDir();
  try {
    mkdirSync(defaultDir, { recursive: true });
  } catch {
    // the picker still works without the default
  }
  async function submit(values: { dest: string[] }) {
    const dest = values.dest?.[0];
    if (!dest) {
      await showToast({ style: Toast.Style.Failure, title: "Choose a destination folder" });
      return;
    }
    try {
      props.session.saveState(); // the backup copies state.json from disk
      const { folder, manifest } = exportBackup(props.session.dir, statePath(), dest);
      await showToast({
        style: Toast.Style.Success,
        title: "Backup exported",
        message: `${manifest.files.length} checklist${manifest.files.length === 1 ? "" : "s"}${manifest.hasState ? " + local state" : ""}`,
        primaryAction: { title: "Show in Finder", onAction: () => void showInFinder(folder) },
      });
      pop();
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Export failed", message: errorText(e) });
    }
  }
  return (
    <Form
      navigationTitle="Export Backup"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Export Backup" icon={Icon.Upload} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description text="Copies every checklist file and the local state (day assignments, links, estimates) into a new dated folder inside the destination." />
      <Form.FilePicker
        id="dest"
        title="Destination"
        canChooseDirectories
        canChooseFiles={false}
        allowMultipleSelection={false}
        defaultValue={[defaultDir]}
      />
    </Form>
  );
}

function ImportBackupForm(props: { session: ChecklistSession; onImported: () => void }) {
  const { push } = useNavigation();
  async function submit(values: { folder: string[] }) {
    const folder = values.folder?.[0];
    if (!folder) {
      await showToast({ style: Toast.Style.Failure, title: "Choose a backup folder" });
      return;
    }
    try {
      const report = importBackup(folder, props.session.dir, props.session.state);
      props.session.saveState();
      props.onImported();
      push(<ImportReportView report={report} />);
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: "Import failed", message: errorText(e) });
    }
  }
  return (
    <Form
      navigationTitle="Import Backup"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Import Backup" icon={Icon.Download} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description text="Choose a my-day-backup-… folder. Newer checklists are never overwritten (the backup copy is saved beside them), and state entries are only added when missing." />
      <Form.FilePicker
        id="folder"
        title="Backup folder"
        canChooseDirectories
        canChooseFiles={false}
        allowMultipleSelection={false}
        defaultValue={[backupDefaultDir()]}
      />
    </Form>
  );
}

function ImportReportView({ report }: { report: ImportReport }) {
  const section = (title: string, items: string[]) =>
    items.length ? `### ${title} (${items.length})\n\n${items.map((i) => `- ${i}`).join("\n")}\n` : "";
  const md = [
    "# Import report",
    "",
    section("Restored", report.restored),
    section("Kept your newer version (backup saved beside it)", report.conflictCopies),
    section(
      "Skipped",
      report.skippedInvalid.map((s) => `${s.name}: ${s.reason}`),
    ),
    report.stateMerged
      ? `### Local state\n\n- Day assignments added: ${report.stateMerged.assignments}\n- Links added: ${report.stateMerged.links}${report.stateMerged.dropped.length ? `\n- Invalid entries dropped: ${report.stateMerged.dropped.length}` : ""}\n`
      : "### Local state\n\nNot included in this backup.\n",
    report.restored.length + report.conflictCopies.length + report.skippedInvalid.length === 0
      ? "Nothing to restore: every checklist in the backup is identical to the one on disk."
      : "",
  ].join("\n");
  return <Detail navigationTitle="Import Report" markdown={md} />;
}
