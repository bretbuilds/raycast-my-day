import {
  Action,
  ActionPanel,
  Color,
  Icon,
  Keyboard,
  List,
  Toast,
  confirmAlert,
  environment,
  openExtensionPreferences,
  showToast,
  type LaunchProps,
} from "@raycast/api";
import { existsSync, readdirSync } from "node:fs";
import { useCallback, useEffect, useState } from "react";
import { ExportRemindersForm } from "./components/ExportRemindersForm.tsx";
import * as ek from "./eventkit.ts";
import {
  failureText,
  type AccessStatus,
  type CalendarsResult,
  type HelperStatus,
  type Parsed,
} from "./lib/eventkit-protocol.ts";
import { backupDefaultDir, checklistDir, statePath } from "./lib/paths.ts";
import { runSelfTest, type SelfTestReport } from "./lib/selftest.ts";

interface SetupContext {
  selfTest?: boolean;
  logPath?: string;
}

function accessLabel(s: AccessStatus): { text: string; color: Color } {
  switch (s) {
    case "full-access":
      return { text: "Full access", color: Color.Green };
    case "not-determined":
      return { text: "Not requested", color: Color.Orange };
    case "write-only":
      return { text: "Write only", color: Color.Orange };
    case "denied":
      return { text: "Denied", color: Color.Red };
    case "restricted":
      return { text: "Restricted", color: Color.Red };
    default:
      return { text: "Unknown", color: Color.SecondaryText };
  }
}

const PERMISSION_HINT =
  "System Settings → Privacy & Security → Calendars / Reminders → turn on Raycast. Quit Raycast first; changing it while Raycast runs has frozen input on this Mac.";

