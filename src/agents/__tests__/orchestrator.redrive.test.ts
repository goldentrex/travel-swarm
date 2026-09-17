/**
 * Task 20 — real-arrival impact re-drive, per-plan activity proposals, F5 echo.
 *
 * Guiding model: the replacement flight's REAL arrival is the impact driver;
 * the nominal delay is only the fallback when no candidate exists. Each
 * carousel plan carries activity moves consistent with ITS OWN arrival.
 *
 * Covered here:
 *  - {@link effectiveDelayMinutes} (pure helper);
 *  - the live-scenario twin: nominal delay flags only ONE downstream node,
 *    while the replacement's next-day real arrival (00:55Z) flags ≥2 ⇒ the
 *    DayReorganizer fires with same-day moves (not blind next-day shifts);
 *  - the arrival-floor sweep boundary (exactly arrival+buffer IS swept);
 *  - per-plan rederive in resolveDisruptionMulti: 5 plans / 2 arrivals ⇒
 *    exactly 2 rederive walks, deduped by exact arrival ISO;
 *  - guardrails: 0 candidates ⇒ byte-identical nominal output, weather-swap
 *    rail and single-activity legacy rail unchanged under the re-drive;
 *  - F5: "protecting <name>, as you asked" trace echo when the
 *    activity_priority constraint is consumed.
 */

import { describe, expect, it, vi } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { OrchestratorAgent, effectiveDelayMinutes } from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import type {
  FlightAgent,
  FlightRebookingAssessment,
  RebookingCandidate,
} from "@/agents/flight/FlightAgent";
import { ActivityAgent } from "@/agents/activity/ActivityAgent";
import type {
  DayReorgRequest,
  DayReorganizer,
  DayReorganizationOutcome,
} from "@/agents/activity/DayReorganizer";
import { resolutionPlanToJson, validateResolutionPlan } from "@/agents/finance/TrustLayer";
import type { ActivityProvider } from "@/providers/interfaces/ActivityProvider";
import type {
  ActivitySearchQuery,
  ActivitySearchResult,
  FareDifference,
  FlightOption,
} from "@/providers/interfaces/types";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// ------------------------------------------------------------------ fixtures

const FLIGHT_ID = "flight-xy123";
const HOTEL_ID = "hotel-lis";
const ACTIVITY_A = "activity-night-food";
const ACTIVITY_B = "activity-sunrise-surf";

/** Flight departs 2026-09-02T20:00Z, lands 22:30Z. */
const FLIGHT_DEPARTURE = Date.parse("2026-09-02T20:00:00Z");
const FLIGHT_ARRIVAL = Date.parse("2026-09-02T22:30:00Z");
/** The replacement's REAL next-day arrival driving the re-drive. */
const REAL_ARRIVAL_ISO = "2026-09-03T00:55:00.000Z";
const REAL_ARRIVAL_MS = Date.parse(REAL_ARRIVAL_ISO);
/** A second, later real arrival for the per-plan rederive tests. */
const LATE_ARRIVAL_ISO = "2026-09-03T04:30:00.000Z";

/**
 * Live-scenario twin graph: flight → hotel check-in (23:00) + two late
 * next-day-adjacent activities (00:30 / 02:00 UTC). With a 30-minute nominal
 * delay ONLY activity A falls inside the impacted window; the replacement's
 * real 00:55Z arrival flags BOTH activities (plus the hotel).
 */
