// Resolves the 12/24-hour display style: the extension preference wins; "system" uses the helper's reading of
// the Mac's Date & Time setting, falling back to Node's locale when the helper is unavailable.
import { getPreferenceValues } from "@raycast/api";

export function applyClockPreference(systemSays24: boolean | null, set: (v: boolean) => void): void {
  const pref = getPreferenceValues<{ timeFormat?: string }>().timeFormat ?? "system";
  if (pref === "12h") return set(false);
  if (pref === "24h") return set(true);
  if (systemSays24 !== null) return set(systemSays24);
  const hc = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  set(hc === "h23" || hc === "h24");
}
