// Operations on the task tree, addressed by task id. Every operation mutates the document in place and
// returns false when it is not applicable (unknown id, no sibling, would create a cycle, …).
import { newTaskId } from "./ids.ts";
import { reindent, setDetailsText, type Block, type ParsedDocument, type TaskNode } from "./markdown.ts";

export interface Located {
  node: TaskNode;
  parent: TaskNode | null;
  /** Sibling list: parent.children, or the top-level task list in document order. */
  siblings: TaskNode[];
  index: number;
  depth: number;
  chain: TaskNode[];
}

export function locate(doc: ParsedDocument, id: string): Located | null {
  const top = doc.blocks.filter((b): b is TaskNode => b.kind === "task");
  const walk = (nodes: TaskNode[], parent: TaskNode | null, depth: number, chain: TaskNode[]): Located | null => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return { node: n, parent, siblings: nodes, index: i, depth, chain };
      const found = walk(n.children, n, depth + 1, [...chain, n]);
      if (found) return found;
    }
    return null;
  };
  return walk(top, null, 0, []);
}

export function setChecked(doc: ParsedDocument, id: string, checked: boolean): boolean {
  const l = locate(doc, id);
  if (!l) return false;
  l.node.checked = checked; // children and parents are independent by default (SPEC §4.3)
  return true;
}

export function setTitle(doc: ParsedDocument, id: string, title: string): boolean {
  const l = locate(doc, id);
  if (!l) return false;
  l.node.title = title.replace(/\s+/g, " ").trim();
  return true;
}

export function setDetails(doc: ParsedDocument, id: string, text: string): boolean {
  const l = locate(doc, id);
  if (!l) return false;
  setDetailsText(l.node, text);
  return true;
}

function makeNode(
  doc: ParsedDocument,
  template: TaskNode | null,
  depth: number,
  title: string,
  details: string,
): TaskNode {
  const node: TaskNode = {
    kind: "task",
    id: newTaskId(),
    title: title.replace(/\s+/g, " ").trim(),
    checked: false,
    indent: template ? template.indent : doc.indentUnit.repeat(depth),
    marker: template ? template.marker : "-",
    details: [],
    children: [],
  };
  if (details.trim()) setDetailsText(node, details);
  return node;
}

/** Inserts a new task after `afterId` at the same level. Returns the new id. */
export function addSibling(doc: ParsedDocument, afterId: string, title: string, details = ""): string | null {
  const l = locate(doc, afterId);
  if (!l) return null;
  const node = makeNode(doc, l.node, l.depth, title, details);
  insertSibling(doc, l, node, l.index + 1);
  return node.id;
}

/** Appends a new task as the last child of `parentId`. Returns the new id. */
export function addChild(doc: ParsedDocument, parentId: string, title: string, details = ""): string | null {
  const l = locate(doc, parentId);
  if (!l) return null;
  const template = l.node.children[l.node.children.length - 1] ?? null;
  const node = makeNode(doc, template, l.depth + 1, title, details);
  if (!template) {
    node.indent = l.node.indent + doc.indentUnit;
    node.marker = l.node.marker;
  }
  l.node.children.push(node);
  return node.id;
}

/** Appends a top-level task at the end of the document. Returns the new id. */
export function addTopLevel(doc: ParsedDocument, title: string, details = ""): string {
  const top = doc.blocks.filter((b): b is TaskNode => b.kind === "task");
  const template = top[top.length - 1] ?? null;
  const node = makeNode(doc, template, 0, title, details);
  doc.blocks.push(node);
  return node.id;
}

function insertSibling(doc: ParsedDocument, l: Located, node: TaskNode, index: number): void {
  if (l.parent) {
    l.parent.children.splice(index, 0, node);
    return;
  }
  // Top level: siblings are interleaved with prose in doc.blocks; insert relative to the anchor block.
  const anchor = index > 0 ? l.siblings[index - 1] : null;
  if (!anchor) {
    const firstTaskAt = doc.blocks.findIndex((b) => b.kind === "task");
    doc.blocks.splice(firstTaskAt < 0 ? doc.blocks.length : firstTaskAt, 0, node);
    return;
  }
  const at = doc.blocks.indexOf(anchor);
  doc.blocks.splice(at + 1, 0, node);
}

function removeFromSiblings(doc: ParsedDocument, l: Located): void {
  if (l.parent) l.parent.children.splice(l.index, 1);
  else doc.blocks.splice(doc.blocks.indexOf(l.node), 1);
}

