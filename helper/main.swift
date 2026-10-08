// myday-helper — on-demand EventKit helper for the My Day Raycast extension.
// One JSON document on stdout per run; diagnostics on stderr. No state, no network, exits when done.
// Read commands take arguments; write commands take ONE JSON object on stdin (never shell-interpolated user text).

import EventKit
import Foundation

let helperSchema = 1
let helperVersion = "0.2.0"
let maxTextLength = 20_000
let maxRangeDays = 62.0

// MARK: - Output

struct Failure: Codable {
    let schema: Int
    let ok: Bool
    let code: String   // usage | denied | restricted | not-determined | write-only | not-found | read-only | invalid-input | store-error | timeout
    let message: String
}

func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else {
        FileHandle.standardError.write("myday-helper: could not encode response\n".data(using: .utf8)!)
        exit(1)
    }
    print(text)
}

func fail(_ code: String, _ message: String, exitCode: Int32 = 2) -> Never {
    emit(Failure(schema: helperSchema, ok: false, code: code, message: message))
    exit(exitCode)
}

func option(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func flag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

func clip(_ s: String?) -> String? {
    guard let s = s else { return nil }
    return s.count > maxTextLength ? String(s.prefix(maxTextLength)) + "…" : s
}

// MARK: - Dates

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func iso(_ d: Date?) -> String? { d.map { isoFormatter.string(from: $0) } }

let isoFractionalFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func parseISO(_ s: String?) -> Date? {
    guard let s = s else { return nil }
    return isoFormatter.date(from: s) ?? isoFractionalFormatter.date(from: s)
}

/// Local calendar date "YYYY-MM-DD" of an instant in the device's current time zone.
func localDay(_ d: Date) -> String {
    var cal = Calendar.current
    cal.timeZone = TimeZone.current
    let c = cal.dateComponents([.year, .month, .day], from: d)
    return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
}

func parseDay(_ s: String) -> Date? {
    let parts = s.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    var cal = Calendar.current
    cal.timeZone = TimeZone.current
    return cal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
}

func hex(_ cg: CGColor?) -> String? {
    guard let cg = cg, let rgb = cg.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
          let c = rgb.components, c.count >= 3 else { return nil }
    return String(format: "#%02X%02X%02X", Int(round(c[0] * 255)), Int(round(c[1] * 255)), Int(round(c[2] * 255)))
}

// MARK: - Store and access

let store = EKEventStore()

func statusName(_ s: EKAuthorizationStatus) -> String {
    switch s {
    case .notDetermined: return "not-determined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .fullAccess: return "full-access"
    case .writeOnly: return "write-only"
    case .authorized: return "full-access" // pre-macOS 14 name
    @unknown default: return "unknown"
    }
}

struct StatusResponse: Codable {
    let schema: Int
    let ok: Bool
    let helper: String
    let macos: String
    let events: String
    let reminders: String
    let timeZone: String
    let pid: Int32
    let parentPid: Int32
    let uses24HourClock: Bool
}

func statusResponse() -> StatusResponse {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return StatusResponse(
        schema: helperSchema, ok: true, helper: helperVersion,
        macos: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
        events: statusName(EKEventStore.authorizationStatus(for: .event)),
        reminders: statusName(EKEventStore.authorizationStatus(for: .reminder)),
        timeZone: TimeZone.current.identifier, pid: getpid(), parentPid: getppid(),
        uses24HourClock: !(DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: Locale.current) ?? "H").contains("a"))
}

/// Requests full access and blocks until the user answers or the timeout elapses.
/// Attribution of the system prompt belongs to the responsible process (the app that launched us).
func requestAccess(_ type: EKEntityType, timeoutSeconds: Double) -> (granted: Bool, error: String?, timedOut: Bool) {
    let sema = DispatchSemaphore(value: 0)
    var granted = false
    var errorText: String?
    let handler: EKEventStoreRequestAccessCompletionHandler = { ok, err in
        granted = ok
        errorText = err?.localizedDescription
        sema.signal()
    }
    if type == .event { store.requestFullAccessToEvents(completion: handler) } else { store.requestFullAccessToReminders(completion: handler) }
    let result = sema.wait(timeout: .now() + timeoutSeconds)
    return (granted, errorText, result == .timedOut)
}

