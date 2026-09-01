import Foundation
import Observation
import SwiftUI

// MARK: - Nexus Swarm state machine (DEBUG ONLY)
//
// `idle → monitoring → processing → proposal → awaiting_approval → settled`
// (+ `failed`) — SPEC §5.2. Launches swarm missions against the hackathon
// backend, polls `swarm-status` while the agents work, merges trace entries
// for the Swarm Activity Stream, and picks up background monitor alerts.
// The whole file is wrapped in `#if DEBUG` so Release / App Store builds
// contain none of it.

@MainActor
@Observable
final class SwarmViewModel {

    enum Phase: Equatable {
        case idle
        case monitoring
        case processing
        /// 2-phase flow: the assess endpoint asked trade-off questions — the
        /// Trust Layer shows the quiz until every question is answered.
        case gatheringPreferences
        /// 2-phase flow: answers submitted, resolve acknowledged but the
        /// plans are still being built (async rail → poll `swarm-status`).
        case resolving
        case proposal
        case awaitingApproval
        case settled
        case failed(String)
    }

    // MARK: Observable state

    var phase: Phase = .idle
    var resolutionId: String?
    /// Extended Trust Layer plans (SPEC §3.4) once the swarm produced them.
    /// The 2-phase flow returns up to 3 carousel plans; legacy single-plan
    /// rails (mission/alert/simulate) store exactly one.
    var plans: [SwarmService.Plan] = []
    /// Legacy single-plan surface — the first carousel page (contract:
    /// `plan === plans[0]`).
    var plan: SwarmService.Plan? { plans.first }
    /// The carousel page currently shown — sent as `planIndex` on approve.
    var selectedPlanIndex = 0
    /// The plan on the currently-selected carousel page (fallback: first).
    var selectedPlan: SwarmService.Plan? {
        plans.indices.contains(selectedPlanIndex) ? plans[selectedPlanIndex] : plans.first
    }
    /// Trade-off quiz questions from `POST /mission/assess` (2-phase flow).
    var tradeoffs: [SwarmService.TradeoffQuestion] = []
    /// Quiz selections, questionId → optionId.
    var answers: [String: String] = [:]
    /// Which quiz step (question index) is on screen — the quiz advances one
    /// question at a time.
    var quizStep = 0
    /// Continue button gate — every question needs a picked option.
    var allTradeoffsAnswered: Bool {
        !tradeoffs.isEmpty && tradeoffs.allSatisfy { answers[$0.id] != nil }
    }
    /// Rendered as the Swarm Activity Stream, one row per agent step.
    var trace: [SwarmService.TraceEntry] = []
    var booking: SwarmService.Booking?
    /// Most recent background monitor alert (SPEC §4.5).
    var latestAlert: SwarmService.Alert?
    /// Drives the pulsing coral badge on the Copilot pill.
    var hasPendingAlert = false
    /// Weather-style mission derived from a DEGRADED (proactive, not bookable)
    /// alert's incident — NexusSwarmView shows an "Adapt my itinerary" button
    /// that launches this intent instead of reviewing an unbookable plan.
    var adaptiveMissionIntent: String?
    var approving = false
    var approveError: String?
    /// NEW (Phase C) — the mission/status response flagged the plan as
    /// assembled from simulated data (`degraded: true`): TrustLayerSheet
    /// shows a badge, disables Approve (it would 409) and offers a re-run.
    var degraded = false
    /// "provider_offline" | "session_store_memory" (optional).
    var degradedReason: String?
    /// Human-readable settlement changes ("day 2 rebooked…") shown as a
    /// bulleted recap once the mission settles.
    private(set) var settlementChanges: [String] = []
    /// Flips after ~15 s of polling while still `processing` — NexusSwarmView
    /// shows a reassuring footnote so the wait reads as depth, not failure.
    /// Reset on every new run.
    var isTakingLong = false
    /// Set by `friendlyError` when the failure is recoverable by re-running
    /// the same mission (`session_expired`, `trip_not_hydratable`) — the
    /// failed block then offers "Re-run mission" instead of a bare Retry.
    var failedOffersRerun = false

