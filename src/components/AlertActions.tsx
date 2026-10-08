// Set Alert… (owner feedback 2026-10-04, item 8): changes only the alerts of one non-recurring event.
import { Action, ActionPanel, Icon, showToast, Toast } from "@raycast/api";
import * as ek from "../eventkit.ts";
import type { EventInfo } from "../lib/eventkit-protocol.ts";
import { ALERT_OPTIONS, describeAlerts } from "../lib/summary.ts";
import { failureToast } from "./agenda-shared.tsx";

export function SetAlertSubmenu(props: { event: EventInfo; onDone: () => void }) {
  const e = props.event;
  if (e.isRecurring || !e.allowsModifications || !e.eventId) return null;
  async function apply(minutes: number[], title: string) {
    const r = await ek.updateEvent({
      eventId: e.eventId!,
      externalId: e.externalId,
      expectedLastModified: e.lastModified,
      expectedSnapshot: { title: e.title, start: e.start, end: e.end },
      alarmMinutes: minutes,
    });
    if (r.ok) await showToast({ style: Toast.Style.Success, title: `Alert: ${title}`, message: e.title });
    else if (r.failure.kind === "helper" && r.failure.code === "conflict")
      await showToast({ style: Toast.Style.Failure, title: "Changed in Calendar — press ⌘R and try again" });
    else await failureToast("Alert not changed", r.failure);
    props.onDone();
  }
  return (
    <ActionPanel.Submenu
      title={`Set Alert… (${describeAlerts(e.alarmMinutes)})`}
      icon={Icon.Bell}
      shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
    >
      {ALERT_OPTIONS.filter((o) => o.minutes !== null).map((o) => (
        <Action
          key={o.value}
          title={o.title}
          icon={JSON.stringify(o.minutes) === JSON.stringify(e.alarmMinutes) ? Icon.Checkmark : undefined}
          onAction={() => void apply(o.minutes!, o.title)}
        />
      ))}
    </ActionPanel.Submenu>
  );
}