function buildTwinGraph(withActivityB = true): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: FLIGHT_ID,
    type: "flight",
    flightNumber: "XY123",
    origin: "CDG",
    destination: "LIS",
    departureTime: FLIGHT_DEPARTURE,
    arrivalTime: FLIGHT_ARRIVAL,
    scheduledTime: FLIGHT_DEPARTURE,
    status: "on_track",
    dependsOn: [],
    arrivalLocationId: "LIS",
  });
  graph.addNode({
    id: HOTEL_ID,
    type: "hotel_check_in",
    hotelName: "Lisbon Riverside Hotel",
    scheduledTime: Date.parse("2026-09-02T23:00:00Z"),
    status: "on_track",
    dependsOn: [FLIGHT_ID],
  });
  graph.addNode({
    id: ACTIVITY_A,
    type: "activity",
    name: "Night Food Tour",
    durationMinutes: 90,
    scheduledTime: Date.parse("2026-09-03T00:30:00Z"),
    status: "on_track",
    dependsOn: [FLIGHT_ID],
  });
  if (withActivityB) {
    graph.addNode({
      id: ACTIVITY_B,
      type: "activity",
      name: "Sunrise Surf Session",
      durationMinutes: 60,
      scheduledTime: Date.parse("2026-09-03T02:00:00Z"),
      status: "on_track",
      dependsOn: [FLIGHT_ID],
    });
  }
  return graph;
}

function makeFlightOption(overrides: Partial<FlightOption> = {}): FlightOption {
  return {
    id: "ATL-A",
    airline: "Atlas Sandbox",
    flightNumber: "XY401",
    origin: "CDG",
    // Same destination as the original arrivalLocationId — the spatial
    // re-quote path stays out of these tests.
    destination: "LIS",
    departureTime: "2026-09-02T22:30:00Z",
    arrivalTime: REAL_ARRIVAL_ISO,
    price: 180,
    currency: "EUR",
    ...overrides,
  };
}

