/**
 * WS1/WS2/WS3 — cancel endpoint, production gating and flight-less settlement.
 *
 * Every test here runs with the production gate ON (SWARM_REAL_TRIPS=1 +
 * SWARM_DEMO_TOKEN bearer). The session store is an in-memory fake (with an
 * injectable read failure for the 503 rail) and src/lib/swarmTripContext is
 * mocked so loadSwarmTrip / settlePlanOnTrip are fully controllable while the
 * REAL hydrateTripFromContent / applySettlementToContent transformers still
 * do the actual content rewriting.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TRIP_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BEARER_TOKEN = "test-secret-token";

// ---------------------------------------------------------------- trip mock

vi.mock("@/lib/swarmTripContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarmTripContext")>();
  let loadResult: import("@/lib/swarmTripContext").SwarmTripLoadResult = {
    kind: "not_found",
  };
  let seedContent: Record<string, unknown> | null = null;
  let settleConflict = false;
  return {
    ...actual,
    /**
     * Seed (or clear) the trip the mocked loadSwarmTrip hydrates. `null`
     * maps to `{ kind: "not_found" }` (existing 404 rails stay intact).
     */
    __setTripContent(tripId: string, content: Record<string, unknown> | null): void {
      seedContent = content;
      if (content === null) {
        loadResult = { kind: "not_found" };
        return;
      }
      const trip = actual.hydrateTripFromContent(tripId, "Lisbon Surf Week", "Lisbon", content);
      loadResult = trip ? { kind: "ok", trip } : { kind: "unhydratable" };
    },
    /** Force settlePlanOnTrip into the CAS-conflict branch. */
    __setSettleConflict(value: boolean): void {
      settleConflict = value;
    },
    async loadSwarmTrip(_tripId: string) {
      return loadResult;
    },
    async settlePlanOnTrip(
      _tripId: string,
      _nodeRefs: Record<string, unknown>,
      plan: import("@/agents").ResolutionPlan,
      operational: import("@/agents").OperationalSettlement,
    ) {
      if (settleConflict) return { conflict: true as const };
      if (loadResult.kind !== "ok" || !seedContent) return null;
      const result = actual.applySettlementToContent(
        seedContent,
        loadResult.trip.nodeRefs,
        plan,
        operational,
      );
      return { updatedContent: result.content, changes: result.changes };
    },
  };
});

// --------------------------------------------------------------- store mock

interface FakeSessionRecord {
  id: string;
  trip_id: string | null;
  user_id: string | null;
  state: string;
  plan: unknown;
  trace: unknown[];
  degraded: boolean;
  candidates?: unknown;
  plans?: unknown;
  created_at: string;
  expires_at: string;
}

vi.mock("@/lib/swarmAuth", async () => {
  const { makeSwarmAuthMock } = await import("./helpers/realTripFixture");
  return makeSwarmAuthMock();
});

