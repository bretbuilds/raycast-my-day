// Stable identifiers. Never derived from titles or line numbers.
import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/1/i/l/o to keep ids readable in files

function token(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export const newTaskId = () => `t-${token(8)}`;
export const newChecklistId = () => `cl-${token(8)}`;
export const newLinkId = () => `lk-${token(8)}`;
export const newToken = () => token(16);

/** Obsidian block ids allow letters, digits and dashes. Task ids additionally start with `t-`. */
export const TASK_ID_RE = /^t-[a-z0-9]{4,32}$/;
export const CHECKLIST_ID_RE = /^cl-[a-z0-9]{4,32}$/;
export const LINK_ID_RE = /^lk-[a-z0-9]{4,32}$/;

export const isTaskId = (s: unknown): s is string => typeof s === "string" && TASK_ID_RE.test(s);
export const isChecklistId = (s: unknown): s is string => typeof s === "string" && CHECKLIST_ID_RE.test(s);
export const isLinkId = (s: unknown): s is string => typeof s === "string" && LINK_ID_RE.test(s);
