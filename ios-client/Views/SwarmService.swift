import Foundation

// MARK: - Travel Swarm service
//
// URLSession client for the `/api/hackathon/*` swarm endpoints: mission
// launch, live swarm-status polling, background alerts, and Trust Layer
// settlement.
//
// This file SHIPS in Release. It was `#if DEBUG`-only until the swarm went to
// real testers; the switch that withdraws the feature is now server-side
// (`SWARM_ENABLED` on the Worker, read through `SwarmAvailability`), which can
// be flipped with a `wrangler deploy` instead of an App Store round trip.
//
// Wire contract mirrors `src/agents/finance/TrustLayer.ts` (extended
// `ResolutionPlan`, SPEC §3.4) — snake_case fields decoded via explicit
// CodingKeys with tolerant fallbacks, the `HackathonDisruptionService` style.

// MARK: - Demo server origin (DEBUG ONLY)
//
// Shared, configurable origin for the hackathon demo server. The default is
// the isolated swarm demo Worker (https://your-worker.example.com). Override
// via the UserDefaults key `SwarmConfig.overrideKey` for local LAN dev when
// the Mac's DHCP IP changes, e.g.:
//   defaults write com.goldentrex.globeplanner swarm.demoOrigin "http://192.168.1.20:8080"

enum SwarmConfig {
    /// Override via UserDefaults key "swarm.demoOrigin" (e.g. "http://192.168.1.20:8080") —
    /// useful for local LAN dev when the Mac's DHCP IP changes.
    static let overrideKey = "swarm.demoOrigin"

