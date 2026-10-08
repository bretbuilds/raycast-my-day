import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChecklist,
  deleteFromTrash,
  duplicateChecklist,
  exportBackup,
  importBackup,
  listChecklists,
  listSnapshots,
  listTrash,
  loadChecklist,
  normalizeChecklist,
  renameChecklist,
  restoreFromTrash,
  saveWholeDocument,
  saveWithOperation,
  setChecklistMeta,
  trashChecklist,
} from "../src/lib/store.ts";
import { allTasks, serializeDocument } from "../src/lib/markdown.ts";
import { addChild, setChecked, setTitle } from "../src/lib/tree.ts";
import { emptyState } from "../src/lib/state.ts";

const fixture = readFileSync(join(process.cwd(), "test/fixtures/demo-checklist.md"), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "myday-store-"));

test("A-C-2 create, list, pin and order persist across reloads", () => {
  const dir = tmp();
  const a = createChecklist(dir, "Alpha");
  const b = createChecklist(dir, "Beta");
  assert.ok(existsSync(join(dir, "Alpha.md")) && existsSync(join(dir, "Beta.md")));
  const pinned = setChecklistMeta(dir, b, { pinned: true });
  assert.ok(pinned.ok);
  const list = listChecklists(dir).checklists;
  assert.deepEqual(
    list.map((c) => c.title),
    ["Beta", "Alpha"],
  );
  assert.equal(list[0].pinned, true);
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].order, 1);
  assert.ok(readFileSync(join(dir, "Beta.md"), "utf8").startsWith("---\nmyday: 1\nid: cl-"));
  void a;
});

test("A-C-13 saves are atomic with a snapshot and no temp files left behind", () => {
  const dir = tmp();
  const c = createChecklist(dir, "Snap", "- [ ] one ^t-snap0001\n");
  const r = saveWithOperation(dir, c, (doc) => setChecked(doc, "t-snap0001", true));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.snapshot && existsSync(r.snapshot));
  assert.ok(readFileSync(c.path, "utf8").includes("- [x] one ^t-snap0001"));
  assert.ok(!readdirSync(dir).some((f) => f.includes(".tmp-")));
  assert.equal(listSnapshots(dir, c.fileName).length, 1);
});

test("A-C-14 an operation is re-applied by id when the file changed outside My Day", () => {
  const dir = tmp();
  const c = createChecklist(dir, "Conflict", "- [ ] one ^t-conf0001\n- [ ] two ^t-conf0002\n");
  // External edit: rename task two and add a third.
  writeFileSync(c.path, readFileSync(c.path, "utf8").replace("two", "two renamed") + "- [ ] three ^t-conf0003\n");
  const r = saveWithOperation(dir, c, (doc) => setChecked(doc, "t-conf0001", true));
  assert.ok(r.ok && r.reapplied);
  const after = readFileSync(c.path, "utf8");
  assert.ok(after.includes("- [x] one ^t-conf0001"));
  assert.ok(after.includes("two renamed"));
  assert.ok(after.includes("three"));
});

test("A-C-14 when the task vanished externally nothing is written and the reason is explained", () => {
  const dir = tmp();
  const c = createChecklist(dir, "Gone", "- [ ] one ^t-gone0001\n");
  writeFileSync(c.path, "# Gone\n\nno tasks any more\n");
  const r = saveWithOperation(dir, c, (doc) => setChecked(doc, "t-gone0001", true));
  assert.ok(!r.ok && r.reason === "conflict");
  assert.equal(readFileSync(c.path, "utf8"), "# Gone\n\nno tasks any more\n");
});

test("A-C-14 whole-document save keeps both versions on conflict", () => {
  const dir = tmp();
  const c = createChecklist(dir, "Whole", "- [ ] one ^t-whol0001\n");
  writeFileSync(c.path, "# theirs\n");
  const r = saveWholeDocument(dir, c, "# ours\n- [ ] new ^t-whol0002\n");
  assert.ok(!r.ok && r.reason === "conflict" && r.conflictPath && existsSync(r.conflictPath));
  assert.equal(readFileSync(c.path, "utf8"), "# theirs\n");
  assert.ok(readFileSync(r.conflictPath!, "utf8").includes("# ours"));
});

