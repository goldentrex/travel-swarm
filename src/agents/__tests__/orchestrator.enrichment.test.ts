/**
 * Phase B (B3/B4) — OrchestratorAgent contract enrichment tests.
 *
 * Covers the additive plan fields the orchestrator now emits:
 *  - `currency` from trip context (default "EUR" on the demo graph)
 *  - enriched `new_flight` (origin/destination/airline/departure/arrival/currency)
 *  - `rescheduled_activities[].new_time_iso` + `reason` (penalty rationale)
 *  - `hotel_adjustments[].alternative` presentation feed
 *
 * Specialists are stubbed exactly like orchestrator.ttl.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { OrchestratorAgent } from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import type {
  FlightAgent,
  FlightRebookingAssessment,
  RebookingCandidate,
} from "@/agents/flight/FlightAgent";
import type { HotelAgent, HotelAssessment, HotelImpactRequest } from "@/agents/hotel/HotelAgent";
import type {
  ActivityAgent,
  ActivityRescheduleProposal,
  ActivityRescheduleRequest,
} from "@/agents/activity/ActivityAgent";
import { validateResolutionPlan } from "@/agents/finance/TrustLayer";
import type { FareDifference, FlightOption } from "@/providers/interfaces/types";

const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-08-22T08:00:00Z");
const BASE = Date.parse("2026-08-22T09:00:00Z");

const FLIGHT_ID = "flight-xy123";
const HOTEL_ID = "hotel-checkin";
const ACTIVITY_ID = "activity-surf";

function makeFlightOption(overrides: Partial<FlightOption> = {}): FlightOption {
  return {
    id: "ATL-SANDBOX-OFR-88431",
    airline: "Atlas Sandbox",
    flightNumber: "XY999",
    origin: "CDG",
    destination: "LIS",
    departureTime: "2026-08-22T13:00:00Z",
    arrivalTime: "2026-08-22T15:30:00Z",
    price: 189.5,
    currency: "USD",
    ...overrides,
  };
}

function makeFareDifference(overrides: Partial<FareDifference> = {}): FareDifference {
  return {
    oldFlightId: FLIGHT_ID,
    newFlightId: "ATL-SANDBOX-OFR-88431",
    amount: 60.5,
    currency: "USD",
    direction: "charge",
    ...overrides,
  };
}

function flightStub(bestCandidate: RebookingCandidate | null): FlightAgent {
  return {
    assessRebookingOptions: async (
      flightId: string,
      newTime: string,
    ): Promise<FlightRebookingAssessment> => ({
      originalFlightId: flightId,
      requestedTime: newTime,
      candidates: bestCandidate ? [bestCandidate] : [],
      bestCandidate,
    }),
  } as unknown as FlightAgent;
}

function hotelStub(assessment: Partial<HotelAssessment>): HotelAgent {
  return {
    assessHotelImpact: async (request: HotelImpactRequest): Promise<HotelAssessment> => ({
      hotelNodeId: request.hotelNodeId,
      lateCheckInAvailable: true,
      cancellationFee: 0,
      currency: "EUR",
      alternativeRooms: [],
      recommendation: "keep_late_checkin",
      feeDelta: 0,
      ...assessment,
    }),
  } as unknown as HotelAgent;
}

function activityStub(proposals: ActivityRescheduleProposal[]): ActivityAgent {
  return {
    proposeRescheduling: async (_requests: ActivityRescheduleRequest[]) => proposals,
  } as unknown as ActivityAgent;
}

/** Flight → hotel check-in + activity (both downstream of the flight). */
function buildGraph(): ItineraryGraph {
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
  graph.addNode({
    id: HOTEL_ID,
    type: "hotel_check_in",
    hotelName: "Atlantica Surf House",
    scheduledTime: BASE + 300 * MINUTE_MS,
    status: "on_track",
    dependsOn: [FLIGHT_ID],
  });
  graph.addNode({
    id: ACTIVITY_ID,
    type: "activity",
    name: "Surf Lesson",
    durationMinutes: 60,
    scheduledTime: BASE + 270 * MINUTE_MS,
    status: "on_track",
    dependsOn: [FLIGHT_ID],
  });
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

describe("OrchestratorAgent Phase B enrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enriches new_flight from the chosen option and passes validation", async () => {
    const option = makeFlightOption({
      origin: "CDG",
      destination: "OPO",
      airline: "Atlas Demo",
      departureTime: "2026-08-22T13:00:00Z",
      arrivalTime: "2026-08-22T15:30:00Z",
      currency: "EUR",
    });
    const candidate: RebookingCandidate = { option, fareDifference: makeFareDifference() };
    const orchestrator = new OrchestratorAgent(buildGraph(), flightStub(candidate));

    const { plan } = await orchestrator.resolveDisruption(makeEvent());

    expect(plan.proposed_resolution.new_flight).toMatchObject({
      id: option.id,
      cost: option.price,
      origin: "CDG",
      destination: "OPO",
      airline: "Atlas Demo",
      departure: "2026-08-22T13:00:00Z",
      arrival: "2026-08-22T15:30:00Z",
      currency: "EUR",
    });
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("defaults currency to EUR and honours tripContext.currency when present", async () => {
    const orchestrator = new OrchestratorAgent(buildGraph(), flightStub(null));

    const demo = await orchestrator.resolveDisruption(makeEvent());
    expect(demo.plan.currency).toBe("EUR");

    const orchestrator2 = new OrchestratorAgent(buildGraph(), flightStub(null));
    const hydrated = await orchestrator2.resolveDisruption(
      makeEvent({ tripContext: { city: "New York", currency: "USD" } }),
    );
    expect(hydrated.plan.currency).toBe("USD");
    expect(validateResolutionPlan(demo.plan)).toBe(true);
    expect(validateResolutionPlan(hydrated.plan)).toBe(true);
  });

  it("threads new_time_iso and the penalty rationale into rescheduled_activities", async () => {
    const rationale =
      "Change lands inside the 24h window before start, so Viator's standard policy applies a flat 15 service charge.";
    const proposal: ActivityRescheduleProposal = {
      activityNodeId: ACTIVITY_ID,
      action: "reschedule",
      newTime: "2026-08-23T13:30:00Z",
      penalty: 15,
      currency: "EUR",
      rationale,
    };
    const orchestrator = new OrchestratorAgent(
      buildGraph(),
      flightStub(null),
      null,
      null,
      activityStub([proposal]),
    );

    const { plan } = await orchestrator.resolveDisruption(makeEvent());

    const entry = plan.proposed_resolution.rescheduled_activities[0];
    expect(entry).toBeDefined();
    expect(entry.name).toBe("Surf Lesson");
    // Human label (Tomorrow, since the move crosses midnight UTC)…
    expect(entry.new_time).toBe("Tomorrow 13:30");
    // …plus the additive machine-readable ISO + rationale.
    expect(entry.new_time_iso).toBe("2026-08-23T13:30:00Z");
    expect(entry.reason).toBe(rationale);
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("omits reason when the proposal carries no rationale (absent = valid)", async () => {
    const proposal: ActivityRescheduleProposal = {
      activityNodeId: ACTIVITY_ID,
      action: "reschedule",
      newTime: "2026-08-23T13:30:00Z",
      penalty: 0,
      currency: "EUR",
    };
    const orchestrator = new OrchestratorAgent(
      buildGraph(),
      flightStub(null),
      null,
      null,
      activityStub([proposal]),
    );

    const { plan } = await orchestrator.resolveDisruption(makeEvent());
    const entry = plan.proposed_resolution.rescheduled_activities[0];
    expect(entry.new_time_iso).toBe("2026-08-23T13:30:00Z");
    expect("reason" in entry).toBe(false);
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("attaches the best alternative room to hotel_adjustments for the presentation layer", async () => {
    const orchestrator = new OrchestratorAgent(
      buildGraph(),
      flightStub(null),
      null,
      hotelStub({
        lateCheckInAvailable: false,
        cancellationFee: 0,
        recommendation: "rebook_room",
        feeDelta: 0,
        currency: "EUR",
        alternativeRooms: [
          {
            roomId: "room-1",
            hotelName: "Atlantica Annex",
            ratePerNight: 120,
            currency: "EUR",
            freeCancellationUntil: "2026-08-21T18:00:00Z",
            images: ["https://img.example/1.jpg"],
            latitude: 38.7,
            longitude: -9.1,
          },
        ],
      }),
    );

    const { plan, hotelAdjustments } = await orchestrator.resolveDisruption(makeEvent());

    expect(hotelAdjustments.length).toBeGreaterThan(0);
    const adjustment = plan.proposed_resolution.hotel_adjustments?.[0];
    expect(adjustment?.action).toBe("rebook");
    expect(adjustment?.alternative).toMatchObject({
      name: "Atlantica Annex",
      ratePerNight: 120,
      currency: "EUR",
      freeCancellationUntil: "2026-08-21T18:00:00Z",
      lat: 38.7,
      lng: -9.1,
      images: ["https://img.example/1.jpg"],
    });
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("keeps hotel_adjustments without alternative when no replacement rooms exist", async () => {
    const orchestrator = new OrchestratorAgent(
      buildGraph(),
      flightStub(null),
      null,
      hotelStub({ recommendation: "keep_late_checkin", feeDelta: 0 }),
    );

    const { plan } = await orchestrator.resolveDisruption(makeEvent());
    const adjustment = plan.proposed_resolution.hotel_adjustments?.[0];
    expect(adjustment?.action).toBe("late_check_in");
    expect(adjustment?.alternative).toBeUndefined();
    expect(validateResolutionPlan(plan)).toBe(true);
  });
});