    /// Called on the MainActor after a successful settlement when the server
    /// returned `updated_content` — TripDetailView wires this to
    /// `model.apply(rawContent:)` so the open trip refreshes in place.
    @ObservationIgnored var onTripUpdated: (([String: Any]) -> Void)?

    /// Called ONCE after a successful settlement when the server reported
    /// `trip_updated == true` but returned NO `updated_content` (the rewrite
    /// landed server-side without an inline echo) — TripDetailView wires this
    /// to a one-shot network refresh so the timeline still catches the write.
    @ObservationIgnored var onTripRefreshNeeded: (() -> Void)?

    /// The settlement receipt of the last successful approve — the settled
    /// block reads `conflictSkipped` / `tripUpdated` / `note` to stay honest
    /// about a skipped or partial itinerary rewrite.
    private(set) var lastSettlement: SwarmService.Settlement?

    // MARK: Private machinery

    @ObservationIgnored private var alertTask: Task<Void, Never>?
    @ObservationIgnored private var alertCursor: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    /// The alerts endpoint requires `?since=&tripId=` — set by startMonitoring.
    @ObservationIgnored private var alertTripId: String?
    @ObservationIgnored private var lastIntent: String?
    /// Bumped by `reset()` — in-flight `pollStatus()` iterations captured the
    /// generation at start and bail out the moment it changes, so a poll
    /// response landing AFTER a cancel can't mutate the reset state machine.
    @ObservationIgnored private var pollGeneration = 0

    // MARK: Derived

    /// Busy rails — mission launch, status polling AND the 2-phase resolve
    /// step all block concurrent launches.
    var isProcessing: Bool { phase == .processing || phase == .resolving }

    /// The on-screen quiz step has a picked option (Continue/Next gate).
    var currentStepAnswered: Bool {
        guard tradeoffs.indices.contains(quizStep) else { return false }
        return answers[tradeoffs[quizStep].id] != nil
    }

    /// Iridescent "Deep Agentic Thinking" border is live in these phases.
    /// The swarm is ACTUALLY working right now — agents dispatched, no answer
    /// yet. This is the only state the iridescent border animates in: the
    /// rotating ring means "thinking", so leaving it turning under a finished
    /// proposal (or while merely standing by) drains the signal of meaning —
    /// and keeps a full-height gradient layer redrawing for nothing.
    /// `monitoring` is standby, and `gatheringPreferences` / `proposal` /
    /// `awaitingApproval` are all waiting on the TRAVELER, not on the swarm.
    var isThinking: Bool { phase == .processing || phase == .resolving }

    var glowActive: Bool { isThinking }

    var phaseLabel: String {
        switch phase {
        case .idle: return "Standby"
        case .monitoring: return "Monitoring"
        case .processing: return "Re-planning…"
        case .gatheringPreferences: return swarmL("Votre avis est attendu", "Your input needed")
        case .resolving: return swarmL("Création des plans…", "Building plans…")
        case .proposal: return "Proposal ready"
        case .awaitingApproval: return "Awaiting approval"
        case .settled: return "Settled"
        case .failed: return "Failed"
        }
    }

    /// Model-layer localization mirror of `AppSettings.tr` for DEBUG swarm
    /// labels (the VM has no SwiftUI environment). fr inline; es/de/zh via
    /// the `UIStrings` table keyed on the English source.
    private func swarmL(_ fr: String, _ en: String) -> String {
        switch LangPref.current {
        case "fr": return fr
        default:
            guard let lang = Lang(rawValue: LangPref.current) else { return en }
            return UIStrings.resolve(en, lang) ?? en
        }
    }

    // MARK: Monitoring & alert pickup

