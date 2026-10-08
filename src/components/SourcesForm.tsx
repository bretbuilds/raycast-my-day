// Choose Sources (A-A-4): which calendars and reminder lists My Day shows, plus the remembered defaults for
// new events and reminders. null = include all (also future ones); [] = deliberately none.
import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from "@raycast/api";
import { useState } from "react";
import type { CalendarInfo } from "../lib/eventkit-protocol.ts";
import { writable, type AgendaCtx } from "./agenda-shared.tsx";

interface Values {
  calendarIds?: string[];
  listIds?: string[];
  defaultCalendarId?: string;
  defaultListId?: string;
}

const NONE = "__none__";

function label(c: CalendarInfo) {
  return `${c.title} (${c.source})${c.allowsModifications ? "" : " · read-only"}`;
}

export function SourcesForm({ ctx }: { ctx: AgendaCtx }) {
  const { pop } = useNavigation();
  const sources = ctx.session.state.sources;
  const calendars = ctx.data?.calendars ?? [];
  const lists = ctx.data?.lists ?? [];
  const calendarsKnown = Boolean(ctx.data?.calendarsKnown);
  const listsKnown = Boolean(ctx.data?.listsKnown);
  const [allCalendars, setAllCalendars] = useState(sources.eventCalendarIds === null);
  const [allLists, setAllLists] = useState(sources.reminderListIds === null);

  function submit(v: Values) {
    const s = ctx.session.state.sources;
    // A source that could not be read keeps its stored selection untouched.
    if (calendarsKnown) {
      s.eventCalendarIds = allCalendars ? null : (v.calendarIds ?? []);
      if (v.defaultCalendarId && v.defaultCalendarId !== NONE) s.defaultCalendarId = v.defaultCalendarId;
      else delete s.defaultCalendarId;
    }
    if (listsKnown) {
      s.reminderListIds = allLists ? null : (v.listIds ?? []);
      if (v.defaultListId && v.defaultListId !== NONE) s.defaultListId = v.defaultListId;
      else delete s.defaultListId;
    }
    if (!ctx.session.saveState()) return;
    const none = [
      s.eventCalendarIds?.length === 0 ? "no calendars" : null,
      s.reminderListIds?.length === 0 ? "no reminder lists" : null,
    ].filter(Boolean);
    void showToast({
      style: Toast.Style.Success,
      title: "Sources saved",
      message: none.length ? `Showing ${none.join(" and ")} (deliberately).` : undefined,
    });
    pop();
    void ctx.refresh();
  }

  return (
    <Form
      navigationTitle="Choose Sources"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Sources" icon={Icon.Checkmark} onSubmit={submit} />
        </ActionPanel>
      }
    >
      {calendarsKnown ? (
        <>
          <Form.Checkbox
            id="allCalendars"
            title="Calendars"
            label="Include all calendars"
            info="Also includes calendars added later. Turn off to pick; an empty pick shows no events at all."
            value={allCalendars}
            onChange={setAllCalendars}
          />
          {!allCalendars ? (
            <Form.TagPicker
              id="calendarIds"
              title="Show Calendars"
              defaultValue={(sources.eventCalendarIds ?? []).filter((id) => calendars.some((c) => c.id === id))}
            >
              {calendars.map((c) => (
                <Form.TagPicker.Item key={c.id} value={c.id} title={label(c)} />
              ))}
            </Form.TagPicker>
          ) : null}
          <Form.Dropdown
            id="defaultCalendarId"
            title="Default Calendar"
            info="Preselected in Add Event and Schedule Work Block."
            defaultValue={
              writable(calendars).some((c) => c.id === sources.defaultCalendarId) ? sources.defaultCalendarId : NONE
            }
          >
            <Form.Dropdown.Item value={NONE} title="(First writable calendar)" />
            {writable(calendars).map((c) => (
              <Form.Dropdown.Item key={c.id} value={c.id} title={label(c)} />
            ))}
          </Form.Dropdown>
        </>
      ) : (
        <Form.Description
          title="Calendars"
          text="Calendar could not be read, so the calendar selection is kept as it is."
        />
      )}
      <Form.Separator />
      {listsKnown ? (
        <>
          <Form.Checkbox
            id="allLists"
            title="Reminder Lists"
            label="Include all lists"
            info="Also includes lists added later. Turn off to pick; an empty pick shows no reminders at all."
            value={allLists}
            onChange={setAllLists}
          />
          {!allLists ? (
            <Form.TagPicker
              id="listIds"
              title="Show Lists"
              defaultValue={(sources.reminderListIds ?? []).filter((id) => lists.some((c) => c.id === id))}
            >
              {lists.map((c) => (
                <Form.TagPicker.Item key={c.id} value={c.id} title={label(c)} />
              ))}
            </Form.TagPicker>
          ) : null}
          <Form.Dropdown
            id="defaultListId"
            title="Default List"
            info="Preselected in Add Reminder."
            defaultValue={writable(lists).some((c) => c.id === sources.defaultListId) ? sources.defaultListId : NONE}
          >
            <Form.Dropdown.Item value={NONE} title="(First writable list)" />
            {writable(lists).map((c) => (
              <Form.Dropdown.Item key={c.id} value={c.id} title={label(c)} />
            ))}
          </Form.Dropdown>
        </>
      ) : (
        <Form.Description
          title="Reminder Lists"
          text="Reminders could not be read, so the list selection is kept as it is."
        />
      )}
    </Form>
  );
}
