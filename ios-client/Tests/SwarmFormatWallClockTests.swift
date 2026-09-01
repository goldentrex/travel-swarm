import Foundation
import Testing
@testable import GlobePlanner

#if DEBUG
/// The swarm shows the SAME transit stamps the timeline shows, and the
/// timeline reads them as wall clock (`TripDetailView.parseTransitStamp`
/// pulls "HH:mm" out with a regex and never converts time zones, because a
/// flight's times are already local to its airports).
///
/// Anything in the swarm that renders a leg must read it the same way, or one
/// flight carries two different times: the mission picker and the plan card
/// used `DateFormatter`/`isoToLocalString`, so a leg stored as 14:00Z showed
/// "16:00" on a UTC+2 phone and "14:00" on the timeline — and appeared to
/// change time the moment the traveler approved it.
@Suite("Swarm wall-clock formatting")
struct SwarmFormatWallClockTests {

    // MARK: wallClockTime

    @Test("reads the written time regardless of the device time zone")
    func readsWrittenTime() {
        #expect(SwarmFormat.wallClockTime("2026-08-28T14:00:00Z") == "14:00")
        // A trailing offset must not shift the printed time either.
        #expect(SwarmFormat.wallClockTime("2026-08-28T14:00:00+02:00") == "14:00")
        // Seconds-less stamps are common in stored trip content.
        #expect(SwarmFormat.wallClockTime("2026-08-28T09:05") == "09:05")
    }

    @Test("pads a single-digit hour so columns line up with the timeline")
    func padsHour() {
        #expect(SwarmFormat.wallClockTime("2026-08-28T9:05") == "09:05")
    }

    @Test("returns nil rather than inventing a time")
    func nilWithoutTime() {
        #expect(SwarmFormat.wallClockTime("2026-08-28") == nil)
        #expect(SwarmFormat.wallClockTime("") == nil)
        #expect(SwarmFormat.wallClockTime(nil) == nil)
    }

    // MARK: minutesBetween