/// Ensures full access for a read/write without prompting; callers that may prompt use requestAccess explicitly.
func requireFullAccess(_ type: EKEntityType) {
    let s = EKEventStore.authorizationStatus(for: type)
    switch s {
    case .fullAccess, .authorized: return
    case .notDetermined: fail("not-determined", "Access to \(type == .event ? "Calendar" : "Reminders") has not been requested yet.")
    case .denied: fail("denied", "Access to \(type == .event ? "Calendar" : "Reminders") is denied for the launching app.")
    case .restricted: fail("restricted", "Access to \(type == .event ? "Calendar" : "Reminders") is restricted on this Mac.")
    case .writeOnly: fail("write-only", "Only write-only Calendar access was granted; full access is needed to read events.")
    @unknown default: fail("denied", "Unknown authorization status \(s.rawValue).")
    }
}

// MARK: - Calendars

struct CalendarInfo: Codable {
    let id: String
    let title: String
    let kind: String          // "event" | "reminder"
    let color: String?
    let source: String
    let sourceType: String
    let allowsModifications: Bool
    let isImmutable: Bool
    let isSubscribed: Bool
    let calendarType: String
}

func sourceTypeName(_ t: EKSourceType) -> String {
    switch t {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "caldav"
    case .mobileMe: return "icloud"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "other"
    }
}

func calendarTypeName(_ t: EKCalendarType) -> String {
    switch t {
    case .local: return "local"
    case .calDAV: return "caldav"
    case .exchange: return "exchange"
    case .subscription: return "subscription"
    case .birthday: return "birthday"
    @unknown default: return "other"
    }
}

func info(_ c: EKCalendar, kind: String) -> CalendarInfo {
    CalendarInfo(
        id: c.calendarIdentifier, title: c.title, kind: kind, color: hex(c.cgColor),
        source: c.source?.title ?? "", sourceType: sourceTypeName(c.source?.sourceType ?? .local),
        allowsModifications: c.allowsContentModifications, isImmutable: c.isImmutable,
        isSubscribed: c.isSubscribed, calendarType: calendarTypeName(c.type))
}

struct CalendarsResponse: Codable {
    let schema: Int
    let ok: Bool
    let eventCalendars: [CalendarInfo]?
    let reminderLists: [CalendarInfo]?
    let eventsAccess: String
    let remindersAccess: String
}

func listCalendars() -> CalendarsResponse {
    let ev = EKEventStore.authorizationStatus(for: .event)
    let rm = EKEventStore.authorizationStatus(for: .reminder)
    let evOK = ev == .fullAccess || ev == .authorized
    let rmOK = rm == .fullAccess || rm == .authorized
    return CalendarsResponse(
        schema: helperSchema, ok: true,
        eventCalendars: evOK ? store.calendars(for: .event).map { info($0, kind: "event") }.sorted { $0.title < $1.title } : nil,
        reminderLists: rmOK ? store.calendars(for: .reminder).map { info($0, kind: "reminder") }.sorted { $0.title < $1.title } : nil,
        eventsAccess: statusName(ev), remindersAccess: statusName(rm))
}

// MARK: - Events

struct EventInfo: Codable {
    let eventId: String?            // EKEvent.eventIdentifier (shared by all occurrences of a series)
    let itemId: String              // EKCalendarItem.calendarItemIdentifier
    let externalId: String?         // calendarItemExternalIdentifier (sync-stable where available)
    let occurrenceDate: String?     // identifies the occurrence within a series
    let calendarId: String
    let title: String
    let start: String
    let end: String
    let startDay: String            // local calendar day of start (device time zone)
    let endDay: String
    let isAllDay: Bool
    let isRecurring: Bool
    let isDetached: Bool
    let location: String?
    let notes: String?
    let url: String?
    let status: String
    let availability: String
    let hasAttendees: Bool
    let organizer: String?
    let lastModified: String?
    let timeZone: String?
    let alarmMinutes: [Int]          // minutes before start (0 = at start); relative alarms only
    let allowsModifications: Bool
}

func relativeAlarmMinutes(_ item: EKCalendarItem) -> [Int] {
    (item.alarms ?? []).compactMap { a in a.absoluteDate == nil ? Int((-a.relativeOffset / 60).rounded()) : nil }.sorted()
}

func applyAlarms(_ item: EKCalendarItem, _ minutes: [Int]?) {
    guard let minutes = minutes else { return }
    guard minutes.count <= 5, minutes.allSatisfy({ $0 >= 0 && $0 <= 7 * 24 * 60 }) else { fail("invalid-input", "alarms must be 0…10080 minutes, at most 5") }
    item.alarms = minutes.isEmpty ? nil : Array(Set(minutes)).sorted().map { EKAlarm(relativeOffset: TimeInterval(-$0 * 60)) }
}

