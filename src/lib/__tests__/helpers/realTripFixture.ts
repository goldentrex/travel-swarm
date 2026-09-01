/**
 * Shared REAL-RAIL test fixture for the hackathon API suites (WS5).
 *
 * Every hackathon API suite now runs with the production gate ON
 * (SWARM_REAL_TRIPS=1 + SWARM_DEMO_TOKEN bearer) against this fixture trip:
 *
 *   - one flight leg  TP437 CDG → LIS (carrier/reference/depart/arrive +
 *     booking fields) → graph node `flight-0`
 *   - one car transfer the same day (pickup at the arrival airport) →
 *     `transfer-1` (dependsOn flight-0, pickupLocationId "LIS")
 *   - one activity ("Surf Lesson", 13:30) → `activity-0-0`
 *   - one hotel stay ("Atlantica Surf House", check_in 15:00 UTC) →
 *     `hotel-0-1`
 *
 * The content_json mirrors exactly what `hydrateTripFromContent`
 * (src/lib/swarmTripContext.ts) expects, so the REAL hydration/settlement
 * transformers run in every test — only the Supabase row fetch is stubbed.
 *
 * Mock seams (both match the patterns the suites used before the demo rail
 * was retired):
 *   - `makeSwarmSessionStoreMock()` → in-memory fake of swarmSessionStore
 *     (controllable persistence flag, lookup/cancel failures, candidates +
 *     plans jsonb persistence).
 *   - `makeSwarmTripContextMock(actual)` → PARTIAL mock of swarmTripContext:
 *     keeps the real hydrateTripFromContent / applySettlementToContent and
 *     stubs only loadSwarmTrip / settlePlanOnTrip.
 *
 * `vi.mock` factories are hoisted above imports, so the suites load this
 * helper via a DYNAMIC import inside the factory.
 */

import type { OperationalSettlement, ResolutionPlan } from "@/agents";
import type { SwarmTripLoadResult } from "@/lib/swarmTripContext";

// -------------------------------------------------------------- constants

/** Uuid of the fixture trip (real trips-table ids are uuids). */
export const REAL_TRIP_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Bearer token matched against SWARM_DEMO_TOKEN by the gate. */
export const BEARER_TOKEN = "test-secret-token";

/** Graph node ids produced by hydrateTripFromContent for this fixture. */
export const FIXTURE_NODE_IDS = {
  flight: "flight-0",
  transfer: "transfer-1",
  activity: "activity-0-0",
  hotel: "hotel-0-1",
} as const;

