/**
 * OrchestratorAgent two-phase MULTI-PLAN tests (resolveDisruptionMulti).
 *
 * The pipeline runs ONCE per call (impact propagation → policy gate → flight
 * assessment → hotel/activity fan-out) and then assembles the W1
 * PER-CANDIDATE carousel: ONE plan per non-dominated candidate, capped at
 * {@link MAX_PLANS_PER_CAROUSEL} (5). Each plan carries derived tags in the
 * frozen badge order:
 *
 *   - cheapest : unique minimum net charge
 *   - fastest  : unique earliest arrival
 *   - nonstop  : the stops probe (absent metadata ⇒ treated as direct)
 *   - same_day / next_day : departure UTC day vs. the flight's TRUE
 *                original departure (captured before the delay shift)
 *
 * Constraints pin matching candidates to the front with additive "…, as you
 * asked" echo trace lines (prefer_nonstop / prefer_same_day /
 * prefer_earliest). Covered below: per-candidate emission with derived
 * badges, the 5-plan cap, canonical dedup when physically distinct
 * candidates share one canonical plan — PROVED against a ticking
 * millisecond clock (a Date.now spy advances on every call, so per-assembly
 * timestamps would serialize identically-chosen plans differently and break
 * dedup; the orchestrator captures ONE timestamp per resolve call),
 * Pareto-frontier filtering (dominated = costlier AND later is never
 * offered; cross-currency pairs stay non-comparable), the single-frontier
 * one-honest-plan rail, constraint filtering + pinning (max_price partial +
 * all-filtered, prefer_nonstop, prefer_same_day, prefer_earliest) and the
 * degraded flight-less single-plan rail. No fake timers: TTLs are asserted
 * against real wall-clock ranges.
 */

import { describe, expect, it, vi } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import {
  MAX_PLANS_PER_CAROUSEL,
  OrchestratorAgent,
  nonDominatedCandidates,
} from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import type {
  FlightAgent,
  FlightRebookingAssessment,
  RebookingCandidate,
} from "@/agents/flight/FlightAgent";
import { validateResolutionPlan } from "@/agents/finance/TrustLayer";
import type { ResolutionPlan } from "@/agents";
import type {
  FareDifference,
  FlightOption,
  FlightRouteContext,
} from "@/providers/interfaces/types";

// Test seam: plans assembled around the ATL-BAD candidate fail Trust Layer
// validation (drives the "validation failure drops a selection" coverage
// below). Every other plan delegates to the REAL validator.
vi.mock("@/agents/finance/TrustLayer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/agents/finance/TrustLayer")>();
  return {
    ...actual,
    validateResolutionPlan: (plan: ResolutionPlan): boolean => {
      if (plan.proposed_resolution.new_flight?.id === "ATL-BAD") return false;
      return actual.validateResolutionPlan(plan);
    },
  };
});

const MINUTE_MS = 60_000;
const ATLAS_QUOTE_TTL_MS = 15 * MINUTE_MS;

// Fixed graph anchor: flight departs 09:00 UTC, lands 11:30 UTC at LIS.
const BASE = Date.parse("2026-08-22T09:00:00Z");

const FLIGHT_ID = "flight-xy123";

// ------------------------------------------------------------------ fixtures

function makeFlightOption(overrides: Partial<FlightOption> = {}): FlightOption {
  return {
    id: "ATL-A",
    airline: "Atlas Sandbox",
    flightNumber: "XY401",
    origin: "CDG",
    // Same destination as the original arrivalLocationId — keeps the spatial
    // re-quote path out of these selection tests.
    destination: "LIS",
    departureTime: "2026-08-22T15:30:00Z",
    arrivalTime: "2026-08-22T18:00:00Z",
    price: 180,
    currency: "EUR",
    ...overrides,
  };
}

function makeCandidate(
  id: string,
  fareAmount: number,
  arrivalIso: string,
  departureIso?: string,
  currency = "EUR",
): RebookingCandidate {
  const option = makeFlightOption({
    id,
    flightNumber: `XY-${id}`,
    arrivalTime: arrivalIso,
    ...(departureIso ? { departureTime: departureIso } : {}),
  });
  const fareDifference: FareDifference = {
    oldFlightId: FLIGHT_ID,
    newFlightId: id,
    amount: fareAmount,
    currency,
    direction: "charge",
  };
  return { option, fareDifference };
}

/** Tag a candidate with an explicit stop count (future provider feed shape
 *  the orchestrator's stops probe reads; FlightOption itself has no field). */
function withStops(candidate: RebookingCandidate, stops: number): RebookingCandidate {
  (candidate.option as unknown as Record<string, unknown>).stops = stops;
  return candidate;
}

const netCharge = (candidate: RebookingCandidate): number =>
  candidate.fareDifference.direction === "charge"
    ? candidate.fareDifference.amount
    : -candidate.fareDifference.amount;

/** Minimal FlightAgent fake returning a configurable multi-candidate assessment. */
function flightStubMulti(candidates: RebookingCandidate[]): FlightAgent {
  const bestCandidate = [...candidates].sort((a, b) => netCharge(a) - netCharge(b))[0] ?? null;
  return {
    assessRebookingOptions: async (
      flightId: string,
      newTime: string,
    ): Promise<FlightRebookingAssessment> => ({
      originalFlightId: flightId,
      requestedTime: newTime,
      candidates,
      bestCandidate,
    }),
  } as unknown as FlightAgent;
}