test("A-C-12 a file without ids or frontmatter is normalized once and then round-trips", () => {
  const dir = tmp();
  writeFileSync(join(dir, "Plain.md"), "# Plain\n- [ ] no id\n  - [ ] child no id\n");
  const loaded = listChecklists(dir).checklists[0];
  assert.ok(loaded.needsNormalize);
  const r = normalizeChecklist(dir, loaded);
  assert.ok(r.ok);
  if (!r.ok) return;
  const text = readFileSync(loaded.path, "utf8");
  assert.ok(
    /^---\nmyday: 1\nid: cl-[a-z0-9]{8}\npinned: false\narchived: false\norder: 0\n---\n# Plain\n- \[ \] no id \^t-[a-z0-9]{8}\n {2}- \[ \] child no id \^t-[a-z0-9]{8}\n$/.test(
      text,
    ),
    text,
  );
  assert.equal(r.file.needsNormalize, false);
  assert.equal(r.file.id, loaded.id);
  // ids are stable afterwards
  assert.deepEqual(
    allTasks(loadChecklist(loaded.path).doc.blocks).map((t) => t.id),
    allTasks(r.file.doc.blocks).map((t) => t.id),
  );
});

test("A-C-12 duplicate task ids across two files are repaired in the later file", () => {
  const dir = tmp();
  writeFileSync(join(dir, "A.md"), "- [ ] a ^t-same0001\n");
  writeFileSync(join(dir, "B.md"), "- [ ] b ^t-same0001\n");
  const list = listChecklists(dir).checklists;
  const ids = list.flatMap((c) => allTasks(c.doc.blocks).map((t) => t.id));
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids[0], "t-same0001");
  assert.ok(list[1].needsNormalize);
});

test("rename updates frontmatter title and file name, leaves the H1 alone", () => {
  const dir = tmp();
  const c = createChecklist(dir, "Old name");
  const r = renameChecklist(dir, c, "New: name?");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.file.fileName, "New name.md");
  assert.ok(!existsSync(join(dir, "Old name.md")));
  const text = readFileSync(r.file.path, "utf8");
  assert.ok(text.includes('title: "New: name?"'));
  assert.ok(text.includes("# Old name"));
  assert.equal(r.file.title, "Old name"); // H1 wins for display; the user can edit it in the document
});

test("A-C-10 duplicate gives fresh task ids and a fresh checklist id; reset is optional", () => {
  const dir = tmp();
  const c = createChecklist(dir, "Dup", "- [x] done ^t-dupx0001\n  - [ ] child ^t-dupx0002\n");
  const keep = duplicateChecklist(dir, c, false);
  const reset = duplicateChecklist(dir, c, true);
  assert.notEqual(keep.file.id, c.id);
  assert.equal(keep.idMap.size, 2);
  const keepTasks = allTasks(keep.file.doc.blocks);
  assert.ok(keepTasks.every((t) => !["t-dupx0001", "t-dupx0002"].includes(t.id)));
  assert.equal(keepTasks[0].checked, true);
  assert.equal(allTasks(reset.file.doc.blocks)[0].checked, false);
  assert.deepEqual(
    listChecklists(dir)
      .checklists.map((x) => x.fileName)
      .sort(),
    ["Dup copy-2.md", "Dup copy.md", "Dup.md"],
  );
});

test("A-C-11 trash is recoverable and permanent delete only works from the trash", () => {
  const dir = tmp();
  const c = createChecklist(dir, "Trashy", "- [ ] t ^t-trsh0001\n");
  const entry = trashChecklist(dir, c);
  assert.ok(!existsSync(c.path));
  assert.equal(listTrash(dir).length, 1);
  assert.equal(listTrash(dir)[0].originalName, "Trashy.md");
  const back = restoreFromTrash(dir, entry);
  assert.equal(back.fileName, "Trashy.md");
  assert.ok(allTasks(back.doc.blocks)[0].id === "t-trsh0001");
  const entry2 = trashChecklist(dir, back);
  deleteFromTrash(entry2);
  assert.equal(listTrash(dir).length, 0);
});