    @Test("measures a same-day leg in wall-clock minutes")
    func sameDayDuration() {
        #expect(SwarmFormat.minutesBetween("2026-08-28T14:00:00Z",
                                           "2026-08-28T20:00:00Z") == 360)
    }

    @Test("spans midnight using the stamps' own dates")
    func overnightDuration() {
        #expect(SwarmFormat.minutesBetween("2026-08-28T22:30:00Z",
                                           "2026-08-29T06:15:00Z") == 465)
    }

    @Test("falls back to a next-day reading when only times are present")
    func overnightWithoutDates() {
        #expect(SwarmFormat.minutesBetween("22:30", "06:15") == 465)
    }

    @Test("returns nil when either endpoint carries no time")
    func nilDuration() {
        #expect(SwarmFormat.minutesBetween("2026-08-28", "2026-08-29T06:15:00Z") == nil)
        #expect(SwarmFormat.minutesBetween(nil, nil) == nil)
    }

    // MARK: transitRangeLabel

    @Test("labels a leg with its written day and times")
    func rangeLabel() {
        let label = SwarmFormat.transitRangeLabel(depart: "2026-08-28T14:00:00Z",
                                                  arrive: "2026-08-28T20:00:00Z")
        #expect(label.contains("14:00 – 20:00"))
        #expect(label.contains("28 Aug"))
        #expect(!label.contains("+"))  // same day ⇒ no overnight marker
    }

    @Test("marks an overnight leg with the day it lands")
    func overnightMarker() {
        let label = SwarmFormat.transitRangeLabel(depart: "2026-08-28T22:30:00Z",
                                                  arrive: "2026-08-29T06:15:00Z")
        #expect(label.contains("22:30 – 06:15 +1"))
    }

    @Test("never leaks a raw ISO string")
    func noRawIso() {
        let label = SwarmFormat.transitRangeLabel(depart: "2026-08-28T14:00:00Z", arrive: nil)
        #expect(!label.contains("T"))
        #expect(!label.contains("Z"))
        #expect(label.contains("14:00"))
    }

    // MARK: money

    @Test("prints money the same way the server's ledger lines do")
    func moneyMatchesLedgerConvention() {
        // The sheet mixes client-formatted amounts with server-composed
        // `ledger_summary` prose ("+€25.00"). A locale-aware formatter printed
        // the same amount as "25 €" in the headline directly above "+€25.00"
        // in the breakdown, so both halves now use symbol-then-amount.
        #expect(SwarmFormat.money(25, currency: "EUR") == "€25.00")
        #expect(SwarmFormat.money(454.55, currency: "USD") == "$454.55")
        #expect(SwarmFormat.money(0, currency: "JPY") == "¥0.00")
        #expect(SwarmFormat.money(1234.5, currency: "GBP") == "£1234.50")
    }

    @Test("falls back to the code for a currency with no symbol")
    func moneyUnknownCurrency() {
        // Mirrors the server's `currencySymbol` default ("CODE ").
        #expect(SwarmFormat.money(30, currency: "CHF") == "CHF 30.00")
        // No currency at all — legacy payloads stay a bare number.
        #expect(SwarmFormat.money(30, currency: nil) == "30")
    }

    // MARK: activitySlotLabel

    @Test("reads a rescheduled activity's slot as wall clock, not device time")
    func activitySlotIsWallClock() {
        // The wire anchors a written activity time to UTC on purpose
        // (swarmTripContext.parseEpoch), and the server's own human `new_time`
        // prints it back with getUTCHours(). Reading it against the device
        // clock showed 23:00 for a 15:00 activity on a UTC+8 phone.
        let label = SwarmFormat.activitySlotLabel(iso: "2026-08-28T15:00:00.000Z",
                                                  human: "Tomorrow 15:00")
        #expect(label.contains("15:00"))
        #expect(label.contains("28 Aug"))
        #expect(!label.contains("T"))
        #expect(!label.contains("Z"))
    }

    @Test("falls back to the server's human wording when there is no stamp")
    func activitySlotFallback() {
        #expect(SwarmFormat.activitySlotLabel(iso: nil, human: "Tomorrow 15:00")
                == "Tomorrow 15:00")
        // A stamp carrying no time must not swallow the readable fallback.
        #expect(SwarmFormat.activitySlotLabel(iso: "2026-08-28", human: "Tomorrow 15:00")
                == "Tomorrow 15:00")
    }

    @Test("shows the time alone when the stamp carries no date")
    func activitySlotTimeOnly() {
        #expect(SwarmFormat.activitySlotLabel(iso: "15:00", human: nil) == "15:00")
    }

    // MARK: durationLabel / stopsLabel

    @Test("writes durations the way a traveler reads them")
    func durationWording() {
        #expect(SwarmFormat.durationLabel(minutes: 45) == "45 min")
        #expect(SwarmFormat.durationLabel(minutes: 120) == "2h")
        #expect(SwarmFormat.durationLabel(minutes: 150) == "2h 30")
        #expect(SwarmFormat.durationLabel(minutes: 0) == "")
    }

    @Test("names the stops, and the airports when known")
    func stopsWording() {
        #expect(SwarmFormat.stopsLabel(stops: 0, via: nil) == "Direct")
        #expect(SwarmFormat.stopsLabel(stops: 1, via: ["MAD"]) == "1 stop via MAD")
        #expect(SwarmFormat.stopsLabel(stops: 2, via: ["MAD", "LIS"]) == "2 stops via MAD, LIS")
        #expect(SwarmFormat.stopsLabel(stops: 1, via: []) == "1 stop")
    }

    @Test("says nothing when the provider did not describe the routing")
    func stopsUnknown() {
        // Absent must never render as "Direct": that is a claim about a
        // routing the swarm could not read.
        #expect(SwarmFormat.stopsLabel(stops: nil, via: nil) == nil)
        #expect(SwarmFormat.stopsLabel(stops: nil, via: ["MAD"]) == nil)
    }

    // MARK: isoToLocalString — the unparseable fallback

    /// REGRESSION. A Postgres `timestamptz` renders as
    /// "2026-09-10 14:00:00.123456+02" — a space separator and a 2-digit offset,
    /// which BOTH `ISO8601DateFormatter`s refuse, so it lands in the sanitize
    /// fallback. That branch meant to drop the fractional run and keep the
    /// offset; it kept the digits and dropped the offset, showing the traveler
    /// "2026-09-10 14:00:00 123456".
    @Test("a Postgres timestamptz loses its microseconds, not its offset")
    func postgresStampIsSanitized() {
        let out = SwarmFormat.isoToLocalString("2026-09-10 14:00:00.123456+02")
        #expect(!out.contains("123456"), "raw microseconds leaked into the UI: \(out)")
        #expect(out.contains("14:00:00"))
        #expect(out.contains("+02"), "the offset was thrown away: \(out)")
    }

    /// The stamps the formatters DO accept must keep converting as before — the
    /// fallback is only for what they reject.
    @Test("parseable stamps are unaffected by the fallback")
    func parseableStampsUnchanged() {
        #expect(!SwarmFormat.isoToLocalString("2026-09-10T14:00:00.123456+02:00").isEmpty)
        #expect(!SwarmFormat.isoToLocalString("2026-09-10T14:00:00.123456+02:00").contains("123456"))
        // No offset at all ⇒ fallback, nothing to keep after the fractional run.
        #expect(SwarmFormat.isoToLocalString("2026-09-10T14:00:00.123456") == "2026-09-10 · 14:00:00")
    }
}
#endif
