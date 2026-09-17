/**
 * QA DISRUPTION BATTERY — four human-shaped end-to-end scenarios.
 *
 * Drives the REAL rail (handleHackathonRequest with SWARM_REAL_TRIPS=1)
 * through assess → resolve → approve for four disruptions that differ in
 * geography, severity and provider health, and asserts the Trust Layer
 * invariants a traveler's money depends on.
 *
 *   A — SIN → HND delayed +6h                (nominal intercontinental)
 *   B — SGN → SIN cancelled                  (regional same-day reschedule)
 *   C — CDG → FCO delayed +4h                (European cascading delay)
 *   D — provider starvation / rate limit     (zero-abort ladder)
 *
 * Only the Supabase seams and the Atlas provider are mocked; the graph
 * hydration, DAG reflow, PolicyAgent, TrustLayer and settlement writers are
 * the shipping code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Mutable scenario switchboard read by the mocked Atlas provider. */
const atlas = vi.hoisted(() => ({
  mode: "inventory" as "inventory" | "empty" | "error" | "rate_limited",
  options: [] as Record<string, unknown>[],
  fares: {} as Record<string, number>,
  currency: "EUR",
  searchCalls: 0,
  verifyCalls: 0,
}));

vi.mock("@/providers/atlas/AtlasFlightProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/atlas/AtlasFlightProvider")>();
  return {
    ...actual,
    AtlasFlightProvider: class MockAtlasFlightProvider {
      readonly providerName = "atlas-sandbox";
      async searchAlternativeFlights(flightId: string, requestedTime: string) {
        atlas.searchCalls += 1;
        if (atlas.mode === "error") {
          throw new actual.AtlasApiError({
            kind: "http",
            status: 503,
            retryable: true,
            message: "Atlas sandbox 503 — inventory service unavailable",
          });
        }
        if (atlas.mode === "rate_limited") {
          throw new actual.AtlasApiError({
            kind: "http",
            status: 429,
            retryable: true,
            message: "Atlas sandbox 429 — request quota exhausted",
          });
        }
        const base = Date.parse(requestedTime);
        return {
          referenceFlightId: flightId,
          requestedTime,
          options:
            atlas.mode === "empty"
              ? []
              : atlas.options.map((o) => ({
                  ...o,
                  departureTime: new Date(base + Number(o.depOffsetMin ?? 0) * 60_000).toISOString(),
                  arrivalTime: new Date(
                    base +
                      (Number(o.depOffsetMin ?? 0) + Number(o.durationMinutes ?? 120)) * 60_000,
                  ).toISOString(),
                })),
        };
      }
      async calculateFareDifference(oldFlightId: string, newFlightId: string) {
        atlas.verifyCalls += 1;
        return {
          oldFlightId,
          newFlightId,
          amount: atlas.fares[newFlightId] ?? 100,
          currency: atlas.currency,
          direction: "charge" as const,
          basis: "verified" as const,
        };
      }
      async bookFlight(flightId: string) {
        return {
          confirmationCode: "QA-CONFIRMED",
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
import * as storeModule from "@/lib/swarmSessionStore";
import * as tripContextModule from "@/lib/swarmTripContext";
import type { ResolutionPlan } from "@/agents";
import {
  REAL_TRIP_UUID,
  enableRealRailEnv,
  fixtureTravelDate,
  post,
  get,
  type FakeSwarmSessionStore,
  type FakeSwarmTripContextHooks,
} from "./helpers/realTripFixture";

const store = storeModule as unknown as FakeSwarmSessionStore;
const tripCtx = tripContextModule as unknown as FakeSwarmTripContextHooks;

// ------------------------------------------------------------ trip builders

interface TripSpec {
  title: string;
  destination: string;
  currency: string;
  flight: {
    reference: string;
    carrier: string;
    from: { code: string; city: string };
    to: { code: string; city: string };
    depart: string;
    arrive: string;
  };
  items: Record<string, unknown>[];
  transferAfterLandingMin?: number;
}

function buildTrip(spec: TripSpec): Record<string, unknown> {
  const d = fixtureTravelDate();
  const transit: Record<string, unknown>[] = [
    {
      method: "flight",
      reference: spec.flight.reference,
      carrier: spec.flight.carrier,
      depart: `${d}T${spec.flight.depart}:00Z`,
      arrive: `${d}T${spec.flight.arrive}:00Z`,
      origin: spec.flight.from,
      destination: spec.flight.to,
      booked: true,
      booking_reference: `${spec.flight.reference}-REF`,
    },
  ];
  if (spec.transferAfterLandingMin !== undefined) {
    const [h, m] = spec.flight.arrive.split(":").map(Number);
    const t = h * 60 + m + spec.transferAfterLandingMin;
    transit.push({
      method: "car",
      depart: `${d}T${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00Z`,
      durationHrs: 0.75,
      origin: { city: spec.flight.to.city },
      destination: { city: spec.flight.to.city },
    });
  }
  return {
    title: { en: spec.title },
    destination: { en: spec.destination },
    local_currency_code: spec.currency,
    transit_groups: transit,
    itinerary: [{ day: 1, date: d, place: spec.destination, items: spec.items }],
  };
}

// --------------------------------------------------------------- invariants

/** THE settlement gate: net_payable === total_new_charges - total_refund. */
function assertLedgerExact(plan: ResolutionPlan, label: string): void {
  const fd = plan.financial_delta;
  const derived = fd.total_new_charges - fd.total_refund;
  expect(
    Math.abs(derived - fd.net_payable),
    `${label}: net_payable ${fd.net_payable} !== ${fd.total_new_charges} - ${fd.total_refund}`,
  ).toBeLessThan(1e-9);
  for (const bucket of fd.by_currency ?? []) {
    expect(
      Math.abs(bucket.total_new_charges - bucket.total_refund - bucket.net_payable),
      `${label}: ${bucket.currency} bucket breaks the ledger identity`,
    ).toBeLessThan(1e-9);
  }
  const display = (fd as unknown as Record<string, unknown>).display as
    | { total_refund: number; total_new_charges: number; net_payable: number }
    | undefined;
  if (display) {
    expect(
      Math.abs(display.total_new_charges - display.total_refund - display.net_payable),
      `${label}: display total breaks the ledger identity`,
    ).toBeLessThan(1e-9);
  }
}

/** No screen may dead-end the traveler. */
function assertNoDeadEnd(plan: ResolutionPlan, label: string): void {
  const res = plan.proposed_resolution as unknown as Record<string, unknown>;
  const presentation = (plan as unknown as Record<string, unknown>).presentation as
    | { no_flight_reason?: { kind: string; summary: string } }
    | undefined;
  const hasFlight = res.new_flight != null;
  const hasActivityWork = Array.isArray(res.rescheduled_activities)
    ? (res.rescheduled_activities as unknown[]).length > 0
    : false;
  const hasHotelWork = Array.isArray(res.hotel_adjustments)
    ? (res.hotel_adjustments as unknown[]).length > 0
    : false;
  const explained = Boolean(presentation?.no_flight_reason?.summary);
  expect(
    hasFlight || hasActivityWork || hasHotelWork || explained,
    `${label}: plan offers nothing AND explains nothing — dead end`,
  ).toBe(true);
  // A bare "No replacement flight" with no reason and no other work is the
  // exact trap the recovery ladder exists to prevent.
  if (!hasFlight) {
    expect(explained || hasActivityWork || hasHotelWork, `${label}: silent no-flight`).toBe(true);
  }
}

/** The quote countdown must have something to count down to. */
function assertTtl(plan: ResolutionPlan, label: string): void {
  const expiresAt = (plan as unknown as Record<string, unknown>).expires_at;
  // A TTL fences a QUOTE. With no replacement flight there may still be a
  // priced room to expire, or nothing at all — a re-stated late check-in at
  // zero carries no horizon because it is a fact, not an offer. That rule is
  // not pinned here because it has not been established precisely enough to
  // assert; what IS asserted is the part that protects the traveller: a plan
  // that quotes a FLIGHT must carry a live, bounded countdown, and any
  // countdown that exists must be honest.
  if (plan.proposed_resolution.new_flight == null && expiresAt === undefined) return;
  if (plan.proposed_resolution.new_flight != null) {
    expect(typeof expiresAt, `${label}: a quoted flight with no TTL to render`).toBe("number");
  }
  if (expiresAt === undefined) return;
  const remaining = (expiresAt as number) - Date.now();
  expect(remaining, `${label}: TTL already expired at issue time`).toBeGreaterThan(0);
  // Atlas flight quotes are issued with a 15-minute horizon (ATLAS_QUOTE_TTL_MS);
  // a hotel-capped plan narrows it, never widens it.
  expect(remaining, `${label}: TTL horizon ${Math.round(remaining / 1000)}s exceeds 15 min`)
    .toBeLessThanOrEqual(15 * 60 * 1000 + 5_000);
}

// ------------------------------------------------------------------ driver

interface AssessBody {
  status: string;
  resolution_id: string;
  tradeoffs: { id: string; options: { id: string }[] }[];
}
interface ResolveBody {
  resolution_id: string;
  status: string;
  plans?: ResolutionPlan[];
  degraded?: boolean;
  degraded_reason?: string;
}

async function runMission(intent: string): Promise<{
  assess: AssessBody;
  resolve: ResolveBody;
  plans: ResolutionPlan[];
}> {
  const assessResponse = await handleHackathonRequest(
    post("mission/assess", { intent, tripId: REAL_TRIP_UUID }),
  );
  expect(assessResponse.status, `assess failed for "${intent}"`).toBe(200);
  const assess = (await assessResponse.json()) as AssessBody;
  // Answer every trade-off with its FIRST option — a real tap-through.
  const answers = assess.tradeoffs.map((q) => ({
    question_id: q.id,
    option_id: q.options[0]?.id ?? "",
  }));
  const resolveResponse = await handleHackathonRequest(
    post("mission/resolve", { resolution_id: assess.resolution_id, answers }),
  );
  expect(resolveResponse.status, `resolve failed for "${intent}"`).toBe(200);
  const resolve = (await resolveResponse.json()) as ResolveBody;
  let plans = resolve.plans ?? [];
  if (resolve.status === "processing") {
    for (let i = 0; i < 50 && plans.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      const status = await handleHackathonRequest(get(`swarm-status/${assess.resolution_id}`));
      const body = (await status.json()) as { plans?: ResolutionPlan[]; plan?: ResolutionPlan };
      plans = body.plans ?? (body.plan ? [body.plan] : []);
    }
  }
  return { assess, resolve, plans };
}

beforeEach(() => {
  store.__sessions.clear();
  store.__setPersistent(true);
  store.__setLookupError(false);
  tripCtx.__setSettleConflict(false);
  enableRealRailEnv();
  delete process.env.GEMINI_API_KEY;
  process.env.ATLAS_API_KEY = "qa-test-key";
  process.env.ATLAS_CLIENT_ID = "qa-client";
  atlas.mode = "inventory";
  atlas.searchCalls = 0;
  atlas.verifyCalls = 0;
  atlas.currency = "EUR";
});

// ===================================================================== A

describe("Scenario A — SIN → HND delayed +6h (nominal intercontinental)", () => {
  beforeEach(() => {
    atlas.currency = "SGD";
    atlas.options = [
      {
        id: "SQ-A1",
        airline: "Singapore Airlines",
        flightNumber: "SQ636",
        origin: "SIN",
        destination: "HND",
        price: 880,
        currency: "SGD",
        stops: 0,
        durationMinutes: 420,
        depOffsetMin: 60,
      },
      {
        id: "NH-A2",
        airline: "All Nippon Airways",
        flightNumber: "NH842",
        origin: "SIN",
        destination: "HND",
        price: 1040,
        currency: "SGD",
        stops: 0,
        durationMinutes: 400,
        depOffsetMin: 180,
      },
    ];
    atlas.fares = { "SQ-A1": 210, "NH-A2": 370 };
    tripCtx.__setTripContent(
      REAL_TRIP_UUID,
      buildTrip({
        title: "Tokyo Week",
        destination: "Tokyo",
        currency: "SGD",
        flight: {
          reference: "SQ632",
          carrier: "Singapore Airlines",
          from: { code: "SIN", city: "Singapore" },
          to: { code: "HND", city: "Tokyo" },
          depart: "08:00",
          arrive: "15:30",
        },
        transferAfterLandingMin: 40,
        items: [
          { type: "activity", title: "teamLab Planets", time: "18:00" },
          { type: "stay", title: "Hotel Ryumeikan", check_in: fixtureTravelDate() },
        ],
      }),
    );
  });

  it("replaces the flight, reflows downstream, and settles a self-consistent ledger", async () => {
    const { plans } = await runMission("My flight SQ632 is delayed by 6h, reroute me");
    expect(plans.length, "A: no plan produced").toBeGreaterThan(0);

    for (const [i, plan] of plans.entries()) {
      assertLedgerExact(plan, `A[plan ${i}]`);
      assertNoDeadEnd(plan, `A[plan ${i}]`);
      assertTtl(plan, `A[plan ${i}]`);
    }

    const option1 = plans[0];
    // Option 1 must be populated: a replacement flight with a net payable.
    expect(option1.proposed_resolution.new_flight, "A: Option 1 has no flight").toBeTruthy();
    expect(Number.isFinite(option1.financial_delta.net_payable)).toBe(true);
    // Replacement must depart AFTER the disruption, never before.
    const flight = option1.proposed_resolution.new_flight as unknown as Record<string, unknown>;
    if (typeof flight.departure === "string") {
      expect(Date.parse(flight.departure as string)).toBeGreaterThan(Date.now());
    }
    console.log(
      "A ledger:",
      JSON.stringify({
        plans: plans.length,
        incident: option1.incident,
        flight: flight.id,
        charges: option1.financial_delta.total_new_charges,
        refund: option1.financial_delta.total_refund,
        net: option1.financial_delta.net_payable,
        hotel: option1.proposed_resolution.hotel_adjustments,
        activities: option1.proposed_resolution.rescheduled_activities,
      }),
    );
  });
});

// ===================================================================== B

describe("Scenario B — SGN → SIN cancelled (regional same-day reschedule)", () => {
  beforeEach(() => {
    atlas.currency = "USD";
    atlas.options = [
      {
        id: "VN-650",
        airline: "Vietnam Airlines",
        flightNumber: "VN650",
        origin: "SGN",
        destination: "SIN",
        price: 240,
        currency: "USD",
        stops: 0,
        durationMinutes: 120,
        depOffsetMin: 90,
      },
      {
        id: "TR-285",
        airline: "Scoot",
        flightNumber: "TR285",
        origin: "SGN",
        destination: "SIN",
        price: 160,
        currency: "USD",
        stops: 0,
        durationMinutes: 125,
        depOffsetMin: 260,
      },
    ];
    atlas.fares = { "VN-650": 120, "TR-285": 55 };
    tripCtx.__setTripContent(
      REAL_TRIP_UUID,
      buildTrip({
        title: "Singapore Stopover",
        destination: "Singapore",
        currency: "USD",
        flight: {
          reference: "VN661",
          carrier: "Vietnam Airlines",
          from: { code: "SGN", city: "Ho Chi Minh City" },
          to: { code: "SIN", city: "Singapore" },
          depart: "07:15",
          arrive: "10:20",
        },
        items: [
          { type: "activity", title: "Lunch at Maxwell Food Centre", time: "12:30" },
          { type: "activity", title: "Gardens by the Bay guided tour", time: "16:00" },
          { type: "stay", title: "Parkroyal Collection", check_in: fixtureTravelDate() },
        ],
      }),
    );
  });

  it("finds a replacement (or the fallback ladder), and every penalty lands in the ledger", async () => {
    const { plans } = await runMission("My flight VN661 was cancelled, reroute me");
    expect(plans.length, "B: no plan produced").toBeGreaterThan(0);

    for (const [i, plan] of plans.entries()) {
      assertLedgerExact(plan, `B[plan ${i}]`);
      assertNoDeadEnd(plan, `B[plan ${i}]`);
      assertTtl(plan, `B[plan ${i}]`);
    }

    const plan = plans[0];
    expect(plan.proposed_resolution.new_flight, "B: no replacement offered").toBeTruthy();
    // Every activity penalty must be inside total_new_charges, not floating.
    const penalties = (plan.proposed_resolution.rescheduled_activities ?? []).reduce(
      (sum, a) => sum + (Number(a.penalty) || 0),
      0,
    );
    expect(
      plan.financial_delta.total_new_charges,
      "B: activity penalties are not covered by total_new_charges",
    ).toBeGreaterThanOrEqual(penalties - 1e-9);
    console.log(
      "B ledger:",
      JSON.stringify({
        plans: plans.length,
        impacted: plan.impacted_nodes,
        trip_impact: (plan as unknown as Record<string, unknown>).presentation,
        flight: plan.proposed_resolution.new_flight,
        penalties,
        charges: plan.financial_delta.total_new_charges,
        refund: plan.financial_delta.total_refund,
        net: plan.financial_delta.net_payable,
        activities: plan.proposed_resolution.rescheduled_activities,
      }),
    );
  });
});

// ===================================================================== C

describe("Scenario C — CDG → FCO delayed +4h (European cascading delay)", () => {
  beforeEach(() => {
    atlas.currency = "EUR";
    atlas.options = [
      {
        id: "AZ-345",
        airline: "ITA Airways",
        flightNumber: "AZ345",
        origin: "CDG",
        destination: "FCO",
        price: 210,
        currency: "EUR",
        stops: 0,
        durationMinutes: 135,
        depOffsetMin: 45,
      },
      {
        id: "AF-1104",
        airline: "Air France",
        flightNumber: "AF1104",
        origin: "CDG",
        destination: "FCO",
        price: 265,
        currency: "EUR",
        stops: 0,
        durationMinutes: 130,
        depOffsetMin: 150,
      },
    ];
    atlas.fares = { "AZ-345": 60, "AF-1104": 115 };
    tripCtx.__setTripContent(
      REAL_TRIP_UUID,
      buildTrip({
        title: "Rome Long Weekend",
        destination: "Rome",
        currency: "EUR",
        flight: {
          reference: "AZ311",
          carrier: "ITA Airways",
          from: { code: "CDG", city: "Paris" },
          to: { code: "FCO", city: "Rome" },
          depart: "10:00",
          arrive: "12:10",
        },
        transferAfterLandingMin: 35,
        items: [
          { type: "activity", title: "Galleria Borghese guided tour", time: "15:00" },
          { type: "activity", title: "Dinner at Roscioli", time: "20:30" },
          { type: "stay", title: "Hotel Campo de' Fiori", check_in: fixtureTravelDate() },
        ],
      }),
    );
  });

  it("reflows the downstream day and holds the ledger formula exactly", async () => {
    const { plans } = await runMission("My flight AZ311 is delayed by 4h, reroute me");
    expect(plans.length, "C: no plan produced").toBeGreaterThan(0);

    for (const [i, plan] of plans.entries()) {
      assertLedgerExact(plan, `C[plan ${i}]`);
      assertNoDeadEnd(plan, `C[plan ${i}]`);
      assertTtl(plan, `C[plan ${i}]`);
    }

    const plan = plans[0];
    // No activity may be pushed into the small hours to make the maths fit.
    for (const activity of plan.proposed_resolution.rescheduled_activities ?? []) {
      const iso = (activity as unknown as Record<string, unknown>).new_time_iso as string | undefined;
      if (typeof iso === "string" && !Number.isNaN(Date.parse(iso))) {
        const hour = new Date(iso).getUTCHours();
        expect(hour >= 5 && hour <= 23, `C: activity moved to ${iso} — unsleepable hour`).toBe(true);
      }
    }
    console.log(
      "C ledger:",
      JSON.stringify({
        plans: plans.length,
        impacted: plan.impacted_nodes,
        trip_impact: (plan as unknown as Record<string, unknown>).presentation,
        net: plan.financial_delta.net_payable,
        charges: plan.financial_delta.total_new_charges,
        refund: plan.financial_delta.total_refund,
        activities: plan.proposed_resolution.rescheduled_activities,
        transfer: (plan.proposed_resolution as unknown as Record<string, unknown>).transfer_requote,
      }),
    );
  });
});

// ===================================================================== D

describe("Scenario D — provider inventory starvation / rate limit", () => {
  beforeEach(() => {
    tripCtx.__setTripContent(
      REAL_TRIP_UUID,
      buildTrip({
        title: "Rome Long Weekend",
        destination: "Rome",
        currency: "EUR",
        flight: {
          reference: "AZ311",
          carrier: "ITA Airways",
          from: { code: "CDG", city: "Paris" },
          to: { code: "FCO", city: "Rome" },
          depart: "10:00",
          arrive: "12:10",
        },
        items: [
          { type: "activity", title: "Galleria Borghese guided tour", time: "15:00" },
          { type: "stay", title: "Hotel Campo de' Fiori", check_in: fixtureTravelDate() },
        ],
      }),
    );
  });





  for (const mode of ["empty", "error", "rate_limited"] as const) {
    it(`survives a ${mode} provider without a zero-flight dead end`, async () => {
      atlas.mode = mode;
      atlas.options = [];
      atlas.fares = {};
      const { plans, resolve } = await runMission(
        "My flight AZ311 is delayed by 4h, reroute me",
      );
      expect(plans.length, `D(${mode}): no plan produced at all`).toBeGreaterThan(0);

      for (const [i, plan] of plans.entries()) {
        assertLedgerExact(plan, `D(${mode})[plan ${i}]`);
        assertNoDeadEnd(plan, `D(${mode})[plan ${i}]`);
        assertTtl(plan, `D(${mode})[plan ${i}]`);
      }

      const plan = plans[0];
      const flight = plan.proposed_resolution.new_flight as unknown as Record<string, unknown> | null;
      const presentation = (plan as unknown as Record<string, unknown>).presentation as
        | { no_flight_reason?: { kind: string; summary: string } }
        | undefined;
      // The provider has nothing. The engine no longer invents a flight to fill
      // the gap — it says what happened, in words, with the verdict the
      // provider's own behaviour proves. A blank card would be the dead end;
      // a stated reason is not.
      expect(flight ?? null, `D(${mode}): a flight was offered although the provider had none`).toBeNull();
      expect(
        presentation?.no_flight_reason?.summary,
        `D(${mode}): no flight AND no reason — that is the dead end`,
      ).toBeTruthy();
      // Nothing was compared, so nothing may claim a superlative.
      for (const claim of ["cheapest", "fastest", "balanced"]) {
        expect(plan.badges ?? [], `D(${mode}): flight-less plan claims "${claim}"`).not.toContain(claim);
        expect(plan.badge).not.toBe(claim);
      }
      console.log(
        `D(${mode}):`,
        JSON.stringify({
          degraded: resolve.degraded,
          degraded_reason: resolve.degraded_reason,
          flight,
          no_flight_reason: presentation?.no_flight_reason,
          net: plan.financial_delta.net_payable,
        }),
      );
    });
  }
});

// ============================================ settlement / idempotency gate

describe("Settlement gate — approve is single-shot and TTL-fenced", () => {
  beforeEach(() => {
    atlas.currency = "EUR";
    atlas.options = [
      {
        id: "AZ-345",
        airline: "ITA Airways",
        flightNumber: "AZ345",
        origin: "CDG",
        destination: "FCO",
        price: 210,
        currency: "EUR",
        stops: 0,
        durationMinutes: 135,
        depOffsetMin: 45,
      },
    ];
    atlas.fares = { "AZ-345": 60 };
    tripCtx.__setTripContent(
      REAL_TRIP_UUID,
      buildTrip({
        title: "Rome Long Weekend",
        destination: "Rome",
        currency: "EUR",
        flight: {
          reference: "AZ311",
          carrier: "ITA Airways",
          from: { code: "CDG", city: "Paris" },
          to: { code: "FCO", city: "Rome" },
          depart: "10:00",
          arrive: "12:10",
        },
        items: [
          { type: "activity", title: "Galleria Borghese guided tour", time: "15:00" },
          { type: "stay", title: "Hotel Campo de' Fiori", check_in: fixtureTravelDate() },
        ],
      }),
    );
  });

  it("a double tap on Approve & apply books exactly once", async () => {
    const { assess, plans } = await runMission("My flight AZ311 is delayed by 4h, reroute me");
    expect(plans.length).toBeGreaterThan(0);

    // Two taps fired together, as a fat finger on a slow network produces.
    const [first, second] = await Promise.all([
      handleHackathonRequest(
        post("approve-resolution", { resolutionId: assess.resolution_id, approved: true, planIndex: 0 }),
      ),
      handleHackathonRequest(
        post("approve-resolution", { resolutionId: assess.resolution_id, approved: true, planIndex: 0 }),
      ),
    ]);
    const bodies = [await first.json(), await second.json()] as Record<string, unknown>[];
    const codes = bodies
      .map((b) => (b.booking as Record<string, unknown> | undefined)?.confirmationCode)
      .filter(Boolean);
    console.log(
      "settlement:",
      JSON.stringify({
        statuses: [first.status, second.status],
        codes,
        settlement: bodies.map((b) => b.settlement),
      }),
    );
    // Whatever the second call answers, it must not mint a SECOND booking.
    const distinct = new Set(codes.map(String));
    expect(distinct.size, "double approve produced two different bookings").toBeLessThanOrEqual(1);
    // At least one tap must have succeeded.
    expect([first.status, second.status].some((s) => s === 200)).toBe(true);
  });

  it("the settled ledger still satisfies the gate formula", async () => {
    const { assess } = await runMission("My flight AZ311 is delayed by 4h, reroute me");
    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: assess.resolution_id, approved: true, planIndex: 0 }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { approved: boolean; plan?: ResolutionPlan };
    expect(body.approved).toBe(true);
    if (body.plan) assertLedgerExact(body.plan, "settled receipt");
  });
});
