# Travel Swarm

A multi-agent system that re-plans a trip when it goes wrong.

You missed your flight. Your hotel is overbooked. There is a rail strike tomorrow and
your museum booking is on the wrong side of town. Travel Swarm takes the disruption,
asks the providers what is actually available, and comes back with plans a person can
compare — each one costed, each trade-off stated, and nothing claimed that was not
checked.

It runs against **real** providers: Atlas for flights, Booking.com (via RapidAPI) for
hotels, Viator for activities, Open-Meteo for weather, PredictHQ for events. Gemini
supplies the judgement. Every agent also has a deterministic rail, so the system keeps
producing valid plans when a provider or the model is unavailable — it just says so
instead of pretending.

Extracted from [GlobePlanner](https://globeplanner.app), where it ships in the iOS app.

> **⚠️ Flights run against Atlas's SANDBOX, not production.** `AtlasFlightProvider`
> talks to `sandbox.atriptech.com` with a bearer credential. Atlas's own documentation
> describes this environment as test inventory for rehearsing the booking flow, not real
> availability — and its coverage is a **sampled set of route pairs, not a geography**.
> This is not a bug to fix in this codebase; it is the environment the credential is
> scoped to. See **[What Atlas actually covers](#what-atlas-actually-covers)** for the
> measured map and **[Flight coverage is honest, not complete](#flight-coverage-is-honest-not-complete)**
> for how the swarm reports a gap without blaming the wrong thing.

---

## What it actually does

```
  disruption ──▶ Liaison ──▶ Orchestrator ──┬──▶ Flight   ──▶ Atlas
   (free text)   (intent →   (fan-out,      ├──▶ Hotel    ──▶ Booking.com
                 constraints) plan carousel)├──▶ Activity ──▶ Viator
                                            ├──▶ DayReorg (rebuild one day)
                                            └──▶ Policy   ──▶ the carrier's real fare rules
                                                     │
                                              TrustLayer ──▶ what you pay, why, in one currency
```

**Nine agents**, each with an LLM path and a deterministic fallback:

| Agent | Job |
|---|---|
| `liaison/GeminiLiaisonAgent` | Turns free text and the traveler's answers into typed constraints |
| `orchestrator/OrchestratorAgent` | Fans out to the specialists, builds a carousel of distinct plans |
| `flight/FlightAgent` | Replacement flights, flexible dates, multi-airport fan-out |
| `hotel/HotelAgent` | Alternative rooms and properties for the nights affected |
| `activity/ActivityAgent` | Real replacement experiences that fit what the trip was for |
| `activity/DayReorganizer` | Rebuilds one day around a late arrival — bounds, travel time, opening hours |
| `policy/PolicyAgent` | Change and refund rules from the carrier's own published fare rule |
| `finance/TrustLayer` | The money: one currency, quotes and estimates never merged |
| `geminiCascade` | Model ladder — falls to a lighter tier rather than losing the LLM |

## Two things this codebase is opinionated about

**A plan must be feasible, not merely well-formed.** The replacement flight departs
*after* the disruption. Connections clear the airport's minimum connection time. An
activity is never moved to 01:00 to make the arithmetic work. A day is never quietly
trimmed to make it fit: `DayReorganizer` computes the feasibility verdict itself and
hands it to the model as a fact, and if the model drops an activity anyway the drop is
repaired rather than the schedule discarded.

**Never show a number you did not check.** A price badged as live came from a provider.
An estimate is labelled an estimate. A line nobody could price says so, and is counted
out of the total in words. "Your trip has been updated" is only said when something was
actually written. Most of the tests here exist to pin exactly that.

**A plan must leave you a trip, not just a flight.** A replacement that lands after
everything else in the itinerary is over is not a rebooking — it is a different, emptier
trip. `src/core/dag/tripConsequence.ts` checks every candidate against what is still
ahead (nights, activities) before it is offered, and a plan that survives carries a plain
sentence saying what it costs: *"You arrive 1 day late: 1 night and 11 activities you had
planned."*

## What Atlas actually covers

Measured live on 2026-09-02 across 57 origin–destination pairs, one search each. The
result is not "these cities work and those don't" — it is a **sample of specific route
pairs**, and direction matters:

| | |
|---|---|
| **Strong** | Intra-Asia-Pacific. `SIN→CGK` 39 routings, `SIN→BOM` 49, `SIN→DPS` 32, `SIN→KUL` 22, plus `HND/NRT/BKK/HKG/TPE/MNL/ICN/SYD` both ways. |
| **Good** | Intra-Europe. `FCO→CDG` 10, `CDG→FCO` 9, `LIS→CDG` 9, `LGW→BCN` 8, `MUC→FCO` 6, `BCN→CDG` 6, `CDG→BCN` 5, `LHR→FCO` 5, `FCO→LHR` 4. |
| **Thin** | Asia ↔ Europe. Only `SIN↔LHR` (3 each way) and `SIN↔DXB` (12/13). `SIN→CDG`, `SIN→FCO`, `SIN→AMS`, `SIN→FRA`, `SIN→BCN`, `SIN→DOH`, `SIN→IST` are all empty. |
| **Absent** | Transatlantic. `JFK→LHR`, `JFK→CDG`, `JFK→FLR` — nothing. US domestic is near-empty too (`JFK→MIA`, `MIA→JFK` empty). |

**Direction is not symmetric**, which is the clearest proof this is route sampling rather
than geography: `JFK→LAX` returns 1 routing, `LAX→JFK` returns 0. Likewise `FCO→LHR`
returns 4 while `CDG→LHR`, `AMS→LHR` and `FRA→LHR` return 0 — London is covered, just not
from those origins.

The practical consequence: **you cannot predict coverage from the cities involved.** A
trip between two well-covered airports can still hit a gap on its particular leg. That is
why the swarm reports the reason per-search rather than maintaining a city allowlist.

## Flight coverage is honest, not complete

When a flight search comes back empty, the reason matters — the four causes ask the
traveler to do different things, and only one of them is the partner's fault:

| Reason | What it means | What the traveler is told |
|---|---|---|
| `route_not_covered` | Atlas answered on ≥2 distinct dates with zero options — a real coverage gap | *"Our flight partner doesn't cover this route yet — you'll need to book it with the airline directly."* |
| `all_options_rejected` | Atlas had flights; **our own** rebooking window rejected all of them | *"We found flights, but every one leaves too late to still count as a rebooking."* |
| `pricing_unavailable` | Options existed, none could be priced | *"We found flights but couldn't price them just now — worth trying again."* |
| `search_declined` | Atlas refused the request outright (e.g. a past-dated search) — proves nothing either way | Retry, not a coverage claim |

Only `route_not_covered` is allowed to name the partner, and the `FlightAgent` has to
prove it first. This exists because the naive version — "empty result ⇒ not covered" —
is wrong twice over: one live trip returned **15** Atlas options that simply failed to
price, and would have been told its route was unsupported; a past-dated search returns
the identical empty array as a genuine no-coverage answer (Atlas replies HTTP 200 with
`{"routings": [], "status": 102, "msg": "Can not search past flights"}` — status 102 is
also reused for an unrelated gzip-header fault, so the two are disambiguated by message).
`src/agents/__tests__/noReplacementWording.test.ts` pins that only a proven gap may use
the word "partner".

The client renders this as a dedicated card in the Trust Layer, separate from — and above
— the money panel, because "wait and retry" and "book it yourself" are opposite
instructions and the traveler needs to know which one applies before reading a single
number.

## Quick start

```bash
npm install
npm test          # 589 tests, offline, no API keys needed
npm run typecheck
```

Every provider is stubbed at the `fetch` boundary in the test suite, so the whole thing
runs green on a fresh clone with no credentials.

To run it for real:

```bash
cp .dev.vars.example workers/swarm-demo/.dev.vars   # fill in what you have
npm run dev                                          # wrangler dev on :8787
```

```bash
curl -s localhost:8787/api/hackathon/health -H "Authorization: Bearer $SWARM_DEMO_TOKEN"
```

Keys are all optional except `SWARM_DEMO_TOKEN`. Without `GEMINI_API_KEY` the agents run
their deterministic rails; without a provider key that provider reports itself degraded
and the affected lines fall back to the trip's own figures. Nothing crashes, and the
response says which rails were live.

## The API

| Endpoint | What it does |
|---|---|
| `POST /mission/assess` | Classify a disruption, return the trade-off questions worth asking |
| `POST /mission/resolve` | Run the swarm, return a carousel of costed plans |
| `POST /approve-resolution` | Settle a chosen plan onto the trip (CAS write, consumed once) |
| `POST /booking-preview` | Real provider prices for a booking confirmation screen |
| `POST /mission/cancel` | Cancel an in-flight mission |
| `GET  /health` | Which rails are configured, reachable and authorized |

Two-factor auth by design: a shared bearer for the Worker, **plus** the traveler's own
Supabase access token in `X-Swarm-User-Token` for anything that reads or writes a trip.
The shared token alone grants nothing.

## Testing against reality

Unit tests prove the logic. They do not prove the plans are any good — the defects worth
finding only appeared against live providers and real trips. `scripts/swarm-sim/` is the
harness for that:

```bash
SWARM_API_ORIGIN=https://your-worker.example.com \
SUPABASE_URL=... SIM_TEST_USER=... npm run sim
```

It runs every scenario against every trip and grades the output on two tiers:

- **Tier 1 — feasibility.** Deterministic, no leniency: departure ordering, connection
  times, physical reachability, opening hours, per-currency arithmetic, whether the
  "cheapest" option really is cheapest once the change fee is counted.
- **Tier 2 — is this any good for a real traveler?** Does the plan preserve what the trip
  was *for*? Is the replacement in the same city? Does it respect the budget tier? Does
  the explanation hold up, and is the trade-off stated honestly?

A plan can pass tier 1 and still be stupid. That is the whole reason tier 2 exists.

## Layout

```
src/agents/          the nine agents + the model cascade
src/providers/       Atlas, Booking.com, Viator, Open-Meteo, PredictHQ + interfaces
src/lib/             the HTTP API, session store, trip hydration, auth, booking preview
src/core/dag/        the itinerary graph the orchestrator reasons over, plus
                     tripConsequence.ts — what a late arrival costs the rest of the trip
workers/swarm-demo/  the Cloudflare Worker that serves it
scripts/swarm-sim/   the live simulation harness
ios-client/          the SwiftUI client, as reference (not a buildable target)
```

## Notes if you fork this

- **Cloudflare free plan caps a Worker invocation at 50 subrequests.** The provider
  ceilings in `swarmBookingPreview.ts` are measured against that, not guessed.
- **The session store is Supabase.** `swarmSessionStore.ts` is the only place that knows,
  so it is the file to change for another backend.
- **Trip shape.** `swarmTripContext.ts` hydrates GlobePlanner's `content_json`. That is
  the seam to adapt for a different trip model.
- **Never fan out `verify.do`.** The sandbox rate-limits per QPS: five concurrent
  re-price calls return HTTP 429 — all five — while the same calls made one at a time
  each succeed in ~90ms. `FlightAgent` prices sequentially with a 120ms gap for exactly
  this reason. A parallel `Promise.allSettled` here manufactures the "we found flights
  but couldn't price them" failure it then reports, and it is not obvious from local
  testing because a single sequential probe always works. When the re-price is throttled
  anyway, the candidate is kept at the price the *search* published, flagged
  `basis: "search_reference"` so the UI can say it is unconfirmed.
- **Atlas is the only flight provider, and it's sandbox-scoped.** No amount of code can
  return a flight absent from that dataset. A production integration needs either Atlas's
  OAuth/production credential path (see their `atlas-flight` CLI docs) or a second
  provider behind the same `FlightProvider` interface (`src/providers/interfaces/`) —
  the `NoReplacementReason` verdict above already tells you exactly which routes are
  hitting the gap.

## License

MIT — see [LICENSE](LICENSE).
