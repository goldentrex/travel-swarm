/**
 * QA — common-sense invariants for re-planned itineraries.
 *
 * Every case here is a plan that would pass the schema and still be absurd for
 * a real traveller: an activity in the middle of the night, a lunch served at
 * 21:20, a museum visit before the plane has landed, a pickup waiting at the
 * wrong airport, a flight sacrificed to protect a lunch reservation. Each must
 * be caught, corrected or dropped BEFORE a traveller reads the plan, and the
 * settlement must never write one onto their trip.
 *
 * Layers exercised:
 *   1. the pure rules (`src/core/sanity`)
 *   2. the orchestrator's proposal path, through a real OrchestratorAgent
 *   3. the settlement writer (`applySettlementToContent`)
 *   4. the HTTP rail end to end — the preview shown before approval must be
 *      exactly what approval writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── End-to-end harness mocks (hoisted; only the provider + Supabase seams) ──
const atlas = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  fares: {} as Record<string, number>,
}));

vi.mock("@/providers/atlas/AtlasFlightProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/atlas/AtlasFlightProvider")>();
  return {
    ...actual,
    AtlasFlightProvider: class {
      readonly providerName = "atlas-sandbox";
      async searchAlternativeFlights(flightId: string, requestedTime: string) {
        return { referenceFlightId: flightId, requestedTime, options: atlas.options };
      }
      async calculateFareDifference(oldFlightId: string, newFlightId: string) {
        return {
          oldFlightId,
          newFlightId,
          amount: atlas.fares[newFlightId] ?? 50,
          currency: "EUR",
          direction: "charge" as const,
          basis: "fare_difference" as const,
        };
      }
      async bookFlight(flightId: string) {
        return {
          confirmationCode: "QA-SANITY",
          flightId,
          status: "confirmed" as const,
          bookedAt: new Date().toISOString(),
        };
      }
    },
  };
});
vi.mock("@/lib/swarmAuth", async () => {
  const { makeSwarmAuthMock } = await import("./helpers/realTripFixture");
  return makeSwarmAuthMock();
});
vi.mock("@/lib/swarmSessionStore", async () => {
  const { makeSwarmSessionStoreMock } = await import("./helpers/realTripFixture");
  return makeSwarmSessionStoreMock({ persistent: true });
});
vi.mock("@/lib/swarmTripContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarmTripContext")>();
  const { makeSwarmTripContextMock } = await import("./helpers/realTripFixture");
  return makeSwarmTripContextMock(actual);
});

import {
  SemanticCritic,
  arrivalBuffer,
  classifyItem,
  earliestAfterLanding,
  enforceMoveSanity,
  isSleepingHour,
  placeDisplacedItem,
  unstayedNights,
  yieldsTo,
} from "@/core/sanity";
import { ItineraryGraph } from "@/core/dag";
import {
  OrchestratorAgent,
  applyConstraintsToCandidates,
  fareBasisOf,
} from "@/agents/orchestrator/OrchestratorAgent";
import type { FlightAgent, RebookingCandidate } from "@/agents/flight/FlightAgent";
import type { ActivityAgent, ActivityRescheduleProposal } from "@/agents/activity/ActivityAgent";
import type { HotelAgent } from "@/agents/hotel/HotelAgent";
import { validateResolutionPlan } from "@/agents/finance/TrustLayer";
import type { ResolutionPlan } from "@/agents";
import { handleHackathonRequest } from "@/lib/hackathonApi";
import * as tripContextModule from "@/lib/swarmTripContext";
import * as storeModule from "@/lib/swarmSessionStore";
import {
  REAL_TRIP_UUID,
  enableRealRailEnv,
  post,
  type FakeSwarmSessionStore,
  type FakeSwarmTripContextHooks,
} from "./helpers/realTripFixture";

const { applySettlementToContent, hydrateTripFromContent } = tripContextModule;
const store = storeModule as unknown as FakeSwarmSessionStore;
const tripCtx = tripContextModule as unknown as FakeSwarmTripContextHooks;

const MINUTE_MS = 60_000;
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`);
const DAY = "2031-03-14";

// ─────────────────────────────────────────────────────────── 1. pure rules

describe("classification and importance", () => {
  it.each([
    [{ type: "flight" }, "primary_transit"],
    [{ method: "flight" }, "primary_transit"],
    [{ type: "transit", title: "Flight AZ311 Paris → Rome" }, "primary_transit"],
    [{ type: "stay", title: "Hotel Ryumeikan" }, "lodging"],
    [{ method: "car" }, "ground_transfer"],
    [{ type: "activity", title: "Metro from the airport" }, "ground_transfer"],
    [{ type: "dining", title: "Roscioli" }, "meal"],
    [{ type: "activity", title: "Lunch at Maxwell Food Centre" }, "meal"],
    [{ type: "activity", title: "Galleria Borghese guided tour" }, "timed_activity"],
    [{ type: "activity", title: "Stroll along the Tiber" }, "soft_activity"],
  ])("%o → %s", (item, expected) => {
    expect(classifyItem(item)).toBe(expected);
  });

  it("primary transit outranks everything a lunch or a museum could be", () => {
    for (const soft of ["meal", "soft_activity", "timed_activity", "ground_transfer", "lodging"] as const) {
      expect(yieldsTo(soft, "primary_transit")).toBe(true);
      expect(yieldsTo("primary_transit", soft)).toBe(false);
    }
  });
});

describe("circadian sanity", () => {
  it("23:30–07:30 is sleeping time", () => {
    expect(isSleepingHour(at(DAY, "23:30"))).toBe(true);
    expect(isSleepingHour(at(DAY, "03:00"))).toBe(true);
    expect(isSleepingHour(at(DAY, "07:29"))).toBe(true);
    expect(isSleepingHour(at(DAY, "07:30"))).toBe(false);
    expect(isSleepingHour(at(DAY, "23:29"))).toBe(false);
  });

  it("drops a museum visit the arrival would push into the night", () => {
    const placement = placeDisplacedItem(
      { category: "timed_activity", title: "Galleria Borghese", originalMs: at(DAY, "15:00") },
      at(DAY, "23:40"),
    );
    expect(placement).toEqual({ action: "drop", reason: "outside_meal_or_opening_window" });
  });

  it("drops a lunch that could only be served at dinner time", () => {
    const placement = placeDisplacedItem(
      { category: "meal", title: "Lunch at Armando", originalMs: at(DAY, "13:00") },
      at(DAY, "21:20"),
    );
    expect(placement.action).toBe("drop");
  });

  it("keeps a dinner that simply starts later", () => {
    const placement = placeDisplacedItem(
      { category: "meal", title: "Dinner at Roscioli", originalMs: at(DAY, "20:30") },
      at(DAY, "22:00"),
    );
    expect(placement).toEqual({ action: "move", atMs: at(DAY, "22:00") });
  });

  it("lets a night activity start late — it is what it is for", () => {
    const placement = placeDisplacedItem(
      { category: "soft_activity", title: "Night market walk", originalMs: at(DAY, "20:00") },
      at(DAY, "22:45"),
    );
    expect(placement).toEqual({ action: "move", atMs: at(DAY, "22:45") });
  });

  it("never lets a cascade push a soft item onto another day's plan", () => {
    const placement = placeDisplacedItem(
      { category: "soft_activity", title: "Evening stroll", originalMs: at(DAY, "22:00") },
      at("2031-03-15", "00:30"),
    );
    expect(placement).toEqual({ action: "drop", reason: "would_move_to_another_day" });
  });

  it("never drops a bed or a ride — late check-ins and late pickups are real", () => {
    // A red-eye landing: check-in and pickup after midnight, the next calendar day.
    expect(
      placeDisplacedItem({ category: "lodging", originalMs: at(DAY, "15:00") }, at("2031-03-15", "02:10")),
    ).toEqual({ action: "move", atMs: at("2031-03-15", "02:10") });
    expect(
      placeDisplacedItem({ category: "ground_transfer", originalMs: at(DAY, "12:45") }, at("2031-03-15", "01:15")),
    ).toEqual({ action: "move", atMs: at("2031-03-15", "01:15") });
  });
});

describe("realistic arrival buffers", () => {
  it("an international arrival waits for immigration, baggage and the ride into town", () => {
    const buffer = arrivalBuffer("SIN", "HND");
    expect(buffer.international).toBe(true);
    expect(buffer.borderMinutes).toBeGreaterThan(0);
    expect(buffer.cityTransitMinutes).toBeGreaterThanOrEqual(45);
    expect(buffer.cityTransitMinutes).toBeLessThanOrEqual(90);
    // Never "zero buffer": landing → downtown hotel takes well over two hours.
    expect(buffer.readyInCityMinutes).toBeGreaterThanOrEqual(120);
    // A pickup meets the traveller in arrivals, before the ride into town.
    expect(buffer.readyForPickupMinutes).toBeLessThan(buffer.readyInCityMinutes);
  });

  it("a Schengen hop skips passport control but not the bags or the ride", () => {
    const buffer = arrivalBuffer("CDG", "FCO");
    expect(buffer.international).toBe(false);
    expect(buffer.borderMinutes).toBe(0);
    expect(buffer.readyInCityMinutes).toBe(90);
  });

  it("unknown airports keep the understood legacy default rather than a guess", () => {
    expect(arrivalBuffer("XXX", "YYY").readyInCityMinutes).toBe(90);
  });

  it("keeps the tight gap a traveller already accepted, capped at the realistic buffer", () => {
    const oldLanding = at(DAY, "12:10");
    const newLanding = at(DAY, "19:50");
    // Pickup booked 35 min after landing: stays 35 min after the new landing.
    expect(earliestAfterLanding(at(DAY, "12:45"), oldLanding, newLanding, 45)).toBe(at(DAY, "20:25"));
    // Museum 5h after landing: needs the full buffer, not 5h.
    expect(earliestAfterLanding(at(DAY, "17:10"), oldLanding, newLanding, 90)).toBe(at(DAY, "21:20"));
    // Same-time rebooking: nothing is "now impossible".
    expect(earliestAfterLanding(at(DAY, "12:45"), oldLanding, oldLanding, 45)).toBe(at(DAY, "12:45"));
  });
});

describe("proposal-time enforcement (pure)", () => {
  it("turns a retime into sleeping hours into an honest drop, same penalty", () => {
    const fixed = enforceMoveSanity({
      name: "Galleria Borghese guided tour",
      new_time: "02:00",
      new_time_iso: `${DAY}T02:00:00.000Z`,
      penalty: 12,
    });
    expect(fixed.action).toBe("drop");
    expect(fixed.penalty).toBe(12);
    expect(fixed.new_time_iso).toBeUndefined();
    expect(fixed.reason).toMatch(/^Cancelled — /);
  });

  it("brings a slot before the traveller can be in town forward to the first real one", () => {
    const fixed = enforceMoveSanity(
      { name: "Stroll along the Tiber", new_time: "14:30", new_time_iso: `${DAY}T14:30:00.000Z`, penalty: 0 },
      { readyInCityMs: at(DAY, "16:00") },
    );
    expect(fixed.action).toBeUndefined();
    expect(fixed.new_time_iso).toBe(`${DAY}T16:00:00.000Z`);
  });

  it("allows a deliberate next-day move (a rained-off activity belongs tomorrow)", () => {
    const proposal = {
      name: "Stroll along the Tiber",
      new_time: "tomorrow 10:00",
      new_time_iso: "2031-03-15T10:00:00.000Z",
      penalty: 0,
    };
    expect(enforceMoveSanity(proposal, { originalMs: at(DAY, "10:00") })).toEqual(proposal);
  });
});

// ─────────────────────────────────── 2. orchestrator proposal path (real agent)

describe("the orchestrator never shows an absurd reschedule", () => {
  const BASE = at(DAY, "09:00");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(DAY, "07:00"));
  });
  afterEach(() => vi.useRealTimers());

  function graphWithLunchAndMuseum(): ItineraryGraph {
    const graph = new ItineraryGraph();
    graph.addNode({
      id: "flight-0",
      type: "flight",
      flightNumber: "AZ311",
      origin: "CDG",
      destination: "FCO",
      departureTime: BASE,
      arrivalTime: BASE + 130 * MINUTE_MS,
      scheduledTime: BASE,
      status: "on_track",
      dependsOn: [],
      arrivalLocationId: "FCO",
    });
    graph.addNode({
      id: "activity-lunch",
      type: "activity",
      name: "Lunch at Armando",
      durationMinutes: 75,
      scheduledTime: at(DAY, "12:00"),
      status: "on_track",
      dependsOn: ["flight-0"],
    });
    graph.addNode({
      id: "activity-museum",
      type: "activity",
      name: "Galleria Borghese guided tour",
      durationMinutes: 120,
      scheduledTime: at(DAY, "15:00"),
      status: "on_track",
      dependsOn: ["flight-0"],
    });
    return graph;
  }

  function candidateLandingAt(arrivalIso: string): RebookingCandidate {
    return {
      option: {
        id: "AZ-LATE",
        airline: "ITA Airways",
        flightNumber: "AZ345",
        origin: "CDG",
        destination: "FCO",
        departureTime: new Date(Date.parse(arrivalIso) - 130 * MINUTE_MS).toISOString(),
        arrivalTime: arrivalIso,
        price: 210,
        currency: "EUR",
      },
      fareDifference: {
        oldFlightId: "flight-0",
        newFlightId: "AZ-LATE",
        amount: 60,
        currency: "EUR",
        direction: "charge",
      },
    };
  }

  function flightAgent(candidate: RebookingCandidate): FlightAgent {
    return {
      assessRebookingOptions: async (flightId: string, newTime: string) => ({
        originalFlightId: flightId,
        requestedTime: newTime,
        candidates: [candidate],
        bestCandidate: candidate,
      }),
    } as unknown as FlightAgent;
  }

  /** An activity agent that proposes exactly the absurd slots a naive one would. */
  function naiveActivityAgent(slots: Record<string, string>): ActivityAgent {
    return {
      proposeRescheduling: async (requests: Array<{ activityNodeId: string; activityName: string }>) =>
        requests.map(
          (request): ActivityRescheduleProposal => ({
            activityNodeId: request.activityNodeId,
            activityName: request.activityName,
            action: "reschedule",
            newTime: slots[request.activityNodeId] ?? `${DAY}T18:00:00.000Z`,
            penalty: 15,
            currency: "EUR",
          }),
        ),
    } as unknown as ActivityAgent;
  }

  it("offers the late flight and drops the lunch — never the other way round", async () => {
    // Flight now lands 14:00; lunch was 12:00 — the lunch yields, the flight is offered.
    const candidate = candidateLandingAt(`${DAY}T14:00:00.000Z`);
    const orchestrator = new OrchestratorAgent(
      graphWithLunchAndMuseum(),
      flightAgent(candidate),
      null,
      null,
      naiveActivityAgent({
        "activity-lunch": `${DAY}T21:20:00.000Z`, // lunch at dinner time
        "activity-museum": `${DAY}T16:30:00.000Z`, // fine
      }),
    );
    const { plan } = await orchestrator.resolveDisruption({
      nodeId: "flight-0",
      delay: 290,
      description: "Flight AZ311 delayed by 4h50",
    });

    expect(plan.proposed_resolution.new_flight?.id).toBe("AZ-LATE");
    const lunch = plan.proposed_resolution.rescheduled_activities.find((a) => a.name === "Lunch at Armando");
    expect(lunch?.action).toBe("drop");
    expect(lunch?.penalty).toBe(15);
    const museum = plan.proposed_resolution.rescheduled_activities.find((a) =>
      a.name.startsWith("Galleria Borghese"),
    );
    expect(museum?.action).toBe("reschedule");
    // Converting a move into a drop never changes the money.
    const fd = plan.financial_delta;
    expect(Math.abs(fd.total_new_charges - fd.total_refund - fd.net_payable)).toBeLessThan(1e-9);
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("no proposal ever starts before the traveller can be in town", async () => {
    const candidate = candidateLandingAt(`${DAY}T14:00:00.000Z`);
    const orchestrator = new OrchestratorAgent(
      graphWithLunchAndMuseum(),
      flightAgent(candidate),
      null,
      null,
      // The naive agent books the museum 20 minutes after touchdown.
      naiveActivityAgent({ "activity-museum": `${DAY}T14:20:00.000Z` }),
    );
    const { plan } = await orchestrator.resolveDisruption({
      nodeId: "flight-0",
      delay: 290,
      description: "Flight AZ311 delayed by 4h50",
    });
    const readyInCity = Date.parse(`${DAY}T14:00:00.000Z`) + arrivalBuffer("CDG", "FCO").readyInCityMinutes * MINUTE_MS;
    for (const activity of plan.proposed_resolution.rescheduled_activities) {
      if (activity.action === "drop" || !activity.new_time_iso) continue;
      expect(Date.parse(activity.new_time_iso)).toBeGreaterThanOrEqual(readyInCity);
    }
  });

  it("the candidate filter is blind to soft items: a flight is never filtered to protect a lunch", () => {
    const late = candidateLandingAt(`${DAY}T14:00:00.000Z`);
    const { candidates } = applyConstraintsToCandidates([late]);
    expect(candidates).toEqual([late]);
  });

  it("labels how every price was established", () => {
    const base = candidateLandingAt(`${DAY}T14:00:00.000Z`);
    expect(fareBasisOf(base)).toBe("verified");
    expect(fareBasisOf({ ...base, fareDifference: { ...base.fareDifference, basis: "search_reference" } })).toBe(
      "search_reference",
    );
    expect(
      fareBasisOf({ ...base, option: { ...base.option, inventorySource: "synthetic_recovery" } }),
    ).toBe("synthetic_estimate");
  });
});

