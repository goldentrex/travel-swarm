import Foundation
import Testing
@testable import GlobePlanner

#if DEBUG
/// Generated trips restate a flight INSIDE a day as an `activity` item (a day
/// item's type can only be stay/activity/dining/transit), alongside the real
/// leg in `transit_groups`. Those restatements are not activities: the swarm
/// gives them no graph node, so offering one in the "activity cancelled"
/// picker would send a nodeId the backend does not know.
///
/// The matcher is deliberately narrow — a miss only leaves an extra picker
/// row, a false positive hides a genuine activity the traveler wanted to
/// change — so both directions are pinned here.
@Suite("Swarm mission targets")
struct SwarmMissionTargetTests {

    private func leg(reference: String? = "TP437",
                     method: String = "flight",
                     depart: String? = "2026-08-28T09:00:00Z",
                     originCity: String? = "Paris",
                     originCode: String? = "CDG",
                     destCity: String? = "Lisbon",
                     destCode: String? = "LIS") -> Transit {
        Transit(id: "tg0",
                method: method,
                origin: TransitEndpoint(code: originCode, city: originCity, coordinates: nil),
                destination: TransitEndpoint(code: destCode, city: destCity, coordinates: nil),
                carrier: "TAP Air Portugal",
                reference: reference,
                depart: depart,
                arrive: "2026-08-28T11:30:00Z",
                durationHrs: nil,
                cabin: nil,
                price: nil,
                booked: true)
    }

    private func item(_ title: String, type: String = "activity", time: String? = "09:00") -> DayItem {
        DayItem(type: type, title: Loc(title), subtitle: nil, duration: nil, cost: nil,
                image: nil, coordinates: nil, time: time, booked: nil)
    }

    @Test("a title repeating the leg reference is a restatement")
    func referenceMatch() {
        #expect(SwarmMissionTargets.restatesTransitLeg(
            item("Flight TP437 CDG → LIS"), dayDate: "2026-08-28", legs: [leg()]))
    }

    @Test("a spaced reference still matches the way titles write it")
    func spacedReference() {
        #expect(SwarmMissionTargets.restatesTransitLeg(
            item("Overnight flight TP 437"), dayDate: "2026-08-28", legs: [leg()]))
    }

    @Test("a mode word plus an endpoint is a restatement without the reference")
    func modeAndEndpoint() {
        #expect(SwarmMissionTargets.restatesTransitLeg(
            item("Morning flight to Lisbon"), dayDate: "2026-08-28", legs: [leg()]))
    }

    @Test("a city name alone never hides a genuine activity")
    func cityAloneIsNotEnough() {
        // "Lisbon" matches an endpoint but carries no mode word — this is a
        // real activity the traveler must still be able to target.
        #expect(!SwarmMissionTargets.restatesTransitLeg(
            item("Lisbon Food Tour"), dayDate: "2026-08-28", legs: [leg()]))
    }

    @Test("a mode word alone never hides a genuine activity")
    func modeAloneIsNotEnough() {
        // A scenic flight elsewhere is not this leg.
        #expect(!SwarmMissionTargets.restatesTransitLeg(
            item("Helicopter flight over the coast"), dayDate: "2026-08-28",
            legs: [leg(originCity: nil, originCode: nil, destCity: nil, destCode: nil)]))
    }

    @Test("a restatement is scoped to the leg's own travel day")
    func scopedToDay() {
        // The return flight's restatement on a later day must not match the
        // outbound leg departing 28 Aug.
        #expect(!SwarmMissionTargets.restatesTransitLeg(
            item("Flight to Lisbon"), dayDate: "2026-09-04", legs: [leg()]))
    }

    @Test("an untitled item is never a restatement")
    func emptyTitle() {
        #expect(!SwarmMissionTargets.restatesTransitLeg(
            item(""), dayDate: "2026-08-28", legs: [leg()]))
    }

    @Test("a trip without transit legs has no restatements")
    func noLegs() {
        #expect(!SwarmMissionTargets.restatesTransitLeg(
            item("Flight TP437 CDG → LIS"), dayDate: "2026-08-28", legs: []))
    }
}
#endif
