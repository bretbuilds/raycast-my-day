import { test } from "node:test";
import assert from "node:assert/strict";
import { allTasks, parseDocument, serializeDocument } from "../src/lib/markdown.ts";
import {
  addChild,
  addSibling,
  addTopLevel,
  countTasks,
  flatten,
  indent,
  locate,
  moveDown,
  moveUp,
  outdent,
  regenerateIds,
  removeTask,
  setChecked,
  setParent,
  uncheckAll,
} from "../src/lib/tree.ts";

const SRC = `# Doc
- [ ] A ^t-tree0001
  detail of A
  - [ ] A1 ^t-tree0002
    - [ ] A1a ^t-tree0003
  - [ ] A2 ^t-tree0004
prose between
- [ ] B ^t-tree0005
- [ ] C ^t-tree0006
`;

const fresh = () => parseDocument(SRC);
const order = (doc: ReturnType<typeof parseDocument>) =>
  allTasks(doc.blocks)
    .map((t) => t.title)
    .join(" ");

test("A-C-6 parent completion is independent of children", () => {
  const doc = fresh();
  assert.ok(setChecked(doc, "t-tree0001", true));
  const a1 = locate(doc, "t-tree0002")!.node;
  assert.equal(a1.checked, false);
  assert.ok(serializeDocument(doc).includes("- [x] A ^t-tree0001"));
});

test("A-C-6 move up/down swaps siblings and keeps subtrees and details", () => {
  const doc = fresh();
  assert.ok(moveDown(doc, "t-tree0002"));
  assert.equal(order(doc), "A A2 A1 A1a B C");
  assert.ok(moveUp(doc, "t-tree0002"));
  assert.equal(order(doc), "A A1 A1a A2 B C");
  assert.equal(moveUp(doc, "t-tree0002"), false);
  assert.ok(moveUp(doc, "t-tree0006")); // top-level across prose
  assert.equal(order(doc), "A A1 A1a A2 C B");
  assert.equal(
    serializeDocument(doc),
    `# Doc
- [ ] A ^t-tree0001
  detail of A
  - [ ] A1 ^t-tree0002
    - [ ] A1a ^t-tree0003
  - [ ] A2 ^t-tree0004
prose between
- [ ] C ^t-tree0006
- [ ] B ^t-tree0005
`,
  );
});

test("A-C-6 indent makes the previous sibling the parent and re-indents the subtree", () => {
  const doc = fresh();
  assert.equal(indent(doc, "t-tree0001"), false);
  assert.ok(indent(doc, "t-tree0004"));
  const a1 = locate(doc, "t-tree0002")!.node;
  assert.equal(a1.children.map((c) => c.title).join(","), "A1a,A2");
  assert.ok(serializeDocument(doc).includes("    - [ ] A2 ^t-tree0004"));
  assert.ok(indent(doc, "t-tree0006"));
  assert.equal(locate(doc, "t-tree0006")!.depth, 1);
  assert.equal(locate(doc, "t-tree0006")!.parent!.id, "t-tree0005");
});

test("A-C-6 outdent moves the task after its parent; later siblings stay", () => {
  const doc = fresh();
  assert.equal(outdent(doc, "t-tree0001"), false);
  assert.ok(outdent(doc, "t-tree0002"));
  assert.equal(order(doc), "A A2 A1 A1a B C");
  const a1 = locate(doc, "t-tree0002")!;
  assert.equal(a1.depth, 0);
  assert.equal(a1.node.children[0].indent, "  ");
  assert.equal(
    serializeDocument(doc),
    `# Doc
- [ ] A ^t-tree0001
  detail of A
  - [ ] A2 ^t-tree0004
- [ ] A1 ^t-tree0002
  - [ ] A1a ^t-tree0003
prose between
- [ ] B ^t-tree0005
- [ ] C ^t-tree0006
`,
  );
});

test("A-C-6 setParent rejects cycles and self, moves subtrees with details", () => {
  const doc = fresh();
  assert.equal(setParent(doc, "t-tree0001", "t-tree0003"), false);
  assert.equal(setParent(doc, "t-tree0001", "t-tree0001"), false);
  assert.ok(setParent(doc, "t-tree0001", "t-tree0006"));
  assert.equal(order(doc), "B C A A1 A1a A2");
  assert.ok(
    serializeDocument(doc).includes(
      "  - [ ] A ^t-tree0001\n    detail of A\n    - [ ] A1 ^t-tree0002\n      - [ ] A1a ^t-tree0003",
    ),
  );
  assert.ok(setParent(doc, "t-tree0003", null));
  assert.equal(locate(doc, "t-tree0003")!.depth, 0);
});

test("add sibling, child and top-level tasks get fresh ids and inherit indentation", () => {
  const doc = fresh();
  const s = addSibling(doc, "t-tree0004", "A3", "with details\nsecond")!;
  const c = addChild(doc, "t-tree0003", "A1a-i")!;
  const t = addTopLevel(doc, "D");
  const ids = allTasks(doc.blocks).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(serializeDocument(doc).includes("  - [ ] A3 ^" + s + "\n    with details\n    second\n"));
  assert.ok(serializeDocument(doc).includes("      - [ ] A1a-i ^" + c));
  assert.ok(serializeDocument(doc).endsWith("- [ ] D ^" + t + "\n"));
  assert.equal(addSibling(doc, "t-nope0000", "x"), null);
});

test("A-C-10 regenerateIds gives every task a new id and uncheckAll resets boxes", () => {
  const doc = fresh();
  setChecked(doc, "t-tree0005", true);
  const before = allTasks(doc.blocks).map((x) => x.id);
  const map = regenerateIds(doc.blocks);
  const after = allTasks(doc.blocks).map((x) => x.id);
  assert.equal(map.size, before.length);
  assert.ok(after.every((id, i) => id !== before[i] && map.get(before[i]) === id));
  uncheckAll(doc.blocks);
  assert.equal(countTasks(doc.blocks).done, 0);
});

test("flatten hides collapsed children and reports context", () => {
  const doc = fresh();
  const rows = flatten(doc, new Set(["t-tree0002"]));
  assert.deepEqual(
    rows.map((r) => r.node.title),
    ["A", "A1", "A2", "B", "C"],
  );
  assert.deepEqual(rows[2].parentChain, ["A"]);
  assert.equal(rows[1].collapsed, true);
});

test("removeTask removes the subtree", () => {
  const doc = fresh();
  const removed = removeTask(doc, "t-tree0002")!;
  assert.equal(removed.children.length, 1);
  assert.equal(order(doc), "A A2 B C");
});