func eventInfo(_ e: EKEvent) -> EventInfo {
    let status: String
    switch e.status {
    case .confirmed: status = "confirmed"
    case .tentative: status = "tentative"
    case .canceled: status = "canceled"
    default: status = "none"
    }
    let availability: String
    switch e.availability {
    case .busy: availability = "busy"
    case .free: availability = "free"
    case .tentative: availability = "tentative"
    case .unavailable: availability = "unavailable"
    default: availability = "not-supported"
    }
    return EventInfo(
        eventId: e.eventIdentifier, itemId: e.calendarItemIdentifier, externalId: e.calendarItemExternalIdentifier,
        occurrenceDate: iso(e.occurrenceDate), calendarId: e.calendar.calendarIdentifier, title: e.title ?? "",
        start: iso(e.startDate)!, end: iso(e.endDate)!, startDay: localDay(e.startDate), endDay: localDay(e.endDate),
        isAllDay: e.isAllDay, isRecurring: e.hasRecurrenceRules || e.isDetached, isDetached: e.isDetached,
        location: clip(e.location), notes: clip(e.notes), url: e.url?.absoluteString, status: status,
        availability: availability, hasAttendees: e.hasAttendees, organizer: e.organizer?.name,
        lastModified: iso(e.lastModifiedDate), timeZone: e.timeZone?.identifier,
        alarmMinutes: relativeAlarmMinutes(e), allowsModifications: e.calendar.allowsContentModifications)
}

struct EventsResponse: Codable {
    let schema: Int
    let ok: Bool
    let from: String
    let to: String
    let events: [EventInfo]
}

func listEvents() -> EventsResponse {
    requireFullAccess(.event)
    guard let from = parseISO(option("--from")), let to = parseISO(option("--to")) else {
        fail("usage", "events requires --from <ISO8601> --to <ISO8601>")
    }
    guard to > from, to.timeIntervalSince(from) <= maxRangeDays * 86_400 else {
        fail("invalid-input", "events range must be positive and at most \(Int(maxRangeDays)) days")
    }
    var calendars: [EKCalendar]? = nil
    if let ids = option("--calendars") {
        let wanted = Set(ids.split(separator: ",").map(String.init))
        calendars = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
        if calendars!.isEmpty { return EventsResponse(schema: helperSchema, ok: true, from: iso(from)!, to: iso(to)!, events: []) }
    }
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
    let events = store.events(matching: predicate).sorted { a, b in
        if a.startDate != b.startDate { return a.startDate < b.startDate }
        return (a.title ?? "") < (b.title ?? "")
    }
    return EventsResponse(schema: helperSchema, ok: true, from: iso(from)!, to: iso(to)!, events: events.map(eventInfo))
}

// MARK: - Reminders

struct ReminderInfo: Codable {
    let itemId: String
    let externalId: String?
    let listId: String
    let title: String
    let notes: String?
    let url: String?
    let dueDay: String?          // "YYYY-MM-DD" when a due date exists (date-only or with time)
    let dueDateTime: String?     // ISO instant only when the reminder has a time of day
    let dueHasTime: Bool
    let isCompleted: Bool
    let completionDate: String?
    let priority: Int
    let isRecurring: Bool
    let lastModified: String?
    let created: String?
}

func reminderInfo(_ r: EKReminder) -> ReminderInfo {
    var dueDay: String? = nil
    var dueDateTime: String? = nil
    var hasTime = false
    if let c = r.dueDateComponents, let y = c.year, let m = c.month, let d = c.day {
        dueDay = String(format: "%04d-%02d-%02d", y, m, d)
        if c.hour != nil {
            hasTime = true
            var cal = Calendar.current
            cal.timeZone = c.timeZone ?? TimeZone.current
            if let date = cal.date(from: c) { dueDateTime = iso(date) }
        }
    }
    return ReminderInfo(
        itemId: r.calendarItemIdentifier, externalId: r.calendarItemExternalIdentifier, listId: r.calendar.calendarIdentifier,
        title: r.title ?? "", notes: clip(r.notes), url: r.url?.absoluteString, dueDay: dueDay, dueDateTime: dueDateTime,
        dueHasTime: hasTime, isCompleted: r.isCompleted, completionDate: iso(r.completionDate), priority: r.priority,
        isRecurring: r.hasRecurrenceRules, lastModified: iso(r.lastModifiedDate), created: iso(r.creationDate))
}

struct RemindersResponse: Codable {
    let schema: Int
    let ok: Bool
    let reminders: [ReminderInfo]
    let includeCompleted: Bool
}

