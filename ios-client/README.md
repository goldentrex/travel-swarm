# iOS client — reference implementation

The SwiftUI client that drives the swarm in the GlobePlanner app. **This is reference
code, not a buildable target.** It is here so you can see how a real client consumes the
API in `../src/lib/hackathonApi.ts` — the mission flow, the live trace, the trust layer,
the booking confirmation screen — without having to reverse-engineer it from the wire
format.

## What is here

| File | What it is |
|---|---|
| `SwarmService.swift` | The HTTP client. Every endpoint, every decoder, the two-factor auth headers. |
| `SwarmViewModel.swift` | Mission state machine: launch → poll → propose → approve → settle. |
| `NexusSwarmView.swift` | The main surface: scenario tiles, live activity stream, free-text mission. |
| `TrustLayerSheet.swift` | The plan carousel — what changes, what it costs, what you lose. |
| `SwarmBookingSheet.swift` | "Book these for me": real provider prices, what the swarm cannot take on, one total. |
| `TradeoffQuizView.swift` | The pre-mission questions the Liaison agent asks. |
| `SwarmEntryPoints.swift` | The seam into the host app (see below). |
| `SwarmMissionTargets.swift` | Turns a trip into the node ids the Worker's graph understands. |
| `SwarmFormat.swift` | Money, durations and wall-clock formatting. |
| `SwarmAvailability.swift` | Reads `SWARM_ENABLED` off `/health` — the server-side kill switch. |
| `SwarmIridescentBorder.swift` | The "agents are thinking" border. |
| `Tests/` | The Swift unit tests for the money rule, the bookable window, formatting and wire language. |

## To actually build this you would need

Twenty symbols from the host app, of which three matter:

- **`TripContent`** (and `Transit`, `DayItem`, `Cost`, `ItineraryDay`) — the trip model.
  This is not really a dependency, it *is* the swarm's wire format: node ids like
  `flight-0`, `activity-2-1` are derived from its shape and the Worker's graph expects
  exactly those.
- **`BookingChecklist`** — decides what is bookable at all, which drives the booking
  sheet's three sections.
- **`MarkBookedService`** — the CAS write back to the trip.

The rest are shallow: `Brand` (colors), `Haptics`, `GlassCard`, `AppSettings.tr` for
localization, and two one-line helpers (`leadCity`, `Collection[safe:]`).

## Two things worth stealing even if you write your own client

**`SwarmEntryPoints.swift` is a deliberate seam.** The host screen is a ~5,900-line
SwiftUI view, and attaching the swarm through eight separate modifiers pushed the Release
type-checker past its budget — it span for 23 minutes with no diagnostic. Collapsing them
into one `SwarmTripAttachment` ViewModifier plus three standalone entry-point views fixed
it. If you attach a feature to a large SwiftUI body, do it through one node.

**`SwarmAvailability.swift` defaults to OFF.** Entry points stay hidden until `/health`
answers, and the last known answer is cached. Withdrawing the feature from people already
carrying the build is a `wrangler deploy`, not an App Store round trip.