vi.mock("@/lib/swarmSessionStore", () => {
  const sessions = new Map<string, FakeSessionRecord>();
  let lookupError = false;
  let cancelError = false;
  const ACTIVE_STATES = [
    "processing",
    "gathering_preferences",
    "proposal_ready",
    "awaiting_approval",
  ];
  return {
    __sessions: sessions,
    __setLookupError(value: boolean): void {
      lookupError = value;
    },
    __setCancelError(value: boolean): void {
      cancelError = value;
    },
    __seed(record: Partial<FakeSessionRecord> & { id: string }): FakeSessionRecord {
      const full: FakeSessionRecord = {
        trip_id: null,
        user_id: null,
        state: "proposal_ready",
        plan: null,
        trace: [],
        degraded: false,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        ...record,
      };
      sessions.set(full.id, full);
      return full;
    },
    async saveSwarmSession(input: Record<string, unknown>): Promise<boolean> {
      sessions.set(input.id as string, {
        id: input.id as string,
        trip_id: (input.trip_id as string | null) ?? null,
        user_id: (input.user_id as string | null) ?? null,
        state: (input.state as string) ?? "processing",
        plan: (input.plan as unknown) ?? null,
        trace: (input.trace as unknown[]) ?? [],
        degraded: (input.degraded as boolean) ?? false,
        ...(input.candidates !== undefined ? { candidates: input.candidates } : {}),
        ...(input.plans !== undefined ? { plans: input.plans } : {}),
        created_at: new Date().toISOString(),
        expires_at: (input.expires_at as string) ?? new Date().toISOString(),
      });
      return true;
    },
    // State-guarded variant: an existing row outside the allowed states
    // (e.g. cancelled ⇒ "expired") is never overwritten.
    async saveSwarmSessionIfState(
      input: Record<string, unknown>,
      allowedStates: readonly string[] = ["processing", "gathering_preferences"],
    ): Promise<boolean> {
      const existing = sessions.get(input.id as string);
      if (existing && !allowedStates.includes(existing.state)) return false;
      sessions.set(input.id as string, {
        id: input.id as string,
        trip_id: (input.trip_id as string | null) ?? null,
        user_id: (input.user_id as string | null) ?? null,
        state: (input.state as string) ?? "processing",
        plan: (input.plan as unknown) ?? null,
        trace: (input.trace as unknown[]) ?? [],
        degraded: (input.degraded as boolean) ?? false,
        ...(input.candidates !== undefined ? { candidates: input.candidates } : {}),
        ...(input.plans !== undefined ? { plans: input.plans } : {}),
        created_at: new Date().toISOString(),
        expires_at: (input.expires_at as string) ?? new Date().toISOString(),
      });
      return true;
    },
    async getSwarmSession(id: string): Promise<FakeSessionRecord | null> {
      const record = sessions.get(id);
      if (!record) return null;
      if (record.expires_at <= new Date().toISOString()) return null;
      return record;
    },
    async getSwarmSessionIgnoringExpiry(
      id: string,
    ): Promise<{ record: FakeSessionRecord } | { error: string } | null> {
      if (lookupError) return { error: "simulated store failure" };
      const record = sessions.get(id);
      return record ? { record } : null;
    },
    async cancelSwarmSession(id: string) {
      if (cancelError) return { cancelled: false, error: "simulated store failure" };
      const record = sessions.get(id);
      if (!record) return { cancelled: false };
      if (!ACTIVE_STATES.includes(record.state)) {
        return { cancelled: false, state: record.state };
      }
      record.state = "expired";
      return { cancelled: true, state: "expired" };
    },
    async claimSwarmSessionForBooking(id: string, candidates?: unknown): Promise<FakeSessionRecord | null> {
      const record = sessions.get(id);
      if (!record || (record.state !== "proposal_ready" && record.state !== "awaiting_approval")) {
        return null;
      }
      if (record.expires_at <= new Date().toISOString()) return null;
      record.state = "approved";
      if (candidates !== undefined) record.candidates = candidates;
      return record;
    },
    settlementOperation(record: FakeSessionRecord) {
      return (record.candidates as { settlement_operation?: unknown } | undefined)?.settlement_operation ?? null;
    },
    async saveSwarmSettlementReceipt(entry: FakeSessionRecord, receipt: Record<string, unknown>) {
      const record = sessions.get(entry.id);
      if (!record || record.state !== "approved") return false;
      const candidates = entry.candidates as Record<string, unknown>;
      record.candidates = { ...candidates, settlement_operation: { ...(candidates.settlement_operation as object), receipt } };
      record.state = "settled";
      return true;
    },
    async markSwarmSessionSettled(id: string): Promise<void> {
      const record = sessions.get(id);
      if (record) record.state = "settled";
    },
    async updateSwarmSession(id: string, patch: Record<string, unknown>): Promise<boolean> {
      const record = sessions.get(id);
      if (!record) return false;
      Object.assign(record, patch);
      return true;
    },
    async listSwarmAlerts(): Promise<never[]> {
      return [];
    },
    swarmStoreIsPersistent(): boolean {
      return true;
    },
    async probeSwarmStoreHealth(): Promise<boolean> {
      return true;
    },
  };
});

import { handleHackathonRequest } from "@/lib/hackathonApi";
import * as storeModule from "@/lib/swarmSessionStore";
import * as tripModule from "@/lib/swarmTripContext";
import type { ResolutionPlan } from "@/agents";

const store = storeModule as unknown as {
  __sessions: Map<string, FakeSessionRecord>;
  __setLookupError(value: boolean): void;
  __setCancelError(value: boolean): void;
  __seed(record: Partial<FakeSessionRecord> & { id: string }): FakeSessionRecord;
};

const tripHooks = tripModule as unknown as {
  __setTripContent(tripId: string, content: Record<string, unknown> | null): void;
  __setSettleConflict(value: boolean): void;
};

// ----------------------------------------------------------------- helpers

