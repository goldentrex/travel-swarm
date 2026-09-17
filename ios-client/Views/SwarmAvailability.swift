import Foundation
import Observation

/// Whether the travel swarm is offered at all, decided by the SERVER.
///
/// The swarm cannot do anything without its Worker — every mission, plan and
/// settlement lives there. So the Worker's own `/health` response is the honest
/// place to ask whether the feature exists, and it doubles as a kill switch:
/// flipping `SWARM_ENABLED` to "0" and redeploying (~10 s) withdraws the
/// feature from every build already in people's hands, with no App Store round
/// trip.
///
/// Defaults and caching are deliberate:
///  * The last known answer is remembered, so a launch with no network keeps
///    behaving like the previous one instead of flickering.
///  * With NO cached answer yet, the feature stays hidden until the server
///    replies. That is the conservative reading and it is also the truthful
///    one — without a reachable Worker the entry points would open onto
///    something that cannot work.
///  * `swarm.forceEnabled` in UserDefaults overrides both, for development.
@MainActor
@Observable
final class SwarmAvailability {

    /// Show the swarm's entry points?
    private(set) var isEnabled: Bool

    /// True once the server has answered at least once this launch.
    private(set) var didLoad = false

    /// True only when the server identifies the known Atlas test endpoint.
    /// Keep test inventory distinct from a live ticket in the approval UI.
    private(set) var usesFlightSandbox = false

    private static let cacheKey = "swarm.enabled.cached"
    private static let overrideKey = "swarm.forceEnabled"

    init() {
        if let forced = UserDefaults.standard.object(forKey: Self.overrideKey) as? Bool {
            isEnabled = forced
            didLoad = true
        } else {
            isEnabled = UserDefaults.standard.bool(forKey: Self.cacheKey)
        }
    }

    /// Ask the Worker. Never throws: an unreachable server leaves the cached
    /// answer in place rather than toggling the feature on a flaky network.
    func refresh() async {
        if UserDefaults.standard.object(forKey: Self.overrideKey) != nil { return }
        guard let url = URL(string: SwarmConfig.apiBase + "/health") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("Bearer " + SwarmConfig.demoToken, forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            // Absent key ⇒ an older Worker that predates the switch: treat that
            // as enabled rather than hiding a working feature.
            let enabled = (json["swarmEnabled"] as? Bool) ?? true
            usesFlightSandbox = (json["atlasSandboxHost"] as? String)?.lowercased() == "sandbox.atriptech.com"
            isEnabled = enabled
            didLoad = true
            UserDefaults.standard.set(enabled, forKey: Self.cacheKey)
        } catch {
            // Leave `isEnabled` on its cached value — silence is not a "no".
        }
    }
}
