/**
 * WS4 — OrchestratorAgent proactive `user_report` synthesis tests.
 *
 * Strike-without-transit and feeling-unwell missions carry `delay: 0` and
 * target an activity node directly. ItineraryGraph.handleDisruption treats a
 * zero delay as a no-op, so proposeActivityRescheduling must SYNTHESIZE the
 * ActivityAgent request (same mechanism as the proactive weather path) or no
 * Viator-backed retime/swap proposal would ever be produced.
 *
 * Specialists are stubbed exactly like orchestrator.enrichment.test.ts;
 * no LLM / no live network (global fetch is stubbed where geocoding runs).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { OrchestratorAgent } from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import type { FlightAgent, FlightRebookingAssessment } from "@/agents/flight/FlightAgent";
import type {
  ActivityAgent,
  ActivityRescheduleProposal,
  ActivityRescheduleRequest,
} from "@/agents/activity/ActivityAgent";
import { validateResolutionPlan } from "@/agents/finance/TrustLayer";

const MINUTE_MS = 60_000;
const NOW = Date.parse("2026-08-22T08:00:00Z");
const BASE = Date.parse("2026-08-22T09:00:00Z");

const ACTIVITY_ID = "activity-surf";

function flightStub(): FlightAgent {
  return {
    assessRebookingOptions: async (
      flightId: string,
      newTime: string,
    ): Promise<FlightRebookingAssessment> => ({
      originalFlightId: flightId,
      requestedTime: newTime,
      candidates: [],
      bestCandidate: null,
    }),
  } as unknown as FlightAgent;
}

/** Captures the requests handed to the ActivityAgent for assertions. */
function activitySpy(proposals: ActivityRescheduleProposal[]): {
  agent: ActivityAgent;
  requests: ActivityRescheduleRequest[];
} {
  const requests: ActivityRescheduleRequest[] = [];
  const agent = {
    proposeRescheduling: async (reqs: ActivityRescheduleRequest[]) => {
      requests.push(...reqs);
      return proposals;
    },
  } as unknown as ActivityAgent;
  return { agent, requests };
}

/** Single-activity graph: no flights/transfers to propagate a delay through. */
function buildGraph(): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: ACTIVITY_ID,
    type: "activity",
    name: "Surf Lesson",
    durationMinutes: 60,
    scheduledTime: BASE + 270 * MINUTE_MS, // 2026-08-22T13:30:00Z
    status: "on_track",
    dependsOn: [],
  });
  return graph;
}

function makeUserReportEvent(overrides: Partial<DisruptionEvent> = {}): DisruptionEvent {
  return {
    nodeId: ACTIVITY_ID,
    delay: 0,
    description: "Lighten the day in Lisbon: feeling unwell, please lighten the day",
    origin: "proactive",
    evidence: {
      kind: "user_report",
      source: "mission-intent",
      confidence: 0.8,
      detail: "feeling unwell, please lighten the day",
    },
    ...overrides,
  };
}

const PROPOSAL: ActivityRescheduleProposal = {
  activityNodeId: ACTIVITY_ID,
  action: "reschedule",
  newTime: "2026-08-23T10:00:00Z",
  penalty: 0,
  currency: "EUR",
};

