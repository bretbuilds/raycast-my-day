// Linked work blocks: a calendar event created by Schedule Work Block carries a marker line in its notes
// (D-009). The link record in state.json is authoritative; the marker lets writes be reconciled and lets
// an event still be recognised after its identifiers changed.
import { isLinkId } from "./ids.ts";
import type { EventInfo } from "./eventkit-protocol.ts";
import type { Link } from "./state.ts";

export const MARKER_PREFIX = "My Day link: ";
const MARKER_RE = /(?:^|\n)My Day link: (lk-[a-z0-9]{4,32})\s*$/;

export function markerLine(linkId: string): string {
  return `${MARKER_PREFIX}${linkId}`;
}

/** Appends the marker to user notes (kept on its own last line). */
export function notesWithMarker(notes: string | undefined, linkId: string): string {
  const base = (notes ?? "").replace(/\s+$/, "");
  return base ? `${base}\n\n${markerLine(linkId)}` : markerLine(linkId);
}

export function linkIdFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const m = MARKER_RE.exec(notes.replace(/\s+$/, ""));
  return m && isLinkId(m[1]) ? m[1] : null;
}

/** Notes without the marker line, for display and for editing. */
export function notesWithoutMarker(notes: string | null | undefined): string {
  if (!notes) return "";
  return notes.replace(/\n*My Day link: lk-[a-z0-9]{4,32}\s*$/, "").replace(/\s+$/, "");
}

export type LinkCheck =
  | { status: "ok"; event: EventInfo }
  | { status: "edited-externally"; event: EventInfo; changes: string[] }
  | { status: "missing" };

/** Compares a freshly read event with the stored snapshot. */
export function checkLink(link: Link, fresh: EventInfo | null): LinkCheck {
  if (!fresh) return { status: "missing" };
  const changes: string[] = [];
  if (fresh.title !== link.snapshot.title) changes.push("title");
  if (new Date(fresh.start).getTime() !== new Date(link.snapshot.start).getTime()) changes.push("start");
  if (new Date(fresh.end).getTime() !== new Date(link.snapshot.end).getTime()) changes.push("end");
  if (
    link.snapshot.lastModified &&
    fresh.lastModified &&
    new Date(fresh.lastModified).getTime() > new Date(link.snapshot.lastModified).getTime() + 1000 &&
    changes.length === 0
  ) {
    changes.push("details");
  }
  return changes.length ? { status: "edited-externally", event: fresh, changes } : { status: "ok", event: fresh };
}

export function snapshotOf(e: EventInfo): Link["snapshot"] {
  return { title: e.title, start: e.start, end: e.end, lastModified: e.lastModified };
}