function makeCandidate(
  id: string,
  fareAmount: number,
  arrivalIso: string,
  departureIso: string,
  currency = "EUR",
): RebookingCandidate {
  const option = makeFlightOption({
    id,
    flightNumber: `XY-${id}`,
    arrivalTime: arrivalIso,
    departureTime: departureIso,
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

const netCharge = (candidate: RebookingCandidate): number =>
  candidate.fareDifference.direction === "charge"
    ? candidate.fareDifference.amount
    : -candidate.fareDifference.amount;

/** Minimal FlightAgent fake returning a configurable candidate pool. */
function flightStub(candidates: RebookingCandidate[]): FlightAgent {
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

/** Provider that never offers replacements (pure reschedule/consult rail). */
function noOptionsProvider(): ActivityProvider {
  return {
    providerName: "noop-fake",
    async searchActivities(query: ActivitySearchQuery): Promise<ActivitySearchResult> {
      return { query: query.query, degraded: false, options: [] };
    },
  };
}

/**
 * Arrival-aware DayReorganizer stub: retimes every activity of the day to
 * arrival + 9h / arrival + 12h — so walks with DIFFERENT arrivals produce
 * DIFFERENT proposal sets, and every recorded request is observable.
 */
function arrivalAwareReorganizerStub(): {
  stub: DayReorganizer;
  calls: DayReorgRequest[];
} {
  const calls: DayReorgRequest[] = [];
  const stub = {
    reorganizeDay: async (request: DayReorgRequest): Promise<DayReorganizationOutcome> => {
      calls.push(request);
      const anchor = request.newArrivalTime
        ? Date.parse(request.newArrivalTime)
        : Date.parse(`${request.date}T08:00:00Z`);
      const decisions = request.activities.map((activity, index) => ({
        nodeId: activity.nodeId,
        action: "retime" as const,
        newTime: new Date(anchor + (9 + index * 3) * HOUR_MS).toISOString(),
        reason: "moved inside the arrival day",
      }));
      return { decisions, source: "deterministic" };
    },
  } as unknown as DayReorganizer;
  return { stub, calls };
}

function makeEvent(overrides: Partial<DisruptionEvent> = {}): DisruptionEvent {
  return {
    nodeId: FLIGHT_ID,
    delay: 30,
    description: "Flight XY123 delayed by 30 minutes",
    ...overrides,
  };
}

function makeTwinOrchestrator(
  candidates: RebookingCandidate[],
  withActivityB = true,
): { orchestrator: OrchestratorAgent; reorgCalls: () => DayReorgRequest[] } {
  const { stub, calls } = arrivalAwareReorganizerStub();
  const orchestrator = new OrchestratorAgent(
    buildTwinGraph(withActivityB),
    flightStub(candidates),
    null,
    null,
    new ActivityAgent(noOptionsProvider()),
    null,
    null,
    stub,
  );
  return { orchestrator, reorgCalls: () => calls };
}

// ------------------------------------------------------------- pure helper

describe("effectiveDelayMinutes (pure helper)", () => {
  it("computes the true gap from the original arrival to the replacement arrival", () => {
    // 22:30 → next-day 00:55 = 145 minutes.
    expect(effectiveDelayMinutes(FLIGHT_ARRIVAL, REAL_ARRIVAL_ISO, 30)).toBe(145);
  });

  it("falls back to the nominal delay when the replacement arrival is unknown or unparseable", () => {
    expect(effectiveDelayMinutes(FLIGHT_ARRIVAL, undefined, 45)).toBe(45);
    expect(effectiveDelayMinutes(FLIGHT_ARRIVAL, "not-a-date", 45)).toBe(45);
    expect(effectiveDelayMinutes(Number.NaN, REAL_ARRIVAL_ISO, 45)).toBe(45);
  });

  it("clamps to zero (an earlier replacement never creates a negative delay)", () => {
    expect(effectiveDelayMinutes(FLIGHT_ARRIVAL, "2026-09-02T21:00:00Z", 30)).toBe(0);
    expect(effectiveDelayMinutes(FLIGHT_ARRIVAL, undefined, -10)).toBe(0);
  });
});

// ------------------------------------------------- live-scenario twin

describe("real-arrival re-drive — live-scenario twin", () => {
  it("nominal delay flags only ONE downstream node and stays on the legacy rail", async () => {
    const { orchestrator, reorgCalls } = makeTwinOrchestrator([]);
    const outcome = await orchestrator.resolveDisruption(makeEvent());

    // Nominal arrival 23:00 (+120 min buffer ⇒ 01:00): only activity A
    // (00:30) is inside the impacted window; B (02:00) and the hotel
    // (23:00, zero slack) are untouched.
    expect(outcome.disruption.delayMinutes).toBe(30);
    expect(outcome.disruption.affected.map((report) => report.nodeId)).toEqual([ACTIVITY_A]);

    // ONE flagged activity ⇒ the ≥2-per-day gate keeps the legacy per-item
    // rail: the DayReorganizer never fires.
    expect(reorgCalls()).toHaveLength(0);
    expect(outcome.activityProposals).toHaveLength(1);
    expect(outcome.activityProposals[0]?.reorgSource).toBeUndefined();
  });

  it("the next-day real arrival (00:55Z) flags ≥2 nodes ⇒ DayReorganizer fires with same-day moves", async () => {
    const nextDay = makeCandidate("ATL-NEXT", 80, REAL_ARRIVAL_ISO, "2026-09-02T22:30:00Z");
    const { orchestrator, reorgCalls } = makeTwinOrchestrator([nextDay]);
    const outcome = await orchestrator.resolveDisruption(makeEvent());

    // Re-drive gate: real 00:55Z > post-nominal 23:00 ⇒ ONE re-propagation
    // from the untouched baseline with the EFFECTIVE delay (145 min).
    expect(outcome.disruption.delayMinutes).toBe(145);
    const flaggedActivities = outcome.disruption.affected.filter(
      (report) => report.nodeType === "activity" && report.action === "requires_rescheduling",
    );
    expect(flaggedActivities.length).toBeGreaterThanOrEqual(2);
    expect(flaggedActivities.map((report) => report.nodeId)).toEqual([ACTIVITY_A, ACTIVITY_B]);

    // ≥2 timing-flagged activities on ONE day ⇒ the DayReorganizer fires
    // exactly once, fed with the REAL arrival floor.
    const calls = reorgCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.date).toBe("2026-09-03");
    expect(calls[0]?.newArrivalTime).toBe(REAL_ARRIVAL_ISO);
    expect(calls[0]?.activities).toHaveLength(2);

    // Moves on the ARRIVAL day — not blind next-day shifts.
    expect(outcome.activityProposals).toHaveLength(2);
    for (const proposal of outcome.activityProposals) {
      expect(proposal.action).toBe("reschedule");
      expect(proposal.reorgSource).toBe("deterministic");
      expect(proposal.newTime.slice(0, 10)).toBe("2026-09-03");
    }
    // The reorganizer packs the day from the landing, which put the "Night
    // Food Tour" at 09:55. A live battery produced the same class of answer on
    // a real trip ("Godzilla Road Night View" at 16:00), so the window floor
    // now raises a night item to the first hour it makes sense — 17:00 — and
    // this test records that rather than the morning slot it used to accept.
    expect(outcome.activityProposals[0]?.newTime).toBe("2026-09-03T17:00:00.000Z");
    expect(outcome.activityProposals[1]?.newTime).toBe("2026-09-03T12:55:00.000Z");
  });

  it("the live graph ends at the true-arrival state — no double-shift", async () => {
    const nextDay = makeCandidate("ATL-NEXT", 80, REAL_ARRIVAL_ISO, "2026-09-02T22:30:00Z");
    const graph = buildTwinGraph();
    const { stub } = arrivalAwareReorganizerStub();
    const orchestrator = new OrchestratorAgent(
      graph,
      flightStub([nextDay]),
      null,
      null,
      new ActivityAgent(noOptionsProvider()),
      null,
      null,
      stub,
    );
    await orchestrator.resolveDisruption(makeEvent());

    const flight = graph.getNode(FLIGHT_ID);
    expect(flight && flight.type === "flight" ? flight.arrivalTime : NaN).toBe(REAL_ARRIVAL_MS);
    // The hotel was deferred to the REAL arrival, not arrival + nominal.
    const hotel = graph.getNode(HOTEL_ID);
    expect(hotel?.scheduledTime).toBe(REAL_ARRIVAL_MS);
    expect(hotel?.status).toBe("updated");
  });
});

// ------------------------------------------------------ arrival-floor sweep

describe("arrival-floor sweep boundary", () => {
  /**
   * flight → transfer (03:00, generous slack ⇒ propagation never reaches
   * through it) → two activities. The sweep must flag the activity EXACTLY
   * at realArrival + 120 min and leave the one minute after it alone.
   */
  function buildSweepGraph(): ItineraryGraph {
    const graph = new ItineraryGraph();
    graph.addNode({
      id: FLIGHT_ID,
      type: "flight",
      flightNumber: "XY123",
      origin: "CDG",
      destination: "LIS",
      departureTime: FLIGHT_DEPARTURE,
      arrivalTime: FLIGHT_ARRIVAL,
      scheduledTime: FLIGHT_DEPARTURE,
      status: "on_track",
      dependsOn: [],
      arrivalLocationId: "LIS",
    });
    graph.addNode({
      id: "transfer-airport",
      type: "transfer",
      durationMinutes: 30,
      scheduledTime: Date.parse("2026-09-03T03:00:00Z"),
      status: "on_track",
      dependsOn: [FLIGHT_ID],
    });
    graph.addNode({
      id: "activity-edge",
      type: "activity",
      name: "Edge Tour",
      durationMinutes: 60,
      // Exactly realArrival (00:55) + the 120-minute buffer = 02:55.
      scheduledTime: Date.parse("2026-09-03T02:55:00Z"),
      status: "on_track",
      dependsOn: ["transfer-airport"],
    });
    graph.addNode({
      id: "activity-after",
      type: "activity",
      name: "After Tour",
      durationMinutes: 60,
      scheduledTime: Date.parse("2026-09-03T02:56:00Z"),
      status: "on_track",
      dependsOn: ["transfer-airport"],
    });
    return graph;
  }

  it("an activity EXACTLY at realArrival + buffer IS swept; one minute later is not", async () => {
    const nextDay = makeCandidate("ATL-NEXT", 80, REAL_ARRIVAL_ISO, "2026-09-02T22:30:00Z");
    const orchestrator = new OrchestratorAgent(buildSweepGraph(), flightStub([nextDay]));
    const assessment = await orchestrator.assessDisruption(makeEvent({ delay: 0 }));

    // The transfer kept its slack (125 min ≥ 15), so propagation never
    // reached the activities — the sweep is the ONLY rail that can flag them.
    const swept = assessment.disruption.affected.find(
      (report) => report.nodeId === "activity-edge",
    );
    expect(swept).toBeDefined();
    expect(swept?.action).toBe("requires_rescheduling");
    expect(swept?.reason).toContain("Arrival-floor sweep");
    expect(
      assessment.disruption.affected.some((report) => report.nodeId === "activity-after"),
    ).toBe(false);
  });
});

// --------------------------------------------------------- per-plan rederive

describe("resolveDisruptionMulti — per-plan activity rederive", () => {
  /**
   * Five non-dominated candidates converging on TWO distinct arrival ISOs.
   * EUR/USD pairs are non-comparable; ATL-5 departs the NEXT UTC day, which
   * the Pareto guard never dominates. Net order: ATL-2, ATL-4, ATL-5,
   * ATL-1, ATL-3 ⇒ arrivals [A2, A2, A1, A1, A1].
   */
  function fiveCandidatesTwoArrivals(): RebookingCandidate[] {
    return [
      makeCandidate("ATL-1", 70, REAL_ARRIVAL_ISO, "2026-09-02T20:30:00Z"),
      makeCandidate("ATL-2", 40, LATE_ARRIVAL_ISO, "2026-09-02T21:00:00Z"),
      makeCandidate("ATL-3", 75, REAL_ARRIVAL_ISO, "2026-09-02T21:15:00Z", "USD"),
      makeCandidate("ATL-4", 45, LATE_ARRIVAL_ISO, "2026-09-02T21:30:00Z", "USD"),
      makeCandidate("ATL-5", 55, REAL_ARRIVAL_ISO, "2026-09-03T00:00:00Z"),
    ];
  }

  it("5 plans / 2 arrivals ⇒ exactly 2 rederive walks, deduped by exact arrival ISO", async () => {
    const { orchestrator, reorgCalls } = makeTwinOrchestrator(fiveCandidatesTwoArrivals());
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    expect(outcome.plans).toHaveLength(5);
    expect(outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id)).toEqual([
      "ATL-2",
      "ATL-4",
      "ATL-5",
      "ATL-1",
      "ATL-3",
    ]);

    // One reorg run in the shared pipeline (best candidate = ATL-2, arrival
    // A2) + ONE walk per DISTINCT arrival — never one per plan.
    const calls = reorgCalls();
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.newArrivalTime === REAL_ARRIVAL_ISO)).toHaveLength(1);
    expect(calls.filter((call) => call.newArrivalTime === LATE_ARRIVAL_ISO)).toHaveLength(2);

    // Dedup by exact arrival ISO: plans sharing an arrival share the SAME
    // proposal-set reference (arrivals [A2, A2, A1, A1, A1]).
    const sets = outcome.planActivityProposals;
    expect(sets).toHaveLength(5);
    expect(sets[0]).toBe(sets[1]);
    expect(sets[2]).toBe(sets[3]);
    expect(sets[3]).toBe(sets[4]);
    expect(sets[0]).not.toBe(sets[2]);

    // Back-compat: the shared field stays plan-0's set.
    expect(outcome.activityProposals).toBe(sets[0]);
  });

  it("per-plan proposals differ across arrival days (each plan carries ITS OWN arrival's moves)", async () => {
    const { orchestrator } = makeTwinOrchestrator(fiveCandidatesTwoArrivals());
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent());

    const arrivalOf = (index: number): string =>
      outcome.plans[index]?.proposed_resolution.new_flight?.arrival ?? "";
    expect(arrivalOf(0)).toBe(LATE_ARRIVAL_ISO);
    expect(arrivalOf(2)).toBe(REAL_ARRIVAL_ISO);

    const a2 = outcome.planActivityProposals[0] ?? [];
    const a1 = outcome.planActivityProposals[2] ?? [];
    expect(a2).toHaveLength(2);
    expect(a1).toHaveLength(2);
    // The arrival-aware stub moves slots relative to each arrival — the two
    // sets must disagree on the actual new slots.
    // Both sets carry the SAME night tour, each raised to its own window floor
    // (17:00); the second slot is what still distinguishes the two arrivals.
    expect(a2.map((proposal) => proposal.newTime)).toEqual([
      "2026-09-03T17:00:00.000Z",
      "2026-09-03T16:30:00.000Z",
    ]);
    expect(a1.map((proposal) => proposal.newTime)).toEqual([
      "2026-09-03T17:00:00.000Z",
      "2026-09-03T12:55:00.000Z",
    ]);
    expect(JSON.stringify(a2)).not.toBe(JSON.stringify(a1));

    // Every plan still passes the TrustLayer validator.
    for (const plan of outcome.plans) {
      expect(validateResolutionPlan(plan)).toBe(true);
    }
  });
});

