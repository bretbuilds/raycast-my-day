// Checklist document model: parse Markdown into prose blocks and a task tree, and serialize it back.
// Round trip of an unchanged document is byte-identical (SPEC §6). Unknown content is preserved verbatim.
//
// Rules (deterministic):
//  - A task line is `<indent><marker> [ ] title ^t-id` / `[x]`. Marker is -, * or +.
//  - Nesting: a task is a child of the nearest preceding task with a smaller indent width.
//  - A non-blank, non-task line with zero indent ends every open task and belongs to prose.
//  - Any other line after a task (indented content, blank lines, fenced code) is a detail line of the
//    innermost open task, stored verbatim so the file round-trips; it is dedented only for display.
//  - Lines inside a fenced code block are never task lines.
import { isTaskId, newTaskId } from "./ids.ts";

export interface TaskNode {
  kind: "task";
  id: string;
  title: string;
  checked: boolean;
  /** Leading whitespace of the task line as written. */
  indent: string;
  /** List marker as written: "-", "*" or "+". */
  marker: string;
  /** Detail lines exactly as written (including their indentation). */
  details: string[];
  children: TaskNode[];
}

export interface ProseBlock {
  kind: "prose";
  lines: string[];
}

export type Block = ProseBlock | TaskNode;

export interface Frontmatter {
  /** Raw lines between the --- fences, preserved for unknown keys. */
  lines: string[];
  values: Record<string, string>;
}

export interface LoadReport {
  assignedIds: string[];
  repairedDuplicateIds: string[];
  taskCount: number;
}

export interface ParsedDocument {
  frontmatter: Frontmatter | null;
  blocks: Block[];
  endsWithNewline: boolean;
  /** Indent unit for new children: the most common child/parent delta, else two spaces. */
  indentUnit: string;
  report: LoadReport;
}

const TASK_LINE = /^(\s*)([-*+])\s+\[([ xX])\](?:\s(.*))?$/;
const BLOCK_ID_SUFFIX = /(?:^|\s+)\^([A-Za-z0-9-]+)\s*$/;
const FENCE = /^(\s*)(```|~~~)/;

export function parseFrontmatter(lines: string[]): { frontmatter: Frontmatter | null; bodyStart: number } {
  if (lines[0] !== "---") return { frontmatter: null, bodyStart: 0 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      const fmLines = lines.slice(1, i);
      const values: Record<string, string> = {};
      for (const l of fmLines) {
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l);
        if (m) values[m[1]] = unquote(m[2].trim());
      }
      return { frontmatter: { lines: fmLines, values }, bodyStart: i + 1 };
    }
  }
  return { frontmatter: null, bodyStart: 0 };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    try {
      return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

function needsQuotes(v: string): boolean {
  return (
    v === "" ||
    /[:#"'\n\\]/.test(v) ||
    v !== v.trim() ||
    /^[-?&*!|>%@`[\]{}]/.test(v) ||
    /^(true|false|null|yes|no)$/i.test(v) ||
    /^[\d.+-]+$/.test(v)
  );
}

/** Returns a copy of the frontmatter with `key` set (or removed when value is null); other lines are untouched. */
export function setFrontmatterValue(
  fm: Frontmatter | null,
  key: string,
  value: string | number | boolean | null,
): Frontmatter {
  const base = fm ?? { lines: [], values: {} };
  const keyRe = new RegExp(`^${key}:`);
  const lines = base.lines.filter((l) => !keyRe.test(l));
  const values = { ...base.values };
  if (value === null) {
    delete values[key];
  } else {
    const scalar = typeof value === "string" ? (needsQuotes(value) ? JSON.stringify(value) : value) : String(value);
    const rendered = `${key}: ${scalar}`;
    const at = base.lines.findIndex((l) => keyRe.test(l));
    if (at >= 0) lines.splice(at, 0, rendered);
    else lines.push(rendered);
    values[key] = String(value);
  }
  return { lines, values };
}

