// Read-only preview of a checklist document for Raycast's `Detail` markdown prop (SPEC §2.1, A-C-7).
// Raycast does not document GFM task-list rendering, so task lines are rewritten to plain ☐/☑ glyphs that do not
// look clickable. The list marker and indentation are kept so nesting still renders as nested bullets; the
// `^t-id` block ids are stripped; frontmatter is dropped (it is shown as metadata instead); prose and fenced code
// are left exactly as written. Pure: no I/O.
import { keepLineBreaks, parseFrontmatter } from "./markdown.ts";

const TASK_LINE = /^(\s*)([-*+])\s+\[([ xX])\](?:\s(.*))?$/;
const BLOCK_ID_SUFFIX = /(?:^|\s+)\^[A-Za-z0-9-]+\s*$/;
const FENCE = /^(\s*)(```|~~~)/;

export const UNCHECKED_GLYPH = "☐";
export const CHECKED_GLYPH = "☑";

function width(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === "\t" ? 4 : 1;
  return w;
}

/** Rewrites one task line, or returns null when the line is not a task line. */
export function previewTaskLine(line: string): string | null {
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  const [, indent, marker, box, restRaw] = m;
  const title = (restRaw ?? "").replace(BLOCK_ID_SUFFIX, "").trimEnd();
  const glyph = box === " " ? UNCHECKED_GLYPH : CHECKED_GLYPH;
  return `${indent}${marker} ${glyph}${title ? ` ${title}` : ""}`;
}

export function previewMarkdown(content: string): string {
  const rawLines = content.replace(/\r\n?/g, "\n").split("\n");
  const { bodyStart } = parseFrontmatter(rawLines);
  const out: string[] = [];
  let inFence = false;
  let fenceWidth = 0;
  let lastWasTask = false;
  for (const line of rawLines.slice(bodyStart)) {
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
    const rewritten = wasInFence || fence ? null : previewTaskLine(line);
    // A task line directly followed by its details: a blank line makes the details their own paragraph inside
    // the list item instead of running on after the title.
    if (!rewritten && line.trim() && lastWasTask) out.push("");
    out.push(rewritten ?? line);
    lastWasTask = rewritten !== null;
  }
  while (out.length && out[0].trim() === "") out.shift();
  return keepLineBreaks(out.join("\n"));
}