export default function Command(props: LaunchProps<{ launchContext?: SetupContext }>) {
  const [status, setStatus] = useState<Parsed<HelperStatus> | null>(null);
  const [calendars, setCalendars] = useState<Parsed<CalendarsResult> | null>(null);
  const [busy, setBusy] = useState(false);
  const [selfTest, setSelfTest] = useState<SelfTestReport | null>(null);
  const folder = checklistDir();
  const folderExists = existsSync(folder);
  const fileCount = folderExists
    ? readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".md") && !f.startsWith(".")).length
    : 0;

  const refresh = useCallback(async () => {
    setBusy(true);
    const s = await ek.helperStatus();
    setStatus(s);
    if (s.ok && (s.value.events === "full-access" || s.value.reminders === "full-access")) {
      setCalendars(await ek.listCalendars());
    } else {
      setCalendars(null);
    }
    setBusy(false);
  }, []);

  const runTest = useCallback(
    async (logPath: string) => {
      setBusy(true);
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Running the self-test in My Day Test fixtures…",
      });
      try {
        const r = await runSelfTest(
          ek,
          { supportPath: environment.supportPath, assetsPath: environment.assetsPath },
          logPath,
        );
        setSelfTest(r);
        const ok = r.steps.filter((x) => x.ok).length;
        toast.style = ok === r.steps.length && r.cleanedUp ? Toast.Style.Success : Toast.Style.Failure;
        toast.title = `Self-test ${ok}/${r.steps.length} ok, fixtures ${r.cleanedUp ? "removed" : "NOT removed"}`;
        toast.message = `Evidence: ${logPath}`;
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    const ctx = props.launchContext;
    if (ctx?.selfTest) runTest(ctx.logPath ?? `${environment.supportPath}/m1-selftest.json`);
    else refresh();
  }, [props.launchContext, refresh, runTest]);

  async function request(entity: "events" | "reminders") {
    setBusy(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Waiting for the ${entity === "events" ? "Calendar" : "Reminders"} permission dialog…`,
      message: "The dialog names Raycast. Click Allow.",
    });
    const r = await ek.requestAccess(entity);
    if (r.ok && r.value.granted) {
      toast.style = Toast.Style.Success;
      toast.title = "Access granted";
      toast.message = "";
    } else {
      toast.style = Toast.Style.Failure;
      if (r.ok) {
        toast.title = r.value.timedOut ? "No answer to the permission dialog" : `Access ${r.value.status}`;
        toast.message = r.value.error ?? PERMISSION_HINT;
      } else {
        const t = failureText(r.failure);
        toast.title = t.title;
        toast.message = t.description;
      }
    }
    await refresh();
  }

  const s = status?.ok ? status.value : null;
  const failure = status && !status.ok ? failureText(status.failure) : null;
  const refreshAction = (
    <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={refresh} />
  );
  const common = (
    <ActionPanel.Section title="Setup">
      {refreshAction}
      <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
      <Action
        title="Run Self-Test with My Day Test Fixtures"
        icon={Icon.Bug}
        onAction={async () => {
          const ok = await confirmAlert({
            title: "Run the integration self-test?",
            message:
              "It creates a calendar and a reminder list named “My Day Test” in your iCloud (or local) account, writes a few items there, verifies them and deletes both sources. Your existing events and reminders are only counted, never changed.",
            primaryAction: { title: "Run" },
          });
          if (ok) await runTest(`${environment.supportPath}/selftest-${Date.now()}.json`);
        }}
      />
    </ActionPanel.Section>
  );

  return (
    <List isLoading={busy || status === null} navigationTitle="My Day Setup">
      {failure && (
        <List.Section title="Helper">
          <List.Item
            icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
            title={failure.title}
            subtitle={failure.description}
            actions={<ActionPanel>{common}</ActionPanel>}
          />
        </List.Section>
      )}
      {s && (
        <List.Section title="Access (granted to Raycast; My Day's helper runs as a child of Raycast)">
          <List.Item
            icon={Icon.Calendar}
            title="Calendar"
            subtitle={s.events === "full-access" ? "Events can be read and created" : PERMISSION_HINT}
            accessories={[{ tag: { value: accessLabel(s.events).text, color: accessLabel(s.events).color } }]}
            actions={
              <ActionPanel>
                {s.events !== "full-access" && (
                  <Action title="Request Calendar Access" icon={Icon.Lock} onAction={() => request("events")} />
                )}
                {common}
              </ActionPanel>
            }
          />
          <List.Item
            icon={Icon.CheckCircle}
            title="Reminders"
            subtitle={s.reminders === "full-access" ? "Reminders can be read, created and completed" : PERMISSION_HINT}
            accessories={[{ tag: { value: accessLabel(s.reminders).text, color: accessLabel(s.reminders).color } }]}
            actions={
              <ActionPanel>
                {s.reminders !== "full-access" && (
                  <Action title="Request Reminders Access" icon={Icon.Lock} onAction={() => request("reminders")} />
                )}
                {s.reminders === "full-access" && (
                  <Action.Push
                    title="Export Undated Reminders…"
                    icon={Icon.Download}
                    target={<ExportRemindersForm />}
                  />
                )}
                {common}
              </ActionPanel>
            }
          />
          <List.Item
            icon={Icon.Terminal}
            title="Helper"
            subtitle={`v${s.helper} · macOS ${s.macos} · ${s.timeZone} · exits after every call`}
            accessories={[{ text: `pid ${s.pid} ← parent ${s.parentPid}` }]}
            actions={
              <ActionPanel>
                <Action.ShowInFinder title="Show Helper in Finder" path={ek.helperPath()} />
                {common}
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      <List.Section title="Checklists">
        <List.Item
          icon={Icon.Folder}
          title="Checklist folder"
          subtitle={folder}
          accessories={[
            { text: folderExists ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "created on first checklist" },
          ]}
          actions={
            <ActionPanel>
              {folderExists && <Action.ShowInFinder path={folder} />}
              <Action
                title="Change Folder (Extension Preferences)"
                icon={Icon.Gear}
                onAction={openExtensionPreferences}
              />
              {common}
            </ActionPanel>
          }
        />
        <List.Item
          icon={Icon.HardDrive}
          title="Local state"
          subtitle={statePath()}
          accessories={[{ text: "day assignments, links, journal" }]}
          actions={
            <ActionPanel>
              {existsSync(statePath()) && <Action.ShowInFinder path={statePath()} />}
              {common}
            </ActionPanel>
          }
        />
        <List.Item
          icon={Icon.Download}
          title="Backups"
          subtitle={`Checklists → Export Backup… (default ${backupDefaultDir()})`}
          actions={<ActionPanel>{common}</ActionPanel>}
        />
      </List.Section>
      <List.Section title="Hotkey and alias">
        <List.Item
          icon={Icon.Keyboard}
          title="Assign a hotkey to My Day"
          subtitle="Raycast → Settings → Extensions → My Day → click the Hotkey field of the My Day command and record a free combination. My Day never assigns one itself."
          actions={<ActionPanel>{common}</ActionPanel>}
        />
        <List.Item
          icon={Icon.Text}
          title="Optional alias"
          subtitle="Same place: type an alias such as “md” for My Day or “cl” for Checklists."
          actions={<ActionPanel>{common}</ActionPanel>}
        />
      </List.Section>
      <List.Section title="Privacy">
        <List.Item
          icon={Icon.Shield}
          title="Local only"
          subtitle="No network, analytics or accounts. Calendar and Reminders are read on demand; checklists stay in your folder."
          actions={<ActionPanel>{common}</ActionPanel>}
        />
      </List.Section>
      {calendars?.ok && calendars.value.eventCalendars && (
        <List.Section title={`Calendars (${calendars.value.eventCalendars.length})`}>
          {calendars.value.eventCalendars.map((c) => (
            <List.Item
              key={c.id}
              icon={{ source: Icon.Circle, tintColor: c.color ?? Color.SecondaryText }}
              title={c.title}
              subtitle={c.source}
              accessories={[{ text: c.allowsModifications ? "writable" : "read-only" }]}
              actions={<ActionPanel>{common}</ActionPanel>}
            />
          ))}
        </List.Section>
      )}
      {calendars?.ok && calendars.value.reminderLists && (
        <List.Section title={`Reminder lists (${calendars.value.reminderLists.length})`}>
          {calendars.value.reminderLists.map((c) => (
            <List.Item
              key={c.id}
              icon={{ source: Icon.Circle, tintColor: c.color ?? Color.SecondaryText }}
              title={c.title}
              subtitle={c.source}
              accessories={[{ text: c.allowsModifications ? "writable" : "read-only" }]}
              actions={<ActionPanel>{common}</ActionPanel>}
            />
          ))}
        </List.Section>
      )}
      {calendars && !calendars.ok && (
        <List.Section title="Calendars">
          <List.Item
            icon={{ source: Icon.Warning, tintColor: Color.Red }}
            title={failureText(calendars.failure).title}
            subtitle={failureText(calendars.failure).description}
            actions={<ActionPanel>{common}</ActionPanel>}
          />
        </List.Section>
      )}
      {selfTest && (
        <List.Section
          title={`Self-test (${selfTest.steps.filter((x) => x.ok).length}/${selfTest.steps.length} ok, fixtures removed: ${selfTest.cleanedUp})`}
        >
          {selfTest.steps.map((st, i) => (
            <List.Item
              key={i}
              icon={
                st.ok
                  ? { source: Icon.CheckCircle, tintColor: Color.Green }
                  : { source: Icon.XMarkCircle, tintColor: Color.Red }
              }
              title={st.step}
              subtitle={typeof st.detail === "object" ? JSON.stringify(st.detail).slice(0, 120) : String(st.detail)}
              actions={<ActionPanel>{common}</ActionPanel>}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