/** Flight-only graph: no downstream nodes, no hotel/transfer side effects. */
function buildFlightOnlyGraph(): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: FLIGHT_ID,
    type: "flight",
    flightNumber: "XY123",
    origin: "CDG",
    destination: "LIS",
    departureTime: BASE,
    arrivalTime: BASE + 150 * MINUTE_MS,
    scheduledTime: BASE,
    status: "on_track",
    dependsOn: [],
    arrivalLocationId: "LIS",
  });
  return graph;
}

/**
 * The flight PLUS the trip it belongs to: two nights and two activities.
 *
 * The flight-only graph cannot express the failure this guards — with nothing
 * downstream there is nothing a late arrival can destroy, which is exactly why
 * the gap went unnoticed for so long.
 */
describe("a replacement must leave the traveller a trip to arrive to", () => {
  // The failure this closes: the swarm would happily rebook someone onto a
  // flight landing after their whole itinerary had finished. Every rule
  // passed — it flies the route, it leaves after the one they missed — and
  // nothing anywhere asked what happens to the days in between.

  const DAY = 24 * 60 * MINUTE_MS;
  const arrival = BASE + 150 * MINUTE_MS;

  function orchestratorWithTrip(candidates: RebookingCandidate[]): OrchestratorAgent {
    return new OrchestratorAgent(buildGraphWithTrip(), flightStubMulti(candidates));
  }

  it("keeps a replacement that lands after the original downstream schedule", async () => {
    const usable = makeCandidate("SOON", 40, new Date(arrival + 4 * 60 * MINUTE_MS).toISOString());
    // Lands after both nights and both activities are over.
    const tooLate = makeCandidate("LATE", 10, new Date(arrival + 5 * DAY).toISOString());

    const outcome = await orchestratorWithTrip([tooLate, usable]).resolveDisruptionMulti(
      makeEvent(),
    );

    const ids = outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id);
    expect(ids).toContain("SOON");
    // …even though LATE is the CHEAPEST, which is exactly why it used to win.
    expect(ids).toContain("LATE");
    expect(outcome.trace.join(" ")).not.toContain("landing after the rest of the trip is over");
  });

  it("offers the only flight and lets the graph reflow the trip around it", async () => {
    const tooLate = makeCandidate("LATE", 10, new Date(arrival + 5 * DAY).toISOString());

    const outcome = await orchestratorWithTrip([tooLate]).resolveDisruptionMulti(makeEvent());

    expect(outcome.plans.length).toBe(1);
    expect(outcome.plans[0]?.proposed_resolution.new_flight?.id).toBe("LATE");
  });

  it("keeps a late-but-survivable replacement, since the trip goes on", async () => {
    // One day late still leaves the second night and the second activity. That
    // is a real trade-off for the traveller to weigh, not a plan to suppress.
    const oneDayLate = makeCandidate("D1", 60, new Date(arrival + DAY).toISOString());

    const outcome = await orchestratorWithTrip([oneDayLate]).resolveDisruptionMulti(makeEvent());

    expect(outcome.plans.map((p) => p.proposed_resolution.new_flight?.id)).toContain("D1");
  });
});

function buildGraphWithTrip(): ItineraryGraph {
  const graph = buildFlightOnlyGraph();
  const arrival = BASE + 150 * MINUTE_MS;
  const DAY = 24 * 60 * MINUTE_MS;
  for (let night = 0; night < 2; night += 1) {
    graph.addNode({
      id: `hotel-${night}`,
      type: "hotel_check_in",
      hotelName: "Hotel Lisboa",
      scheduledTime: arrival + night * DAY + 2 * 60 * MINUTE_MS,
      status: "on_track",
      dependsOn: night === 0 ? [FLIGHT_ID] : [],
    });
    graph.addNode({
      id: `activity-${night}`,
      type: "activity",
      name: `Day ${night + 1} walk`,
      durationMinutes: 90,
      scheduledTime: arrival + night * DAY + 20 * 60 * MINUTE_MS,
      status: "on_track",
      dependsOn: [],
    });
  }
  return graph;
}

function makeEvent(overrides: Partial<DisruptionEvent> = {}): DisruptionEvent {
  return {
    nodeId: FLIGHT_ID,
    delay: 240,
    description: "Flight XY123 delayed by 4h",
    ...overrides,
  };
}

/** Three candidates that disagree on BOTH price and arrival time. */
function threeDistinctCandidates(): RebookingCandidate[] {
  return [
    // Cheapest (40) but latest arrival.
    makeCandidate("ATL-A", 40, "2026-08-22T18:00:00Z", "2026-08-22T15:30:00Z"),
    // Fastest (arrives 14:00) but most expensive.
    makeCandidate("ATL-B", 90, "2026-08-22T14:00:00Z", "2026-08-22T11:30:00Z"),
    // Middle fare AND middle arrival.
    makeCandidate("ATL-C", 60, "2026-08-22T16:00:00Z", "2026-08-22T13:30:00Z"),
  ];
}

