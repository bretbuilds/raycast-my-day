// Left "column" for list titles (owner feedback 2026-10-04). Raycast lists have no columns and draw titles in the
// proportional system font, where runs of ASCII spaces collapse and "1" is narrower than "0". So each label is
// padded with Unicode spaces of measured width (src/lib/font-widths.ts) to one fixed width, which puts every
// title on the page at the same horizontal position, within about a point.
import { WIDTHS } from "./font-widths.ts";
import { partsIn } from "./dates.ts";

const PADS: [string, number][] = [
  [" ", WIDTHS[" "]], // em space
  [" ", WIDTHS[" "]], // en space
  [" ", WIDTHS[" "]], // punctuation space
  [" ", WIDTHS[" "]], // thin space
  [" ", WIDTHS[" "]], // hair space
];
/** Invisible, non-whitespace anchor so a title that starts with padding is not trimmed. */
const ANCHOR = "‍";
/** Space between the column and the title, in points at 14 pt. */
export const COLUMN_GAP = 20;
/** Extra width for empty labels, from the on-screen check (one hair space). */
export const EMPTY_LABEL_NUDGE = WIDTHS["\u200A"];

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch === ANCHOR ? 0 : (WIDTHS[ch] ?? 8);
  return w;
}

/** Appends spaces so `s` is `target` points wide (never shorter than itself). */
export function padTo(s: string, target: number): string {
  let rem = target - textWidth(s);
  let out = s;
  for (const [c, cw] of PADS) {
    while (rem >= cw - 0.05) {
      out += c;
      rem -= cw;
    }
  }
  return out;
}

function clock(d: Date, use24: boolean): string {
  const p = partsIn(d);
  if (use24) return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** Widest single time in the clock style ("4" is the widest digit). */
export function timeSlot(use24: boolean): number {
  return textWidth(use24 ? "44:44" : "44:44 AM") + 1;
}

/** "2:15 PM – 3:15 PM" with natural spacing; the column padding after it aligns the titles. */
export function rangeLabel(start: Date, end: Date | null, use24: boolean): string {
  const s = clock(start, use24);
  return end ? `${s} – ${clock(end, use24)}` : s;
}

/** Column width that fits a time range, a date ("Wed 28 Oct") and a date range ("28 Oct – 28 Oct"). */
export function columnWidth(use24: boolean): number {
  const range = timeSlot(use24) + textWidth(" – ") + timeSlot(use24);
  return Math.max(range, textWidth("Wed 28 Oct"), textWidth("28 Oct – 28 Oct"), textWidth("Any time"));
}

/** Title with a left column: label padded to the column, then the title. An empty label keeps the indent. */
export function withColumn(label: string, title: string, use24: boolean): string {
  // Measured on screen 2026-10-04: a title after an all-padding label sat about 1 pt left of a labelled one
  // (the zero-width anchor and leading spaces render slightly narrower than measured); one hair space evens it.
  const target = columnWidth(use24) + COLUMN_GAP + (label ? 0 : EMPTY_LABEL_NUDGE);
  return `${label ? "" : ANCHOR}${padTo(label, target)}${title}`;
}

/** Indentation by `points` at the start of a title (measured spaces behind an invisible anchor). */
export function indentBy(points: number): string {
  return points > 0 ? `${ANCHOR}${padTo("", points)}` : "";
}