// ----------------------------------------------------- guardrail byte-identity

describe("guardrails — nominal behaviour stays byte-identical", () => {
  it("0 candidates ⇒ legacy and multi plans are byte-identical (canonical JSON)", async () => {
    const event = makeEvent();
    const legacy = await new OrchestratorAgent(
      buildTwinGraph(),
      flightStub([]),
      null,
      null,
      new ActivityAgent(noOptionsProvider()),
    ).resolveDisruption({ ...event });

    const multiOutcome = await new OrchestratorAgent(
      buildTwinGraph(),
      flightStub([]),
      null,
      null,
      new ActivityAgent(noOptionsProvider()),
    ).resolveDisruptionMulti({ ...event });

    expect(multiOutcome.plans).toHaveLength(1);
    // The honesty rail survives: the headline still says nothing was found.
    expect(multiOutcome.plans[0]?.incident).toContain("no replacement flight found");
    expect(legacy.plan.incident).toBe(multiOutcome.plans[0]?.incident);

    // Byte-identical canonical form — the re-drive/rederive machinery added
    // NOTHING visible to the frozen wire when no candidate exists. (The
    // additive W1 `badge`/`badges` carousel stamps are stripped first: they
    // are pre-existing carousel metadata, not pipeline output.)
    const unbadged = { ...multiOutcome.plans[0]!, badge: undefined, badges: undefined };
    expect(resolutionPlanToJson(unbadged)).toBe(resolutionPlanToJson(legacy.plan));

    // Flight-less plan ⇒ every per-plan slot carries the shared proposals.
    expect(multiOutcome.planActivityProposals).toHaveLength(1);
    expect(multiOutcome.planActivityProposals[0]).toBe(multiOutcome.activityProposals);
  });

  it("the weather-swap rail is unchanged under the re-drive (rain stays exempt from reorg)", async () => {
    // WeatherSwap fixture: flight lands 11:30, two same-day outdoor
    // activities at 13:30/15:00; nominal 4h delay; a LATE replacement makes
    // the re-drive fire — the rain-hinted requests must STILL stay on the
    // legacy swap-first rail.
    const graph = new ItineraryGraph();
    const base = Date.parse("2026-09-10T09:00:00Z");
    graph.addNode({
      id: FLIGHT_ID,
      type: "flight",
      flightNumber: "XY123",
      origin: "CDG",
      destination: "LIS",
      departureTime: base,
      arrivalTime: base + 150 * MINUTE_MS,
      scheduledTime: base,
      status: "on_track",
      dependsOn: [],
      arrivalLocationId: "LIS",
    });
    graph.addNode({
      id: ACTIVITY_A,
      type: "activity",
      name: "Surf Lesson",
      durationMinutes: 60,
      scheduledTime: base + 270 * MINUTE_MS,
      status: "on_track",
      dependsOn: [FLIGHT_ID],
    });
    graph.addNode({
      id: ACTIVITY_B,
      type: "activity",
      name: "Coastal Hike",
      durationMinutes: 90,
      scheduledTime: base + 360 * MINUTE_MS,
      status: "on_track",
      dependsOn: [FLIGHT_ID],
    });

    const indoorProvider: ActivityProvider = {
      providerName: "indoor-fake",
      async searchActivities(query: ActivitySearchQuery): Promise<ActivitySearchResult> {
        return {
          query: query.query,
          degraded: false,
          options: [
            {
              id: "OCEANARIUM-1",
              name: "Lisbon Oceanarium Ticket",
              price: 25,
              currency: "EUR",
              setting: "indoor",
              image: "https://img.example/oceanarium.jpg",
              rating: 4.8,
            },
          ],
        };
      },
    };
    const { stub, calls } = arrivalAwareReorganizerStub();
    // Replacement lands 18:00 — later than the post-nominal 15:30 ⇒ re-drive.
    const late = makeCandidate("ATL-LATE", 60, "2026-09-10T18:00:00Z", "2026-09-10T16:00:00Z");
    const orchestrator = new OrchestratorAgent(
      graph,
      flightStub([late]),
      null,
      null,
      new ActivityAgent(indoorProvider),
      null,
      null,
      stub,
    );

    const outcome = await orchestrator.resolveDisruption(
      makeEvent({
        delay: 240,
        description: "Flight XY123 delayed by 4h",
        evidence: {
          kind: "weather",
          source: "openweathermap:test",
          confidence: 0.9,
          detail: "Heavy rain 14:00-20:00 local, 92% precip probability",
        },
      }),
    );

    // The re-drive fired (effective delay 18:00 − 11:30 = 390 min)…
    expect(outcome.disruption.delayMinutes).toBe(390);
    // …yet the DayReorganizer never consumed the rain day.
    expect(calls).toHaveLength(0);
    expect(outcome.activityProposals).toHaveLength(2);
    for (const proposal of outcome.activityProposals) {
      expect(proposal.action).toBe("swap");
      expect(proposal.swap?.replacementName).toBe("Lisbon Oceanarium Ticket");
    }
  });

  it("a single flagged activity stays on the legacy per-item rail under the re-drive", async () => {
    // Same real arrival, but only ONE activity on the day (no ACTIVITY_B):
    // the ≥2-per-day gate routes it to the legacy rail even after re-drive.
    const nextDay = makeCandidate("ATL-NEXT", 80, REAL_ARRIVAL_ISO, "2026-09-02T22:30:00Z");
    const { orchestrator, reorgCalls } = makeTwinOrchestrator([nextDay], false);
    const outcome = await orchestrator.resolveDisruption(makeEvent());

    expect(outcome.disruption.delayMinutes).toBe(145);
    const flagged = outcome.disruption.affected.filter((report) => report.nodeType === "activity");
    expect(flagged).toHaveLength(1);
    expect(reorgCalls()).toHaveLength(0);
    expect(outcome.activityProposals).toHaveLength(1);
    expect(outcome.activityProposals[0]?.reorgSource).toBeUndefined();
    expect(outcome.activityProposals[0]?.action).toBe("reschedule");
  });
});