export function removeTask(doc: ParsedDocument, id: string): TaskNode | null {
  const l = locate(doc, id);
  if (!l) return null;
  removeFromSiblings(doc, l);
  return l.node;
}

export function moveUp(doc: ParsedDocument, id: string): boolean {
  const l = locate(doc, id);
  if (!l || l.index === 0) return false;
  if (l.parent) {
    l.parent.children.splice(l.index, 1);
    l.parent.children.splice(l.index - 1, 0, l.node);
  } else {
    const prev = l.siblings[l.index - 1];
    doc.blocks.splice(doc.blocks.indexOf(l.node), 1);
    doc.blocks.splice(doc.blocks.indexOf(prev), 0, l.node);
  }
  return true;
}

export function moveDown(doc: ParsedDocument, id: string): boolean {
  const l = locate(doc, id);
  if (!l || l.index >= l.siblings.length - 1) return false;
  if (l.parent) {
    l.parent.children.splice(l.index, 1);
    l.parent.children.splice(l.index + 1, 0, l.node);
  } else {
    const next = l.siblings[l.index + 1];
    doc.blocks.splice(doc.blocks.indexOf(l.node), 1);
    doc.blocks.splice(doc.blocks.indexOf(next) + 1, 0, l.node);
  }
  return true;
}

/** Makes the task the last child of its previous sibling; the subtree and details follow. */
export function indent(doc: ParsedDocument, id: string): boolean {
  const l = locate(doc, id);
  if (!l || l.index === 0) return false;
  const newParent = l.siblings[l.index - 1];
  removeFromSiblings(doc, l);
  newParent.children.push(l.node);
  reindent(l.node, l.depth + 1, doc.indentUnit);
  return true;
}

/** Moves the task out to become the sibling right after its parent; later siblings stay with the old parent. */
export function outdent(doc: ParsedDocument, id: string): boolean {
  const l = locate(doc, id);
  if (!l || !l.parent) return false;
  const parentLoc = locate(doc, l.parent.id);
  if (!parentLoc) return false;
  removeFromSiblings(doc, l);
  reindent(l.node, l.depth - 1, doc.indentUnit);
  insertSibling(doc, parentLoc, l.node, parentLoc.index + 1);
  return true;
}

/** Moves a subtree under a new parent (or to top level when null). Refuses cycles. */
export function setParent(doc: ParsedDocument, id: string, newParentId: string | null): boolean {
  const l = locate(doc, id);
  if (!l) return false;
  if (newParentId === id) return false;
  if (newParentId) {
    const target = locate(doc, newParentId);
    if (!target) return false;
    if (target.chain.some((n) => n.id === id)) return false; // would create a cycle
    removeFromSiblings(doc, l);
    target.node.children.push(l.node);
    reindent(l.node, target.depth + 1, doc.indentUnit);
  } else {
    if (!l.parent) return true;
    removeFromSiblings(doc, l);
    reindent(l.node, 0, doc.indentUnit);
    doc.blocks.push(l.node);
  }
  return true;
}

/** Fresh ids for every task (used by Duplicate). Returns old→new mapping. */
export function regenerateIds(blocks: Block[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (n: TaskNode) => {
    const fresh = newTaskId();
    map.set(n.id, fresh);
    n.id = fresh;
    n.children.forEach(walk);
  };
  for (const b of blocks) if (b.kind === "task") walk(b);
  return map;
}

export function uncheckAll(blocks: Block[]): void {
  const walk = (n: TaskNode) => {
    n.checked = false;
    n.children.forEach(walk);
  };
  for (const b of blocks) if (b.kind === "task") walk(b);
}

export interface Row {
  node: TaskNode;
  depth: number;
  parentChain: string[];
  hasChildren: boolean;
  collapsed: boolean;
}

/** Document-order rows for the list view; children of collapsed parents are omitted. */
export function flatten(doc: ParsedDocument, collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (n: TaskNode, depth: number, chain: string[]) => {
    const isCollapsed = collapsed.has(n.id);
    rows.push({ node: n, depth, parentChain: chain, hasChildren: n.children.length > 0, collapsed: isCollapsed });
    if (!isCollapsed) for (const c of n.children) walk(c, depth + 1, [...chain, n.title]);
  };
  for (const b of doc.blocks) if (b.kind === "task") walk(b, 0, []);
  return rows;
}

export function countTasks(blocks: Block[]): { total: number; done: number } {
  let total = 0;
  let done = 0;
  const walk = (n: TaskNode) => {
    total++;
    if (n.checked) done++;
    n.children.forEach(walk);
  };
  for (const b of blocks) if (b.kind === "task") walk(b);
  return { total, done };
}