func fetchReminders(_ predicate: NSPredicate, timeoutSeconds: Double = 20) -> [EKReminder] {
    let sema = DispatchSemaphore(value: 0)
    var result: [EKReminder] = []
    store.fetchReminders(matching: predicate) { items in
        result = items ?? []
        sema.signal()
    }
    if sema.wait(timeout: .now() + timeoutSeconds) == .timedOut { fail("timeout", "Reminders did not answer within \(Int(timeoutSeconds)) s") }
    return result
}

func listReminders() -> RemindersResponse {
    requireFullAccess(.reminder)
    var lists: [EKCalendar]? = nil
    if let ids = option("--lists") {
        let wanted = Set(ids.split(separator: ",").map(String.init))
        lists = store.calendars(for: .reminder).filter { wanted.contains($0.calendarIdentifier) }
        if lists!.isEmpty { return RemindersResponse(schema: helperSchema, ok: true, reminders: [], includeCompleted: false) }
    }
    let includeCompleted = flag("--include-completed")
    let predicate: NSPredicate
    if includeCompleted {
        predicate = store.predicateForReminders(in: lists)
    } else {
        predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
    }
    let reminders = fetchReminders(predicate).sorted { a, b in
        let ad = a.dueDateComponents?.date ?? Date.distantFuture
        let bd = b.dueDateComponents?.date ?? Date.distantFuture
        if ad != bd { return ad < bd }
        return (a.title ?? "") < (b.title ?? "")
    }
    return RemindersResponse(schema: helperSchema, ok: true, reminders: reminders.map(reminderInfo), includeCompleted: includeCompleted)
}

// MARK: - Writes (JSON on stdin)

func readStdinJSON<T: Decodable>(_ type: T.Type) -> T {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 1_000_000 else { fail("invalid-input", "stdin payload too large") }
    do { return try JSONDecoder().decode(type, from: data) } catch { fail("invalid-input", "Invalid JSON input: \(error.localizedDescription)") }
}

func writableCalendar(_ id: String, _ type: EKEntityType) -> EKCalendar {
    guard let cal = store.calendar(withIdentifier: id), cal.allowedEntityTypes.contains(type == .event ? .event : .reminder) else {
        fail("not-found", "No \(type == .event ? "calendar" : "reminder list") with id \(id)")
    }
    guard cal.allowsContentModifications, !cal.isImmutable else { fail("read-only", "\(cal.title) does not allow changes") }
    return cal
}

struct CreateEventInput: Codable {
    let calendarId: String
    let title: String
    let start: String?       // ISO instant (timed events)
    let end: String?
    let day: String?         // "YYYY-MM-DD" (all-day events)
    let endDay: String?      // inclusive last day for multi-day all-day events
    let isAllDay: Bool
    let location: String?
    let notes: String?
    let url: String?
    let alarmMinutes: [Int]?
}

struct EventWriteResponse: Codable {
    let schema: Int
    let ok: Bool
    let event: EventInfo
}

func allDayRange(_ day: String, _ endDay: String?) -> (Date, Date) {
    guard let start = parseDay(day) else { fail("invalid-input", "day must be YYYY-MM-DD") }
    let lastDay = endDay.flatMap(parseDay) ?? start
    guard lastDay >= start else { fail("invalid-input", "endDay precedes day") }
    var cal = Calendar.current
    cal.timeZone = TimeZone.current
    let nextMidnight = cal.date(byAdding: .day, value: 1, to: lastDay)!
    return (start, nextMidnight.addingTimeInterval(-1)) // Calendar.app's convention: 23:59:59 on the last day
}

func applyTiming(_ e: EKEvent, isAllDay: Bool, start: String?, end: String?, day: String?, endDay: String?) {
    if isAllDay {
        guard let day = day else { fail("invalid-input", "all-day events require day") }
        let (s, en) = allDayRange(day, endDay)
        e.isAllDay = true
        e.startDate = s
        e.endDate = en
        e.timeZone = nil
    } else {
        guard let s = parseISO(start), let en = parseISO(end) else { fail("invalid-input", "timed events require ISO start and end") }
        guard en > s else { fail("invalid-input", "end must be after start") }
        e.isAllDay = false
        e.startDate = s
        e.endDate = en
        e.timeZone = TimeZone.current
    }
}

