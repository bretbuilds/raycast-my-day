import { test } from "node:test";
import assert from "node:assert/strict";
import { previewMarkdown, previewTaskLine } from "../src/lib/preview.ts";

test("A-C-7 task lines become glyphs with indentation kept and ids stripped", () => {
  const src = [
    "- [ ] Write the announcement ^t-a1b2c3d4",
    "  - [x] Draft outline ^t-e5f6g7h8",
    "    * [X] Deep item ^t-i9j0k1l2",
    "+ [ ] No id here",
    "- [ ]",
  ].join("\n");
  assert.equal(
    previewMarkdown(src),
    ["- ☐ Write the announcement", "  - ☑ Draft outline", "    * ☑ Deep item", "+ ☐ No id here", "- ☐"].join("\n"),
  );
});

test("prose, details and non-task bullets are untouched", () => {
  const src = [
    "# Title",
    "Some prose with a link https://example.com and `code`.",
    "- plain bullet",
    "- [ ] Task ^t-prev0001",
    "  Details line with **bold** ^not-an-id-at-start",
    "  - supporting bullet",
  ].join("\n");
  const out = previewMarkdown(src).split("\n");
  assert.equal(out[0], "# Title");
  assert.equal(out[1], "Some prose with a link https://example.com and `code`.");
  assert.equal(out[2], "- plain bullet");
  assert.equal(out[3], "- ☐ Task");
  assert.equal(out[4], ""); // details become their own paragraph inside the item (owner test 2026-10-04)
  assert.equal(out[5], "  Details line with **bold** ^not-an-id-at-start");
  assert.equal(out[6], "  - supporting bullet");
});

test("fenced code is untouched, including task-looking lines", () => {
  const src = ["```md", "- [ ] inside fence ^t-fenc0001", "```", "~~~", "- [x] tilde ^t-fenc0002", "~~~"].join("\n");
  assert.equal(previewMarkdown(src), src);
});

test("an indented fence inside details is untouched until it closes", () => {
  const src = ["- [ ] Task ^t-fenc0003", "  ```", "  - [ ] code ^t-fenc0004", "  ```", "- [x] after ^t-fenc0005"].join(
    "\n",
  );
  assert.equal(
    previewMarkdown(src),
    ["- ☐ Task", "", "  ```", "  - [ ] code ^t-fenc0004", "  ```", "- ☑ after"].join("\n"),
  );
});

test("frontmatter is dropped from the preview", () => {
  const src = "---\nmyday: 1\nid: cl-abcdefgh\n---\n# Doc\n- [ ] a ^t-fm000001\n";
  assert.equal(previewMarkdown(src), "# Doc\n- ☐ a\n");
});

test("previewTaskLine returns null for non-task lines", () => {
  assert.equal(previewTaskLine("just text"), null);
  assert.equal(previewTaskLine("- [y] not a box"), null);
});

test("owner test: a task's details render as their own paragraph with line breaks kept", () => {
  const md = previewMarkdown(
    "- [ ] Plan the trip ^t-prev0009\n  Book flights first.\n  Budget: 1200 CAD\n  - [x] Child ^t-prev0010\n",
  );
  assert.equal(md, "- ☐ Plan the trip\n\n  Book flights first.  \n  Budget: 1200 CAD\n  - ☑ Child\n");
});
