/**
 * REAL-RAIL hackathon API LIVE-path contract tests (WS5 — demo rail retired).
 *
 * Everything runs with the production gate ON (SWARM_REAL_TRIPS=1 + bearer)
 * against the shared fixture trip (helpers/realTripFixture.ts):
 *   - Atlas provider mocked at the module boundary (constructor never throws
 *     ⇒ `atlasConfigured: true`; one CDG→LIS candidate landing at the
 *     ORIGINAL destination ⇒ no spatial transfer re-quote)
 *   - session store mocked as PERSISTENT (makeSwarmSessionStoreMock)
 *   - swarmTripContext partially mocked — the REAL hydrate/settle
 *     transformers run; only the Supabase seams are stubbed
 *
 * Expected deterministic ledger: fare difference 150 + FALLBACK_FARE_RULE
 * change fee 25 = 175 EUR net.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/providers/atlas/AtlasFlightProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/atlas/AtlasFlightProvider")>();
  return {
    ...actual,
    AtlasFlightProvider: class MockAtlasFlightProvider {
      /** Test hook: override the fare returned by calculateFareDifference. */
      static __fareOverride: { amount: number; currency: string } | null = null;
      /**
       * Test hooks for the liveness proof: correlation ids returned by the
       * mocked envelopes (ON by default — the mock plays a LIVE sandbox),
       * plus a switch to make the search call fail (degraded-rail tests).
       */
      static __correlation: { search: string; verify: string } | null = {
        search: "550e8400-e29b-41d4-a716-446655440000",
        verify: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      };
      static __failSearch = false;
      readonly providerName = "atlas-sandbox";
      async searchAlternativeFlights(flightId: string, requestedTime: string) {
        if (MockAtlasFlightProvider.__failSearch) {
          throw new Error("simulated sandbox outage");
        }
        return {
          referenceFlightId: flightId,
          requestedTime,
          // Single candidate at the ORIGINAL destination — no spatial
          // conflict on the fixture's LIS transfer.
          options: [
            {
              id: "ATL-OFR-1",
              airline: "Atlas Sandbox",
              flightNumber: "XY456",
              origin: "CDG",
              destination: "LIS",
              departureTime: requestedTime,
              arrivalTime: requestedTime,
              price: 200,
              currency: "EUR",
            },
          ],
          ...(MockAtlasFlightProvider.__correlation
            ? { atlasSearchRequestId: MockAtlasFlightProvider.__correlation.search }
            : {}),
        };
      }
      async calculateFareDifference(oldFlightId: string, newFlightId: string) {
        const override = MockAtlasFlightProvider.__fareOverride;
        return {
          oldFlightId,
          newFlightId,
          amount: override?.amount ?? 150,
          currency: override?.currency ?? "EUR",
          direction: "charge" as const,
          ...(MockAtlasFlightProvider.__correlation
            ? { atlasRequestId: MockAtlasFlightProvider.__correlation.verify }
            : {}),
        };
      }
      async bookFlight(flightId: string) {
        return {
          confirmationCode: "ATL-CONFIRMED",
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
import { AtlasFlightProvider } from "@/providers/atlas/AtlasFlightProvider";
import * as storeModule from "@/lib/swarmSessionStore";
import * as tripContextModule from "@/lib/swarmTripContext";
import type { ResolutionPlan, ResolutionPresentation } from "@/agents";
import {
  REAL_TRIP_UUID,
  enableRealRailEnv,
  get,
  post,
  realTripContent,
  type FakeSwarmSessionStore,
  type FakeSwarmTripContextHooks,
} from "./helpers/realTripFixture";

const store = storeModule as unknown as FakeSwarmSessionStore;
const tripCtx = tripContextModule as unknown as FakeSwarmTripContextHooks;

beforeEach(() => {
  store.__sessions.clear();
  store.__setPersistent(true);
  store.__setLookupError(false);
  enableRealRailEnv();
  tripCtx.__setTripContent(REAL_TRIP_UUID, realTripContent());
  const providerHooks = AtlasFlightProvider as unknown as {
    __failSearch: boolean;
    __correlation: { search: string; verify: string } | null;
  };
  providerHooks.__failSearch = false;
  providerHooks.__correlation = {
    search: "550e8400-e29b-41d4-a716-446655440000",
    verify: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  };
});

afterEach(() => {
  const providerHooks = AtlasFlightProvider as unknown as { __failSearch: boolean };
  providerHooks.__failSearch = false;
});

interface MissionBody {
  resolution_id: string;
  plan: ResolutionPlan;
  swarm_trace: { agent: string; step: string; detail: string }[];
  degraded: boolean;
  degraded_reason?: string;
}

function runMission(): Promise<Response> {
  return handleHackathonRequest(
    post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
  );
}

describe("live real-trip mission — full pipeline", () => {
  it("runs the PolicyAgent on the fallback fare rule and keeps the ledger invariant", async () => {
    const response = await runMission();
    expect(response.status).toBe(200);
    const body = (await response.json()) as MissionBody;

    // Healthy provider + persistent store ⇒ NOT degraded, no reason field.
    expect(body.degraded).toBe(false);
    expect(body.degraded_reason).toBeUndefined();

    // Policy gate ran on the fallback rule: rebook permitted, 25 EUR fee.
    const policyTrace = body.swarm_trace.find(
      (entry) => entry.agent === "policy" && entry.step === "fare_rules",
    );
    expect(policyTrace).toBeDefined();
    expect(policyTrace?.detail).toContain("rebook permitted");
    expect(body.plan.proposed_resolution.policy_verdict?.changeFee).toBe(25);
    expect(body.plan.proposed_resolution.policy_verdict?.rebookPermitted).toBe(true);

    // Deterministic ledger: fare difference 150 + change fee 25 — the
    // candidate lands at LIS, so NO spatial transfer re-quote applies.
    const delta = body.plan.financial_delta;
    expect(delta.total_new_charges).toBe(175);
    expect(delta.total_refund).toBe(0);
    expect(delta.net_payable).toBe(175);
    expect(body.plan.proposed_resolution.transfer_requote).toBeUndefined();
  });

  it("pushes a finance trace row after Trust Layer validation", async () => {
    const response = await runMission();
    const body = (await response.json()) as MissionBody;

    const financeTrace = body.swarm_trace.find((entry) => entry.agent === "finance");
    expect(financeTrace).toBeDefined();
    expect(financeTrace?.step).toBe("ledger_check");
    expect(financeTrace?.detail).toBe("ledger balanced: +175 −0 = 175 EUR net");
  });

  it("pins the fare_basis trace row with the honest full-reprice wording", async () => {
    const response = await runMission();
    const body = (await response.json()) as MissionBody;

    // The fixture trip carries NO original fare (no price/paid facts on the
    // leg) and the mocked provider returns no basis ⇒ the trace must carry
    // the honest "full verified re-price" wording, never a fabricated delta.
    const fareBasisTrace = body.swarm_trace.find(
      (entry) => entry.agent === "flight" && entry.step === "fare_basis",
    );
    expect(fareBasisTrace).toBeDefined();
    expect(fareBasisTrace?.detail).toBe(
      "original fare unknown — quoting full verified re-price as the charge",
    );
  });

  it("emits the additive atlas_liveness trace row with truncated correlation ids", async () => {
    const response = await runMission();
    const body = (await response.json()) as MissionBody;

    // Live scenario: the mocked envelopes carry search.do + verify.do
    // correlation ids ⇒ the ADDITIVE flight/atlas_liveness row quotes them,
    // each truncated to 12 chars (uuid prefixes).
    const liveness = body.swarm_trace.find(
      (entry) => entry.agent === "flight" && entry.step === "atlas_liveness",
    );
    expect(liveness).toBeDefined();
    expect(liveness?.detail).toBe("Atlas sandbox live — search 550e8400-e29 · verify f47ac10b-58c");
    // Never the full ids.
    expect(liveness?.detail).not.toContain("a716");
    expect(liveness?.detail).not.toContain("d479");
    // Frozen rows stay untouched: search + fare_basis still present.
    expect(
      body.swarm_trace.some((entry) => entry.agent === "flight" && entry.step === "search"),
    ).toBe(true);
  });

  it("reports the provider failure honestly, without fabricating atlas_liveness", async () => {
    const providerHooks = AtlasFlightProvider as unknown as { __failSearch: boolean };
    providerHooks.__failSearch = true;

    const response = await runMission();
    const body = (await response.json()) as MissionBody;

    // Provider failure ⇒ an honest empty answer, not an invented flight.
    expect(body.degraded).toBe(false);
    expect(body.plan.incident).toContain("needs a manual booking");
    expect(body.plan.proposed_resolution.new_flight).toBeUndefined();
    // No correlation ids on the degraded rail ⇒ NO liveness row, ever.
    expect(body.swarm_trace.some((entry) => entry.step === "atlas_liveness")).toBe(false);
  });

  it("the assess rail persists the flight/atlas_liveness row with truncated ids", async () => {
    // Two-phase phase 1: the SAME mocked envelopes carry correlation ids, so
    // the assess pipeline must emit the additive liveness row exactly like
    // the /mission rail. The assess response is trace-less — the row lives
    // on the persisted `gathering_preferences` session.
    const response = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      resolution_id: string;
    };
    expect(body.status).toBe("gathering_preferences");

    const session = store.__sessions.get(body.resolution_id);
    expect(session).toBeDefined();
    expect(session?.state).toBe("gathering_preferences");
    const trace = (session?.trace ?? []) as MissionBody["swarm_trace"];

    const liveness = trace.find(
      (entry) => entry.agent === "flight" && entry.step === "atlas_liveness",
    );
    expect(liveness).toBeDefined();
    expect(liveness?.detail).toBe("Atlas sandbox live — search 550e8400-e29 · verify f47ac10b-58c");
    // 12-char truncation only — never the full envelope ids.
    expect(liveness?.detail).not.toContain("a716");
    expect(liveness?.detail).not.toContain("d479");
  });

  it("enriches new_flight from the Atlas candidate and defaults currency to EUR", async () => {
    const response = await runMission();
    const body = (await response.json()) as MissionBody;

    expect(body.plan.currency).toBe("EUR");
    expect(body.plan.proposed_resolution.new_flight).toMatchObject({
      id: "ATL-OFR-1",
      cost: 200, // published price of the chosen candidate
      origin: "CDG",
      destination: "LIS",
      airline: "Atlas Sandbox",
      currency: "EUR",
    });
    expect(body.plan.proposed_resolution.new_flight?.departure).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.plan.proposed_resolution.new_flight?.arrival).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The live plan names the fixture flight and carries NO degraded suffix.
    expect(body.plan.incident).toBe("Delayed flight TP437");
  });

  it("assembles the presentation block with map points and ledger summary", async () => {
    const response = await runMission();
    const body = (await response.json()) as MissionBody;

    const presentation = body.plan.presentation as ResolutionPresentation | undefined;
    expect(presentation).toBeDefined();

    // Map points from the static IATA table: CDG (origin) + LIS (new).
    const kinds = presentation?.map_points?.map((point) => point.kind).sort();
    expect(kinds).toEqual(["airport_new", "airport_origin"]);
    const origin = presentation?.map_points?.find((point) => point.kind === "airport_origin");
    expect(origin?.label).toBe("Paris CDG");
    expect(origin?.lat).toBeCloseTo(49.0097, 3);
    const destination = presentation?.map_points?.find((point) => point.kind === "airport_new");
    expect(destination?.label).toBe("Lisbon");

    // Self-explanatory ledger lines with direction prefixes, matching the
    // validated delta. The mock provider returns NO basis (⇒ `full_fare`), so
    // the charge carries the companion line saying it is the whole ticket
    // rather than a delta. It must not assert the original was "already
    // paid" — `full_fare` also covers legs the traveler never booked.
    const lines = presentation?.ledger_summary ?? [];
    expect(lines).toContain("You pay now — new ticket: +€150.00");
    expect(lines).toContain(
      "This is the full ticket price, not a difference — no fare on file to refund",
    );
    expect(lines).toContain("You pay now — change fee: +€25.00");
    expect(lines).toContain("Total due now: €175.00");
    // The old bare "Net payable" lines are gone.
    expect(lines.some((line) => line.startsWith("Net payable"))).toBe(false);

    // No hotel/activity providers configured ⇒ those blocks stay absent.
    expect(presentation?.hotel).toBeUndefined();
    expect(presentation?.activity_swap).toBeUndefined();
  });

  it("the enriched plan approves to a confirmed booking AND settles the real trip", async () => {
    const mission = await runMission();
    const { resolution_id: resolutionId } = (await mission.json()) as { resolution_id: string };

    const approval = await handleHackathonRequest(
      post("approve-resolution", { resolutionId, approved: true }),
    );
    expect(approval.status).toBe(200);
    const body = (await approval.json()) as {
      approved: boolean;
      booking: { confirmationCode: string; status: string };
      settlement: {
        booking_recorded: boolean;
        trip_updated: boolean;
        changes: string[];
        content_rev?: number;
      };
      updated_content?: { transit_groups: Record<string, unknown>[] };
    };
    expect(body.approved).toBe(true);
    expect(body.booking.confirmationCode).toBe("ATL-CONFIRMED");
    expect(body.booking.status).toBe("confirmed");
    expect(body.settlement.booking_recorded).toBe(true);

    // Real-trip settlement rewrote the fixture's flight leg in content_json.
    expect(body.settlement.trip_updated).toBe(true);
    expect(body.settlement.changes.length).toBeGreaterThan(0);
    // Additive post-write content rev rides along with the settlement.
    expect(typeof body.settlement.content_rev).toBe("number");
    const flightLeg = body.updated_content?.transit_groups?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(flightLeg?.reference).toBe("XY456"); // the booked candidate's number
    expect(flightLeg?.booked).toBe(true);
    expect(String(flightLeg?.booking_reference ?? "").startsWith("SWARM-")).toBe(true);
    // The session was consumed exactly once.
    expect(store.__sessions.get(resolutionId)?.state).toBe("settled");
  });
});

