// Checklist storage: one Markdown file per checklist in a user-visible folder, atomic writes, snapshots,
// recoverable trash, conflict handling by re-applying operations on fresh content, and backup/restore.
// Pure Node; the folder and the clock are injected so tests use temporary directories.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isChecklistId, newChecklistId } from "./ids.ts";
import {
  allTasks,
  documentTitle,
  parseDocument,
  serializeDocument,
  setFrontmatterValue,
  type ParsedDocument,
} from "./markdown.ts";
import { regenerateIds, uncheckAll } from "./tree.ts";
import { emptyState, validateState, type LocalState } from "./state.ts";

export const META_DIR = ".myday";
export const SNAPSHOT_KEEP = 20;

export interface ChecklistFile {
  id: string;
  path: string;
  fileName: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  order: number;
  doc: ParsedDocument;
  hash: string;
  mtimeMs: number;
  /** Set when the file is opened read-only (newer format, undecodable); the UI explains and disables edits. */
  readOnlyReason?: string;
  /** True when the file needs a normalizing save (missing ids or frontmatter). */
  needsNormalize: boolean;
}

export interface ListResult {
  checklists: ChecklistFile[];
  problems: { fileName: string; reason: string }[];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 _-]+/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return s || "Checklist";
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Writes atomically: temp file in the same folder, then rename over the target. */
export function atomicWrite(path: string, content: string): void {
  const tmp = join(join(path, ".."), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    throw e;
  }
}

export function snapshotPath(dir: string, fileName: string, now: Date): string {
  return join(dir, META_DIR, "snapshots", `${fileName}.${timestamp(now)}.md`);
}

/** Copies the current on-disk content to the snapshots folder and prunes old snapshots of that file. */
export function snapshot(dir: string, fileName: string, now = new Date()): string | null {
  const src = join(dir, fileName);
  if (!existsSync(src)) return null;
  const snapDir = join(dir, META_DIR, "snapshots");
  ensureDir(snapDir);
  const dest = snapshotPath(dir, fileName, now);
  copyFileSync(src, dest);
  const mine = readdirSync(snapDir)
    .filter((f) => f.startsWith(`${fileName}.`) && f.endsWith(".md"))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - SNAPSHOT_KEEP)))
    rmSync(join(snapDir, old), { force: true });
  return dest;
}

export function listSnapshots(dir: string, fileName: string): string[] {
  const snapDir = join(dir, META_DIR, "snapshots");
  if (!existsSync(snapDir)) return [];
  return readdirSync(snapDir)
    .filter((f) => f.startsWith(`${fileName}.`) && f.endsWith(".md"))
    .sort()
    .reverse()
    .map((f) => join(snapDir, f));
}

function parseFlag(v: string | undefined): boolean {
  return v === "true" || v === "yes";
}

/** Reads and parses one checklist file. `knownTaskIds` lets duplicate ids across files be repaired. */
export function loadChecklist(path: string, knownTaskIds: Iterable<string> = []): ChecklistFile {
  const raw = readFileSync(path);
  const content = raw.toString("utf8");
  const st = statSync(path);
  const fileName = basename(path);
  const fallbackTitle = fileName.replace(/\.md$/i, "");
  let readOnlyReason: string | undefined;
  if (content.includes("�")) readOnlyReason = "File is not valid UTF-8 text";
  const doc = parseDocument(content, knownTaskIds);
  const fm = doc.frontmatter?.values ?? {};
  if (fm.myday && Number(fm.myday) > 1) readOnlyReason = `File uses a newer My Day format (${fm.myday})`;
  const id = isChecklistId(fm.id) ? fm.id : newChecklistId();
  const needsNormalize =
    !readOnlyReason &&
    (!isChecklistId(fm.id) || doc.report.assignedIds.length > 0 || doc.report.repairedDuplicateIds.length > 0);
  return {
    id,
    path,
    fileName,
    title: documentTitle(doc, fallbackTitle),
    pinned: parseFlag(fm.pinned),
    archived: parseFlag(fm.archived),
    order: Number.isFinite(Number(fm.order)) && fm.order !== undefined ? Number(fm.order) : Number.MAX_SAFE_INTEGER,
    doc,
    hash: sha256(content),
    mtimeMs: st.mtimeMs,
    readOnlyReason,
    needsNormalize,
  };
}