describe("OrchestratorAgent — proactive user_report synthesis (WS4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("synthesizes a request for a proactive user_report mission and yields non-empty activity proposals", async () => {
    const spy = activitySpy([PROPOSAL]);
    const orchestrator = new OrchestratorAgent(buildGraph(), flightStub(), null, null, spy.agent);

    const outcome = await orchestrator.resolveDisruption(makeUserReportEvent());

    // The zero-delay no-op must NOT starve the ActivityAgent.
    expect(spy.requests).toHaveLength(1);
    expect(spy.requests[0]).toMatchObject({
      activityNodeId: ACTIVITY_ID,
      activityName: "Surf Lesson",
      originalTime: "2026-08-22T13:30:00.000Z",
      // Rebooking window anchored on the activity's own slot (+24h..+48h).
      windowStart: "2026-08-23T13:30:00.000Z",
      windowEnd: "2026-08-24T13:30:00.000Z",
    });
    // No weather hint leaks into a user_report mission.
    expect(spy.requests[0].weatherHint).toBeUndefined();

    expect(outcome.activityProposals).toHaveLength(1);
    const entries = outcome.plan.proposed_resolution.rescheduled_activities;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].name).toBe("Surf Lesson");
    expect(entries[0].new_time_iso).toBe("2026-08-23T10:00:00Z");
    expect(validateResolutionPlan(outcome.plan)).toBe(true);
  });

  it("covers the strike-without-transit mission shape (user_report, detail transit_strike)", async () => {
    const spy = activitySpy([PROPOSAL]);
    const orchestrator = new OrchestratorAgent(buildGraph(), flightStub(), null, null, spy.agent);

    const outcome = await orchestrator.resolveDisruption(
      makeUserReportEvent({
        description: "Strike in Lisbon: re-planning around Surf Lesson: there is a strike",
        evidence: {
          kind: "user_report",
          source: "mission-intent",
          confidence: 0.8,
          detail: "transit_strike",
        },
      }),
    );

    expect(spy.requests).toHaveLength(1);
    expect(outcome.activityProposals).toHaveLength(1);
    expect(outcome.plan.proposed_resolution.rescheduled_activities.length).toBeGreaterThan(0);
    expect(validateResolutionPlan(outcome.plan)).toBe(true);
  });

  it("still synthesizes when the proactive geocode check degrades (city set, fetch down)", async () => {
    // Production missions carry tripContext.city: the proactive branch then
    // probes the real weather/event providers. A failing geocode must never
    // swallow the user_report synthesis.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const spy = activitySpy([PROPOSAL]);
    const orchestrator = new OrchestratorAgent(buildGraph(), flightStub(), null, null, spy.agent);

    const outcome = await orchestrator.resolveDisruption(
      makeUserReportEvent({ tripContext: { city: "Lisbon", currency: "EUR" } }),
    );

    expect(spy.requests).toHaveLength(1);
    // Hydrated context scopes the provider search + currency.
    expect(spy.requests[0].location).toBe("Lisbon");
    expect(spy.requests[0].currency).toBe("EUR");
    expect(outcome.activityProposals).toHaveLength(1);
    expect(validateResolutionPlan(outcome.plan)).toBe(true);
  });

  it("does NOT synthesize for a reactive zero-delay event (scope is strictly proactive user_report)", async () => {
    const spy = activitySpy([PROPOSAL]);
    const orchestrator = new OrchestratorAgent(buildGraph(), flightStub(), null, null, spy.agent);

    const outcome = await orchestrator.resolveDisruption(
      makeUserReportEvent({ origin: "reactive", evidence: undefined }),
    );

    expect(spy.requests).toHaveLength(0);
    expect(outcome.activityProposals).toHaveLength(0);
    expect(outcome.plan.proposed_resolution.rescheduled_activities).toHaveLength(0);
  });
});

describe("an overbooked traveller is never left with a blank plan", () => {
  it("keeps the advisory row even when the traveller drops the booking", async () => {
    // Live on 2026-09-18 the `keep_hotel=false` filter kept only `rebook`
    // rows, so the one line that explained the situation — "we could not find
    // a comparable room, the property owes you a rehousing" — was deleted, and
    // a mission entirely about the hotel produced no mention of the hotel.
    const { OrchestratorAgent } = await import("../orchestrator/OrchestratorAgent");
    const { ItineraryGraph } = await import("../../core/dag/ItineraryGraph");
    const graph = new ItineraryGraph();
    graph.addNode({
      id: "hotel-0-0",
      type: "hotel_check_in",
      hotelName: "Hotel Gracery Shinjuku",
      scheduledTime: Date.now() + 6 * 3_600_000,
      status: "on_track",
      dependsOn: [],
    });
    // No HotelAgent at all — the exact state the live Worker was in.
    const orchestrator = new OrchestratorAgent(graph, null, null, null, null);
    const outcome = await orchestrator.resolveDisruptionMulti(
      {
        nodeId: "hotel-0-0",
        delay: 0,
        description: "Hotel issue at Hotel Gracery Shinjuku: My hotel is overbooked",
        origin: "reactive",
      },
      { keep_hotel: false },
    );
    const rows = outcome.plans[0]?.proposed_resolution.hotel_adjustments ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].requires_confirmation).toBe(true);
    expect(rows[0].note).toMatch(/rehouse/i);
    // And never a late check-in: the room does not exist at any hour.
    expect(rows[0].action).not.toBe("late_check_in");
  });
});