function makeOrchestrator(candidates: RebookingCandidate[]): OrchestratorAgent {
  return new OrchestratorAgent(buildFlightOnlyGraph(), flightStubMulti(candidates));
}

const HOTEL_ID = "hotel-overbooked";

/** A lone hotel node — no flight anywhere in the graph, so a disruption
 *  sourced here never attempts a rebooking assessment at all. */
function buildHotelOnlyGraph(): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: HOTEL_ID,
    type: "hotel_check_in",
    hotelName: "Some Hotel",
    scheduledTime: BASE,
    status: "on_track",
    dependsOn: [],
  });
  return graph;
}

// --------------------------------------------------------------------- tests

describe("OrchestratorAgent.resolveDisruptionMulti — per-candidate carousel", () => {
  it("emits ONE plan per non-dominated candidate with derived badges", async () => {
    const before = Date.now();
    const orchestrator = makeOrchestrator(threeDistinctCandidates());
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());
    const after = Date.now();

    // Base ordering is net charge: A(40) → C(60) → B(90).
    expect(outcome.plans.length).toBe(3);
    const flightIds = outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id);
    expect(flightIds).toEqual(["ATL-A", "ATL-C", "ATL-B"]);

    // Derived tags (frozen badge order): A = cheapest, C = nonstop only
    // (no cheapest/fastest superlative), B = fastest. Every fixture
    // candidate departs on the original departure's UTC day ⇒ same_day, and
    // absent stops metadata ⇒ nonstop.
    expect(outcome.plans.map((plan) => plan.badge)).toEqual(["cheapest", "nonstop", "fastest"]);
    expect(outcome.plans[0]?.badges).toEqual(["cheapest", "nonstop", "same_day"]);
    expect(outcome.plans[1]?.badges).toEqual(["nonstop", "same_day"]);
    expect(outcome.plans[2]?.badges).toEqual(["fastest", "nonstop", "same_day"]);

    // Each plan is valid, computes its OWN financial delta and a FRESH TTL.
    // One resolve call captures a SINGLE timestamp, so every sibling plan
    // carries the SAME expires_at (asserted exactly, then bounded by the
    // wall-clock range around the call).
    const stamps = outcome.plans.map((plan) => plan.expires_at);
    expect(new Set(stamps).size).toBe(1);
    for (const plan of outcome.plans) {
      expect(validateResolutionPlan(plan)).toBe(true);
      expect(plan.expires_at).toBeGreaterThanOrEqual(before + ATLAS_QUOTE_TTL_MS);
      expect(plan.expires_at).toBeLessThanOrEqual(after + ATLAS_QUOTE_TTL_MS);
      expect(plan.financial_delta.net_payable).toBe(
        plan.financial_delta.total_new_charges - plan.financial_delta.total_refund,
      );
    }
    // Per-plan ledger math: fare charge only (no policy/hotel/transfer).
    expect(outcome.plans[0]?.financial_delta.total_new_charges).toBe(40);
    expect(outcome.plans[1]?.financial_delta.total_new_charges).toBe(60);
    expect(outcome.plans[2]?.financial_delta.total_new_charges).toBe(90);

    // Provenance (OrchestrationOutcome fields) stays intact.
    expect(outcome.rebookingAssessment?.candidates.length).toBe(3);
    expect(outcome.policyVerdict).toBeNull();
    expect(outcome.hotelAdjustments).toEqual([]);
    expect(outcome.activityProposals).toEqual([]);
  });

  it("omits the nonstop tag for candidates exposing a stop count", async () => {
    // C is the cheapest but flies with one stop — the stops probe must keep
    // the `nonstop` tag off it while the direct sibling keeps it.
    const candidates = [
      withStops(makeCandidate("ATL-C", 40, "2026-08-22T16:00:00Z", "2026-08-22T13:30:00Z"), 1),
      makeCandidate("ATL-B", 90, "2026-08-22T14:00:00Z", "2026-08-22T11:30:00Z"),
    ];
    const orchestrator = makeOrchestrator(candidates);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(outcome.plans.length).toBe(2);
    expect(outcome.plans[0]?.badges).toEqual(["cheapest", "same_day"]);
    expect(outcome.plans[1]?.badges).toEqual(["fastest", "nonstop", "same_day"]);
  });

  it("caps the carousel at MAX_PLANS_PER_CAROUSEL and notes the overflow", async () => {
    // Six-candidate frontier: strictly rising fares against strictly
    // earlier arrivals — nothing dominates anything.
    const candidates = [
      makeCandidate("ATL-1", 30, "2026-08-22T21:00:00Z", "2026-08-22T18:30:00Z"),
      makeCandidate("ATL-2", 50, "2026-08-22T20:00:00Z", "2026-08-22T17:30:00Z"),
      makeCandidate("ATL-3", 70, "2026-08-22T19:00:00Z", "2026-08-22T16:30:00Z"),
      makeCandidate("ATL-4", 90, "2026-08-22T17:00:00Z", "2026-08-22T14:30:00Z"),
      makeCandidate("ATL-5", 110, "2026-08-22T15:00:00Z", "2026-08-22T12:30:00Z"),
      makeCandidate("ATL-6", 130, "2026-08-22T13:00:00Z", "2026-08-22T10:30:00Z"),
    ];
    const orchestrator = makeOrchestrator(candidates);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(MAX_PLANS_PER_CAROUSEL).toBe(5);
    expect(outcome.plans.length).toBe(MAX_PLANS_PER_CAROUSEL);
    expect(outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id)).toEqual([
      "ATL-1",
      "ATL-2",
      "ATL-3",
      "ATL-4",
      "ATL-5",
    ]);
    expect(
      outcome.trace.some(
        (note) =>
          note ===
          `1 further option(s) beyond the ${MAX_PLANS_PER_CAROUSEL}-plan carousel cap — not offered`,
      ),
    ).toBe(true);
    // The fastest superlative survives the cap: ATL-5 lands earliest of the
    // offered pool, so its plan carries the fastest tag.
    expect(outcome.plans[4]?.badges).toContain("fastest");
  });

  it("offers ONE honest plan when the frontier has exactly one member", async () => {
    // One candidate only. Instead of padding the carousel with badge-stamped
    // copies, the orchestrator emits a single `cheapest` plan + the honesty
    // note.
    const only = makeCandidate("ATL-SOLO", 55, "2026-08-22T15:00:00Z");
    const orchestrator = makeOrchestrator([only]);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(outcome.plans.length).toBe(1);
    expect(outcome.plans[0]?.badge).toBe("cheapest");
    // Badges are a COMPARISON result, not a stamp: the single frontier member
    // runs through the same derivation as a carousel, so it carries every tag
    // it actually earns — including the `nonstop` / `same_day` pair the old
    // hardcoded ["cheapest","fastest"] silently withheld from it.
    expect(outcome.plans[0]?.badges).toEqual(["cheapest", "fastest", "nonstop", "same_day"]);
    expect(outcome.plans[0]?.proposed_resolution.new_flight?.id).toBe("ATL-SOLO");
    expect(
      outcome.trace.some(
        (note) => note === "single non-dominated option — offering one honest plan",
      ),
    ).toBe(true);
    expect(outcome.trace.some((note) => note.includes("deduplicated"))).toBe(false);
    expect(validateResolutionPlan(outcome.plans[0]!)).toBe(true);
  });

  it("dedup survives a ticking clock: ONE timestamp stamps every assembled plan", async () => {
    // PROOF of the timing fix: Date.now advances on EVERY call (7 ms per
    // tick), simulating the millisecond clock crossing between assembly loop
    // iterations. With per-assembly timestamps the two physically distinct
    // but canonically IDENTICAL candidates below would serialize with
    // different expires_at and dedup would fail; capturing ONE timestamp
    // per resolve call collapses them onto a single plan.
    let clock = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (clock += 7));
    try {
      const a = makeCandidate("ATL-X", 40, "2026-08-22T18:00:00Z");
      const b = makeCandidate("ATL-X", 40, "2026-08-22T18:00:00Z");
      const orchestrator = makeOrchestrator([a, b]);
      const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

      expect(outcome.plans.length).toBe(1); // would be 2 without the fix
      expect(outcome.trace.filter((note) => note.includes("deduplicated")).length).toBe(1); // the second selection collapsed onto the first canonical
    } finally {
      spy.mockRestore();
    }
  });

  it("stamps the FULL converging badge union when the post-dedup list collapses onto ONE plan", async () => {
    // Two physically distinct candidates sharing option id, fare AND
    // arrival: the first selection carries cheapest+fastest (both
    // superlatives tie onto it), the second only nonstop+same_day — both
    // canonicals are identical, so dedup collapses the carousel to ONE plan
    // that BOTH selections converged on. That plan carries the union of the
    // ACTUALLY converging tags in the frozen badge order while its frozen
    // badge stays "cheapest".
    const a = makeCandidate("ATL-X", 40, "2026-08-22T18:00:00Z");
    const b = makeCandidate("ATL-X", 40, "2026-08-22T18:00:00Z");
    const orchestrator = makeOrchestrator([a, b]);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(outcome.plans.length).toBe(1);
    expect(outcome.plans[0]?.badge).toBe("cheapest");
    expect(outcome.plans[0]?.badges).toEqual(["cheapest", "fastest", "nonstop", "same_day"]);
    expect(outcome.trace.filter((note) => note.includes("deduplicated")).length).toBe(1);
    expect(validateResolutionPlan(outcome.plans[0]!)).toBe(true);
  });

  it("stamps ONLY the converging badges when a selection fails validation", async () => {
    // Candidates: a(ATL-X, 40, 18:00), bad(ATL-BAD, 90, 14:00 — earliest
    // arrival), c(ATL-X duplicate of a). Selection order by net: a, c, bad.
    // bad's plan fails Trust Layer validation (module-level seam) and is
    // DROPPED — its fastest tag never enters the converging set; c dedups
    // onto a's canonical. The collapse stamp must therefore reflect only
    // the tags that ACTUALLY converged — cheapest + nonstop + same_day.
    const a = makeCandidate("ATL-X", 40, "2026-08-22T18:00:00Z");
    const bad = makeCandidate("ATL-BAD", 90, "2026-08-22T14:00:00Z");
    const c = makeCandidate("ATL-X", 40, "2026-08-22T18:00:00Z");
    const orchestrator = makeOrchestrator([a, bad, c]);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(outcome.plans.length).toBe(1);
    expect(outcome.plans[0]?.badge).toBe("cheapest");
    expect(outcome.plans[0]?.badges).toEqual(["cheapest", "nonstop", "same_day"]);
    expect(outcome.plans[0]?.proposed_resolution.new_flight?.id).toBe("ATL-X");
    // The fastest selection was dropped by the validator (honest trace note).
    expect(
      outcome.trace.some((note) => note === "fastest plan failed Trust Layer validation — dropped"),
    ).toBe(true);
    expect(validateResolutionPlan(outcome.plans[0]!)).toBe(true);
  });
});

