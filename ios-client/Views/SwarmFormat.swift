import Foundation

// MARK: - Nexus Swarm formatting helpers (DEBUG ONLY)
//
// Shared money/date/penalty rendering for the Nexus Swarm Trust Layer
// (TrustLayerSheet). Fixes the hackathon feedback:
// unlabeled amounts ("+30"), raw ISO timestamps and unexplained "penalties".
// The whole file is wrapped in `#if DEBUG` so Release / App Store builds
// contain none of it.

enum SwarmFormat {

    // MARK: Money

    /// Format an amount ALREADY expressed in `currency` (NO FX conversion —
    /// the server settles in the trip currency). Uses `NumberFormatter` with
    /// the ISO currency code; falls back to a grouped number + `FX.symbol`
    /// when the formatter can't handle the code, and to a bare number when
    /// no currency is known (legacy payloads render exactly as before).
    /// SYMBOL-then-amount with two decimals — deliberately NOT the device
    /// locale's convention.
    ///
    /// Half of this sheet's money is composed server-side (`ledger_summary`
    /// carries ready-made strings like "+€25.00"), and a locale-aware client
    /// formatter rendered the SAME amount as "25 €" in the headline directly
    /// above "+€25.00" in the breakdown. One bill has to read one way, and the
    /// only convention both halves can share is the server's, because prose
    /// lines cannot be re-formatted on the device.
    ///
    /// Scope is contained: this is `#if DEBUG` swarm-only formatting. Every
    /// other price in the app keeps its locale-aware rendering.
    static func money(_ value: Double, currency: String?) -> String {
        let digits = value.truncatingRemainder(dividingBy: 1) == 0 ? 0 : 2
        guard let code = currency?.trimmingCharacters(in: .whitespaces), !code.isEmpty else {
            // Legacy bare-number rendering for payloads without a currency.
            return value.formatted(.number.precision(.fractionLength(digits)))
        }
        let amount = String(format: "%.2f", value)
        return "\(symbol(for: code.uppercased()))\(amount)"
    }

    /// Mirrors the server's `currencySymbol` (src/lib/hackathonApi.ts) so the
    /// two halves of the ledger cannot disagree. An unlisted code falls back to
    /// "CODE " on both sides.
    private static func symbol(for code: String) -> String {
        switch code {
        case "EUR": return "€"
        case "USD": return "$"
        case "GBP": return "£"
        case "JPY": return "¥"
        default: return "\(code) "
        }
    }

    // MARK: Dates

    private static let isoFormatters: [ISO8601DateFormatter] = {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return [withFractional, plain]
    }()

