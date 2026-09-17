/**
 * REAL-RAIL two-phase (assess/resolve) hackathon API contract tests
 * (WS5 — demo rail retired).
 *
 * Everything runs with the production gate ON (SWARM_REAL_TRIPS=1 + bearer)
 * against the shared fixture trip (helpers/realTripFixture.ts). The Atlas
 * provider is mocked at the module boundary with THREE differently-priced/
 * timed candidates (all CDG→LIS — no scripted diversion anymore), the
 * session store is a persistent in-memory fake that persists the
 * `candidates` / `plans` jsonb fields, and swarmTripContext is partially
 * mocked (real hydrate/settle transformers, stubbed Supabase seams).
 * No GEMINI_API_KEY is set — W1: assess serves the deterministic PREFERENCE
 * questions (buildPreferenceTradeoffs) through the discrimination filter
 * (dropNonDiscriminating); resolve serves the per-candidate carousel.
 *
 * Covered: assess → gathering_preferences + preference tradeoffs (≤2
 * questions × 2 options, budget-cap anchored on the cheapest net fare);
 * resolve (sync rail) → proposal_ready with per-candidate tagged plans;
 * a budget_cap answer narrows the carousel to the single honest plan;
 * swarm-status surfaces `plans` (plan === plans[0]); approve planIndex books
 * the SELECTED plan; unknown resolution_id → structured error; legacy
 * POST /mission stays byte-compatible; dropNonDiscriminating unit rail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
          // Three candidates at the ORIGINAL destination (LIS) with distinct
          // fares/arrivals — the multi-plan rail gets all three directly.
          options: [
            {
              id: "ATL-1",
              airline: "Atlas Sandbox",
              flightNumber: "XY456",
              origin: "CDG",
              destination: "LIS",
              departureTime: requestedTime,
              arrivalTime: arrival(180), // latest arrival
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
              arrivalTime: arrival(120), // earliest arrival
              price: 260,
              currency: "EUR",
            },
            {
              id: "ATL-3",
              airline: "Atlas Sandbox",
              flightNumber: "XY458",
              origin: "CDG",
              destination: "LIS",
              departureTime: requestedTime,
              arrivalTime: arrival(150), // middle arrival
              price: 230,
              currency: "EUR",
            },
          ],
        };
      }
      async calculateFareDifference(oldFlightId: string, newFlightId: string) {
        // Per-candidate fares: ATL-1 cheapest, ATL-3 middle, ATL-2 priciest.
        const fares: Record<string, number> = { "ATL-1": 40, "ATL-2": 90, "ATL-3": 60 };
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

import { dropNonDiscriminating, handleHackathonRequest } from "@/lib/hackathonApi";
import type { HackathonContext } from "@/lib/hackathonApi";
import * as storeModule from "@/lib/swarmSessionStore";
import * as tripContextModule from "@/lib/swarmTripContext";
import type { RebookingCandidate, ResolutionPlan, TradeoffQuestion } from "@/agents";
import { GeminiLiaisonAgent } from "@/agents/liaison/GeminiLiaisonAgent";
import { GEMINI_QUOTA_RETRIES } from "@/agents/geminiDegrade";
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
  delete process.env.GEMINI_API_KEY;
  tripCtx.__setTripContent(REAL_TRIP_UUID, realTripContent());
});

interface AssessBody {
  status: string;
  resolution_id: string;
  tradeoffs: TradeoffQuestion[];
}

interface ResolveBody {
  resolution_id: string;
  status: string;
  plans: ResolutionPlan[];
}

/** Full two-phase dance on the real rail; returns the resolve payload. */
async function assessThenResolve(answers: { question_id: string; option_id: string }[]) {
  const assessResponse = await handleHackathonRequest(
    post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
  );
  expect(assessResponse.status).toBe(200);
  const assess = (await assessResponse.json()) as AssessBody;
  const resolveResponse = await handleHackathonRequest(
    post("mission/resolve", { resolution_id: assess.resolution_id, answers }),
  );
  return { assess, resolveResponse };
}

