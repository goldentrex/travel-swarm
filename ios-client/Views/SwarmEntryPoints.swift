import SwiftUI

// The travel swarm's three entry points, as standalone views.
//
// They live OUTSIDE TripDetailView on purpose. That file is ~5,000 lines with
// very large SwiftUI bodies, and it sat right at the type-checker's practical
// limit: once these segments stopped being `#if DEBUG`-stripped from Release
// builds, the optimizing compiler stopped converging on it entirely (15+ min at
// 100% CPU, no diagnostic). Moving them into their own types takes the work out
// of that file's type-check budget for good — extracting them into computed
// properties of the same struct was not enough.
//
// All three ask the SERVER whether the feature is on. The swarm can do nothing
// without its Worker, so a withdrawn feature must leave no entry point behind.

/// Overflow-menu row on the trip screen.
struct SwarmMenuItem: View {
    @Environment(AppSettings.self) private var app
    @Environment(SwarmAvailability.self) private var availability
    @Binding var isPresented: Bool

    var body: some View {
        if availability.isEnabled {
            Button { isPresented = true } label: {
                Label(app.tr("Essaim de voyage", "Travel Swarm"),
                      systemImage: "circle.hexagongrid.fill")
            }
            .accessibilityIdentifier("tripDetail.swarmMenuItem")
        }
    }
}

/// Segment appended to the copilot pill. The coral badge pulses while a
/// background swarm alert is waiting for the traveler.
struct SwarmPillSegment: View {
    @Environment(SwarmAvailability.self) private var availability
    @Binding var isPresented: Bool
    var model: SwarmViewModel

    var body: some View {
        if availability.isEnabled {
            Divider().frame(height: 16)
            Button { isPresented = true } label: {
                Image(systemName: "circle.hexagongrid.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Brand.violet)
                    .frame(width: 44, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .overlay(alignment: .topTrailing) {
                if model.hasPendingAlert {
                    SwarmPillBadge().offset(x: 5, y: 3)
                }
            }
        }
    }
}

/// Compact status row beneath the dashboard's three action tiles.
struct SwarmDashboardRow: View {
    @Environment(AppSettings.self) private var app
    @Environment(SwarmAvailability.self) private var availability
    @Binding var isPresented: Bool
    var model: SwarmViewModel

    var body: some View {
        if availability.isEnabled {
            Button { isPresented = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "circle.hexagongrid.fill")
                        .font(.subheadline)
                        .foregroundStyle(Brand.violet)
                    Text(app.tr("Essaim", "Swarm"))
                        .font(.caption.weight(.semibold))
                    Text(model.phaseLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Brand.violet.opacity(0.09), in: .rect(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        }
    }
}


/// Everything the swarm attaches to the trip screen's own body: the sheet, the
/// deep-link consumption, the ambient glow and the alert-polling lifecycle.
///
/// Collapsed into ONE modifier because these hung off `TripDetailView.body`
/// individually. That body is the largest in the app, and once these stopped
/// being stripped from Release builds the optimizing type-checker stopped
/// converging on the file altogether. One modifier is one node in that chain
/// instead of eight, and the closures below are type-checked here.
struct SwarmTripAttachment: ViewModifier {
    @Binding var isPresented: Bool
    var model: SwarmViewModel
    var content: TripContent?
    var rawContent: [String: Any]
    var tripId: String
    /// Deep link asked for "have the swarm book this trip".
    var bookingRequested: Bool
    /// True while the trip's content has not decoded yet.
    var contentPending: Bool

    var onApply: ([String: Any]) -> Bool
    var onRefreshNeeded: () -> Void
    var onNoteRev: () -> Void
    var onConsumeBookingRequest: () -> Void

    func body(content view: Content) -> some View {
        view
            .environment(\.isSwarmActive, model.glowActive)
            .onAppear { onConsumeBookingRequest() }
            .onChange(of: bookingRequested) { onConsumeBookingRequest() }
            .onChange(of: contentPending) { onConsumeBookingRequest() }
            .task { model.startMonitoring(tripId: tripId) }
            .onDisappear { model.stopMonitoring() }
            .sheet(isPresented: $isPresented) { sheet }
    }

    private var sheet: some View {
        NexusSwarmView(model: model,
                       content: content,
                       tripId: tripId,
                       rawContent: rawContent) { updated in
            _ = onApply(updated)
        }
        .onAppear {
            model.onTripUpdated = { updated in
                // A settled payload we cannot decode must never leave the
                // timeline silently stale: the worker's CAS write already
                // landed, so re-read it from the server instead.
                guard onApply(updated) else {
                    onRefreshNeeded()
                    return
                }
                onNoteRev()
            }
            // Settlement reported trip_updated but returned no content — one
            // network refresh picks the write up.
            model.onTripRefreshNeeded = onRefreshNeeded
        }
    }
}
