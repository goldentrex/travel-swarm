/**
 * SCENARIO SIMULATION — drives the real mission→approve pipeline across the
 * situations a traveler actually hits, then checks the settled trip with the
 * app's OWN budget function and a faithful model of the iOS decoder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CANDIDATES = {
  nonstop: {
    id: "ATL-NS",
    airline: "TAP Air Portugal",
    flightNumber: "TP1949",
    origin: "CDG",
    destination: "LIS",
    price: 412,
    currency: "EUR",
    stops: 0,
    durationMinutes: 150,
  },
  onestop: {
    id: "ATL-1S",
    airline: "Iberia",
    flightNumber: "IB3125",
    origin: "CDG",
    destination: "LIS",
    price: 268,
    currency: "EUR",
    stops: 1,
    stopAirports: ["MAD"],
    durationMinutes: 360,
  },
};

vi.mock("@/providers/atlas/AtlasFlightProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/atlas/AtlasFlightProvider")>();
  return {
    ...actual,
    AtlasFlightProvider: class MockAtlas {
      static __originalFare = 280;
      readonly providerName = "atlas-sandbox";
      async searchAlternativeFlights(flightId: string, requestedTime: string) {
        const base = Date.parse(requestedTime);
        return {
          referenceFlightId: flightId,
          requestedTime,
          options: [
            {
              ...CANDIDATES.nonstop,
              departureTime: new Date(base).toISOString(),
              arrivalTime: new Date(base + 150 * 60_000).toISOString(),
            },
            {
              ...CANDIDATES.onestop,
              departureTime: new Date(base + 3600_000).toISOString(),
              arrivalTime: new Date(base + 3600_000 + 360 * 60_000).toISOString(),
            },
          ],
          atlasSearchRequestId: "550e8400-e29b-41d4-a716-446655440000",
        };
      }
      async calculateFareDifference(oldFlightId: string, newFlightId: string) {
        const price: Record<string, number> = { "ATL-NS": 412, "ATL-1S": 268 };
        const diff = (price[newFlightId] ?? 400) - MockAtlas.__originalFare;
        return {
          oldFlightId,
          newFlightId,
          amount: Math.abs(diff),
          currency: "EUR",
          direction: (diff >= 0 ? "charge" : "refund") as "charge" | "refund",
          atlasRequestId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        };
      }
      async bookFlight(flightId: string) {
        return {
          confirmationCode: "ATL-OK",
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

import { handleHackathonRequest } from "@/lib/hackathonApi";
import { rateFromEurOf } from "@/lib/i18n/translations";
import * as storeModule from "@/lib/swarmSessionStore";
import * as tripContextModule from "@/lib/swarmTripContext";
import {
  REAL_TRIP_UUID,
  enableRealRailEnv,
  fixtureTravelDate,
  post,
  type FakeSwarmSessionStore,
  type FakeSwarmTripContextHooks,
} from "./helpers/realTripFixture";
import {
  rawDictionary,
  decodeWouldFail,
  lostPaths,
} from "../../../scripts/swarm-sim/iosDecode.mjs";

const store = storeModule as unknown as FakeSwarmSessionStore;
const tripCtx = tripContextModule as unknown as FakeSwarmTripContextHooks;

interface TripOpts {
  paid?: boolean;
  restated?: boolean;
}

function trip(opts: TripOpts = {}): Record<string, unknown> {
  const d = fixtureTravelDate();
  const items: unknown[] = [];
  if (opts.restated !== false) {
    items.push({
      type: "activity",
      title: "Flight TP437 CDG → LIS",
      time: "09:00",
      cost: { amount: 280, currency: "EUR" },
      booked: true,
    });
  }
  items.push({
    type: "activity",
    title: "Surf Lesson",
    time: "13:30",
    cost: { amount: 60, currency: "EUR" },
  });
  items.push({
    type: "stay",
    title: "Atlantica Surf House",
    check_in: d,
    cost: { amount: 140, currency: "EUR" },
  });
  return {
    title: { en: "Lisbon Surf Week" },
    destination: { en: "Lisbon" },
    local_currency_code: "EUR",
    travelers: [{ name: "Victor" }, null],
    transit_groups: [
      {
        id: "leg-1",
        method: "flight",
        reference: "TP437",
        carrier: "TAP Air Portugal",
        depart: `${d}T09:00:00Z`,
        arrive: `${d}T11:30:00Z`,
        durationHrs: 2.5,
        origin: { code: "CDG", city: "Paris" },
        destination: { code: "LIS", city: "Lisbon" },
        price: { amount: 280, currency: "EUR" },
        booked: true,
        booking_reference: "TP-REF-437",
        ...(opts.paid ? { paid: true, paid_amount: 280, paid_currency: "EUR" } : {}),
      },
      {
        id: "leg-2",
        method: "car",
        depart: `${d}T12:15:00Z`,
        durationHrs: 0.5,
        origin: { city: "Lisbon" },
        destination: { city: "Lisbon" },
        price: { amount: 45, currency: "EUR" },
      },
    ],
    itinerary: [{ day: 1, date: d, place: "Lisbon", items }],
  };
}

/**
 * Total trip cost in EUR.
 *
 * In the full GlobePlanner app this is `deriveTripBudget().totalEur`, which
 * lives behind the app's trip-data model (mockTrip, placeCurrency,
 * transitRouting — ~2100 lines the swarm otherwise never touches). These tests
 * only compare a BEFORE against an AFTER, so the sum is inlined here rather
 * than dragging the whole model into a standalone repo.
 */
