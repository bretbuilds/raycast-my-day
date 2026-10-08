import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFolderFor, obsidianOpenUrl, obsidianVaults, vaultFor } from "../src/lib/obsidian.ts";

test("finds the innermost vault that contains a file", () => {
  const vaults = ["/v/Work", "/v/Work/Nested", "/v/Other/"];
  assert.equal(vaultFor("/v/Work/Projects/A.md", vaults), "/v/Work");
  assert.equal(vaultFor("/v/Work/Nested/B.md", vaults), "/v/Work/Nested");
  assert.equal(vaultFor("/v/Other/C.md", vaults), "/v/Other");
  assert.equal(vaultFor("/v/Workshop/C.md", vaults), null);
});

test("reads vault paths from Obsidian's config and tolerates a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-"));
  const cfg = join(dir, "obsidian.json");
  writeFileSync(cfg, JSON.stringify({ vaults: { a: { path: "/x/Work", ts: 1 }, b: { path: 3 } } }));
  assert.deepEqual(obsidianVaults(cfg), ["/x/Work"]);
  assert.deepEqual(obsidianVaults(join(dir, "missing.json")), []);
  assert.equal(obsidianOpenUrl("/x/Work/A b.md"), "obsidian://open?path=%2Fx%2FWork%2FA%20b.md");
});

test("export folder follows the checklist folder's vault, preferring its Inbox, else the fallback", () => {
  const vaults = ["/v/Notes", "/v/Other"];
  const has = (set: string[]) => (p: string) => set.includes(p);
  assert.equal(exportFolderFor("/v/Notes/Checklists", vaults, "/d", has(["/v/Notes/Inbox"])), "/v/Notes/Inbox");
  assert.equal(exportFolderFor("/v/Notes/Checklists", vaults, "/d", has([])), "/v/Notes");
  assert.equal(exportFolderFor("/v/Notes", vaults, "/d", has([])), "/v/Notes");
  assert.equal(exportFolderFor("/elsewhere/Checklists", vaults, "/d", has([])), "/d");
});
