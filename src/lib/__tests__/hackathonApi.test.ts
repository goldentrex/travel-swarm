/**
 * REAL-RAIL hackathon API contract tests (WS5 — demo rail retired).
 *
 * Every test runs with the production gate ON (SWARM_REAL_TRIPS=1 + bearer
 * token) against the shared fixture trip (helpers/realTripFixture.ts). The
 * real hydrateTripFromContent / applySettlementToContent transformers stay
 * live; only the Supabase seams are mocked:
 *   - swarmSessionStore  → in-memory fake (persistence flag controllable,
 *     lookup failures injectable) via makeSwarmSessionStoreMock
 *   - swarmTripContext   → PARTIAL mock (loadSwarmTrip / settlePlanOnTrip
 *     stubbed) via makeSwarmTripContextMock
 *
 * No ATLAS_API_KEY is present: FLIGHT missions run the graph-only DEGRADED
 * rail (provider fallback flight XY999), while NON-FLIGHT missions run LIVE
 * with a null flight agent (clarity pass — the flight limb degrades only).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/swarmAuth", async () => {
  const { makeSwarmAuthMock } = await import("./helpers/realTripFixture");
  return makeSwarmAuthMock();
});

vi.mock("@/lib/swarmSessionStore", async () => {
  const { makeSwarmSessionStoreMock } = await import("./helpers/realTripFixture");
  return makeSwarmSessionStoreMock({ persistent: false });
});

vi.mock("@/lib/swarmTripContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarmTripContext")>();
  const { makeSwarmTripContextMock } = await import("./helpers/realTripFixture");
  return makeSwarmTripContextMock(actual);
});

import { buildOperational, handleHackathonRequest } from "@/lib/hackathonApi";
import type { HackathonContext } from "@/lib/hackathonApi";
import * as storeModule from "@/lib/swarmSessionStore";
import * as tripContextModule from "@/lib/swarmTripContext";
import { hydrateTripFromContent } from "@/lib/swarmTripContext";
import { OrchestratorAgent } from "@/agents";
import type { ResolutionPlan } from "@/agents";
import type { RebookingCandidate } from "@/agents/flight/FlightAgent";
import type { FareDifference, FlightOption } from "@/providers/interfaces/types";
import {
  REAL_TRIP_UUID,
  enableRealRailEnv,
  fixtureTravelDate,
  get,
  post,
  realTripContent,
  type FakeSwarmSessionStore,
  type FakeSwarmTripContextHooks,
} from "./helpers/realTripFixture";

const store = storeModule as unknown as FakeSwarmSessionStore;
const tripCtx = tripContextModule as unknown as FakeSwarmTripContextHooks;

/** Bookable-shaped plan (passes the approve pre-checks). */
function bookablePlan(overrides: Partial<ResolutionPlan> = {}): ResolutionPlan {
  return {
    incident: "Delayed flight TP437 (simulated — flight provider unavailable)",
    impacted_nodes: ["Flight TP437"],
    proposed_resolution: {
      new_flight: { id: "XY999", cost: 150 },
      rescheduled_activities: [],
    },
    financial_delta: { total_refund: 0, total_new_charges: 150, net_payable: 150 },
    requires_human_approval: true,
    ...overrides,
  };
}

beforeEach(() => {
  store.__sessions.clear();
  store.__setPersistent(false);
  store.__setLookupError(false);
  delete process.env.ATLAS_API_KEY;
  enableRealRailEnv();
  tripCtx.__setTripContent(REAL_TRIP_UUID, realTripContent());
});

describe("GET /api/hackathon/health", () => {
  it("returns configuration booleans + time and NEVER echoes secrets", async () => {
    const response = await handleHackathonRequest(get("health"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.atlasConfigured).toBe(false); // no ATLAS_API_KEY in tests
    expect(typeof body.hotelConfigured).toBe("boolean");
    expect(typeof body.activityConfigured).toBe("boolean");
    expect(body.storePersistent).toBe(false); // mocked memory-only store
    // Live store probe — the fake reports its persistence flag (false here).
    expect(typeof body.storeHealthy).toBe("boolean");
    // Additive provenance field: host of the resolved Atlas base URL.
    expect(typeof body.atlasSandboxHost).toBe("string");
    expect(typeof body.time).toBe("number");
    // Booleans/numbers only — no env values may leak into the payload.
    // The two permitted string keys (`atlasSandboxHost`, `atlasBillingNote`)
    // are intentional, non-secret, documented provenance fields.
    for (const [key, value] of Object.entries(body)) {
      if (key === "atlasSandboxHost" || key === "atlasBillingNote") continue;
      expect(typeof value === "boolean" || typeof value === "number").toBe(true);
    }
  });

  it("distinguishes CONFIGURED from actually REACHABLE", async () => {
    // The whole point of the field split: `activityConfigured` used to be
    // `Boolean(SUPABASE_URL && SUPABASE_KEY)`, so health stayed green through
    // a deleted Edge Function or a rotated key.
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    process.env.RAPIDAPI_KEY = "stale";
    process.env.RAPIDAPI_HOST = "hotels.example.com";
    const { __resetReachabilityCache } = await import("@/lib/swarmReachability");
    __resetReachabilityCache();
    // Upstream answers, but rejects our credentials.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );

    const body = (await (await handleHackathonRequest(get("health"))).json()) as Record<
      string,
      unknown
    >;

    expect(body.activityConfigured).toBe(true); // env vars are present…
    expect(body.activityReachable).toBe(true); // …and the host answered.
    // RapidAPI's gateway DOES reject a stale key, so the split is visible.
    expect(body.hotelConfigured).toBe(true);
    expect(body.hotelReachable).toBe(true);
    expect(body.hotelAuthorized).toBe(false);
    // The activity function does not verify its key at all, so health must
    // NOT claim anything about those credentials.
    expect("activityAuthorized" in body).toBe(false);

    vi.unstubAllGlobals();
    __resetReachabilityCache();
    delete process.env.RAPIDAPI_KEY;
    delete process.env.RAPIDAPI_HOST;
  });

  it("omits reachability for a provider it never probed", async () => {
    // No ATLAS_API_KEY in tests: "never probed" must not render as `false`,
    // which would report a DOWN upstream we never asked about.
    const body = (await (await handleHackathonRequest(get("health"))).json()) as Record<
      string,
      unknown
    >;
    expect(body.atlasConfigured).toBe(false);
    expect("atlasReachable" in body).toBe(false);
    expect("atlasAuthorized" in body).toBe(false);
  });

  it("rejects non-GET on the health endpoint", async () => {
    const response = await handleHackathonRequest(post("health", {}));
    expect(response.status).toBe(405);
  });
});

describe("bearer gate (SWARM_REAL_TRIPS=1)", () => {
  it("rejects requests without a bearer token — even GET health", async () => {
    const response = await handleHackathonRequest(get("health", null));
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("unauthorized");
  });

  it("rejects a wrong bearer token on the mission endpoint", async () => {
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }, "wrong-token"),
    );
    expect(response.status).toBe(401);
  });
});

