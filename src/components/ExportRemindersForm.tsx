// Export Undated Reminders (My Day Setup): writes every open reminder without a due date to one Markdown file in a
// folder the user picks, plus an identity manifest in the support folder. Read-only towards Reminders.
import {
  Action,
  ActionPanel,
  Form,
  Icon,
  Toast,
  environment,
  showInFinder,
  showToast,
  useNavigation,
} from "@raycast/api";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useState } from "react";
import * as ek from "../eventkit.ts";
import { dayKeyOf, formatDay } from "../lib/dates.ts";
import { failureText, type Failure } from "../lib/eventkit-protocol.ts";
import { exportFolderFor, obsidianVaults } from "../lib/obsidian.ts";
import { checklistDir } from "../lib/paths.ts";
import { undatedRemindersExport } from "../lib/reminders-export.ts";

/** The Obsidian vault that holds the checklist folder (its Inbox when present), else Downloads. */
function defaultFolder(): string {
  return exportFolderFor(checklistDir(), obsidianVaults(), join(homedir(), "Downloads"), existsSync);
}

/** Never overwrites: "Name.md", then "Name (2).md", … */
function freePath(dir: string, base: string): string {
  let p = join(dir, `${base}.md`);
  for (let n = 2; existsSync(p); n++) p = join(dir, `${base} (${n}).md`);
  return p;
}

function failed(f: Failure) {
  const t = failureText(f);
  return showToast({ style: Toast.Style.Failure, title: t.title, message: t.description });
}

export function ExportRemindersForm() {
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);

  async function submit(values: { folder: string[] }) {
    const dir = values.folder?.[0];
    if (!dir || !existsSync(dir)) {
      await showToast({ style: Toast.Style.Failure, title: "Choose an existing folder" });
      return;
    }
    setBusy(true);
    try {
      const [rems, cals] = await Promise.all([ek.listReminders(), ek.listCalendars()]);
      if (!rems.ok) return void failed(rems.failure);
      if (!cals.ok) return void failed(cals.failure);
      const now = new Date();
      const result = undatedRemindersExport(rems.value, cals.value.reminderLists ?? [], formatDay(dayKeyOf(now)));
      const file = freePath(dir, `Undated reminders ${dayKeyOf(now)}`);
      writeFileSync(file, result.markdown, { flag: "wx" });
      const manifestDir = join(environment.supportPath, "exports");
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        join(manifestDir, `undated-reminders-${now.getTime()}.json`),
        JSON.stringify({ file, exportedAt: now.toISOString(), reminders: result.manifest }, null, 2),
      );
      await showToast({
        style: Toast.Style.Success,
        title: `Exported ${result.manifest.length} undated reminders`,
        message: `${result.listCount} lists · Reminders unchanged`,
        primaryAction: { title: "Show in Finder", onAction: () => void showInFinder(file) },
      });
      pop();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      navigationTitle="Export Undated Reminders"
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Export" icon={Icon.Download} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description text="Writes every open reminder that has no due date to one Markdown file, grouped by list. Nothing is changed in Reminders." />
      <Form.FilePicker
        id="folder"
        title="Folder"
        canChooseDirectories
        canChooseFiles={false}
        allowMultipleSelection={false}
        defaultValue={[defaultFolder()]}
      />
    </Form>
  );
}