// ────────────────────────── 2b. the multi-day shift (semantic critic)

/**
 * The failure the critic exists for, end to end.
 *
 * A traveller books SIN → NRT on 5 Nov. Every flight that day is gone; the
 * replacement lands on the SIXTH at 17:15. Narita is 75 minutes from town and
 * the arrival is international, so they are not in Tokyo until about 20:00 —
 * the next day.
 *
 * Everything on the 5th is therefore over: the room they booked for that night,
 * the 20:00 shrine visit. The engine used to re-time the shrine to 20:00 on the
 * 6th and call the room "late check-in at 20:00", both of which read as
 * perfectly reasonable and neither of which is true.
 */
describe("a replacement flight that lands the NEXT DAY", () => {
  const BOOKED = "2026-11-05";
  const LANDS = "2026-11-06";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(`${BOOKED}T06:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  function tokyoGraph(): ItineraryGraph {
    const graph = new ItineraryGraph();
    graph.addNode({
      id: "flight-0",
      type: "flight",
      flightNumber: "SQ632",
      origin: "SIN",
      destination: "NRT",
      departureTime: Date.parse(`${BOOKED}T08:00:00Z`),
      arrivalTime: Date.parse(`${BOOKED}T14:30:00Z`),
      scheduledTime: Date.parse(`${BOOKED}T08:00:00Z`),
      status: "on_track",
      dependsOn: [],
      arrivalLocationId: "NRT",
    });
    graph.addNode({
      id: "hotel-0",
      type: "hotel_check_in",
      hotelName: "Hotel Ryumeikan Tokyo",
      scheduledTime: Date.parse(`${BOOKED}T15:00:00Z`),
      status: "on_track",
      dependsOn: ["flight-0"],
    });
    graph.addNode({
      id: "activity-shrine",
      type: "activity",
      name: "Meiji Jingu Shrine",
      durationMinutes: 90,
      scheduledTime: Date.parse(`${BOOKED}T20:00:00Z`),
      status: "on_track",
      dependsOn: ["flight-0"],
    });
    return graph;
  }

  /** The replacement: same route, landing 6 Nov 17:15. */
  const nextDayCandidate: RebookingCandidate = {
    option: {
      id: "NH-844",
      airline: "ANA",
      flightNumber: "NH844",
      origin: "SIN",
      destination: "NRT",
      departureTime: `${LANDS}T09:05:00.000Z`,
      arrivalTime: `${LANDS}T17:15:00.000Z`,
      price: 480,
      currency: "USD",
    },
    fareDifference: {
      oldFlightId: "flight-0",
      newFlightId: "NH-844",
      amount: 120,
      currency: "USD",
      direction: "charge",
    },
  };

  const flightAgent = {
    assessRebookingOptions: async (flightId: string, newTime: string) => ({
      originalFlightId: flightId,
      requestedTime: newTime,
      candidates: [nextDayCandidate],
      bestCandidate: nextDayCandidate,
    }),
  } as unknown as FlightAgent;

  /** Proposes the shrine for the SAME hour on the arrival day — the naive move. */
  const activityAgent = {
    proposeRescheduling: async (
      requests: Array<{ activityNodeId: string; activityName: string }>,
    ) =>
      requests.map(
        (request): ActivityRescheduleProposal => ({
          activityNodeId: request.activityNodeId,
          activityName: request.activityName,
          action: "reschedule",
          newTime: `${LANDS}T20:00:00.000Z`,
          penalty: 0,
          currency: "USD",
        }),
      ),
  } as unknown as ActivityAgent;

  const hotelAgent = {
    assessHotelImpact: async (request: { hotelNodeId: string; hotelName: string }) => ({
      hotelNodeId: request.hotelNodeId,
      lateCheckInAvailable: true,
      cancellationFee: 0,
      currency: "USD",
      alternativeRooms: [],
      recommendation: "keep_late_checkin" as const,
      feeDelta: 0,
      note: "Late Check-in (confirmed)",
    }),
  } as unknown as HotelAgent;

  function orchestrator(critic: SemanticCritic | null) {
    return new OrchestratorAgent(
      tokyoGraph(),
      flightAgent,
      null,
      hotelAgent,
      activityAgent,
      null,
      null,
      null,
      critic,
    );
  }

  const disruption = {
    nodeId: "flight-0",
    delay: 26 * 60 + 45,
    description: "Flight SQ632 SIN → NRT cancelled",
  };

  it("drops the shrine instead of quietly moving it to the day you actually land", async () => {
    // No key ⇒ the pure rules alone, which is exactly how CI and every
    // offline deployment runs.
    const { plans } = await orchestrator(new SemanticCritic({ apiKey: "" })).resolveDisruptionMulti(
      disruption,
    );
    const shrine = plans[0].proposed_resolution.rescheduled_activities.find((a) =>
      a.name.includes("Meiji Jingu"),
    );
    expect(shrine?.action).toBe("drop");
    // …and the reason is the real one, not a schedule artefact.
    expect(shrine?.reason ?? "").toMatch(/another day|its own plan/i);
  });

  it("states the booked night that will not be used, without inventing what it costs", async () => {
    const { plans } = await orchestrator(new SemanticCritic({ apiKey: "" })).resolveDisruptionMulti(
      disruption,
    );
    const hotel = plans[0].proposed_resolution.hotel_adjustments?.[0];
    expect(hotel?.nights_unstayed).toBe(1);
    // Disclosure is NOT a charge: the property's terms for an unused night are
    // unknown to us, and a number we made up would land in a ledger the
    // traveller is asked to approve.
    expect(hotel?.fee).toBe(0);
    const fd = plans[0].financial_delta;
    expect(Math.abs(fd.total_new_charges - fd.total_refund - fd.net_payable)).toBeLessThan(1e-9);
    expect(validateResolutionPlan(plans[0])).toBe(true);
  });

  it("the model can add a venue ruling the rules cannot reach — and still not touch the money", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      is_sane: false,
                      criticisms: [
                        {
                          node_id: "activity-shrine",
                          issue_type: "CLOSED_VENUE",
                          explanation:
                            "Meiji Jingu closes at sunset, about 16:30 in November.",
                          suggested_action: "DROP",
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const withModel = orchestrator(new SemanticCritic({ apiKey: "k", fetchImpl }));
    const { plans } = await withModel.resolveDisruptionMulti(disruption);
    expect(withModel.lastCriticVerdicts[0]?.source).toBe("gemini");
    const shrine = plans[0].proposed_resolution.rescheduled_activities.find((a) =>
      a.name.includes("Meiji Jingu"),
    );
    expect(shrine?.action).toBe("drop");
    const fd = plans[0].financial_delta;
    expect(Math.abs(fd.total_new_charges - fd.total_refund - fd.net_payable)).toBeLessThan(1e-9);
  });

  it("produces the SAME plan whether or not the model was reachable", async () => {
    const offline = await orchestrator(new SemanticCritic({ apiKey: "" })).resolveDisruptionMulti(
      disruption,
    );
    const broken = await orchestrator(
      new SemanticCritic({
        apiKey: "k",
        fetchImpl: vi.fn(async () => {
          throw new Error("ECONNRESET");
        }) as unknown as typeof fetch,
      }),
    ).resolveDisruptionMulti(disruption);
    const noCriticAtAll = await orchestrator(null).resolveDisruptionMulti(disruption);

    const shape = (plan: ResolutionPlan) => ({
      flight: plan.proposed_resolution.new_flight?.id,
      activities: plan.proposed_resolution.rescheduled_activities.map((a) => [a.name, a.action]),
      nights: plan.proposed_resolution.hotel_adjustments?.[0]?.nights_unstayed,
      net: plan.financial_delta.net_payable,
    });
    expect(shape(broken.plans[0])).toEqual(shape(offline.plans[0]));
    expect(shape(noCriticAtAll.plans[0])).toEqual(shape(offline.plans[0]));
  });
});

// ───────────────────────────────────────────── 3. the settlement writer

function romeTrip(): Record<string, unknown> {
  return {
    title: { en: "Rome" },
    destination: { en: "Rome" },
    local_currency_code: "EUR",
    transit_groups: [
      {
        id: "leg-flight",
        method: "flight",
        reference: "AZ311",
        carrier: "ITA Airways",
        depart: `${DAY}T10:00`,
        arrive: `${DAY}T12:10`,
        origin: { code: "CDG", city: "Paris" },
        destination: { code: "FCO", city: "Rome Fiumicino" },
        booked: true,
        price: { amount: 150, currency: "EUR" },
      },
      {
        id: "leg-pickup",
        method: "car",
        depart: `${DAY}T12:45`,
        durationHrs: 0.75,
        origin: { code: "FCO", city: "Rome Fiumicino", terminal: "T1" },
        destination: { city: "Rome" },
        booked: true,
      },
      {
        // A day trip from town, unrelated to the landing — must not move.
        id: "leg-daytrip",
        method: "bus",
        depart: "2031-03-15T09:00",
        origin: { city: "Rome" },
        destination: { city: "Tivoli" },
      },
    ],
    itinerary: [
      {
        day: 1,
        date: DAY,
        place: "Rome",
        items: [
          { type: "dining", title: "Breakfast at the gate", time: "08:30" },
          { type: "transit", title: "Flight AZ311 Paris → Rome", time: "10:00" },
          { type: "dining", title: "Lunch at Armando", time: "13:00", booked: true },
          {
            type: "activity",
            title: "Galleria Borghese guided tour",
            time: "15:00",
            booked: true,
            paid: true,
            paid_amount: 22,
            paid_currency: "EUR",
          },
          { type: "dining", title: "Dinner at Roscioli", time: "20:30", booked: true },
          { type: "stay", title: "Hotel Campo de' Fiori", check_in: DAY, booked: true },
        ],
      },
      { day: 2, date: "2031-03-15", place: "Rome", items: [{ type: "stay", title: "Hotel Campo de' Fiori", booked: true }] },
    ],
  };
}

function settle(
  arrive: string,
  planOverrides: Partial<ResolutionPlan["proposed_resolution"]["new_flight"]> = {},
  operationalOverrides: Record<string, unknown> = {},
) {
  const content = romeTrip();
  const hydrated = hydrateTripFromContent("t", "Rome", "Rome", content)!;
  const plan: ResolutionPlan = {
    incident: "Delayed flight AZ311",
    impacted_nodes: [],
    proposed_resolution: {
      new_flight: { id: "AZ-345", cost: 210, currency: "EUR", origin: "CDG", destination: "FCO", ...planOverrides },
      rescheduled_activities: [],
    },
    financial_delta: { total_refund: 0, total_new_charges: 85, net_payable: 85 },
    requires_human_approval: true,
    currency: "EUR",
  };
  const result = applySettlementToContent(content, hydrated.nodeRefs, plan, {
    disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight AZ311" },
    new_flight: { reference: "AZ345", depart: `${DAY}T17:40:00Z`, arrive, carrier: "ITA Airways" },
    bookingCode: "SWARM-QA0001",
    ...operationalOverrides,
  });
  const next = result.content as {
    transit_groups: Array<Record<string, any>>;
    itinerary: Array<{ items: Array<Record<string, any>> }>;
    swarm_cancellations?: Array<Record<string, any>>;
  };
  const item = (title: string) => next.itinerary.flatMap((d) => d.items).find((i) => i.title === title);
  return { ...result, next, item };
}

describe("the settlement never writes an absurd trip", () => {
  it("drops the lunch and the late museum, keeps a late dinner, never touches the flight's priority", () => {
    const { item, changes } = settle(`${DAY}T19:50`);
    expect(item("Lunch at Armando")).toBeUndefined();
    expect(item("Galleria Borghese guided tour")).toBeUndefined();
    expect(item("Dinner at Roscioli")?.time).toBe("21:20");
    expect(changes.some((c) => c.startsWith("Lunch at Armando cancelled"))).toBe(true);
    expect(changes.some((c) => c.startsWith("Flight → new flight AZ345"))).toBe(true);
  });

  it("nothing on the arrival day starts before the traveller can be in town", () => {
    const { next } = settle(`${DAY}T19:50`);
    const readyInCity = at(DAY, "19:50") + arrivalBuffer("CDG", "FCO").readyInCityMinutes * MINUTE_MS;
    for (const entry of next.itinerary[0].items) {
      if (entry.type === "transit" || typeof entry.time !== "string") continue;
      if (entry.title === "Breakfast at the gate") continue; // before the old landing, never waiting on it
      expect(at(DAY, entry.time), `${entry.title} at ${entry.time}`).toBeGreaterThanOrEqual(readyInCity);
    }
  });

  it("no written activity starts in sleeping hours", () => {
    // A red-eye: lands 01:30.
    const { next } = settle("2031-03-15T01:30");
    for (const day of next.itinerary) {
      for (const entry of day.items) {
        if (entry.type === "stay" || entry.type === "transit" || typeof entry.time !== "string") continue;
        const date = (day as unknown as { date: string }).date;
        expect(isSleepingHour(at(date, entry.time)), `${entry.title} at ${entry.time}`).toBe(false);
      }
    }
  });

  it("re-anchors the airport pickup to the new arrival and says it must be re-confirmed", () => {
    const { next, followUps, changes } = settle(`${DAY}T19:50`);
    const pickup = next.transit_groups.find((leg) => leg.id === "leg-pickup")!;
    // 35 minutes after landing was the accepted gap; it is kept.
    expect(pickup.depart).toBe(`${DAY}T20:25`);
    expect(changes).toContain("Airport transfer re-timed to 20:25 to meet the new arrival");
    expect(followUps.some((f) => f.kind === "retime_pickup_with_provider")).toBe(true);
    // The unrelated day trip is untouched.
    expect(next.transit_groups.find((leg) => leg.id === "leg-daytrip")!.depart).toBe("2031-03-15T09:00");
  });

  it("moves the pickup to the new airport when the replacement lands elsewhere", () => {
    const { next } = settle(`${DAY}T19:50`, { destination: "CIA" });
    const pickup = next.transit_groups.find((leg) => leg.id === "leg-pickup")!;
    expect(pickup.origin.code).toBe("CIA");
    // A terminal written for FCO is meaningless at another airport.
    expect(pickup.origin.terminal).toBeUndefined();
    expect(next.transit_groups[0].destination.code).toBe("CIA");
  });

  it("a paid ticket that is cancelled keeps its money trail and asks for the refund", () => {
    const { next, followUps } = settle(`${DAY}T19:50`);
    const archived = next.swarm_cancellations?.find((c) => c.title === "Galleria Borghese guided tour");
    expect(archived).toMatchObject({ paid_amount: 22, paid_currency: "EUR", was_booked: true });
    expect(followUps.some((f) => f.kind === "claim_refund" && f.message.includes("22"))).toBe(true);
  });

  it("names what the cascade moved instead of counting it", () => {
    // Lands 18:50: ready in town 20:20, so the 20:30 dinner can stay but not
    // the lunch; whatever moves is named with its new time.
    const { changes } = settle(`${DAY}T18:50`);
    const cascade = changes.find((c) => c.startsWith("Arrival cascade"));
    if (cascade) expect(cascade).not.toMatch(/\d+ items? moved/);
  });

  it("never books a dinner for the minute the traveller is still dropping their bags", () => {
    const content = romeTrip();
    const hydrated = hydrateTripFromContent("t", "Rome", "Rome", content)!;
    const hotelNodeId = Object.entries(hydrated.nodeRefs).find(([, ref]) => ref.kind === "hotel")![0];
    const result = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      {
        incident: "Delayed flight AZ311",
        impacted_nodes: [],
        proposed_resolution: { new_flight: { id: "X", cost: 1, origin: "CDG", destination: "FCO" }, rescheduled_activities: [] },
        financial_delta: { total_refund: 0, total_new_charges: 0, net_payable: 0 },
        requires_human_approval: true,
      },
      {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight AZ311" },
        new_flight: { reference: "AZ345", depart: `${DAY}T17:00`, arrive: `${DAY}T19:10`, carrier: "ITA" },
        hotel_actions: [{ nodeId: hotelNodeId, action: "late_check_in", note: "late", newCheckIn: `${DAY}T20:40:00Z` }],
      },
    );
    const items = (result.content as any).itinerary[0].items as Array<Record<string, any>>;
    const dinner = items.find((i) => i.title === "Dinner at Roscioli");
    const stay = items.find((i) => i.type === "stay");
    expect(stay?.time).toBe("20:40");
    // Either the dinner waits for the bags, or it honestly cannot happen.
    if (dinner) expect(dinner.time >= "21:10").toBe(true);
  });

  it("names the booked night that goes unused when the landing slips past it", () => {
    // The replacement lands on the 15th; the room was booked for the night of
    // the 14th. That night is gone, and saying "late check-in at 20:00" would
    // hide it behind a time.
    const { changes, followUps, item } = settle(`2031-03-15T18:00:00Z`, {}, {
      hotel_actions: [
        {
          nodeId: "hotel-0-5",
          action: "late_check_in",
          note: "Check-in deferred to the replacement arrival.",
          newCheckIn: "2031-03-15T20:00:00.000Z",
        },
      ],
    });
    const stay = item("Hotel Campo de' Fiori");
    expect(stay?.nights_unstayed).toBe(1);
    expect(stay?.unstayed_from).toBe(DAY);
    // The date is IN the words, not implied by a bare clock time.
    expect(changes.some((c) => /will not be used/.test(c))).toBe(true);
    expect(changes.some((c) => /check-in moves to \w{3} \d+ \w{3} at 20:00/.test(c))).toBe(true);
    // …and the traveller is told to settle it with the property. We do not
    // know their rate's terms and will not invent a refund.
    const unused = followUps.find((f) => f.kind === "confirm_unused_night");
    expect(unused?.message).toMatch(/goes unused/);
  });

  it("does not put the unused night on top of the night that IS booked", () => {
    // Rome is a two-night stay: day 1 (the 14th) and day 2 (the 15th) each
    // carry their own row. Re-dating the 14th forward onto the 15th would
    // leave two rows for one night — the room shown twice, one of them a
    // phantom. The unused night keeps its own date and says what it is.
    const { next, item } = settle(`2031-03-15T18:00:00Z`, {}, {
      hotel_actions: [
        {
          nodeId: "hotel-0-5",
          action: "late_check_in",
          note: "Check-in deferred to the replacement arrival.",
          newCheckIn: "2031-03-15T20:00:00.000Z",
        },
      ],
    });
    const stays = next.itinerary.flatMap((d) => d.items).filter((i) => i.type === "stay");
    expect(stays).toHaveLength(2);
    // Exactly ONE room for the night of the 15th.
    const forThe15th = stays.filter((s) => (s.check_in ?? "2031-03-15") === "2031-03-15");
    expect(forThe15th).toHaveLength(1);
    // …and the 14th's row is still the 14th's, flagged as the night nobody uses.
    const unused = item("Hotel Campo de' Fiori");
    expect(unused?.check_in).toBe(DAY);
    expect(unused?.unstayed).toBe(true);
  });

  it("moves the airport ride to the day the plane actually lands", () => {
    // The live Tokyo defect, exactly: the replacement departs on the 15th and
    // lands the 16th, and the settled trip came back showing the airport bus
    // and the check-in on the 15th — hours before the traveller had even left.
    // Re-writing the clock is not enough; the ride has to change DAY.
    const content = romeTrip();
    const day1 = (content.itinerary as any[])[0];
    day1.items.push({ type: "transit", title: "Airport Limousine Bus to Rome", time: "12:45" });
    const hydrated = hydrateTripFromContent("t", "Rome", "Rome", content)!;
    const plan: ResolutionPlan = {
      incident: "Delayed flight AZ311",
      impacted_nodes: [],
      proposed_resolution: {
        new_flight: { id: "AZ-345", cost: 210, currency: "EUR", origin: "CDG", destination: "FCO" },
        rescheduled_activities: [],
      },
      financial_delta: { total_refund: 0, total_new_charges: 85, net_payable: 85 },
      requires_human_approval: true,
      currency: "EUR",
    };
    const { content: next } = applySettlementToContent(content, hydrated.nodeRefs, plan, {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight AZ311" },
      // Departs the 14th at 22:00, lands the FIFTEENTH at 06:30.
      new_flight: {
        reference: "AZ345",
        depart: `${DAY}T22:00:00Z`,
        arrive: "2031-03-15T06:30:00Z",
        carrier: "ITA Airways",
      },
      bookingCode: "SWARM-QA0002",
    });
    const days = (next.itinerary as any[]);
    const titlesOn = (date: string) =>
      (days.find((d) => d.date === date)?.items ?? []).map((i: any) => i.title);

    // The bus is GONE from the departure day…
    expect(titlesOn(DAY)).not.toContain("Airport Limousine Bus to Rome");
    // …and stands on the day the plane lands.
    expect(titlesOn("2031-03-15")).toContain("Airport Limousine Bus to Rome");
    const bus = days
      .flatMap((d: any) => d.items)
      .find((i: any) => i.title === "Airport Limousine Bus to Rome");
    // Never before the plane is on the ground. CDG→FCO is Schengen, so there
    // is no border queue: the ride keeps the 35-minute gap the traveller had
    // already accepted (capped at the real 45-minute deplane+bags buffer).
    expect(bus.time > "06:30").toBe(true);
    expect(bus.time).toBe("07:05");
  });

  it("never says a hotel needs no change on the same breath as losing its night", () => {
    // Both lines were printed about one property on a live trip.
    const { changes } = settle(`2031-03-15T18:00:00Z`, {}, {
      hotel_actions: [
        {
          nodeId: "hotel-0-5",
          action: "none",
          note: "Room policy unchanged.",
          newCheckIn: "2031-03-15T20:00:00.000Z",
        },
      ],
    });
    expect(changes.some((c) => /will not be used/.test(c))).toBe(true);
    expect(changes.some((c) => /no change needed/.test(c))).toBe(false);
  });

  it("puts every rewritten day back in running order", () => {
    // Live battery 2026-09-17: 40 of 62 settled days came back out of
    // sequence, one reading 16:30 · 21:30 · 08:00 · 11:30 · 17:00. The iOS
    // timeline re-sorts at render time so most of it was invisible, but the
    // stored trip was wrong and two paths read the array order directly.
    const content = romeTrip();
    const day1 = (content.itinerary as any[])[0];
    day1.items.push({ type: "transit", title: "Airport Limousine Bus to Rome", time: "12:45" });
    const hydrated = hydrateTripFromContent("t", "Rome", "Rome", content)!;
    const plan: ResolutionPlan = {
      incident: "Delayed flight AZ311",
      impacted_nodes: [],
      proposed_resolution: {
        new_flight: { id: "AZ-345", cost: 210, currency: "EUR", origin: "CDG", destination: "FCO" },
        rescheduled_activities: [],
      },
      financial_delta: { total_refund: 0, total_new_charges: 85, net_payable: 85 },
      requires_human_approval: true,
      currency: "EUR",
    };
    const { content: next } = applySettlementToContent(content, hydrated.nodeRefs, plan, {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight AZ311" },
      new_flight: {
        reference: "AZ345",
        depart: `${DAY}T22:00:00Z`,
        arrive: "2031-03-15T06:30:00Z",
        carrier: "ITA Airways",
      },
      bookingCode: "SWARM-QA0003",
    });

    for (const day of next.itinerary as any[]) {
      const times = (day.items ?? [])
        .map((i: any) => i.time)
        .filter((t: unknown): t is string => typeof t === "string");
      expect(times, `day ${day.date} is out of order`).toEqual([...times].sort());
    }
  });

  it("does NOT reorder a day the settlement never touched", () => {
    // A day the traveller arranged by hand keeps that arrangement — the
    // settlement only restores order on days it actually rewrote.
    const content = romeTrip();
    const day2 = (content.itinerary as any[])[1];
    day2.manual_order = true;
    day2.items = [
      { type: "activity", title: "Evening first, on purpose", time: "19:00" },
      { type: "activity", title: "Morning second, on purpose", time: "09:00" },
    ];
    const hydrated = hydrateTripFromContent("t", "Rome", "Rome", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      {
        incident: "x",
        impacted_nodes: [],
        proposed_resolution: { rescheduled_activities: [] },
        financial_delta: { total_refund: 0, total_new_charges: 0, net_payable: 0 },
        requires_human_approval: true,
        currency: "EUR",
      } as ResolutionPlan,
      { disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight AZ311" } },
    );
    const after = (next.itinerary as any[])[1];
    expect(after.items.map((i: any) => i.time)).toEqual(["19:00", "09:00"]);
    expect(after.manual_order).toBe(true);
  });

  it("a merely late arrival is still a late check-in, not a lost night", () => {
    // 01:00 on the 15th is the night of the 14th in every hotel's book.
    const { changes, followUps, item } = settle(`${DAY}T23:10:00Z`, {}, {
      hotel_actions: [
        {
          nodeId: "hotel-0-5",
          action: "late_check_in",
          note: "arrival pushed back",
          newCheckIn: "2031-03-15T01:00:00.000Z",
        },
      ],
    });
    expect(item("Hotel Campo de' Fiori")?.nights_unstayed).toBeUndefined();
    expect(changes.some((c) => /late check-in at 01:00/.test(c))).toBe(true);
    expect(followUps.some((f) => f.kind === "confirm_unused_night")).toBe(false);
  });

  it("a same-time rebooking changes nothing on the day", () => {
    const { item, changes, next } = settle(`${DAY}T12:10`);
    expect(item("Lunch at Armando")?.time).toBe("13:00");
    expect(next.transit_groups.find((leg) => leg.id === "leg-pickup")!.depart).toBe(`${DAY}T12:45`);
    expect(changes.some((c) => c.includes("cancelled") || c.includes("re-timed"))).toBe(false);
  });
});

describe("booking state after settlement is exactly what a hand booking would record", () => {
  it("a confirmed replacement is booked on the leg — the booking authority — never duplicated on its day row", () => {
    const { next, item, followUps } = settle(`${DAY}T19:50`, { fare_basis: "verified" }, { booking_status: "confirmed" });
    expect(next.transit_groups[0]).toMatchObject({
      reference: "AZ345",
      booked: true,
      booking_reference: "SWARM-QA0001",
      booking_source: "swarm_settlement",
    });
    // The restating row follows the booking by reference, but must NOT carry
    // booked/paid flags: the journey view hides it as a duplicate of the leg
    // card only while it is unflagged (a flagged copy rendered the flight twice).
    const row = item("Flight AZ345 Paris → Rome");
    expect(row?.booking_reference).toBe("SWARM-QA0001");
    expect(row?.booked).toBeUndefined();
    expect(row?.paid).toBeUndefined();
    expect(followUps.some((f) => f.kind === "book_replacement_flight")).toBe(false);
  });

  it("an indicative estimate is scheduled but NEVER recorded as a booking", () => {
    const { next, item, followUps } = settle(`${DAY}T19:50`, { fare_basis: "synthetic_estimate" });
    expect(next.transit_groups[0].booked).toBe(false);
    expect(next.transit_groups[0].booking_reference).toBeUndefined();
    expect(item("Flight AZ345 Paris → Rome")?.booking_reference).toBeUndefined();
    expect(followUps.some((f) => f.kind === "book_replacement_flight")).toBe(true);
  });

  it("an order the provider did not confirm is not a booking either", () => {
    const { next, followUps } = settle(`${DAY}T19:50`, { fare_basis: "verified" }, { booking_status: "recorded" });
    expect(next.transit_groups[0].booked).toBe(false);
    expect(followUps.some((f) => f.kind === "book_replacement_flight")).toBe(true);
  });

  it("the stay stays booked on every night — a late check-in does not un-book a hotel", () => {
    const { next } = settle(`${DAY}T19:50`);
    const nights = next.itinerary.flatMap((d) => d.items).filter((i) => i.type === "stay");
    expect(nights).toHaveLength(2);
    for (const night of nights) expect(night.booked).toBe(true);
  });
});

// ─────────────────────────────── 4. end to end: what is shown is what is done

describe("end to end: the approval preview is the settlement", () => {
  beforeEach(() => {
    store.__sessions.clear();
    store.__setPersistent(true);
    store.__setLookupError(false);
    tripCtx.__setSettleConflict(false);
    enableRealRailEnv();
    delete process.env.GEMINI_API_KEY;
    process.env.ATLAS_API_KEY = "qa";
    process.env.ATLAS_CLIENT_ID = "qa";
  });

  it("every change and follow-up approval writes was on the plan before approval", async () => {
    // A trip whose day is realistic: tomorrow, so the rail's future-date rules hold.
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    const trip = JSON.parse(JSON.stringify(romeTrip()).replaceAll(DAY, tomorrow).replaceAll("2031-03-15", "2099-01-01"));
    tripCtx.__setTripContent(REAL_TRIP_UUID, trip);
    atlas.options = [
      {
        id: "AZ-345",
        airline: "ITA Airways",
        flightNumber: "AZ345",
        origin: "CDG",
        destination: "FCO",
        // Departs after the 18:00 the +8h delay allows (earlier is refused).
        departureTime: `${tomorrow}T18:30:00.000Z`,
        arrivalTime: `${tomorrow}T20:40:00.000Z`,
        price: 210,
        currency: "EUR",
        stops: 0,
      },
    ];
    atlas.fares = { "AZ-345": 60 };

    const assess = (await (
      await handleHackathonRequest(post("mission/assess", { intent: "My flight AZ311 is delayed by 8h, reroute me", tripId: REAL_TRIP_UUID }))
    ).json()) as { resolution_id: string; tradeoffs: Array<{ id: string; options: Array<{ id: string }> }> };
    // Production re-hydrates the trip on EVERY request (loadSwarmTrip); the
    // fixture mock hydrates once and the pipeline mutates that graph in place,
    // so re-seed per request to stay faithful to the real rail.
    tripCtx.__setTripContent(REAL_TRIP_UUID, trip);
    const resolve = (await (
      await handleHackathonRequest(
        post("mission/resolve", {
          resolution_id: assess.resolution_id,
          // First option everywhere: a later option can set a minimum-departure
          // delay that (correctly) rules out this candidate.
          answers: assess.tradeoffs.map((q) => ({ question_id: q.id, option_id: q.options[0].id })),
        }),
      )
    ).json()) as { plans: ResolutionPlan[]; swarm_trace?: Array<{ agent: string; step: string; detail: string }> };
    const plan = resolve.plans[0];
    expect(plan.proposed_resolution.new_flight?.fare_basis).toBe("verified");

    // Finding 1: the late check-in is on the plan even with no hotel provider —
    // timed from THIS plan's arrival plus the realistic buffer, not the nominal delay.
    const lateCheckIn = plan.proposed_resolution.hotel_adjustments?.find((h) => h.action === "late_check_in");
    expect(lateCheckIn).toBeDefined();
    const arrival = Date.parse(plan.proposed_resolution.new_flight!.arrival!);
    const expected = new Date(arrival + arrivalBuffer("CDG", "FCO").readyInCityMinutes * MINUTE_MS).toISOString().slice(11, 16);
    expect(lateCheckIn?.note).toContain(expected);
    // Finding 3: the meal and the pickup are named, not folded into "1 activity".
    expect(plan.presentation?.trip_impact?.meals_lost).toBeGreaterThanOrEqual(1);
    expect(plan.presentation?.trip_impact?.transfers_lost).toBeGreaterThanOrEqual(1);

    const preview = plan.presentation?.settlement_preview;
    expect(preview?.changes.length).toBeGreaterThan(0);

    tripCtx.__setTripContent(REAL_TRIP_UUID, trip);
    const approved = (await (
      await handleHackathonRequest(post("approve-resolution", { resolutionId: assess.resolution_id, approved: true, planIndex: 0 }))
    ).json()) as { settlement: { changes: string[]; follow_ups?: Array<{ kind: string }> } };

    // By construction: identical change lines, identical follow-up kinds.
    expect(approved.settlement.changes).toEqual(preview!.changes);
    expect((approved.settlement.follow_ups ?? []).map((f) => f.kind).sort()).toEqual(
      preview!.follow_ups.map((f) => f.kind).sort(),
    );
  });
});