describe("OrchestratorAgent.resolveDisruptionMulti — Pareto frontier", () => {
  it("drops a candidate that is BOTH costlier AND later (same currency) and notes it", async () => {
    // ATL-X (100, 19:00) is dominated by ATL-A (40, 18:00): costlier AND
    // later in the same currency — it must never be offered.
    const candidates = [
      makeCandidate("ATL-A", 40, "2026-08-22T18:00:00Z", "2026-08-22T15:30:00Z"),
      makeCandidate("ATL-B", 90, "2026-08-22T14:00:00Z", "2026-08-22T11:30:00Z"),
      makeCandidate("ATL-X", 100, "2026-08-22T19:00:00Z", "2026-08-22T16:30:00Z"),
    ];
    const orchestrator = makeOrchestrator(candidates);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(
      outcome.trace.some(
        (note) => note === "1 dominated option(s) filtered (costlier and later) — not offered",
      ),
    ).toBe(true);
    const selected = outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id);
    expect(selected).not.toContain("ATL-X");
    // Frontier [A, B] ⇒ one plan per candidate (net order).
    expect(outcome.plans.length).toBe(2);
    expect(selected).toEqual(["ATL-A", "ATL-B"]);
    expect(outcome.plans.map((plan) => plan.badge)).toEqual(["cheapest", "fastest"]);
    for (const plan of outcome.plans) {
      expect(validateResolutionPlan(plan)).toBe(true);
    }
  });

  it("keeps cross-currency candidates — they are non-comparable, never dominated", async () => {
    // ATL-U looks superficially "costlier and later" than ATL-A, but its
    // quote is in USD: no FX conversion in the trust layer ⇒ both kept.
    const candidates = [
      makeCandidate("ATL-A", 40, "2026-08-22T18:00:00Z", "2026-08-22T15:30:00Z"),
      makeCandidate("ATL-U", 50, "2026-08-22T19:00:00Z", "2026-08-22T16:30:00Z", "USD"),
    ];
    const orchestrator = makeOrchestrator(candidates);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(outcome.trace.some((note) => note.includes("dominated option(s) filtered"))).toBe(false);
    const selected = outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id);
    expect(selected).toContain("ATL-A");
    expect(selected).toContain("ATL-U");
  });

  it("orders the carousel deterministically regardless of the input order", async () => {
    // Same four candidates fed in two different orders: the base ordering
    // (net → arrival → option id) must produce the SAME carousel both times.
    const a = makeCandidate("ATL-A", 30, "2026-08-22T18:00:00Z", "2026-08-22T15:30:00Z");
    const d = makeCandidate("ATL-D", 50, "2026-08-22T17:00:00Z", "2026-08-22T14:30:00Z");
    const x = makeCandidate("ATL-X", 40, "2026-08-22T19:00:00Z", "2026-08-22T16:00:00Z", "USD");
    const c = makeCandidate("ATL-C", 60, "2026-08-22T16:00:00Z", "2026-08-22T13:30:00Z", "USD");

    for (const order of [
      [a, x, d, c],
      [a, d, x, c],
    ]) {
      const outcome = await new OrchestratorAgent(
        buildFlightOnlyGraph(),
        flightStubMulti(order),
      ).resolveDisruptionMulti(makeEvent());

      // Four frontier members (EUR/USD pairs are non-comparable; within USD
      // the cheaper X lands later ⇒ nothing dominated) ⇒ four plans.
      expect(outcome.plans.length).toBe(4);
      expect(outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id)).toEqual([
        "ATL-A",
        "ATL-X",
        "ATL-D",
        "ATL-C",
      ]);
      for (const plan of outcome.plans) {
        expect(validateResolutionPlan(plan)).toBe(true);
      }
    }
  });
});