test("A-C-15 backup exports documents and state; import never overwrites newer files silently", () => {
  const dir = tmp();
  const c = createChecklist(dir, "Backup me", fixture);
  const statePath = join(dir, "state.json");
  const state = emptyState();
  state.assignments["t-aaaa0001"] = { day: "2026-10-02", checklistId: c.id, assignedAt: "x" };
  writeFileSync(statePath, JSON.stringify(state));
  const dest = tmp();
  const { folder, manifest } = exportBackup(dir, statePath, dest, new Date("2026-10-02T12:00:00Z"));
  assert.equal(manifest.files.length, 1);
  assert.ok(manifest.hasState);
  // Case 1: target newer than backup → kept, backup written as a restored copy.
  writeFileSync(c.path, "# edited later\n");
  utimesSync(c.path, new Date("2026-10-02T13:00:00Z"), new Date("2026-10-02T13:00:00Z"));
  const fresh = emptyState();
  const r1 = importBackup(folder, dir, fresh, new Date("2026-10-02T14:00:00Z"));
  assert.deepEqual(r1.skippedNewer, ["Backup me.md"]);
  assert.equal(r1.conflictCopies.length, 1);
  assert.equal(readFileSync(c.path, "utf8"), "# edited later\n");
  assert.equal(r1.stateMerged?.assignments, 1);
  assert.deepEqual(fresh.assignments["t-aaaa0001"].day, "2026-10-02");
  // Case 2: target older than backup → restored with a snapshot.
  utimesSync(c.path, new Date("2026-10-02T11:00:00Z"), new Date("2026-10-02T11:00:00Z"));
  const r2 = importBackup(folder, dir, fresh, new Date("2026-10-02T15:00:00Z"));
  assert.deepEqual(r2.restored, ["Backup me.md"]);
  assert.ok(readFileSync(c.path, "utf8").includes("Demo launch checklist"));
  assert.equal(listSnapshots(dir, "Backup me.md").length, 1);
  // Case 3: tampered checksum is refused.
  writeFileSync(join(folder, "checklists", "Backup me.md"), "tampered\n");
  const r3 = importBackup(folder, dir, fresh);
  assert.equal(r3.skippedInvalid[0].reason, "checksum mismatch");
  // Case 4: not a backup.
  assert.throws(() => importBackup(dest, dir, fresh), /manifest/);
});

test("read-only files are not written", () => {
  const dir = tmp();
  writeFileSync(join(dir, "Future.md"), "---\nmyday: 2\nid: cl-futr0001\n---\n- [ ] x ^t-futr0001\n");
  const c = listChecklists(dir).checklists[0];
  assert.ok(c.readOnlyReason);
  const r = saveWithOperation(dir, c, (doc) => setTitle(doc, "t-futr0001", "y"));
  assert.ok(!r.ok && r.reason === "read-only");
  const r2 = saveWithOperation(
    dir,
    { ...c, readOnlyReason: undefined },
    (doc) => addChild(doc, "t-futr0001", "z") !== null,
  );
  assert.ok(r2.ok);
  void serializeDocument;
});

test("owner test: trash lists the most recently trashed checklist first, regardless of name", () => {
  const dir = tmp();
  const a = createChecklist(dir, "Zeta");
  const b = createChecklist(dir, "Alpha");
  trashChecklist(dir, a, new Date("2026-10-04T10:00:00Z"));
  trashChecklist(dir, b, new Date("2026-10-04T11:00:00Z"));
  assert.deepEqual(
    listTrash(dir).map((e) => e.originalName),
    ["Alpha.md", "Zeta.md"],
  );
  trashChecklist(dir, restoreFromTrash(dir, listTrash(dir)[1]), new Date("2026-10-04T12:00:00Z"));
  assert.deepEqual(
    listTrash(dir).map((e) => e.originalName),
    ["Zeta.md", "Alpha.md"],
  );
});

test("D-012 archiving moves a checklist into Shelved/ and restoring moves it back; Shelved files list as archived", async () => {
  const { mkdtempSync: mk, existsSync: ex, writeFileSync: wr, mkdirSync: md } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const { join: j } = await import("node:path");
  const { createChecklist: create, listChecklists: list, setChecklistMeta: meta } = await import("../src/lib/store.ts");
  const dir = mk(j(td(), "shelf-"));
  const c = create(dir, "Website", "- [ ] One\n");
  const r = meta(dir, c, { archived: true });
  assert.ok(r.ok);
  assert.ok(!ex(c.path));
  assert.ok(ex(j(dir, "Shelved", c.fileName)));
  let all = list(dir).checklists;
  assert.equal(all.length, 1);
  assert.equal(all[0].archived, true);
  assert.equal(all[0].id, c.id);
  const back = meta(dir, all[0], { archived: false });
  assert.ok(back.ok);
  assert.ok(ex(c.path));
  // A note moved into Shelved/ by hand (e.g. in Obsidian) counts as archived without a flag.
  md(j(dir, "Shelved"), { recursive: true });
  wr(j(dir, "Shelved", "Old project.md"), "# Old project\n\n- [ ] Thing\n");
  all = list(dir).checklists;
  assert.deepEqual(
    all.map((x) => [x.title, x.archived]),
    [
      ["Website", false],
      ["Old project", true],
    ],
  );
});
