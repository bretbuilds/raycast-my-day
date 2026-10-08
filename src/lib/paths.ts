// Where My Day keeps things. Documents: a user-visible folder (preference or the documented default).
// State: the extension's own support directory. Nothing is ever read from the Obsidian vault at large.
import { environment, getPreferenceValues } from "@raycast/api";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CHECKLIST_DIR = join(homedir(), "Library", "Application Support", "My Day", "Checklists");

export function checklistDir(): string {
  const prefs = getPreferenceValues<{ checklistFolder?: string }>();
  const p = prefs.checklistFolder?.trim();
  return p ? p : DEFAULT_CHECKLIST_DIR;
}

export function statePath(): string {
  return join(environment.supportPath, "state.json");
}

export function backupDefaultDir(): string {
  return join(homedir(), "Library", "Application Support", "My Day", "Backups");
}
