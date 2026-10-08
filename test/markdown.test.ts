import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allTasks,
  bodyText,
  keepLineBreaks,
  withOriginalFrontmatter,
  detailsText,
  documentTitle,
  extractLinks,
  parseDocument,
  serializeDocument,
  setDetailsText,
  setFrontmatterValue,
} from "../src/lib/markdown.ts";
import { isTaskId } from "../src/lib/ids.ts";

const fixture = readFileSync(join(process.cwd(), "test/fixtures/demo-checklist.md"), "utf8");

test("A-C-1 round trip is byte-identical when every task already has an id", () => {
  const withIds = fixture.replace("- [ ] No id yet, gets one", "- [ ] No id yet, gets one ^t-aaaa0008");
  const doc = parseDocument(withIds);
  assert.equal(serializeDocument(doc), withIds);
  assert.equal(doc.report.taskCount, 8);
  assert.deepEqual(doc.report.assignedIds, []);
});

test("A-C-12 a task without an id gets one and the rest of the file is unchanged", () => {
  const doc = parseDocument(fixture);
  assert.equal(doc.report.assignedIds.length, 1);
  const out = serializeDocument(doc);
  const expected = fixture.replace(
    "- [ ] No id yet, gets one",
    `- [ ] No id yet, gets one ^${doc.report.assignedIds[0]}`,
  );
  assert.equal(out, expected);
  assert.ok(isTaskId(doc.report.assignedIds[0]));
});

test("A-C-4 prose, frontmatter, code fences and tables are preserved; code lines are not tasks", () => {
  const doc = parseDocument(fixture);
  const ids = allTasks(doc.blocks).map((t) => t.id);
  assert.ok(!ids.some((id) => id.includes("code")));
  assert.equal(doc.frontmatter?.values["custom-key"], "kept as is");
  const first = allTasks(doc.blocks)[0];
  assert.ok(detailsText(first).includes("- [ ] this is code, not a task"));
  assert.ok(detailsText(first).includes("- supporting bullet without a checkbox"));
  assert.ok(serializeDocument(doc).includes("| --- |"));
});

test("A-C-6 nesting reaches four levels and tab indentation nests", () => {
  const doc = parseDocument(fixture);
  const top = doc.blocks.filter((b) => b.kind === "task");
  assert.equal(top.length, 3);
  const announce = top[0];
  assert.equal(announce.kind, "task");
  if (announce.kind !== "task") return;
  assert.equal(announce.children.length, 1);
  const outline = announce.children[0];
  assert.equal(outline.children.length, 2);
  assert.equal(outline.children[0].children[0].title, "Four levels");
  const last = top[2];
  if (last.kind !== "task") return;
  assert.equal(last.children[0].title, "Tab-indented child");
  assert.equal(doc.indentUnit, "  ");
});

test("A-C-5 details keep paragraphs, pasted text and links; links are extracted", () => {
  const doc = parseDocument(fixture);
  const first = allTasks(doc.blocks)[0];
  const text = detailsText(first);
  assert.ok(text.startsWith("Draft it in the shared doc."));
  assert.ok(text.includes("\n\nSecond paragraph"));
  const links = extractLinks(first).map((l) => l.url);
  assert.deepEqual(links, ["https://example.com/one", "https://example.com/two"]);
});

test("A-C-12 duplicate ids inside one file are repaired and reported", () => {
  const dup = "- [ ] a ^t-dupe0001\n- [ ] b ^t-dupe0001\n";
  const doc = parseDocument(dup);
  assert.deepEqual(doc.report.repairedDuplicateIds, ["t-dupe0001"]);
  const ids = allTasks(doc.blocks).map((t) => t.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids[0], "t-dupe0001");
});

test("A-C-12 ids already used by another file are repaired", () => {
  const doc = parseDocument("- [ ] a ^t-used0001\n", ["t-used0001"]);
  assert.deepEqual(doc.report.repairedDuplicateIds, ["t-used0001"]);
});

test("checked state parses with x and X, and empty titles survive", () => {
  const doc = parseDocument("- [X] done ^t-xxxx0001\n- [ ] ^t-xxxx0002\n* [x] star ^t-xxxx0003\n");
  const t = allTasks(doc.blocks);
  assert.equal(t[0].checked, true);
  assert.equal(t[1].title, "");
  assert.equal(t[2].marker, "*");
  assert.equal(serializeDocument(doc), "- [x] done ^t-xxxx0001\n- [ ] ^t-xxxx0002\n* [x] star ^t-xxxx0003\n");
});

test("details are written at the content column and read back dedented", () => {
  const doc = parseDocument("- [ ] t ^t-dddd0001\n");
  const n = allTasks(doc.blocks)[0];
  setDetailsText(n, "line one\n\n  indented two\nhttps://x.y/z");
  assert.equal(serializeDocument(doc), "- [ ] t ^t-dddd0001\n  line one\n\n    indented two\n  https://x.y/z\n");
  assert.equal(detailsText(n), "line one\n\n  indented two\nhttps://x.y/z");
  assert.equal(extractLinks(n)[0].url, "https://x.y/z");
});

test("a file without frontmatter or trailing newline round-trips and gets a title from H1", () => {
  const src = "# Title here\n- [ ] a ^t-nofm0001";
  const doc = parseDocument(src);
  assert.equal(serializeDocument(doc), src);
  assert.equal(documentTitle(doc, "fallback"), "Title here");
  assert.equal(documentTitle(parseDocument("- [ ] a ^t-nofm0002\n"), "fallback"), "fallback");
});

test("frontmatter values can be set without disturbing unknown keys", () => {
  const doc = parseDocument(fixture);
  const fm = setFrontmatterValue(doc.frontmatter, "pinned", false);
  assert.equal(fm.values.pinned, "false");
  assert.ok(fm.lines.includes("custom-key: kept as is"));
  assert.equal(fm.lines.indexOf("pinned: false"), doc.frontmatter!.lines.indexOf("pinned: true"));
  const quoted = setFrontmatterValue(null, "title", "Plan: phase 2");
  assert.equal(quoted.lines[0], 'title: "Plan: phase 2"');
  assert.equal(parseDocument(`---\n${quoted.lines[0]}\n---\n`).frontmatter?.values.title, "Plan: phase 2");
});

test("A-D-2 pasted text is content only: a title containing shell or template syntax stays literal", () => {
  const nasty = "$(rm -rf ~) `echo hi` ${x} <script>alert(1)</script>";
  const doc = parseDocument(`- [ ] ${nasty} ^t-safe0001\n`);
  assert.equal(allTasks(doc.blocks)[0].title, nasty);
  assert.equal(serializeDocument(doc), `- [ ] ${nasty} ^t-safe0001\n`);
});

test("whole-document editing hides the frontmatter and re-attaches it unchanged, with a final line break", () => {
  const doc = parseDocument("---\nmyday: 1\nid: cl-body0001\ncustom: kept\n---\n# T\n- [ ] a ^t-body0001\n");
  assert.equal(bodyText(doc), "# T\n- [ ] a ^t-body0001\n");
  const saved = withOriginalFrontmatter(doc, "# T\n- [ ] a ^t-body0001\n- [ ] b");
  assert.equal(saved, "---\nmyday: 1\nid: cl-body0001\ncustom: kept\n---\n# T\n- [ ] a ^t-body0001\n- [ ] b\n");
});

test("display line breaks: typed lines stay separate, code fences untouched", () => {
  assert.equal(keepLineBreaks("one\ntwo\n\nthree"), "one  \ntwo\n\nthree");
  assert.equal(keepLineBreaks("```\na\nb\n```"), "```\na\nb\n```");
});
