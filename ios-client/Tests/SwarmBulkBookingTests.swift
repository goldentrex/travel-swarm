import Foundation
import Testing
@testable import GlobePlanner

/// `MarkBookedService.applyBulkBooking` is the write behind the swarm's "book
/// everything with Swarm" sheet: ONE confirmation flips `booked` on a whole list
/// of checklist rows at once, with no per-row editor to catch a mistake.
///
/// That makes two things load-bearing, and this suite pins both:
///  • it must write EVERY night of a hotel (one real booking, one item per night)
///    without one night's write clobbering another's;
///  • it must report how many rows actually resolved, so the sheet can refuse to
///    claim success on a trip that changed underneath it.
@Suite("Swarm bulk booking")
struct SwarmBulkBookingTests {

    // MARK: Fixtures — TripContent is Codable, so JSON is the least brittle builder.

    private func decoded(_ object: [String: Any]) -> TripContent {
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(TripContent.self, from: data)
    }

    private func leg(_ id: String, ref: String) -> [String: Any] {
        ["id": id,
         "method": "flight",
         "reference": ref,
         "carrier": "TAP",
         "origin": ["code": "CDG", "city": "Paris"],
         "destination": ["code": "LIS", "city": "Lisbon"],
         "depart": "2026-09-05T09:55"]
    }

    private func stay(_ title: String) -> [String: Any] {
        ["type": "stay", "title": title]
    }

    private func day(_ n: Int, _ items: [[String: Any]]) -> [String: Any] {
        ["day": n, "date": "2026-09-0\(n)", "items": items]
    }

    /// The rows the sheet would show: everything open that genuinely needs booking.
    private func openRows(_ raw: [String: Any]) -> [BookingChecklist.Bookable] {
        BookingChecklist.derive(from: decoded(raw))
            .filter { !$0.booked && $0.style.needsBooking }
    }

    private func booked(_ raw: [String: Any], day d: Int, item i: Int) -> Bool {
        let itinerary = raw["itinerary"] as! [[String: Any]]
        let items = itinerary[d]["items"] as! [[String: Any]]
        return (items[i]["booked"] as? Bool) == true
    }

    // MARK: A hotel is ONE booking spread over per-night items

    @Test("every night of a multi-night stay is flipped, from a single row")
    func stayFansOutAcrossNights() {
        let raw: [String: Any] = [
            "itinerary": [
                day(1, [stay("Atlantica Surf House")]),
                day(2, [stay("Atlantica Surf House")]),
                day(3, [stay("Atlantica Surf House")]),
            ]
        ]
        let rows = openRows(raw)
        // Three nights collapse into ONE checklist row.
        #expect(rows.count == 1)

        let (out, applied) = MarkBookedService.applyBulkBooking(raw, for: rows)
        #expect(applied == 1)
        for d in 0..<3 {
            #expect(booked(out, day: d, item: 0), "night \(d + 1) was left unbooked")
        }
    }

    /// REGRESSION. The first version of this write built one mutated copy of the
    /// row's OWN day, fanned the group out day by day, and then wrote that stale
    /// copy back over the row's day last — so a stay with two nights on the SAME
    /// day silently lost the second one. The traveler saw "booked", the checklist
    /// kept nagging, and nothing said why.
    @Test("two nights of one stay on the SAME day both survive the write")
    func sameDayNightsDoNotClobberEachOther() {
        let raw: [String: Any] = [
            "itinerary": [
                day(1, [stay("Atlantica Surf House"), stay("Atlantica Surf House")]),
            ]
        ]
        let rows = openRows(raw)
        #expect(rows.count == 1)

        let (out, applied) = MarkBookedService.applyBulkBooking(raw, for: rows)
        #expect(applied == 1)
        #expect(booked(out, day: 0, item: 0))
        #expect(booked(out, day: 0, item: 1), "the second night on the same day was clobbered")
    }

    // MARK: Transit legs are addressed by identity, never by position

    @Test("a leg is found by its id even after the list was reordered underneath")
    func transitIsAddressedById() {
        let derivedFrom: [String: Any] = [
            "transit_groups": [leg("tg-out", ref: "TP437"), leg("tg-back", ref: "TP438")]
        ]
        // The row the traveler confirmed: the OUTBOUND leg, first in the list.
        let outbound = openRows(derivedFrom).first { $0.title.contains("TP437") }
        #expect(outbound != nil)

        // Meanwhile the trip was rewritten and the legs came back the other way
        // round. Position-addressing would now book the return flight.
        let fresh: [String: Any] = [
            "transit_groups": [leg("tg-back", ref: "TP438"), leg("tg-out", ref: "TP437")]
        ]
        let (out, applied) = MarkBookedService.applyBulkBooking(fresh, for: [outbound!])
        #expect(applied == 1)

        let legs = out["transit_groups"] as! [[String: Any]]
        #expect((legs[0]["booked"] as? Bool) != true, "the return leg was booked by mistake")
        #expect((legs[1]["booked"] as? Bool) == true, "the outbound leg was not booked")
    }

    // MARK: The count has to be honest — the sheet reports success from it

    @Test("a row whose position no longer exists is not counted as booked")
    func staleRowIsNotCounted() {
        let derivedFrom: [String: Any] = [
            "itinerary": [day(1, [stay("Hotel A")]), day(2, [stay("Hotel B")])]
        ]
        let rows = openRows(derivedFrom)
        #expect(rows.count == 2)

        // Day 2 is gone by the time the traveler confirms.
        let fresh: [String: Any] = ["itinerary": [day(1, [stay("Hotel A")])]]
        let (out, applied) = MarkBookedService.applyBulkBooking(fresh, for: rows)

        #expect(applied == 1, "only the row that still resolves may be counted")
        #expect(booked(out, day: 0, item: 0))
    }

    @Test("nothing resolves ⇒ applied is 0, so the sheet can refuse to claim success")
    func everythingStaleReportsZero() {
        let derivedFrom: [String: Any] = [
            "transit_groups": [leg("tg-out", ref: "TP437")],
            "itinerary": [day(1, [stay("Hotel A")])],
        ]
        let rows = openRows(derivedFrom)
        #expect(rows.count == 2)

        let fresh: [String: Any] = ["transit_groups": [], "itinerary": []]
        let (_, applied) = MarkBookedService.applyBulkBooking(fresh, for: rows)
        #expect(applied == 0)
    }

    // MARK: Nothing outside the given rows moves

    @Test("only the confirmed rows are touched")
    func untouchedItemsStayUnbooked() {
        let raw: [String: Any] = [
            "itinerary": [
                day(1, [stay("Hotel A"),
                        ["type": "dining", "title": "Cervejaria Ramiro",
                         "booking": ["mode": "recommended"]]]),
            ]
        ]
        let rows = openRows(raw)
        let stayRow = rows.filter { $0.category == "stay" }
        #expect(stayRow.count == 1)
        // The dining row exists but is deliberately left to the traveler.
        #expect(rows.contains { $0.category == "dining" })

        let (out, applied) = MarkBookedService.applyBulkBooking(raw, for: stayRow)
        #expect(applied == 1)
        #expect(booked(out, day: 0, item: 0))
        #expect(!booked(out, day: 0, item: 1), "the dining row was booked without being confirmed")
    }
}