func createEvent() -> EventWriteResponse {
    requireFullAccess(.event)
    let input = readStdinJSON(CreateEventInput.self)
    let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title.count <= 1000 else { fail("invalid-input", "title is required (max 1000 characters)") }
    let cal = writableCalendar(input.calendarId, .event)
    let e = EKEvent(eventStore: store)
    e.calendar = cal
    e.title = title
    applyTiming(e, isAllDay: input.isAllDay, start: input.start, end: input.end, day: input.day, endDay: input.endDay)
    e.location = input.location
    e.notes = clip(input.notes)
    if let u = input.url, let url = URL(string: u) { e.url = url }
    applyAlarms(e, input.alarmMinutes)
    do { try store.save(e, span: .thisEvent, commit: true) } catch { fail("store-error", "Could not save event: \(error.localizedDescription)", exitCode: 3) }
    return EventWriteResponse(schema: helperSchema, ok: true, event: eventInfo(e))
}

struct UpdateEventInput: Codable {
    let eventId: String
    let externalId: String?
    let expectedLastModified: String?   // optimistic check: refuse if the event changed externally
    let expectedSnapshot: ExpectedSnapshot?
    let title: String?
    let start: String?
    let end: String?
    let day: String?
    let endDay: String?
    let isAllDay: Bool?
    let location: String?
    let notes: String?
    let url: String?
    let calendarId: String?
    let alarmMinutes: [Int]?
}

func resolveEvent(eventId: String, externalId: String?) -> EKEvent {
    if let e = store.event(withIdentifier: eventId) { return e }
    if let ext = externalId {
        let items = store.calendarItems(withExternalIdentifier: ext).compactMap { $0 as? EKEvent }
        if let e = items.first { return e }
    }
    fail("not-found", "Event no longer exists (it may have been deleted outside My Day)")
}

struct ExpectedSnapshot: Codable {
    let title: String?
    let start: String?
    let end: String?
}

/// Optimistic concurrency: lastModifiedDate has one-second granularity, so a content snapshot is checked as well.
func checkUnchanged(_ e: EKCalendarItem, _ expected: String?, snapshot: ExpectedSnapshot? = nil) {
    if let expected = expected, let exp = parseISO(expected), let actual = e.lastModifiedDate, abs(actual.timeIntervalSince(exp)) >= 1.0 {
        fail("conflict", "Item was modified outside My Day at \(iso(actual)!); reread before changing it")
    }
    guard let snap = snapshot else { return }
    if let t = snap.title, t != (e.title ?? "") { fail("conflict", "Title changed outside My Day; reread before changing it") }
    if let ev = e as? EKEvent {
        if let s = snap.start, let d = parseISO(s), abs(d.timeIntervalSince(ev.startDate)) >= 1.0 { fail("conflict", "Start changed outside My Day; reread before changing it") }
        if let en = snap.end, let d = parseISO(en), abs(d.timeIntervalSince(ev.endDate)) >= 1.0 { fail("conflict", "End changed outside My Day; reread before changing it") }
    }
}

func updateEvent() -> EventWriteResponse {
    requireFullAccess(.event)
    let input = readStdinJSON(UpdateEventInput.self)
    let e = resolveEvent(eventId: input.eventId, externalId: input.externalId)
    guard e.calendar.allowsContentModifications else { fail("read-only", "\(e.calendar.title) does not allow changes") }
    guard !e.hasRecurrenceRules, !e.isDetached else { fail("recurring", "My Day does not edit recurring events; change it in Calendar") }
    checkUnchanged(e, input.expectedLastModified, snapshot: input.expectedSnapshot)
    if let t = input.title { let tt = t.trimmingCharacters(in: .whitespacesAndNewlines); guard !tt.isEmpty else { fail("invalid-input", "title cannot be empty") }; e.title = tt }
    if input.start != nil || input.day != nil || input.isAllDay != nil {
        let allDay = input.isAllDay ?? e.isAllDay
        applyTiming(e, isAllDay: allDay, start: input.start ?? iso(e.startDate), end: input.end ?? iso(e.endDate),
                    day: input.day ?? localDay(e.startDate), endDay: input.endDay)
    }
    if let l = input.location { e.location = l.isEmpty ? nil : l }
    if let n = input.notes { e.notes = n.isEmpty ? nil : clip(n) }
    if let u = input.url { e.url = u.isEmpty ? nil : URL(string: u) }
    if let cid = input.calendarId, cid != e.calendar.calendarIdentifier { e.calendar = writableCalendar(cid, .event) }
    applyAlarms(e, input.alarmMinutes)
    do { try store.save(e, span: .thisEvent, commit: true) } catch { fail("store-error", "Could not update event: \(error.localizedDescription)", exitCode: 3) }
    return EventWriteResponse(schema: helperSchema, ok: true, event: eventInfo(e))
}

