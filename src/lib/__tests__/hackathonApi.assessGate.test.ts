/**
 * Task 25 (#3) — DayReorganizer assess-gate tests.
 *
 * buildSwarmOrchestrator wires the Gemini DayReorganizer ONLY on the async
 * resolve rail (flags.dayReorg). The assess rail must perform ZERO day-reorg
 * network work (Gemini ≤3 + Viator consults) — "zero new I/O on assess" and
 * the 20 s iOS timeout budget.
 *
 * Seams (same pattern as the sibling hackathon API suites):
 *   - AtlasFlightProvider mocked at the module boundary (three candidates).
 *   - ViatorActivityProvider mocked: `viatorEdgeConfigured` forced true (so
 *     the activity agent — and with it the DayReorganizer — WOULD wire) and
 *     `searchActivities` a no-op (never touches the network).
 *   - session store + trip context fakes from the shared real-trip fixture.
 *   - DayReorganizer.prototype.reorganizeDay spied: the gate under test.
 *
 * The fixture trip is extended to TWO same-day activities so the ≥2-per-day
 * reorg gate is satisfied — with the reorganizer wired, an assess run WOULD
 * have invoked it; the assertion is therefore not vacuous.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

vi.mock("@/providers/atlas/AtlasFlightProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/atlas/AtlasFlightProvider")>();
  return {
    ...actual,
    AtlasFlightProvider: class MockAtlasFlightProvider {
      readonly providerName = "atlas-sandbox";
      async searchAlternativeFlights(flightId: string, requestedTime: string) {
        const departureMs = Date.parse(requestedTime);
        const arrival = (minutes: number) => new Date(departureMs + minutes * 60_000).toISOString();
        return {
          referenceFlightId: flightId,
          requestedTime,
          options: [
            {
              id: "ATL-1",
              airline: "Atlas Sandbox",
              flightNumber: "XY456",
              origin: "CDG",
              destination: "LIS",
              departureTime: requestedTime,
              arrivalTime: arrival(180),
              price: 200,
              currency: "EUR",
            },
            {
              id: "ATL-2",
              airline: "Atlas Sandbox",
              flightNumber: "XY457",
              origin: "CDG",
              destination: "LIS",
              departureTime: requestedTime,
              arrivalTime: arrival(120),
              price: 260,
              currency: "EUR",
            },
          ],
        };
      }
      async calculateFareDifference(oldFlightId: string, newFlightId: string) {
        const fares: Record<string, number> = { "ATL-1": 40, "ATL-2": 90 };
        return {
          oldFlightId,
          newFlightId,
          amount: fares[newFlightId] ?? 150,
          currency: "EUR",
          direction: "charge" as const,
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

vi.mock("@/providers/viator/ViatorActivityProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/viator/ViatorActivityProvider")>();
  return {
    ...actual,
    // Force the activity rail "configured" without any Supabase env.
    viatorEdgeConfigured: () => true,
    ViatorActivityProvider: class MockViatorActivityProvider {
      readonly providerName = "viator-edge";
      async searchActivities(query: { query: string }) {
        return { query: query.query, options: [], degraded: false };
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
import { DayReorganizer } from "@/agents";
import type { DayReorganizationOutcome, DayReorgRequest } from "@/agents/activity/DayReorganizer";
import * as storeModule from "@/lib/swarmSessionStore";
import * as tripContextModule from "@/lib/swarmTripContext";
import {
  REAL_TRIP_UUID,
  enableRealRailEnv,
  post,
  realTripContent,
  type FakeSwarmSessionStore,
  type FakeSwarmTripContextHooks,
} from "./helpers/realTripFixture";

const store = storeModule as unknown as FakeSwarmSessionStore;
const tripCtx = tripContextModule as unknown as FakeSwarmTripContextHooks;

/** Fixture trip + a SECOND same-day activity (15:00) — with a 4h delay the
 *  nominal arrival lands 15:30, so BOTH activities fall inside the flagged
 *  window and the ≥2-activities-per-day reorg gate is satisfied. */
function twoActivityTripContent(): Record<string, unknown> {
  const content = realTripContent();
  const itinerary = content.itinerary as Array<{ items: unknown[] }>;
  const day = itinerary[0];
  const items = day.items as Array<Record<string, unknown>>;
  // Insert the second activity BEFORE the stay entry.
  items.splice(items.length - 1, 0, {
    type: "activity",
    title: "Lisbon Food Tour",
    time: "15:00",
  });
  return content;
}

let reorgSpy: MockInstance<(request: DayReorgRequest) => Promise<DayReorganizationOutcome>>;

beforeEach(() => {
  store.__sessions.clear();
  store.__setPersistent(true);
  store.__setLookupError(false);
  enableRealRailEnv();
  delete process.env.GEMINI_API_KEY; // deterministic fallback rail only
  tripCtx.__setTripContent(REAL_TRIP_UUID, twoActivityTripContent());
  reorgSpy = vi.spyOn(DayReorganizer.prototype, "reorganizeDay");
});

afterEach(() => {
  reorgSpy.mockRestore();
});

describe("Task 25 (#3) — DayReorganizer gated OFF the assess rail", () => {
  it("assess never invokes the DayReorganizer, even with ≥2 flagged activities", async () => {
    const response = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; resolution_id: string };
    expect(body.status).toBe("gathering_preferences");

    // Preconditions: the mission DID flag both activities (the gate would
    // have fired pre-fix — the assertion below is not vacuous).
    const session = store.__sessions.get(body.resolution_id);
    expect(session).toBeDefined();
    const candidates = session!.candidates as Record<string, unknown>;
    const impacted = candidates.impacted_nodes as string[];
    expect(impacted).toContain("Surf Lesson");
    expect(impacted).toContain("Lisbon Food Tour");

    // The gate under test: zero day-reorganization invocations on assess.
    expect(reorgSpy).not.toHaveBeenCalled();
  });

  it("control: the resolve rail STILL invokes the DayReorganizer", async () => {
    const assessResponse = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    expect(assessResponse.status).toBe(200);
    const assess = (await assessResponse.json()) as { resolution_id: string };
    reorgSpy.mockClear(); // assess phase must not pollute the control count

    const resolveResponse = await handleHackathonRequest(
      post("mission/resolve", { resolution_id: assess.resolution_id, answers: [] }),
    );
    expect(resolveResponse.status).toBe(200);
    const body = (await resolveResponse.json()) as { status: string };
    expect(body.status).toBe("proposal_ready");

    expect(reorgSpy).toHaveBeenCalled();
  });
});
