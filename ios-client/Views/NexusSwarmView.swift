import SwiftUI

// MARK: - Travel Swarm — the disruption-recovery sheet
//
// Assisted disruption recovery: shows the itinerary impact and supplier
// trace, then hands proposals to TrustLayerSheet for explicit approval.
// Ships in Release; SwarmAvailability reads the server feature switch.

struct NexusSwarmView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSettings.self) private var app

    var model: SwarmViewModel
    var content: TripContent? = nil
    var tripId: String?
    var rawContent: [String: Any] = [:]
    var onUpdate: (([String: Any]) -> Void)? = nil
    /// When set (e.g. tapped from a Copilot suggestion), that mission fires
    /// the moment the sheet opens.
    var autoLaunchIntent: String? = nil

    @State private var didAutoLaunch = false
    @State private var showSwarmBooking = false
    @State private var showTrust = false
    /// Free-text "custom mission" input — anything the user types is sent to
    /// the swarm exactly like a scenario tile's intent.
    @State private var customMissionText: String = ""
    @FocusState private var isInputFocused: Bool
    @State private var scenarioSelectionMode: MissionScenario? = nil

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    statusHeader
                    swarmStatusCard
                    if case let .failed(message) = model.phase {
                        failedBlock(message)
                    }
                    if model.phase == .settled {
                        settledBlock
                    }
                    if model.phase == .proposal || model.phase == .awaitingApproval {
                        reviewProposalButton
                    }
                    // 2-phase flow: the swarm is waiting on trade-off answers.
                    if model.phase == .gatheringPreferences {
                        answerQuizButton
                        // A traveler who wants out of the quiz mid-way cancels
                        // the whole mission (server-side abandon + reset).
                        cancelMissionButton(identifier: "trustLayer.cancelMission.1")
                    }
                    // Proactive (degraded) alert → not bookable, so offer the
                    // adaptive mission derived from the alert's incident instead.
                    if let intent = model.adaptiveMissionIntent {
                        adaptItineraryButton(intent)
                    }
                    missionSection
                }
                .padding(20)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(AuroraBackground(animated: model.isProcessing))
            .navigationTitle(app.tr("Essaim de voyage", "Travel Swarm"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(app.tr("Fermer", "Dismiss")) { dismiss() }
                }
            }
            .sheet(isPresented: $showTrust, onDismiss: { model.closeTrustLayer() }) {
                TrustLayerSheet(model: model)
            }
            .sheet(isPresented: $showSwarmBooking) {
                SwarmBookingSheet(content: content, rawContent: rawContent, tripId: tripId, onUpdate: onUpdate)
                    .presentationDetents([.medium, .large])
            }
            .sheet(item: $scenarioSelectionMode) { scenario in
                ScenarioSelectionSheet(
                    scenario: scenario,
                    content: content,
                    onLaunch: { finalIntent, nodeId in
                        model.openTrustLayer()
                        showTrust = true
                        Task { await model.launch(mission: finalIntent, tripId: tripId, nodeId: nodeId) }
                    }
                )
                .presentationDetents([.medium, .large])
            }
            .onChange(of: model.phase) { oldPhase, newPhase in
                if newPhase == .proposal && oldPhase != .awaitingApproval {
                    Haptics.success()
                    model.openTrustLayer()
                    showTrust = true
                } else if newPhase == .gatheringPreferences {
                    // 2-phase flow: the trade-off quiz needs the traveler's
                    // input — bring up the Trust Layer sheet so it's visible.
                    showTrust = true
                } else if case .failed = newPhase {
                    Haptics.warning()
                }
            }
            .task {
                model.startMonitoring()
                // The Trust Layer resolves the mission's target node against
                // this to show the leg the traveller actually had.
                model.missionContent = content
                if let intent = autoLaunchIntent, !didAutoLaunch {
                    didAutoLaunch = true
                    await model.launch(mission: intent, tripId: tripId)
                }
            }
        }
    }

    // MARK: Status indicator

    /// Plain words for what the swarm is doing. These are read by a traveler,
    /// not an operator: no internal product name, no "agentic", and localized
    /// like the rest of the app.
    private var statusText: String {
        switch model.phase {
        case .idle: return app.tr("En veille", "Standing by")
        case .monitoring: return app.tr("Surveillance active", "Watching your trip")
        case .processing:
            if let last = model.trace.last {
                return last.detail
            }
            return app.tr("Analyse en cours…", "Working on it…")
        case .gatheringPreferences:
            return app.tr("L'essaim attend votre avis", "The swarm needs your input")
        case .resolving:
            return app.tr("L'essaim prépare les plans", "The swarm is building plans")
        case .proposal, .awaitingApproval:
            return app.tr("Proposition prête", "Proposal ready")
        case .settled:
            return app.tr("Surveillance active", "Watching your trip")
        case .failed:
            return app.tr("Intervention nécessaire", "Needs your attention")
        }
    }

    private var statusDotColor: Color {
        switch model.phase {
        case .idle: return .secondary
        case .monitoring: return .green
        case .processing: return Brand.violet
        case .gatheringPreferences: return Brand.amber
        case .resolving: return Brand.violet
        case .proposal, .awaitingApproval: return Brand.sky
        case .settled: return .green // Return to green!
        case .failed: return Brand.coral
        }
    }

    private var statusHeader: some View {
        HStack(spacing: 8) {
            if model.isProcessing {
                SwarmSpinner()
            } else {
                SwarmLiveDot(color: statusDotColor, pulsing: model.glowActive)
            }
            Text(statusText)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("swarm.statusHeader")
                .lineLimit(1)
                .animation(.easeInOut, value: statusText)
            Spacer()
            Text(model.phaseLabel)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(statusDotColor.opacity(0.16), in: Capsule())
                .foregroundStyle(statusDotColor)
        }
    }

    // MARK: Iridescent Swarm Status card

    private var swarmStatusCard: some View {
        SwarmSurfaceCard(cornerRadius: 22) {
            VStack(alignment: .leading, spacing: 12) {
                Label(app.tr("Activité de l'essaim", "Swarm Activity Stream"), systemImage: "dot.radiowaves.left.and.right")
                    .font(.caption.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)

                if model.trace.isEmpty {
                    Text(model.isProcessing
                         ? app.trm("Déploiement des agents sur le graphe du voyage…",
                                   "Dispatching agents across the itinerary graph…",
                                   "Desplegando agentes por el grafo del itinerario…",
                                   "Agenten werden über den Reisegraphen verteilt…",
                                   "正在行程图上调度智能体…")
                         : app.trm("Agents en veille — lancez une mission ci-dessous.",
                                   "Agents standing by — launch a mission below.",
                                   "Agentes en espera: lanza una misión abajo.",
                                   "Agenten bereit – starte unten eine Mission.",
                                   "智能体待命 — 在下方启动任务。"))
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .padding(.vertical, 6)
                } else {
                    VStack(alignment: .leading, spacing: 9) {
                        ForEach(Array(model.trace.enumerated()), id: \.element.id) { index, entry in
                            SwarmTraceRow(entry: entry,
                                          isLatest: index == model.trace.count - 1,
                                          isProcessing: model.isProcessing)
                        }
                    }
                }

                // Long-running missions read as depth, not failure: a quiet
                // reassurance once the swarm has been negotiating ~15 s+.
                if model.isTakingLong && model.isProcessing {
                    Label(app.tr("Replanification complexe — l'essaim négocie encore les options…", "Complex re-plan — the swarm is still negotiating options…"),
                          systemImage: "hourglass")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .transition(.opacity)
                }
            }
        }
        // The iridescent border ANIMATES only while agents are actually
        // working. It used to rotate continuously — idle, reviewing, settled —
        // re-rendering the card under it at 30 fps for nothing.
        .overlay {
            SwarmIridescentBorder(active: model.isProcessing || model.phase == .resolving,
                                  settled: model.phase == .settled,
                                  cornerRadius: 22)
        }
        .animation(.easeInOut(duration: 0.3), value: model.trace.count)
        .animation(.easeInOut(duration: 0.25), value: model.isTakingLong)
    }

    // MARK: Mission launcher

    /// One scenario tile in the mission grid — canonical intent strings match
    /// the backend's keyword parser exactly (SwarmService.MissionIntent).
    fileprivate struct MissionScenario: Identifiable {
        let title: String
        let symbol: String
        let tint: Color
        let intent: String
        /// Stable lowercase slug used for the XCUITest accessibility
        /// identifier (`swarm.tile.<slug>`).
        let slug: String

        var id: String { intent }
    }

    /// What the traveller reads on a mission tile. `MissionScenario.title`
    /// stays ENGLISH on purpose — it is folded into the intent string the
    /// backend's keyword parser matches (SPEC §4.2) — so the label is resolved
    /// separately here instead of being shown raw in every locale.
    fileprivate func scenarioTitle(_ scenario: MissionScenario) -> String {
        switch scenario.slug {
        case "missedFlight":
            return app.trm("Vol manqué", "Missed flight", "Vuelo perdido", "Flug verpasst", "错过航班")
        case "weather":
            return app.trm("Météo", "Weather check", "Meteorología", "Wetter-Check", "天气检查")
        case "hotelOverbooked":
            return app.trm("Hôtel surbooké", "Hotel overbooked", "Hotel sobrevendido",
                           "Hotel überbucht", "酒店超额预订")
        case "activityCancelled":
            return app.trm("Activité annulée", "Activity cancelled", "Actividad cancelada",
                           "Aktivität abgesagt", "活动取消")
        case "transitStrike":
            return app.trm("Grève des transports", "Transit strike", "Huelga de transporte",
                           "Verkehrsstreik", "交通罢工")
        case "feelingUnwell":
            return app.trm("Je ne me sens pas bien", "Feeling unwell", "Me siento mal",
                           "Mir geht es nicht gut", "身体不适")
        default:
            return scenario.title
        }
    }

    private let scenarios: [MissionScenario] = [
        MissionScenario(title: "Missed flight", symbol: "airplane",
                        tint: Brand.coral, intent: SwarmService.MissionIntent.missedFlight,
                        slug: "missedFlight"),
        MissionScenario(title: "Weather check", symbol: "cloud.bolt",
                        tint: Brand.sky, intent: SwarmService.MissionIntent.weather,
                        slug: "weather"),
        MissionScenario(title: "Hotel overbooked", symbol: "bed.double",
                        tint: Brand.violet, intent: SwarmService.MissionIntent.hotelOverbooked,
                        slug: "hotelOverbooked"),
        MissionScenario(title: "Activity cancelled", symbol: "ticket",
                        tint: Brand.indigo, intent: SwarmService.MissionIntent.activityCancelled,
                        slug: "activityCancelled"),
        MissionScenario(title: "Transit strike", symbol: "tram",
                        tint: Brand.amber, intent: SwarmService.MissionIntent.transitStrike,
                        slug: "transitStrike"),
        MissionScenario(title: "Feeling unwell", symbol: "heart",
                        tint: Brand.coral, intent: SwarmService.MissionIntent.feelingUnwell,
                        slug: "feelingUnwell"),
    ]

    private var missionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(app.tr("Lancer une mission", "Launch a mission"))
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10),
                                GridItem(.flexible(), spacing: 10)],
                      spacing: 10) {
                ForEach(scenarios) { scenario in
                    missionButton(scenario)
                }
            }
            
            // Only offered when we actually hold the trip: opened from the Copilot
            // this view gets no content and no tripId, so the sheet could only
            // ever have shown an empty list and claimed everything was handled.
            if content != nil {
                Button {
                    Haptics.tap()
                    showSwarmBooking = true
                } label: {
                    Label(app.tr("Tout réserver avec le swarm", "Book everything with Swarm"),
                          systemImage: "sparkles")
                        .font(.footnote.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                }
                .buttonStyle(.plain)
                .background(Brand.indigo.opacity(0.12), in: .rect(cornerRadius: 12))
                .foregroundStyle(Brand.indigo)
                .overlay(RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Brand.indigo.opacity(0.3), lineWidth: 1))
                .disabled(model.isProcessing || model.phase == .awaitingApproval
                          || model.phase == .gatheringPreferences)
            }

            customMissionInput
        }
    }

    /// Free-text mission row — same disable gate as the tiles, launched
    /// identically via `model.launch(mission:)`. The backend's intent parser
    /// only accepts actionable phrasing for real trips, hence the hint.
    private var customMissionInput: some View {
        let busy = model.isProcessing || model.phase == .awaitingApproval
            || model.phase == .gatheringPreferences
        let trimmed = customMissionText.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                TextField("Ask the swarm anything…", text: $customMissionText)
                    .focused($isInputFocused)
                    .font(.footnote)
                    .textFieldStyle(.plain)
                    .submitLabel(.send)
                    .autocorrectionDisabled(false)
                    .onSubmit { submitCustomMission() }
                    .accessibilityIdentifier("swarm.customInput")
                    .disabled(busy)
                Button {
                    submitCustomMission()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(!trimmed.isEmpty && !busy
                                         ? AnyShapeStyle(Brand.gradient)
                                         : AnyShapeStyle(Color.secondary.opacity(0.45)))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("swarm.customSend")
                .disabled(busy || trimmed.isEmpty)
                .accessibilityLabel(app.tr("Envoyer une mission libre", "Send custom mission"))
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .background(Brand.violet.opacity(0.09), in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Brand.violet.opacity(0.22), lineWidth: 1))

            Text(app.tr("Astuce : une formulation actionnable marche mieux — « Changer / déplacer / annuler <quelque chose> ».", "Tip: actionable phrasing works best — “Change / reschedule / cancel <something>”."))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    /// Trim → validate → launch, identical to a tile tap. Clears the field
    /// once the mission is dispatched (input stays disabled while the swarm
    /// works, so nothing races the clear).
    private func submitCustomMission() {
        let trimmed = customMissionText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !model.isProcessing, model.phase != .awaitingApproval,
              model.phase != .gatheringPreferences else { return }
        customMissionText = ""
        Haptics.tap()
        model.openTrustLayer()
        showTrust = true
        Task { await model.launch(mission: trimmed, tripId: tripId) }
    }

    private func missionButton(_ scenario: MissionScenario) -> some View {
        Button {
            Haptics.tap()
            // Every tile routes through the node picker — the mission body
            // carries the selected node's id so the backend targets it
            // precisely (no more junk intents fired without a target).
            scenarioSelectionMode = scenario
        } label: {
            HStack(spacing: 8) {
                Image(systemName: scenario.symbol)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(scenario.tint)
                Text(scenarioTitle(scenario))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
            .background(scenario.tint.opacity(0.09), in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .strokeBorder(scenario.tint.opacity(0.22), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("swarm.tile.\(scenario.slug)")
        .disabled(model.isProcessing || model.phase == .awaitingApproval
                  || model.phase == .gatheringPreferences)
    }

    /// One-tap adaptive mission launched from a DEGRADED (proactive, not
    /// bookable) monitor alert — the intent is derived from the alert's
    /// incident by the view model.
    private func adaptItineraryButton(_ intent: String) -> some View {
        Button {
            Haptics.tap()
            model.openTrustLayer()
            showTrust = true
            Task { await model.launch(mission: intent, tripId: tripId) }
        } label: {
            Label(app.tr("Adapter mon itinéraire", "Adapt my itinerary"), systemImage: "arrow.triangle.branch")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
        }
        .buttonStyle(.borderedProminent)
        .tint(Brand.violet)
        .disabled(model.isProcessing)
    }

    private var reviewProposalButton: some View {
        Button {
            model.openTrustLayer()
            showTrust = true
        } label: {
            Label(app.tr("Examiner la proposition", "Review the proposal"), systemImage: "doc.text.magnifyingglass")
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Brand.indigo)
    }

    /// Re-opens the Trust Layer sheet when the traveler dismissed it while
    /// the trade-off quiz is still waiting on answers.
    private var answerQuizButton: some View {
        Button {
            Haptics.tap()
            showTrust = true
        } label: {
            Label(app.tr("Répondre aux questions de l'essaim", "Answer the swarm's questions"),
                  systemImage: "questionmark.circle")
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Brand.amber)
    }

    /// Shared "Cancel mission" affordance — abandons the in-flight session
    /// server-side (best-effort) and resets back to monitoring. `identifier`
    /// carries an index suffix where several instances can coexist.
    private func cancelMissionButton(identifier: String) -> some View {
        Button {
            Haptics.tap()
            model.cancelMission()
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

    // MARK: Failed & settled

    private func failedBlock(_ message: String) -> some View {
        SwarmSurfaceCard(cornerRadius: 18) {
            VStack(alignment: .leading, spacing: 10) {
                Label(app.tr("Échec de la mission de l'essaim", "Swarm mission failed"),
                      systemImage: "wifi.exclamationmark")
                    .font(.headline)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text(app.tr("Vérifiez votre connexion Internet, puis réessayez.",
                            "Check your internet connection, then try again."))
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                if model.failedOffersRerun {
                    // session_expired / trip_not_hydratable — the fix is a
                    // fresh run of the same mission.
                    Button {
                        Task { await model.rerunMission() }
                    } label: {
                        Label(app.tr("Relancer la mission", "Re-run mission"),
                              systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Brand.indigo)
                } else {
                    Button {
                        Task { await model.retry() }
                    } label: {
                        Label(app.tr("Réessayer", "Retry"), systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Brand.indigo)
                }
            }
        }
    }

    private var settledBlock: some View {
        SwarmSurfaceCard(cornerRadius: 18) {
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Brand.gradient)
                Text(app.tr("Approuvé et appliqué", "Approved & settled"))
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
                    Text(carrierBooked
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
                            "Rien n'a été réservé auprès d'un fournisseur — la modification n'est enregistrée que dans votre voyage.",
                            "Nothing was booked with a provider — this change is recorded in your trip only."))
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .multilineTextAlignment(.center)
                    }
                }
                if let plan = model.plan {
                    Text(plan.incident)
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                if !model.settlementChanges.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(app.tr("Appliqué à votre voyage :", "Applied to your trip:"))
                            .font(.footnote.weight(.semibold))
                        ForEach(model.settlementChanges, id: \.self) { change in
                            HStack(alignment: .top, spacing: 8) {
                                Circle()
                                    .fill(Brand.indigo)
                                    .frame(width: 5, height: 5)
                                    .padding(.top, 6)
                                Text(change)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(Brand.indigo.opacity(0.07), in: .rect(cornerRadius: 12))
                }
                Button(app.tr("Nouvelle mission", "New mission")) { model.reset() }
                    .font(.subheadline)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

// MARK: - Iridescent border (TimelineView + rotating AngularGradient)

// MARK: - Activity Stream row

/// One agent step. The newest row shimmers while the swarm is still working;
/// completed rows fade to 0.6 opacity (PlacePhotoGalleryView shimmer +
/// EventImpactCardView spinner precedents).
private struct SwarmTraceRow: View {
    let entry: SwarmService.TraceEntry
    let isLatest: Bool
    let isProcessing: Bool

    @State private var shimmerPhase: CGFloat = 0

    private var inFlight: Bool { isLatest && isProcessing }

    private var emoji: String {
        switch entry.agent {
        case "flight": return "✈️"
        case "policy": return "📜"
        case "hotel": return "🏨"
        case "activity": return "🎯"
        case "orchestrator": return "🧠"
        case "finance": return "💳"
        default: return "✨"
        }
    }

    private var agentTitle: String {
        switch entry.agent {
        case "orchestrator": return "Orchestrator"
        case "finance": return "Trust Layer"
        default: return entry.agent.capitalized + " Agent"
        }
    }

    private var agentTint: Color {
        switch entry.agent {
        case "flight": return Brand.sky
        case "policy": return Brand.violet
        case "hotel": return Brand.coral
        case "activity": return Brand.indigo
        default: return Brand.indigo
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(emoji)
                .font(.subheadline)
            VStack(alignment: .leading, spacing: 2) {
                Text(agentTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(agentTint)
                Text(entry.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            if inFlight {
                SwarmSpinner()
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green.opacity(0.85))
            }
        }
        .opacity(inFlight ? 1 : 0.6)
        .overlay {
            // Shimmer sweep on the in-flight row (SPEC §5.5).
            if inFlight {
                GeometryReader { geo in
                    LinearGradient(colors: [.clear, Color.primary.opacity(0.22), .clear],
                                   startPoint: .leading, endPoint: .trailing)
                        .frame(width: max(40, geo.size.width / 3))
                        .offset(x: -geo.size.width / 3 + shimmerPhase * (geo.size.width * 4 / 3))
                }
                .allowsHitTesting(false)
                .onAppear {
                    shimmerPhase = 0
                    withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) {
                        shimmerPhase = 1
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .opacity))
    }
}

// MARK: - Small animated bits

/// Rotating trim ring (EventImpactCardView spinner precedent).
struct SwarmSpinner: View {
    @State private var rotating = false

    var body: some View {
        Circle()
            .trim(from: 0.15, to: 1)
            .stroke(
                AngularGradient(
                    colors: [
                        Color(red: 0.95, green: 0.25, blue: 0.8),
                        Color(red: 0.35, green: 0.8, blue: 1.0),
                        Color(red: 0.6, green: 0.2, blue: 0.95)
                    ],
                    center: .center
                ),
                style: StrokeStyle(lineWidth: 2, lineCap: .round)
            )
            .frame(width: 14, height: 14)
            .rotationEffect(.degrees(rotating ? 360 : 0))
            .animation(.linear(duration: 0.9).repeatForever(autoreverses: false), value: rotating)
            .onAppear { rotating = true }
    }
}

/// Soft pulsing status dot for the header. Driven by a `TimelineView(.periodic)`
/// (torn down with the view — no `Timer.publish` subscription survives the
/// screen) and rendered static under Reduce Motion.
private struct SwarmLiveDot: View {
    var color: Color
    var pulsing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if pulsing && !reduceMotion {
            TimelineView(.periodic(from: .now, by: 0.3)) { context in
                let on = Int(context.date.timeIntervalSinceReferenceDate / 0.3) % 2 == 0
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                    .scaleEffect(on ? 1.35 : 1)
                    .opacity(on ? 1 : 0.55)
                    .animation(.easeInOut(duration: 0.3), value: on)
            }
        } else {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
        }
    }
}

/// Pulsing coral warning badge overlaid on the Copilot pill when a background
/// swarm alert is pending (TypingDots cadence precedent). Referenced from
/// TripDetailView's `actionPill` — keep internal visibility. Clock-derived
/// pulse via `TimelineView(.periodic)` — no retained Combine timer.
struct SwarmPillBadge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            ZStack {
                Circle().fill(Brand.coral.opacity(0.28)).frame(width: 15, height: 15)
                Circle().fill(Brand.coral).frame(width: 7, height: 7)
            }
            .allowsHitTesting(false)
        } else {
            TimelineView(.periodic(from: .now, by: 0.3)) { context in
                let on = Int(context.date.timeIntervalSinceReferenceDate / 0.3) % 2 == 0
                ZStack {
                    Circle()
                        .fill(Brand.coral.opacity(on ? 0.28 : 0.10))
                        .frame(width: 15, height: 15)
                    Circle()
                        .fill(Brand.coral)
                        .frame(width: 7, height: 7)
                }
                .scaleEffect(on ? 1.15 : 0.92)
                .animation(.easeInOut(duration: 0.3), value: on)
            }
            .allowsHitTesting(false)
        }
    }
}

#Preview("Travel Swarm") {
    NexusSwarmView(model: SwarmViewModel())
}

fileprivate struct ScenarioSelectionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSettings.self) private var app
    let scenario: NexusSwarmView.MissionScenario
    let content: TripContent?
    /// `(intent, nodeId)` — `nodeId` is the backend's synthetic node id for
    /// the picked option (nil for options with no graph node, e.g. "Entire
    /// Day"); sent in the mission body so the swarm targets it precisely.
    let onLaunch: (_ intent: String, _ nodeId: String?) -> Void

    @State private var selectedIds = Set<String>()

    /// Same mapping the mission tiles use, so the picker heading and the tile
    /// the traveller tapped read the same words.
    private var localizedScenarioTitle: String {
        switch scenario.slug {
        case "missedFlight":
            return app.trm("Vol manqué", "Missed flight", "Vuelo perdido", "Flug verpasst", "错过航班")
        case "weather":
            return app.trm("Météo", "Weather check", "Meteorología", "Wetter-Check", "天气检查")
        case "hotelOverbooked":
            return app.trm("Hôtel surbooké", "Hotel overbooked", "Hotel sobrevendido",
                           "Hotel überbucht", "酒店超额预订")
        case "activityCancelled":
            return app.trm("Activité annulée", "Activity cancelled", "Actividad cancelada",
                           "Aktivität abgesagt", "活动取消")
        case "transitStrike":
            return app.trm("Grève des transports", "Transit strike", "Huelga de transporte",
                           "Verkehrsstreik", "交通罢工")
        case "feelingUnwell":
            return app.trm("Je ne me sens pas bien", "Feeling unwell", "Me siento mal",
                           "Mir geht es nicht gut", "身体不适")
        default:
            return scenario.title
        }
    }

    struct Option: Identifiable {
        let id: String
        let title: String
        let subtitle: String?
        /// Second detail line. Route and schedule are two different facts, and
        /// crushing them into one subtitle wrapped mid-sentence and left the
        /// row unbalanced — the schedule gets its own line.
        var detail: String? = nil
        let icon: String
        /// Backend node ref (`swarmTripContext.hydrateTripFromContent`):
        /// flights/transits are indexed over the RAW `transit_groups` array
        /// (`flight-<idx>` / `transfer-<idx>`), itinerary items by their
        /// array positions (`activity-<day>-<item>`, `hotel-<day>-<item>`).
        let nodeId: String?
    }

    struct OptionGroup: Identifiable {
        let id = UUID()
        let title: String?
        let options: [Option]
    }

    /// Shared transit-leg row builder — one `Option` per `transit_groups`
    /// entry, carrying the backend's `flight-<idx>` / `transfer-<idx>` id.
    /// Mirrors `hydrateTripFromContent` (src/lib/swarmTripContext.ts): the
    /// backend derives `flight-<idx>` / `transfer-<idx>` from the SAME
    /// `transit_groups` indices, but silently drops legs it cannot read. A leg
    /// this returns false for has no node on the server, so it must not be
    /// offered as a mission target.
    private func isHydratableLeg(_ t: Transit, isFlight: Bool) -> Bool {
        func present(_ value: String?) -> Bool {
            guard let value else { return false }
            return !value.trimmingCharacters(in: .whitespaces).isEmpty
        }
        guard present(t.depart) else { return false }
        guard isFlight else { return true }
        return present(t.arrive)
            && (present(t.reference) || present(t.carrier))
            && (present(t.origin?.code) || present(t.origin?.city))
            && (present(t.destination?.code) || present(t.destination?.city))
    }

    private func transitOptions(methodFilter: ((String) -> Bool)? = nil,
                                icon: String? = nil) -> [Option] {
        guard let groups = content?.transit_groups else { return [] }
        var opts: [Option] = []
        for (idx, t) in groups.enumerated() {
            let method = (t.method ?? "").lowercased()
            let isFlight = method == "flight"
            if let methodFilter, !methodFilter(method) { continue }
            // Only offer legs the backend can actually hydrate into a node.
            // `hydrateTripFromContent` skips a leg without a departure, and a
            // FLIGHT also needs an arrival, a reference/carrier and both
            // endpoints — offering one anyway sent a nodeId the swarm does
            // not know, so picking it from this list dead-ended in a 404.
            guard isHydratableLeg(t, isFlight: isFlight) else { continue }

            // Line 1: what the leg IS — its route first, then its number.
            var route: [String] = []
            let origin = t.origin?.city ?? t.origin?.code ?? "Unknown"
            let dest = t.destination?.city ?? t.destination?.code ?? "Unknown"
            route.append("\(origin) → \(dest)")
            // P4 — an UNBOOKED leg's reference number is the model's illustrative
            // example, not a real departure: mark it indicative (mirrors the
            // timeline's honesty label).
            if let ref = t.reference {
                route.append(t.booked == true
                             ? ref
                             : "\(ref) (\(app.trm("indicatif", "indicative", "orientativo", "Richtwert", "参考价")))")
            }

            // Line 2: WHEN it goes — wall clock, exactly like the timeline
            // renders this same leg. Converting to the device time zone here
            // made the picker show "16:10" for the flight the timeline calls
            // "14:10".
            let schedule = t.depart == nil
                ? nil
                : SwarmFormat.transitRangeLabel(depart: t.depart, arrive: t.arrive)

            let title = isFlight ? (t.carrier ?? "Flight") : (t.carrier ?? method.capitalized)
            opts.append(Option(id: isFlight ? "flight-\(idx)" : "transfer-\(idx)",
                               title: title.isEmpty ? (isFlight ? "Flight" : method.capitalized) : title,
                               subtitle: route.joined(separator: " · "),
                               detail: (schedule?.isEmpty ?? true) ? nil : schedule,
                               icon: icon ?? (isFlight ? "airplane" : "tram"),
                               nodeId: isFlight ? "flight-\(idx)" : "transfer-\(idx)"))
        }
        return opts
    }

    /// Per-day activity/dining options carrying `activity-<day>-<item>` ids
    /// (RAW item index — the backend skips non-matching types but keeps the
    /// array position). `types` filters which item types qualify.
    private func activityOptionsByDay(types: Set<String>,
                                      icon: (String) -> String) -> [OptionGroup] {
        guard let itinerary = content?.itinerary else { return [] }
        var result: [OptionGroup] = []
        for (dayIndex, day) in itinerary.enumerated() {
            var opts: [Option] = []
            for (itemIndex, item) in day.items.enumerated() {
                let type = item.type.lowercased()
                guard types.contains(type) else { continue }
                // A day item that merely restates a transit leg is not a
                // cancellable activity — and the backend gives it no node, so
                // offering it here would dead-end in a 404. (It is also the
                // item the timeline hides for the same reason.)
                guard !SwarmMissionTargets.restatesTransitLeg(
                    item, dayDate: day.date, legs: content?.transit_groups ?? []
                ) else { continue }
                opts.append(Option(id: "activity-\(dayIndex)-\(itemIndex)",
                                   title: item.title.text,
                                   subtitle: item.time,
                                   icon: icon(type),
                                   nodeId: "activity-\(dayIndex)-\(itemIndex)"))
            }
            if !opts.isEmpty {
                let dateStr = day.date ?? ""
                result.append(OptionGroup(title: "Day \(day.day) \(dateStr)", options: opts))
            }
        }
        return result
    }

    private var groups: [OptionGroup] {
        guard let content else { return [] }

        switch scenario.slug {
        case "missedFlight":
            let opts = transitOptions(methodFilter: { $0 == "flight" }, icon: "airplane")
            return opts.isEmpty ? [] : [OptionGroup(title: nil, options: opts)]

        case "hotelOverbooked":
            guard let itinerary = content.itinerary else { return [] }
            var opts: [Option] = []
            for (dayIndex, day) in itinerary.enumerated() {
                for (itemIndex, item) in day.items.enumerated()
                where item.type == "stay" || item.type == "hotel" {
                    let dateStr = day.date.map { " • \($0)" } ?? ""
                    let sub = "Day \(day.day)\(dateStr)"
                    opts.append(Option(id: "hotel-\(dayIndex)-\(itemIndex)",
                                       title: item.title.text, subtitle: sub,
                                       icon: "bed.double.fill",
                                       nodeId: "hotel-\(dayIndex)-\(itemIndex)"))
                }
            }
            return opts.isEmpty ? [] : [OptionGroup(title: nil, options: opts)]

        case "weather":
            guard let itinerary = content.itinerary else { return [] }
            var result: [OptionGroup] = []
            for (dayIndex, day) in itinerary.enumerated() {
                var opts: [Option] = []
                opts.append(Option(id: "day_\(day.day)", title: "Entire Day \(day.day)",
                                   subtitle: day.date, icon: "cloud.sun.fill", nodeId: nil))
                for (itemIndex, item) in day.items.enumerated() {
                    let type = item.type.lowercased()
                    guard type == "activity" || type == "dining" else { continue }
                    opts.append(Option(id: "activity-\(dayIndex)-\(itemIndex)",
                                       title: item.title.text, subtitle: nil,
                                       icon: type == "dining" ? "fork.knife" : "figure.walk",
                                       nodeId: "activity-\(dayIndex)-\(itemIndex)"))
                }
                if !opts.isEmpty {
                    let dateStr = day.date ?? ""
                    result.append(OptionGroup(title: "Day \(day.day) \(dateStr)", options: opts))
                }
            }
            return result

        case "activityCancelled":
            // The backend hydrates activity-* nodes for activity, dining AND
            // restaurant items (feelingUnwell precedent).
            return activityOptionsByDay(types: ["activity", "dining", "restaurant"],
                                        icon: { $0 == "activity" ? "figure.walk" : "fork.knife" })

        case "transitStrike":
            // Primary: non-flight transit legs (trains/transfers); secondary
            // group: flights, for strikes that ground the airport link.
            var result: [OptionGroup] = []
            let ground = transitOptions(methodFilter: { $0 != "flight" }, icon: "tram")
            if !ground.isEmpty {
                result.append(OptionGroup(title: app.tr("Trajets en transports", "Transit legs"), options: ground))
            }
            let flights = transitOptions(methodFilter: { $0 == "flight" }, icon: "airplane")
            if !flights.isEmpty {
                result.append(OptionGroup(title: app.tr("Vols", "Flights"), options: flights))
            }
            return result

        case "feelingUnwell":
            // Activities & dining per day — lightening targets one of them.
            return activityOptionsByDay(types: ["activity", "dining", "restaurant"],
                                        icon: { $0 == "activity" ? "figure.walk" : "fork.knife" })

        default: return []
        }
    }

    /// Node-targeting scenarios pick exactly ONE affected node (the mission
    /// body carries a single `nodeId`); weather keeps multi-choice since its
    /// "Entire Day" option has no node.
    var isSingleChoice: Bool {
        switch scenario.slug {
        case "missedFlight", "transitStrike", "feelingUnwell", "hotelOverbooked":
            return true
        default:
            return false
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if groups.isEmpty {
                    ContentUnavailableView(
                        "No options found",
                        systemImage: "magnifyingglass",
                        description: Text(app.tr("Aucun élément de votre voyage ne correspond à ce scénario.", "Could not find any items in your trip matching this scenario."))
                    )
                } else {
                    ScrollView {
                        VStack(spacing: 16) {
                            ForEach(groups) { group in
                                VStack(spacing: 0) {
                                    if let title = group.title {
                                        Text(title)
                                            .font(.footnote.weight(.semibold))
                                            .textCase(.uppercase)
                                            .foregroundStyle(.secondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(.horizontal, 16)
                                            .padding(.bottom, 6)
                                    }
                                    
                                    VStack(spacing: 0) {
                                        ForEach(Array(group.options.enumerated()), id: \.element.id) { idx, opt in
                                            Button {
                                                if isSingleChoice {
                                                    selectedIds = [opt.id]
                                                } else {
                                                    if selectedIds.contains(opt.id) { selectedIds.remove(opt.id) }
                                                    else { selectedIds.insert(opt.id) }
                                                }
                                            } label: {
                                                HStack {
                                                    Image(systemName: opt.icon)
                                                        .frame(width: 24)
                                                        .foregroundStyle(Brand.indigo)
                                                    VStack(alignment: .leading, spacing: 2) {
                                                        Text(opt.title)
                                                            .font(.body.weight(.medium))
                                                            .foregroundStyle(.primary)
                                                        if let sub = opt.subtitle {
                                                            Text(sub)
                                                                .font(.caption)
                                                                .foregroundStyle(.secondary)
                                                                .fixedSize(horizontal: false, vertical: true)
                                                        }
                                                        if let detail = opt.detail {
                                                            Text(detail)
                                                                .font(.caption)
                                                                .foregroundStyle(.tertiary)
                                                                .monospacedDigit()
                                                        }
                                                    }
                                                    .padding(.vertical, 2)
                                                    Spacer()
                                                    if selectedIds.contains(opt.id) {
                                                        Image(systemName: isSingleChoice ? "record.circle" : "checkmark.circle.fill")
                                                            .foregroundStyle(Brand.indigo)
                                                    } else {
                                                        Image(systemName: "circle")
                                                            .foregroundStyle(.tertiary)
                                                    }
                                                }
                                                .padding()
                                                .contentShape(Rectangle())
                                            }
                                            .buttonStyle(.plain)
                                            // Stable handle for the E2E suite. The
                                            // sheet is NOT an XCUIElement `.sheet`
                                            // (SwiftUI presents it as plain
                                            // `Other` views under a second
                                            // window), so tests cannot scope to it
                                            // by container — they need to address
                                            // the rows directly, or they end up
                                            // matching the mission tiles on the
                                            // Nexus Swarm sheet underneath.
                                            .accessibilityIdentifier("swarm.node.\(opt.id)")
                                            if idx < group.options.count - 1 { Divider() }
                                        }
                                    }
                                    .background(Color(uiColor: .secondarySystemGroupedBackground))
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    .padding(.horizontal)
                                }
                            }
                        }
                        .padding(.vertical)
                    }
                }
            }
            // The scenario's own title stays English (it feeds the backend
            // intent); the heading the traveller reads is localized.
            .navigationTitle(app.trm("Choisir : \(localizedScenarioTitle)", "Select \(localizedScenarioTitle)",
                                     "Seleccionar: \(localizedScenarioTitle)", "Auswählen: \(localizedScenarioTitle)",
                                     "选择：\(localizedScenarioTitle)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(app.tr("Annuler", "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(app.tr("Confirmer", "Confirm")) {
                        let allOptions = groups.flatMap { $0.options }
                        let picked = allOptions.filter { selectedIds.contains($0.id) }
                        let names = picked.map(\.title)
                        let intent = "Change my \(scenario.title.lowercased()) " + names.joined(separator: " and ")
                        // One `nodeId` per mission — the first picked node
                        // (single-choice scenarios target exactly one).
                        let nodeId = picked.first?.nodeId
                        onLaunch(intent, nodeId)
                        dismiss()
                    }
                    .disabled(selectedIds.isEmpty)
                }
            }
        }
    }
}
