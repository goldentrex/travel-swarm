import Foundation
import Testing
@testable import GlobePlanner

#if DEBUG
/// `SwarmService.appLanguage` is the `language` field sent to the swarm
/// backend on assess/resolve. It must follow the IN-APP language setting
/// (`LangPref.current`) — the same source TripDetailView's booking links use
/// — not the device locale: a traveler who picked German on an English
/// iPhone used to receive English trade-off questions. Unknown values must
/// fall back to "en" (the only codes the backend localizes are
/// en/de/es/fr/zh).
@Suite("Swarm wire language", .serialized)
struct SwarmLanguageTests {

    /// `LangPref.current` is global mutable state — always restore what we
    /// found so no other suite inherits a mutated app language.
    private func withLang(_ value: String, _ body: () -> Void) {
        let before = LangPref.current
        LangPref.current = value
        defer { LangPref.current = before }
        body()
    }

    @Test("each supported in-app language is passed through verbatim",
          arguments: ["en", "de", "es", "fr", "zh"])
    func supportedPassthrough(_ code: String) {
        withLang(code) {
            #expect(SwarmService.appLanguage == code)
        }
    }

    @Test("unsupported language values fall back to English",
          arguments: ["pt", "it", "ja", "zh-Hant", "", "german"])
    func unknownFallsBackToEnglish(_ value: String) {
        withLang(value) {
            #expect(SwarmService.appLanguage == "en")
        }
    }
}
#endif