/**
 * Archived checklists live in this subfolder (D-012), so "shelving" a project is the same act in My Day and in
 * Obsidian: the note moves into Shelved/. A `archived: true` flag in a file outside it still counts as archived.
 */
export const SHELVED_DIR = "Shelved";

function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md") && !f.startsWith("."))
    .sort();
}

export function listChecklists(dir: string): ListResult {
  ensureDir(dir);
  const problems: ListResult["problems"] = [];
  const shelved = join(dir, SHELVED_DIR);
  const files = [
    ...mdFiles(dir).map((f) => ({ f, path: join(dir, f), shelved: false })),
    ...mdFiles(shelved).map((f) => ({ f: `${SHELVED_DIR}/${f}`, path: join(shelved, f), shelved: true })),
  ];
  const known = new Set<string>();
  const seenChecklistIds = new Set<string>();
  const checklists: ChecklistFile[] = [];
  for (const { f, path, shelved: isShelved } of files) {
    try {
      const c = loadChecklist(path, known);
      if (isShelved) c.archived = true;
      if (seenChecklistIds.has(c.id)) {
        c.id = newChecklistId();
        c.needsNormalize = true;
      }
      seenChecklistIds.add(c.id);
      for (const t of allTasks(c.doc.blocks)) known.add(t.id);
      checklists.push(c);
    } catch (e) {
      problems.push({ fileName: f, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  checklists.sort(compareChecklists);
  return { checklists, problems };
}

export function compareChecklists(a: ChecklistFile, b: ChecklistFile): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  return a.title.localeCompare(b.title);
}

function withMeta(
  doc: ParsedDocument,
  c: Pick<ChecklistFile, "id" | "pinned" | "archived" | "order">,
  title?: string,
): ParsedDocument {
  let fm = doc.frontmatter;
  fm = setFrontmatterValue(fm, "myday", 1);
  fm = setFrontmatterValue(fm, "id", c.id);
  if (title !== undefined) fm = setFrontmatterValue(fm, "title", title);
  fm = setFrontmatterValue(fm, "pinned", c.pinned);
  fm = setFrontmatterValue(fm, "archived", c.archived);
  fm = setFrontmatterValue(fm, "order", c.order === Number.MAX_SAFE_INTEGER ? 0 : c.order);
  return { ...doc, frontmatter: fm };
}

export type SaveResult =
  | { ok: true; file: ChecklistFile; reapplied: boolean; snapshot: string | null }
  | { ok: false; reason: "not-applicable" | "read-only" | "conflict"; message: string; conflictPath?: string };

/**
 * Applies `op` to the freshest content of the file and writes the result atomically.
 * If the file changed since `file` was loaded, the operation is re-applied on the new content (by task id);
 * when it cannot be applied there, nothing is written and the caller is told why.
 */
export function saveWithOperation(
  dir: string,
  file: ChecklistFile,
  op: (doc: ParsedDocument) => boolean,
  now = new Date(),
): SaveResult {
  if (file.readOnlyReason) return { ok: false, reason: "read-only", message: file.readOnlyReason };
  const current = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
  const changed = current === null || sha256(current) !== file.hash;
  let doc: ParsedDocument;
  if (changed && current !== null) {
    doc = parseDocument(current, []);
  } else {
    doc = parseDocument(serializeDocument(file.doc), []);
  }
  const applied = op(doc);
  if (!applied) {
    return {
      ok: false,
      reason: changed ? "conflict" : "not-applicable",
      message: changed
        ? "The file was edited outside My Day and the task is no longer there. Nothing was written."
        : "Nothing to change.",
    };
  }
  const meta = withMeta(doc, file);
  const content = serializeDocument(meta);
  const snap = snapshot(dir, file.fileName, now);
  atomicWrite(file.path, content);
  const reloaded = loadChecklist(file.path);
  reloaded.id = file.id;
  return { ok: true, file: reloaded, reapplied: changed && current !== null, snapshot: snap };
}

/**
 * Replaces the whole document (whole-document editor). When the file changed on disk meanwhile, both versions
 * are kept: theirs stays in place, ours is written beside it as a conflict copy, and the caller gets both paths.
 */
export function saveWholeDocument(dir: string, file: ChecklistFile, newContent: string, now = new Date()): SaveResult {
  if (file.readOnlyReason) return { ok: false, reason: "read-only", message: file.readOnlyReason };
  const current = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
  const parsed = parseDocument(newContent, []);
  const meta = withMeta(parsed, file);
  const content = serializeDocument(meta);
  if (current !== null && sha256(current) !== file.hash) {
    const conflictPath = join(dir, `${file.fileName.replace(/\.md$/i, "")} (My Day conflict ${timestamp(now)}).md`);
    atomicWrite(conflictPath, content);
    return {
      ok: false,
      reason: "conflict",
      message:
        "The file changed outside My Day. Your version was saved as a conflict copy; the external version was kept.",
      conflictPath,
    };
  }
  const snap = snapshot(dir, file.fileName, now);
  atomicWrite(file.path, content);
  const reloaded = loadChecklist(file.path);
  reloaded.id = file.id;
  return { ok: true, file: reloaded, reapplied: false, snapshot: snap };
}

function uniqueFileName(dir: string, base: string, exclude?: string): string {
  let name = `${base}.md`;
  let n = 2;
  while (existsSync(join(dir, name)) && name !== exclude) name = `${base}-${n++}.md`;
  return name;
}

export function createChecklist(dir: string, title: string, body = "", now = new Date()): ChecklistFile {
  ensureDir(dir);
  const clean = title.replace(/\s+/g, " ").trim() || "Untitled checklist";
  const fileName = uniqueFileName(dir, slug(clean));
  const existing = listChecklists(dir).checklists;
  const order = existing.reduce((m, c) => (c.order === Number.MAX_SAFE_INTEGER ? m : Math.max(m, c.order)), 0) + 1;
  const parsed = parseDocument(body.trim() ? body : `# ${clean}\n\n`, []);
  const doc = withMeta(parsed, { id: newChecklistId(), pinned: false, archived: false, order }, clean);
  const path = join(dir, fileName);
  atomicWrite(path, serializeDocument(doc));
  void now;
  return loadChecklist(path);
}

/** Persists ids and frontmatter for a file loaded without them (no content change otherwise). */
export function normalizeChecklist(dir: string, file: ChecklistFile, now = new Date()): SaveResult {
  return saveWithOperation(dir, file, () => true, now);
}

export function setChecklistMeta(
  dir: string,
  file: ChecklistFile,
  patch: Partial<Pick<ChecklistFile, "pinned" | "archived" | "order">>,
  now = new Date(),
): SaveResult {
  const next = { ...file, ...patch };
  const r = saveWithOperation(dir, next, () => true, now);
  if (!r.ok || patch.archived === undefined) return r;
  // Archive = move into Shelved/; restore = move back next to the other checklists.
  const target = patch.archived ? join(dir, SHELVED_DIR) : dir;
  if (dirname(file.path) === target) return r;
  ensureDir(target);
  const name = uniqueFileName(target, file.fileName.replace(/\.md$/i, ""));
  renameSync(file.path, join(target, name));
  const moved = loadChecklist(join(target, name));
  moved.id = r.file.id;
  moved.archived = patch.archived;
  return { ...r, file: moved };
}

/** Renames: updates frontmatter `title` and the file name; the H1 the user wrote is left alone. */
export function renameChecklist(dir: string, file: ChecklistFile, newTitle: string, now = new Date()): SaveResult {
  const clean = newTitle.replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, reason: "not-applicable", message: "Title cannot be empty." };
  const r = saveWithOperation(
    dir,
    file,
    (doc) => {
      doc.frontmatter = setFrontmatterValue(doc.frontmatter, "title", clean);
      return true;
    },
    now,
  );
  if (!r.ok) return r;
  const folder = dirname(file.path);
  const target = uniqueFileName(folder, slug(clean), file.fileName);
  if (target !== file.fileName) {
    renameSync(file.path, join(folder, target));
    const moved = loadChecklist(join(folder, target));
    moved.id = file.id;
    return { ...r, file: moved };
  }
  return r;
}

/** Copies the document with fresh task ids; links/assignments are the caller's (state) to clear. */
export function duplicateChecklist(
  dir: string,
  file: ChecklistFile,
  resetCheckboxes: boolean,
  now = new Date(),
): { file: ChecklistFile; idMap: Map<string, string> } {
  const doc = parseDocument(serializeDocument(file.doc), []);
  const idMap = regenerateIds(doc.blocks);
  if (resetCheckboxes) uncheckAll(doc.blocks);
  const title = `${file.title} copy`;
  const fileName = uniqueFileName(dir, slug(title));
  const existing = listChecklists(dir).checklists;
  const order = existing.reduce((m, c) => (c.order === Number.MAX_SAFE_INTEGER ? m : Math.max(m, c.order)), 0) + 1;
  const meta = withMeta(doc, { id: newChecklistId(), pinned: false, archived: false, order }, title);
  const path = join(dir, fileName);
  atomicWrite(path, serializeDocument(meta));
  void now;
  return { file: loadChecklist(path), idMap };
}

export interface TrashEntry {
  path: string;
  fileName: string;
  originalName: string;
  trashedAt: string;
}

export function trashChecklist(dir: string, file: ChecklistFile, now = new Date()): TrashEntry {
  const trashDir = join(dir, META_DIR, "trash");
  ensureDir(trashDir);
  const ts = timestamp(now);
  const dest = join(trashDir, `${file.fileName.replace(/\.md$/i, "")}.${ts}.md`);
  renameSync(file.path, dest);
  return { path: dest, fileName: basename(dest), originalName: file.fileName, trashedAt: ts };
}

export function listTrash(dir: string): TrashEntry[] {
  const trashDir = join(dir, META_DIR, "trash");
  if (!existsSync(trashDir)) return [];
  return (
    readdirSync(trashDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .map((f) => {
        const m = /^(.*)\.(\d{4}-\d{2}-\d{2}T[0-9-]+Z)\.md$/.exec(f);
        return { path: join(trashDir, f), fileName: f, originalName: m ? `${m[1]}.md` : f, trashedAt: m ? m[2] : "" };
      })
      // Newest first by trash time, not by name (owner test 2026-10-04).
      .sort((a, b) => b.trashedAt.localeCompare(a.trashedAt) || a.fileName.localeCompare(b.fileName))
  );
}

export function restoreFromTrash(dir: string, entry: TrashEntry): ChecklistFile {
  const target = uniqueFileName(dir, entry.originalName.replace(/\.md$/i, ""));
  renameSync(entry.path, join(dir, target));
  return loadChecklist(join(dir, target));
}

export function deleteFromTrash(entry: TrashEntry): void {
  rmSync(entry.path, { force: true });
}

// ---- Backup and restore --------------------------------------------------------------------------------------

export interface BackupManifest {
  schema: 1;
  app: "my-day";
  createdAt: string;
  files: { name: string; sha256: string; mtime: string }[];
  hasState: boolean;
}

export function exportBackup(
  dir: string,
  statePath: string | null,
  destRoot: string,
  now = new Date(),
): { folder: string; manifest: BackupManifest } {
  const folder = join(destRoot, `my-day-backup-${timestamp(now)}`);
  ensureDir(join(folder, "checklists"));
  const manifest: BackupManifest = {
    schema: 1,
    app: "my-day",
    createdAt: now.toISOString(),
    files: [],
    hasState: false,
  };
  for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md") && !f.startsWith("."))) {
    const content = readFileSync(join(dir, f), "utf8");
    writeFileSync(join(folder, "checklists", f), content);
    manifest.files.push({ name: f, sha256: sha256(content), mtime: statSync(join(dir, f)).mtime.toISOString() });
  }
  if (statePath && existsSync(statePath)) {
    copyFileSync(statePath, join(folder, "state.json"));
    manifest.hasState = true;
  }
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { folder, manifest };
}

export interface ImportReport {
  restored: string[];
  skippedNewer: string[];
  skippedInvalid: { name: string; reason: string }[];
  stateMerged: { assignments: number; links: number; dropped: string[] } | null;
  conflictCopies: string[];
}

/**
 * Restores a backup folder. Documents: a target that is newer than the backup is never overwritten; instead the
 * backup copy is written beside it as "(restored <ts>)". State: entries are added only when absent.
 */
export function importBackup(backupFolder: string, dir: string, state: LocalState, now = new Date()): ImportReport {
  const report: ImportReport = {
    restored: [],
    skippedNewer: [],
    skippedInvalid: [],
    stateMerged: null,
    conflictCopies: [],
  };
  const manifestPath = join(backupFolder, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("Not a My Day backup: manifest.json is missing");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch {
    throw new Error("Not a My Day backup: manifest.json is not valid JSON");
  }
  if (manifest.app !== "my-day" || manifest.schema !== 1 || !Array.isArray(manifest.files))
    throw new Error("Not a My Day backup: unexpected manifest");
  ensureDir(dir);
  const backupTime = new Date(manifest.createdAt).getTime();
  for (const entry of manifest.files) {
    const name = basename(String(entry.name));
    if (!name.toLowerCase().endsWith(".md") || name.startsWith(".") || name !== entry.name) {
      report.skippedInvalid.push({ name: String(entry.name), reason: "unsafe or non-Markdown file name" });
      continue;
    }
    const src = join(backupFolder, "checklists", name);
    if (!existsSync(src)) {
      report.skippedInvalid.push({ name, reason: "listed in manifest but missing" });
      continue;
    }
    const content = readFileSync(src, "utf8");
    if (sha256(content) !== entry.sha256) {
      report.skippedInvalid.push({ name, reason: "checksum mismatch" });
      continue;
    }
    try {
      parseDocument(content, []);
    } catch {
      report.skippedInvalid.push({ name, reason: "does not parse" });
      continue;
    }
    const target = join(dir, name);
    if (existsSync(target)) {
      const existing = readFileSync(target, "utf8");
      if (sha256(existing) === entry.sha256) continue; // identical
      if (statSync(target).mtimeMs > backupTime) {
        const copy = join(dir, `${name.replace(/\.md$/i, "")} (restored ${timestamp(now)}).md`);
        atomicWrite(copy, content);
        report.skippedNewer.push(name);
        report.conflictCopies.push(copy);
        continue;
      }
      snapshot(dir, name, now);
    }
    atomicWrite(target, content);
    report.restored.push(name);
  }
  if (manifest.hasState && existsSync(join(backupFolder, "state.json"))) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(backupFolder, "state.json"), "utf8"));
    } catch {
      raw = null;
    }
    const { state: incoming, dropped } = validateState(raw ?? emptyState());
    let assignments = 0;
    let links = 0;
    for (const [k, v] of Object.entries(incoming.assignments)) {
      if (state.assignments[k]) continue;
      state.assignments[k] = v;
      assignments++;
    }
    for (const [k, v] of Object.entries(incoming.links)) {
      if (state.links[k]) continue;
      state.links[k] = v;
      links++;
    }
    for (const [k, v] of Object.entries(incoming.estimates)) if (!state.estimates[k]) state.estimates[k] = v;
    report.stateMerged = { assignments, links, dropped };
  }
  return report;
}