describe("POST /mission/assess — phase 1", () => {
  it("returns gathering_preferences + W1 preference tradeoffs (≤2 questions × 2 options)", async () => {
    const response = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AssessBody;

    expect(body.status).toBe("gathering_preferences");
    expect(body.resolution_id).toMatch(/^res_/);
    expect(body.tradeoffs.length).toBeGreaterThanOrEqual(1);
    expect(body.tradeoffs.length).toBeLessThanOrEqual(2);
    for (const question of body.tradeoffs) {
      expect(question.id).toBeTruthy();
      expect(question.question).toBeTruthy();
      expect(question.options.length).toBe(2); // frozen contract: exactly 2
    }
    // W1: same-day, no-stop fixture ⇒ no stops/cross-date trade-off exists;
    // the ONLY discriminating preference question is the budget cap, anchored
    // on the cheapest net fare (ATL-1: €40). The legacy profile question ids
    // are gone from the assess rail.
    expect(body.tradeoffs.map((q) => q.id)).toEqual(["budget-cap"]);
    expect(body.tradeoffs[0].question).toBe("How strict should we be on price?");
    expect(body.tradeoffs[0].options.map((o) => o.id)).toEqual(["budget_cap", "allow_pricier"]);
    expect(body.tradeoffs[0].options[0].label).toBe("Keep it under €40");

    // Session persisted in gathering_preferences with raw candidates.
    const session = store.__sessions.get(body.resolution_id);
    expect(session?.state).toBe("gathering_preferences");
    expect(session?.candidates).toBeDefined();
    const candidates = session?.candidates as Record<string, unknown>;
    expect(Array.isArray(candidates.rebookingAssessment)).toBe(false);
    expect((candidates.rebookingAssessment as { candidates: unknown[] }).candidates.length).toBe(3);
    // Real-trip intent parsing names the fixture flight.
    expect(candidates.incident).toBe("Delayed flight TP437");
    expect(Array.isArray(candidates.tradeoffs)).toBe(true);
  });

  it("returns German tradeoff labels for language 'de' on the deterministic rail and persists language on the candidates blob", async () => {
    const response = await handleHackathonRequest(
      post("mission/assess", {
        intent: "reroute TP437 by 4h",
        tripId: REAL_TRIP_UUID,
        language: "de",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AssessBody;

    expect(body.status).toBe("gathering_preferences");
    const budget = body.tradeoffs.find((question) => question.id === "budget-cap");
    expect(budget).toBeDefined();
    // No GEMINI_API_KEY ⇒ deterministic PREFERENCE builder — assert the
    // EXACT German strings (locale-safe: the €40 cap survives translation).
    expect(budget!.question).toBe("Wie streng sollen wir beim Preis sein?");
    expect(budget!.options.map((option) => option.label)).toEqual([
      "Unter €40 bleiben",
      "Auch teurere Optionen zeigen",
    ]);

    // The assess `language` is persisted on the session candidates blob
    // (PersistedTwoPhaseCandidates.language), so phase 2 can recover it.
    const session = store.__sessions.get(body.resolution_id);
    const candidates = session?.candidates as Record<string, unknown>;
    expect(candidates.language).toBe("de");
  });

  it("missing tripId → 400 trip_required (the demo default is gone)", async () => {
    const response = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("trip_required");
  });

  it("free-text without a known category lands on the custom catch-all (200, not 400)", async () => {
    const response = await handleHackathonRequest(
      post("mission/assess", { intent: "tell me a joke", tripId: REAL_TRIP_UUID }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AssessBody;
    expect(body.status).toBe("gathering_preferences");
    const session = store.__sessions.get(body.resolution_id);
    const candidates = session?.candidates as Record<string, unknown>;
    expect(String(candidates.incident)).toMatch(/^Custom request for Lisbon/);
  });
});

describe("POST /mission/resolve — phase 2 (sync rail)", () => {
  it("returns proposal_ready with a per-candidate tagged carousel (one plan per non-dominated candidate)", async () => {
    const { resolveResponse } = await assessThenResolve([]);
    expect(resolveResponse.status).toBe(200);
    const body = (await resolveResponse.json()) as ResolveBody;

    expect(body.status).toBe("proposal_ready");
    expect(body.plans.length).toBe(3);
    // W1 per-candidate carousel: cheapest first, then net order; derived
    // tags replace the old fixed profile badges.
    expect(body.plans.map((plan) => plan.badge)).toEqual(["cheapest", "nonstop", "fastest"]);

    // Selection: ATL-1 (net 40) cheapest, ATL-3 (net 60), ATL-2 (net 90,
    // earliest arrival ⇒ fastest).
    expect(body.plans[0]?.proposed_resolution.new_flight?.id).toBe("ATL-1");
    expect(body.plans[1]?.proposed_resolution.new_flight?.id).toBe("ATL-3");
    expect(body.plans[2]?.proposed_resolution.new_flight?.id).toBe("ATL-2");

    // Every candidate is direct and departs on the original departure day.
    expect((body.plans[0] as ResolutionPlan & { badges?: string[] }).badges).toEqual([
      "cheapest",
      "nonstop",
      "same_day",
    ]);
    expect((body.plans[1] as ResolutionPlan & { badges?: string[] }).badges).toEqual([
      "nonstop",
      "same_day",
    ]);
    expect((body.plans[2] as ResolutionPlan & { badges?: string[] }).badges).toEqual([
      "fastest",
      "nonstop",
      "same_day",
    ]);

    // Ledger math per plan (fallback rule: 25 EUR change fee; every
    // candidate lands at LIS ⇒ NO spatial transfer re-quote anywhere).
    expect(body.plans[0]?.financial_delta.net_payable).toBe(65); // 40 + 25
    expect(body.plans[1]?.financial_delta.net_payable).toBe(85); // 60 + 25
    expect(body.plans[2]?.financial_delta.net_payable).toBe(115); // 90 + 25
    for (const plan of body.plans) {
      expect(plan.requires_human_approval).toBe(true);
      expect(typeof plan.expires_at).toBe("number"); // fresh quote TTL
      expect(plan.presentation?.ledger_summary?.length).toBeGreaterThan(0);
      expect(plan.proposed_resolution.transfer_requote).toBeUndefined();
    }

    // Session carries plans AND plan = plans[0] (backward compat).
    const session = store.__sessions.get(body.resolution_id);
    expect(session?.state).toBe("proposal_ready");
    expect((session?.plans as unknown[]).length).toBe(3);
    expect(JSON.stringify(session?.plan)).toBe(JSON.stringify(body.plans[0]));
  });

  it("a budget_cap answer narrows the carousel to the single honest plan", async () => {
    // The €40 cap filters ATL-3/ATL-2 out at resolve time; the honest
    // single-candidate rail then offers exactly ONE plan (never a fake
    // choice between identical plans).
    const { resolveResponse } = await assessThenResolve([
      { question_id: "budget-cap", option_id: "budget_cap" },
    ]);
    expect(resolveResponse.status).toBe(200);
    const body = (await resolveResponse.json()) as ResolveBody;

    expect(body.status).toBe("proposal_ready");
    expect(body.plans.length).toBe(1);
    expect(body.plans[0]?.badge).toBe("cheapest");
    expect(body.plans[0]?.proposed_resolution.new_flight?.id).toBe("ATL-1");
    expect(body.plans[0]?.financial_delta.net_payable).toBe(65);
  });

  it("surfaces plans on swarm-status with plan === plans[0]", async () => {
    const { assess, resolveResponse } = await assessThenResolve([]);
    const resolved = (await resolveResponse.json()) as ResolveBody;

    const status = await handleHackathonRequest(get(`swarm-status/${assess.resolution_id}`));
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      state: string;
      plan: ResolutionPlan;
      plans: ResolutionPlan[];
    };
    expect(body.state).toBe("proposal_ready");
    expect(body.plans.length).toBe(3);
    expect(JSON.stringify(body.plan)).toBe(JSON.stringify(body.plans[0]));
    expect(JSON.stringify(body.plan)).toBe(JSON.stringify(resolved.plans[0]));
  });

  it("unknown resolution_id → structured 404 invalid_resolution_id", async () => {
    const response = await handleHackathonRequest(
      post("mission/resolve", { resolution_id: "res_doesnotexist", answers: [] }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_resolution_id");
    expect(typeof body.message).toBe("string");
  });

  it("replaying identical choices returns the existing proposal", async () => {
    const { assess, resolveResponse } = await assessThenResolve([]);
    const original = await resolveResponse.json();

    const replay = await handleHackathonRequest(
      post("mission/resolve", { resolution_id: assess.resolution_id, answers: [] }),
    );
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body.plans).toEqual(original.plans);
  });
});

describe("POST /approve-resolution — planIndex selection", () => {
  it("planIndex books the SELECTED plan (distinct ledger per plan) and settles the trip", async () => {
    const { assess } = await assessThenResolve([]);

    const approval = await handleHackathonRequest(
      post("approve-resolution", {
        resolutionId: assess.resolution_id,
        approved: true,
        planIndex: 1,
      }),
    );
    expect(approval.status).toBe(200);
    const body = (await approval.json()) as {
      approved: boolean;
      plan_index: number;
      plan: ResolutionPlan;
      booking: { confirmationCode: string; flightId: string; status: string };
      settlement: { booking_recorded: boolean; trip_updated: boolean };
    };
    expect(body.approved).toBe(true);
    expect(body.plan_index).toBe(1);
    // Index 1 is the MIDDLE-NET plan (ATL-3, net 85) — not plans[0].
    expect(body.plan.proposed_resolution.new_flight?.id).toBe("ATL-3");
    expect(body.plan.financial_delta.net_payable).toBe(85);
    expect(body.booking.flightId).toBe("ATL-3");
    expect(body.booking.confirmationCode).toBe("ATL-CONFIRMED");
    expect(body.settlement.booking_recorded).toBe(true);
    // Real-trip settlement: the operational layer rewrote content_json.
    expect(body.settlement.trip_updated).toBe(true);
  });

  it("default planIndex 0 books plans[0]", async () => {
    const { assess } = await assessThenResolve([]);

    const approval = await handleHackathonRequest(
      post("approve-resolution", { resolutionId: assess.resolution_id, approved: true }),
    );
    expect(approval.status).toBe(200);
    const body = (await approval.json()) as {
      plan_index: number;
      plan: ResolutionPlan;
      booking: { flightId: string };
    };
    expect(body.plan_index).toBe(0);
    expect(body.plan.proposed_resolution.new_flight?.id).toBe("ATL-1");
    expect(body.booking.flightId).toBe("ATL-1");
  });

  it("out-of-range planIndex → 400 invalid_plan_index (session NOT consumed)", async () => {
    const { assess } = await assessThenResolve([]);

    const approval = await handleHackathonRequest(
      post("approve-resolution", {
        resolutionId: assess.resolution_id,
        approved: true,
        planIndex: 7,
      }),
    );
    expect(approval.status).toBe(400);
    const body = (await approval.json()) as { error: string };
    expect(body.error).toBe("invalid_plan_index");
    // Peek-before-claim: the session is still approvable afterwards.
    expect(store.__sessions.get(assess.resolution_id)?.state).toBe("proposal_ready");
  });
});

describe("legacy rails stay frozen", () => {
  it("POST /mission still returns a single sync plan (no badge) with the best-candidate ledger", async () => {
    const response = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resolution_id: string;
      plan: ResolutionPlan;
      degraded: boolean;
    };
    expect(body.degraded).toBe(false);
    expect(body.plan.badge).toBeUndefined();
    // Single-plan rail picks the best candidate (smallest net): ATL-1,
    // fare 40 + 25 change fee = 65 (no transfer re-quote — lands at LIS).
    expect(body.plan.financial_delta.total_new_charges).toBe(65);
    expect(body.plan.financial_delta.net_payable).toBe(65);
    expect(body.plan.proposed_resolution.new_flight?.id).toBe("ATL-1");
    expect(store.__sessions.get(body.resolution_id)?.state).toBe("proposal_ready");
  });

  it("approve on a LEGACY session (no plans field) ignores planIndex and books plan", async () => {
    const mission = await handleHackathonRequest(
      post("mission", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    const { resolution_id: resolutionId } = (await mission.json()) as { resolution_id: string };

    const approval = await handleHackathonRequest(
      post("approve-resolution", { resolutionId, approved: true, planIndex: 3 }),
    );
    expect(approval.status).toBe(200);
    const body = (await approval.json()) as {
      plan: ResolutionPlan;
      booking: { flightId: string };
    };
    // No `plans` on legacy sessions ⇒ fall back to `plan`, index ignored.
    expect(body.plan.proposed_resolution.new_flight?.id).toBe("ATL-1");
    expect(body.booking.flightId).toBe("ATL-1");
  });
});

// ---------------- WS1 regression: cancel landing during an async resolve

describe("async resolve rail — cancel-vs-final-upsert race (WS1)", () => {
  it("a session cancelled while resolve runs stays expired — no resurrection", async () => {
    // Phase 1: assess → gathering_preferences with persisted candidates.
    const assessResponse = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    expect(assessResponse.status).toBe(200);
    const assess = (await assessResponse.json()) as AssessBody;

    // Phase 2 (async rail): the worker acks immediately and defers the
    // pipeline to ctx.waitUntil — captured here so we can cancel mid-run.
    const pending: { promise: Promise<unknown> | null } = { promise: null };
    const ctx: HackathonContext = {
      waitUntil(promise) {
        pending.promise = promise;
      },
    };
    const ack = await handleHackathonRequest(
      post("mission/resolve", { resolution_id: assess.resolution_id, answers: [] }),
      ctx,
    );
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { status: string }).status).toBe("processing");
    expect(pending.promise).not.toBeNull();

    // The traveler cancels while the pipeline is still running.
    const cancel = await handleHackathonRequest(
      post("mission/cancel", { resolutionId: assess.resolution_id }),
    );
    expect(cancel.status).toBe(200);
    expect(store.__sessions.get(assess.resolution_id)?.state).toBe("expired");

    // The pipeline finishes: the final upsert must NOT resurrect the session.
    await pending.promise;
    expect(store.__sessions.get(assess.resolution_id)?.state).toBe("expired");
    expect(store.__sessions.get(assess.resolution_id)?.plans).toBeUndefined();
  });
});

// ------------------------------------------- W1: discrimination filter (unit)

describe("dropNonDiscriminating — simulatable flight questions only", () => {
  const candidate = (
    id: string,
    amount: number,
    arrivalOffsetMin: number,
    stops?: number,
  ): RebookingCandidate =>
    ({
      option: {
        id,
        airline: "Atlas Sandbox",
        flightNumber: `XY${id}`,
        origin: "CDG",
        destination: "LIS",
        departureTime: "2026-08-22T10:00:00Z",
        arrivalTime: new Date(
          Date.parse("2026-08-22T10:00:00Z") + arrivalOffsetMin * 60_000,
        ).toISOString(),
        price: 200,
        currency: "EUR",
        ...(stops !== undefined ? { stops } : {}),
      },
      fareDifference: {
        oldFlightId: "orig",
        newFlightId: id,
        amount,
        currency: "EUR",
        direction: "charge",
      },
    }) as unknown as RebookingCandidate;

  const stopsQuestion: TradeoffQuestion = {
    id: "flight-stops",
    question: "Nonstop, or save money with a stop?",
    options: [
      { id: "nonstop", label: "Fly nonstop" },
      { id: "cheaper_with_stop", label: "Take the cheaper routing" },
    ],
  };

  it("drops a flight question when BOTH answers yield the identical plan order", async () => {
    // All-direct pool: the nonstop answer filters nothing (direct.length ===
    // pool.length), cheaper_with_stop constrains nothing ⇒ same sequence.
    const kept = dropNonDiscriminating(
      [stopsQuestion],
      [candidate("D1", 40, 120), candidate("D2", 60, 150)],
    );
    expect(kept).toEqual([]);
  });

  it("keeps a flight question whose answers produce different selections", async () => {
    // Mixed pool: nonstop narrows to D1; cheaper_with_stop keeps both with
    // S1 (cheaper) first ⇒ different ordered sequences.
    const kept = dropNonDiscriminating(
      [stopsQuestion],
      [candidate("D1", 100, 120), candidate("S1", 50, 180, 1)],
    );
    expect(kept.map((q) => q.id)).toEqual(["flight-stops"]);
  });

  it("never simulates non-flight questions — they pass through untouched", async () => {
    const activity: TradeoffQuestion = {
      id: "activity-priority",
      question: "Two activities are at risk — which one do we protect?",
      options: [
        { id: "keep_a", label: "Keep A" },
        { id: "drop_a", label: "Drop A" },
      ],
    };
    const kept = dropNonDiscriminating([activity], [candidate("D1", 40, 120)]);
    expect(kept.map((q) => q.id)).toEqual(["activity-priority"]);
  });
});

// --------------------------------------- Task 21: Gemini liveness (resolve rail)

describe("Gemini liveness — resolve rail (Task 21)", () => {
  interface TraceRow {
    agent: string;
    step: string;
    detail: string;
  }

  /** Stub global fetch: 429-shaped answers for Gemini URLs only; every other
   *  URL keeps the real implementation (the harness mocks everything else). */
  function stubGeminiFetch(status: number): { count: () => number } {
    const original = globalThis.fetch;
    let geminiCalls = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("generativelanguage.googleapis.com")) {
        geminiCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
            status,
            statusText: "RATE LIMITED",
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return original(input as Parameters<typeof fetch>[0], init);
    });
    return { count: () => geminiCalls };
  }

  async function assessFirst(): Promise<AssessBody> {
    const assessResponse = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    expect(assessResponse.status).toBe(200);
    return (await assessResponse.json()) as AssessBody;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ack latency: 200 processing returns BEFORE translateAnswersToConstraints runs", async () => {
    const assess = await assessFirst();

    // Gate the translate so an ack-side await would deadlock the test: the
    // ack MUST come back while the translate is still untouched.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const translateSpy = vi
      .spyOn(GeminiLiaisonAgent.prototype, "translateAnswersToConstraints")
      .mockImplementation(async () => {
        await gate;
        return {}; // deterministic-shaped constraints
      });

    const pending: { promise: Promise<unknown> | null } = { promise: null };
    const ctx: HackathonContext = {
      waitUntil(promise) {
        pending.promise = promise;
      },
    };
    const ack = await handleHackathonRequest(
      post("mission/resolve", { resolution_id: assess.resolution_id, answers: [] }),
      ctx,
    );
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { status: string }).status).toBe("processing");
    // The ack beat the liaison: translate runs INSIDE waitUntil, never on
    // the ack path.
    expect(translateSpy).not.toHaveBeenCalled();

    release();
    await pending.promise;
    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(store.__sessions.get(assess.resolution_id)?.state).toBe("proposal_ready");
  });

  it("async rail, every model rate-limited: the ladder is walked, then bounded", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const gemini = stubGeminiFetch(429);
    const assess = await assessFirst();

    const pending: { promise: Promise<unknown> | null } = { promise: null };
    const ctx: HackathonContext = {
      waitUntil(promise) {
        pending.promise = promise;
      },
    };
    const ack = await handleHackathonRequest(
      post("mission/resolve", { resolution_id: assess.resolution_id, answers: [] }),
      ctx,
    );
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { status: string }).status).toBe("processing");
    await pending.promise; // includes the real ~1.5 s retry backoff

    // The ladder walks down on a capacity answer: the primary plus
    // GEMINI_QUOTA_RETRIES fallbacks. Single-shot would be 1; unbounded would
    // keep going until the per-mission budget ran out.
    expect(gemini.count()).toBe(1 + GEMINI_QUOTA_RETRIES);
    const trace = (store.__sessions.get(assess.resolution_id)?.trace ?? []) as TraceRow[];
    const row = trace.find(
      (entry) => entry.agent === "liaison" && entry.step === "gemini_degraded",
    );
    expect(row).toBeDefined();
    expect(row!.detail).toContain("quota_429");
    // Deterministic fallback constraints still produce the full carousel.
    expect(store.__sessions.get(assess.resolution_id)?.state).toBe("proposal_ready");
    expect(((store.__sessions.get(assess.resolution_id)?.plans ?? []) as unknown[]).length).toBe(3);
  });

  it("sync rail 429: walks ONE rung down the ladder, then stops", async () => {
    // The sync rail used to be strictly single-shot, on the reasoning that the
    // caller is waiting on it. That also meant the model ladder could never
    // advance here: one refusal from the leading model dropped constraint
    // translation to the deterministic rail without ever asking a lighter one,
    // which on the live matrix of 2026-09-01 was most of the degradations.
    //
    // What matters is that it stays BOUNDED, not that it stays at one: exactly
    // one extra attempt, against the NEXT model, each with its own deadline.
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const gemini = stubGeminiFetch(429);

    const { resolveResponse } = await assessThenResolve([]);
    expect(resolveResponse.status).toBe(200);
    const body = (await resolveResponse.json()) as ResolveBody & {
      swarm_trace: TraceRow[];
    };

    expect(body.status).toBe("proposal_ready");
    // One rung: 2 attempts. NOT the async rail's 1 + GEMINI_QUOTA_RETRIES, and
    // NOT unbounded — a user is waiting on this response.
    expect(gemini.count()).toBe(2);
    expect(gemini.count()).toBeLessThan(1 + GEMINI_QUOTA_RETRIES);
    // Every model refusing still degrades honestly rather than throwing.
    const row = body.swarm_trace.find(
      (entry) => entry.agent === "liaison" && entry.step === "gemini_degraded",
    );
    expect(row).toBeDefined();
    expect(row!.detail).toContain("quota_429");
  });
});

