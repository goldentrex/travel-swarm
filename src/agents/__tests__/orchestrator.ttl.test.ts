/**
 * OrchestratorAgent TTL + ledger tests (spec §3.5).
 *
 * Specialists are stubbed with minimal fakes (constructor wiring:
 * `new OrchestratorAgent(graph, flightAgent, policyAgent, hotelAgent,
 * activityAgent)` — policy/activity agents omitted). `Date.now` is pinned
 * via fake timers so the stamped `expires_at` is deterministic:
 *
 * - flight replacement candidate present → ATLAS_QUOTE_TTL (15 min)
 * - hotel adjustments present            → HOTEL_QUOTE_TTL (30 min)
 * - both present                         → the SHORTEST TTL wins
 * - neither                              → no `expires_at` at all
 *
 * Transfer re-quote (spec §2.4): TRANSFER_REQUOTE_CHARGE = 45 is folded into
 * total_new_charges and mirrored as proposed_resolution.transfer_requote
 * when disruption.affected carries a transfer conflict whose reason starts
 * with "Spatial mismatch" — covered in the "transfer re-quote" describe
 * block below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import {
  OrchestratorAgent,
  TRANSFER_REQUOTE_CHARGE,
} from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import type {
  FlightAgent,
  FlightRebookingAssessment,
  RebookingCandidate,
} from "@/agents/flight/FlightAgent";
import type { HotelAgent, HotelAssessment, HotelImpactRequest } from "@/agents/hotel/HotelAgent";
import { validateResolutionPlan } from "@/agents/finance/TrustLayer";
import type { FareDifference, FlightOption } from "@/providers/interfaces/types";

const MINUTE_MS = 60_000;
const ATLAS_QUOTE_TTL_MS = 15 * MINUTE_MS;
const HOTEL_QUOTE_TTL_MS = 30 * MINUTE_MS;

// Fixed clock: 2026-08-22T08:00:00Z (one hour before the demo departure).
const NOW = Date.parse("2026-08-22T08:00:00Z");
// Fixed graph anchor: flight departs 09:00 UTC, lands 11:30 UTC at LIS.
const BASE = Date.parse("2026-08-22T09:00:00Z");

const FLIGHT_ID = "flight-xy123";
const TRANSFER_ID = "transfer-airport";
const HOTEL_ID = "hotel-checkin";

// ------------------------------------------------------------------ fixtures

function makeFlightOption(overrides: Partial<FlightOption> = {}): FlightOption {
  return {
    id: "ATL-SANDBOX-OFR-88431",
    airline: "Atlas Sandbox",
    flightNumber: "XY999",
    origin: "CDG",
    // Same destination as the original arrivalLocationId by default, so the
    // orchestrator's spatial re-disruption path is opt-in per test.
    destination: "LIS",
    departureTime: "2026-08-22T13:00:00Z",
    arrivalTime: "2026-08-22T15:30:00Z",
    price: 189.5,
    // Matches the plan currency (EUR default) so the fare lands in the
    // ledger bucket the legacy triple reports — no foreign-currency split.
    currency: "EUR",
    ...overrides,
  };
}

function makeFareDifference(overrides: Partial<FareDifference> = {}): FareDifference {
  return {
    oldFlightId: FLIGHT_ID,
    newFlightId: "ATL-SANDBOX-OFR-88431",
    amount: 60.5,
    currency: "EUR",
    direction: "charge",
    ...overrides,
  };
}

/** Minimal FlightAgent fake returning a configurable assessment. */
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

/** Minimal HotelAgent fake returning a configurable assessment. */
function hotelStub(feeDelta: number): HotelAgent {
  return {
    assessHotelImpact: async (request: HotelImpactRequest): Promise<HotelAssessment> => ({
      hotelNodeId: request.hotelNodeId,
      lateCheckInAvailable: true,
      cancellationFee: 0,
      currency: "USD",
      alternativeRooms: [],
      recommendation: "keep_late_checkin",
      feeDelta,
    }),
  } as unknown as HotelAgent;
}