struct DeleteEventInput: Codable {
    let eventId: String
    let externalId: String?
    let expectedLastModified: String?
    let expectedSnapshot: ExpectedSnapshot?
}

struct OkResponse: Codable {
    let schema: Int
    let ok: Bool
    let detail: String
}

func deleteEvent() -> OkResponse {
    requireFullAccess(.event)
    let input = readStdinJSON(DeleteEventInput.self)
    let e = resolveEvent(eventId: input.eventId, externalId: input.externalId)
    guard !e.hasRecurrenceRules, !e.isDetached else { fail("recurring", "My Day does not delete recurring events; change it in Calendar") }
    checkUnchanged(e, input.expectedLastModified, snapshot: input.expectedSnapshot)
    do { try store.remove(e, span: .thisEvent, commit: true) } catch { fail("store-error", "Could not delete event: \(error.localizedDescription)", exitCode: 3) }
    return OkResponse(schema: helperSchema, ok: true, detail: "deleted")
}

struct GetEventInput: Codable {
    let eventId: String
    let externalId: String?
}

func getEvent() -> EventWriteResponse {
    requireFullAccess(.event)
    let input = readStdinJSON(GetEventInput.self)
    let e = resolveEvent(eventId: input.eventId, externalId: input.externalId)
    return EventWriteResponse(schema: helperSchema, ok: true, event: eventInfo(e))
}

struct CreateReminderInput: Codable {
    let listId: String
    let title: String
    let notes: String?
    let url: String?
    let dueDay: String?        // "YYYY-MM-DD"; nil = no date
    let dueTime: String?       // "HH:MM" local; requires dueDay; nil = date only
}

struct ReminderWriteResponse: Codable {
    let schema: Int
    let ok: Bool
    let reminder: ReminderInfo
}

func dueComponents(day: String?, time: String?) -> DateComponents? {
    guard let day = day else { return nil }
    let p = day.split(separator: "-").compactMap { Int($0) }
    guard p.count == 3 else { fail("invalid-input", "dueDay must be YYYY-MM-DD") }
    var c = DateComponents(calendar: Calendar.current, timeZone: TimeZone.current, year: p[0], month: p[1], day: p[2])
    if let time = time {
        let t = time.split(separator: ":").compactMap { Int($0) }
        guard t.count == 2, (0..<24).contains(t[0]), (0..<60).contains(t[1]) else { fail("invalid-input", "dueTime must be HH:MM") }
        c.hour = t[0]
        c.minute = t[1]
    } else {
        c.timeZone = nil // date-only reminders are floating dates
    }
    return c
}

func createReminder() -> ReminderWriteResponse {
    requireFullAccess(.reminder)
    let input = readStdinJSON(CreateReminderInput.self)
    let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title.count <= 1000 else { fail("invalid-input", "title is required (max 1000 characters)") }
    let list = writableCalendar(input.listId, .reminder)
    let r = EKReminder(eventStore: store)
    r.calendar = list
    r.title = title
    r.notes = clip(input.notes)
    if let u = input.url, let url = URL(string: u) { r.url = url }
    if let due = dueComponents(day: input.dueDay, time: input.dueTime) {
        r.dueDateComponents = due
        r.startDateComponents = due
    }
    do { try store.save(r, commit: true) } catch { fail("store-error", "Could not save reminder: \(error.localizedDescription)", exitCode: 3) }
    return ReminderWriteResponse(schema: helperSchema, ok: true, reminder: reminderInfo(r))
}

struct ReminderRefInput: Codable {
    let itemId: String
    let externalId: String?
    let expectedLastModified: String?
}

func resolveReminder(itemId: String, externalId: String?) -> EKReminder {
    if let r = store.calendarItem(withIdentifier: itemId) as? EKReminder { return r }
    if let ext = externalId, let r = store.calendarItems(withExternalIdentifier: ext).compactMap({ $0 as? EKReminder }).first { return r }
    fail("not-found", "Reminder no longer exists")
}

struct CompleteReminderInput: Codable {
    let itemId: String
    let externalId: String?
    let expectedLastModified: String?
    let completed: Bool
}

func completeReminder() -> ReminderWriteResponse {
    requireFullAccess(.reminder)
    let input = readStdinJSON(CompleteReminderInput.self)
    let r = resolveReminder(itemId: input.itemId, externalId: input.externalId)
    guard r.calendar.allowsContentModifications else { fail("read-only", "\(r.calendar.title) does not allow changes") }
    checkUnchanged(r, input.expectedLastModified)
    r.isCompleted = input.completed
    do { try store.save(r, commit: true) } catch { fail("store-error", "Could not update reminder: \(error.localizedDescription)", exitCode: 3) }
    return ReminderWriteResponse(schema: helperSchema, ok: true, reminder: reminderInfo(r))
}