describe("resolve operation identity", () => {
  it("concurrent identical submissions schedule only one continuation", async () => {
    const assessed = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    const { resolution_id } = await assessed.json();
    const pending: Promise<unknown>[] = [];
    const ctx: HackathonContext = {
      waitUntil(promise) {
        pending.push(promise);
      },
    };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        handleHackathonRequest(post("mission/resolve", { resolution_id, answers: [] }), ctx),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(store.__sessions.get(resolution_id)?.state).toBe("proposal_ready");
  });
  it("rejects changed choices on an existing operation", async () => {
    const { assess } = await assessThenResolve([]);
    const response = await handleHackathonRequest(
      post("mission/resolve", {
        resolution_id: assess.resolution_id,
        answers: [{ question_id: "budget_cap", option_id: "changed" }],
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("resolution_input_conflict");
  });
  it("a synchronous resolve cannot overwrite cancellation during translation", async () => {
    const assessed = await handleHackathonRequest(
      post("mission/assess", { intent: "reroute TP437 by 4h", tripId: REAL_TRIP_UUID }),
    );
    const { resolution_id } = await assessed.json();
    const original = GeminiLiaisonAgent.prototype.translateAnswersToConstraints;
    const spy = vi
      .spyOn(GeminiLiaisonAgent.prototype, "translateAnswersToConstraints")
      .mockImplementationOnce(async function (this: GeminiLiaisonAgent, questions, answers) {
        await store.cancelSwarmSession(resolution_id);
        return original.call(this, questions, answers);
      });
    try {
      const response = await handleHackathonRequest(
        post("mission/resolve", { resolution_id, answers: [] }),
      );
      expect(response.status).toBe(409);
      expect(store.__sessions.get(resolution_id)?.state).toBe("expired");
      expect(store.__sessions.get(resolution_id)?.plans).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("settlement response recovery", () => {
  it("replays a receipt without booking again and exposes it after quote expiry", async () => {
    const { AtlasFlightProvider } = await import("@/providers/atlas/AtlasFlightProvider");
    const book = vi.spyOn(AtlasFlightProvider.prototype, "bookFlight");
    try {
      const { assess } = await assessThenResolve([]);
      const approve = () =>
        handleHackathonRequest(
          post("approve-resolution", {
            resolutionId: assess.resolution_id,
            approved: true,
            planIndex: 0,
          }),
        );
      const first = await approve();
      expect(first.status).toBe(200);
      const original = await first.json();
      store.__sessions.get(assess.resolution_id)!.expires_at = new Date(
        Date.now() - 1000,
      ).toISOString();
      const repeated = await approve();
      expect(repeated.status).toBe(200);
      expect((await repeated.json()).booking).toEqual(original.booking);
      expect(book).toHaveBeenCalledTimes(1);
      const status = await handleHackathonRequest(get(`swarm-status/${assess.resolution_id}`));
      expect(status.status).toBe(200);
      expect((await status.json()).receipt.booking).toEqual(original.booking);
    } finally {
      book.mockRestore();
    }
  });
  it("does not accept a different plan after approval", async () => {
    const { assess } = await assessThenResolve([]);
    await handleHackathonRequest(
      post("approve-resolution", {
        resolutionId: assess.resolution_id,
        approved: true,
        planIndex: 0,
      }),
    );
    const changed = await handleHackathonRequest(
      post("approve-resolution", {
        resolutionId: assess.resolution_id,
        approved: true,
        planIndex: 1,
      }),
    );
    expect(changed.status).toBe(409);
    expect((await changed.json()).error).toBe("approval_input_conflict");
  });
});