/**
 * Flight → hotel check-in graph (hotel at 14:00; a 240-min delay pushes the
 * landing to 15:30, forcing the hotel into the `updated` impact surface).
 */
function buildFlightHotelGraph(): ItineraryGraph {
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
    scheduledTime: BASE + 300 * MINUTE_MS, // 14:00
    status: "on_track",
    dependsOn: [FLIGHT_ID],
  });
  return graph;
}

/** Demo-shaped graph with the spatially anchored transfer (LIS → LIS). */
function buildFlightTransferGraph(): ItineraryGraph {
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
    id: TRANSFER_ID,
    type: "transfer",
    durationMinutes: 30,
    scheduledTime: BASE + 195 * MINUTE_MS, // 12:15 — 45 min slack
    status: "on_track",
    dependsOn: [FLIGHT_ID],
    pickupLocationId: "LIS",
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

// --------------------------------------------------------------------- tests

describe("OrchestratorAgent quote TTL (expires_at)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the SHORTEST TTL when both a flight candidate and hotel adjustments exist", async () => {
    const candidate: RebookingCandidate = {
      option: makeFlightOption(),
      fareDifference: makeFareDifference(),
    };
    const orchestrator = new OrchestratorAgent(
      buildFlightHotelGraph(),
      flightStub(candidate),
      null, // no policy gate — keeps the ledger to fare + hotel
      hotelStub(0),
    );

    const { plan, hotelAdjustments } = await orchestrator.resolveDisruption(makeEvent());

    // Preconditions: both TTL sources are actually present.
    expect(hotelAdjustments.length).toBeGreaterThan(0);
    expect(plan.expires_at).toBeDefined();
    // Shortest TTL wins: the 15-min Atlas flight TTL, not the 30-min hotel one.
    expect(plan.expires_at).toBe(NOW + ATLAS_QUOTE_TTL_MS);
    expect(plan.expires_at).toBeLessThanOrEqual(NOW + ATLAS_QUOTE_TTL_MS);
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("stamps the hotel TTL when only hotel adjustments exist", async () => {
    const orchestrator = new OrchestratorAgent(
      buildFlightHotelGraph(),
      flightStub(null), // no replacement candidate
      null,
      hotelStub(0),
    );

    const { plan, hotelAdjustments } = await orchestrator.resolveDisruption(makeEvent());

    expect(hotelAdjustments.length).toBeGreaterThan(0);
    expect(plan.expires_at).toBe(NOW + HOTEL_QUOTE_TTL_MS);
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("omits expires_at when neither a flight candidate nor hotel adjustments exist", async () => {
    const orchestrator = new OrchestratorAgent(
      buildFlightHotelGraph(),
      flightStub(null),
      null,
      hotelStub(0),
    );

    // Small delay: nothing downstream is impacted (hotel keeps its slot).
    const { plan, hotelAdjustments, disruption } = await orchestrator.resolveDisruption(
      makeEvent({ delay: 30 }),
    );

    expect(disruption.affected).toEqual([]);
    expect(hotelAdjustments).toEqual([]);
    expect(plan.expires_at).toBeUndefined();
    expect("expires_at" in plan).toBe(false);
    expect(validateResolutionPlan(plan)).toBe(true);
  });
});

describe("OrchestratorAgent financial ledger invariant", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("net_payable === total_new_charges − total_refund with fare charge + hotel fee", async () => {
    const candidate: RebookingCandidate = {
      option: makeFlightOption(),
      fareDifference: makeFareDifference({ amount: 60.5, direction: "charge" }),
    };
    const orchestrator = new OrchestratorAgent(
      buildFlightHotelGraph(),
      flightStub(candidate),
      null,
      hotelStub(20), // hotel-side fee flows into total_new_charges
    );

    const { plan } = await orchestrator.resolveDisruption(makeEvent());
    const delta = plan.financial_delta;

    expect(delta.total_new_charges).toBeCloseTo(60.5 + 20, 10);
    expect(delta.total_refund).toBe(0);
    expect(delta.net_payable).toBeCloseTo(delta.total_new_charges - delta.total_refund, 10);
    // The validator enforces the same arithmetic as a hard gate.
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("books a fare refund into total_refund with a negative net_payable", async () => {
    const candidate: RebookingCandidate = {
      option: makeFlightOption(),
      fareDifference: makeFareDifference({ amount: 30, direction: "refund" }),
    };
    const orchestrator = new OrchestratorAgent(
      buildFlightHotelGraph(),
      flightStub(candidate),
      null,
      hotelStub(0),
    );

    const { plan } = await orchestrator.resolveDisruption(makeEvent());
    const delta = plan.financial_delta;

    expect(delta.total_refund).toBe(30);
    expect(delta.total_new_charges).toBe(0);
    expect(delta.net_payable).toBe(-30);
    expect(delta.net_payable).toBe(delta.total_new_charges - delta.total_refund);
    expect(validateResolutionPlan(plan)).toBe(true);
  });
});

describe("OrchestratorAgent spatial transfer conflict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces the DAG spatial conflict in the plan when the replacement lands elsewhere", async () => {
    // Replacement flight lands at OPO while the transfer picks up at LIS →
    // the orchestrator's delay-0 spatial re-disruption must flag the transfer.
    const candidate: RebookingCandidate = {
      option: makeFlightOption({ destination: "OPO" }),
      fareDifference: makeFareDifference(),
    };
    const orchestrator = new OrchestratorAgent(buildFlightTransferGraph(), flightStub(candidate));

    const { plan, disruption } = await orchestrator.resolveDisruption(makeEvent({ delay: 30 }));

    const transferReport = disruption.affected.find((report) => report.nodeId === TRANSFER_ID);
    expect(transferReport).toBeDefined();
    expect(transferReport?.action).toBe("conflict");
    expect(transferReport?.reason).toBe(
      "Spatial mismatch: Upstream flight arrives at a different location (OPO instead of LIS).",
    );
    expect(plan.impacted_nodes).toContain("Transfer");
    // Ledger invariant still holds through the spatial path.
    expect(plan.financial_delta.net_payable).toBe(
      plan.financial_delta.total_new_charges - plan.financial_delta.total_refund,
    );
    expect(validateResolutionPlan(plan)).toBe(true);
  });
});

describe("OrchestratorAgent transfer re-quote (spec §2.4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Shared scenario: replacement flight re-routed CDG → OPO (was LIS). */
  async function resolveReroutedScenario() {
    const candidate: RebookingCandidate = {
      option: makeFlightOption({ destination: "OPO" }),
      fareDifference: makeFareDifference({ amount: 60.5, direction: "charge" }),
    };
    const orchestrator = new OrchestratorAgent(buildFlightTransferGraph(), flightStub(candidate));
    return orchestrator.resolveDisruption(makeEvent({ delay: 30 }));
  }

  it("folds the 45 re-quote charge into total_new_charges on a spatial transfer conflict", async () => {
    const { plan } = await resolveReroutedScenario();
    const delta = plan.financial_delta;

    // Fare charge (60.5) + transfer re-quote (45) — no refunds in this path.
    expect(delta.total_new_charges).toBeCloseTo(60.5 + TRANSFER_REQUOTE_CHARGE, 10);
    expect(delta.total_new_charges).toBe(105.5);
    expect(delta.total_refund).toBe(0);
    expect(delta.net_payable).toBeCloseTo(delta.total_new_charges - delta.total_refund, 10);
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("surfaces proposed_resolution.transfer_requote with amount 45 and the spatial reason", async () => {
    const { plan } = await resolveReroutedScenario();

    const requote = plan.proposed_resolution.transfer_requote;
    expect(requote).toBeDefined();
    expect(requote?.amount).toBe(TRANSFER_REQUOTE_CHARGE);
    expect(requote?.amount).toBe(45);
    // From the NEW arrival airport to the transfer's original pickup.
    expect(requote?.from).toBe("OPO");
    expect(requote?.to).toBe("LIS");
    expect(requote?.reason).toBe(
      "Spatial mismatch: Upstream flight arrives at a different location (OPO instead of LIS).",
    );
    expect(requote?.reason.startsWith("Spatial mismatch")).toBe(true);
  });

  it("omits transfer_requote and the 45 charge when no spatial conflict occurs", async () => {
    // Same scenario but the replacement keeps the original destination (LIS):
    // no spatial mismatch, and the 30-min delay alone leaves the transfer's
    // slack exactly at the buffer (no chronological conflict either).
    const candidate: RebookingCandidate = {
      option: makeFlightOption({ destination: "LIS" }),
      fareDifference: makeFareDifference({ amount: 60.5, direction: "charge" }),
    };
    const orchestrator = new OrchestratorAgent(buildFlightTransferGraph(), flightStub(candidate));

    const { plan, disruption } = await orchestrator.resolveDisruption(makeEvent({ delay: 30 }));

    expect(disruption.affected.some((report) => report.reason.startsWith("Spatial mismatch"))).toBe(
      false,
    );
    expect("transfer_requote" in plan.proposed_resolution).toBe(false);
    expect(plan.proposed_resolution.transfer_requote).toBeUndefined();
    // Ledger carries the fare charge only — no 45 re-quote term.
    expect(plan.financial_delta.total_new_charges).toBe(60.5);
    expect(plan.financial_delta.net_payable).toBe(
      plan.financial_delta.total_new_charges - plan.financial_delta.total_refund,
    );
    expect(validateResolutionPlan(plan)).toBe(true);
  });
});

describe("OrchestratorAgent hotel-source disruption (hotel overbooked)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fans the HotelAgent out over the disrupted hotel SOURCE and stamps the 30-min TTL", async () => {
    // Regression: handleDisruption re-times the source node in place and
    // reports only the DOWNSTREAM surface, so a hotel_check_in SOURCE never
    // entered disruption.affected — the hotel fan-out was structurally empty
    // and no expires_at was ever emitted (the hotelOverbooked E2E failure).
    const orchestrator = new OrchestratorAgent(
      buildFlightHotelGraph(),
      flightStub(null),
      null,
      hotelStub(25), // hotel fee flows into total_new_charges
    );

    const { plan, hotelAdjustments, disruption } = await orchestrator.resolveDisruption(
      makeEvent({
        nodeId: HOTEL_ID,
        delay: 240,
        description: "Hotel overbooked at Atlantica Surf House",
      }),
    );

    // The graph's own report still excludes the source node…
    expect(disruption.affected).toEqual([]);
    // …yet the orchestrator's hotel fan-out covers it.
    expect(hotelAdjustments.length).toBe(1);
    expect(hotelAdjustments[0]?.hotel_name).toBe("Atlantica Surf House");
    // The hotel change is surfaced in the plan's "what we'll change" summary.
    expect(plan.proposed_resolution.hotel_adjustments).toEqual(hotelAdjustments);
    expect(plan.impacted_nodes).toContain("Hotel Check-in (Atlantica Surf House)");
    // The 30-minute hotel quote TTL is stamped (hotel-only → it wins).
    expect(plan.expires_at).toBe(NOW + HOTEL_QUOTE_TTL_MS);
    // Ledger invariant holds through the hotel-source path.
    expect(plan.financial_delta.total_new_charges).toBe(25);
    expect(plan.financial_delta.total_refund).toBe(0);
    expect(plan.financial_delta.net_payable).toBe(
      plan.financial_delta.total_new_charges - plan.financial_delta.total_refund,
    );
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("keeps flight-source behaviour unchanged (hotel stays a downstream report)", async () => {
    const orchestrator = new OrchestratorAgent(
      buildFlightHotelGraph(),
      flightStub(null),
      null,
      hotelStub(0),
    );

    const { plan, hotelAdjustments, disruption } = await orchestrator.resolveDisruption(
      makeEvent(), // flight source, 240-min delay → hotel enters `affected`
    );

    expect(disruption.affected.some((report) => report.nodeId === HOTEL_ID)).toBe(true);
    expect(hotelAdjustments.length).toBe(1);
    expect(plan.expires_at).toBe(NOW + HOTEL_QUOTE_TTL_MS);
    expect(validateResolutionPlan(plan)).toBe(true);
  });
});