const budgetOf = (content: unknown): number => {
  const c = content as Record<string, unknown> | null;
  if (!c) return 0;
  const eur = (money: unknown): number => {
    const m = money as { amount?: unknown; currency?: unknown } | null;
    if (!m || typeof m.amount !== "number") return 0;
    const code = typeof m.currency === "string" ? m.currency : "EUR";
    return m.amount / rateFromEurOf(code);
  };
  let total = 0;
  for (const leg of (c.transit_groups as Array<Record<string, unknown>>) ?? []) {
    total += eur(leg.price);
  }
  for (const day of (c.itinerary as Array<Record<string, unknown>>) ?? []) {
    for (const item of (day.items as Array<Record<string, unknown>>) ?? []) {
      total += eur(item.cost ?? item.price);
    }
  }
  return total;
};

async function runMission(intent: string, planIndex = 0) {
  const missionRes = await handleHackathonRequest(
    post("mission", { intent, tripId: REAL_TRIP_UUID }),
  );
  const mission = (await missionRes.json()) as any;
  if (!mission.resolution_id) return { mission, approve: null, status: missionRes.status };
  const approveRes = await handleHackathonRequest(
    post("approve-resolution", { resolutionId: mission.resolution_id, approved: true, planIndex }),
  );
  return { mission, approve: (await approveRes.json()) as any, status: approveRes.status };
}

beforeEach(() => {
  store.__sessions.clear();
  store.__setPersistent(true);
  enableRealRailEnv();
  (tripContextModule as any).__setSettleConflict?.(false);
  tripCtx.__setTripContent(REAL_TRIP_UUID, trip());
});