describe("OrchestratorAgent.resolveDisruptionMulti — next-day comparability guard", () => {
  it("never dominates a next-UTC-day departure that is costlier AND later", async () => {
    // ATL-B departs the NEXT UTC calendar day and is both costlier and lands
    // later than same-currency ATL-A — legacy Pareto filtered it out, which
    // collapsed every missed-daily-flight frontier onto one option (the
    // next day IS the missed daily flight's only real replacement).
    const a = makeCandidate("ATL-A", 40, "2026-08-22T18:00:00Z", "2026-08-22T15:30:00Z");
    const b = makeCandidate("ATL-B", 90, "2026-08-23T14:00:00Z", "2026-08-23T11:30:00Z");

    // Frontier level: both survive (order-preserving).
    expect(nonDominatedCandidates([a, b]).map((c) => c.option.id)).toEqual(["ATL-A", "ATL-B"]);

    // End-to-end: the resolve rail keeps BOTH candidates in play (no
    // dominated-filter trace) and offers each as its own plan — the
    // same_day/next_day tags make the day difference visible.
    const orchestrator = makeOrchestrator([a, b]);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());
    expect(outcome.trace.some((note) => note.includes("dominated option(s) filtered"))).toBe(false);
    expect(outcome.rebookingAssessment?.candidates.length).toBe(2);
    expect(outcome.plans.length).toBe(2);
    expect(outcome.plans[0]?.badges).toContain("same_day");
    expect(outcome.plans[1]?.badges).toContain("next_day");
    expect(outcome.plans[1]?.badges).not.toContain("same_day");
    for (const plan of outcome.plans) {
      expect(validateResolutionPlan(plan)).toBe(true);
    }
  });

  it("keeps a costlier-and-later next-day option through to a distinct plan", async () => {
    // Three-member frontier: D (20, lands 20:00) is the cheapest same-day
    // option, E (50, 16:00) the fastest same-day one, B (90, NEXT UTC day)
    // the costlier-and-later next-day one ⇒ 3 distinct plans in net order.
    const candidates = [
      makeCandidate("ATL-D", 20, "2026-08-22T20:00:00Z", "2026-08-22T17:30:00Z"),
      makeCandidate("ATL-E", 50, "2026-08-22T16:00:00Z", "2026-08-22T13:30:00Z"),
      makeCandidate("ATL-B", 90, "2026-08-23T12:00:00Z", "2026-08-23T09:30:00Z"),
    ];
    const orchestrator = makeOrchestrator(candidates);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(outcome.plans.length).toBe(3);
    expect(outcome.plans[0]?.proposed_resolution.new_flight?.id).toBe("ATL-D");
    expect(outcome.plans[1]?.proposed_resolution.new_flight?.id).toBe("ATL-E");
    expect(outcome.plans[2]?.proposed_resolution.new_flight?.id).toBe("ATL-B");
    // The next-day option wears its day tag honestly (no same_day tag).
    expect(outcome.plans[2]?.badges).toContain("next_day");
    expect(outcome.plans[2]?.badges).not.toContain("same_day");
    expect(outcome.trace.some((note) => note.includes("dominated option(s) filtered"))).toBe(false);
  });

  it("keeps legacy comparability when a departure time is unparseable", () => {
    // Unparseable departure ⇒ sameUtcDay returns null ⇒ the pair stays
    // comparable exactly as before the guard: costlier-and-later is still
    // dominated on identical arrivals/departures metadata.
    const a = makeCandidate("ATL-A", 40, "2026-08-22T18:00:00Z", "not-a-date");
    const x = makeCandidate("ATL-X", 100, "2026-08-22T19:00:00Z", "2026-08-22T16:30:00Z");
    expect(nonDominatedCandidates([a, x]).map((c) => c.option.id)).toEqual(["ATL-A"]);
  });
});