struct SetReminderDueInput: Codable {
    let itemId: String
    let externalId: String?
    let expectedLastModified: String?
    let dueDay: String?     // nil clears the due date
    let dueTime: String?
}

func setReminderDue() -> ReminderWriteResponse {
    requireFullAccess(.reminder)
    let input = readStdinJSON(SetReminderDueInput.self)
    let r = resolveReminder(itemId: input.itemId, externalId: input.externalId)
    guard r.calendar.allowsContentModifications else { fail("read-only", "\(r.calendar.title) does not allow changes") }
    checkUnchanged(r, input.expectedLastModified)
    let due = dueComponents(day: input.dueDay, time: input.dueTime)
    r.dueDateComponents = due
    r.startDateComponents = due
    if due == nil { r.alarms = nil }
    do { try store.save(r, commit: true) } catch { fail("store-error", "Could not change due date: \(error.localizedDescription)", exitCode: 3) }
    return ReminderWriteResponse(schema: helperSchema, ok: true, reminder: reminderInfo(r))
}

struct UpdateReminderInput: Codable {
    let itemId: String
    let externalId: String?
    let expectedLastModified: String?
    let title: String?
    let notes: String?       // "" clears
    let url: String?         // "" clears
    let listId: String?
}

func updateReminder() -> ReminderWriteResponse {
    requireFullAccess(.reminder)
    let input = readStdinJSON(UpdateReminderInput.self)
    let r = resolveReminder(itemId: input.itemId, externalId: input.externalId)
    guard r.calendar.allowsContentModifications else { fail("read-only", "\(r.calendar.title) does not allow changes") }
    checkUnchanged(r, input.expectedLastModified)
    if let t = input.title {
        let tt = t.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tt.isEmpty, tt.count <= 1000 else { fail("invalid-input", "title is required (max 1000 characters)") }
        r.title = tt
    }
    if let n = input.notes { r.notes = n.isEmpty ? nil : clip(n) }
    if let u = input.url { r.url = u.isEmpty ? nil : URL(string: u) }
    if let lid = input.listId, lid != r.calendar.calendarIdentifier { r.calendar = writableCalendar(lid, .reminder) }
    do { try store.save(r, commit: true) } catch { fail("store-error", "Could not update reminder: \(error.localizedDescription)", exitCode: 3) }
    return ReminderWriteResponse(schema: helperSchema, ok: true, reminder: reminderInfo(r))
}

func getReminder() -> ReminderWriteResponse {
    requireFullAccess(.reminder)
    let input = readStdinJSON(ReminderRefInput.self)
    let r = resolveReminder(itemId: input.itemId, externalId: input.externalId)
    return ReminderWriteResponse(schema: helperSchema, ok: true, reminder: reminderInfo(r))
}

func deleteReminder() -> OkResponse {
    requireFullAccess(.reminder)
    let input = readStdinJSON(ReminderRefInput.self)
    let r = resolveReminder(itemId: input.itemId, externalId: input.externalId)
    checkUnchanged(r, input.expectedLastModified)
    do { try store.remove(r, commit: true) } catch { fail("store-error", "Could not delete reminder: \(error.localizedDescription)", exitCode: 3) }
    return OkResponse(schema: helperSchema, ok: true, detail: "deleted")
}

// Test-fixture support: create or delete a whole calendar / reminder list. Used only for My Day's own tagged fixtures.
struct CreateCalendarInput: Codable {
    let title: String
    let kind: String      // "event" | "reminder"
    let sourceId: String?
}

struct CalendarWriteResponse: Codable {
    let schema: Int
    let ok: Bool
    let calendar: CalendarInfo
    let sources: [String]
}