export function width(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === "\t" ? 4 : 1;
  return w;
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** Column where a task's content starts: the indent width plus the marker and one space. */
export function contentColumn(node: TaskNode): number {
  return width(node.indent) + node.marker.length + 1;
}

interface Frame {
  node: TaskNode;
  indentWidth: number;
}

export function parseDocument(content: string, existingIds: Iterable<string> = []): ParsedDocument {
  const endsWithNewline = content.endsWith("\n");
  const rawLines = content.split("\n");
  if (endsWithNewline) rawLines.pop();
  const { frontmatter, bodyStart } = parseFrontmatter(rawLines);
  const lines = rawLines.slice(bodyStart);

  const blocks: Block[] = [];
  const report: LoadReport = { assignedIds: [], repairedDuplicateIds: [], taskCount: 0 };
  const seen = new Set<string>(existingIds);
  const stack: Frame[] = [];
  let prose: string[] | null = null;
  let inFence = false;
  let fenceWidth = 0;
  const deltas = new Map<string, number>();

  const flushProse = () => {
    if (prose && prose.length) blocks.push({ kind: "prose", lines: prose });
    prose = null;
  };
  const addProse = (line: string) => {
    if (!prose) prose = [];
    prose.push(line);
  };

  for (const line of lines) {
    const fence = FENCE.exec(line);
    const wasInFence = inFence;
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceWidth = width(fence[1]);
      } else if (width(fence[1]) <= fenceWidth) {
        inFence = false;
      }
    }
    const taskMatch = wasInFence || fence ? null : TASK_LINE.exec(line);
    if (taskMatch) {
      const [, indent, marker, box, restRaw] = taskMatch;
      const rest = restRaw ?? "";
      const indentWidth = width(indent);
      while (stack.length && stack[stack.length - 1].indentWidth >= indentWidth) stack.pop();
      let title = rest;
      let id: string | null = null;
      const idMatch = BLOCK_ID_SUFFIX.exec(rest);
      if (idMatch) {
        id = idMatch[1];
        title = rest.slice(0, idMatch.index);
      }
      if (!isTaskId(id)) {
        id = newTaskId();
        report.assignedIds.push(id);
      } else if (seen.has(id)) {
        report.repairedDuplicateIds.push(id);
        id = newTaskId();
      }
      seen.add(id);
      const node: TaskNode = {
        kind: "task",
        id,
        title: title.trimEnd(),
        checked: box !== " ",
        indent,
        marker,
        details: [],
        children: [],
      };
      if (stack.length) {
        const parent = stack[stack.length - 1].node;
        parent.children.push(node);
        if (indent.startsWith(parent.indent) && indent.length > parent.indent.length) {
          const unit = indent.slice(parent.indent.length);
          deltas.set(unit, (deltas.get(unit) ?? 0) + 1);
        }
      } else {
        flushProse();
        blocks.push(node);
      }
      stack.push({ node, indentWidth });
      report.taskCount++;
      continue;
    }
    const blank = line.trim() === "";
    if (!blank && width(leadingWhitespace(line)) === 0) {
      // A zero-indent content line ends every open task (fences at zero indent included).
      stack.length = 0;
      addProse(line);
      continue;
    }
    if (stack.length) stack[stack.length - 1].node.details.push(line);
    else addProse(line);
  }
  flushProse();

  let indentUnit = "  ";
  let best = 0;
  for (const [unit, n] of deltas) {
    if (n > best) {
      best = n;
      indentUnit = unit;
    }
  }
  return { frontmatter, blocks, endsWithNewline, indentUnit, report };
}

export function serializeTask(node: TaskNode, out: string[]): void {
  const box = node.checked ? "x" : " ";
  const title = node.title.length ? ` ${node.title}` : "";
  out.push(`${node.indent}${node.marker} [${box}]${title} ^${node.id}`);
  out.push(...node.details);
  for (const c of node.children) serializeTask(c, out);
}

export function serializeDocument(doc: ParsedDocument): string {
  const out: string[] = [];
  if (doc.frontmatter) out.push("---", ...doc.frontmatter.lines, "---");
  for (const b of doc.blocks) {
    if (b.kind === "prose") out.push(...b.lines);
    else serializeTask(b, out);
  }
  const body = out.join("\n");
  return body + (doc.endsWithNewline || body.length === 0 ? "\n" : "");
}

