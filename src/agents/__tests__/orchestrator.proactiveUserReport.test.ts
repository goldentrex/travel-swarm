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