function post(endpoint: string, body: unknown, token: string | null = BEARER_TOKEN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/hackathon/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const day1Date = (() => {
  const d = new Date(Date.now() + DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString()
    .slice(0, 10);
})();

/** Real-trip content: one day with an activity + a hotel stay (hotel-0-1). */
function hotelTripContent(): Record<string, unknown> {
  return {
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
  };
}

/** Hotel-only plan (flight-less) with a complete operational layer. */
function hotelOnlyPlan(): ResolutionPlan {
  return {
    incident: "Hotel overbooked at Atlantica Surf House",
    impacted_nodes: ["Atlantica Surf House"],
    proposed_resolution: { rescheduled_activities: [] },
    financial_delta: { total_refund: 0, total_new_charges: 0, net_payable: 0 },
    requires_human_approval: true,
    operational: {
      disrupted: { nodeId: "hotel-0-1", kind: "hotel", label: "Atlantica Surf House" },
      hotel_actions: [
        {
          nodeId: "hotel-0-1",
          action: "late_check_in",
          note: "check-in moved to 21:00",
          newCheckIn: `${day1Date}T21:00:00.000Z`,
        },
      ],
    },
  };
}

beforeEach(() => {
  store.__sessions.clear();
  store.__setLookupError(false);
  tripHooks.__setTripContent(TRIP_UUID, null);
  tripHooks.__setSettleConflict(false);
  process.env.SWARM_REAL_TRIPS = "1";
  process.env.SWARM_DEMO_TOKEN = BEARER_TOKEN;
  delete process.env.ATLAS_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

// ------------------------------------------------------------- WS3: cancel

describe("POST /mission/cancel (WS3)", () => {
  it("cancels an active session → { cancelled: true } and the session becomes expired", async () => {
    store.__seed({ id: "res_active", trip_id: TRIP_UUID, state: "gathering_preferences" });

    const response = await handleHackathonRequest(
      post("mission/cancel", { resolutionId: "res_active" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
    expect(store.__sessions.get("res_active")?.state).toBe("expired");
  });

  it("is idempotent: a second cancel answers { cancelled: false, noop: true, state }", async () => {
    store.__seed({ id: "res_twice", trip_id: TRIP_UUID, state: "proposal_ready" });

    const first = await handleHackathonRequest(
      post("mission/cancel", { resolutionId: "res_twice" }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ cancelled: true });

    const second = await handleHackathonRequest(
      post("mission/cancel", { resolutionId: "res_twice" }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ cancelled: false, noop: true, state: "expired" });
  });

  it("cancelling a SETTLED session is a noop reporting its state", async () => {
    store.__seed({ id: "res_settled", trip_id: TRIP_UUID, state: "settled" });

    const response = await handleHackathonRequest(
      post("mission/cancel", { resolutionId: "res_settled" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: false, noop: true, state: "settled" });
    expect(store.__sessions.get("res_settled")?.state).toBe("settled");
  });

  it("cancelling an unknown id is a noop without a state", async () => {
    const response = await handleHackathonRequest(
      post("mission/cancel", { resolutionId: "res_ghost" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: false, noop: true });
  });

  it("missing resolutionId → 400 invalid_body", async () => {
    const response = await handleHackathonRequest(post("mission/cancel", {}));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  it("sits behind the bearer gate (gate ON without token → 401)", async () => {
    const response = await handleHackathonRequest(
      post("mission/cancel", { resolutionId: "res_active" }, null),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("a cancelled session can no longer be approved → 410 session_expired", async () => {
    store.__seed({ id: "res_c_then_a", trip_id: TRIP_UUID, state: "proposal_ready" });

    await handleHackathonRequest(post("mission/cancel", { resolutionId: "res_c_then_a" }));

    const approval = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_c_then_a", approved: true }),
    );
    expect(approval.status).toBe(410);
    const body = (await approval.json()) as { error: string };
    expect(body.error).toBe("session_expired");
  });

  it("store failure on cancel → 503 session_store_unavailable", async () => {
    store.__seed({ id: "res_cancel_err", trip_id: TRIP_UUID, state: "proposal_ready" });
    store.__setCancelError(true);

    const response = await handleHackathonRequest(
      post("mission/cancel", { resolutionId: "res_cancel_err" }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("session_store_unavailable");
    // The session was NOT transitioned by the failed cancel.
    expect(store.__sessions.get("res_cancel_err")?.state).toBe("proposal_ready");
  });
});

// ------------------------------------------------ WS2: production gating

describe("gate-ON structured errors (WS2)", () => {
  it("/mission without tripId → 400 trip_required (no demo default)", async () => {
    const response = await handleHackathonRequest(post("mission", { intent: "reroute by 4h" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("trip_required");
  });

  it("/mission with a non-uuid tripId → 400 trip_required", async () => {
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute by 4h", tripId: "demo-lisbon" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("trip_required");
  });

  it("/mission with a uuid that fails hydration → 404 trip_not_hydratable", async () => {
    tripHooks.__setTripContent(TRIP_UUID, null); // loadSwarmTrip ⇒ not_found
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute by 4h", tripId: TRIP_UUID }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("trip_not_hydratable");
  });

  it("/mission/assess without tripId → 400 trip_required", async () => {
    const response = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute by 4h" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("trip_required");
  });

  it("/mission/assess with an unhydratable uuid → 404 trip_not_hydratable", async () => {
    const response = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute by 4h", tripId: TRIP_UUID }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("trip_not_hydratable");
  });

  it("/mission/resolve on a session whose trip no longer hydrates → 404 trip_not_hydratable", async () => {
    // A gathering_preferences session persisted while the trip was loadable;
    // by resolve time the trip row is gone.
    store.__seed({
      id: "res_resolve_lost",
      trip_id: TRIP_UUID,
      state: "gathering_preferences",
      candidates: {
        incident: "hotel disruption",
        options: {
          nodeId: "hotel-0-1",
          delayMinutes: 360,
          description: "hotel disruption",
          origin: "reactive",
          tripId: TRIP_UUID,
        },
        tradeoffs: [],
      },
    });

    const response = await handleHackathonRequest(
      post("mission/resolve", { resolution_id: "res_resolve_lost", answers: [] }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("trip_not_hydratable");
  });
});

// ------------------------------ WS2: flight-less approve settles the trip

describe("flight-less approve settles a real trip (gate ON)", () => {
  it("hotel-only plan → settlement.trip_updated with the rewritten content", async () => {
    tripHooks.__setTripContent(TRIP_UUID, hotelTripContent());
    store.__seed({
      id: "res_hotel",
      trip_id: TRIP_UUID,
      state: "proposal_ready",
      degraded: false,
      plan: hotelOnlyPlan(),
    });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_hotel", approved: true }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approved: boolean;
      booking: { status: string; source: string; flightId: string };
      settlement: {
        trip_updated: boolean;
        changes: string[];
        booking_recorded: boolean;
        conflict_skipped?: boolean;
      };
      updated_content?: { itinerary: Array<{ items: Array<Record<string, unknown>> }> };
    };

    expect(body.approved).toBe(true);
    // Flight-less disruption: locally recorded stub, provider never called.
    expect(body.booking.status).toBe("recorded");
    expect(body.booking.source).toBe("swarm_settlement");
    expect(body.settlement.booking_recorded).toBe(false);
    expect(body.settlement.trip_updated).toBe(true);
    expect(body.settlement.conflict_skipped).toBeUndefined();
    expect(body.settlement.changes.join(" ")).toContain("Atlantica Surf House");

    // The rewritten content reflects the hotel action (late check-in note).
    const stay = body.updated_content?.itinerary?.[0]?.items?.[1];
    expect(stay).toBeDefined();
    expect(String(stay?.swarm_note ?? "")).toContain("Swarm settlement");
    expect(String(stay?.swarm_note ?? "")).toContain("late check-in");

    // Session consumed exactly once.
    expect(store.__sessions.get("res_hotel")?.state).toBe("settled");
  });

  it("CAS conflict during settlement → conflict_skipped + human-readable note", async () => {
    tripHooks.__setTripContent(TRIP_UUID, hotelTripContent());
    tripHooks.__setSettleConflict(true);
    store.__seed({
      id: "res_hotel_conflict",
      trip_id: TRIP_UUID,
      state: "proposal_ready",
      degraded: false,
      plan: hotelOnlyPlan(),
    });

    const response = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: "res_hotel_conflict", approved: true }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settlement: { trip_updated: boolean; conflict_skipped?: boolean; note?: string };
    };
    expect(body.settlement.trip_updated).toBe(false);
    expect(body.settlement.conflict_skipped).toBe(true);
    expect(body.settlement.note).toBe("Your trip changed elsewhere — review the updated itinerary");
  });
});