describe("OrchestratorAgent.resolveDisruptionMulti — constraints, pinning & echo", () => {
  it("max_price filters candidates out and echoes the budget", async () => {
    const orchestrator = makeOrchestrator(threeDistinctCandidates());
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent(), { max_price: 65 });

    // ATL-B (90) is filtered out; no plan may select it.
    expect(outcome.trace.some((note) => note.includes("max_price 65"))).toBe(true);
    const selected = outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id);
    expect(selected).not.toContain("ATL-B");

    // Remaining pool [A(40), C(60)] ⇒ one plan each; C lands earlier than
    // A, so it carries the fastest superlative within the filtered pool.
    expect(outcome.plans.length).toBe(2);
    expect(selected).toEqual(["ATL-A", "ATL-C"]);
    expect(outcome.plans.map((plan) => plan.badge)).toEqual(["cheapest", "fastest"]);
    // W1e additive echo: the budget answer is visible in the trace.
    expect(
      outcome.trace.some((note) => note === "keeping plans within your budget, as you asked"),
    ).toBe(true);
    for (const plan of outcome.plans) {
      expect(validateResolutionPlan(plan)).toBe(true);
    }
  });

  it("max_price below every candidate keeps the cheapest pool and notes the exception", async () => {
    const orchestrator = makeOrchestrator(threeDistinctCandidates());
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent(), { max_price: 10 });

    expect(outcome.trace.some((note) => note.includes("exceeded by every candidate"))).toBe(true);
    // Nothing filtered ⇒ the full per-candidate carousel survives.
    expect(outcome.plans.length).toBe(3);
    expect(outcome.plans[0]?.proposed_resolution.new_flight?.id).toBe("ATL-A");
    // No budget echo when nothing was actually filtered.
    expect(
      outcome.trace.some((note) => note === "keeping plans within your budget, as you asked"),
    ).toBe(false);
  });

  it("prefer_nonstop filters the pool down to direct candidates", async () => {
    // The cheapest option flies with a stop; the direct sibling costs more.
    const candidates = [
      withStops(makeCandidate("ATL-S", 40, "2026-08-22T16:00:00Z", "2026-08-22T13:30:00Z"), 1),
      makeCandidate("ATL-D", 90, "2026-08-22T14:00:00Z", "2026-08-22T11:30:00Z"),
    ];
    const orchestrator = makeOrchestrator(candidates);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent(), {
      prefer_nonstop: true,
    });

    expect(
      outcome.trace.some((note) => note === "prefer_direct — kept 1 non-stop candidate(s)"),
    ).toBe(true);
    // One member left ⇒ the honest single-plan rail.
    expect(outcome.plans.length).toBe(1);
    expect(outcome.plans[0]?.proposed_resolution.new_flight?.id).toBe("ATL-D");
    // The surviving direct candidate is measured, not stamped — `nonstop` is
    // precisely the tag it earned by surviving this filter.
    expect(outcome.plans[0]?.badges).toEqual(["cheapest", "fastest", "nonstop", "same_day"]);
  });

  it("prefer_same_day pins the same-day candidate to the front and echoes it", async () => {
    // The cheaper option departs the NEXT UTC day — base ordering puts it
    // first; the same-day preference must pin the same-day candidate ahead
    // of it and say so.
    const nextDay = makeCandidate("ATL-N", 20, "2026-08-23T20:00:00Z", "2026-08-23T17:30:00Z");
    const sameDay = makeCandidate("ATL-S", 50, "2026-08-22T16:00:00Z", "2026-08-22T13:30:00Z");
    const orchestrator = makeOrchestrator([nextDay, sameDay]);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent(), {
      prefer_same_day: true,
    });

    expect(outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id)).toEqual([
      "ATL-S",
      "ATL-N",
    ]);
    expect(
      outcome.trace.some((note) => note === "prioritising same-day departure, as you asked"),
    ).toBe(true);
  });

  it("prefer_earliest pins the earliest arrival to the front and echoes it", async () => {
    // Base (net) order: A(40, 18:00), C(60, 16:00), D(70, 15:00), B(90,
    // 14:00). Earliest arrival = B ⇒ pinned first.
    const candidates = [
      ...threeDistinctCandidates(),
      makeCandidate("ATL-D", 70, "2026-08-22T15:00:00Z", "2026-08-22T12:30:00Z"),
    ];
    const orchestrator = makeOrchestrator(candidates);

    const plain = await orchestrator.resolveDisruptionMulti(makeEvent());
    expect(plain.plans.map((plan) => plan.proposed_resolution.new_flight?.id)).toEqual([
      "ATL-A",
      "ATL-C",
      "ATL-D",
      "ATL-B",
    ]);

    const biased = await new OrchestratorAgent(
      buildFlightOnlyGraph(),
      flightStubMulti(candidates),
    ).resolveDisruptionMulti(makeEvent(), { prefer_earliest: true });
    expect(biased.plans.map((plan) => plan.proposed_resolution.new_flight?.id)).toEqual([
      "ATL-B",
      "ATL-A",
      "ATL-C",
      "ATL-D",
    ]);
    expect(
      biased.trace.some((note) => note === "prioritising earliest arrival, as you asked"),
    ).toBe(true);
  });
});