// --------------------------------------------------------------- fixture

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" (UTC) of the fixture travel day — tomorrow, always future. */
export function fixtureTravelDate(offsetDays = 1): string {
  const d = new Date(Date.now() + offsetDays * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

/**
 * Minimal realistic trips-table content_json: flight TP437 CDG → LIS
 * (09:00 → 11:30 UTC), a car pickup 45 min after landing, a Surf Lesson at
 * 13:30 and the Atlantica Surf House check-in on the arrival day. Currency
 * EUR (drives the plan currency + fallback fare-rule amounts).
 */
export function realTripContent(): Record<string, unknown> {
  const travelDate = fixtureTravelDate();
  return {
    title: { en: "Lisbon Surf Week" },
    destination: { en: "Lisbon" },
    local_currency_code: "EUR",
    transit_groups: [
      {
        method: "flight",
        reference: "TP437",
        carrier: "TAP Air Portugal",
        depart: `${travelDate}T09:00:00Z`,
        arrive: `${travelDate}T11:30:00Z`,
        origin: { code: "CDG", city: "Paris" },
        destination: { code: "LIS", city: "Lisbon" },
        booked: true,
        booking_reference: "TP-REF-437",
      },
      {
        method: "car",
        depart: `${travelDate}T12:15:00Z`,
        durationHrs: 0.5,
        origin: { city: "Lisbon" },
        destination: { city: "Lisbon" },
      },
    ],
    itinerary: [
      {
        day: 1,
        date: travelDate,
        place: "Lisbon",
        items: [
          { type: "activity", title: "Surf Lesson", time: "13:30" },
          { type: "stay", title: "Atlantica Surf House", check_in: travelDate },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------- env + http

/** Flip the production gate ON with a matching bearer token. */
export function enableRealRailEnv(): void {
  process.env.SWARM_REAL_TRIPS = "1";
  process.env.SWARM_DEMO_TOKEN = BEARER_TOKEN;
}

/** POST helper carrying the bearer token (gate-ON surface). */
export function post(
  endpoint: string,
  body: unknown,
  token: string | null = BEARER_TOKEN,
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/hackathon/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** GET helper carrying the bearer token (gate-ON surface). */
export function get(endpoint: string, token: string | null = BEARER_TOKEN): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/hackathon/${endpoint}`, { headers });
}

// -------------------------------------------------------- session store mock

export interface FakeSessionRecord {
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

export interface FakeSwarmSessionStore {
  __sessions: Map<string, FakeSessionRecord>;
  /**
   * Additive (review-fix tests) — every updateSwarmSession call recorded in
   * order (id + resulting trace length), so chunked-mirror-write regression
   * tests can count mirror writes without spying module bindings.
   */
  __updateCalls: Array<{ id: string; traceLength: number }>;
  __setPersistent(value: boolean): void;
  __setLookupError(value: boolean): void;
  __setCancelError(value: boolean): void;
  __seed(record: Partial<FakeSessionRecord> & { id: string }): FakeSessionRecord;
  saveSwarmSession(input: Record<string, unknown>): Promise<boolean>;
  saveSwarmSessionIfState(
    input: Record<string, unknown>,
    allowedStates?: readonly string[],
  ): Promise<boolean>;
  getSwarmSession(id: string): Promise<FakeSessionRecord | null>;
  getSwarmSessionIgnoringExpiry(
    id: string,
  ): Promise<{ record: FakeSessionRecord } | { error: string } | null>;
  cancelSwarmSession(id: string): Promise<Record<string, unknown>>;
  claimSwarmSessionForBooking(id: string): Promise<FakeSessionRecord | null>;
  markSwarmSessionSettled(id: string): Promise<void>;
  updateSwarmSession(id: string, patch: Record<string, unknown>): Promise<boolean>;
  listSwarmAlerts(): Promise<never[]>;
  swarmStoreIsPersistent(): boolean;
  probeSwarmStoreHealth(): Promise<boolean>;
}

/**
 * Unified in-memory fake of `@/lib/swarmSessionStore` — the seam every
 * hackathon suite used before the demo rail retirement. `persistent`
 * defaults to true (pass `{ persistent: false }` for the memory-tier rail).
 */
export function makeSwarmSessionStoreMock(
  options: { persistent?: boolean } = {},
): FakeSwarmSessionStore {
  const sessions = new Map<string, FakeSessionRecord>();
  const updateCalls: Array<{ id: string; traceLength: number }> = [];
  let persistent = options.persistent ?? true;
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
    __updateCalls: updateCalls,
    __setPersistent(value: boolean): void {
      persistent = value;
    },
    /** Simulates a store read failure ⇒ approve must answer 503. */
    __setLookupError(value: boolean): void {
      lookupError = value;
    },
    /** Simulates a cancel write failure ⇒ cancel must answer 503. */
    __setCancelError(value: boolean): void {
      cancelError = value;
    },
    __seed(record: Partial<FakeSessionRecord> & { id: string }): FakeSessionRecord {
      const full: FakeSessionRecord = {
        trip_id: REAL_TRIP_UUID,
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
    // State-guarded variant: mirrors the real store's conditional UPDATE —
    // an existing row outside `allowedStates` (e.g. cancelled ⇒ "expired")
    // is NEVER overwritten; absent rows keep upsert (bootstrap) semantics.
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
    async cancelSwarmSession(id: string): Promise<Record<string, unknown>> {
      if (cancelError) return { cancelled: false, error: "simulated store failure" };
      const record = sessions.get(id);
      if (!record) return { cancelled: false };
      if (!ACTIVE_STATES.includes(record.state)) {
        return { cancelled: false, state: record.state };
      }
      record.state = "expired";
      return { cancelled: true, state: "expired" };
    },
    async claimSwarmSessionForBooking(id: string): Promise<FakeSessionRecord | null> {
      const record = sessions.get(id);
      if (!record || (record.state !== "proposal_ready" && record.state !== "awaiting_approval")) {
        return null;
      }
      if (record.expires_at <= new Date().toISOString()) return null;
      record.state = "approved";
      return record;
    },
    async markSwarmSessionSettled(id: string): Promise<void> {
      const record = sessions.get(id);
      if (record) record.state = "settled";
    },
    async updateSwarmSession(id: string, patch: Record<string, unknown>): Promise<boolean> {
      const record = sessions.get(id);
      if (!record) return false;
      updateCalls.push({
        id,
        traceLength: Array.isArray(patch.trace) ? patch.trace.length : record.trace.length,
      });
      Object.assign(record, patch);
      return true;
    },
    async listSwarmAlerts(): Promise<never[]> {
      return [];
    },
    swarmStoreIsPersistent(): boolean {
      return persistent;
    },
    /** Live health probe — the fake reports its persistence flag. */
    async probeSwarmStoreHealth(): Promise<boolean> {
      return persistent;
    },
  };
}

// ---------------------------------------------------- trip context (partial)

export interface FakeSwarmTripContextHooks {
  __setTripContent(tripId: string, content: Record<string, unknown> | null): void;
  /** Simulate a trip-store failure ⇒ loadSwarmTrip returns store_unavailable. */
  __setTripStoreError(value: boolean): void;
  __setSettleConflict(value: boolean): void;
}

/**
 * PARTIAL mock factory for `@/lib/swarmTripContext`: the REAL
 * hydrateTripFromContent / applySettlementToContent transformers stay live;
 * only the Supabase row fetch (loadSwarmTrip — returns the classified
 * {@link SwarmTripLoadResult} union) and the CAS write (settlePlanOnTrip)
 * are stubbed and made controllable.
 */
/**
 * Grant-everything stub for the per-user trip gate.
 *
 * These suites were written to exercise the swarm rails, not authorization, so
 * they run as an owner with edit rights. The gate ITSELF is exercised for real
 * in `swarmAuth.test.ts` — mocking it here must never become the reason nobody
 * tests it.
 */
export function makeSwarmAuthMock(): Record<string, unknown> {
  return {
    USER_TOKEN_HEADER: "X-Swarm-User-Token",
    resolveSwarmActor: async () => ({ kind: "user", userId: "test-owner" }),
    checkTripAccess: async () => ({ kind: "granted", canEdit: true }),
  };
}

export function makeSwarmTripContextMock(
  actual: typeof import("@/lib/swarmTripContext"),
): Record<string, unknown> {
  let loadResult: SwarmTripLoadResult = { kind: "not_found" };
  let seedContent: Record<string, unknown> | null = null;
  let settleConflict = false;
  const hooks: FakeSwarmTripContextHooks = {
    /**
     * Seed (or clear) the trip the mocked loadSwarmTrip hydrates. `null`
     * maps to `{ kind: "not_found" }` (keeps the existing 404 rails green).
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
    /** Simulate a trip-store failure ⇒ 503 session_store_unavailable rail. */
    __setTripStoreError(value: boolean): void {
      if (value) {
        loadResult = { kind: "store_unavailable" };
      } else if (seedContent === null) {
        loadResult = { kind: "not_found" };
      } else {
        const trip = actual.hydrateTripFromContent(
          REAL_TRIP_UUID,
          "Lisbon Surf Week",
          "Lisbon",
          seedContent,
        );
        loadResult = trip ? { kind: "ok", trip } : { kind: "unhydratable" };
      }
    },
    /** Force settlePlanOnTrip into the CAS-conflict branch. */
    __setSettleConflict(value: boolean): void {
      settleConflict = value;
    },
  };
  return {
    ...actual,
    ...hooks,
    async loadSwarmTrip(_tripId: string): Promise<SwarmTripLoadResult> {
      return loadResult;
    },
    async settlePlanOnTrip(
      _tripId: string,
      _nodeRefs: Record<string, unknown>,
      plan: ResolutionPlan,
      operational: OperationalSettlement,
    ) {
      if (settleConflict) return { conflict: true as const };
      if (loadResult.kind !== "ok" || !seedContent) return null;
      const result = actual.applySettlementToContent(
        seedContent,
        loadResult.trip.nodeRefs,
        plan,
        operational,
      );
      return {
        updatedContent: result.content,
        changes: result.changes,
        flightRewriteLanded: result.flightRewriteLanded,
        // Additive: WHY a flight rewrite did not land (honest skip notes).
        ...(result.flightSkipReason !== undefined
          ? { flightSkipReason: result.flightSkipReason }
          : {}),
        // Deterministic stand-in for the post-write content_rev (the real
        // DB trigger bumps the rev; the RETURNING clause returns it).
        contentRev: 2,
      };
    },
  };
}
