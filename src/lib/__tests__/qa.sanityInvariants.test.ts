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
  arrivalBuffer,
  classifyItem,
  earliestAfterLanding,
  enforceMoveSanity,
  isSleepingHour,
  placeDisplacedItem,
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
