import Foundation

// MARK: - Which trip entries can be a swarm mission target (DEBUG ONLY)
//
// The backend derives its graph node ids from the SAME trip document the
// pickers read (`flight-<idx>` / `transfer-<idx>` from `transit_groups`,
// `activity-<day>-<item>` from the day items), but it drops entries it cannot
// use. Anything this file rejects has no node on the server, so offering it as
// a mission target would send a nodeId the swarm does not know and dead-end in
// a 404 after the traveler had already picked it.
//
// Mirrors `findTransitRestatements` in src/lib/swarmTripContext.ts. Keep the
// two in step: they must agree on which day items are real activities.

enum SwarmMissionTargets {

    /// Mode words that identify a day item restating a transit leg, per leg
    /// `method`. Best-effort across the shipped languages, matching both the
    /// backend list and `TripDetailView.transitModeWords`.
    private static let modeWords: [String: [String]] = [
        "flight": ["flight", "flights", "fly", "flying", "plane", "vol", "avion"],
        "train": ["train", "rail", "railway", "tgv"],
        "bus": ["bus", "coach", "autocar"],
        "car": ["transfer", "drive", "driving", "taxi", "shuttle", "navette"],
        "ferry": ["ferry", "boat"],
    ]

    /// Comparison form for reference tokens: "AF 276" and "AF276" must match.
    private static func normalized(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    /// "yyyy-MM-dd" exactly as written in a stamp.
    private static func writtenDay(_ raw: String?) -> String? {
        guard let raw,
              let r = raw.range(of: #"\d{4}-\d{2}-\d{2}"#, options: .regularExpression)
        else { return nil }
        return String(raw[r])
    }

    /// True when `item` merely restates one of `legs` rather than describing a
    /// separate plan — e.g. an `activity` item titled "Flight TP437 CDG → LIS"
    /// alongside the real leg. Trip generation emits these routinely, since a
    /// day item's type can only be stay/activity/dining/transit.
    ///
    /// Matched the same two narrow ways the timeline and the backend use: the
    /// leg's own reference (the one token a restatement reliably repeats), or
    /// the leg's mode word TOGETHER with either endpoint. Deliberately narrow —
    /// a miss only leaves an extra picker row, while a false positive would
    /// hide a genuine activity the traveler wanted to change.
    static func restatesTransitLeg(_ item: DayItem, dayDate: String?, legs: [Transit]) -> Bool {
        let title = item.title.text.lowercased()
        guard !title.isEmpty else { return false }
        let normalizedTitle = normalized(title)

        for leg in legs {
            // Scope to the leg's own travel day when BOTH dates are known, so
            // a return flight's restatement never matches the outbound leg.
            if let legDay = writtenDay(leg.depart), let dayDate,
               let itemDay = writtenDay(dayDate), legDay != itemDay {
                continue
            }
            if let reference = leg.reference {
                let token = normalized(reference)
                if token.count >= 3 && normalizedTitle.contains(token) { return true }
            }
            let words = modeWords[(leg.method ?? "").lowercased()] ?? []
            guard words.contains(where: { title.contains($0) }) else { continue }
            let endpoints = [
                leg.origin?.city, leg.origin?.code,
                leg.destination?.city, leg.destination?.code,
            ]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { $0.count > 1 }
            if endpoints.contains(where: { title.contains($0) }) { return true }
        }
        return false
    }
}
