# My Day for Raycast

A Raycast extension for macOS that puts one day in one keyboard-first place: your calendar agenda, your Apple Reminders, and saved work checklists kept as plain Markdown files you own. It works on **Raycast Free**, needs no account, and everything stays on your Mac.

- **My Day:** today's events, due and overdue reminders, the day's main task and supporting tasks, tomorrow, and what's coming up. Complete, push to tomorrow, schedule a work block into a free gap, all from the keyboard.
- **Checklists:** nested checkbox lists with long notes and links, stored as Markdown (Obsidian-friendly). Pin, archive, duplicate, trash, back up and restore.
- **My Day Setup:** permission status, calendar and reminder list inventory, a self-test, and an export of undated reminders to Markdown.

Calendar and Reminders are edited two-way through Apple's EventKit, so changes show up in Calendar, Reminders and on your other devices through iCloud. Work checklists are **never** stored in Reminders; they're Markdown files in a folder you choose.

> Not in the Raycast Store. You install it from source, which takes about five minutes and is described step by step below.

## Requirements

- A Mac with **Apple Silicon** (M1 or later) running **macOS 14 Sonoma** or later. The bundled helper is compiled for arm64.
- **Raycast** 2.6 or later ([raycast.com](https://www.raycast.com)). The free plan is enough.
- **Node.js 22.22 or later** with npm.
- **Xcode Command Line Tools**, for `swiftc`, which compiles the small native helper that talks to Calendar and Reminders. Full Xcode is not needed.

## Install, step by step

### 1. Install the tools (skip any you already have)

Open **Terminal** (Applications → Utilities) and check what you have:

```bash
node --version
```

```bash
swiftc --version
```

- If `node` is missing or older than v22.22, install the current LTS from [nodejs.org](https://nodejs.org) (the macOS installer), or with Homebrew: `brew install node`.
- If `swiftc` is missing, install the Command Line Tools and follow the dialog that appears:

```bash
xcode-select --install
```

### 2. Download the source

```bash
git clone https://github.com/bretbuilds/raycast-my-day.git
```

```bash
cd raycast-my-day
```

(No git? Use **Code → Download ZIP** on the GitHub page, unzip it, and `cd` into the folder.)

### 3. Install dependencies

```bash
npm install
```

### 4. Build and install into Raycast

Make sure Raycast is running, then:

```bash
npm run dev
```

This compiles the native helper from `helper/main.swift` on your Mac, then runs Raycast's `ray develop`, which builds the extension and installs it into Raycast. Wait for `ready - built extension successfully`, then press **Ctrl+C**. The extension stays installed. It doesn't depend on this terminal, and it survives Raycast restarts and reboots.

Optional: run the checks first.

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

### 5. Grant Calendar and Reminders access

1. Open Raycast and run **My Day Setup**.
2. Where Calendar or Reminders shows "Not requested", run **Request Calendar Access** / **Request Reminders Access**. macOS shows a dialog that names **Raycast** (the helper runs inside Raycast and uses its permission). Click **Allow**.
3. If you denied it earlier: System Settings → Privacy & Security → **Calendars** / **Reminders** → turn on **Raycast**. Quit Raycast before changing these switches and reopen it afterwards.

No other permission is requested: no Accessibility, no Screen Recording, no network.

### 6. Choose what to show

1. Run **My Day**. The first time, choose which calendars and reminder lists to include with **Choose Sources…** (⌘⇧S).
2. Optional: in Raycast → Settings → Extensions → **My Day**, set the **Checklist folder**. By default it's `~/Library/Application Support/My Day/Checklists`. Pointing it at a folder inside an Obsidian vault lets you edit checklists in Obsidian too. Here you can also pick an editor app, the time format (12/24 h) and your working hours.
3. Run **Checklists** and create your first checklist (⌘N). A checklist titled **Backlog** becomes the default home for quick-added tasks.

### 7. Give it a hotkey or alias

My Day never assigns a hotkey itself, so it can't clash with yours. In Raycast → Settings → Extensions → **My Day**, click the Hotkey column of the **My Day** command and press a free combination, or type an alias such as `md`. An alias like `cl` for **Checklists** is handy too.

## Everyday use

### My Day

One day, top to bottom:

- **Header:** "Today · Monday, Oct 5", how long you are free until your next event ("free until 2:15 PM (1 h 30 min)", "busy until 3:00 PM"), "1 of 4 tasks done" for the day's checklist tasks and a red count of overdue reminders. ↵ picks tasks.
- **Calendar** (with the date, like My Schedule): all-day and timed events; your work blocks have a clock icon; the current or next one carries a countdown tag.
- **Reminders:** overdue (red bell and a red "2 days overdue" tag), due that day, and reminders you picked from the backlog for the day ("No date"). Reminders are only ever shown here, never as tasks.
- **Main task:** the needle-moving checklist task for the day. Until you choose one, a prompt row asks for it.
- **Supporting Tasks:** the other checklist tasks on the day. Open tasks from earlier days are carried onto today with "from Fri 2 Oct"; done ones sink to the bottom.
- **Tomorrow** (with its date): its events, reminders and planned tasks, so pushed work stays in sight. ⌘⇧← brings an item back.
- **Coming up:** the next month of events and holidays after tomorrow, grouped like My Schedule (Later this week, Next week, Rest of October, November), date first. Same-titled all-day events from several holiday calendars show once. A range keeps the start date in the date column and puts the end in a tag in the calendar's colour ("until Thu 19 Nov"). ⌘⇧U hides or shows it. Every event has **Hide Calendar "…"** to drop a calendar from My Day only (⌘⇧S Choose Calendars brings it back).

**Several at once:** ⌘⇧A marks a reminder or task (blue "selected" tag; the header counts them). On a marked row the menu acts on all marked rows: ↵ Complete N, ⌘⇧→ Push N to the next day, Move N to Date…, Move N Reminders to List…, ⌃X Delete N (one confirmation listing them). Complete, push, move and list changes have Undo in the toast. ⌥⌘A clears the selection.

**Reminder and task menus** (↵ is the first item): ↵ complete, ⌘↵ edit (for a reminder this includes its due date), ⌃X delete (asks first); then ⌘S schedule a work block in a free slot, ⌘⇧→ push to tomorrow, ⌘O open in Reminders / open its checklist, and for tasks ⌘⇧M make main / make supporting; ⌘⌫ removes a picked reminder or a task from the day without deleting it. Then the Add section (⌘N task, ⌘⇧N reminder, ⌘⌥N event) and the Day section (⌘⇧P pick tasks, ⌘←/⌘→ previous/next day, ⌘T today, ⌘⇧D go to date, ⌘R refresh, ⌘⇧I details pane).

**Events:** ↵/⌘O open in Calendar, ⌃X **Delete Event** (second in the menu, asks first; recurring events offer Delete in Calendar… instead, since My Day never edits a series), ⌘⇧L set alert; work blocks also have ⌘E edit. A timed event over several days reads "from 4:00 PM", "All day", "until 11:00 AM" on its first, middle and last day.

**Adding:** start typing in the search bar. A **New** section appears at the top with "Add “…” to today" selected, so ↵ adds it as a supporting task, saved as a line in your checklist named **Backlog** (or, without one, your first pinned checklist); the "today" part is kept in My Day's local state on your Mac. Below the New rows, only rows containing every typed word are shown, in their usual order; ↓ reaches them. The rows below it make it the main task, or open a reminder or event form with the title filled in. On every row, ⌘N adds the typed text to the day (or opens the task form when nothing is typed), ⌘⇧N opens a new reminder, ⌘⌥N a new event.

**Pick tasks** (⌘⇧P) lists every open checklist item (pinned checklists first), then reminders without a date, then reminders due later. ↵ adds an item to the day (a task as supporting, a reminder to the day's Reminders; again removes it); ⌘↵ makes a task the main task. Type a name and press ⌘N to add a new item to the **Backlog** checklist and the day in one step; ⌘⇧N opens the full form to choose another checklist.

**Picking a reminder never changes it in Reminders.** The pick is kept in My Day's local state; the reminder stays undated, is completed with ⌘↵ like any other, and its pick disappears once it is completed. Pushing a reminder that is due (rather than picked) changes its due date, and the toast says so.

Data is re-read when the command opens, on ⌘R, and quietly every 30 seconds while the view exists. Raycast keeps a closed command loaded for a while (Settings → Advanced → Pop to Root Search), so a quick reopen shows the same view; the 30-second re-read keeps it current. Nothing runs once Raycast unloads the command. Partial failures stay visible as warning rows; denied access is never shown as "nothing today".

### Checklists

- One Markdown file per checklist in your checklist folder (default `~/Library/Application Support/My Day/Checklists`; point it inside an Obsidian vault in iCloud Drive and your checklists also open in Obsidian on your iPhone). My Day reads only `.md` files in that folder and in its **Shelved/** subfolder.
- **Archive = shelve:** archiving moves the file into `Shelved/`, restoring moves it back. Moving a note into `Shelved/` in Obsidian has the same effect.
- **Open in Obsidian** (⌘⇧O) appears when the checklist is inside a vault Obsidian knows (Obsidian does not register for .md files, so it never shows in macOS's Open With list). The details pane inside a checklist is off by default so titles get the full width; ⌘⇧I shows it.
- Inside a checklist: ↵ edits the item with the details field focused, ⌘↵ completes, ⌘N add sibling, ⌘⇧N add child, ⌘E edit (title, long Markdown details, parent), ⌘] / ⌘[ indent/outdent, ⌘⌥↑/↓ move, ⌘⇧←/→ collapse/expand, ⌘⇧A add to day, ⌘S schedule a work block, ⌘O open link(s), ⌘⇧E edit the whole document, ⌘Y preview, ⌘⇧O open in your editor, ⌘⇧I show/hide details, ⌃X delete item (recoverable from the snapshots folder). Set Estimate… and Remove from Day are in the Plan section without shortcuts.
- Root list: ⌘N new, ⌘E rename (optionally also the document's first heading), ⌘. pin, ⌘⇧A archive/restore, ⌘D duplicate (keep or reset checkboxes), ⌘⌥↑/↓ reorder, ⌃X move to trash (undo in the toast). The search-bar dropdown switches Active · Manual Order / Active · Recent First / Archived / Trash. Pinned checklists come first and stay pinned after restarts.

### Document format

```markdown
---
myday: 1
id: cl-7k2m9q4w
title: Launch checklist
pinned: true
archived: false
order: 2
---
# Launch checklist
Prose, links and anything else are kept exactly as written.

- [ ] Write the announcement ^t-a1b2c3d4
  Details: every indented line under a task belongs to it — paragraphs, pasted text,
  links such as https://example.com, code blocks, bullet points without checkboxes.
  - [ ] Draft outline ^t-e5f6g7h8
    - [x] Collect links ^t-i9j0k1l2
```

The trailing `^t-…` is the task's identity (Obsidian block-id syntax). Keep it when editing elsewhere so day assignments and linked blocks follow the task. Lines without an id get one the next time My Day saves the file. Checkbox state is the `[ ]`/`[x]`. Parent and child completion are independent.

The whole-document editor is a plain Markdown text area with this syntax; it is **not** Raycast Notes' editor. Use **Open in Editor** for long sessions in your own app.

## Data, safety and recovery

- **Checklists are plain Markdown files** in `~/Library/Application Support/My Day/Checklists` (or the folder you choose in the preferences). Any editor, script or AI tool that can read and write Markdown can use them. Keep each task's trailing `^t-…` id when editing so day assignments and work blocks stay attached.

- **Where things live:** documents in the checklist folder; day assignments, linked-block records, estimates and the write journal in `~/Library/Application Support/com.raycast.macos/extensions/my-day/state.json`.
- **Saves** are atomic (temp file + rename). Before each write, the previous version is copied to `<folder>/.myday/snapshots/` (20 per file). Trash is `<folder>/.myday/trash/`; restore from the Checklists command (Trash view).
- **External edits:** if a file changed outside My Day since it was read, the operation is re-applied by task id on the new content; if that is impossible, nothing is written and you are told why. A whole-document save in that situation keeps the external version and writes yours as `<name> (My Day conflict <time>).md`.
- **Backups:** Checklists → **Export Backup…** writes a folder with every document, `state.json` and a manifest with checksums (default under `~/Library/Application Support/My Day/Backups`). **Import Backup…** validates the manifest and checksums, never overwrites a file that is newer than the backup (it writes a "(restored …)" copy instead), and only adds state entries that are missing.
- **Calendar writes** are journaled before they run; if the helper times out, the next launch looks for the event by its marker line (`My Day link: lk-…` at the end of the event notes) and records it instead of writing again.
- **Privacy:** calendar and reminder contents never leave your Mac. There is no network access, account or telemetry. The self-test logs counts and its own `My Day Test` fixtures only.

## Limitations

- The Raycast window size is set by Raycast, not by extensions, and it cannot be dragged larger. Raycast Settings → General → Appearance offers **Window Mode** (Compact or Expanded) and **Interface Size** (Default, Large, Larger).
- Raycast lists have no extra buttons beyond the primary action and the Actions menu (⌘K), so the header row acts as the button bar for the day.
- The details pane is read-only; ↵ opens the editable form instead.
- Extensions cannot set icon size, the gap between icon and text, fonts or real table columns. My Day keeps every time in the same shape so titles line up closely, but Raycast's proportional font can still shift a title by a pixel or two.

- No drag-and-drop: Raycast's list API has no drag or reorder gestures, so scheduling and reordering are keyboard actions.
- Recurring events and reminders are shown, but My Day does not edit or delete recurring events (do that in Calendar); completing a recurring reminder completes the current occurrence like Reminders does.
- Markdown preview shows ☐/☑ glyphs that are not clickable; use the actions.
- No invitations: attendees cannot be added through EventKit; My Day never sends anything.
- Raycast's built-in My Schedule and Raycast Notes are separate; My Day neither reads nor changes them.

## Upgrading and removal

- **Upgrade:** `git pull`, then `npm install && npm run dev`, and Ctrl+C when it's built. Your checklists and day state are untouched.
- **Rebuild only the helper:** `npm run build:helper` (it also writes the sources' sha256 to `helper/SOURCES.sha256`).
- **Remove:** Raycast → Settings → Extensions → My Day → remove, or delete `~/.config/raycast/extensions/my-day/`. Your checklist folder and backups stay where they are. Delete `~/Library/Application Support/com.raycast.macos/extensions/my-day/` too if you also want the day assignments and link records gone.

## Troubleshooting

- **"Calendar access denied" or empty sections:** run **My Day Setup**. It shows each permission's real state and never reports denied access as "nothing today".
- **`swiftc: command not found` during `npm run dev`:** install the Command Line Tools (`xcode-select --install`) and run it again.
- **`Cannot find name 'Preferences'` from `npm run typecheck`:** run `npm run build` (or `npm run dev`) once first. It generates `raycast-env.d.ts`, the preference types the code uses.
- **`ray: command not found`:** run `npm install` first. `ray` comes from the `@raycast/api` dependency.
- **Intel Mac:** the helper targets arm64. In `package.json`, change `arm64-apple-macos14` to `x86_64-apple-macos14` in the `build:helper` script. This is untested.

## Development

- `npm run dev`: watch mode, and installs into Raycast.
- `npm run build`: builds the helper and the extension with `ray build`.
- Checks: `npm run typecheck`, `npm run lint` (or `npm run fix-lint` to fix), `npm test`.
- `npm run lint:store`: Raycast's own Store lint.

Layout: `src/` holds the extension (React + `@raycast/api`), `src/lib/` holds pure logic covered by `test/`, and `helper/main.swift` is the EventKit helper. It runs as a short-lived child process and speaks JSON over stdin/stdout. `scripts/` has small generators for the icon and the font-width table.

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