describe("mixed-currency fare segregation (USD fare, EUR plan)", () => {
  const mockProvider = AtlasFlightProvider as unknown as {
    __fareOverride: { amount: number; currency: string } | null;
  };

  beforeEach(() => {
    mockProvider.__fareOverride = { amount: 150, currency: "USD" };
  });
  afterEach(() => {
    mockProvider.__fareOverride = null;
  });

  it("segregates the foreign fare into its own bucket — never converts, never mixes", async () => {
    const response = await runMission();
    expect(response.status).toBe(200);
    const body = (await response.json()) as MissionBody;

    // Two buckets: ledger currency (EUR, change fee only) first, USD second.
    const delta = body.plan.financial_delta;
    expect(delta.by_currency).toHaveLength(2);
    expect(delta.by_currency?.[0]).toEqual({
      currency: "EUR",
      total_refund: 0,
      total_new_charges: 25,
      net_payable: 25,
    });
    expect(delta.by_currency?.[1]).toEqual({
      currency: "USD",
      total_refund: 0,
      total_new_charges: 150,
      net_payable: 150,
    });

    // No all-zero buckets. `bucketOf(ledgerCurrency)` is created
    // unconditionally for local-service terms, so a trip whose ledger
    // currency carries none emitted an empty bucket — and because the legacy
    // scalars ARE that bucket, `net_payable` read 0 while real money was owed
    // in other currencies (the "JP¥0" headline on a JPY trip).
    for (const bucket of delta.by_currency ?? []) {
      expect(bucket.total_new_charges !== 0 || bucket.total_refund !== 0).toBe(true);
    }

    // Legacy triple reports the ledger-currency bucket ONLY.
    expect(delta.total_refund).toBe(0);
    expect(delta.total_new_charges).toBe(25);
    expect(delta.net_payable).toBe(25);

    // Mixed ledger trace: one segment per bucket, ledger bucket first.
    const financeTrace = body.swarm_trace.find((entry) => entry.agent === "finance");
    expect(financeTrace?.detail).toBe(
      "ledger balanced: +25 −0 = 25 EUR net · +150 −0 = 150 USD net",
    );

    // Presentation: flight line in the fare's TRUE currency, and ONE total
    // listing every currency. A separate "Total due now: …" per bucket
    // printed the same label twice, which reads as two competing totals
    // rather than one bill payable in two currencies. Still segregated —
    // the amounts are never summed or converted into each other.
    const lines =
      (body.plan.presentation as ResolutionPresentation | undefined)?.ledger_summary ?? [];
    expect(lines).toContain("You pay now — new ticket: +$150.00");
    expect(lines).toContain("You pay now — change fee: +€25.00");
    expect(lines).toContain("Total due now: €25.00 + $150.00");
    expect(lines.filter((line) => line.startsWith("Total due now"))).toHaveLength(1);
  });
});

