// Shared plumbing for the Checklists UI (and later the My Day command): one state load per command mount,
// save-after-change, and uniform reporting of SaveResult outcomes. Engine logic stays in store.ts/tree.ts.
import { showInFinder, showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { checklistDir, statePath } from "./paths.ts";
import { createStateStore, type LocalState, type StateStore } from "./state.ts";
import {
  listChecklists,
  listTrash,
  normalizeChecklist,
  type ChecklistFile,
  type ListResult,
  type SaveResult,
  type TrashEntry,
} from "./store.ts";
import type { ParsedDocument } from "./markdown.ts";

export interface ChecklistSession {
  dir: string;
  store: StateStore;
  /** Loaded once per command mount; mutate it, then call saveState(). */
  state: LocalState;
  /** Writes state.json; shows a failure toast and returns false when it cannot. */
  saveState(): boolean;
  /** Called after any document write so lists above in the navigation stack can reload. */
  onFilesChanged: () => void;
}

export function createSession(dir = checklistDir(), path = statePath()): ChecklistSession {
  const store = createStateStore(path);
  const loaded = store.load();
  if (loaded.dropped.length) {
    void showToast({
      style: Toast.Style.Failure,
      title: loaded.corrupt ? "Local state was unreadable" : "Some local state was invalid",
      message: loaded.dropped.slice(0, 5).join("; "),
    });
  }
  const session: ChecklistSession = {
    dir,
    store,
    state: loaded.state,
    saveState() {
      try {
        store.save(session.state);
        return true;
      } catch (e) {
        void showToast({ style: Toast.Style.Failure, title: "Could not save local state", message: errorText(e) });
        return false;
      }
    },
    onFilesChanged: () => undefined,
  };
  return session;
}

/** One session per command mount (the state file is read exactly once). */
export function useChecklistSession(): ChecklistSession {
  const ref = useRef<ChecklistSession | null>(null);
  if (!ref.current) ref.current = createSession();
  return ref.current;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Records that a checklist was used (for the Recent sort). Does not save; callers save with their change. */
export function touchRecent(session: ChecklistSession, checklistId: string, now = new Date()): void {
  session.state.recent[checklistId] = now.toISOString();
}

const FAILURE_TITLES: Record<"not-applicable" | "read-only" | "conflict", string> = {
  "not-applicable": "Nothing changed",
  "read-only": "This checklist is read-only",
  conflict: "Not saved: the file changed outside My Day",
};

/**
 * Shows the right toast for a SaveResult and returns the fresh file on success (null otherwise).
 * `success` is shown only when the save was not re-applied (the re-applied toast replaces it).
 */
export async function reportSave(r: SaveResult, success?: { title: string; message?: string }) {
  if (!r.ok) {
    await showToast({
      style: Toast.Style.Failure,
      title: FAILURE_TITLES[r.reason],
      message: r.conflictPath ? `${r.message}\n${r.conflictPath}` : r.message,
      primaryAction: r.conflictPath
        ? { title: "Show in Finder", onAction: () => void showInFinder(r.conflictPath as string) }
        : undefined,
    });
    return null;
  }
  if (r.reapplied) {
    await showToast({
      style: Toast.Style.Success,
      title: "Applied to the version edited outside My Day",
      message: success?.title,
    });
  } else if (success) {
    await showToast({ style: Toast.Style.Success, title: success.title, message: success.message });
  }
  return r.file;
}

/**
 * Persists generated ids/frontmatter before anything in state.json references them. Returns the file to use
 * (unchanged when no normalization was needed) or null when the normalizing save failed.
 */
export async function ensureNormalized(session: ChecklistSession, file: ChecklistFile): Promise<ChecklistFile | null> {
  if (!file.needsNormalize || file.readOnlyReason) return file;
  const r = normalizeChecklist(session.dir, file);
  if (!r.ok) {
    await reportSave(r);
    return null;
  }
  await showToast({ style: Toast.Style.Success, title: `Added ids to ${r.file.title}` });
  session.onFilesChanged();
  return r.file;
}

export interface ChecklistsData {
  list: ListResult;
  trash: TrashEntry[];
  isLoading: boolean;
  reload: () => void;
}

/** Loads the checklist folder and the trash; `reload` re-reads both synchronously (files are local). */
export function useChecklists(session: ChecklistSession): ChecklistsData {
  const [data, setData] = useState<{ list: ListResult; trash: TrashEntry[] } | null>(null);
  const reload = useCallback(() => {
    try {
      setData({ list: listChecklists(session.dir), trash: listTrash(session.dir) });
    } catch (e) {
      setData({ list: { checklists: [], problems: [{ fileName: session.dir, reason: errorText(e) }] }, trash: [] });
    }
  }, [session]);
  useEffect(() => {
    session.onFilesChanged = reload;
    reload();
  }, [session, reload]);
  return {
    list: data?.list ?? { checklists: [], problems: [] },
    trash: data?.trash ?? [],
    isLoading: data === null,
    reload,
  };
}

const H1 = /^#\s+(.+?)\s*$/;

/** True when the document has a first-level heading (which then wins as the display title, SPEC §6 rule 5). */
export function hasFirstHeading(doc: ParsedDocument): boolean {
  return doc.blocks.some((b) => b.kind === "prose" && b.lines.some((l) => H1.test(l)));
}

/** Replaces the text of the first H1 (used only when the user asks for it on rename, or for a duplicate's copy). */
export function setFirstHeading(doc: ParsedDocument, title: string): boolean {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return false;
  for (const b of doc.blocks) {
    if (b.kind !== "prose") continue;
    const i = b.lines.findIndex((l) => H1.test(l));
    if (i >= 0) {
      b.lines[i] = `# ${clean}`;
      return true;
    }
  }
  return false;
}