/** Details as the user sees them: dedented by the task's content column (less if a line is shallower). */
export function detailsText(node: TaskNode): string {
  const col = contentColumn(node);
  const lines = node.details.map((l) => dedent(l, col));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  while (lines.length && lines[0].trim() === "") lines.shift();
  return lines.join("\n");
}

function dedent(line: string, column: number): string {
  let removed = 0;
  let i = 0;
  while (i < line.length && removed < column) {
    const ch = line[i];
    if (ch === " ") removed += 1;
    else if (ch === "\t") removed += 4;
    else break;
    i++;
  }
  return line.slice(i);
}

/** Replaces the details with `text`, indented to the task's content column. Blank lines stay empty. */
export function setDetailsText(node: TaskNode, text: string): void {
  const pad = " ".repeat(contentColumn(node));
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  node.details = lines.map((l) => (l.trim() === "" ? "" : pad + l));
}

/** Re-indents a subtree to `depth` using `unit`; detail lines shift with their task. */
export function reindent(node: TaskNode, depth: number, unit: string): void {
  const oldCol = contentColumn(node);
  node.indent = unit.repeat(depth);
  const newCol = contentColumn(node);
  const pad = " ".repeat(newCol);
  node.details = node.details.map((l) => (l.trim() === "" ? "" : pad + dedent(l, oldCol)));
  for (const c of node.children) reindent(c, depth + 1, unit);
}

export function allTasks(blocks: Block[]): TaskNode[] {
  const out: TaskNode[] = [];
  const walk = (n: TaskNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  for (const b of blocks) if (b.kind === "task") walk(b);
  return out;
}

/** Title: first H1 in prose, else frontmatter title, else fallback. */
export function documentTitle(doc: ParsedDocument, fallback: string): string {
  for (const b of doc.blocks) {
    if (b.kind !== "prose") continue;
    for (const l of b.lines) {
      const m = /^#\s+(.+?)\s*$/.exec(l);
      if (m) return m[1];
    }
  }
  const t = doc.frontmatter?.values.title;
  return t && t.trim() ? t.trim() : fallback;
}

const URL_RE = /\bhttps?:\/\/[^\s<>()\]]+|\bmailto:[^\s<>()\]]+|\bobsidian:\/\/[^\s<>()\]]+/g;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Links found in a task's title and details: Markdown links first, then bare URLs, de-duplicated. */
export function extractLinks(node: TaskNode): { title: string; url: string }[] {
  const text = `${node.title}\n${detailsText(node)}`;
  const out: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MD_LINK_RE)) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      out.push({ title: m[1] || m[2], url: m[2] });
    }
  }
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push({ title: url, url });
    }
  }
  return out;
}

/** The document without its frontmatter, for the whole-document editor (the settings block is not user text). */
export function bodyText(doc: ParsedDocument): string {
  return serializeDocument({ ...doc, frontmatter: null }).replace(/^\n+/, "");
}

/** Re-attaches the original frontmatter to an edited body and makes sure the file ends with a line break. */
export function withOriginalFrontmatter(doc: ParsedDocument, body: string): string {
  const text = body.replace(/\r\n?/g, "\n");
  const ended = text.endsWith("\n") ? text : `${text}\n`;
  return doc.frontmatter ? `---\n${doc.frontmatter.lines.join("\n")}\n---\n${ended}` : ended;
}

const DISPLAY_FENCE = /^(\s*)(```|~~~)/;

/**
 * Markdown for display that keeps the line breaks the user typed: a non-empty line followed by another non-empty
 * line gets a hard break. Fenced code is left alone. Used for details panes and previews only, never saved.
 */
export function keepLineBreaks(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  return lines
    .map((line, i) => {
      if (DISPLAY_FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const next = lines[i + 1];
      // Only between two plain text lines: list items, headings, quotes, tables and fences break on their own.
      const plain = (l: string | undefined) =>
        l !== undefined && l.trim() !== "" && !/^\s*([-*+]\s|\d+[.)]\s|#|>|\||```|~~~)/.test(l);
      return plain(line) && plain(next) && !/ {2}$/.test(line) ? `${line}  ` : line;
    })
    .join("\n");
}