    /// `idle → monitoring` + start the background-alert polling fallback
    /// (SPEC §4.5; the primary rail is push + the realtime notifications
    /// channel, this poll is the fallback when realtime is unavailable).
    /// `tripId` is mandatory for the alerts endpoint; a later call with a
    /// tripId refreshes it, a nil keeps whatever was set before.
    /// WITHOUT a known tripId there is nothing to monitor — stay on
    /// "Standby" instead of flipping the header to "Active Monitoring" and
    /// spinning a no-op poller (guest/demo copilot path).
    func startMonitoring(tripId: String? = nil) {
        if let tripId, !tripId.isEmpty { alertTripId = tripId }
        guard alertTripId != nil else { return }
        if phase == .idle { phase = .monitoring }
        guard alertTask == nil else { return }
        alertTask = Task { [weak self] in
            while !Task.isCancelled {
                // The owning view is gone — stop polling instead of sleeping
                // forever on a deallocated model.
                guard let self else { return }
                await self.pollAlertsOnce()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    func stopMonitoring() {
        alertTask?.cancel()
        alertTask = nil
        if phase == .monitoring { phase = .idle }
    }

    private func pollAlertsOnce() async {
        guard let tripId = alertTripId,
              let response = try? await SwarmService.alerts(since: alertCursor, tripId: tripId) else { return }
        // Advance the cursor to the newest alert's own created_at; fall back
        // to server_time only for an empty batch — server_time taken after the
        // query would skip alerts inserted between query and response.
        if let newestCreatedAt = response.alerts.compactMap(\.createdAt).max() {
            alertCursor = max(alertCursor, newestCreatedAt)
        } else {
            alertCursor = max(alertCursor, response.serverTime)
        }
        // Server returns newest-first → surface the FIRST entry.
        if let newest = response.alerts.first { receive(alert: newest) }
    }

    /// A `swarm_disruption_alert` landed (polling fallback, or handed over
    /// from the notifications feed / deep link).
    func receive(alert: SwarmService.Alert) {
        guard alert.id != latestAlert?.id else { return }
        // Never hijack an in-flight mission (incl. the 2-phase quiz/resolve).
        guard phase != .processing && phase != .resolving
                && phase != .gatheringPreferences else { return }
        latestAlert = alert
        hasPendingAlert = true
        Haptics.warning()
        if alert.degraded {
            // Proactive monitor session — placeholder plan, NOT bookable
            // (approve would 409 plan_not_bookable). Don't jump to the Trust
            // Layer; offer a reactive mission built from the incident. An
            // incident the intent parser cannot classify falls back to the
            // weather intent instead of dead-ending on a 400 intent.
            adaptiveMissionIntent = SwarmService.MissionIntent.parseOrFallback(alert.incident)
            phase = .monitoring
        } else if let plan = alert.plan, !alert.resolutionId.isEmpty {
            // Bookable background plan, pre-approved-for-review server-side →
            // straight to the proposal. Alert rail is single-plan: the
            // carousel renders exactly one page.
            resolutionId = alert.resolutionId
            plans = [plan]
            selectedPlanIndex = 0
            degraded = alert.degraded
            degradedReason = nil
            adaptiveMissionIntent = nil
            prefetchPresentationImages(plan)
            phase = .proposal
        } else if phase == .idle {
            phase = .monitoring
        }
    }

    // MARK: Mission launch → assess → quiz → resolve (2-phase flow)

    /// Launches a mission through the 2-phase rail: `POST /mission/assess`
    /// first. The backend either returns trade-off questions (→
    /// `.gatheringPreferences`, the quiz collects answers, then
    /// `submitAnswers()`) or none at all (→ straight to `resolve` with empty
    /// answers). Errors land on the existing friendlyError → `.failed` path.
    /// The trip's own itinerary and the node this mission targeted. The Trust
    /// Layer needs both to show what the traveller HAD, not merely a sentence
    /// about what went wrong: `plan.incident` describes the disruption, and on
    /// a flight reroute it names the same leg the proposal replaces, so a
    /// before/after built from it can read "VY6651 → VY6651".
    var missionContent: TripContent?
    var missionNodeId: String?

    func launch(mission intent: String, tripId: String? = nil, nodeId: String? = nil) async {
        missionNodeId = nodeId
        guard !isProcessing else { return }
        resolutionId = nil
        plans = []
        selectedPlanIndex = 0
        tradeoffs = []
        answers = [:]
        quizStep = 0
        booking = nil
        trace = []
        approveError = nil
        hasPendingAlert = false
        adaptiveMissionIntent = nil
        settlementChanges = []
        lastSettlement = nil
        degraded = false
        degradedReason = nil
        prefetchedImageURLs = []
        isTakingLong = false
        failedOffersRerun = false
        lastIntent = intent
        phase = .processing
        do {
            // Scenario buttons launch without a tripId — fall back to the
            // monitored trip so settlement can rewrite the right itinerary.
            let resolvedTripId = tripId ?? alertTripId
            let response = try await SwarmService.assess(intent: intent,
                                                         tripId: resolvedTripId,
                                                         nodeId: nodeId,
                                                         language: SwarmService.appLanguage)
            guard phase == .processing else { return }   // superseded / cancelled
            resolutionId = response.resolutionId
            // Mission acknowledged by the swarm — a light physical commit tap.
            Haptics.tap()
            if response.tradeoffs.isEmpty {
                // No preferences needed — resolve immediately with no answers.
                await performResolve()
            } else {
                tradeoffs = response.tradeoffs
                answers = [:]
                quizStep = 0
                phase = .gatheringPreferences
            }
        } catch {
            guard phase == .processing else { return }
            phase = .failed(friendlyError(error))
        }
    }

    /// Quiz submitted — `POST /mission/resolve` with the picked trade-offs.
    /// The sync rail returns the plans inline (→ `.proposal`); the async
    /// real-trip rail answers `processing` and reuses the `pollStatus()`
    /// loop, which now reads `plans` off the status payload too.
    func submitAnswers() async {
        guard phase == .gatheringPreferences, allTradeoffsAnswered else { return }
        await performResolve()
    }

    /// Shared resolve step for `submitAnswers()` and the no-tradeoffs rail.
    private func performResolve() async {
        guard let id = resolutionId else { return }
        phase = .resolving
        do {
            let response = try await SwarmService.resolve(resolutionId: id,
                                                          answers: answers,
                                                          language: SwarmService.appLanguage)
            guard phase == .resolving else { return }   // superseded / cancelled
            resolutionId = response.resolutionId.isEmpty ? id : response.resolutionId
            degraded = response.degraded
            degradedReason = response.degradedReason
            if response.status == "proposal_ready",
               let responsePlans = response.plans, !responsePlans.isEmpty {
                // Demo/sync rail — the plans arrived inline, along with the
                // full `swarm_trace`; merge it (same helper as the polling
                // rail) so the Activity Stream isn't empty before .proposal.
                merge(response.swarmTrace ?? [])
                storePlans(responsePlans)
                Haptics.success()
                isTakingLong = false
                phase = .proposal
            } else {
                // Real-trip async rail — poll until the plans surface.
                await pollStatus()
            }
        } catch {
            guard phase == .resolving else { return }
            phase = .failed(friendlyError(error))
        }
    }

    /// Stores a fresh plan set (carousel-safe: resets the page index and
    /// warms the image cache for every page).
    private func storePlans(_ newPlans: [SwarmService.Plan]) {
        plans = newPlans
        selectedPlanIndex = 0
        for plan in newPlans { prefetchPresentationImages(plan) }
    }

    /// Judge-mode one-shot path retired with the demo rail — missions now
    /// always flow through the 2-phase assess → resolve rail.

    /// GET `swarm-status/{id}` every 1.5 s while processing (or resolving on
    /// the async 2-phase rail), merging new trace entries into the Activity
    /// Stream as they arrive.
    func pollStatus() async {
        guard let id = resolutionId else { return }
        // Freshness anchor — `reset()` (cancel/expire) bumps `pollGeneration`
        // and a superseding launch replaces `resolutionId`, so every response
        // landing after one of those is discarded BEFORE it touches state.
        let gen = pollGeneration
        func stillFresh() -> Bool {
            isProcessing && resolutionId == id && gen == pollGeneration
        }
        let pollingStartedAt = Date()
        for _ in 0..<60 {   // bounded — the demo graph resolves in < 3 s
            do {
                let status = try await SwarmService.status(resolutionId: id)
                // A cancel/reset landed while this request was in flight —
                // drop the response instead of resurrecting the proposal or
                // flipping the fresh standby screen into a failure.
                guard stillFresh() else { return }
                merge(status.trace ?? [])
                degraded = status.degraded
                degradedReason = status.degradedReason
                if let statusPlans = status.plans, !statusPlans.isEmpty {
                    // 2-phase flow: the status payload carries the full set
                    // (contract: `plan === plans[0]`).
                    storePlans(statusPlans)
                } else if let plan = status.plan {
                    storePlans([plan])
                }
                switch status.state {
                case "processing":
                    break
                case "proposal_ready", "awaiting_approval":
                    guard stillFresh() else { return }
                    // The server may report proposal_ready one tick before
                    // the plans are readable — keep polling instead of
                    // revealing an empty Trust Layer. (`break` exits the
                    // switch, so the bounded loop sleeps and polls again.)
                    guard !plans.isEmpty else { break }
                    // The plan landed — one success haptic for the reveal.
                    Haptics.success()
                    isTakingLong = false
                    phase = .proposal
                    return
                case "approved", "settled":
                    guard stillFresh() else { return }
                    phase = .settled
                    return
                case "expired":
                    guard stillFresh() else { return }
                    failedOffersRerun = true
                    phase = .failed(swarmL(
                        "Cette session de l'essaim a expiré. Lancez une nouvelle mission pour continuer.",
                        "This swarm session has expired. Launch a new mission to continue."))
                    return
                default:
                    break
                }
            } catch let error as SwarmService.ServiceError {
                if case .http(404, _) = error {
                    guard stillFresh() else { return }
                    phase = .failed(swarmL(
                        "La session de l'essaim est inconnue du serveur.",
                        "The swarm session is unknown to the server."))
                    return
                }
                // Any other error: tolerate one bad poll and keep polling.
            } catch {
                // Transient transport hiccup — keep polling.
            }
            // Still negotiating after ~15 s → reassure instead of silence.
            if !isTakingLong, Date().timeIntervalSince(pollingStartedAt) >= 15 {
                isTakingLong = true
            }
            try? await Task.sleep(for: .seconds(1.5))
            guard stillFresh(), !Task.isCancelled else { return }
        }
        if isProcessing {
            phase = .failed(swarmL(
                "L'essaim a mis trop de temps à répondre. Réessayez.",
                "The swarm took too long to respond. Try again."))
        }
    }

    private func merge(_ entries: [SwarmService.TraceEntry]) {
        var seen = Set(trace.map(\.id))
        for entry in entries where !seen.contains(entry.id) {
            trace.append(entry)
            seen.insert(entry.id)
        }
    }

    // MARK: Trust Layer wiring

    /// `proposal → awaiting_approval` (TrustLayerSheet presented).
    func openTrustLayer() {
        if phase == .proposal { phase = .awaitingApproval }
    }

    /// `awaiting_approval → proposal` (sheet dismissed without approving).
    func closeTrustLayer() {
        if phase == .awaitingApproval { phase = .proposal }
    }

    /// `awaiting_approval → settled` via `POST /approve-resolution`
    /// `{ resolutionId, approved: true, planIndex }` — the single settlement
    /// endpoint. `planIndex` settles the carousel page the user picked.
    func approve() async {
        guard let id = resolutionId, phase == .awaitingApproval, !approving else { return }
        approving = true
        approveError = nil
        defer { approving = false }
        do {
            let response = try await SwarmService.approve(resolutionId: id, planIndex: selectedPlanIndex)
            booking = response.booking
            if let plan = response.plan { storePlans([plan]) }
            settlementChanges = response.settlement?.changes ?? []
            lastSettlement = response.settlement
            phase = .settled
            Haptics.success()
            // Settlement rewrote the itinerary → push the fresh content_json
            // into the open trip (already on the MainActor).
            if let content = response.updatedContent {
                onTripUpdated?(content)
            } else if response.settlement?.tripUpdated == true {
                // The rewrite landed server-side but the payload carried no
                // `updated_content` — one network refresh picks it up.
                onTripRefreshNeeded?()
            }
        } catch {
            approveError = notBookableError(error) ?? friendlyError(error)
        }
    }

    /// Maps the approve endpoint's 409 not-bookable codes
    /// (`degraded_plan_not_bookable` / `plan_not_bookable`) onto actionable
    /// copy — the proposal was simulated data, a re-run is the fix. Returns
    /// nil for every other error (handled by `friendlyError`).
    private func notBookableError(_ error: Error) -> String? {
        guard case let SwarmService.ServiceError.http(code, detail) = error, code == 409 else { return nil }
        let d = detail ?? ""
        guard d.contains("plan_not_bookable") || d.contains("degraded_plan_not_bookable") else { return nil }
        degraded = true
        return "This proposal can't be booked — it was assembled from simulated data. Re-run the mission below to get a bookable plan."
    }

    /// `failed → idle` (or back to monitoring when the alert poller is live).
    func reset() {
        // Invalidate any in-flight poll iteration — its captured generation
        // no longer matches, so a late response can't mutate the fresh state.
        pollGeneration += 1
        resolutionId = nil
        plans = []
        selectedPlanIndex = 0
        tradeoffs = []
        answers = [:]
        quizStep = 0
        booking = nil
        trace = []
        approveError = nil
        adaptiveMissionIntent = nil
        settlementChanges = []
        lastSettlement = nil
        degraded = false
        degradedReason = nil
        prefetchedImageURLs = []
        isTakingLong = false
        failedOffersRerun = false
        phase = alertTask == nil ? .idle : .monitoring
    }

    /// Retry the last mission after a failure.
    func retry() async {
        guard case .failed = phase, let intent = lastIntent else { return }
        await launch(mission: intent)
    }

    /// One-tap "Re-run mission" for DEGRADED (not bookable) proposals —
    /// reuses the launch flow, which resets all plan state first. Falls back
    /// to `reset()` when no intent is known (e.g. a background alert plan).
    func rerunMission() async {
        guard let intent = lastIntent else {
            reset()
            return
        }
        await launch(mission: intent)
    }

    /// Abandons the current mission — BEST-EFFORT: the state machine resets
    /// IMMEDIATELY (the UI never stalls on a slow cancel endpoint), then the
    /// server-side cancel fires as an unawaited background task. It never
    /// throws into the UI flow.
    func cancelMission() {
        let id = resolutionId
        reset()
        guard let id else { return }
        Task { _ = await SwarmService.cancelMission(resolutionId: id) }
    }

    // MARK: Presentation prefetch

    /// URLs already kicked off this mission (idempotent — pollStatus re-fires
    /// on every plan update).
    @ObservationIgnored private var prefetchedImageURLs: Set<String> = []

    /// Warm the shared disk image cache with the dossier imagery the moment
    /// the plan first arrives, so the TrustLayerSheet carousel paints without
    /// a fetch delay.
    private func prefetchPresentationImages(_ plan: SwarmService.Plan) {
        var urls: [String] = plan.presentation?.hotel?.images ?? []
        if let swap = plan.presentation?.activitySwap?.image, !swap.isEmpty { urls.append(swap) }
        let fresh = urls.filter { prefetchedImageURLs.insert($0).inserted }
        guard !fresh.isEmpty else { return }
        Task.detached(priority: .utility) {
            for urlString in fresh {
                guard let url = URL(string: urlString) else { continue }
                _ = await RemoteImageDataStore.shared.data(for: url)
            }
        }
    }

    // MARK: Error shaping (friendly, localized)

    /// Shapes errors into traveler-friendly copy. Structured backend codes
    /// (`session_expired`, `session_store_unavailable`, `trip_not_hydratable`,
    /// `trip_required`, `no_actionable_nodes`, `quotes_expired`) get dedicated
    /// messages; `session_expired` and `trip_not_hydratable` additionally set
    /// `failedOffersRerun` so the failed block offers `rerunMission()`.
    private func friendlyError(_ error: Error) -> String {
        failedOffersRerun = false
        // Server-side TTL rejection (approve 410) — fresh prices need a re-run.
        if case SwarmService.ServiceError.quotesExpired = error {
            failedOffersRerun = true
            return swarmL(
                "Les devis de ce plan ont expiré. Relancez la mission pour obtenir de nouveaux prix.",
                "The price quotes for this plan have expired. Re-run the mission to get fresh prices.")
        }
        if case let SwarmService.ServiceError.http(_, detail) = error, let detail {
            // `errorDetail` composes "<code> — <message>" — match on the code.
            if detail.contains("session_expired") {
                failedOffersRerun = true
                return swarmL(
                    "Cette session de l'essaim a expiré. Relancez la mission pour continuer.",
                    "This swarm session has expired. Re-run the mission to continue.")
            }
            if detail.contains("session_store_unavailable") {
                return swarmL(
                    "Le service de sessions de l'essaim est momentanément indisponible. Réessayez dans un instant.",
                    "The swarm session service is temporarily unavailable. Please try again in a moment.")
            }
            if detail.contains("trip_not_hydratable") {
                failedOffersRerun = true
                return swarmL(
                    "Votre voyage n'a pas pu être chargé pour cette mission. Relancez-la pour réessayer.",
                    "Your trip couldn't be loaded for this mission. Re-run the mission to try again.")
            }
            if detail.contains("trip_required") {
                return swarmL(
                    "Cette mission a besoin d'un voyage enregistré. Ouvrez un voyage, puis lancez la mission depuis celui-ci.",
                    "This mission needs a saved trip. Open a trip, then launch the mission from it.")
            }
            if detail.contains("no_actionable_nodes") {
                return swarmL(
                    "Rien dans votre itinéraire ne peut être modifié pour ce scénario.",
                    "Nothing in your itinerary can be changed for this scenario.")
            }
            if detail.contains("quotes_expired") {
                failedOffersRerun = true
                return swarmL(
                    "Les devis de ce plan ont expiré. Relancez la mission pour obtenir de nouveaux prix.",
                    "The price quotes for this plan have expired. Re-run the mission to get fresh prices.")
            }
        }
        if let serviceError = error as? SwarmService.ServiceError {
            return serviceError.errorDescription
                ?? swarmL("Une erreur est survenue.", "Something went wrong.")
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cannotConnectToHost, .networkConnectionLost, .notConnectedToInternet, .cannotFindHost:
                return swarmL(
                    "Aucune connexion au service de l'essaim.",
                    "No connection to the swarm service.")
            case .timedOut:
                return swarmL(
                    "Le service de l'essaim a mis trop de temps à répondre. Vérifiez votre connexion et réessayez.",
                    "The swarm service took too long to answer. Check your connection and try again.")
            default:
                return urlError.localizedDescription
            }
        }
        return error.localizedDescription
    }
}