describe("OrchestratorAgent.resolveDisruptionMulti — routeContext anchoring (regression)", () => {
  /** Captures the routeContext FlightAgent actually received, instead of
   *  returning candidates — this is the ONLY way to observe what
   *  OrchestratorAgent computed for excludeFlight/earliestDeparture, since
   *  that computation happens entirely on the caller's side of the
   *  FlightAgent boundary. */
  function capturingFlightAgent(): {
    agent: FlightAgent;
    captured: () => FlightRouteContext | undefined;
  } {
    let captured: FlightRouteContext | undefined;
    const agent = {
      assessRebookingOptions: async (
        flightId: string,
        newTime: string,
        routeContext?: FlightRouteContext,
      ): Promise<FlightRebookingAssessment> => {
        captured = routeContext;
        return {
          originalFlightId: flightId,
          requestedTime: newTime,
          candidates: [],
          bestCandidate: null,
        };
      },
    } as unknown as FlightAgent;
    return { agent, captured: () => captured };
  }

  it("anchors excludeFlight/earliestDeparture on the ORIGINAL departure, not the delay-shifted one", async () => {
    // Root cause reproduced live: a "missed flight" mission with no explicit
    // "delayed by Xh" wording defaults to a 240-minute delay (swarmIntent's
    // DEFAULT_DELAY_MINUTES). handleDisruption commits that shift onto the
    // node BEFORE routeContext is built, so naively reading `source.departureTime`
    // afterwards silently compared against "09:00 + 4h" while Atlas's real,
    // unaware-of-our-simulated-delay results (correctly) still departed at
    // 09:00 — so the exclude guard never matched, and the flight the
    // traveler just missed came back as its own "cheapest" replacement.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const { agent, captured } = capturingFlightAgent();
      const orchestrator = new OrchestratorAgent(buildFlightOnlyGraph(), agent);
      await orchestrator.resolveDisruptionMulti(
        makeEvent({ delay: 240, description: "Reroute requested — Flight XY123 CDG → LIS" }),
      );
      const routeContext = captured();
      expect(routeContext?.excludeFlight?.departureTime).toBe(new Date(BASE).toISOString());
      expect(routeContext?.earliestDeparture).toBe(new Date(BASE).toISOString());
      // The bug, made explicit: the shifted time must NEVER appear here.
      const shifted = new Date(BASE + 240 * MINUTE_MS).toISOString();
      expect(routeContext?.excludeFlight?.departureTime).not.toBe(shifted);
      expect(routeContext?.earliestDeparture).not.toBe(shifted);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets the SAME floor even when the description never says "missed" (explicit-node UI path)', async () => {
    // The UI's "which flight did you miss" picker sends an explicit nodeId,
    // which classifies as "delay" rather than "missed_flight" — the floor
    // must not depend on that classification any more.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const { agent, captured } = capturingFlightAgent();
      const orchestrator = new OrchestratorAgent(buildFlightOnlyGraph(), agent);
      await orchestrator.resolveDisruptionMulti(
        makeEvent({ delay: 240, description: "Reroute requested — Flight XY123 CDG → LIS" }),
      );
      expect(captured()?.earliestDeparture).toBe(new Date(BASE).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves the complete rebooking window with the sellable search date for a past fixture", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T03:15:00Z"));
    try {
      const { agent, captured } = capturingFlightAgent();
      const orchestrator = new OrchestratorAgent(buildFlightOnlyGraph(), agent);
      await orchestrator.resolveDisruptionMulti(
        makeEvent({ delay: 240, description: "Reroute requested — Flight XY123 CDG → LIS" }),
      );

      const routeContext = captured();
      const recoveryAnchor = "2026-09-17T05:15:00.000Z";
      expect(routeContext?.departureDate).toBe(recoveryAnchor);
      expect(routeContext?.earliestDeparture).toBe(recoveryAnchor);
      expect(routeContext?.latestDeparture).toBeUndefined();
      // The exact stale departure is still excluded for auditability, but it
      // no longer defines the window used to judge future provider inventory.
      expect(routeContext?.excludeFlight?.departureTime).toBe(new Date(BASE).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OrchestratorAgent.resolveDisruptionMulti — degraded rail", () => {
  it("emits EXACTLY one flight-less plan when there are no priced candidates", async () => {
    const orchestrator = makeOrchestrator([]);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(outcome.plans.length).toBe(1);
    const plan = outcome.plans[0]!;
    expect(plan.badge).toBe("balanced");
    expect("new_flight" in plan.proposed_resolution).toBe(false);
    expect(plan.financial_delta.total_new_charges).toBe(0);
    expect(plan.financial_delta.net_payable).toBe(0);
    expect(validateResolutionPlan(plan)).toBe(true);
    expect(outcome.trace.some((note) => note.includes("single plan"))).toBe(true);
    // Clarity pass: a flight search that ran and found nothing must say so
    // in the ONE thing every presentation of this plan is guaranteed to
    // show — the headline. Without this the traveler saw a normal looking
    // "requires approval" card with a €0 total and no clue their trip still
    // has an unresolved gap.
    expect(plan.incident).toContain("no replacement flight found");
  });

  it("does NOT append the no-flight-found note for a non-flight disruption", async () => {
    // A hotel/activity mission never attempts a flight search at all —
    // `rebookingAssessment` stays null (never attempted), which must read
    // differently from "attempted and came back empty".
    const orchestrator = new OrchestratorAgent(buildHotelOnlyGraph(), flightStubMulti([]));
    const outcome = await orchestrator.resolveDisruptionMulti(
      makeEvent({ nodeId: HOTEL_ID, description: "Hotel issue — Some Hotel" }),
    );
    const plan = outcome.plans[0]!;
    expect(plan.incident).toBe("Hotel issue — Some Hotel");
    expect(plan.incident).not.toContain("no replacement flight found");
  });

  /**
   * The rule the badges must obey: each superlative belongs to whichever plan
   * actually wins it. When the cheapest option and the fastest option are two
   * DIFFERENT flights, neither may claim both.
   */
  it("splits cheapest and fastest across the two plans that each win one", async () => {
    // A: cheaper but lands later.  B: pricier but lands first.
    const cheapLate = makeCandidate("ATL-CHEAP", 40, "2026-08-22T21:00:00Z");
    const dearEarly = makeCandidate("ATL-FAST", 180, "2026-08-22T13:00:00Z");
    const orchestrator = makeOrchestrator([cheapLate, dearEarly]);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    const byId = (id: string) =>
      outcome.plans.find((p) => p.proposed_resolution.new_flight?.id === id);

    expect(byId("ATL-CHEAP")?.badges).toContain("cheapest");
    expect(byId("ATL-CHEAP")?.badges).not.toContain("fastest");
    expect(byId("ATL-FAST")?.badges).toContain("fastest");
    expect(byId("ATL-FAST")?.badges).not.toContain("cheapest");
  });
});
