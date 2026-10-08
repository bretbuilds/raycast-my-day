// Obsidian integration (D-012): when a checklist file sits inside a vault Obsidian knows about, "Open in Obsidian"
// uses Obsidian's own URL scheme. Obsidian does not register itself for .md files, so it never appears in macOS's
// Open With list. Pure apart from reading Obsidian's vault list.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export const OBSIDIAN_CONFIG = join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");

/** Vault folders listed in Obsidian's config; empty when Obsidian is not installed or the file is unreadable. */
export function obsidianVaults(configPath = OBSIDIAN_CONFIG): string[] {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { vaults?: Record<string, { path?: unknown }> };
    return Object.values(cfg.vaults ?? {})
      .map((v) => v.path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

/** The vault that contains `file`, or null. */
export function vaultFor(file: string, vaults: string[]): string | null {
  const hit = vaults
    .map((v) => (v.endsWith(sep) ? v.slice(0, -1) : v))
    .filter((v) => file.startsWith(v + sep))
    .sort((a, b) => b.length - a.length)[0];
  return hit ?? null;
}

/**
 * Default folder for a Markdown export: the vault that holds the checklist folder (its "Inbox" when there is one),
 * so the file lands where the user already keeps notes; otherwise `fallback` (Downloads).
 */
export function exportFolderFor(
  checklistDir: string,
  vaults: string[],
  fallback: string,
  exists: (p: string) => boolean,
): string {
  const vault = vaultFor(join(checklistDir, "x.md"), vaults);
  if (!vault) return fallback;
  const inbox = join(vault, "Inbox");
  return exists(inbox) ? inbox : vault;
}

export function obsidianOpenUrl(file: string): string {
  return `obsidian://open?path=${encodeURIComponent(file)}`;
}