describe("live health snapshot", () => {
  it("reports atlasConfigured + storePersistent true with mocked provider/store", async () => {
    // Hermetic: `viatorEdgeConfigured()` probes the SUPABASE creds (the
    // activity path is a Supabase Edge Function), so an ambient SUPABASE_URL
    // in the developer's or CI runner's environment would otherwise flip
    // `activityConfigured` and fail this assertion for the wrong reason.
    const savedUrl = process.env.SUPABASE_URL;
    const savedServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const savedPublishable = process.env.SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    const restoreEnv = (): void => {
      if (savedUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = savedUrl;
      if (savedServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = savedServiceKey;
      if (savedPublishable === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
      else process.env.SUPABASE_PUBLISHABLE_KEY = savedPublishable;
    };

    let response: Response;
    try {
      response = await handleHackathonRequest(get("health"));
    } finally {
      restoreEnv();
    }
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.atlasConfigured).toBe(true);
    expect(body.storePersistent).toBe(true);
    expect(body.hotelConfigured).toBe(false); // no RapidAPI creds in tests
    expect(body.activityConfigured).toBe(false); // no Viator creds in tests
    // Additive honest billing note (mirrored in src/providers/atlas/README.md).
    expect(body.atlasBillingNote).toBe(
      "Atlas sandbox billing is quota-based; fare search credits are not deducted per request — live usage with 100% credits is expected.",
    );
  });
});