describe("real-trip mission contract — tripId required", () => {
  it("missing tripId → 400 trip_required", async () => {
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("trip_required");
  });

  it("non-uuid tripId → 400 trip_required (the demo rail is gone)", async () => {
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: "demo-lisbon" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("trip_required");
  });

  it("uuid trip that cannot hydrate → 404 trip_not_hydratable", async () => {
    tripCtx.__setTripContent(REAL_TRIP_UUID, null);

    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("trip_not_hydratable");
  });

  it("free-text we do not understand is refused, not answered", async () => {
    // It used to answer. "Tell me a joke" became a mission on the first
    // upcoming node, and on the live Worker the same path turned "my suitcase
    // didn't arrive" into three flight rebookings at 2,306,617 IDR. A
    // confident answer to a question we did not understand is the most
    // expensive failure this system has.
    const response = await handleHackathonRequest(
      post("mission", { intent: "tell me a joke", tripId: REAL_TRIP_UUID }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("out_of_scope");
    // And the refusal has to be useful: it names what the swarm does handle.
    expect(body.message).toMatch(/missed or delayed flights/i);
  });
});

describe("trip store failure → retryable 503 (rotated-key regression)", () => {
  it("assess answers 503 session_store_unavailable when the trip load store fails", async () => {
    tripCtx.__setTripStoreError(true);

    const response = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, string>;
    // iOS friendlyError already maps this exact wire code — retryable.
    expect(body.error).toBe("session_store_unavailable");

    tripCtx.__setTripStoreError(false);
  });
});

describe("approve-resolution matrix", () => {
  it("degraded session → 409 degraded_plan_not_bookable", async () => {
    store.__seed({ id: "res_degraded", degraded: true, plan: bookablePlan() });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_degraded", approved: true }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("degraded_plan_not_bookable");
    expect(store.__sessions.get("res_degraded")?.state).toBe("proposal_ready");
  });

  it("degraded session with NO flight in the plan still applies", async () => {
    // Caught in the settlement battery of 2026-09-18: a weather mission on
    // the Bali trip — swap an outdoor activity for an indoor one, no flight
    // anywhere in it — was refused 409 "cannot be booked" because Atlas
    // happened to be unreachable. There was nothing to book: the plan moves
    // activities on the traveller's own itinerary, and blocking it leaves
    // them unable to act on advice we had already given them.
    store.__seed({
      id: "res_degraded_activity",
      degraded: true,
      plan: bookablePlan({
        incident: "Heavy rain in Seminyak",
        impacted_nodes: ["Seminyak Beach Morning Stroll"],
        proposed_resolution: {
          rescheduled_activities: [
            { name: "Seminyak Beach Morning Stroll", new_time: "Today 15:00", penalty: 0 },
          ],
        },
        financial_delta: { total_refund: 0, total_new_charges: 0, net_payable: 0 },
      }),
    });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_degraded_activity", approved: true }),
    );

    expect(response.status).not.toBe(409);
  });


  it("flight-less plan approves with a locally recorded booking (flight-only 409 gate removed)", async () => {
    // Hotel/activity/transfer plans settle the trip without ever calling the
    // flight provider — the old 409 plan_not_bookable pre-check is gone.
    const flightless = bookablePlan();
    flightless.proposed_resolution.new_flight = { id: "", cost: 0 };
    store.__seed({ id: "res_flightless", degraded: false, plan: flightless });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_flightless", approved: true }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approved: boolean;
      booking: { status: string; source: string };
      settlement: { booking_recorded: boolean; trip_updated: boolean };
    };
    expect(body.approved).toBe(true);
    expect(body.booking.status).toBe("recorded");
    expect(body.booking.source).toBe("swarm_settlement");
    expect(body.settlement.booking_recorded).toBe(false);
    expect(body.settlement.trip_updated).toBe(false); // no operational layer → no settlement
    // The session was consumed exactly once.
    expect(store.__sessions.get("res_flightless")?.state).toBe("settled");
  });

  it("healthy session → 200 with a locally recorded booking (no provider in dev)", async () => {
    store.__seed({ id: "res_healthy", degraded: false, plan: bookablePlan() });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_healthy", approved: true }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approved: boolean;
      booking: { confirmationCode: string; status: string; source?: string };
      settlement: { booking_recorded: boolean };
    };
    expect(body.approved).toBe(true);
    expect(body.booking.status).toBe("recorded");
    expect(body.booking.source).toBe("swarm_settlement");
    expect(body.booking.confirmationCode.startsWith("SWARM-")).toBe(true);
    expect(body.settlement.booking_recorded).toBe(false);
    // Session was consumed exactly once.
    expect(store.__sessions.get("res_healthy")?.state).toBe("settled");
  });

  it("an indicative synthetic flight stays approvable and is recorded without Atlas booking", async () => {
    const plan = bookablePlan();
    plan.proposed_resolution.new_flight = {
      id: "SYNTHETIC-RECOVERY-SIN-DPS-2026-09-18",
      cost: 182,
      origin: "SIN",
      destination: "DPS",
      airline: "Scoot (indicative fallback)",
      flight_number: "TR285",
    };
    store.__seed({ id: "res_synthetic", degraded: false, plan });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_synthetic", approved: true }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approved: boolean;
      booking: { flightId: string; status: string; source?: string };
    };
    expect(body.approved).toBe(true);
    expect(body.booking.flightId).toBe("SYNTHETIC-RECOVERY-SIN-DPS-2026-09-18");
    expect(body.booking.status).toBe("recorded");
    expect(body.booking.source).toBe("swarm_settlement");
    expect(store.__sessions.get("res_synthetic")?.state).toBe("settled");
  });

  it("an inconsistent financial proposal is rejected before approval is consumed", async () => {
    const plan = bookablePlan();
    plan.financial_delta.net_payable = 999999;
    store.__seed({ id: "res_invalid_ledger", plan, degraded: false });
    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_invalid_ledger", approved: true }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("plan_not_bookable");
    expect(store.__sessions.get("res_invalid_ledger")?.state).toBe("proposal_ready");
  });

  it("expired quotes → 410 quotes_expired", async () => {
    store.__seed({
      id: "res_expired",
      degraded: false,
      plan: bookablePlan({ expires_at: Date.now() - 60_000 }),
    });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_expired", approved: true }),
    );

    expect(response.status).toBe(410);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("quotes_expired");
    expect(body.message).toContain("re-run the mission");
  });

  it("expired SESSION (TTL elapsed) → 410 session_expired, not 404", async () => {
    store.__seed({
      id: "res_session_expired",
      degraded: false,
      plan: bookablePlan(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_session_expired", approved: true }),
    );

    expect(response.status).toBe(410);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("session_expired");
    expect(body.message).toContain("start a new mission");
    // Session untouched — the peek never claims.
    expect(store.__sessions.get("res_session_expired")?.state).toBe("proposal_ready");
  });

  it("cancelled session (state expired) → 410 session_expired", async () => {
    store.__seed({
      id: "res_cancelled",
      degraded: false,
      state: "expired",
      plan: bookablePlan(),
    });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_cancelled", approved: true }),
    );

    expect(response.status).toBe(410);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("session_expired");
  });

  it("unknown resolution → 404 unknown_resolution (distinct from 410)", async () => {
    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_never_existed", approved: true }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("unknown_resolution");
  });

  it("store read failure → 503 session_store_unavailable", async () => {
    store.__seed({ id: "res_store_err", degraded: false, plan: bookablePlan() });
    store.__setLookupError(true);

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_store_err", approved: true }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, string>;
    expect(body.error).toBe("session_store_unavailable");
    // Nothing was claimed or settled while the store was unavailable.
    expect(store.__sessions.get("res_store_err")?.state).toBe("proposal_ready");
  });
});