    static var origin: String {
        if let o = UserDefaults.standard.string(forKey: overrideKey),
           !o.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            var cleaned = o.trimmingCharacters(in: .whitespacesAndNewlines)
            while cleaned.hasSuffix("/") { cleaned.removeLast() }
            return cleaned
        }
        // Default: the isolated swarm demo Worker.
        return "https://your-worker.example.com"
    }

    static var apiBase: String { origin + "/api/hackathon" }

    /// Override via UserDefaults key "swarm.demoToken".
    static let tokenOverrideKey = "swarm.demoToken"

    /// Shared bearer for the isolated swarm Worker.
    ///
    /// Injected at build time from `Secrets.xcconfig` (gitignored) via the
    /// `SwarmDemoToken` Info.plist key — see `Secrets.example.xcconfig`. It
    /// used to be a string literal here, which put a live credential in git
    /// history, in every Release binary, and in a file that is also published
    /// as a standalone open-source repo.
    ///
    /// It is the SECOND factor only: every endpoint that reads or writes a
    /// trip additionally requires the traveler's own Supabase access token
    /// (`X-Swarm-User-Token`), so this token alone grants nothing.
    ///
    /// Empty in a checkout with no `Secrets.xcconfig`. That is deliberate —
    /// the swarm then fails visibly rather than a placeholder silently
    /// becoming the shipped secret. Rotate with `wrangler secret put
    /// SWARM_DEMO_TOKEN` and update the xcconfig; no source change.
    static var demoToken: String {
        if let t = UserDefaults.standard.string(forKey: tokenOverrideKey),
           !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return t.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let injected = Bundle.main.object(forInfoDictionaryKey: "SwarmDemoToken") as? String ?? ""
        return injected.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum SwarmService {

    /// vite dev server. NOTE: `localhost` only works on the SIMULATOR (plain
    /// HTTP is exempt from ATS for localhost by default). To run on a
    /// physical device, set the `SwarmConfig.overrideKey` UserDefaults to
    /// your Mac's LAN IP, e.g. "http://192.168.1.20:8080", and make sure the
    /// dev server listens on 0.0.0.0.
    static var baseURL: String { SwarmConfig.apiBase }

    /// Canonical mission intents sent by the DEBUG scenario buttons. The
    /// server's deterministic intent parser keyword-matches these EXACT
    /// strings (SPEC §4.2) — do not reword them without updating the backend.
    enum MissionIntent {
        static let missedFlight = "I missed my flight, reroute me"
        static let weather = "Heavy rain forecast tomorrow, adapt my outdoor plans"
        static let hotelOverbooked = "My hotel is overbooked"
        static let activityCancelled = "My activity got cancelled"
        static let transitStrike = "Transit strike tomorrow"
        static let feelingUnwell = "I'm feeling unwell, lighten my day"

        /// Keyword families the backend's deterministic intent parser accepts
        /// (mirrors swarmIntent.ts) — used to decide whether free-form alert
        /// text can become a mission at all.
        private static let parsableKeywords: [[String]] = [
            ["rain", "rainy", "storm", "thunder", "weather", "forecast", "snow", "wind", "heat", "hurricane", "typhoon"],
            ["flight", "missed", "reroute", "rebook", "delay"],
            ["overbook", "no-show", "hotel", "room", "reservation", "check-in"],
            ["cancel", "activity", "tour", "lesson", "excursion", "class"],
            ["strike"],
            ["unwell", "lighten", "sick", "exhausted"],
        ]

        /// Maps free-form alert/incident text onto a mission the backend can
        /// parse. Text matching no known intent family falls back to the
        /// WEATHER intent so a proactive alert never dead-ends (a rejected
        /// 400 intent would just fail the adaptive mission).
        static func parseOrFallback(_ text: String) -> String {
            let lowered = text.lowercased()
            let parsable = parsableKeywords.contains { family in
                family.contains(where: { lowered.contains($0) })
            }
            return parsable && !text.trimmingCharacters(in: .whitespaces).isEmpty
                ? "\(text) — adapt my plans"
                : MissionIntent.weather
        }
    }

    enum ServiceError: LocalizedError {
        case badURL
        case noData
        case http(Int, detail: String?)
        case decoding
        /// Server-side TTL rejection from the approve endpoint (HTTP 410,
        /// error code `quotes_expired`) — the plan's quotes expired after
        /// the client-side countdown, so settlement must not proceed.
        case quotesExpired

        var errorDescription: String? {
            switch self {
            case .badURL: return "Invalid swarm service URL"
            case .noData: return "The swarm service returned no data"
            case let .http(code, detail):
                if let detail, !detail.isEmpty {
                    return "Swarm service error (\(code)): \(detail)"
                }
                return "Swarm service request failed (\(code))"
            case .decoding: return "The swarm service sent an unexpected payload"
            case .quotesExpired: return "The price quotes for this plan have expired. Re-run the mission to get fresh prices."
            }
        }
    }

    // MARK: Wire models (extended Trust Layer `ResolutionPlan`, SPEC §3.4)

    /// One agent step in the swarm trace — rendered as an Activity Stream row.
    /// `{ agent, step, detail, at }` (SPEC §4.2 `swarm_trace`).
    struct TraceEntry: Decodable, Identifiable, Equatable {
        let agent: String
        let step: String
        let detail: String
        let at: String?

        var id: String { "\(agent)|\(step)|\(at ?? "")" }

        enum CodingKeys: String, CodingKey {
            case agent, step, detail, at
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            agent = (try? c.decode(String.self, forKey: .agent)) ?? "swarm"
            step = (try? c.decode(String.self, forKey: .step)) ?? ""
            detail = (try? c.decode(String.self, forKey: .detail)) ?? ""
            at = try? c.decode(String.self, forKey: .at)
        }
    }

    /// The extended Trust Layer plan (hotel_adjustments / policy_verdict are
    /// the new optional fields; absent ⇒ classic plan, still valid).
    struct Plan: Decodable {
        let incident: String
        let impactedNodes: [String]
        let proposedResolution: ProposedResolution
        let financialDelta: FinancialDelta
        let requiresHumanApproval: Bool
        let expiresAt: Date?
        /// NEW (Phase C) — ISO code (e.g. "EUR") all plan amounts are already
        /// expressed in. Optional: absent ⇒ legacy bare-number rendering.
        let currency: String?
        /// NEW (Phase C) — optional rich presentation block (hotel images,
        /// activity swap, map points, human ledger lines). Absent ⇒ the
        /// classic dossier renders unchanged.
        let presentation: Presentation?
        /// NEW (2-phase flow) — carousel badge for multi-plan proposals:
        /// "cheapest" | "fastest" | "balanced". Absent ⇒ no badge capsule.
        let badge: String?
        /// NEW (clarity pass) — additive multi-badge set (subset of
        /// "cheapest"/"fastest"/"balanced"); a plan that is both the
        /// cheapest AND the fastest carries both. Absent on old payloads ⇒
        /// the UI falls back to `[badge]`.
        let badges: [String]?

        enum CodingKeys: String, CodingKey {
            case incident
            case impactedNodes = "impacted_nodes"
            case proposedResolution = "proposed_resolution"
            case financialDelta = "financial_delta"
            case requiresHumanApproval = "requires_human_approval"
            case expiresAt = "expires_at"
            case currency
            case presentation
            case badge
            case badges
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            incident = (try? c.decode(String.self, forKey: .incident)) ?? "Disruption detected"
            impactedNodes = (try? c.decode([String].self, forKey: .impactedNodes)) ?? []
            proposedResolution = (try? c.decode(ProposedResolution.self, forKey: .proposedResolution))
                ?? ProposedResolution(newFlight: nil, rescheduledActivities: [], hotelAdjustments: nil, policyVerdict: nil)
            financialDelta = (try? c.decode(FinancialDelta.self, forKey: .financialDelta))
                ?? FinancialDelta(totalRefund: 0, totalNewCharges: 0, netPayable: 0)
            requiresHumanApproval = (try? c.decode(Bool.self, forKey: .requiresHumanApproval)) ?? true
            if let ms = try? c.decode(Double.self, forKey: .expiresAt) {
                expiresAt = Date(timeIntervalSince1970: ms / 1000.0)
            } else {
                expiresAt = nil
            }
            if let raw = try? c.decode(String.self, forKey: .currency),
               !raw.trimmingCharacters(in: .whitespaces).isEmpty {
                currency = raw.trimmingCharacters(in: .whitespaces)
            } else {
                currency = nil
            }
            presentation = try? c.decode(Presentation.self, forKey: .presentation)
            badge = try? c.decode(String.self, forKey: .badge)
            // Tolerant: an empty/blank entry set decodes to nil so the
            // render path's `[badge]` fallback stays the single source of truth.
            let rawBadges = (try? c.decode([String].self, forKey: .badges)) ?? []
            let cleanBadges = rawBadges.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            badges = cleanBadges.isEmpty ? nil : cleanBadges
        }
    }

    // MARK: Trade-off quiz wire models (2-phase flow: assess → resolve)

    /// One selectable side of a trade-off question — `{ id, label, detail? }`.
    /// Decoded tolerantly: a malformed option never fails the whole quiz.
    struct TradeoffOption: Decodable, Equatable, Identifiable {
        let id: String
        let label: String
        let detail: String?

        enum CodingKeys: String, CodingKey {
            case id, label, detail
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decode(String.self, forKey: .id)) ?? ""
            label = (try? c.decode(String.self, forKey: .label)) ?? ""
            detail = try? c.decode(String.self, forKey: .detail)
        }
    }

    /// One trade-off question from `POST /mission/assess` —
    /// `{ id, question, detail?, options }` (contract: exactly 2 options;
    /// decoded tolerantly). The question/option TEXT is already localized by
    /// the backend — the client renders it verbatim.
    struct TradeoffQuestion: Decodable, Equatable, Identifiable {
        let id: String
        let question: String
        let detail: String?
        let options: [TradeoffOption]

        enum CodingKeys: String, CodingKey {
            case id, question, detail, options
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decode(String.self, forKey: .id)) ?? ""
            question = (try? c.decode(String.self, forKey: .question)) ?? ""
            detail = try? c.decode(String.self, forKey: .detail)
            options = (try? c.decode([TradeoffOption].self, forKey: .options)) ?? []
        }
    }

    /// `POST /api/hackathon/mission/assess` →
    /// `{ status: "gathering_preferences", resolution_id, tradeoffs }`.
    struct AssessResponse: Decodable {
        let resolutionId: String
        let tradeoffs: [TradeoffQuestion]

        enum CodingKeys: String, CodingKey {
            case resolutionId = "resolution_id"
            case tradeoffs
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            resolutionId = (try? c.decode(String.self, forKey: .resolutionId)) ?? ""
            tradeoffs = (try? c.decode([TradeoffQuestion].self, forKey: .tradeoffs)) ?? []
        }
    }

    /// `POST /api/hackathon/mission/resolve` — two response rails:
    /// demo/sync `{ status: "proposal_ready", plans, degraded… }` or
    /// real-trip `{ status: "processing" }` (then poll `swarm-status`).
    struct ResolveResponse: Decodable {
        let resolutionId: String
        /// "proposal_ready" | "processing"
        let status: String
        let plans: [Plan]?
        let degraded: Bool
        let degradedReason: String?
        /// Demo/sync rail ships the agent trace inline (`swarm_trace`) so the
        /// Activity Stream isn't empty — the async rail delivers it via
        /// `swarm-status` polling instead.
        let swarmTrace: [TraceEntry]?

        enum CodingKeys: String, CodingKey {
            case resolutionId = "resolution_id"
            case status, plans, degraded
            case degradedReason = "degraded_reason"
            case swarmTrace = "swarm_trace"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            resolutionId = (try? c.decode(String.self, forKey: .resolutionId)) ?? ""
            status = (try? c.decode(String.self, forKey: .status)) ?? "processing"
            plans = try? c.decode([Plan].self, forKey: .plans)
            degraded = (try? c.decode(Bool.self, forKey: .degraded)) ?? false
            degradedReason = try? c.decode(String.self, forKey: .degradedReason)
            swarmTrace = try? c.decode([TraceEntry].self, forKey: .swarmTrace)
        }
    }

    // MARK: Presentation block (Phase C — all fields optional, decode tolerantly)

    /// Rich "Your new plan" surface: hotel imagery, activity swap, map points
    /// and pre-composed ledger lines. Every sub-block is optional — the UI
    /// renders identically when the server omits it.
    struct Presentation: Decodable {
        let hotel: PresentationHotel?
        let activitySwap: PresentationActivitySwap?
        let mapPoints: [MapPoint]
        let ledgerSummary: [String]
        /// What this plan costs the REST of the trip. Absent when it costs
        /// nothing — the money panel says what you pay, this says what you lose.
        let tripImpact: TripImpact?
        /// Why no replacement flight could be offered. Only `partner_coverage`
        /// names the provider, and the server proves it before saying so.
        let noFlightReason: NoFlightReason?

        struct NoFlightReason: Decodable {
            let kind: String
            let summary: String
            let route: String?

            /// The one case that means "go book it with the airline yourself"
            /// rather than "wait and retry".
            var isPartnerCoverage: Bool { kind == "partner_coverage" }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
                summary = (try? c.decode(String.self, forKey: .summary)) ?? ""
                route = try? c.decode(String.self, forKey: .route)
            }

            enum CodingKeys: String, CodingKey { case kind, summary, route }
        }

        struct TripImpact: Decodable {
            let summary: String
            let nightsLost: Int
            let activitiesLost: Int
            let daysLost: Int

            enum CodingKeys: String, CodingKey {
                case summary
                case nightsLost = "nights_lost"
                case activitiesLost = "activities_lost"
                case daysLost = "days_lost"
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                summary = (try? c.decode(String.self, forKey: .summary)) ?? ""
                nightsLost = (try? c.decode(Int.self, forKey: .nightsLost)) ?? 0
                activitiesLost = (try? c.decode(Int.self, forKey: .activitiesLost)) ?? 0
                daysLost = (try? c.decode(Int.self, forKey: .daysLost)) ?? 0
            }
        }

        enum CodingKeys: String, CodingKey {
            case hotel
            case activitySwap = "activity_swap"
            case mapPoints = "map_points"
            case ledgerSummary = "ledger_summary"
            case tripImpact = "trip_impact"
            case noFlightReason = "no_flight_reason"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            hotel = try? c.decode(PresentationHotel.self, forKey: .hotel)
            activitySwap = try? c.decode(PresentationActivitySwap.self, forKey: .activitySwap)
            mapPoints = (try? c.decode([MapPoint].self, forKey: .mapPoints)) ?? []
            ledgerSummary = (try? c.decode([String].self, forKey: .ledgerSummary)) ?? []
            tripImpact = try? c.decode(TripImpact.self, forKey: .tripImpact)
            noFlightReason = try? c.decode(NoFlightReason.self, forKey: .noFlightReason)
        }
    }

    struct PresentationHotel: Decodable {
        let name: String?
        let action: String?
        let ratePerNight: Double?
        let currency: String?
        /// ISO8601 — rendered via `SwarmFormat.isoToLocalString`.
        let freeCancellationUntil: String?
        let lat: Double?
        let lng: Double?
        let images: [String]

        enum CodingKeys: String, CodingKey {
            case name, action, currency, lat, lng, images
            case ratePerNight = "rate_per_night"
            case freeCancellationUntil = "free_cancellation_until"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try? c.decode(String.self, forKey: .name)
            action = try? c.decode(String.self, forKey: .action)
            ratePerNight = try? c.decode(Double.self, forKey: .ratePerNight)
            currency = try? c.decode(String.self, forKey: .currency)
            freeCancellationUntil = try? c.decode(String.self, forKey: .freeCancellationUntil)
            lat = try? c.decode(Double.self, forKey: .lat)
            lng = try? c.decode(Double.self, forKey: .lng)
            images = (try? c.decode([String].self, forKey: .images))?
                .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? []
        }
    }

    struct PresentationActivitySwap: Decodable {
        let name: String?
        let image: String?
        let priceFrom: Double?
        let currency: String?
        let rating: Double?

        enum CodingKeys: String, CodingKey {
            case name, image, currency, rating
            case priceFrom = "price_from"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try? c.decode(String.self, forKey: .name)
            image = try? c.decode(String.self, forKey: .image)
            priceFrom = try? c.decode(Double.self, forKey: .priceFrom)
            currency = try? c.decode(String.self, forKey: .currency)
            rating = try? c.decode(Double.self, forKey: .rating)
        }
    }

    /// One pin on the change map — `kind` is
    /// "airport_origin|airport_new|hotel|activity".
    struct MapPoint: Decodable, Identifiable {
        let label: String
        let lat: Double
        let lng: Double
        let kind: String

        var id: String { "\(kind)|\(label)|\(lat)|\(lng)" }

        enum CodingKeys: String, CodingKey {
            case label, lat, lng, kind
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = (try? c.decode(String.self, forKey: .label)) ?? ""
            lat = (try? c.decode(Double.self, forKey: .lat)) ?? 0
            lng = (try? c.decode(Double.self, forKey: .lng)) ?? 0
            kind = (try? c.decode(String.self, forKey: .kind)) ?? "activity"
        }
    }

    struct ProposedResolution: Decodable {
        let newFlight: NewFlight?
        let rescheduledActivities: [RescheduledActivity]
        /// NEW (SPEC §3.4) — omit or [] when no hotel is impacted.
        let hotelAdjustments: [HotelAdjustment]?
        /// NEW (SPEC §3.4) — PolicyAgent audit surface.
        let policyVerdict: PolicyVerdict?
        /// NEW — spatial-conflict transfer re-quote charge. Its amount is
        /// already included in `financial_delta.total_new_charges`; absent
        /// when no spatial conflict fired.
        let transferRequote: TransferRequote?

        enum CodingKeys: String, CodingKey {
            case newFlight = "new_flight"
            case rescheduledActivities = "rescheduled_activities"
            case hotelAdjustments = "hotel_adjustments"
            case policyVerdict = "policy_verdict"
            case transferRequote = "transfer_requote"
        }

        init(newFlight: NewFlight?, rescheduledActivities: [RescheduledActivity],
             hotelAdjustments: [HotelAdjustment]?, policyVerdict: PolicyVerdict?) {
            self.newFlight = newFlight
            self.rescheduledActivities = rescheduledActivities
            self.hotelAdjustments = hotelAdjustments
            self.policyVerdict = policyVerdict
            self.transferRequote = nil
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            newFlight = try? c.decode(NewFlight.self, forKey: .newFlight)
            rescheduledActivities = (try? c.decode([RescheduledActivity].self, forKey: .rescheduledActivities)) ?? []
            hotelAdjustments = try? c.decode([HotelAdjustment].self, forKey: .hotelAdjustments)
            policyVerdict = try? c.decode(PolicyVerdict.self, forKey: .policyVerdict)
            transferRequote = try? c.decode(TransferRequote.self, forKey: .transferRequote)
        }
    }

    /// NEW — one transfer re-quote charge raised when a spatial conflict
    /// fires; `{ amount, from, to, reason }` (tolerant — absent keys never
    /// fail decoding).
    struct TransferRequote: Decodable {
        let amount: Double
        let from: String
        let to: String
        let reason: String

        enum CodingKeys: String, CodingKey {
            case amount, from, to, reason
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            amount = (try? c.decode(Double.self, forKey: .amount)) ?? 0
            from = (try? c.decode(String.self, forKey: .from)) ?? ""
            to = (try? c.decode(String.self, forKey: .to)) ?? ""
            reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        }
    }

    struct NewFlight: Decodable {
        let id: String
        let cost: Double
        /// Optional route endpoints — shown instead of the raw id when the
        /// backend provides them.
        let from: String?
        let to: String?
        /// NEW (Phase C) — flight enrichment for the "Your new plan" dossier.
        /// All optional; absent ⇒ fall back to `displayLabel`.
        let airline: String?
        /// ISO8601 — rendered via `SwarmFormat.isoToLocalString`.
        let departure: String?
        /// ISO8601 — rendered via `SwarmFormat.isoToLocalString`.
        let arrival: String?
        /// ISO code the fare is already expressed in (falls back to
        /// `Plan.currency`).
        let currency: String?
        /// NEW — machine-readable flight number (e.g. "VY8462") for the
        /// settled recap line; absent ⇒ the recap omits it.
        let flightNumber: String?
        /// NEW — routing shape, so the card can distinguish a 2h non-stop
        /// from a 6h one-stop at a similar fare. All optional: absent means
        /// the provider did not describe the segments, and the UI then says
        /// nothing rather than claiming "Non-stop".
        let stops: Int?
        /// NEW — total travel time in minutes, departure to arrival.
        let durationMinutes: Int?
        /// NEW — IATA layover airports, in order ("via MAD").
        let stopAirports: [String]?
        /// NEW — the replacement journey hop by hop, when the provider
        /// described it. The AUTHORITY on the routing, exactly as on a stored
        /// leg: the settlement derives `stops` / `stop_airports` from these,
        /// so the proposal card must derive from them too or it would promise
        /// "Non-stop" for a journey the timeline then shows with a connection.
        let segments: [NewFlightSegment]?

        /// One hop of the replacement, mirroring `TransitSegment` on the leg.
        struct NewFlightSegment: Decodable {
            let carrier: String?
            let reference: String?
            let from: String?
            let to: String?
            let depart: String?
            let arrive: String?
        }

        /// Human label for the Trust Layer: "New flight" + route when
        /// available, falling back to the raw flight id.
        var displayLabel: String {
            if let from, let to, !from.isEmpty, !to.isEmpty {
                return "New flight · \(from) → \(to)"
            }
            return "New flight \(id)"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeyBox.self)
            id = (try? c.decode(String.self, forKey: CodingKeyBox("id"))) ?? "unknown"
            cost = (try? c.decode(Double.self, forKey: CodingKeyBox("cost"))) ?? 0
            self.from = (try? c.decode(String.self, forKey: CodingKeyBox("from")))
                ?? (try? c.decode(String.self, forKey: CodingKeyBox("origin")))
            self.to = (try? c.decode(String.self, forKey: CodingKeyBox("to")))
                ?? (try? c.decode(String.self, forKey: CodingKeyBox("destination")))
            airline = try? c.decode(String.self, forKey: CodingKeyBox("airline"))
            departure = try? c.decode(String.self, forKey: CodingKeyBox("departure"))
            arrival = try? c.decode(String.self, forKey: CodingKeyBox("arrival"))
            currency = try? c.decode(String.self, forKey: CodingKeyBox("currency"))
            flightNumber = try? c.decode(String.self, forKey: CodingKeyBox("flight_number"))
            // Tolerant camel/snake decoding, matching the rest of this wire
            // model: every field is optional, so an older worker payload (or
            // an older client against a newer worker) still decodes.
            stops = (try? c.decode(Int.self, forKey: CodingKeyBox("stops")))
            durationMinutes = (try? c.decode(Int.self, forKey: CodingKeyBox("durationMinutes")))
                ?? (try? c.decode(Int.self, forKey: CodingKeyBox("duration_minutes")))
            stopAirports = (try? c.decode([String].self, forKey: CodingKeyBox("stopAirports")))
                ?? (try? c.decode([String].self, forKey: CodingKeyBox("stop_airports")))
            segments = try? c.decode([NewFlightSegment].self, forKey: CodingKeyBox("segments"))
        }

        /// Layover points, derived from the hops when we have them.
        ///
        /// Segments outrank the flat `stops` / `stopAirports` fields for the
        /// same reason they do on a stored leg: they are the only description
        /// that can be shown hop by hop, and the settlement derives the flat
        /// fields FROM them — so preferring them here is what keeps the
        /// proposal card and the settled timeline telling one story.
        var viaCodes: [String] {
            if let segments, segments.count > 1 {
                return segments.dropLast().compactMap {
                    let code = $0.to?.trimmingCharacters(in: .whitespaces)
                    return (code?.isEmpty == false) ? code : nil
                }
            }
            return (stopAirports ?? []).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        }

        /// Connection count — from the hops when present, else the flat field.
        var effectiveStops: Int? {
            if let segments, !segments.isEmpty { return max(0, segments.count - 1) }
            return stops
        }

        /// "Non-stop" / "1 stop via MAD" — nil when the routing is unknown.
        var stopsLabel: String? {
            SwarmFormat.stopsLabel(stops: effectiveStops, via: viaCodes)
        }

        /// Wall-clock "14:00 – 20:00 +1" for this leg, read the same way the
        /// timeline reads it. Empty when neither endpoint carries a time.
        var wallClockRange: String {
            SwarmFormat.transitRangeLabel(depart: departure, arrive: arrival)
        }

        /// Travel time: the server's figure when present, else derived from
        /// the leg's own wall-clock stamps.
        var effectiveDurationMinutes: Int? {
            if let durationMinutes, durationMinutes > 0 { return durationMinutes }
            return SwarmFormat.minutesBetween(departure, arrival)
        }
    }

    struct RescheduledActivity: Decodable {
        let name: String
        let newTime: String
        let penalty: Double
        /// NEW (Phase C) — preferred machine-readable reschedule time
        /// (ISO8601); shown via `SwarmFormat.isoToLocalString` when present.
        let newTimeIso: String?
        /// NEW (Phase C) — why the penalty was charged; absent ⇒ the UI uses
        /// a generic explanation.
        let reason: String?
        /// NEW (W2, additive) — "reschedule" | "swap" | "drop". Absent = legacy
        /// move (renders exactly as before). "drop" = cancelled out of the day
        /// by smart day reorganization — rendered as a cancelled row (no slot,
        /// no move arrow).
        let action: String?

        enum CodingKeys: String, CodingKey {
            case name
            case newTime = "new_time"
            case penalty
            case newTimeIso = "new_time_iso"
            case reason
            case action
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = (try? c.decode(String.self, forKey: .name)) ?? "Activity"
            newTime = (try? c.decode(String.self, forKey: .newTime)) ?? ""
            penalty = (try? c.decode(Double.self, forKey: .penalty)) ?? 0
            newTimeIso = try? c.decode(String.self, forKey: .newTimeIso)
            reason = try? c.decode(String.self, forKey: .reason)
            action = try? c.decode(String.self, forKey: .action)
        }
    }

    /// NEW (SPEC §3.4) — one hotel-side adjustment in the impact window.
    struct HotelAdjustment: Decodable {
        let hotelName: String
        /// "late_check_in" | "rebook" | "none"
        let action: String
        let fee: Double

        enum CodingKeys: String, CodingKey {
            case hotelName = "hotel_name"
            case action
            case fee
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            hotelName = (try? c.decode(String.self, forKey: .hotelName)) ?? "Hotel"
            action = (try? c.decode(String.self, forKey: .action)) ?? "none"
            fee = (try? c.decode(Double.self, forKey: .fee)) ?? 0
        }
    }

    /// NEW (SPEC §3.4) — PolicyAgent verdict (audit surface; money math only
    /// ever reads the typed numeric/boolean fields).
    struct PolicyVerdict: Decodable {
        let rebookPermitted: Bool
        let changeFee: Double
        /// "rebook" | "keep_and_wait" | "refund_and_rebook"
        let recommendedAction: String
        let noShowApplied: Bool
        /// ISO code `changeFee` is quoted in. The fare rule has its OWN
        /// currency — a 25 EUR change fee on a JPY trip is 25 EUR — so
        /// rendering the fee in the trip currency turned €25 into ¥25.
        /// Absent ⇒ the caller falls back to the plan currency as before.
        let currency: String?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeyBox.self)
            rebookPermitted = (try? c.decode(Bool.self, forKey: CodingKeyBox("rebookPermitted"))) ?? false
            changeFee = (try? c.decode(Double.self, forKey: CodingKeyBox("changeFee"))) ?? 0
            recommendedAction = (try? c.decode(String.self, forKey: CodingKeyBox("recommendedAction"))) ?? "keep_and_wait"
            noShowApplied = (try? c.decode(Bool.self, forKey: CodingKeyBox("noShowApplied"))) ?? false
            currency = try? c.decode(String.self, forKey: CodingKeyBox("currency"))
        }
    }

    struct FinancialDelta: Decodable {
        let totalRefund: Double
        let totalNewCharges: Double
        let netPayable: Double
        /// NEW — per-currency split of the settlement (`by_currency`); empty
        /// for legacy single-currency payloads, in decoded order (ledger
        /// bucket first) when the server emits several.
        let byCurrency: [CurrencyBucket]

        /// The WHOLE ledger in ONE currency — the traveller's own. This is what
        /// the confirm screen shows; `byCurrency` remains the truthful record
        /// of what each provider actually quoted. Absent on older payloads.
        let display: DisplayTotal?

        /// `financial_delta.display`. `converted` is not decoration: a figure
        /// reached through an FX rate must never be presented as the number a
        /// provider quoted.
        struct DisplayTotal: Decodable {
            let currency: String
            let totalRefund: Double
            let totalNewCharges: Double
            let netPayable: Double
            let converted: Bool

            enum CodingKeys: String, CodingKey {
                case currency
                case totalRefund = "total_refund"
                case totalNewCharges = "total_new_charges"
                case netPayable = "net_payable"
                case converted
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                currency = (try? c.decode(String.self, forKey: .currency)) ?? ""
                totalRefund = (try? c.decode(Double.self, forKey: .totalRefund)) ?? 0
                totalNewCharges = (try? c.decode(Double.self, forKey: .totalNewCharges)) ?? 0
                netPayable = (try? c.decode(Double.self, forKey: .netPayable)) ?? 0
                converted = (try? c.decode(Bool.self, forKey: .converted)) ?? false
            }
        }

        /// One bucket of `by_currency` — tolerant: absent keys default to
        /// zero. Any malformed entry drops the WHOLE `by_currency` array via
        /// the outer `try?` (the settle title falls back to the legacy
        /// single-number wording).
        struct CurrencyBucket: Decodable {
            let currency: String
            let totalRefund: Double
            let totalNewCharges: Double
            let netPayable: Double

            enum CodingKeys: String, CodingKey {
                case currency
                case totalRefund = "total_refund"
                case totalNewCharges = "total_new_charges"
                case netPayable = "net_payable"
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                currency = (try? c.decode(String.self, forKey: .currency)) ?? ""
                totalRefund = (try? c.decode(Double.self, forKey: .totalRefund)) ?? 0
                totalNewCharges = (try? c.decode(Double.self, forKey: .totalNewCharges)) ?? 0
                netPayable = (try? c.decode(Double.self, forKey: .netPayable)) ?? 0
            }
        }

        enum CodingKeys: String, CodingKey {
            case totalRefund = "total_refund"
            case totalNewCharges = "total_new_charges"
            case netPayable = "net_payable"
            case byCurrency = "by_currency"
            case display
        }

        init(totalRefund: Double, totalNewCharges: Double, netPayable: Double,
             byCurrency: [CurrencyBucket] = [], display: DisplayTotal? = nil) {
            self.totalRefund = totalRefund
            self.totalNewCharges = totalNewCharges
            self.netPayable = netPayable
            self.byCurrency = byCurrency
            self.display = display
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            totalRefund = (try? c.decode(Double.self, forKey: .totalRefund)) ?? 0
            totalNewCharges = (try? c.decode(Double.self, forKey: .totalNewCharges)) ?? 0
            netPayable = (try? c.decode(Double.self, forKey: .netPayable)) ?? 0
            byCurrency = (try? c.decode([CurrencyBucket].self, forKey: .byCurrency)) ?? []
            display = try? c.decode(DisplayTotal.self, forKey: .display)
        }
    }

    /// `POST /api/hackathon/mission` → `{ resolution_id, plan?, swarm_trace }`
    struct MissionResponse: Decodable {
        let resolutionId: String
        let plan: Plan?
        let swarmTrace: [TraceEntry]
        /// NEW (Phase C) — true when the plan was assembled from simulated
        /// data (e.g. flight provider offline); approve would 409.
        let degraded: Bool
        /// "provider_offline" | "session_store_memory" (optional).
        let degradedReason: String?

        enum CodingKeys: String, CodingKey {
            case resolutionId = "resolution_id"
            case plan
            case swarmTrace = "swarm_trace"
            case degraded
            case degradedReason = "degraded_reason"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            resolutionId = try c.decode(String.self, forKey: .resolutionId)
            plan = try? c.decode(Plan.self, forKey: .plan)
            swarmTrace = (try? c.decode([TraceEntry].self, forKey: .swarmTrace)) ?? []
            degraded = (try? c.decode(Bool.self, forKey: .degraded)) ?? false
            degradedReason = try? c.decode(String.self, forKey: .degradedReason)
        }
    }

    /// `GET /api/hackathon/swarm-status/{resolution_id}` →
    /// `{ resolution_id, state, trace?, plan?, plans? }`
    struct StatusResponse: Decodable {
        let resolutionId: String
        /// processing | proposal_ready | awaiting_approval | approved | settled | expired
        let state: String
        let trace: [TraceEntry]?
        let plan: Plan?
        /// NEW (2-phase flow) — full multi-plan set in plan-visible states
        /// (contract: `plan === plans[0]`). Absent ⇒ single-plan legacy rail.
        let plans: [Plan]?
        /// NEW (Phase C) — see `MissionResponse.degraded`.
        let degraded: Bool
        let degradedReason: String?

        enum CodingKeys: String, CodingKey {
            case resolutionId = "resolution_id"
            case state
            case trace
            case plan
            case plans
            case degraded
            case degradedReason = "degraded_reason"
        }

        init(resolutionId: String, state: String, trace: [TraceEntry]?, plan: Plan?,
             plans: [Plan]? = nil, degraded: Bool = false, degradedReason: String? = nil) {
            self.resolutionId = resolutionId
            self.state = state
            self.trace = trace
            self.plan = plan
            self.plans = plans
            self.degraded = degraded
            self.degradedReason = degradedReason
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            resolutionId = (try? c.decode(String.self, forKey: .resolutionId)) ?? ""
            state = (try? c.decode(String.self, forKey: .state)) ?? "processing"
            trace = try? c.decode([TraceEntry].self, forKey: .trace)
            plan = try? c.decode(Plan.self, forKey: .plan)
            plans = try? c.decode([Plan].self, forKey: .plans)
            degraded = (try? c.decode(Bool.self, forKey: .degraded)) ?? false
            degradedReason = try? c.decode(String.self, forKey: .degradedReason)
        }
    }

    /// `GET /api/hackathon/alerts?since={epoch_ms}` → `{ alerts, server_time }`
    struct AlertsResponse: Decodable {
        let alerts: [Alert]
        let serverTime: Int64

        enum CodingKeys: String, CodingKey {
            case alerts
            case serverTime = "server_time"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            alerts = (try? c.decode([Alert].self, forKey: .alerts)) ?? []
            // epoch ms may arrive as int or double — tolerate both.
            if let ms = try? c.decode(Int64.self, forKey: .serverTime) {
                serverTime = ms
            } else if let ms = try? c.decode(Double.self, forKey: .serverTime) {
                serverTime = Int64(ms)
            } else {
                serverTime = Int64(Date().timeIntervalSince1970 * 1000)
            }
        }
    }

    /// One background monitor alert (backed by `swarm_sessions` rows in
    /// `awaiting_approval`, SPEC §4.5). `degraded` marks proactive monitor
    /// sessions — placeholder plans that are NOT bookable (approve 409s).
    struct Alert: Decodable, Identifiable {
        let notificationId: String?
        let resolutionId: String
        let createdAt: Int64?
        let incident: String
        let degraded: Bool
        /// Which rail produced the alert ("proactive_monitor", "reactive"…).
        let origin: String?
        let plan: Plan?

        var id: String { notificationId ?? resolutionId }

        enum CodingKeys: String, CodingKey {
            case notificationId = "notification_id"
            case resolutionId = "resolution_id"
            case createdAt = "created_at"
            case incident
            case degraded
            case origin
            case plan
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            notificationId = try? c.decode(String.self, forKey: .notificationId)
            resolutionId = (try? c.decode(String.self, forKey: .resolutionId)) ?? ""
            createdAt = (try? c.decode(Int64.self, forKey: .createdAt))
                ?? (try? c.decode(Double.self, forKey: .createdAt)).map(Int64.init)
            incident = (try? c.decode(String.self, forKey: .incident)) ?? "Swarm alert"
            degraded = (try? c.decode(Bool.self, forKey: .degraded)) ?? false
            origin = try? c.decode(String.self, forKey: .origin)
            plan = try? c.decode(Plan.self, forKey: .plan)
        }
    }

    /// `POST /api/hackathon/approve-resolution` → `{ approved, booking, plan? }`.
    /// `booking` is decoded LOOSELY — whatever the provider returned,
    /// surfaced best-effort (HackathonDisruptionService precedent).
    struct ApproveResponse: Decodable {
        let approved: Bool
        let booking: Booking
        let plan: Plan?
        /// Full updated trip content_json when settlement rewrote the
        /// itinerary — applied to the open trip via `onTripUpdated`.
        let updatedContent: [String: Any]?
        /// Settlement receipt: which trip fields changed + whether a booking
        /// was recorded on the server.
        let settlement: Settlement?

        enum CodingKeys: String, CodingKey {
            case approved, booking, plan
            case updatedContent = "updated_content"
            case settlement
        }

        init(approved: Bool, booking: Booking, plan: Plan?,
             updatedContent: [String: Any]?, settlement: Settlement?) {
            self.approved = approved
            self.booking = booking
            self.plan = plan
            self.updatedContent = updatedContent
            self.settlement = settlement
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            approved = (try? c.decode(Bool.self, forKey: .approved)) ?? false
            booking = (try? c.decode(Booking.self, forKey: .booking))
                ?? Booking(confirmationCode: nil, flightId: nil, status: nil)
            plan = try? c.decode(Plan.self, forKey: .plan)
            settlement = try? c.decode(Settlement.self, forKey: .settlement)
            // `updated_content` is an arbitrary trip content_json — decode it
            // as raw JSON rather than fighting a typed schema.
            if let nested = try? c.nestedContainer(keyedBy: Booking.DynamicKey.self, forKey: .updatedContent) {
                updatedContent = ApproveResponse.rawDictionary(from: nested)
            } else {
                updatedContent = nil
            }
        }

        /// Best-effort flattening of a keyed JSON container into a
        /// `[String: Any]` dictionary (tolerant — unknown shapes are dropped,
        /// never fatal).
        private static func rawDictionary(from container: KeyedDecodingContainer<Booking.DynamicKey>) -> [String: Any]? {
            var result: [String: Any] = [:]
            for key in container.allKeys {
                if let value = try? container.decode(String.self, forKey: key) {
                    result[key.stringValue] = value
                } else if let value = try? container.decode(Bool.self, forKey: key) {
                    result[key.stringValue] = value
                } else if let value = try? container.decode(Double.self, forKey: key) {
                    result[key.stringValue] = value
                } else if let value = try? container.decode(Int.self, forKey: key) {
                    result[key.stringValue] = value
                } else if let nested = try? container.nestedContainer(keyedBy: Booking.DynamicKey.self, forKey: key) {
                    if let dict = rawDictionary(from: nested) { result[key.stringValue] = dict }
                } else if var nested = try? container.nestedUnkeyedContainer(forKey: key) {
                    result[key.stringValue] = rawArray(from: &nested)
                } else if (try? container.decodeNil(forKey: key)) == true {
                    // Preserve an explicit null: re-encoding this dictionary
                    // must not silently drop a key the server sent.
                    result[key.stringValue] = NSNull()
                }
            }
            return result.isEmpty ? nil : result
        }

        private static func rawArray(from container: inout UnkeyedDecodingContainer) -> [Any] {
            var result: [Any] = []
            while !container.isAtEnd {
                if let value = try? container.decode(String.self) {
                    result.append(value)
                } else if let value = try? container.decode(Bool.self) {
                    result.append(value)
                } else if let value = try? container.decode(Double.self) {
                    result.append(value)
                } else if let value = try? container.decode(Int.self) {
                    result.append(value)
                } else if let nested = try? container.nestedContainer(keyedBy: Booking.DynamicKey.self) {
                    if let dict = rawDictionary(from: nested) { result.append(dict) }
                } else if var nested = try? container.nestedUnkeyedContainer() {
                    result.append(rawArray(from: &nested))
                } else if (try? container.decodeNil()) == true {
                    // A null element must keep its SLOT. Dropping it shrinks
                    // the array and shifts every later index down one — and
                    // real trips carry nulls (an unfilled traveler slot is
                    // `travelers: [{…}, null]`), so settling a plan used to
                    // silently delete those slots and renumber the rest.
                    result.append(NSNull())
                } else {
                    // Neither a value nor null: nothing can consume it, so
                    // stop rather than spin forever on the same element.
                    break
                }
            }
            return result
        }
    }

    /// Settlement receipt inside the approve response — snake_case keys
    /// `trip_updated` / `conflict_skipped` / `note` / `changes` /
    /// `booking_recorded` / `content_rev` (the last is additive — the
    /// post-write `trips.content_rev` so the client can seed its optimistic
    /// concurrency registry without a refetch; absent on old payloads).
    struct Settlement: Decodable {
        let tripUpdated: Bool
        /// True when the server skipped the itinerary rewrite (rev conflict)
        /// — the settlement must then NOT read as a full timeline update.
        let conflictSkipped: Bool
        /// Human note from the server when the rewrite was skipped/partial.
        let note: String?
        let changes: [String]
        let bookingRecorded: Bool
        /// Additive — post-write `trips.content_rev` (absent ⇒ nil).
        let contentRev: Int?

        enum CodingKeys: String, CodingKey {
            case tripUpdated = "trip_updated"
            case conflictSkipped = "conflict_skipped"
            case note
            case changes
            case bookingRecorded = "booking_recorded"
            case contentRev = "content_rev"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            tripUpdated = (try? c.decode(Bool.self, forKey: .tripUpdated)) ?? false
            conflictSkipped = (try? c.decode(Bool.self, forKey: .conflictSkipped)) ?? false
            note = try? c.decode(String.self, forKey: .note)
            changes = (try? c.decode([String].self, forKey: .changes)) ?? []
            bookingRecorded = (try? c.decode(Bool.self, forKey: .bookingRecorded)) ?? false
            contentRev = try? c.decode(Int.self, forKey: .contentRev)
        }
    }

    struct Booking: Decodable {
        let confirmationCode: String?
        let flightId: String?
        let status: String?

        init(confirmationCode: String?, flightId: String?, status: String?) {
            self.confirmationCode = confirmationCode
            self.flightId = flightId
            self.status = status
        }

        struct DynamicKey: CodingKey {
            var stringValue: String
            var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { nil }
        }

        init(from decoder: Decoder) throws {
            // Tolerant decode: unknown/missing keys never fail the approval.
            let container = try? decoder.container(keyedBy: DynamicKey.self)
            func string(_ keys: String...) -> String? {
                for key in keys {
                    if let value = try? container?.decode(String.self, forKey: DynamicKey(stringValue: key)!) {
                        return value
                    }
                }
                return nil
            }
            confirmationCode = string("confirmation_code", "confirmationCode", "code")
            flightId = string("flight_id", "flightId")
            status = string("status")
        }
    }

    /// Generic dynamic coding-key box for tolerant flat-object decoding.
    private struct CodingKeyBox: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ key: String) { self.stringValue = key }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    // MARK: Transport (same shape as HackathonDisruptionService)

    private static func request(_ method: String, _ path: String,
                                body: [String: Any]? = nil) async throws -> Data {
        guard let url = URL(string: baseURL + path) else { throw ServiceError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("Bearer " + SwarmConfig.demoToken, forHTTPHeaderField: "Authorization")
        // The bearer above identifies the APP — it is the same literal in every
        // install. WHO is calling comes from the traveler's own Supabase token,
        // which the Worker verifies before letting the mission touch a trip.
        // Without it the server refuses (401 user_token_required), which is the
        // correct outcome for a guest: guests have no real trips to work on.
        if let session = try? await SupabaseManager.shared.auth.session {
            req.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "X-Swarm-User-Token")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            // Surface the backend's structured error body ({ error, message })
            // instead of a bare status code — demo-day troubleshooting.
            throw ServiceError.http(code, detail: errorDetail(from: data))
        }
        return data
    }

    /// Best-effort extraction of the backend's
    /// `{ "error"/"code": ..., "message": ... }` payload from a non-2xx
    /// response body; nil when the body isn't that JSON.
    private static func errorDetail(from data: Data) -> String? {
        guard !data.isEmpty,
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        // The backend has used both `error` and `code` for the error code.
        let errorCode = (json["error"] as? String) ?? (json["code"] as? String)
        let message = json["message"] as? String
        switch (errorCode, message) {
        case let (code?, message?): return "\(code) — \(message)"
        case let (code?, nil): return code
        case let (nil, message?): return message
        case (nil, nil): return nil
        }
    }

    static let decoder = JSONDecoder()

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try decoder.decode(type, from: data) }
        catch { throw ServiceError.decoding }
    }

    // MARK: Endpoints

    /// In-app selected language's two-letter code, sent as `language` on
    /// assess/resolve so the backend localizes trade-off questions and plans.
    /// Derived from the app's language setting (`LangPref.current`) — NOT the
    /// device locale — matching how TripDetailView's booking links derive the
    /// wire language. Whitelisted to the five supported codes; unknown → "en".
    static var appLanguage: String {
        switch LangPref.current {
        case "en", "de", "es", "fr", "zh": return LangPref.current
        default: return "en"
        }
    }

    /// User-initiated reroute (SPEC §4.2). Request body is camelCase per the
    /// backend contract; the response stays snake_case.
    static func mission(intent: String, tripId: String? = nil,
                        nodeId: String? = nil) async throws -> MissionResponse {
        // The currency the traveller reads in. Without it the server
        // denominates the confirm screen in the TRIP's currency, and a JPY
        // trip rebooked on a USD fare showed a yen refund with no price at all
        // for the replacement — the charge was in a bucket nothing rendered.
        var body: [String: Any] = ["intent": intent, "displayCurrency": FX.displayCurrency.uppercased()]
        if let tripId { body["tripId"] = tripId }
        if let nodeId { body["nodeId"] = nodeId }
        let data = try await request("POST", "/mission", body: body)
        return try decode(MissionResponse.self, from: data)
    }

    /// Phase 1 of the 2-phase flow — `POST /mission/assess`. Body keys per the
    /// frozen contract: `intent`, `tripId`, `nodeId`, `language`. Response:
    /// `{ status: "gathering_preferences", resolution_id, tradeoffs }`.
    static func assess(intent: String, tripId: String? = nil, nodeId: String? = nil,
                       language: String = appLanguage) async throws -> AssessResponse {
        var body: [String: Any] = [
            "intent": intent,
            "language": language,
            // See `mission(intent:)` — one purchase must read as one number.
            "displayCurrency": FX.displayCurrency.uppercased(),
        ]
        if let tripId { body["tripId"] = tripId }
        if let nodeId { body["nodeId"] = nodeId }
        let data = try await request("POST", "/mission/assess", body: body)
        return try decode(AssessResponse.self, from: data)
    }

    /// Phase 2 of the 2-phase flow — `POST /mission/resolve`. Body keys per
    /// the frozen contract: `resolution_id`, `answers` (array of
    /// `{ question_id, option_id }`), `language`. The response is either the
    /// sync `{ status: "proposal_ready", plans, … }` rail or the async
    /// `{ status: "processing" }` rail (poll `swarm-status` afterwards).
    /// `answers` is keyed questionId → optionId.
    static func resolve(resolutionId: String, answers: [String: String],
                        language: String = appLanguage) async throws -> ResolveResponse {
        let answersPayload: [[String: Any]] = answers.map {
            ["question_id": $0.key, "option_id": $0.value]
        }
        let body: [String: Any] = [
            "resolution_id": resolutionId,
            "answers": answersPayload,
            "language": language,
            "displayCurrency": FX.displayCurrency.uppercased(),
        ]
        let data = try await request("POST", "/mission/resolve", body: body)
        return try decode(ResolveResponse.self, from: data)
    }

    /// Live swarm-status poll (SPEC §4.3) — iOS polls every ~1.5 s while
    /// `processing`.
    static func status(resolutionId: String) async throws -> StatusResponse {
        let data = try await request("GET", "/swarm-status/\(resolutionId)")
        return try decode(StatusResponse.self, from: data)
    }

    /// Background-alert polling fallback (SPEC §4.5) — primary rail is push +
    /// the NotificationsViewModel realtime channel. Both `since` and `tripId`
    /// are required by the endpoint.
    // MARK: Booking preview (real provider prices for the trust layer)

    /// What one checklist row costs according to the provider that actually
    /// sells it. `priceSource` is the load-bearing field: the sheet must never
    /// show the planner's estimate as though Booking.com or Viator had quoted
    /// it.
    struct PreviewLine: Decodable {
        let id: String
        let priceSource: String
        let price: Double?
        let currency: String?
        let provider: String?
        let matchedName: String?
        let freeCancellationUntil: String?
        let unavailableReason: String?

        var isLive: Bool { priceSource == "live_provider" }
    }

    struct BookingPreview: Decodable {
        let lines: [PreviewLine]
        let providersUsed: [String]
        let providersDegraded: [String]
    }

    /// Ask the swarm what these rows really cost. NEVER throws for a single bad
    /// row — the server answers per line, so a dead provider degrades that row
    /// to its estimate instead of blanking the sheet.
    /// `quoteCurrency` is the currency the confirm screen totals in. Every
    /// provider is asked to quote in it, so one purchase reads as one total
    /// instead of a JPY stay beside a USD tour beside a EUR estimate.
    static func bookingPreview(tripId: String, lines: [[String: Any]],
                               quoteCurrency: String) async throws -> BookingPreview {
        let data = try await request("POST", "/booking-preview",
                                     body: ["tripId": tripId, "lines": lines,
                                            "quoteCurrency": quoteCurrency])
        return try JSONDecoder().decode(BookingPreview.self, from: data)
    }

    static func alerts(since epochMs: Int64, tripId: String) async throws -> AlertsResponse {
        let data = try await request("GET", "/alerts?since=\(epochMs)&tripId=\(tripId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? tripId)")
        return try decode(AlertsResponse.self, from: data)
    }

    /// Human approved the plan → the server executes booking/refund/charge.
    /// `approved: true` is mandatory — the backend 400s (invalid_approval)
    /// without it. `planIndex` selects which carousel plan to settle
    /// (2-phase flow; default 0 = legacy single-plan behavior, the response
    /// echoes `plan_index`). A 410 from the approve endpoint carries one of
    /// two codes: `quotes_expired` (prices outlived their TTL — mapped onto
    /// the dedicated `.quotesExpired` error) or `session_expired` (the
    /// session itself is gone — rethrown as the raw http error so
    /// `SwarmViewModel.friendlyError` shows the session-expiry copy).
    static func approve(resolutionId: String, planIndex: Int = 0) async throws -> ApproveResponse {
        do {
            let data = try await request("POST", "/approve-resolution",
                                         body: ["resolutionId": resolutionId,
                                                "approved": true,
                                                "planIndex": planIndex])
            return try decode(ApproveResponse.self, from: data)
        } catch let ServiceError.http(status, detail) where status == 410 {
            // Only the quotes-expiry flavor maps onto the clean, actionable
            // `.quotesExpired`; a session-expiry 410 must keep its detail so
            // friendlyError's `session_expired` branch fires.
            if detail?.contains("quotes_expired") == true {
                throw ServiceError.quotesExpired
            }
            throw ServiceError.http(status, detail: detail)
        }
    }

    /// `POST /api/hackathon/mission/cancel` → `{ cancelled: true }` OR
    /// `{ cancelled: false, noop: true, state? }` when the session was
    /// already terminal (approved/settled/expired) or unknown. camelCase
    /// body, like approve. Decoded tolerantly — cancel is best-effort.
    struct CancelResponse: Decodable {
        let cancelled: Bool
        let noop: Bool
        let state: String?

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            cancelled = (try? c.decode(Bool.self, forKey: .cancelled)) ?? false
            noop = (try? c.decode(Bool.self, forKey: .noop)) ?? false
            state = try? c.decode(String.self, forKey: .state)
        }

        enum CodingKeys: String, CodingKey {
            case cancelled, noop, state
        }
    }

    /// Abandons an in-flight mission server-side (active sessions flip to
    /// `expired`; a late async-rail completion then discards its results).
    /// BEST-EFFORT by contract: any transport/server failure is swallowed
    /// and surfaced as a nil — the UI always proceeds to `reset()`.
    static func cancelMission(resolutionId: String) async -> CancelResponse? {
        do {
            let data = try await request("POST", "/mission/cancel",
                                         body: ["resolutionId": resolutionId])
            return try decode(CancelResponse.self, from: data)
        } catch {
            return nil
        }
    }
}