func createCalendar() -> CalendarWriteResponse {
    let input = readStdinJSON(CreateCalendarInput.self)
    let type: EKEntityType = input.kind == "reminder" ? .reminder : .event
    requireFullAccess(type)
    let title = input.title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { fail("invalid-input", "title is required") }
    let sources = store.sources
    // Candidate order: an explicit source, then sources that already hold a writable calendar of this kind,
    // iCloud-like first (Google CalDAV refuses new calendars), then a local source. The first that accepts wins.
    var candidates: [EKSource] = []
    if let sid = input.sourceId, let s = sources.first(where: { $0.sourceIdentifier == sid }) { candidates = [s] }
    else {
        let holders = store.calendars(for: type).filter { $0.allowsContentModifications }.compactMap { $0.source }
        var seen = Set<String>()
        let ordered = holders.filter { seen.insert($0.sourceIdentifier).inserted }
        let icloud = ordered.filter { $0.sourceType == .calDAV && $0.title.lowercased().contains("icloud") }
        let otherCalDAV = ordered.filter { $0.sourceType == .calDAV && !$0.title.lowercased().contains("icloud") }
        let local = (ordered + sources).filter { $0.sourceType == .local }
        let rest = ordered.filter { $0.sourceType != .calDAV && $0.sourceType != .local }
        seen.removeAll()
        candidates = (icloud + local + otherCalDAV + rest).filter { seen.insert($0.sourceIdentifier).inserted }
    }
    guard !candidates.isEmpty else { fail("not-found", "No calendar source can hold a new \(input.kind) calendar") }
    var cal: EKCalendar? = nil
    var errors: [String] = []
    for source in candidates {
        let c = EKCalendar(for: type, eventStore: store)
        c.title = title
        c.source = source
        do {
            try store.saveCalendar(c, commit: true)
            cal = c
            break
        } catch {
            errors.append("\(source.title): \(error.localizedDescription)")
        }
    }
    guard let cal = cal else { fail("store-error", "Could not create calendar in any source: \(errors.joined(separator: " | "))", exitCode: 3) }
    return CalendarWriteResponse(schema: helperSchema, ok: true, calendar: info(cal, kind: input.kind),
                                 sources: sources.map { "\($0.title) [\(sourceTypeName($0.sourceType))] \($0.sourceIdentifier)" })
}

struct DeleteCalendarInput: Codable {
    let calendarId: String
    let expectedTitle: String  // defence against deleting the wrong calendar
}

func deleteCalendar() -> OkResponse {
    let input = readStdinJSON(DeleteCalendarInput.self)
    guard let cal = store.calendar(withIdentifier: input.calendarId) else { fail("not-found", "No calendar with id \(input.calendarId)") }
    guard cal.title == input.expectedTitle else { fail("invalid-input", "Calendar title mismatch; refusing to delete") }
    requireFullAccess(cal.allowedEntityTypes.contains(.reminder) ? .reminder : .event)
    do { try store.removeCalendar(cal, commit: true) } catch { fail("store-error", "Could not delete calendar: \(error.localizedDescription)", exitCode: 3) }
    return OkResponse(schema: helperSchema, ok: true, detail: "deleted calendar \(cal.title)")
}

// MARK: - Main

struct AccessResponse: Codable {
    let schema: Int
    let ok: Bool
    let entity: String
    let granted: Bool
    let status: String
    let timedOut: Bool
    let error: String?
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage", "Usage: myday-helper status | request-access <events|reminders> [--timeout s] | calendars | events --from ISO --to ISO [--calendars a,b] | reminders [--lists a,b] [--include-completed] | create-event | update-event | delete-event | get-event | create-reminder | complete-reminder | set-reminder-due | get-reminder | delete-reminder | create-calendar | delete-calendar (write commands read one JSON object on stdin)")
}

switch arguments[1] {
case "status", "version":
    emit(statusResponse())
case "request-access":
    guard arguments.count >= 3, arguments[2] == "events" || arguments[2] == "reminders" else { fail("usage", "request-access <events|reminders>") }
    let type: EKEntityType = arguments[2] == "events" ? .event : .reminder
    let timeout = Double(option("--timeout") ?? "") ?? 170
    let r = requestAccess(type, timeoutSeconds: timeout)
    emit(AccessResponse(schema: helperSchema, ok: true, entity: arguments[2], granted: r.granted,
                        status: statusName(EKEventStore.authorizationStatus(for: type)), timedOut: r.timedOut, error: r.error))
case "calendars": emit(listCalendars())
case "events": emit(listEvents())
case "reminders": emit(listReminders())
case "create-event": emit(createEvent())
case "update-event": emit(updateEvent())
case "delete-event": emit(deleteEvent())
case "get-event": emit(getEvent())
case "create-reminder": emit(createReminder())
case "complete-reminder": emit(completeReminder())
case "set-reminder-due": emit(setReminderDue())
case "get-reminder": emit(getReminder())
case "update-reminder": emit(updateReminder())
case "delete-reminder": emit(deleteReminder())
case "create-calendar": emit(createCalendar())
case "delete-calendar": emit(deleteCalendar())
default:
    fail("usage", "Unknown command \(arguments[1])")
}
