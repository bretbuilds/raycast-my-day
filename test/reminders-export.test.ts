import { test } from "node:test";
import assert from "node:assert/strict";
import { undatedRemindersExport } from "../src/lib/reminders-export.ts";
import type { CalendarInfo, ReminderInfo } from "../src/lib/eventkit-protocol.ts";

const list = (id: string, title: string) => ({ id, title, kind: "reminder" }) as CalendarInfo;
const rem = (over: Partial<ReminderInfo>): ReminderInfo => ({
  itemId: "i",
  externalId: null,
  listId: "L1",
  title: "Task",
  notes: null,
  url: null,
  dueDay: null,
  dueDateTime: null,
  dueHasTime: false,
  isCompleted: false,
  completionDate: null,
  priority: 0,
  isRecurring: false,
  lastModified: null,
  created: null,
  ...over,
});

test("only open undated reminders are exported, grouped by list name, oldest first", () => {
  const r = undatedRemindersExport(
    [
      rem({ itemId: "a", title: "Newer", created: "2026-05-01T00:00:00Z" }),
      rem({ itemId: "b", title: "Older", created: "2025-01-01T00:00:00Z" }),
      rem({ itemId: "c", title: "Dated", dueDay: "2026-10-05" }),
      rem({ itemId: "d", title: "Done", isCompleted: true }),
      rem({ itemId: "e", title: "Work thing", listId: "L2" }),
      rem({ itemId: "f", title: "Orphan", listId: "gone" }),
    ],
    [list("L1", "Inbox"), list("L2", "Admin")],
    "4 Oct 2026",
  );
  assert.deepEqual(
    r.manifest.map((m) => m.itemId),
    ["e", "b", "a", "f"],
  );
  assert.equal(r.listCount, 3);
  const md = r.markdown;
  assert.ok(md.startsWith("4 open reminders without a date, from 3 lists, oldest first, exported 4 Oct 2026."));
  assert.ok(md.indexOf("## Admin (1)") < md.indexOf("## Inbox (2)"));
  assert.ok(md.indexOf("- [ ] Older") < md.indexOf("- [ ] Newer"));
  assert.ok(md.includes("## Other list (1)"));
  assert.ok(!md.includes("Dated") && !md.includes("Done"));
});

test("notes and links stay inside the task; titles are one line", () => {
  const { markdown } = undatedRemindersExport(
    [rem({ title: "Two\nlines", notes: "First para\n\nSecond para", url: "https://example.com" })],
    [list("L1", "Inbox")],
    "d",
  );
  assert.ok(markdown.includes("- [ ] Two lines\n  First para\n\n  Second para\n  https://example.com\n"));
});

test("a link already in the notes is not repeated; empty export says so", () => {
  const { markdown } = undatedRemindersExport(
    [rem({ notes: "see https://x.test", url: "https://x.test" })],
    [list("L1", "Inbox")],
    "d",
  );
  assert.equal(markdown.split("https://x.test").length, 2);
  assert.ok(undatedRemindersExport([], [], "d").markdown.includes("No open reminders without a date"));
});
