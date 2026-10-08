// Export of open reminders that have no due date, as one Markdown file grouped by list, so a backlog kept in
// Reminders can be sorted into project notes. Read-only: nothing is changed in Reminders. Pure (no Raycast imports)
// so tests can drive it.
import type { CalendarInfo, ReminderInfo } from "./eventkit-protocol.ts";

export interface ExportedReminder {
  itemId: string;
  externalId: string | null;
  listId: string;
  listTitle: string;
  title: string;
  created: string | null;
}

export interface UndatedExport {
  markdown: string;
  /** Identities of every exported reminder, kept outside the Markdown so a later cleanup can find the originals. */
  manifest: ExportedReminder[];
  listCount: number;
}

const UNKNOWN_LIST = "Other list";

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Indents every line so it stays inside the task's list item; blank lines stay blank. */
function indent(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `  ${l.trimEnd()}` : ""));
}

export function undatedRemindersExport(
  reminders: ReminderInfo[],
  lists: CalendarInfo[],
  dayLabel: string,
): UndatedExport {
  const titles = new Map(lists.map((l) => [l.id, l.title]));
  const undated = reminders.filter((r) => !r.isCompleted && !r.dueDay && oneLine(r.title));
  const groups = new Map<string, ReminderInfo[]>();
  for (const r of undated) {
    const t = titles.get(r.listId) ?? UNKNOWN_LIST;
    groups.set(t, [...(groups.get(t) ?? []), r]);
  }
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  // No H1: the file name is the title (Obsidian shows it as the inline title).
  const out: string[] = [
    undated.length === 0
      ? `No open reminders without a date (exported ${dayLabel}).`
      : `${undated.length} open reminder${undated.length === 1 ? "" : "s"} without a date, from ${names.length} list${names.length === 1 ? "" : "s"}, oldest first, exported ${dayLabel}. Nothing was changed in Reminders: move each task into a project note or Backlog, or delete it here.`,
  ];
  const manifest: ExportedReminder[] = [];
  for (const name of names) {
    const items = [...groups.get(name)!].sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
    out.push("", `## ${name} (${items.length})`, "");
    for (const r of items) {
      out.push(`- [ ] ${oneLine(r.title)}`);
      if (r.notes?.trim()) out.push(...indent(r.notes));
      if (r.url && !r.notes?.includes(r.url)) out.push(`  ${r.url}`);
      manifest.push({
        itemId: r.itemId,
        externalId: r.externalId,
        listId: r.listId,
        listTitle: name,
        title: r.title,
        created: r.created,
      });
    }
  }
  return { markdown: out.join("\n") + "\n", manifest, listCount: names.length };
}