    private static let dateOnlyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// ISO8601 string → local-time "EEE d MMM · HH:mm" (e.g. "Thu 10 Sep ·
    /// 14:00"). Raw ISO is NEVER shown when parseable; the raw string only
    /// survives when it doesn't look like an ISO timestamp at all (it's then
    /// assumed to be already-human text).
    static func isoToLocalString(_ iso: String?) -> String {
        guard let raw = iso?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return "" }
        if let date = parseISO(raw) {
            let f = DateFormatter()
            f.locale = Locale.autoupdatingCurrent
            f.timeZone = TimeZone.current
            f.dateFormat = "EEE d MMM · HH:mm"
            return f.string(from: date)
        }
        // Unparsable: if it looks like an ISO timestamp, sanitize it into
        // something human instead of leaking "T"/"Z"/milliseconds.
        if looksLikeISO(raw) {
            var cleaned = raw
                .replacingOccurrences(of: "T", with: " · ")
                .replacingOccurrences(of: "Z", with: "")
            if let dot = cleaned.firstIndex(of: ".") {
                // Drop the ".123456" fractional run and KEEP whatever follows it
                // (the offset). Slicing the numeric run instead printed the raw
                // microseconds and threw the offset away — a Postgres
                // `timestamptz` ("2026-09-10 14:00:00.123456+02", which neither
                // ISO8601 formatter accepts) rendered as "14:00:00 123456".
                let tail = cleaned[cleaned.index(after: dot)...]
                let cut = tail.firstIndex(where: { !$0.isNumber })
                cleaned = String(cleaned[..<dot]) + (cut.map { " " + String(tail[$0...]) } ?? "")
            }
            cleaned = cleaned
                .replacingOccurrences(of: "+00:00", with: "")
                .trimmingCharacters(in: .whitespaces)
            return cleaned
        }
        return raw
    }

    private static func parseISO(_ raw: String) -> Date? {
        for f in isoFormatters {
            if let date = f.date(from: raw) { return date }
        }
        // Bare date ("2026-09-10") — midnight UTC, still better than raw text.
        if raw.count == 10, let date = dateOnlyFormatter.date(from: raw) { return date }
        return nil
    }

    private static func looksLikeISO(_ raw: String) -> Bool {
        // "2026-09-10T13:00…" / "2026-09-10 13:00…"
        guard raw.count >= 10 else { return false }
        let chars = Array(raw)
        return chars[0].isNumber && chars[1].isNumber && chars[2].isNumber && chars[3].isNumber
            && chars[4] == "-" && chars[7] == "-"
    }

    // MARK: Wall-clock transit stamps
    //
    // The timeline renders a leg's `depart`/`arrive` EXACTLY as written in the
    // trip document — `TripDetailView.parseTransitStamp` pulls "HH:mm" out with
    // a regex and never converts time zones, because a flight's times are
    // already local to its airports. Anything in the swarm that shows the same
    // stamp must use the same reading, or the traveler sees one time on the
    // plan card and a different one on the timeline for one flight (a leg
    // stored as 14:00Z reads "16:00" on a UTC+2 phone and "14:00" on the
    // timeline). `isoToLocalString` above stays for genuinely instant-like
    // values (quote expiry), which SHOULD follow the device clock.

    /// "HH:mm" exactly as written in the stamp; nil when it carries no time.
    static func wallClockTime(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        guard let r = raw.range(of: #"\d{1,2}:\d{2}"#, options: .regularExpression) else { return nil }
        let hhmm = String(raw[r])
        // Pad "9:05" → "09:05" so columns line up with the timeline's.
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]) else { return hhmm }
        return String(format: "%02d:%@", h, String(parts[1]))
    }

    /// "yyyy-MM-dd" exactly as written in the stamp; nil when absent.
    static func wallClockDay(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        guard let r = raw.range(of: #"\d{4}-\d{2}-\d{2}"#, options: .regularExpression) else { return nil }
        return String(raw[r])
    }

    /// Minutes from `depart` to `arrive` read as wall clock, spanning days via
    /// the stamps' own dates. nil when either side carries no usable time.
    static func minutesBetween(_ depart: String?, _ arrive: String?) -> Int? {
        guard let from = wallClockMinutes(depart), let to = wallClockMinutes(arrive) else { return nil }
        var delta = to - from
        if let d1 = wallClockDay(depart), let d2 = wallClockDay(arrive),
           let dayGap = dayGapBetween(d1, d2) {
            delta += dayGap * 24 * 60
        } else if delta < 0 {
            // No dates to lean on — a backwards clock means it landed the
            // next day.
            delta += 24 * 60
        }
        return delta >= 0 ? delta : nil
    }

    /// Compact leg label for pickers and plan cards: "28 Aug · 14:00 – 20:00",
    /// with a "+1" marker when the leg lands on a later day. Falls back to
    /// whatever is readable rather than leaking a raw ISO string.
    static func transitRangeLabel(depart: String?, arrive: String?) -> String {
        let departTime = wallClockTime(depart)
        let arriveTime = wallClockTime(arrive)
        var parts: [String] = []
        if let day = wallClockDay(depart), let pretty = prettyDay(day) { parts.append(pretty) }

        var range = ""
        if let departTime, let arriveTime {
            range = "\(departTime) – \(arriveTime)"
            if let d1 = wallClockDay(depart), let d2 = wallClockDay(arrive),
               let gap = dayGapBetween(d1, d2), gap > 0 {
                range += " +\(gap)"
            }
        } else if let departTime {
            range = departTime
        } else if let arriveTime {
            range = arriveTime
        }
        if !range.isEmpty { parts.append(range) }
        if parts.isEmpty {
            // Nothing parseable — never leak "2026-08-28T14:00:00Z".
            return isoToLocalString(depart)
        }
        return parts.joined(separator: " · ")
    }

    /// Minutes since midnight of a stamp's wall-clock time.
    private static func wallClockMinutes(_ raw: String?) -> Int? {
        guard let hhmm = wallClockTime(raw) else { return nil }
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
        return h * 60 + m
    }

    /// Whole days between two "yyyy-MM-dd" strings; nil when either is invalid.
    private static func dayGapBetween(_ from: String, _ to: String) -> Int? {
        guard let d1 = dateOnlyFormatter.date(from: from),
              let d2 = dateOnlyFormatter.date(from: to) else { return nil }
        return Int((d2.timeIntervalSince(d1) / 86_400).rounded())
    }

    /// "2026-08-28" → "28 Aug", formatted in UTC so the printed day matches
    /// the one written in the stamp.
    private static func prettyDay(_ isoDay: String) -> String? {
        guard let date = dateOnlyFormatter.date(from: isoDay) else { return nil }
        let f = DateFormatter()
        f.locale = Locale.autoupdatingCurrent
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "d MMM"
        return f.string(from: date)
    }

    /// A rescheduled activity's new slot read as WALL CLOCK — "28 Aug · 15:00".
    ///
    /// The swarm anchors a written time to UTC on the wire on purpose
    /// (`swarmTripContext.parseEpoch` parses "15:00" as 15:00Z so every
    /// read/write round trip preserves the digits the traveler sees), and the
    /// server's own human `new_time` prints it back with `getUTCHours()`.
    /// Reading `new_time_iso` against the DEVICE clock therefore showed 23:00
    /// on a UTC+8 phone for a 15:00 activity — disagreeing with the timeline,
    /// with the picker, and with the server's own wording. Invisible at UTC,
    /// which is why it survived.
    ///
    /// Falls back to `human` (already traveler-readable) when the stamp
    /// carries no usable wall clock.
    static func activitySlotLabel(iso: String?, human: String?) -> String {
        if let time = wallClockTime(iso) {
            if let day = wallClockDay(iso), let pretty = prettyDay(day) {
                return "\(pretty) · \(time)"
            }
            return time
        }
        let fallback = human?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return fallback.isEmpty ? isoToLocalString(iso) : fallback
    }

    /// "6h 00" / "45 min" from a minute count — the duration chip's wording.
    static func durationLabel(minutes: Int) -> String {
        guard minutes > 0 else { return "" }
        let h = minutes / 60
        let m = minutes % 60
        if h == 0 { return "\(m) min" }
        return m == 0 ? "\(h)h" : String(format: "%dh %02d", h, m)
    }

    /// "Non-stop" / "1 stop via MAD" / "2 stops" — nil when the provider did
    /// not describe the routing, so the card says nothing rather than guessing.
    static func stopsLabel(stops: Int?, via: [String]?) -> String? {
        guard let stops, stops >= 0 else { return nil }
        if stops == 0 { return "Direct" }
        let base = stops == 1 ? "1 stop" : "\(stops) stops"
        let airports = (via ?? []).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return airports.isEmpty ? base : "\(base) via \(airports.joined(separator: ", "))"
    }

    // MARK: Penalties

    /// Caption explaining a rescheduled activity's penalty: the server's
    /// `reason` when present, otherwise a generic provider-fee explanation.
    static func penaltyExplanation(_ activity: SwarmService.RescheduledActivity) -> String {
        penaltyExplanation(reason: activity.reason)
    }

    /// Reason-string overload for wire models that don't share
    /// `SwarmService.RescheduledActivity`.
    static func penaltyExplanation(reason: String?) -> String {
        if let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
            return reason
        }
        return "Change/cancellation fee charged by the activity provider"
    }
}