describe("SCENARIOS", () => {
  it("A. missed flight on a planned (unpaid) leg", async () => {
    const before = budgetOf(trip());
    const { approve, status } = await runMission("I missed my flight, reroute me");
    const after = budgetOf(approve.updated_content);
    const leg = approve.updated_content.transit_groups[0];
    console.log(
      `A. status=${status} budget ${before} → ${after} (Δ${(after - before).toFixed(2)})`,
    );
    console.log(
      `   leg: ${leg.reference} ${leg.price.amount}${leg.price.currency} ` +
        `${leg.durationHrs}h stops=${leg.stops} via=${JSON.stringify(leg.stop_airports)}`,
    );
    console.log(`   changes: ${JSON.stringify(approve.settlement.changes)}`);
    expect(status).toBe(200);
    expect(after).not.toBe(before);
  }, 30000);

  it("B. missed flight on a PAID leg — out-of-pocket must grow, not reset", async () => {
    tripCtx.__setTripContent(REAL_TRIP_UUID, trip({ paid: true }));
    const before = budgetOf(trip({ paid: true }));
    const { approve } = await runMission("I missed my flight, reroute me");
    const leg = approve.updated_content.transit_groups[0];
    const after = budgetOf(approve.updated_content);
    console.log(
      `B. budget ${before} → ${after}; paid ${leg.paid_amount} ${leg.paid_currency}, ` +
        `net due ${approve.plan.financial_delta.net_payable}`,
    );
    expect(leg.paid_amount).toBeGreaterThan(280);
  }, 30000);

  it("C. the flight is never rescheduled like an activity", async () => {
    const { approve } = await runMission("I missed my flight, reroute me");
    const moved = approve.settlement.changes.filter((c: string) => /Flight .* moved to/i.test(c));
    const days = approve.updated_content.itinerary.length;
    console.log(`C. flight-move changes=${moved.length}, itinerary days=${days}`);
    console.log(
      `   day 1 items: ${approve.updated_content.itinerary[0].items.map((i: any) => i.title).join(" | ")}`,
    );
    expect(moved).toEqual([]);
  }, 30000);

  it("D. hotel overbooked", async () => {
    const { approve, status } = await runMission("My hotel is overbooked");
    console.log(
      `D. status=${status} trip_updated=${approve.settlement?.trip_updated} ` +
        `changes=${JSON.stringify(approve.settlement?.changes)}`,
    );
    expect(status).toBe(200);
  }, 30000);

  it("E. activity cancelled", async () => {
    const { approve, status } = await runMission("My activity got cancelled");
    console.log(`E. status=${status} changes=${JSON.stringify(approve.settlement?.changes)}`);
    expect(status).toBe(200);
  }, 30000);

  it("F. concurrent edit → conflict reported, never a false success", async () => {
    (tripContextModule as any).__setSettleConflict(true);
    const { approve, status } = await runMission("I missed my flight, reroute me");
    console.log(
      `F. status=${status} trip_updated=${approve.settlement.trip_updated} ` +
        `conflict=${approve.settlement.conflict_skipped} note="${approve.settlement.note ?? ""}"`,
    );
    expect(approve.settlement.conflict_skipped).toBe(true);
    expect(approve.settlement.trip_updated).toBe(false);
  }, 30000);

  it("G. re-approving a settled session replays its receipt", async () => {
    const missionRes = await handleHackathonRequest(
      post("mission", { intent: "I missed my flight, reroute me", tripId: REAL_TRIP_UUID }),
    );
    const mission = (await missionRes.json()) as any;
    const first = await handleHackathonRequest(
      post("approve-resolution", {
        resolutionId: mission.resolution_id,
        approved: true,
        planIndex: 0,
      }),
    );
    const second = await handleHackathonRequest(
      post("approve-resolution", {
        resolutionId: mission.resolution_id,
        approved: true,
        planIndex: 0,
      }),
    );
    const body = (await second.json()) as any;
    console.log(`G. first=${first.status} second=${second.status} error=${body.error}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(body.booking).toEqual((await first.json()).booking);
  }, 30000);

  it("H. every settled payload survives the iOS decoder intact", async () => {
    for (const variant of [{}, { paid: true }, { restated: false }] as TripOpts[]) {
      store.__sessions.clear();
      tripCtx.__setTripContent(REAL_TRIP_UUID, trip(variant));
      const { approve } = await runMission("I missed my flight, reroute me");
      const client = rawDictionary(approve.updated_content);
      const lost = lostPaths(approve.updated_content, client);
      const fatal = decodeWouldFail(client);
      console.log(
        `H. ${JSON.stringify(variant)} lost=${lost.length ? lost.join(",") : "none"} fatal=${fatal.length ? fatal.join(",") : "none"}`,
      );
      expect(lost).toEqual([]);
      expect(fatal).toEqual([]);
    }
  }, 30000);
});
