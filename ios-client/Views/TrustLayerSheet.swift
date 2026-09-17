import SwiftUI
import MapKit

// MARK: - Nexus Swarm Trust Layer sheet
//
// Explicit human-approval gate for a swarm proposal: incident, impacted
// nodes, PolicyAgent verdict, hotel & activity deltas, the "Your new plan"
// dossier (flight card, imagery, change map, itemized ledger) and the
// financial breakdown (new charges − refund = net payable, the Trust Layer
// invariant). Approval calls POST /api/hackathon/approve-resolution.
// The receipt distinguishes provider bookings from changes recorded locally
// in the trip. Ships in Release behind SwarmAvailability.

struct TrustLayerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSettings.self) private var app
    @Environment(SwarmAvailability.self) private var availability

    @Bindable var model: SwarmViewModel
    @State private var confirming = false
    @State private var comparingPlans = false
    /// Which evidence groups are open. "What changes" starts expanded: it is
    /// the answer to "what is the swarm actually doing to my trip", and
    /// making the traveller tap for that put the one thing they came to read
    /// behind a disclosure.
    @State private var expandedGroups: Set<String> = ["changes"]
    /// One-shot settle-seal reveal flag (drives the spring in `settledBlock`).
    @State private var sealRevealed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Bumped exactly once, at the selected quote's expiry. The approve button
    /// and the confirmation popup re-derive their expired state from it, so a
    /// dying quote disables them on time WITHOUT the whole sheet re-rendering
    /// every second — the countdown digits live in `TTLBadgeView` alone.
    @State private var expiryTick = Date()
    /// Measured height of the floating actions card. The page reserves exactly
    /// this much room at its end: a hard-coded 128 pt was ~70 pt short of the
    /// real card, so the end of every plan — the price-guarantee countdown
    /// included — could never be scrolled out from under Approve.
    @State private var actionsHeight: CGFloat = 200
    /// The window's bottom safe-area inset, read from the SAME proxy as the
    /// card. The carousel ignores the bottom safe area so its backdrop runs
    /// edge to edge, which means the home indicator has to be accounted for
    /// explicitly — otherwise the card sits on top of it on every device that
    /// has one, and the page reserves too little room beneath the plan.
    @State private var actionsBottomInset: CGFloat = 0

    /// The plan behind the money copy (settle dialog + `money()`) — the
    /// carousel page currently on screen.
    private var plan: SwarmService.Plan? { model.selectedPlan }
    private var isFlightRehearsal: Bool {
        availability.usesFlightSandbox && plan?.proposedResolution.newFlight != nil
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.phase == .settled {
                    scrollContent { settledBlock }
                } else if model.phase == .gatheringPreferences {
                    // 2-phase flow, step 1 — the trade-off quiz.
                    scrollContent { TradeoffQuizView(model: model) }
                } else if model.phase == .resolving {
                    // 2-phase flow, step 2 — plans being built server-side.
                    scrollContent { resolvingBlock }
                } else if model.isProcessing {
                    scrollContent { processingBlock }
                } else if !model.plans.isEmpty {
                    // Proposal review — swipeable plan carousel + ONE shared
                    // Approve & Settle button below (single-plan and alert
                    // rails render a one-page carousel unchanged).
                    plansCarouselLayout
                } else {
                    scrollContent { emptyBlock }
                }
            }
            // ONE translucent layer for the whole sheet. The aurora animates
            // only while agents are working — during review nothing behind
            // the plan moves, so nothing forces the page to re-composite.
            // The app's own backdrop, so the sheet belongs to the same world
            // as every other screen. It only ANIMATES while agents are working;
            // during review it is a static gradient behind the glass.
            .background(AuroraBackground(animated: model.isProcessing || model.phase == .resolving))
            .navigationTitle(app.tr("Trust Layer", "Trust Layer"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(model.phase == .settled
                           ? app.trm("Terminé", "Done", "Listo", "Fertig", "完成")
                           : app.trm("Plus tard", "Later", "Más tarde", "Später", "稍后")) { dismiss() }
                        // Defense-in-depth: the dismiss button stays visible
                        // above the popup layer only as chrome — it must not
                        // close the sheet mid-settlement.
                        .disabled(confirming)
                }
            }
        }
        // Centered payment-authorization popup — overlaid OUTSIDE the
        // NavigationStack so the dimmed backdrop covers the nav bar and
        // toolbar too, and the card is truly centered in the window. The
        // condition lives INSIDE a persistent ZStack so insertion/removal
        // transitions actually animate.
        .overlay {
            ZStack {
                if confirming {
                    settleConfirmPopup
                }
            }
            .animation(reduceMotion ? nil : .spring(duration: 0.3), value: confirming)
        }
        .sheet(isPresented: $comparingPlans) {
            planComparison.dynamicTypeSize(dynamicTypeSize)
        }
        // One wake-up at the expiry instant, re-armed when the selected plan
        // (and so its deadline) changes.
        .task(id: model.selectedPlan?.expiresAt) {
            guard let expiresAt = model.selectedPlan?.expiresAt else { return }
            let remaining = expiresAt.timeIntervalSinceNow
            if remaining > 0 {
                try? await Task.sleep(for: .seconds(remaining))
                guard !Task.isCancelled else { return }
            }
            expiryTick = Date()
        }
    }

    /// Is the selected quote dead? Evaluated at render time; `expiryTick`
    /// guarantees a render happens at the moment it becomes true.
    private var selectedPlanExpired: Bool {
        _ = expiryTick
        guard let expiresAt = model.selectedPlan?.expiresAt else { return false }
        return expiresAt <= Date()
    }

    /// Shared scroll wrapper for the non-carousel steps.
    private func scrollContent<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                content()
            }
            .padding(20)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
    }

    private var settleDialogTitle: String {
        if isFlightRehearsal {
            return app.trm("Appliquer ce plan de répétition ?", "Apply this rehearsal plan?",
                           "¿Aplicar este plan de prueba?", "Diesen Testplan anwenden?", "应用此演练方案？")
        }
        if let plan {
            // Multi-currency settlements (e.g. a USD charge alongside an EUR
            // refund) — name EVERY payable bucket so no part of the bill is
            // omitted. Order is as decoded: the ledger bucket first. Sign
            // gate: this only fires when the settlement is actually payable
            // (positive buckets AND a positive net) — refund-only /
            // mixed-negative cases fall through to the legacy wording.
            let buckets = plan.financialDelta.byCurrency.filter { $0.netPayable > 0 }
            if buckets.count > 1 && plan.financialDelta.netPayable > 0 {
                let joined = buckets
                    .map { SwarmFormat.money($0.netPayable, currency: $0.currency) }
                    .joined(separator: " + ")
                return app.trm("Régler \(joined) auprès du prestataire ?",
                               "Settle \(joined) with the provider?",
                               "¿Pagar \(joined) al proveedor?",
                               "\(joined) beim Anbieter begleichen?",
                               "向供应商支付 \(joined)？")
            }
            if plan.financialDelta.netPayable > 0 {
                let amount = money(plan.financialDelta.netPayable)
                return app.trm("Régler \(amount) auprès du prestataire ?",
                               "Settle \(amount) with the provider?",
                               "¿Pagar \(amount) al proveedor?",
                               "\(amount) beim Anbieter begleichen?",
                               "向供应商支付 \(amount)？")
            }
        }
        return app.trm("Approuver ce plan ?", "Approve this resolution plan?",
                       "¿Aprobar este plan?", "Diesen Plan genehmigen?", "批准此方案？")
    }

    // MARK: Blocks

    /// Header badge for DEGRADED missions (simulated data — provider offline
    /// or in-memory session store). Approve is disabled below; the fix is a
    /// one-tap re-run.
    private var degradedBadge: some View {
        SwarmSurfaceCard {
            HStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title3)
                    .foregroundStyle(Brand.amber)
                VStack(alignment: .leading, spacing: 3) {
                    Text(degradedTitle)
                        .font(.subheadline.weight(.semibold))
                    Text(app.tr("Cette proposition vient de données simulées et ne peut pas être réservée. Relancez la mission ci-dessous pour des prix réels.", "This proposal was built from simulated data and can't be booked. Re-run the mission below for live pricing."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var degradedTitle: String {
        switch model.degradedReason {
        case "session_store_memory":
            return app.trm("Données simulées — session de démo", "Simulated data — demo session",
                           "Datos simulados — sesión de demo", "Simulierte Daten – Demo-Sitzung",
                           "模拟数据 — 演示会话")
        default:
            return app.trm("Données simulées — fournisseur indisponible", "Simulated data — provider offline",
                           "Datos simulados — proveedor sin conexión", "Simulierte Daten – Anbieter offline",
                           "模拟数据 — 供应商离线")
        }
    }

    private var approvalBanner: some View {
        SwarmSurfaceCard {
            HStack(spacing: 12) {
                Image(systemName: settlementNeedsFollowUp ? "exclamationmark.circle.fill" : "checkmark.seal.fill")
                    .font(.title2)
                    .foregroundStyle(Brand.gradient)
                VStack(alignment: .leading, spacing: 3) {
                    Text(app.tr("Votre validation est requise", "Requires your approval"))
                        .font(.subheadline.weight(.semibold))
                    Text(app.tr("Rien n'est réservé ni débité tant que vous n'avez pas validé ici.", "Nothing is booked or charged until you approve it here."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func incidentBlock(_ plan: SwarmService.Plan) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(app.tr("Incident", "Incident"))
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(plan.incident)
                // Headline weight, not display size: this sits above a card
                // that already spells out the flight, the route and the
                // impacted nodes, and at .title3 it wrapped into a wall of
                // bold text that pushed everything else off screen.
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            if !plan.impactedNodes.isEmpty {
                SwarmSurfaceCard(style: .solid) {
                    VStack(alignment: .leading, spacing: 0) {
                        sectionHeader(app.trm("Ce qui est touché", "What it affected", "Qué se ve afectado", "Was betroffen ist", "受影响的内容"), icon: "exclamationmark.triangle")
                            .padding(.bottom, 6)
                        ForEach(Array(plan.impactedNodes.enumerated()), id: \.element) { idx, node in
                            factRow(node,
                                    app.tr("Touché", "Affected"),
                                    tint: Brand.coral,
                                    first: idx == 0)
                        }
                    }
                }
            }
        }
    }

    /// One fact per line, each on its own divided row. Mixed prose, a
    /// checkmark row and two label/value rows in one stack meant the reader
    /// had to parse three different shapes to answer three simple questions;
    /// a single label-left / value-right rhythm reads in one pass.
    private func policyBlock(_ verdict: SwarmService.PolicyVerdict) -> some View {
        SwarmSurfaceCard(style: .solid) {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader(app.trm("Les règles de votre billet", "Your ticket's change rules", "Las reglas de tu billete", "Die Umbuchungsregeln deines Tickets", "你的机票改签规则"), icon: "scalemass")
                    .padding(.bottom, 6)
                factRow(app.tr("Modification", "Rebooking"),
                        verdict.rebookPermitted
                            ? app.tr("Autorisée", "Permitted")
                            : app.tr("Refusée", "Not permitted"),
                        tint: verdict.rebookPermitted ? .green : Brand.coral,
                        first: true)
                factRow(app.tr("Recommandation", "Recommended"),
                        verdict.recommendedAction
                            .replacingOccurrences(of: "_", with: " ")
                            .capitalized)
                // The fee's OWN currency — never the trip's.
                factRow(app.tr("Frais de modification", "Change fee"),
                        SwarmFormat.money(verdict.changeFee,
                                          currency: verdict.currency ?? plan?.currency))
                if verdict.noShowApplied {
                    factRow(app.tr("Non-présentation", "No-show"),
                            app.tr("La compagnie retient une partie du billet",
                                   "The airline keeps part of the fare"),
                            tint: Brand.coral)
                }
            }
        }
    }

    /// Label left, value right, hairline above every row but the first.
    @ViewBuilder
    private func factRow(_ label: String, _ value: String,
                         tint: Color? = nil, first: Bool = false) -> some View {
        if !first { Divider().opacity(0.25) }
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(.footnote.weight(.medium))
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .foregroundStyle(tint ?? .primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 7)
    }

    /// What the disruption broke, and what replaces it — side by side.
    ///
    /// "What changes" previously opened straight onto the replacement, with
    /// the thing being replaced named only in the incident line further down
    /// the page. A change is a pair; showing one half asks the traveller to
    /// hold the other in their head.
    private func beforeAfterBlock(_ plan: SwarmService.Plan) -> some View {
        SwarmSurfaceCard(style: .solid) {
            VStack(alignment: .leading, spacing: 10) {
                let original = originalLeg()
                changeSide(label: app.tr("AVANT", "WAS"),
                           icon: "exclamationmark.triangle.fill",
                           tint: Brand.coral,
                           headline: original?.headline ?? plan.incident,
                           detail: original?.detail ?? (plan.impactedNodes.isEmpty
                               ? nil : plan.impactedNodes.joined(separator: " · ")))

                Image(systemName: "arrow.down")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)

                changeSide(label: app.tr("APRÈS", "NOW"),
                           icon: "checkmark.seal.fill",
                           tint: .green,
                           headline: replacementHeadline(plan),
                           detail: replacementDetail(plan))
            }
        }
    }

    /// The leg the mission targeted, read from the trip's OWN itinerary.
    ///
    /// `plan.incident` is a sentence about the disruption, and on a flight
    /// reroute it names the leg being replaced — so a before/after built from
    /// it happily printed "VY6651 → VY6651". The real previous state lives in
    /// the trip content, addressed by the same `flight-<idx>` / `transfer-<idx>`
    /// ids the backend derives from `transit_groups`.
    private func originalLeg() -> (headline: String, detail: String?)? {
        guard let nodeId = model.missionNodeId,
              let legs = model.missionContent?.transit_groups
        else { return nil }
        let parts = nodeId.split(separator: "-")
        guard parts.count == 2,
              parts[0] == "flight" || parts[0] == "transfer",
              let index = Int(parts[1]),
              legs.indices.contains(index)
        else { return nil }

        let leg = legs[index]
        // P4 — an UNBOOKED leg's reference number is the model's illustrative
        // example, not a real departure: mark it indicative (mirrors the
        // timeline's honesty label).
        let refText: String? = leg.reference.flatMap { ref in
            leg.booked == true
                ? ref
                : "\(ref) (\(app.trm("indicatif", "indicative", "orientativo", "Richtwert", "参考价")))"
        }
        let name = [leg.carrier, refText]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let route = [leg.origin?.code ?? leg.origin?.city,
                     leg.destination?.code ?? leg.destination?.city]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " → ")
        let headline = [name, route].filter { !$0.isEmpty }.joined(separator: " · ")
        guard !headline.isEmpty else { return nil }

        // Same wall-clock reading as the timeline, so the two halves of the
        // comparison are measured the same way.
        var schedule = SwarmFormat.transitRangeLabel(depart: leg.depart, arrive: leg.arrive)
        if let minutes = SwarmFormat.minutesBetween(leg.depart, leg.arrive), minutes > 0 {
            schedule += " · \(SwarmFormat.durationLabel(minutes: minutes))"
        }
        if let stops = leg.stopsLabel { schedule += " · \(stops)" }
        return (headline, schedule.isEmpty ? nil : schedule)
    }

    private func changeSide(label: String, icon: String, tint: Color,
                            headline: String, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(label, systemImage: icon)
                .font(.caption2.weight(.bold))
                .foregroundStyle(tint)
            Text(headline)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The replacement, whatever kind of thing it is — a flight, a hotel, a
    /// rescheduled activity — so non-flight missions get a real "after" too.
    private func replacementHeadline(_ plan: SwarmService.Plan) -> String {
        if let flight = plan.proposedResolution.newFlight {
            return flightHeadline(flight)
        }
        if let name = plan.presentation?.hotel?.name, !name.isEmpty {
            return name
        }
        if let name = plan.presentation?.activitySwap?.name, !name.isEmpty {
            return name
        }
        if let first = plan.proposedResolution.rescheduledActivities.first {
            return first.name
        }
        return app.tr("Plan mis à jour", "Updated plan")
    }

    private func replacementDetail(_ plan: SwarmService.Plan) -> String? {
        if let flight = plan.proposedResolution.newFlight {
            return flightScheduleLine(flight)
        }
        if let first = plan.proposedResolution.rescheduledActivities.first {
            return SwarmFormat.activitySlotLabel(iso: first.newTimeIso, human: first.newTime)
        }
        return nil
    }

    private func resolutionBlock(_ plan: SwarmService.Plan) -> some View {
        SwarmSurfaceCard(style: .solid) {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(app.trm("Ce que nous allons changer", "What we'll change", "Lo que vamos a cambiar", "Was wir ändern", "我们将更改的内容"), icon: "wand.and.stars")
                if let flight = plan.proposedResolution.newFlight {
                    HStack {
                        Label(flight.displayLabel, systemImage: "airplane")
                            .font(.subheadline)
                        Spacer()
                        Text(SwarmFormat.money(flight.cost, currency: flight.currency ?? plan.currency))
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                    }
                }
                let hotels = plan.proposedResolution.hotelAdjustments ?? []
                ForEach(hotels, id: \.hotelName) { hotel in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .top) {
                            Label("\(hotel.hotelName) — \(hotelActionLabel(hotel.action))",
                                  systemImage: "bed.double")
                                .font(.subheadline)
                            Spacer()
                            Text(hotel.requiresConfirmation
                                 ? app.trm("Frais non vérifiés", "Fee unverified", "Tarifa sin verificar", "Gebühr ungeprüft", "费用未核实")
                                 : (hotel.fee > 0 ? money(hotel.fee)
                                    : app.trm("sans frais", "no fee", "sin cargo", "keine Gebühr", "无费用")))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        if let note = hotel.note, !note.isEmpty {
                            Label(note, systemImage: hotel.requiresConfirmation ? "exclamationmark.triangle" : "clock")
                                .font(.footnote)
                                .foregroundStyle(hotel.requiresConfirmation ? Color.orange : Color.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        } else if hotel.requiresConfirmation {
                            Label(app.trm("Contactez l’établissement pour confirmer l’arrivée tardive et les frais.",
                                          "Contact the property to confirm late arrival and any fees.",
                                          "Contacta con el alojamiento para confirmar la llegada tardía y los cargos.",
                                          "Kontaktiere die Unterkunft, um die späte Ankunft und Gebühren zu bestätigen.",
                                          "请联系酒店确认晚到及相关费用。"),
                                  systemImage: "exclamationmark.triangle")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("trustLayer.hotel.\(hotel.hotelName)")
                }
                ForEach(plan.proposedResolution.rescheduledActivities, id: \.name) { activity in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(activity.name)
                            .font(.subheadline.weight(.medium))
                        HStack {
                            if activity.action == "drop" {
                                // W2 drop row: cancelled out of the day by the
                                // smart reorganization — no slot, no move
                                // arrow; the backend's `new_time` carries the
                                // cancelled wording verbatim.
                                Text(activity.newTime.isEmpty ? "Cancelled" : activity.newTime)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            } else {
                                // Prefer the machine-readable ISO time, read as
                                // WALL CLOCK: the wire anchors an activity's written
                                // time to UTC, so the device clock would print 23:00
                                // for a 15:00 activity on a UTC+8 phone — against
                                // both the timeline and the server's own `new_time`.
                                Text("→ \(SwarmFormat.activitySlotLabel(iso: activity.newTimeIso, human: activity.newTime))")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(activity.penalty > 0 ? "penalty \(money(activity.penalty))" : "no penalty")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        if activity.penalty > 0 {
                            // Explain the "penalty" — server `reason` first,
                            // generic provider-fee copy otherwise.
                            Text(SwarmFormat.penaltyExplanation(activity))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.leading, 4)
                }
            }
        }
    }

    // MARK: "Your new plan" dossier (Phase C presentation block)

    /// The dossier renders ONLY when there's enrichment to show — an
    /// enriched flight and/or a `presentation` block. Absent data ⇒ the
    /// classic layout, unchanged.
    private func hasDossier(_ plan: SwarmService.Plan) -> Bool {
        // ANY replacement flight earns the dossier. Gating on the enrichment
        // fields meant a plan whose provider returned only an id and a fare
        // showed no flight at all — the traveler was asked to approve a
        // rebooking without being shown what they were rebooking onto.
        if plan.proposedResolution.newFlight != nil { return true }
        return plan.presentation != nil
    }

    private func newPlanDossier(_ plan: SwarmService.Plan) -> some View {
        SwarmSurfaceCard(style: .solid) {
            VStack(alignment: .leading, spacing: 12) {
                sectionHeader(app.trm("Votre nouveau plan", "Your new plan", "Tu nuevo plan", "Dein neuer Plan", "你的新方案"), icon: "doc.text.image")
                if let flight = plan.proposedResolution.newFlight {
                    dossierFlightCard(flight, plan: plan)
                }
                let images = dossierImages(plan)
                if !images.isEmpty {
                    dossierCarousel(images)
                }
                if let hotel = plan.presentation?.hotel {
                    dossierHotel(hotel, fallbackCurrency: plan.currency)
                }
                if let swap = plan.presentation?.activitySwap {
                    dossierActivitySwap(swap, fallbackCurrency: plan.currency)
                }
                let points = (plan.presentation?.mapPoints ?? []).filter { $0.lat != 0 || $0.lng != 0 }
                if !points.isEmpty {
                    // Static snapshot raster (pager perf) — falls back to the
                    // live map internally on snapshot failure.
                    SwarmMapThumbnail(points: points)
                }
            }
        }
    }

    /// New-flight card: airline + route + localized depart/arrive times from
    /// the enrichment fields, falling back to `displayLabel` when absent.
    private func dossierFlightCard(_ flight: SwarmService.NewFlight, plan: SwarmService.Plan) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "airplane")
                    .foregroundStyle(Brand.indigo)
                Text(flight.airline ?? flight.displayLabel)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(SwarmFormat.money(flight.cost, currency: flight.currency ?? plan.currency))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
            }
            if let from = flight.from, let to = flight.to, !from.isEmpty, !to.isEmpty {
                Text("\(from) → \(to)")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            if flight.departure != nil || flight.arrival != nil {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.tr("Départ", "Departs"))
                            .font(.caption2.weight(.semibold))
                            .textCase(.uppercase)
                            .foregroundStyle(.tertiary)
                        // Wall clock, like the timeline — a flight's times are
                        // already local to its airports, and converting them
                        // to the device zone made this card disagree with the
                        // timeline row for the very same flight.
                        Text(SwarmFormat.transitRangeLabel(depart: flight.departure, arrive: nil))
                            .font(.footnote)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(app.tr("Arrivée", "Arrives"))
                            .font(.caption2.weight(.semibold))
                            .textCase(.uppercase)
                            .foregroundStyle(.tertiary)
                        Text(SwarmFormat.transitRangeLabel(depart: flight.arrival, arrive: nil))
                            .font(.footnote)
                    }
                }
            }
            // Routing shape: what separates a 2h non-stop from a 6h one-stop
            // at a similar fare. Rendered only when the provider described it.
            if flight.stopsLabel != nil || flight.effectiveDurationMinutes != nil {
                HStack(spacing: 8) {
                    if let stops = flight.stopsLabel {
                        dossierChip(stops, systemImage: "arrow.triangle.branch")
                    }
                    if let minutes = flight.effectiveDurationMinutes, minutes > 0 {
                        dossierChip(SwarmFormat.durationLabel(minutes: minutes),
                                    systemImage: "clock")
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.indigo.opacity(0.07), in: .rect(cornerRadius: 12))
    }

    /// Small translucent capsule used for the routing facts on a flight card.
    private func dossierChip(_ text: String, systemImage: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.caption2)
            Text(text)
                .font(.caption.weight(.medium))
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.quaternary.opacity(0.6), in: .capsule)
    }

    /// Hotel images + activity-swap image, capped at 4.
    private func dossierImages(_ plan: SwarmService.Plan) -> [String] {
        var urls = plan.presentation?.hotel?.images ?? []
        if let swap = plan.presentation?.activitySwap?.image,
           !swap.trimmingCharacters(in: .whitespaces).isEmpty {
            urls.append(swap)
        }
        return Array(urls.prefix(4))
    }

    private func dossierCarousel(_ urls: [String]) -> some View {
        TabView {
            ForEach(urls, id: \.self) { urlString in
                CachedAsyncImage(url: URL(string: urlString)) { image in
                    image
                        .resizable()
                        .scaledToFill()
                }
                .frame(maxWidth: .infinity)
                .frame(height: 180)
                .background(Brand.indigo.opacity(0.08))
                .clipped()
            }
        }
        .tabViewStyle(.page(indexDisplayMode: urls.count > 1 ? .automatic : .never))
        .frame(height: 180)
        .clipShape(.rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color(.separator)))
    }

    private func dossierHotel(_ hotel: SwarmService.PresentationHotel, fallbackCurrency: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let name = hotel.name, !name.isEmpty {
                Label(name, systemImage: "bed.double")
                    .font(.subheadline.weight(.semibold))
            }
            if let action = hotel.action, !action.isEmpty {
                Text(action.replacingOccurrences(of: "_", with: " "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let rate = hotel.ratePerNight {
                dossierFactRow(app.trm("Tarif par nuit", "Rate per night", "Precio por noche", "Preis pro Nacht", "每晚价格"),
                               SwarmFormat.money(rate, currency: hotel.currency ?? fallbackCurrency))
            }
            if let until = hotel.freeCancellationUntil, !until.isEmpty {
                dossierFactRow(app.trm("Annulation gratuite jusqu'au", "Free cancellation until", "Cancelación gratuita hasta", "Kostenlose Stornierung bis", "免费取消截止"), SwarmFormat.isoToLocalString(until))
            }
        }
    }

    private func dossierActivitySwap(_ swap: SwarmService.PresentationActivitySwap,
                                     fallbackCurrency: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let name = swap.name, !name.isEmpty {
                Label(name, systemImage: "ticket")
                    .font(.subheadline.weight(.semibold))
            }
            HStack(spacing: 10) {
                if let price = swap.priceFrom {
                    dossierFactRow(app.trm("À partir de", "From", "Desde", "Ab", "起价"),
                                   SwarmFormat.money(price, currency: swap.currency ?? fallbackCurrency))
                }
                if let rating = swap.rating {
                    Label(rating.formatted(.number.precision(.fractionLength(1))),
                          systemImage: "star.fill")
                        .font(.footnote)
                        .foregroundStyle(Brand.amber)
                }
            }
        }
    }

    private func dossierFactRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.footnote.weight(.medium)).monospacedDigit()
        }
    }

    // MARK: Money

    private func financialBlock(_ plan: SwarmService.Plan) -> some View {
        let delta = plan.financialDelta
        // Server-composed human ledger lines ("New flight CDG → OPO ·
        // +€150.00") win over the locally-computed itemization when present.
        let ledger = plan.presentation?.ledgerSummary ?? []
        return SwarmSurfaceCard(style: .solid) {
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(app.trm("Récapitulatif financier", "Money summary", "Resumen económico", "Kostenübersicht", "费用汇总"), icon: "creditcard")
                // THE headline number, in the traveller's own currency.
                //
                // The lines below are the truthful per-provider record, and on
                // a real trip they arrive in three currencies at once — a yen
                // refund, a dollar carrier bill, a euro change fee. A traveller
                // shown that had no idea what they were agreeing to, and the
                // replacement flight's price was missing entirely because it
                // sat in a bucket the panel never rendered.
                if let display = delta.display, display.totalNewCharges > 0 || display.totalRefund > 0 {
                    VStack(alignment: .leading, spacing: 6) {
                        if display.totalNewCharges > 0 {
                            financeRow(app.tr("Vous payez", "You pay"),
                                       value: display.totalNewCharges, color: Brand.coral,
                                       signed: true, currency: display.currency)
                        }
                        if display.totalRefund > 0 {
                            financeRow(app.tr("On vous rembourse", "You get back"),
                                       value: display.totalRefund, color: .green,
                                       signed: true, currency: display.currency)
                        }
                        Divider()
                        HStack(spacing: 8) {
                            if let basis = pricingBasisChip(plan) { basis }
                            financeRow(display.netPayable >= 0
                                        ? app.tr("Total à payer", "Total due now")
                                        : app.tr("Total remboursé", "Total back to you"),
                                       value: abs(display.netPayable), color: .primary,
                                       signed: false, bold: true, currency: display.currency)
                        }
                        if display.converted {
                            // Never pass a converted figure off as a quote.
                            Text(app.tr(
                                "Converti en \(display.currency) au taux du jour — le détail ci-dessous est dans la devise de chaque prestataire.",
                                "Converted to \(display.currency) at today's rate — the breakdown below is in each provider's own currency."))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    Divider().padding(.vertical, 2)
                }
                if !ledger.isEmpty {
                    ForEach(ledger, id: \.self) { line in
                        // Bold rule synced to the recomposed ledger (clarity
                        // pass): the per-currency "Total due now: …" totals are
                        // the lines that matter. Old persisted payloads keep
                        // their "net payable" lines bold via the legacy match.
                        let lowered = line.lowercased()
                        let isTotal = lowered.hasPrefix("total due now")
                            || lowered.contains("net payable")
                        Text(line)
                            .font(isTotal ? .subheadline.weight(.bold) : .subheadline)
                            .foregroundStyle(isTotal ? Color.primary : Color.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    if let flight = plan.proposedResolution.newFlight {
                        // The ledger only charges the fare DIFFERENCE against the
                        // original ticket (that's what the totals show) — this
                        // row is the full replacement price for transparency.
                        financeRow(app.trm("Nouveau vol (prix total)", "New flight (full price)", "Nuevo vuelo (precio total)", "Neuer Flug (Gesamtpreis)", "新航班（全价）"), value: flight.cost, color: Brand.coral, signed: true)
                    }
                    if let requote = plan.proposedResolution.transferRequote {
                        // Spatial-conflict transfer re-quote — its amount is part
                        // of total_new_charges, so itemize it to keep the
                        // breakdown summing to "Total new charges".
                        financeRow(app.trm("Transfert re-coté (\(requote.from) → \(requote.to))", "Ride re-quote (\(requote.from) → \(requote.to))", "Traslado recotizado (\(requote.from) → \(requote.to))", "Transfer neu berechnet (\(requote.from) → \(requote.to))", "接送重新报价（\(requote.from) → \(requote.to)）"),
                                   value: requote.amount, color: Brand.coral, signed: true)
                    }
                    if let verdict = plan.proposedResolution.policyVerdict, verdict.changeFee > 0 {
                        financeRow(app.trm("Frais de modification", "Policy change fee", "Tarifa de cambio", "Umbuchungsgebühr", "改签费"), value: verdict.changeFee, color: Brand.coral,
                                   signed: true, currency: verdict.currency ?? plan.currency)
                    }
                    ForEach((plan.proposedResolution.hotelAdjustments ?? []).filter { $0.fee > 0 }, id: \.hotelName) { hotel in
                        financeRow(app.trm("Hôtel — \(hotel.hotelName)", "Hotel — \(hotel.hotelName)", "Hotel — \(hotel.hotelName)", "Hotel — \(hotel.hotelName)", "酒店 — \(hotel.hotelName)"), value: hotel.fee, color: Brand.coral, signed: true)
                    }
                    ForEach(plan.proposedResolution.rescheduledActivities.filter { $0.penalty > 0 }, id: \.name) { activity in
                        financeRow(app.trm("Activité remplacée — \(activity.name)", "Activity swap — \(activity.name)", "Actividad sustituida — \(activity.name)", "Aktivität getauscht — \(activity.name)", "活动替换 — \(activity.name)"), value: activity.penalty, color: Brand.coral, signed: true)
                    }
                    Divider()
                    financeRow(app.trm("Total des nouveaux frais", "Total new charges", "Total de cargos nuevos", "Neue Kosten gesamt", "新增费用合计"), value: delta.totalNewCharges, color: Brand.coral, signed: true)
                    financeRow(app.trm("Total remboursé", "Total refund", "Reembolso total", "Erstattung gesamt", "退款合计"), value: delta.totalRefund, color: .green, signed: true)
                    Divider()
                    financeRow(app.trm("Net à payer", "Net payable", "Neto a pagar", "Netto zu zahlen", "应付净额"), value: delta.netPayable, color: .primary, signed: false, bold: true)
                }
                Text(app.tr(
                    "Les totaux à payer maintenant sont ce qui sera réglé ; les remboursements vous seront restitués.",
                    "Pay-now totals are what you'll pay at settlement; refunds come back to you."))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: Plan carousel (2-phase multi-plan proposal)

    /// Swipeable plan carousel — one dossier per page (`TabView(.page)`,
    /// `dossierCarousel` precedent) with ONE shared Approve & Settle button
    /// underneath, so the "main button + confirm alert button" situation is
    /// unchanged. Each page carries its own badge + TTL countdown.
    private var plansCarouselLayout: some View {
        TabView(selection: $model.selectedPlanIndex) {
            ForEach(Array(model.plans.enumerated()), id: \.offset) { index, pagePlan in
                ScrollView {
                    // Lazy render — only the visible page and its two
                    // neighbours build the full dossier; distant pages
                    // hold their geometry with a clear placeholder.
                    if abs(index - model.selectedPlanIndex) <= 1 {
                        VStack(spacing: 16) {
                            if model.degraded {
                                degradedBadge
                            }
                            approvalBanner
                            if model.plans.count > 1 {
                                Button { comparingPlans = true } label: {
                                    Label(app.tr("Comparer les options", "Compare options"), systemImage: "list.bullet.rectangle")
                                        .font(.subheadline.weight(.semibold))
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 8)
                                }
                                .buttonStyle(.bordered)
                                .disabled(model.approving || model.settlementPending)
                                .accessibilityIdentifier("trustLayer.compare")
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                        .frame(maxWidth: 560)
                        .frame(maxWidth: .infinity)

                        // ONE glass render pass for the whole dossier.
                        //
                        // A plan page stacks ~13 GlassCards, each applying its
                        // own `.glassEffect()` — a live backdrop blur per view.
                        // The carousel keeps the selected page and both
                        // neighbours mounted, so roughly 39 independent glass
                        // effects were compositing at once and the sheet
                        // visibly dropped frames while the rest of the app
                        // stayed smooth. `GlassEffectContainer` exists for
                        // exactly this: the system renders the group in a
                        // single pass instead of one pass per card.
                        // ONE glass pass for the page: the surfaces inside are
                        // siblings in this container, so the system composites
                        // them together instead of once per card.
                        GlassEffectContainer {
                            planPage(pagePlan, index: index)
                        }
                            .padding(.horizontal, 20)
                            .padding(.top, 16)
                            // Room to scroll the end of the plan clear of
                            // the floating actions, which now sit over the
                            // page rather than in a strip beneath it.
                            .padding(.bottom, compactActions ? 32 : actionsHeight + actionsBottomInset + 28)
                            .frame(maxWidth: 560)
                            .frame(maxWidth: .infinity)
                    } else {
                        Color.clear.frame(maxWidth: .infinity)
                            .accessibilityIdentifier("trustLayer.plan.\(index)")
                    }
                }
                .tag(index)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: model.plans.count > 1 ? .always : .never))
        // The backdrop runs edge-to-edge ONLY while the actions float over it.
        // With the actions in the flow (accessibility sizes) the end of the
        // page would otherwise sit under the home indicator, and on the
        // smallest screen the Approve button never became fully tappable.
        .ignoresSafeArea(edges: compactActions ? [] : .bottom)
        // The actions FLOAT over the plan rather than sitting in a reserved
        // strip below it. As a sibling in the stack they took vertical space
        // away from the carousel and clipped the card against their own edge;
        // as an overlay the plan runs the full height and scrolls underneath.
        // No divider, no `.bar` ground — the page shows through.
        .overlay(alignment: .bottom) {
            if !compactActions {
            // A floating glass CARD, inset on every side — not a full-width
            // band welded to the bottom edge. It needs a surface of its own:
            // laid straight over the page the secondary label and the footnote
            // rendered on top of the plan's own text and were unreadable. The
            // material keeps them legible while the plan stays visible,
            // blurred, behind it and scrolls underneath.
            sharedApproveSection
                // Chrome that must fit: the one control floating over the plan
                // is capped so it can never swallow the content it approves.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .padding(.horizontal, 16)
                .padding(.vertical, compactActions ? 12 : 16)
                // Liquid Glass, like every other floating control in the app.
                // A flat 0.97 fill was tried here and was WORSE: the plan
                // scrolling underneath stayed readable through the footnote.
                // Glass blurs what passes behind it, so the text stays legible
                // while the page still shows through. ONE surface, not a stack.
                .glassEffect(.regular, in: .rect(cornerRadius: 28))
                .onGeometryChange(for: ActionsMetrics.self) {
                    ActionsMetrics(height: $0.size.height, bottomInset: $0.safeAreaInsets.bottom)
                } action: { metrics in
                    // Only react to real changes (Dynamic Type, an error line
                    // appearing) — never a per-frame layout feedback loop.
                    if abs(metrics.height - actionsHeight) > 1 { actionsHeight = metrics.height }
                    if abs(metrics.bottomInset - actionsBottomInset) > 1 { actionsBottomInset = metrics.bottomInset }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("trustLayer.actions")
                .padding(.horizontal, 16)
                // The TabView ignores the bottom safe area so the backdrop
                // runs edge-to-edge — inset the CARD itself by the MEASURED
                // home-indicator inset (a flat 12 pt left it sitting on the
                // indicator on every device that has one).
                .padding(.bottom, actionsBottomInset + 12)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
        }
    }

    /// A vertical overview makes every alternative reachable without swiping.
    private var planComparison: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    ForEach(Array(model.plans.enumerated()), id: \.offset) { index, option in
                        comparisonOption(option, index: index)
                    }
                }
                .padding(20)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle(app.tr("Comparer les options", "Compare options"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(app.tr("Terminé", "Done")) { comparingPlans = false }
                }
            }
        }
    }

    private func comparisonOption(_ option: SwarmService.Plan, index: Int) -> some View {
        let selected = index == model.selectedPlanIndex
        let amount = dueNow(option)
        let dropped = option.proposedResolution.rescheduledActivities.filter { $0.action == "drop" }.count
        return Button {
            model.selectedPlanIndex = index
            comparingPlans = false
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(app.tr("Option", "Option")) \(index + 1)")
                        .font(.headline)
                    Spacer()
                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Brand.indigo)
                    }
                }
                // The trade-off itself — cheapest / earliest / non-stop — is
                // what a comparison is FOR; without it only price was compared.
                let badges = option.badges ?? [option.badge].compactMap { $0 }
                if !badges.isEmpty {
                    badgeRow(badges, index: index, identifier: "trustLayer.compare.badges.\(index)")
                }
                Text(replacementHeadline(option))
                    .font(.subheadline.weight(.semibold))
                if let detail = replacementDetail(option), !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Text("\(amount.title) · \(amount.amount)")
                        .font(.subheadline.weight(.bold)).monospacedDigit()
                    if let basis = pricingBasisChip(option) { basis }
                }
                if let impact = option.presentation?.tripImpact, !impact.summary.isEmpty {
                    Text(impact.summary)
                        .font(.footnote)
                        .foregroundStyle(Brand.coral)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if dropped > 0 {
                    Text("\(app.tr("Activités retirées", "Activities removed")): \(dropped)")
                        .font(.footnote).foregroundStyle(.orange)
                }
                Text(selected ? app.tr("Option sélectionnée", "Selected option")
                     : app.tr("Examiner cette option", "Review this option"))
                    .font(.caption.weight(.semibold)).foregroundStyle(Brand.indigo)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Brand.indigo.opacity(selected ? 0.10 : 0.04), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Brand.indigo.opacity(selected ? 0.6 : 0.15)))
        }
        .buttonStyle(.plain)
        .disabled(model.approving || model.settlementPending)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("trustLayer.option.\(index)")
    }

    /// One carousel page — the full dossier blocks reused from the classic
    /// single-plan render, topped by the badge capsule and followed by the
    /// per-plan TTL countdown. Each page is wrapped in the iridescent
    /// "Deep Agentic Thinking" border so the proposal reads as one living
    /// artifact (30 fps-capped, static under Reduce Motion).
    /// A page is ONE decision — "do I accept this plan?" — so it leads with the
    /// answer and files the evidence behind it.
    ///
    /// It used to be eight sibling glass cards (badges, glance, incident,
    /// policy, resolution, dossier, finance, TTL) stacked at identical visual
    /// weight, so the two facts that actually decide it — what you end up with
    /// and what you pay — carried no more emphasis than the restated incident
    /// or the raw policy verdict, and the traveller had to read the whole
    /// stack to find them. Now: the change and the price ARE the page, and
    /// everything that justifies them sits one tap away.
    private func planPage(_ pagePlan: SwarmService.Plan, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            // Multi-badge row (clarity pass): one capsule per badge from the
            // additive `badges` set; old payloads fall back to `[badge]`.
            let badges = pagePlan.badges ?? [pagePlan.badge].compactMap { $0 }
            if !badges.isEmpty {
                badgeRow(badges, index: index)
            }

            // The decision header carries the comparison facts the glance chip
            // row used to hold (schedule, duration, stops, what's due), so the
            // chips now repeat the two lines directly above them — and the row
            // clipped its last chip doing it.
            decisionHeader(pagePlan)

            // No replacement flight, and WHY — the most important thing on the
            // screen when it applies, because it is the only case where the
            // traveller has to go and do something themselves.
            //
            // Only `partner_coverage` says that. The server proves the partner
            // answered on several distinct dates with nothing before it will
            // use that wording; a pricing failure or our own rebooking horizon
            // gets different copy and a different colour, because "wait and
            // retry" and "book it yourself" are opposite instructions.
            if let why = pagePlan.presentation?.noFlightReason, !why.summary.isEmpty {
                SwarmSurfaceCard {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: why.isPartnerCoverage
                              ? "airplane.circle" : "clock.arrow.circlepath")
                            .font(.title3)
                            .foregroundStyle(why.isPartnerCoverage ? Brand.coral : .orange)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(why.isPartnerCoverage
                                 ? app.tr("À réserver vous-même", "You'll need to book this one")
                                 : app.tr("Pas de vol de remplacement", "No replacement flight"))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(why.summary)
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }

            // What this plan COSTS the rest of the trip — directly under the
            // headline, above the money.
            //
            // The traveller who reported this saw a plan that quietly moved
            // them five days later, and nothing on the screen said the days in
            // between were gone. The money panel answers "what do I pay"; this
            // is the other half of the decision, and for a late rebooking it is
            // usually the half that matters more.
            if let impact = pagePlan.presentation?.tripImpact, !impact.summary.isEmpty {
                SwarmSurfaceCard {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "calendar.badge.exclamationmark")
                            .font(.title3)
                            .foregroundStyle(Brand.coral)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(app.tr("Ce que ça coûte au voyage", "What this costs your trip"))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(impact.summary)
                                .font(.subheadline.weight(.medium))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }

            // Exactly what approving will write, produced server-side by the
            // settlement itself. Shown open, above the money: nothing on the
            // trip may change that was not on this screen first.
            if let preview = pagePlan.presentation?.settlementPreview {
                settlementPreviewCard(preview)
            }

            // Evidence, in the order a sceptic asks for it: what exactly
            // changes, then the arithmetic, then why the swarm chose this.
            VStack(spacing: 8) {
                detailGroup(key: "changes",
                            app.trm("Ce qui change", "What changes", "Qué cambia", "Was sich ändert", "有哪些变化"),
                            icon: "arrow.triangle.swap") {
                    beforeAfterBlock(pagePlan)
                    resolutionBlock(pagePlan)
                    if hasDossier(pagePlan) {
                        newPlanDossier(pagePlan)
                    }
                }
                detailGroup(key: "money",
                            app.trm("L'argent", "The money", "El dinero", "Das Geld", "费用明细"),
                            icon: "eurosign.circle") {
                    financialBlock(pagePlan)
                }
                detailGroup(key: "why",
                            app.trm("Pourquoi ce plan", "Why this plan", "Por qué este plan",
                                    "Warum dieser Plan", "为什么是这个方案"),
                            icon: "questionmark.circle") {
                    incidentBlock(pagePlan)
                    if let verdict = pagePlan.proposedResolution.policyVerdict {
                        policyBlock(verdict)
                    }
                }
            }

            ttlRow(pagePlan)
            inlineActions
        }
        .padding(14)
        // Bottom clearance so the page-control dots (shown for multi-plan
        // carousels) never overlap the card border.
        .padding(.bottom, model.plans.count > 1 ? 28 : 14)
        // Same container hazard as the quiz card: an identifier on a CONTAINER
        // propagates to every descendant, which stamped "trustLayer.plan.N"
        // over `trustLayer.badge.N` and `trustLayer.ttl` nested inside and
        // made both unreachable. `.contain` keeps this an enclosing element
        // and leaves the children their own identifiers.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trustLayer.plan.\(index)")
    }

    /// Badge capsule row for a carousel page — maps the contract's
    /// "cheapest" | "fastest" | "balanced" onto emoji + localized label,
    /// one capsule per badge. The frozen `trustLayer.badge.<index>` id sits
    /// on the CONTAINER FlowLayout (once per page, multi-capsule safe).
    /// Contrast (R2): SOLID tint fill with a contrast-checked text color —
    /// amber reads black, sky/violet/indigo read white.
    /// Defensive de-dup: `ForEach(id: \.self)` crashes on duplicate
    /// identities, so a hand-injected session payload with repeated badges
    /// is rendered as an order-preserving unique copy.
    // MARK: The decision

    /// The whole plan in two sentences: what you end up with, and what it
    /// costs. Everything else on the page is evidence for these two lines.
    private func decisionHeader(_ pagePlan: SwarmService.Plan) -> some View {
        let flight = pagePlan.proposedResolution.newFlight
        return VStack(alignment: .leading, spacing: 10) {
            if let flight {
                // What you end up with. Carrier + number + route is how a
                // traveller identifies a flight; the schedule sits under it.
                Text(flightHeadline(flight))
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let schedule = flightScheduleLine(flight) {
                    Text(schedule)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            } else {
                // Non-flight missions (weather swap, hotel, activity) still
                // owe the traveller a one-line answer.
                Text(pagePlan.incident)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider().opacity(0.4)

            // What it costs. Read from the per-currency buckets, never from
            // the legacy scalar — see `dueNow`.
            let due = dueNow(pagePlan)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(due.title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if let basis = pricingBasisChip(pagePlan) {
                    basis
                }
                Text(due.amount)
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(due.isCharge
                                     ? AnyShapeStyle(Brand.coral)
                                     : AnyShapeStyle(Color.green))
            }
            if pagePlan.proposedResolution.newFlight?.isIndicativeEstimate == true {
                Text(app.trm(
                    "Estimation : aucun prestataire n’a proposé ce vol. Il ne sera pas réservé — vous devrez le réserver auprès de la compagnie.",
                    "Estimate: no provider offered this flight. It will not be booked — you will need to book it with the airline.",
                    "Estimación: ningún proveedor ofreció este vuelo. No se reservará; tendrás que reservarlo con la aerolínea.",
                    "Schätzung: Kein Anbieter hat diesen Flug angeboten. Er wird nicht gebucht – du musst ihn bei der Airline buchen.",
                    "估算：没有供应商提供此航班，系统不会预订，需自行向航空公司预订。"))
                    .font(.caption)
                    .foregroundStyle(Brand.amber)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("trustLayer.estimateNote")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trustLayer.decision")
    }

    /// "Vueling VY6651 · London → Lisbon" — falls back through whatever the
    /// provider actually described rather than printing empty separators.
    private func flightHeadline(_ flight: SwarmService.NewFlight) -> String {
        let name = [flight.airline, flight.flightNumber ?? flight.id]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let route = [flight.from, flight.to]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " → ")
        if name.isEmpty { return route.isEmpty ? "New flight" : route }
        return route.isEmpty ? name : "\(name) · \(route)"
    }

    /// "15 Sep · 09:55 – 20:35 · 10h40 · 1 stop via BCN" — the same wall-clock
    /// reading the timeline uses, so one flight never carries two times.
    private func flightScheduleLine(_ flight: SwarmService.NewFlight) -> String? {
        var parts: [String] = []
        let range = flight.wallClockRange
        if !range.isEmpty { parts.append(range) }
        if let minutes = flight.effectiveDurationMinutes, minutes > 0 {
            parts.append(SwarmFormat.durationLabel(minutes: minutes))
        }
        if let stops = flight.stopsLabel { parts.append(stops) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What the traveller owes (or gets back) RIGHT NOW, derived from the
    /// per-currency buckets.
    ///
    /// The legacy `financial_delta.net_payable` scalar is only the LEDGER
    /// currency's bucket. On a Japan trip rebooked onto a USD fare with a EUR
    /// change fee, the JPY bucket holds nothing — so the scalar read 0 and the
    /// header announced "Nothing to pay · JP¥0" directly above a breakdown
    /// charging $454.55 and €25.00. Currencies are listed side by side and
    /// never summed or converted into one another.
    private func dueNow(_ pagePlan: SwarmService.Plan) -> (title: String, amount: String, isCharge: Bool) {
        let buckets = pagePlan.financialDelta.byCurrency
        let payable = buckets.filter { $0.netPayable > 0 }
        let refunded = buckets.filter { $0.netPayable < 0 }

        if !payable.isEmpty {
            return (app.tr("Vous payez maintenant", "You pay now"),
                    payable.map { SwarmFormat.money($0.netPayable, currency: $0.currency) }
                        .joined(separator: " + "),
                    true)
        }
        if !refunded.isEmpty {
            return (app.tr("Vous êtes remboursé", "You get back"),
                    refunded.map { SwarmFormat.money(abs($0.netPayable), currency: $0.currency) }
                        .joined(separator: " + "),
                    false)
        }
        // No buckets at all — legacy single-currency payloads.
        let net = pagePlan.financialDelta.netPayable
        if net > 0 {
            return (app.tr("Vous payez maintenant", "You pay now"),
                    SwarmFormat.money(net, currency: pagePlan.currency), true)
        }
        if net < 0 {
            return (app.tr("Vous êtes remboursé", "You get back"),
                    SwarmFormat.money(abs(net), currency: pagePlan.currency), false)
        }
        return (app.tr("Rien à payer", "Nothing to pay"),
                SwarmFormat.money(0, currency: pagePlan.currency), false)
    }

    /// One collapsible evidence section. Collapsed by default: it exists to be
    /// available, not to be read — a traveller who trusts the headline should
    /// never have to scroll past it to reach Approve.
    /// `key` is the stable identity used by `expandedGroups` (never shown);
    /// `title` is what the traveller reads. They were the same English string,
    /// which is why these three headers stayed English in every locale.
    private func detailGroup<Content: View>(key: String,
                                            _ title: String,
                                            icon: String,
                                            @ViewBuilder content: () -> Content) -> some View {
        // Built eagerly: DisclosureGroup's content closure escapes, and these
        // are plain value-type view trees — SwiftUI still defers the actual
        // rendering until the group is expanded.
        let body = content()
        let isExpanded = Binding(
            get: { expandedGroups.contains(key) },
            set: { open in
                if open { expandedGroups.insert(key) } else { expandedGroups.remove(key) }
            }
        )
        return DisclosureGroup(isExpanded: isExpanded) {
            VStack(alignment: .leading, spacing: 12) {
                body
            }
            .padding(.top, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label(title, systemImage: icon)
                .font(.subheadline.weight(.semibold))
        }
        .tint(.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.white.opacity(0.05), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
    }

    private func badgeRow(_ badges: [String], index: Int, identifier: String? = nil) -> some View {
        let uniqueBadges = badges.reduce(into: [String]()) { acc, badge in
            if !acc.contains(badge) { acc.append(badge) }
        }
        return FlowLayout(spacing: 8, lineSpacing: 6) {
            ForEach(uniqueBadges, id: \.self) { badge in
                badgeCapsule(badge)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier ?? "trustLayer.badge.\(index)")
    }

    /// Translucent tinted capsule, matching the glass surfaces everywhere
    /// else in the app. The solid fill read as a foreign, flat sticker on a
    /// sheet made entirely of translucent material.
    private func badgeCapsule(_ badge: String) -> some View {
        let info = badgeInfo(badge)
        return Text("\(info.emoji) \(info.label)")
            .font(.caption.weight(.bold))
            .textCase(.uppercase)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(info.tint.opacity(0.18), in: Capsule())
            .overlay(Capsule().strokeBorder(info.tint.opacity(0.45), lineWidth: 1))
            .foregroundStyle(info.tint)
    }

    private func badgeInfo(_ badge: String) -> (emoji: String, label: String, tint: Color) {
        switch badge {
        case "cheapest": return ("💰", app.tr("Le moins cher", "Cheapest"), Brand.amber)
        case "fastest": return ("⚡️", app.tr("Arrivée au plus tôt", "Earliest arrival"), Brand.sky)
        case "balanced": return ("⚖️", app.tr("Équilibré", "Balanced"), Brand.violet)
        case "same_day": return ("📅", app.tr("Même jour", "Same day"), Brand.indigo)
        case "next_day": return ("🌙", app.tr("Lendemain", "Next day"), Brand.indigo)
        case "nonstop": return ("✈️", app.tr("Direct", "Nonstop"), Brand.indigo)
        default: return ("✨", badge.replacingOccurrences(of: "_", with: " ").capitalized, Brand.indigo)
        }
    }

    /// Per-plan TTL countdown — rendered by `TTLBadgeView`, the ONLY view in
    /// this sheet that re-renders every second.
    @ViewBuilder
    private func ttlRow(_ pagePlan: SwarmService.Plan) -> some View {
        if let expiresAt = pagePlan.expiresAt {
            TTLBadgeView(expiresAt: expiresAt)
        }
    }

    /// ONE settlement section shared by every carousel page — settles
    /// whatever page is selected (`model.selectedPlanIndex` → `planIndex`).
    /// At accessibility text sizes the floating card grew to ~45% of the
    /// screen and covered the flight and price being approved. There, only a
    /// size-capped Approve button floats; everything else scrolls with the plan.
    private var compactActions: Bool { dynamicTypeSize.isAccessibilitySize }

    /// At accessibility text sizes the actions are part of the page, not a
    /// card floating over it.
    ///
    /// A floating card cannot avoid covering content once the decision header
    /// is ~800 pt tall: measured at AX3 on iPhone 17, 17 Pro Max and 17e, it
    /// sat on top of the flight and the price being approved. In the flow
    /// nothing can ever be hidden behind it, on any device.
    @ViewBuilder
    private var inlineActions: some View {
        if compactActions {
            sharedApproveSection
                .padding(.top, 8)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("trustLayer.actions")
        }
    }

    private var sharedApproveSection: some View {
        VStack(spacing: 10) {
            if let approveError = model.approveError {
                Text(approveError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if model.degraded {
                // Degraded proposals can't be booked (approve 409s) — the fix
                // is a one-tap re-run through the existing launch flow.
                Button {
                    Task { await model.rerunMission() }
                } label: {
                    Label(model.isProcessing
                          ? app.tr("Relance en cours…", "Re-running…")
                          : app.tr("Relancer la mission", "Re-run mission"),
                          systemImage: "arrow.clockwise")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(Brand.indigo)
                .disabled(model.isProcessing)
            }
            // Expiry arrives as ONE state change at the deadline (see
            // `expiryTick`), not as a per-second rebuild of this button.
            approveButton(isExpired: selectedPlanExpired)
            declineButton
            confirmFootnote
        }
    }

    /// Saying NO to a proposal.
    ///
    /// The proposal state offered exactly one action — Approve & Settle. The
    /// only way out was "Later", which defers rather than decides: the mission
    /// stays open and the plan comes back. A traveller who has read the plan
    /// and does not want it needs to be able to say so, and the swarm needs to
    /// release the session rather than hold a quote nobody intends to take.
    private var declineButton: some View {
        Button {
            Haptics.tap()
            model.cancelMission()
            dismiss()
        } label: {
            Text(app.tr("Refuser ce plan", "Decline this plan"))
                .font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("trustLayer.decline")
        .disabled(model.approving || model.settlementPending)
    }

    /// The settlement footnote under the initial CTA (kept out of the
    /// confirm state, which carries its own message text).
    private var confirmFootnote: some View {
        Text(isFlightRehearsal
             ? app.trm("Vols en mode test : aucun billet réel n'est émis. Votre itinéraire peut être modifié.",
                       "Flight booking rehearsal: no real ticket is issued. Your itinerary can still be updated.",
                       "Reserva de vuelos de prueba: no se emite un billete real. Tu itinerario puede actualizarse.",
                       "Flugbuchung im Testmodus: Es wird kein echtes Ticket ausgestellt. Dein Reiseplan kann aktualisiert werden.",
                       "航班预订演练：不会签发真实机票，但仍可能更新行程。")
             : app.trm("Votre approbation applique ce plan. Le résultat précise les réservations confirmées par les prestataires.",
                       "Approval applies this plan. The result identifies which bookings the providers confirmed.",
                       "La aprobación aplica este plan. El resultado indica qué reservas confirmaron los proveedores.",
                       "Deine Zustimmung wendet diesen Plan an. Das Ergebnis zeigt, welche Buchungen die Anbieter bestätigt haben.",
                       "批准后将应用此方案。结果会注明供应商确认了哪些预订。"))
            .font(.caption2)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .accessibilityIdentifier("trustLayer.bookingEnvironment")
    }

    /// Centered settlement confirmation popup — shown as an overlay on the
    /// sheet root while `confirming`: (1) a dimmed backdrop (tap to dismiss),
    /// (2) the settle question as the headline with a short payment
    /// explanation, (3) a full `Brand.gradient` "Allow payment" capsule
    /// (carries `trustLayer.approveConfirm` — deliberately NOT `.glassEffect`
    /// on the tappable capsule: iOS 26 glass can cause silent tap no-ops in
    /// XCUITest), (4) a secondary bordered "Cancel" capsule back to the
    /// proposal. Entry/exit transitions honor Reduce Motion.
    private var settleConfirmPopup: some View {
        ZStack {
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture {
                    if !model.approving { confirming = false }
                }
                // VoiceOver dismiss path — the card is `.isModal`, so focus
                // stays inside the popup; this gives an explicit escape.
                .accessibilityAction(named: "Dismiss") {
                    if !model.approving { confirming = false }
                }
                .transition(.opacity)

            // Same event-driven expiry as the main CTA: the capsule disables
            // the moment the quote dies, without a per-second rebuild.
            popupCard(planExpired: selectedPlanExpired || model.selectedPlan == nil)
            // Sit slightly below dead-center — feels anchored to the sheet's
            // action area rather than floating mid-screen.
            .offset(y: 60)
            .transition(reduceMotion
                        ? .opacity
                        : .scale(scale: 0.88).combined(with: .opacity))
        }
    }

    /// The centered settlement card. `planExpired` is injected by the
    /// surrounding `TimelineView` so the disabled state and the tap-time
    /// guard agree on the same tick. The tappable capsule is deliberately
    /// plain `Brand.gradient` — NOT `.glassEffect`: iOS 26 glass can cause
    /// silent tap no-ops in XCUITest.
    private func popupCard(planExpired: Bool) -> some View {
        SwarmSurfaceCard {
            VStack(spacing: 14) {
                Image(systemName: "creditcard.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(Brand.gradient)
                Text(settleDialogTitle)
                    .font(.headline.weight(.semibold))
                    .multilineTextAlignment(.center)
                confirmFootnote
                Button {
                    // Re-checked live at tap time: the quote may have died
                    // between the last render and this tap.
                    guard !(model.approving || model.degraded || model.phase != .awaitingApproval
                            || planExpired || selectedPlanExpired) else { return }
                    confirming = false
                    Task { await model.approve() }
                } label: {
                    Group {
                        if model.approving {
                            ProgressView().tint(.white)
                        } else {
                            Label(app.trm("Confirmer et appliquer", "Confirm & apply", "Confirmar y aplicar", "Bestätigen und anwenden", "确认并应用"),
                                  systemImage: "checkmark.seal")
                        }
                    }
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Capsule().fill(Brand.gradient))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("trustLayer.approveConfirm")
                .disabled(model.approving || model.degraded || model.phase != .awaitingApproval || planExpired)
                Button {
                    confirming = false
                } label: {
                    Text(app.tr("Annuler", "Cancel"))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35)))
                }
                .buttonStyle(.plain)
                .disabled(model.approving)
            }
            .padding(24)
        }
        .frame(maxWidth: 360)
        .padding(.horizontal, 32)
        // Focus trap: VoiceOver treats the card as a modal container so
        // interaction stays inside the popup while it is up.
        .accessibilityAddTraits(.isModal)
    }

    /// The settlement button, extracted so it can live inside the TTL
    /// TimelineView (expiry-gated) or stand alone when `expiresAt` is nil.
    /// Brand-gradient capsule (NexusSwarmView send-button idiom) instead of
    /// `.borderedProminent` so the CTA reads as the primary action.
    private func approveButton(isExpired: Bool) -> some View {
        Button {
            if model.settlementPending {
                Task { await model.refreshSettlementStatus() }
            } else {
                confirming = true
            }
        } label: {
            Group {
                if model.approving {
                    ProgressView().tint(.white)
                } else {
                    Label(model.settlementPending
                          ? app.tr("Vérifier le statut", "Check booking status")
                          : app.tr("Valider et appliquer", "Approve & apply"),
                          systemImage: model.settlementPending ? "arrow.clockwise" : "checkmark.seal")
                }
            }
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Capsule().fill(Brand.gradient))
        }
        .buttonStyle(.plain)
        // Disabled affordance — mirrors the send-button dim idiom.
        .opacity(!model.settlementPending && (isExpired || model.degraded) ? 0.4 : 1)
        .accessibilityIdentifier("trustLayer.approve")
        // Degraded (simulated) plans are never approvable — the server 409s.
        .disabled(model.approving || (!model.settlementPending && (model.degraded || model.phase != .awaitingApproval || isExpired)))
    }

    /// One-shot settlement reveal: the seal springs in exactly once
    /// (immediate under Reduce Motion). The success haptic already fired in
    /// `SwarmViewModel.approve()` at the moment settlement landed.
    private var settlementNeedsFollowUp: Bool {
        guard let receipt = model.lastSettlement else { return true }
        return receipt.needsFollowUp || receipt.conflictSkipped || !receipt.tripUpdated
            || (plan?.proposedResolution.newFlight != nil &&
                (!receipt.bookingRecorded || model.booking?.status != "confirmed"))
    }

    private var settledBlock: some View {
        SwarmSurfaceCard {
            VStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(Brand.gradient)
                    .scaleEffect(sealRevealed ? 1 : 0.4)
                    .opacity(sealRevealed ? 1 : 0)
                Text(!model.settlementFollowUps.isEmpty
                     ? app.trm("Appliqué — il vous reste \(model.settlementFollowUps.count) chose(s) à faire",
                               "Applied — \(model.settlementFollowUps.count) thing(s) left for you",
                               "Aplicado — te queda(n) \(model.settlementFollowUps.count) cosa(s) por hacer",
                               "Angewendet – \(model.settlementFollowUps.count) Punkt(e) für dich offen",
                               "已应用 — 还有 \(model.settlementFollowUps.count) 项需要你处理")
                     : settlementNeedsFollowUp
                     ? app.tr("Vérification nécessaire", "Follow-up needed")
                     : app.tr("Approuvé et appliqué", "Approved & applied"))
                    .multilineTextAlignment(.center)
                    .font(.title3.weight(.bold))
                if let code = model.booking?.confirmationCode {
                    // A code is a CARRIER confirmation only when a provider
                    // actually booked (`booking_recorded`). Otherwise — no
                    // provider configured, the booking call failed, or the
                    // disruption was never a flight — the server returns its own
                    // `swarm_settlement` record, and labelling that
                    // "Confirmation code" invents an airline booking the
                    // traveler does not have.
                    let carrierBooked = model.lastSettlement?.bookingRecorded == true
                    Text(carrierBooked && isFlightRehearsal
                         ? app.trm("Référence de réservation test", "Test booking reference", "Referencia de reserva de prueba", "Testbuchungsreferenz", "测试预订编号")
                         : carrierBooked
                         ? app.tr("Code de confirmation", "Confirmation code")
                         : app.tr("Référence de règlement du swarm", "Swarm settlement reference"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(code)
                        .font(.title2.weight(.heavy).monospaced())
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Brand.indigo.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    if !carrierBooked {
                        Text(app.tr(
                            "Aucune confirmation du fournisseur n’est disponible ici. Vérifiez la réservation avant d’en effectuer une autre.",
                            "No provider confirmation is available here. Check the booking outcome before making another reservation."))
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .multilineTextAlignment(.center)
                    }
                }
                if let line = settledFlightLine {
                    Text(line)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let plan = model.plan {
                    Text(plan.incident)
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                // Honesty rail (clarity pass, R6): when the server skipped
                // the itinerary rewrite (rev conflict) or reported the trip
                // untouched with a note, surface the note instead of letting
                // the seal imply a full timeline update.
                if !model.settlementFollowUps.isEmpty {
                    // Itemized, so the traveller knows exactly what is left —
                    // and, by omission, that everything else is done.
                    followUpList(model.settlementFollowUps)
                } else if let settlement = model.lastSettlement,
                   settlement.needsFollowUp || settlement.conflictSkipped || !settlement.tripUpdated {
                    Text(settlementHonestyNote(settlement))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Button(app.tr("Terminé", "Done")) { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .tint(Brand.indigo)
            }
            .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("trustLayer.settled")
        .onAppear {
            guard !sealRevealed else { return }
            if reduceMotion {
                sealRevealed = true
            } else {
                withAnimation(.spring(response: 0.45, dampingFraction: 0.62).delay(0.08)) {
                    sealRevealed = true
                }
            }
        }
    }

    /// The server's settlement note when present; a localized fallback when
    /// the rewrite was skipped without one.
    private func settlementHonestyNote(_ settlement: SwarmService.Settlement) -> String {
        if let note = settlement.note, !note.trimmingCharacters(in: .whitespaces).isEmpty {
            return note
        }
        return app.tr(
            "Le règlement a été enregistré, mais votre itinéraire n'a pas pu être mis à jour automatiquement. Rechargez le voyage pour voir la dernière version.",
            "The settlement was recorded, but your itinerary couldn't be updated automatically. Reload the trip to see the latest version.")
    }

    /// Human recap line for the settled block — airline + flight number +
    /// route from the approved plan's enrichment. NEVER dumps the raw flight
    /// id when it's an opaque blob (> 12 chars ⇒ base64-style payload key,
    /// not a booking reference).
    private var settledFlightLine: String? {
        let flight = model.plan?.proposedResolution.newFlight
        var parts: [String] = []
        if let flight {
            var head: [String] = []
            let hasAirline = flight.airline.map { !$0.isEmpty } ?? false
            if let airline = flight.airline, hasAirline { head.append(airline) }
            if let number = flight.flightNumber, !number.isEmpty {
                // The airline name already conveys the carrier ⇒ strip a
                // leading 2-char IATA prefix from the flight number
                // ("VY8243" → "8243" ⇒ "Vueling 8243"). The raw number is
                // kept when the airline is absent.
                let isCarrierChar: (Character) -> Bool = { $0.isUppercase || $0.isNumber }
                if hasAirline, number.count > 2, number.prefix(2).allSatisfy(isCarrierChar) {
                    head.append(String(number.dropFirst(2)))
                } else {
                    head.append(number)
                }
            }
            if !head.isEmpty { parts.append(head.joined(separator: " ")) }
            if let from = flight.from, let to = flight.to, !from.isEmpty, !to.isEmpty {
                parts.append("\(from) → \(to)")
            }
        }
        if parts.isEmpty, let flight {
            // `displayLabel` only when the id is a sane reference, otherwise
            // the bare human label (never a multi-KB base64 blob).
            parts.append(flight.id.count <= 12 ? flight.displayLabel : "New flight")
        }
        if parts.isEmpty, let flightId = model.booking?.flightId, flightId.count <= 12 {
            parts.append("Flight \(flightId)")
        }
        guard !parts.isEmpty else { return nil }
        var line = parts.joined(separator: " · ")
        if let status = model.booking?.status, !status.isEmpty { line += " · \(status)" }
        return line
    }

    private var emptyBlock: some View {
        SwarmSurfaceCard {
            VStack(spacing: 10) {
                Image(systemName: "tray")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text(app.tr("Aucune proposition à examiner pour l'instant.", "No proposal to review yet."))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var processingBlock: some View {
        SwarmSurfaceCard {
            VStack(spacing: 16) {
                ProgressView()
                    .controlSize(.large)
                    .tint(Brand.indigo)
                
                if let last = model.trace.last {
                    Text(friendlyAgentMessage(for: last.agent))
                        .font(.headline)
                        .foregroundStyle(Brand.indigo)
                        .multilineTextAlignment(.center)
                        .animation(.easeInOut, value: last.agent)
                } else {
                    Text(app.tr("Coordination des agents…", "Orchestrating agents…"))
                        .font(.headline)
                        .foregroundStyle(Brand.indigo)
                }
                
                Text(app.tr("Interrogation des fournisseurs et recherche des meilleures options.", "Negotiating providers and finding the best alternatives."))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                cancelMissionButton(identifier: "trustLayer.cancelMission.2")
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
    }

    /// 2-phase flow, step 2 — resolve acknowledged, the plans are being
    /// composed server-side (async rail while `pollStatus()` runs).
    private var resolvingBlock: some View {
        SwarmSurfaceCard {
            VStack(spacing: 16) {
                ProgressView()
                    .controlSize(.large)
                    .tint(Brand.indigo)

                Text(app.tr("Préparation de vos options…", "Building your options..."))
                    .font(.headline)
                    .foregroundStyle(Brand.indigo)

                Text(app.tr("L'essaim compose des plans de reprise adaptés à vos réponses.",
                            "The swarm is composing recovery plans tailored to your answers."))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                // Typing-dots cadence (CopilotChatSheet precedent) while the
                // async rail composes the plans server-side.
                SwarmTypingDots()

                cancelMissionButton(identifier: "trustLayer.cancelMission.3")
            }
            .padding()
            .frame(maxWidth: .infinity)
        }
    }

    /// "Cancel mission" affordance inside the Trust Layer status blocks —
    /// best-effort server-side abandon + reset back to monitoring, then the
    /// sheet dismisses so the user isn't left staring at an empty block.
    private func cancelMissionButton(identifier: String) -> some View {
        Button {
            Haptics.tap()
            model.cancelMission()
            dismiss()
        } label: {
            Label(app.tr("Annuler la mission", "Cancel mission"),
                  systemImage: "xmark.circle")
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.bordered)
        .tint(Brand.coral)
        .accessibilityIdentifier(identifier)
    }

    // MARK: Helpers

    private func friendlyAgentMessage(for agent: String) -> String {
        switch agent {
        case "orchestrator":
            return app.trm("Analyse de la perturbation…", "Analyzing disruption…", "Analizando la interrupción…",
                           "Störung wird analysiert…", "正在分析中断…")
        case "flight":
            return app.trm("Contact des compagnies…", "Contacting airlines…", "Contactando con aerolíneas…",
                           "Airlines werden kontaktiert…", "正在联系航空公司…")
        case "hotel":
            return app.trm("Sécurisation de l'hébergement…", "Securing hotel accommodations…",
                           "Asegurando el alojamiento…", "Unterkunft wird gesichert…", "正在确认住宿…")
        case "activity":
            return app.trm("Replanification des activités…", "Rescheduling activities…",
                           "Reprogramando actividades…", "Aktivitäten werden umgeplant…", "正在重新安排活动…")
        case "policy":
            return app.trm("Vérification des règles tarifaires…", "Verifying fare rules…",
                           "Verificando las reglas tarifarias…", "Tarifregeln werden geprüft…", "正在核对票价规则…")
        case "trust_layer":
            return app.trm("Finalisation du plan…", "Finalizing resolution plan…", "Finalizando el plan…",
                           "Plan wird finalisiert…", "正在完成方案…")
        default:
            return app.trm("Comparaison des itinéraires…", "Comparing alternate routes…",
                           "Comparando rutas alternativas…", "Alternativen werden verglichen…", "正在比较备选路线…")
    }
    }

    private func sectionHeader(_ title: String, icon: String) -> some View {
        Label(title, systemImage: icon)
            .font(.caption.weight(.semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
    }

    /// `currency` overrides the plan currency for a line quoted in its own
    /// money — a fare rule's change fee is in the RULE's currency, so a
    /// 25 EUR fee on a JPY trip must not print as ¥25.
    private func financeRow(_ title: String, value: Double, color: Color,
                            signed: Bool, bold: Bool = false,
                            currency: String? = nil) -> some View {
        HStack {
            Text(title)
                .font(bold ? .subheadline.weight(.bold) : .subheadline)
            Spacer()
            Text((signed && value > 0 ? "+" : "")
                 + SwarmFormat.money(value, currency: currency ?? plan?.currency))
                .font(bold ? .subheadline.weight(.bold) : .subheadline)
                .foregroundStyle(color)
                .monospacedDigit()
        }
    }

    /// All plan amounts are already in the trip currency — delegate to
    /// `SwarmFormat` with `plan.currency` (absent ⇒ legacy bare numbers).
    private func money(_ value: Double) -> String {
        SwarmFormat.money(value, currency: plan?.currency)
    }
}

// MARK: - Change-map shared helpers (live map + static thumbnail)

/// Old airport = muted + struck through, new airport = green, hotel =
/// violet, activity = indigo. Shared by `SwarmChangeMap` (live) and
/// `SwarmMapThumbnail` (static snapshot pins).
fileprivate func swarmMapPinStyle(for kind: String) -> (color: Color, symbol: String) {
    switch kind {
    case "airport_origin": return (.gray, "airplane")
    case "airport_new": return (.green, "airplane.arrival")
    case "hotel": return (Brand.violet, "bed.double")
    default: return (Brand.indigo, "ticket")
    }
}

@ViewBuilder
fileprivate func swarmMapPin(for point: SwarmService.MapPoint) -> some View {
    let style = swarmMapPinStyle(for: point.kind)
    ZStack {
        Circle()
            .fill(style.color)
            .frame(width: 24, height: 24)
            .shadow(radius: 2)
        Image(systemName: style.symbol)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.white)
    }
    .overlay {
        // Strike through the superseded airport so old→new reads at a glance.
        if point.kind == "airport_origin" {
            Rectangle()
                .fill(.white)
                .frame(width: 26, height: 2)
                .rotationEffect(.degrees(-30))
        }
    }
}

/// Framing math shared by the live map and the static snapshotter — single
/// point ⇒ 6 km box, otherwise the bounding box padded ×1.6 with a 0.04°
/// floor.
fileprivate func swarmMapRegion(for coords: [CLLocationCoordinate2D]) -> MKCoordinateRegion? {
    guard !coords.isEmpty else { return nil }
    if coords.count == 1 {
        return MKCoordinateRegion(center: coords[0],
                                  latitudinalMeters: 6_000, longitudinalMeters: 6_000)
    }
    let lats = coords.map(\.latitude)
    let lngs = coords.map(\.longitude)
    let center = CLLocationCoordinate2D(
        latitude: (lats.min()! + lats.max()!) / 2,
        longitude: (lngs.min()! + lngs.max()!) / 2)
    let span = MKCoordinateSpan(
        latitudeDelta: max((lats.max()! - lats.min()!) * 1.6, 0.04),
        longitudeDelta: max((lngs.max()! - lngs.min()!) * 1.6, 0.04))
    return MKCoordinateRegion(center: center, span: span)
}

// MARK: - Compact change map (presentation.map_points)

/// 180pt non-interactive map pinning the old vs new arrival airport, the
/// hotel and swapped-in activities — auto-framed the same way
/// `JourneyRouteMap` frames the journal trail.
private struct SwarmChangeMap: View {
    let points: [SwarmService.MapPoint]

    @State private var position: MapCameraPosition = .automatic

    private var coords: [CLLocationCoordinate2D] {
        points.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
    }

    var body: some View {
        Map(position: $position, interactionModes: []) {
            ForEach(points) { point in
                Annotation(point.label,
                           coordinate: CLLocationCoordinate2D(latitude: point.lat, longitude: point.lng)) {
                    swarmMapPin(for: point)
                }
            }
        }
        .mapStyle(.standard(elevation: .flat))
        .frame(height: 180)
        .clipShape(.rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color(.separator)))
        .task(id: points.count) { frame() }
    }

    private func frame() {
        guard let region = swarmMapRegion(for: coords) else { return }
        if coords.count == 1 {
            position = .region(region)
        } else {
            withAnimation { position = .region(region) }
        }
    }
}

// MARK: - Static map thumbnail (MKMapSnapshotter, cached)

/// Renders the change map as a STATIC `MKMapSnapshotter` image with the same
/// pins composited on top — a single raster paint per page instead of a
/// live `Map` view per carousel page (pager perf). Snapshots are cached in
/// an in-memory `NSCache` keyed by point set + pixel size. While loading it
/// shows a quiet 180pt placeholder; on snapshot failure or empty points it
/// falls back to the live `SwarmChangeMap` so the map never disappears.
private struct SwarmMapThumbnail: View {
    let points: [SwarmService.MapPoint]

    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var failed = false

    /// Small shared snapshot cache — the carousel revisits the same pages.
    /// Cost-bounded by decoded pixel bytes so a wide carousel can't balloon.
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 12
        cache.totalCostLimit = 24 * 1024 * 1024
        return cache
    }()

    private var coords: [CLLocationCoordinate2D] {
        points.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
    }

    private func cacheKey(size: CGSize) -> NSString {
        // Include `kind` — same coords with a different pin role (e.g. a
        // hotel reused as an activity swap) is a different snapshot.
        let pts = points.map { "\($0.kind):\($0.lat),\($0.lng)" }.sorted().joined(separator: "|")
        return "\(pts)@\(Int(size.width * displayScale))x\(Int(size.height * displayScale))" as NSString
    }

    var body: some View {
        GeometryReader { geo in
            Group {
                if points.isEmpty || failed {
                    // Never leave the dossier without a map.
                    SwarmChangeMap(points: points)
                } else if let image {
                    Image(uiImage: image)
                        .resizable()
                        .frame(maxWidth: .infinity)
                        .frame(height: 180)
                        .clipShape(.rect(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color(.separator)))
                } else {
                    RoundedRectangle(cornerRadius: 14)
                        .fill(Color(.systemFill))
                        .frame(height: 180)
                }
            }
            .frame(width: geo.size.width)
            .task(id: Int(geo.size.width)) { await load(width: geo.size.width) }
        }
        .frame(height: 180)
    }

    private func load(width: CGFloat) async {
        // Never rasterize a sub-point placeholder: the first layout pass may
        // report width < 1 — skip it so `.task(id:)` re-fires cleanly once
        // the geometry is real (the key changes with the width, so a better
        // snapshot may replace the placeholder — but never a 1-pt raster).
        guard width >= 1, image == nil, !failed, !points.isEmpty else { return }
        guard let region = swarmMapRegion(for: coords) else {
            failed = true
            return
        }
        let size = CGSize(width: max(width, 1), height: 180)
        let key = cacheKey(size: size)
        if let cached = Self.cache.object(forKey: key) {
            image = cached
            return
        }
        let options = MKMapSnapshotter.Options()
        options.region = region
        options.size = size
        options.scale = displayScale
        do {
            let snapshot = try await MKMapSnapshotter(options: options).start()
            let composite = compositePins(on: snapshot, size: size)
            Self.cache.setObject(
                composite,
                forKey: key,
                cost: Int(size.width * size.height * displayScale * displayScale * 4)
            )
            image = composite
        } catch {
            failed = true
        }
    }

    /// Base snapshot + the SAME pin visuals as the live map, rasterized via
    /// `ImageRenderer` and stamped at `snapshot.point(for:)`.
    private func compositePins(on snapshot: MKMapSnapshotter.Snapshot,
                               size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = displayScale
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            snapshot.image.draw(in: CGRect(origin: .zero, size: size))
            for point in points {
                let pinRenderer = ImageRenderer(
                    content: swarmMapPin(for: point).frame(width: 28, height: 28))
                pinRenderer.scale = displayScale
                guard let pinImage = pinRenderer.uiImage else { continue }
                let pt = snapshot.point(for: CLLocationCoordinate2D(latitude: point.lat,
                                                                    longitude: point.lng))
                pinImage.draw(in: CGRect(x: pt.x - pinImage.size.width / 2,
                                         y: pt.y - pinImage.size.height / 2,
                                         width: pinImage.size.width,
                                         height: pinImage.size.height))
            }
        }
    }
}

// MARK: - Settlement disclosure helpers

extension TrustLayerSheet {
    /// "Late check-in", not "late_check_in".
    func hotelActionLabel(_ action: String) -> String {
        switch action {
        case "late_check_in":
            return app.trm("Arrivée tardive", "Late check-in", "Llegada tardía", "Späte Anreise", "延迟入住")
        case "rebook":
            return app.trm("Chambre à réserver à nouveau", "Room needs rebooking", "Hay que volver a reservar",
                           "Zimmer neu buchen", "需重新预订房间")
        case "none":
            return app.trm("Aucun changement", "No change", "Sin cambios", "Keine Änderung", "无变化")
        default:
            return action.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// Chip naming how the price was established — shown only when it is NOT a
    /// provider-verified fare, so a verified plan stays uncluttered.
    func pricingBasisChip(_ plan: SwarmService.Plan) -> AnyView? {
        guard let flight = plan.proposedResolution.newFlight else { return nil }
        let label: String
        let tint: Color
        if flight.isIndicativeEstimate {
            label = app.trm("Estimation", "Estimate", "Estimación", "Schätzung", "估算")
            tint = Brand.amber
        } else if flight.isUnverifiedPrice {
            label = app.trm("Prix à confirmer", "Price unconfirmed", "Precio por confirmar",
                            "Preis unbestätigt", "价格待确认")
            tint = .orange
        } else {
            return nil
        }
        return AnyView(
            Text(label)
                .font(.caption2.weight(.bold))
                .textCase(.uppercase)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(tint)
                .background(tint.opacity(0.14), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.5), lineWidth: 0.5))
                .accessibilityLabel(label)
                .accessibilityIdentifier("trustLayer.pricingBasis")
        )
    }

    func settlementPreviewCard(_ preview: SwarmService.Presentation.SettlementPreview) -> some View {
        SwarmSurfaceCard {
            VStack(alignment: .leading, spacing: 10) {
                Label(app.trm("Ce que l’approbation modifie", "What approving changes",
                              "Qué cambia al aprobar", "Was die Zustimmung ändert", "批准后将更改"),
                      systemImage: "list.bullet.clipboard")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(Array(preview.changes.enumerated()), id: \.offset) { _, change in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: change.contains("cancelled") ? "xmark.circle" : "arrow.right.circle")
                            .font(.footnote)
                            .foregroundStyle(change.contains("cancelled") ? Brand.coral : Brand.indigo)
                        Text(change)
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if !preview.followUps.isEmpty {
                    Divider().opacity(0.4)
                    Text(app.trm("Il vous restera à faire", "Left for you to do", "Te quedará por hacer",
                                 "Danach noch zu tun", "之后需要你处理"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    followUpList(preview.followUps)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("trustLayer.settlementPreview")
    }

    func followUpList(_ followUps: [SwarmService.FollowUp]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(followUps) { followUp in
                Label {
                    Text(followUp.message)
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: followUp.systemImage)
                        .foregroundStyle(Brand.amber)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityIdentifier("trustLayer.followUps")
    }
}

/// Height of the floating actions card plus the window inset beneath it —
/// read from one proxy so the page reserves exactly the room the card takes on
/// THIS device, at THIS text size.
struct ActionsMetrics: Equatable {
    var height: CGFloat
    var bottomInset: CGFloat
}

// MARK: - Surfaces

/// The Trust Layer's card surface.
///
/// Liquid Glass is the app's language and the sheet keeps it — but only where
/// it carries the design: the page-level cards a traveller actually looks at.
/// Rows NESTED inside one of those cards use `.solid`, because glass sampled
/// through glass is both the expensive case and the muddy-looking one. Every
/// glass surface on a page is a sibling inside one `GlassEffectContainer`, so
/// the system composites the group in a single pass instead of one pass per
/// card (13 per page × 3 mounted pages was what dropped frames).
struct SwarmSurfaceCard<Content: View>: View {
    enum Style {
        /// Page-level surface — real Liquid Glass.
        case glass
        /// Nested inside a glass card: a light fill, never glass on glass.
        case solid
    }

    var cornerRadius: CGFloat = 18
    var style: Style = .glass
    @Environment(\.isSwarmActive) private var isSwarmActive
    @ViewBuilder var content: Content

    var body: some View {
        switch style {
        case .glass:
            content
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
                .overlay {
                    if isSwarmActive {
                        SwarmIridescentBorder(active: true, settled: false, cornerRadius: cornerRadius)
                    }
                }
        case .solid:
            content
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: .secondarySystemGroupedBackground).opacity(0.55),
                            in: .rect(cornerRadius: cornerRadius))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(Color(uiColor: .separator).opacity(0.6), lineWidth: 0.5))
        }
    }
}

// MARK: - Quote countdown

/// The ONLY view in the Trust Layer that re-renders every second.
///
/// It used to be a `TimelineView` wrapped around the countdown AND around the
/// approve button AND around the confirmation popup, so each tick invalidated
/// the button, its gradient and the popup card too. Here the tick is confined
/// to one text badge; expiry reaches the rest of the sheet as a single state
/// change at the deadline.
struct TTLBadgeView: View {
    @Environment(AppSettings.self) private var app
    let expiresAt: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = Int(expiresAt.timeIntervalSince(context.date))
            if remaining > 0 {
                let clock = String(format: "%02d:%02d", remaining / 60, remaining % 60)
                Text(app.trm("Prix garanti pendant \(clock)",
                             "Price guaranteed for \(clock)",
                             "Precio garantizado durante \(clock)",
                             "Preis garantiert für \(clock)",
                             "价格保证剩余 \(clock)"))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(remaining >= 120
                                     ? AnyShapeStyle(.secondary)
                                     : AnyShapeStyle(Brand.coral))
                    .contentTransition(.numericText(countsDown: true))
                    .animation(.linear(duration: 0.2), value: remaining)
                    .accessibilityIdentifier("trustLayer.ttl")
            } else {
                Text(app.tr(
                    "Devis expirés. Relancez la mission pour obtenir de nouveaux prix.",
                    "Quotes expired. Re-run the mission to get fresh prices."))
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("trustLayer.ttlExpired")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Typing dots (resolving cadence)

/// Three dots pulsing in sequence — the copilot TypingDots cadence, rebuilt
/// on a clock-derived `TimelineView(.periodic)` (no retained Combine timer;
/// torn down with the view). Static under Reduce Motion.
struct SwarmTypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(Brand.indigo.opacity(0.6)).frame(width: 5, height: 5)
                }
            }
        } else {
            TimelineView(.periodic(from: .now, by: 0.3)) { context in
                let phase = Int(context.date.timeIntervalSinceReferenceDate / 0.3) % 3
                HStack(spacing: 3) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(Brand.indigo.opacity(phase == i ? 0.9 : 0.25))
                            .frame(width: 5, height: 5)
                    }
                }
                .animation(.easeInOut(duration: 0.3), value: phase)
            }
        }
    }
}