describe("a broken connection does not reshuffle the itinerary", () => {
  it("answers a strike with the ground, and leaves the plans alone", async () => {
    // Live on 2026-09-18 a transit strike produced a correct ground plan AND
    // moved one restaurant to the following evening — for a strike that is
    // itself tomorrow. We cannot verify the strike or know which lines it
    // closes, so which item to move is a guess wearing the clothes of a plan.
    const { OrchestratorAgent } = await import("../orchestrator/OrchestratorAgent");
    const { ItineraryGraph } = await import("../../core/dag/ItineraryGraph");
    const graph = new ItineraryGraph();
    const base = Date.now() + 6 * 3_600_000;
    graph.addNode({
      id: "activity-0-0",
      type: "activity",
      name: "Rules Restaurant",
      durationMinutes: 90,
      scheduledTime: base,
      status: "on_track",
      dependsOn: [],
    });
    const orchestrator = new OrchestratorAgent(graph, null, null, null, null);
    const outcome = await orchestrator.resolveDisruptionMulti({
      nodeId: "activity-0-0",
      delay: 0,
      description: "Strike in London: re-planning around Rules Restaurant: Transit strike tomorrow",
      origin: "proactive",
      groundOnly: true,
      evidence: {
        kind: "user_report",
        source: "mission-intent",
        confidence: 0.8,
        detail: "transit_strike",
      },
    });
    expect(outcome.plans[0]?.proposed_resolution.rescheduled_activities ?? []).toHaveLength(0);
  });
});

describe("a corroborating provider cannot take the mission down with it", () => {
  it("still adapts the day when the weather API refuses the key", async () => {
    // Caught in the battery of 2026-09-18: OpenWeather answers 401 on
    // /data/3.0/onecall — the key has no One Call subscription — and the
    // exception unwound the entire pipeline. Every Bali weather mission fell
    // through to the empty degraded plan, so a traveller reporting rain got a
    // plan proposing nothing, on the one trip of six where the check ran.
    const { OrchestratorAgent } = await import("../orchestrator/OrchestratorAgent");
    const { ItineraryGraph } = await import("../../core/dag/ItineraryGraph");
    const graph = new ItineraryGraph();
    graph.addNode({
      id: "activity-0-0",
      type: "activity",
      name: "Seminyak Beach Morning Stroll",
      durationMinutes: 90,
      scheduledTime: Date.now() + 20 * 3_600_000,
      status: "on_track",
      dependsOn: [],
    });

    const exploding = {
      providerName: "openweathermap",
      async getRainForecast() {
        throw new Error("OpenWeatherMap request to /data/3.0/onecall failed with HTTP 401.");
      },
    };

    const orchestrator = new OrchestratorAgent(
      graph,
      null,
      null,
      null,
      null,
      exploding as never,
    );

    const outcome = await orchestrator.resolveDisruptionMulti({
      nodeId: "activity-0-0",
      delay: 0,
      description: "Weather alert — Bali",
      origin: "proactive",
      evidence: { kind: "weather", source: "mission-intent", confidence: 0.6, detail: "heavy rain" },
      tripContext: { city: "Bali" },
    });

    // The mission survives. What it must NOT do is claim the rain was
    // confirmed when the check never ran.
    expect(outcome.plans.length).toBeGreaterThan(0);
    expect(outcome.plans[0].incident).not.toMatch(/confirmed rain/i);
  });
});

