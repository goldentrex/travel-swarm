import Foundation

/// How a closed settlement reaches the trip on screen — one decision, shared
/// by every surface that can approve a swarm plan.
///
/// The server writes the settled itinerary in ONE compare-and-swap before it
/// answers. The client's only job is to show that write immediately and keep
/// it across relaunches, without a second write of its own: re-persisting the
/// returned content with the pre-settlement `content_rev` collides with the
/// server's own write, and an offline replay of it could overwrite a
/// co-traveller's later edit.
///
/// Two defects this replaces: the Copilot entry point re-saved the settled
/// trip through the generic edit path, and the status-poll rail never wired a
/// refresh at all, so a plan settled while polling left the timeline stale.
enum SwarmSettlementSync {

    enum Action {
        /// The receipt carries the settled trip: show it and cache it.
        case applyContent([String: Any])
        /// The trip changed server-side but the content was not included
        /// (replayed receipt, rev conflict): read it back once.
        case refetch
        /// Nothing about the trip changed.
        case none
    }

    static func action(for response: SwarmService.ApproveResponse) -> Action {
        if let content = response.updatedContent, !content.isEmpty {
            return .applyContent(content)
        }
        guard let settlement = response.settlement else { return .none }
        // A skipped rewrite means ANOTHER write won — the trip still changed,
        // and the traveller must see the version that is really stored.
        if settlement.tripUpdated || settlement.conflictSkipped { return .refetch }
        return .none
    }
}