describe("mission + swarm-status degraded visibility (B2)", () => {
  it("mission body carries degraded flag + session_store_memory reason on the memory tier", async () => {
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resolution_id: string;
      plan: ResolutionPlan & { presentation?: unknown };
      degraded: boolean;
      degraded_reason?: string;
      swarm_trace: { agent: string }[];
    };

    expect(body.degraded).toBe(true);
    expect(body.degraded_reason).toBe("session_store_memory");
    // The provider fallback remains a full structured plan; memory-store
    // degradation does not strip its presentation.
    expect(body.plan.presentation).toBeDefined();
    expect(body.plan.currency).toBe("EUR");
    // Real-trip intent parsing names the fixture flight.
    expect(body.plan.incident).toContain("Delayed flight TP437");
  });

  it("with a persistent store the indicative fallback stays approvable", async () => {
    store.__setPersistent(true);

    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );

    const body = (await response.json()) as {
      resolution_id: string;
      degraded: boolean;
      degraded_reason?: string;
    };
    // Provider is offline, but a structured indicative recovery exists and
    // remains approvable; this is not the graph-only degraded rail.
    expect(body.degraded).toBe(false);
    expect(body.degraded_reason).toBeUndefined();
  });

  it("swarm-status body mirrors the degraded flag and reason", async () => {
    const mission = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    const { resolution_id: resolutionId } = (await mission.json()) as { resolution_id: string };

    const status = await handleHackathonRequest(get(`swarm-status/${resolutionId}`));
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      state: string;
      degraded: boolean;
      degraded_reason?: string;
      plan: Record<string, unknown>;
    };
    expect(body.state).toBe("proposal_ready");
    expect(body.degraded).toBe(true);
    expect(body.degraded_reason).toBe("session_store_memory");
    expect(body.plan).toBeDefined();
  });

  it("a mission stuck in processing says so instead of staying silent", async () => {
    // There was no cap at all. Measured across 84 real missions on
    // 2026-09-18: median 13s, p95 27s, and exactly one run above 60s — which
    // reached 269s and was still working when the harness gave up. A
    // traveller stuck at an airport watched a spinner with no way to tell a
    // slow mission from a dead one.
    store.__seed({
      id: "res_stuck",
      state: "processing",
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    const status = await handleHackathonRequest(get("swarm-status/res_stuck"));
    expect(status.status).toBe(200);
    const body = (await status.json()) as { state: string; stalled?: boolean; stalled_seconds?: number };
    expect(body.state).toBe("processing");
    expect(body.stalled).toBe(true);
    expect(body.stalled_seconds).toBeGreaterThanOrEqual(240);
  });

  it("a mission that is merely slow is not called stalled", async () => {
    store.__seed({
      id: "res_slow",
      state: "processing",
      created_at: new Date(Date.now() - 20_000).toISOString(),
    });

    const body = (await (await handleHackathonRequest(get("swarm-status/res_slow"))).json()) as {
      stalled?: boolean;
    };
    expect(body.stalled).toBeUndefined();
  });

  it("a finished mission is never called stalled, however long it took", async () => {
    // The flag is about waiting, not about duration. A plan that landed at
    // four minutes is a plan.
    store.__seed({
      id: "res_slow_but_done",
      state: "proposal_ready",
      plan: bookablePlan(),
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const body = (await (
      await handleHackathonRequest(get("swarm-status/res_slow_but_done"))
    ).json()) as { stalled?: boolean };
    expect(body.stalled).toBeUndefined();
  });

  it("a non-degraded session reports degraded: false without a reason", async () => {
    store.__seed({ id: "res_clean", degraded: false, plan: bookablePlan() });

    const status = await handleHackathonRequest(get("swarm-status/res_clean"));
    const body = (await status.json()) as { degraded: boolean; degraded_reason?: string };
    expect(body.degraded).toBe(false);
    expect(body.degraded_reason).toBeUndefined();
  });
});

describe("degraded plan formatting (B1.5) on the fixture trip", () => {
  it("emits human new_time labels + new_time_iso instead of raw ISO strings", async () => {
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    const body = (await response.json()) as { plan: ResolutionPlan };
    const activities = body.plan.proposed_resolution.rescheduled_activities;
    // Every slot that IS proposed reads as a human time, never a raw ISO.
    for (const activity of activities) {
      expect(activity.new_time).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(activity.new_time).toMatch(/^(?:Today |Tomorrow |\d{4}-\d{2}-\d{2} )\d{2}:\d{2}$/);
      expect(activity.new_time_iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
    // With no provider there is no replacement to offer — and none is
    // fabricated. Re-timing downstream is still legitimate here: this is a
    // DELAY, so the new arrival is the old one plus a known delay. What the
    // plan may never do is invent the flight itself.
    expect(body.plan.proposed_resolution.new_flight).toBeUndefined();
    expect(body.plan.impacted_nodes.length).toBeGreaterThan(0);
    expect(body.plan.incident).toContain("needs a manual booking");
  });

  it("charges stay arithmetically consistent and impacted_nodes is truthful", async () => {
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    const body = (await response.json()) as { plan: ResolutionPlan };
    const plan = body.plan;

    // Indicative +40 flight delta + the fallback policy's +25 change fee;
    // activity penalties (if any) remain included by the normal ledger.
    // Nothing was booked and nothing was re-timed, so nothing is owed. The
    // 40 + 25 this used to expect were a fabricated fare delta and a change
    // fee on a flight that did not exist.
    const expected = plan.proposed_resolution.rescheduled_activities.reduce(
      (sum, activity) => sum + activity.penalty,
      0,
    );
    expect(plan.financial_delta.total_new_charges).toBe(expected);
    expect(plan.financial_delta.net_payable).toBe(expected);

    // Impacted nodes come from the HYDRATED fixture graph.
    expect(plan.impacted_nodes).toContain("Surf Lesson");
    expect(plan.impacted_nodes).toContain("Transfer");

    // No scripted diversion on the real rail → no spatial transfer re-quote.
    expect(plan.proposed_resolution.transfer_requote).toBeUndefined();
  });
});

describe("non-flight missions run LIVE without an Atlas provider (clarity pass)", () => {
  it("a hotel-overbooked mission is NOT degraded, carries no canary and approves locally", async () => {
    // With a persistent store the session's degraded flag mirrors the
    // pipeline verdict alone — and a hotel mission needs no flight provider.
    store.__setPersistent(true);
    try {
      const response = await handleHackathonRequest(
        post("mission", { intent: "our hotel was overbooked", tripId: REAL_TRIP_UUID }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        resolution_id: string;
        plan: ResolutionPlan;
        degraded: boolean;
        degraded_reason?: string;
        swarm_trace: { agent: string; step: string; detail: string }[];
      };

      // Live rail: no degraded flag, no degraded reason.
      expect(body.degraded).toBe(false);
      expect(body.degraded_reason).toBeUndefined();
      // The canary string is flight-only — never stamped on a hotel plan.
      expect(body.plan.incident).not.toContain("(simulated — flight provider unavailable)");
      expect(body.plan.proposed_resolution.new_flight).toBeUndefined();
      // Additive flight/skipped trace row names why no flight agent ran
      // (existing skip rows stay untouched).
      const flightSkipped = body.swarm_trace.find(
        (entry) => entry.agent === "flight" && entry.step === "skipped",
      );
      expect(flightSkipped?.detail).toBe("flight agent not needed for this mission kind");
      // Per-bucket ledger invariant untouched on the live rail.
      const delta = body.plan.financial_delta;
      expect(delta.net_payable).toBe(delta.total_new_charges - delta.total_refund);

      // Approve: the local booking-record path — never the flight provider.
      const approval = await handleHackathonRequest(
        post("approve-resolution", { resolutionId: body.resolution_id, approved: true }),
      );
      expect(approval.status).toBe(200);
      const approved = (await approval.json()) as {
        approved: boolean;
        booking: { status: string };
        settlement: { trip_updated: boolean; booking_recorded: boolean };
      };
      expect(approved.approved).toBe(true);
      expect(approved.booking.status).toBe("recorded");
      expect(approved.settlement.booking_recorded).toBe(false);
      // The hotel settlement still lands on the trip content.
      expect(approved.settlement.trip_updated).toBe(true);
    } finally {
      store.__setPersistent(false);
    }
  });

  it("a flight mission says the search could not run, instead of inventing one", async () => {
    store.__setPersistent(true);
    try {
      const response = await handleHackathonRequest(
        post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
      );
      const body = (await response.json()) as { degraded: boolean; plan: ResolutionPlan };
      expect(body.degraded).toBe(false);
      expect(body.plan.proposed_resolution.new_flight).toBeUndefined();
      expect(body.plan.incident).toContain("needs a manual booking");
      const reason = (body.plan as unknown as {
        presentation?: { no_flight_reason?: { summary: string; route: string } };
      }).presentation?.no_flight_reason;
      // The route is named, and so is the cause — the traveller is not left
      // with a blank card, which was the whole reason a flight was invented.
      expect(reason?.route).toBe("CDG → LIS");
      expect(reason?.summary).toContain("flight provider is not configured");
    } finally {
      store.__setPersistent(false);
    }
  });
});

describe("unresolvable disrupted node degrades like a flight node (clarity pass)", () => {
  it("a persisted mission whose disrupted node vanished from the trip degrades → 409 on approve", async () => {
    // Simulates a gathering_preferences session persisted by assess while the
    // disrupted node still existed — a concurrent trip edit has since removed
    // it, so resolve re-hydrates a graph WITHOUT the node. Without a provider
    // we cannot prove the mission is flight-free ⇒ the orchestrator gate
    // degrades (pre-pass behavior: degraded plan + 409 on approve).
    store.__setPersistent(true);
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY; // deterministic liaison fallback
    try {
      store.__seed({
        id: "res_ghost",
        state: "gathering_preferences",
        plan: null,
        candidates: {
          incident: "Delayed flight TP437",
          impacted_nodes: [],
          mission: {
            nodeId: "ghost-node",
            delayMinutes: 240,
            description: "Delayed flight TP437",
            origin: "reactive",
          },
          options: {
            nodeId: "ghost-node",
            delayMinutes: 240,
            description: "Delayed flight TP437",
            origin: "reactive",
            tripId: REAL_TRIP_UUID,
          },
          tripId: REAL_TRIP_UUID,
          tradeoffs: [],
        },
      });

      const response = await handleHackathonRequest(
        post("mission/resolve", { resolution_id: "res_ghost", answers: [] }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        degraded: boolean;
        degraded_reason?: string;
        plans: ResolutionPlan[];
      };
      // Provider null + missing node ⇒ degraded single plan (never 500).
      expect(body.status).toBe("proposal_ready");
      expect(body.degraded).toBe(true);
      expect(body.degraded_reason).toBe("provider_offline");
      expect(body.plans.length).toBe(1);
      // Empty impact surface: nothing may be claimed as impacted.
      expect(body.plans[0].impacted_nodes).toEqual([]);
      // No canary: the missing node is not provably a flight source.
      expect(body.plans[0].incident).not.toContain("(simulated");

      // Approve: the degraded session never reaches the booking rail.
      const approval = await handleHackathonRequest(
        post("approve-resolution", { resolutionId: "res_ghost", approved: true }),
      );
      expect(approval.status).toBe(409);
      const approved = (await approval.json()) as Record<string, string>;
      expect(approved.error).toBe("degraded_plan_not_bookable");
    } finally {
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
      store.__setPersistent(false);
    }
  });
});

describe("honest settle-skip reporting on approve (clarity pass)", () => {
  // settlementBookingCode("res_dbl") is deterministic: "SWARM-DBL". Pre-
  // stamping the fixture flight leg with that code simulates a settlement
  // that already landed (double-approve of the same resolution).
  function flightPlanWithOperational(extra?: Record<string, unknown>): ResolutionPlan {
    const date = fixtureTravelDate();
    return bookablePlan({
      operational: {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        new_flight: {
          reference: "XY999",
          depart: `${date}T15:00:00Z`,
          arrive: `${date}T17:30:00Z`,
          carrier: "Atlas Sandbox",
        },
        ...extra,
      },
    });
  }

  it("an operational plan where NOTHING can land reports trip_updated false", async () => {
    // Caught by the live settle matrix on Tokyo/missed_flight: the mission
    // found no replacement flight, so the plan carried an operational layer
    // with no `new_flight`, no hotel action and no activity move. Nothing
    // could possibly be written — yet the API answered `trip_updated: true`
    // with an empty `changes` list and an unmoved content_rev, because the
    // old check only asked whether the settlement handed back a content
    // object. The traveler was told their trip had been rewritten when the
    // stored trip was byte-for-byte unchanged.
    //
    // The previous flight-only guard did not catch this: it fired when a
    // rewrite was ATTEMPTED and skipped, and here none was ever attempted.
    store.__seed({
      id: "res_nothing_lands",
      degraded: false,
      plan: bookablePlan({
        operational: {
          disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        },
      }),
    });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_nothing_lands", approved: true }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settlement: { trip_updated: boolean; changes: string[] };
    };
    expect(body.settlement.changes).toEqual([]);
    expect(body.settlement.trip_updated).toBe(false);
  });

  it("a flight leg already carrying this booking code → trip_updated false + already_settled note", async () => {
    const content = realTripContent();
    (content.transit_groups as Array<Record<string, unknown>>)[0].booking_reference = "SWARM-DBL";
    tripCtx.__setTripContent(REAL_TRIP_UUID, content);
    store.__seed({ id: "res_dbl", degraded: false, plan: flightPlanWithOperational() });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_dbl", approved: true }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approved: boolean;
      settlement: { trip_updated: boolean; changes: string[]; note?: string };
    };
    expect(body.approved).toBe(true);
    // Nothing landed ⇒ honest trip_updated: false (never a silent success).
    expect(body.settlement.trip_updated).toBe(false);
    expect(body.settlement.changes).toEqual([]);
    expect(body.settlement.note).toBe(
      "Flight already settled with this booking — no flight changes written",
    );
  });

  it("when OTHER changes land alongside the skipped flight rewrite, trip_updated stays true + note appended", async () => {
    const date = fixtureTravelDate();
    const content = realTripContent();
    (content.transit_groups as Array<Record<string, unknown>>)[0].booking_reference = "SWARM-MIX";
    tripCtx.__setTripContent(REAL_TRIP_UUID, content);
    store.__seed({
      id: "res_mix",
      degraded: false,
      plan: flightPlanWithOperational({
        hotel_actions: [
          {
            nodeId: "hotel-0-1",
            action: "late_check_in",
            note: "check-in pushed back",
            newCheckIn: `${date}T21:00:00Z`,
          },
        ],
      }),
    });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_mix", approved: true }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settlement: { trip_updated: boolean; changes: string[]; note?: string };
    };
    // The hotel action landed ⇒ the trip REALLY was updated.
    expect(body.settlement.trip_updated).toBe(true);
    expect(body.settlement.changes.length).toBeGreaterThan(0);
    // …and the flight-specific skip note is appended alongside.
    expect(body.settlement.note).toBe(
      "Flight already settled with this booking — no flight changes written",
    );
  });
});

describe("assess candidateFeed wiring — activity proposals (clarity pass)", () => {
  it("activity-shaped proposals feed the W1 activity-priority question", async () => {
    // Spy the assess pipeline: no flight assessment, no hotel adjustments,
    // TWO nameable activity proposals — exactly the feed shape that must
    // reach buildPreferenceTradeoffs via candidateFeed.
    const spy = vi.spyOn(OrchestratorAgent.prototype, "assessDisruption").mockResolvedValue({
      disruption: { sourceNodeId: "hotel-0-1", delayMinutes: 120, affected: [] },
      rebookingAssessment: null,
      hotelAdjustments: [],
      activityProposals: [
        {
          activityNodeId: "activity-0-0",
          action: "swap",
          newTime: `${fixtureTravelDate()}T16:00:00Z`,
          penalty: 0,
          currency: "EUR",
          swap: { replacementName: "Lisbon Oceanarium Ticket", priceDelta: 0, reason: "rain" },
        },
        {
          activityNodeId: "activity-0-1",
          action: "swap",
          newTime: `${fixtureTravelDate()}T18:00:00Z`,
          penalty: 0,
          currency: "EUR",
          swap: { replacementName: "Beach Surf Lesson", priceDelta: 0, reason: "rain" },
        },
      ],
      policyVerdict: null,
      impactedNodes: ["Surf Lesson"],
    });
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY; // deterministic liaison fallback
    try {
      const response = await handleHackathonRequest(
        post("mission/assess", { intent: "our hotel was overbooked", tripId: REAL_TRIP_UUID }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        tradeoffs: { id: string; options: { id: string }[] }[];
      };
      expect(body.status).toBe("gathering_preferences");
      // The activity proposals reached the liaison feed ⇒ the keep-X-or-drop-Y
      // question is emitted (no flight candidates ⇒ no flight question, and
      // the discrimination filter never simulates activity questions).
      const activity = body.tradeoffs.find((question) => question.id === "activity-priority");
      expect(activity).toBeDefined();
      expect(activity!.options.length).toBe(2);
      expect(activity!.options.map((option) => option.id)).toEqual([
        "keep_lisbon_oceanarium_ticket",
        "drop_lisbon_oceanarium_ticket",
      ]);
    } finally {
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
      spy.mockRestore();
    }
  });
});

describe("buildOperational — hotel-source settlement (task #15 fix)", () => {
  // handleDisruption re-times the SOURCE hotel node in place but only reports
  // DOWNSTREAM nodes, so the disrupted check-in never enters
  // `disruption.affected` — buildOperational must settle it explicitly or an
  // approved "hotel overbooked" plan would rewrite nothing in content_json.
  const day1Date = fixtureTravelDate();
  const HOTEL_NODE_ID = "hotel-0-1";

  function hydrateHotelTrip() {
    const hydrated = hydrateTripFromContent(REAL_TRIP_UUID, "Lisbon Surf Week", "Lisbon", {
      title: { en: "Lisbon Surf Week" },
      destination: { en: "Lisbon" },
      local_currency_code: "EUR",
      itinerary: [
        {
          day: 1,
          date: day1Date,
          place: "Lisbon",
          items: [
            { type: "activity", title: "Surf Lesson", time: "13:30" },
            { type: "stay", title: "Atlantica Surf House", check_in: day1Date },
          ],
        },
      ],
    });
    expect(hydrated).not.toBeNull();
    return hydrated!;
  }

  it("settles a hotel_check_in source node with the shifted newCheckIn", () => {
    const hydrated = hydrateHotelTrip();
    const originalCheckIn = hydrated.graph.getNode(HOTEL_NODE_ID)?.scheduledTime;
    expect(originalCheckIn).toBe(Date.parse(`${day1Date}T15:00:00Z`));

    // Hotel-source mission: 6h late check-in propagation (mirrors what the
    // mission pipeline does for a "hotel" intent). Deliberately NOT an
    // overbooking — this trip's room still exists and is simply reached
    // late, which is the one situation where deriving a late check-in
    // without an agent verdict is a fair reading of the graph.
    const delayMinutes = 360;
    const disruption = hydrated.graph.handleDisruption(HOTEL_NODE_ID, delayMinutes);

    const operational = buildOperational(
      {
        nodeId: HOTEL_NODE_ID,
        delayMinutes,
        description: "Arriving 6h late at Atlantica Surf House",
        origin: "reactive",
        tripId: REAL_TRIP_UUID,
      },
      hydrated,
      {
        disruption,
        rebookingAssessment: null,
        hotelAdjustments: [],
        activityProposals: [],
      },
    );

    expect(operational).not.toBeNull();
    expect(operational!.disrupted).toMatchObject({ nodeId: HOTEL_NODE_ID, kind: "hotel" });
    // The SOURCE node never lands in `affected` — the explicit gate must
    // have added exactly one entry for it, carrying the post-propagation
    // (shifted) check-in time, not the original one.
    const sourceAction = operational!.hotel_actions?.filter((a) => a.nodeId === HOTEL_NODE_ID);
    expect(sourceAction).toHaveLength(1);
    expect(sourceAction![0].action).toBe("late_check_in"); // no HotelAgent verdict → default
    expect(sourceAction![0].note).toContain("source");
    expect(sourceAction![0].newCheckIn).toBe(
      new Date(originalCheckIn! + delayMinutes * 60_000).toISOString(),
    );
    expect(sourceAction![0].newCheckIn).not.toBe(new Date(originalCheckIn!).toISOString());
  });

  it("never derives a late check-in for an OVERBOOKING — the room is gone, not late", () => {
    // Live on 2026-09-18 this produced "Hotel Gracery Shinjuku: late check-in
    // at 21:30" for a traveller whose room had been given away. Arriving
    // later is not a remedy for a room that will not exist at any hour, and
    // no agent had verified anything: `late_check_in` was simply the
    // fallback when nothing was known.
    const hydrated = hydrateHotelTrip();
    const disruption = hydrated.graph.handleDisruption(HOTEL_NODE_ID, 0);

    const operational = buildOperational(
      {
        nodeId: HOTEL_NODE_ID,
        delayMinutes: 0,
        description: "Hotel issue at Atlantica Surf House: My hotel is overbooked",
        origin: "reactive",
        tripId: REAL_TRIP_UUID,
      },
      hydrated,
      { disruption, rebookingAssessment: null, hotelAdjustments: [], activityProposals: [] },
    );

    const sourceAction = operational!.hotel_actions?.filter((a) => a.nodeId === HOTEL_NODE_ID);
    expect(sourceAction).toHaveLength(1);
    expect(sourceAction![0].action).toBe("none");
  });

  it("picks up the HotelAgent verdict and never duplicates the source node", () => {
    const hydrated = hydrateHotelTrip();
    const retimed = Date.parse(`${day1Date}T21:00:00Z`);
    const label = hydrated.nodeRefs[HOTEL_NODE_ID].label;

    const operational = buildOperational(
      {
        nodeId: HOTEL_NODE_ID,
        delayMinutes: 360,
        description: "Hotel overbooked",
        origin: "reactive",
        tripId: REAL_TRIP_UUID,
      },
      hydrated,
      {
        disruption: {
          sourceNodeId: HOTEL_NODE_ID,
          delayMinutes: 360,
          // Hypothetical report that already lists the source node — the
          // nodeId dedupe must keep exactly ONE entry.
          affected: [
            {
              nodeId: HOTEL_NODE_ID,
              nodeType: "hotel_check_in",
              action: "updated",
              previousScheduledTime: Date.parse(`${day1Date}T15:00:00Z`),
              newScheduledTime: retimed,
              reason: "check-in pushed back",
            },
          ],
        },
        rebookingAssessment: null,
        hotelAdjustments: [{ hotel_name: label, action: "rebook", fee: 0 }],
        activityProposals: [],
      },
    );

    const entries = operational!.hotel_actions?.filter((a) => a.nodeId === HOTEL_NODE_ID);
    expect(entries).toHaveLength(1);
    expect(entries![0].action).toBe("rebook"); // HotelAgent verdict wins over the default
    expect(entries![0].newCheckIn).toBe(new Date(retimed).toISOString());
  });
});

describe("assess anchor capture — simulated delay crossing UTC midnight (review fix 1)", () => {
  // ROOT CAUSE: the discrimination filter used to re-read the disrupted
  // flight node AFTER runSwarmAssessment mutated the graph in place
  // (departureTime += delayMs). When the simulated delay crosses UTC
  // midnight, that re-read anchor sits on the WRONG day and a genuinely
  // discriminating flight-day question is silently dropped (the same-day
  // pin matches the next-day candidate which is already first in base
  // order, so both answer branches yield identical plan sequences).
  // The fix threads the pipeline's pre-mutation `originalDepartureMs`
  // through DisruptionAssessment — the anchor must be the BOOKED
  // departure, not original+delay. This test replicates the real
  // pipeline's in-place mutation and asserts the question SURVIVES.

  function candidate(
    id: string,
    departureIso: string,
    arrivalIso: string,
    netCharge: number,
  ): RebookingCandidate {
    const option: FlightOption = {
      id,
      airline: "TAP Air Portugal",
      flightNumber: id,
      origin: "CDG",
      destination: "LIS",
      departureTime: departureIso,
      arrivalTime: arrivalIso,
      price: 200 + netCharge,
      currency: "EUR",
    };
    const fareDifference: FareDifference = {
      oldFlightId: "flight-0",
      newFlightId: id,
      amount: netCharge,
      currency: "EUR",
      direction: "charge",
    };
    return { option, fareDifference };
  }

  it("keeps the discriminating flight-day question when the delay crosses midnight", async () => {
    const savedAtlas = process.env.ATLAS_API_KEY;
    const savedGemini = process.env.GEMINI_API_KEY;
    process.env.ATLAS_API_KEY = "test-atlas-key"; // flight mission must build an orchestrator
    delete process.env.GEMINI_API_KEY; // deterministic liaison fallback

    const day = fixtureTravelDate(); // fixture flight day (departure 09:00 UTC)
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    const nextDay = new Date(dayMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Same-day candidate (day D) is PRICIER than the next-day one (day D+1),
    // which is exactly what makes buildCrossDateQuestion emit flight-day.
    const sameDay = candidate("OPT-SAME", `${day}T22:00:00Z`, `${day}T23:30:00Z`, 120);
    const nextDayC = candidate("OPT-NEXT", `${nextDay}T08:00:00Z`, `${nextDay}T09:30:00Z`, 40);
    const candidates = [sameDay, nextDayC];

    const spy = vi
      .spyOn(OrchestratorAgent.prototype, "assessDisruption")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async function (this: any, event: any) {
        const graph = this.graph;
        const source = graph.getNode(event.nodeId);
        const originalDepartureMs =
          source && source.type === "flight" ? source.departureTime : undefined;
        const delayMinutes = typeof event.delay === "number" ? event.delay : event.delay.minutes;
        // Replicate the REAL pipeline: capture the TRUE departure BEFORE
        // handleDisruption mutates the node in place.
        const disruption = graph.handleDisruption(event.nodeId, delayMinutes);
        return {
          disruption,
          rebookingAssessment: {
            originalFlightId: event.nodeId,
            requestedTime: new Date(
              (originalDepartureMs ?? 0) + delayMinutes * 60_000,
            ).toISOString(),
            candidates,
            bestCandidate: nextDayC,
          },
          hotelAdjustments: [],
          activityProposals: [],
          policyVerdict: null,
          impactedNodes: ["Flight TP437"],
          ...(originalDepartureMs !== undefined ? { originalDepartureMs } : {}),
        };
      });

    try {
      // 18h delay pushes the 09:00 departure to 03:00 the NEXT UTC day —
      // precisely the midnight-crossing that the pre-fix re-read got wrong.
      const response = await handleHackathonRequest(
        post("mission/assess", { intent: "reroute TP437 by 18h", tripId: REAL_TRIP_UUID }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        status: string;
        tradeoffs: { id: string; options: { id: string }[] }[];
      };
      expect(body.status).toBe("gathering_preferences");
      const flightDay = body.tradeoffs.find((question) => question.id === "flight-day");
      // Post-fix: the booked (day-D) anchor pins the same-day candidate, so
      // the two answers produce different carousels and the question SURVIVES.
      expect(flightDay).toBeDefined();
      expect(flightDay!.options.map((option) => option.id)).toEqual(["same_day", "cheaper_later"]);
    } finally {
      spy.mockRestore();
      if (savedAtlas === undefined) delete process.env.ATLAS_API_KEY;
      else process.env.ATLAS_API_KEY = savedAtlas;
      if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
    }
  });
});

describe("legacy /mission async rail — chunked trace mirror writes (review fix 3)", () => {
  // The multi-resolve rail already flushed its incremental trace mirror in
  // chunks of TRACE_FLUSH_EVERY (8 — raised from 5 by Task 25 #6 for
  // subrequest margin) to stay inside the Worker subrequest budget. The
  // LEGACY POST /mission rail still wrote one mirror row per trace entry —
  // this asserts it now uses the SAME chunked writer: the mirror-write
  // count is floor(pushed/8), never one per entry.
  it("mirror-writes ≈ floor(entries/8) instead of one write per entry", async () => {
    store.__setPersistent(true);
    const pending: Promise<unknown>[] = [];
    const ctx: HackathonContext = {
      waitUntil(promise: Promise<unknown>): void {
        pending.push(promise);
      },
    };
    try {
      const response = await handleHackathonRequest(
        post("mission", { intent: "our hotel was overbooked", tripId: REAL_TRIP_UUID }),
        ctx,
      );
      expect(response.status).toBe(200);
      const ack = (await response.json()) as { resolution_id: string; state: string };
      expect(ack.state).toBe("processing");
      await Promise.all(pending); // drain the async rail

      const session = store.__sessions.get(ack.resolution_id);
      expect(session).toBeDefined();
      expect(session!.state).toBe("proposal_ready");
      // Entries pushed through the mirror = final trace minus the seeded
      // mission_received row (initialTrace). Mirror flushes every 8th one.
      const pushed = session!.trace.length - 1;
      expect(pushed).toBeGreaterThanOrEqual(8); // the fixture mission must exercise at least one chunked flush
      const mirrorWrites = store.__updateCalls.filter((call) => call.id === ack.resolution_id);
      expect(mirrorWrites.length).toBe(Math.floor(pushed / 8));
      // Chunked, not one-write-per-entry (the pre-fix legacy behaviour).
      expect(mirrorWrites.length).toBeLessThan(pushed);
      // Every flushed snapshot carried the cumulative trace (ascending length).
      for (let i = 1; i < mirrorWrites.length; i += 1) {
        expect(mirrorWrites[i].traceLength).toBeGreaterThan(mirrorWrites[i - 1].traceLength);
      }
    } finally {
      store.__setPersistent(false);
    }
  });
});

describe("a change of planes is judged, not called a delay", () => {
  /** SIN → CDG, 50 minutes at CDG, CDG → LIS. Both legs cross a border. */
  function connectingTripContent(): Record<string, unknown> {
    const travelDate = fixtureTravelDate();
    return {
      title: { en: "Singapore to Lisbon" },
      destination: { en: "Lisbon" },
      local_currency_code: "EUR",
      transit_groups: [
        {
          method: "flight",
          reference: "SQ334",
          carrier: "Singapore Airlines",
          depart: `${travelDate}T01:00:00Z`,
          arrive: `${travelDate}T09:00:00Z`,
          origin: { code: "SIN", city: "Singapore" },
          destination: { code: "CDG", city: "Paris" },
        },
        {
          method: "flight",
          reference: "AF1024",
          carrier: "Air France",
          depart: `${travelDate}T09:50:00Z`,
          arrive: `${travelDate}T11:40:00Z`,
          origin: { code: "CDG", city: "Paris" },
          destination: { code: "LIS", city: "Lisbon" },
        },
      ],
      itinerary: [
        {
          day: 1,
          date: travelDate,
          place: "Lisbon",
          items: [{ type: "stay", title: "Atlantica Surf House", check_in: travelDate }],
        },
      ],
    };
  }

  it("answers the question that was asked, with the real numbers", async () => {
    // Before this, "my connection is too tight, I'll never make the second
    // flight" produced "Delayed flight SQ634" with a four-hour delay nobody
    // mentioned and three activities cancelled — the identical plan the
    // engine gave for "the airline moved my flight to 6am".
    tripCtx.__setTripContent(REAL_TRIP_UUID, connectingTripContent());

    const response = await handleHackathonRequest(
      post("mission", {
        intent: "my connection is too tight, I'll never make the second flight",
        tripId: REAL_TRIP_UUID,
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { plan: ResolutionPlan };
    const check = body.plan.presentation?.connection;
    expect(check).toBeDefined();
    expect(check!.route).toContain("SQ334");
    expect(check!.route).toContain("AF1024");
    // 50 minutes against a floor raised by immigration at CDG.
    expect(check!.verdict).toBe("below_minimum");
    expect(check!.detail.join(" ")).toContain("50 min");
    expect(check!.detail.join(" ")).toMatch(/immigration/);
    // And it never reads as a promise, in either direction.
    expect(check!.detail.join(" ")).toMatch(/don't hold the official minimum/);
  });

  it("targets the SECOND leg — the flight actually at risk", async () => {
    const { parseMissionIntentForTrip } = await import("@/lib/swarmIntent");
    const hydrated = hydrateTripFromContent(
      REAL_TRIP_UUID,
      "Singapore to Lisbon",
      "Lisbon",
      connectingTripContent(),
    );
    if (!hydrated) throw new Error("fixture did not hydrate");

    const parsed = parseMissionIntentForTrip(
      "my connection is too tight, I'll never make the second flight",
      hydrated,
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    // The first leg is fine; it is the onward flight that may be lost, and
    // the one a replacement search should offer later departures for.
    expect(parsed.mission.nodeId).toBe("flight-1");
    // Nothing is late. Inventing a delay here is what produced the wrong plan.
    expect(parsed.mission.delayMinutes).toBe(0);
  });
});

describe("a change of planes inside one ticket is judged through the real pipeline", () => {
  /** QA corpus trip #7's shape, as generate-trip stores it: ONE leg SIN → FCO
   *  whose `segments` carry the two hops, endpoints as objects, wall-clock
   *  stamps without a zone. 2 h 30 on the ground at Doha. */
  function oneStopTripContent(): Record<string, unknown> {
    const travelDate = fixtureTravelDate();
    const endpoint = (code: string, city: string) => ({ code, city });
    return {
      title: { en: "Rome via the Gulf" },
      destination: { en: "Rome" },
      local_currency_code: "EUR",
      transit_groups: [
        {
          id: "tg-1",
          method: "flight",
          reference: "QR943",
          carrier: "Qatar Airways",
          depart: `${travelDate}T08:00`,
          arrive: `${travelDate}T18:15`,
          origin: endpoint("SIN", "Singapore"),
          destination: endpoint("FCO", "Rome"),
          stops: 1,
          stop_airports: ["DOH"],
          segments: [
            { reference: "QR943", carrier: "Qatar Airways", from: endpoint("SIN", "Singapore"), to: endpoint("DOH", "Doha"), depart: `${travelDate}T08:00`, arrive: `${travelDate}T11:00` },
            { reference: "QR115", carrier: "Qatar Airways", from: endpoint("DOH", "Doha"), to: endpoint("FCO", "Rome"), depart: `${travelDate}T13:30`, arrive: `${travelDate}T18:15` },
          ],
        },
      ],
      itinerary: [
        {
          day: 1,
          date: travelDate,
          place: "Rome",
          items: [{ type: "stay", title: "Hotel Monti", check_in: travelDate, time: "20:00" }],
        },
      ],
    };
  }

  it("answers about the stop the ticket carries, with the ticket's own numbers", async () => {
    tripCtx.__setTripContent(REAL_TRIP_UUID, oneStopTripContent());

    const response = await handleHackathonRequest(
      post("mission", {
        intent: "my connection in Doha is too tight, I'll never make the second flight",
        tripId: REAL_TRIP_UUID,
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { plan: ResolutionPlan };
    const check = body.plan.presentation?.connection;
    expect(check).toBeDefined();
    expect(check!.route).toBe("QR943 SIN → DOH → QR115 DOH → FCO");
    expect(check!.verdict).toBe("clears_minimum");
    const text = check!.detail.join(" ");
    expect(text).toContain("2 h 30 at Doha (DOH), on your SIN → FCO journey");
    expect(text).toMatch(/one ticket/);
    expect(text).toMatch(/don't hold the official minimum/);
    // Nothing was late and nothing was invented: no activity moved, no money,
    // no seat searched for, no fare rule quoted, no "needs a manual booking".
    expect(body.plan.proposed_resolution.rescheduled_activities).toEqual([]);
    expect(body.plan.proposed_resolution.new_flight).toBeUndefined();
    expect(body.plan.proposed_resolution.policy_verdict).toBeUndefined();
    expect(body.plan.financial_delta.net_payable).toBe(0);
    expect(body.plan.presentation?.no_flight_reason).toBeUndefined();
    expect(body.plan.incident).toBe("Connection at DOH — QR115 DOH → FCO");
  });
});

describe("a mission the platform cut off is reported dead, not slow", () => {
  // The resolve ack is the instant Cloudflare's 30 s `waitUntil` clock
  // starts. A session still processing 40 s later has nobody working on it:
  // telling the traveller to "let it finish" would have them wait for
  // nothing, when the right advice is the opposite one.
  const ackRow = (secondsAgo: number) => ({
    agent: "orchestrator",
    step: "resolve_received",
    detail: "building plans from 1 trade-off answer(s)",
    at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  });

  it("names the cause once the ack is 40 s old", async () => {
    store.__seed({
      id: "res_dead",
      state: "processing",
      created_at: new Date(Date.now() - 50_000).toISOString(),
      trace: [ackRow(45)],
    });
    const body = (await (await handleHackathonRequest(get("swarm-status/res_dead"))).json()) as {
      stalled?: boolean;
      stalled_seconds?: number;
      stalled_reason?: string;
    };
    expect(body.stalled).toBe(true);
    expect(body.stalled_reason).toBe("continuation_cancelled");
    expect(body.stalled_seconds).toBeGreaterThanOrEqual(45);
  });

  it("a mission acknowledged 20 s ago is still just working", async () => {
    store.__seed({
      id: "res_working",
      state: "processing",
      created_at: new Date(Date.now() - 4 * 60_000).toISOString(), // a long trade-off phase
      trace: [ackRow(20)],
    });
    const body = (await (await handleHackathonRequest(get("swarm-status/res_working"))).json()) as {
      stalled?: boolean;
      stalled_reason?: string;
    };
    // Created four minutes ago, but the WORK only started 20 s ago — the old
    // creation-based rule alone would have called this stalled.
    expect(body.stalled_reason).toBeUndefined();
  });
});