describe("a question about a connection changes nothing", () => {
  /** SIN → FCO via Doha on one ticket, with the day's first plan downstream. */
  function oneStopGraph() {
    const graph = new ItineraryGraph();
    const depart = Date.now() + 30 * 3_600_000;
    const hour = 3_600_000;
    graph.addNode({
      id: "flight-0",
      type: "flight",
      flightNumber: "QR943",
      origin: "SIN",
      destination: "FCO",
      departureTime: depart,
      arrivalTime: depart + 10.75 * hour,
      scheduledTime: depart,
      status: "on_track",
      dependsOn: [],
      segments: [
        { reference: "QR943", from: "SIN", to: "DOH", departureTime: depart, arrivalTime: depart + 3 * hour },
        { reference: "QR115", from: "DOH", to: "FCO", departureTime: depart + 5.5 * hour, arrivalTime: depart + 10.75 * hour },
      ],
    });
    graph.addNode({
      id: "activity-0-0",
      type: "activity",
      name: "Colosseum timed entry",
      durationMinutes: 120,
      scheduledTime: depart + 14 * hour,
      status: "on_track",
      dependsOn: ["flight-0"],
    });
    return graph;
  }

  /** A provider that counts the searches it is asked for. */
  function counting(): { agent: FlightAgent; calls: { n: number } } {
    const calls = { n: 0 };
    const agent = {
      assessRebookingOptions: async (flightId: string, newTime: string): Promise<FlightRebookingAssessment> => {
        calls.n += 1;
        return { originalFlightId: flightId, requestedTime: newTime, candidates: [], bestCandidate: null };
      },
    } as unknown as FlightAgent;
    return { agent, calls };
  }

  const event = (adviceOnly: boolean): DisruptionEvent => ({
    nodeId: "flight-0",
    delay: 0,
    description: "Connection at DOH — QR115 DOH → FCO",
    origin: "reactive",
    ...(adviceOnly ? { adviceOnly: true } : {}),
  });

  it("never goes looking for a seat, and leaves the day exactly as booked", async () => {
    // Before this, a live provider answered the 0-minute "delay" with a
    // later flight; the re-drive then shifted the day by that flight's
    // arrival, priced a fare and a change fee, and asked the traveller to
    // approve a rebooking of a flight nobody had missed.
    const calls = { n: 0 };
    const provider = {
      assessRebookingOptions: async () => {
        calls.n += 1;
        throw new Error("the flight rail must stand down on a question");
      },
    } as unknown as FlightAgent;
    const orchestrator = new OrchestratorAgent(oneStopGraph(), provider, null, null, null);
    const outcome = await orchestrator.resolveDisruptionMulti(event(true));
    expect(calls.n).toBe(0);
    const plan = outcome.plans[0];
    expect(plan).toBeDefined();
    expect(plan.proposed_resolution.new_flight).toBeUndefined();
    expect(plan.proposed_resolution.policy_verdict).toBeUndefined();
    expect(plan.proposed_resolution.rescheduled_activities).toEqual([]);
    expect(plan.financial_delta.net_payable).toBe(0);
    expect(plan.expires_at).toBeUndefined();
    // The headline is the question, with no "needs a manual booking" bolted on.
    expect(plan.incident).toBe("Connection at DOH — QR115 DOH → FCO");
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("is the flag that makes the difference: without it the rail searches", async () => {
    // Documents WHY the gate exists — the same event and provider with no
    // flag: the rail goes looking for a replacement for a flight that was
    // never late, and whatever it finds would be proposed as a rebooking.
    const provider = counting();
    const orchestrator = new OrchestratorAgent(oneStopGraph(), provider.agent, null, null, null);
    await orchestrator.resolveDisruptionMulti(event(false));
    expect(provider.calls.n).toBeGreaterThan(0);
  });
});