// ------------------------------------------------------------------- F5 echo

describe("F5 — answers visibly matter", () => {
  it('echoes "protecting <name>, as you asked" when activity_priority is consumed', async () => {
    const nextDay = makeCandidate("ATL-NEXT", 80, REAL_ARRIVAL_ISO, "2026-09-02T22:30:00Z");
    const { orchestrator, reorgCalls } = makeTwinOrchestrator([nextDay]);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent(), {
      activity_priority: "Night Food Tour",
    });

    expect(outcome.trace.some((note) => note === "protecting Night Food Tour, as you asked")).toBe(
      true,
    );
    // The protected name reached the day reorganizer's priority feed.
    expect(reorgCalls().every((call) => call.priorityName === "Night Food Tour")).toBe(true);
  });

  it("stays silent when the constraint was never consumed (single-activity day)", async () => {
    const nextDay = makeCandidate("ATL-NEXT", 80, REAL_ARRIVAL_ISO, "2026-09-02T22:30:00Z");
    const { orchestrator } = makeTwinOrchestrator([nextDay], false);
    const outcome = await orchestrator.resolveDisruptionMulti(makeEvent(), {
      activity_priority: "Night Food Tour",
    });

    expect(outcome.trace.some((note) => note.startsWith("protecting"))).toBe(false);
  });
});
