/**
 * Bug fix — a directly-cancelled activity with an in-graph dependent (a
 * later same-day activity) never got its own resolution.
 *
 * REGRESSION, found live 2026-09-14: "Activity cancelled — Lau Pa Sat"
 * (Lau Pa Sat has a same-day dependent, Night Safari) produced a plan that
 * only mentioned Night Safari's downstream reschedule and said NOTHING about
 * Lau Pa Sat — the exact activity the traveler reported. Root cause:
 * `disruption.affected` (from `ItineraryGraph.handleDisruption`) only ever
 * lists DOWNSTREAM nodes, never the disrupted node itself. The direct-target
 * synthesis block that's supposed to cover that gap was gated on
 * `!hadInitialRequests` — "only run if NOTHING else was requested" — so
 * Night Safari's real (downstream) request made the gate skip Lau Pa Sat
 * entirely. The traveler who reported the cancellation got an answer about a
 * different activity and silence about the one they named.
 *
 * Fixed: the gate is now per-node (has THIS node already been requested?),
 * not per-mission (was anything requested at all?).
 */

import { describe, expect, it } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { OrchestratorAgent } from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import type { FlightAgent, FlightRebookingAssessment } from "@/agents/flight/FlightAgent";
import { ActivityAgent } from "@/agents/activity/ActivityAgent";
import type { ActivityProvider } from "@/providers/interfaces/ActivityProvider";
import type { ActivitySearchQuery, ActivitySearchResult } from "@/providers/interfaces/types";

const MINUTE_MS = 60_000;
const BASE = Date.parse("2026-10-09T05:00:00Z"); // 13:00 SGT
const LAU_PA_SAT = "activity-1-1";
const NIGHT_SAFARI = "activity-1-2";

/** Lau Pa Sat (13:00), Night Safari (19:30) depends on it — same day. */
function buildGraph(): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: LAU_PA_SAT,
    type: "activity",
    name: "Lau Pa Sat",
    durationMinutes: 60,
    scheduledTime: BASE,
    status: "on_track",
    dependsOn: [],
  });
  graph.addNode({
    id: NIGHT_SAFARI,
    type: "activity",
    name: "Night Safari",
    durationMinutes: 120,
    scheduledTime: BASE + 390 * MINUTE_MS, // 19:30
    status: "on_track",
    dependsOn: [LAU_PA_SAT],
  });
  return graph;
}

/** Finds nothing — every proposal takes the deterministic heuristic path. */
const silentProvider: ActivityProvider = {
  providerName: "test-silent",
  async searchActivities(query: ActivitySearchQuery): Promise<ActivitySearchResult> {
    return { query: query.query, degraded: true, options: [] };
  },
};

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

describe("OrchestratorAgent — a directly-cancelled activity with a same-day dependent", () => {
  it("resolves BOTH the cancelled activity itself and its downstream sibling — neither is silent", async () => {
    const activityAgent = new ActivityAgent(silentProvider);
    const orchestrator = new OrchestratorAgent(
      buildGraph(),
      flightStub(),
      null,
      null,
      activityAgent,
      null,
      null,
      null, // no DayReorganizer — exercises the legacy per-item rail directly
    );

    const event: DisruptionEvent = {
      nodeId: LAU_PA_SAT,
      delay: 300, // 5h — enough to push Night Safari inside the impact buffer
      description: "Change requested — activity cancelled Lau Pa Sat",
      origin: "reactive",
    };
    const { activityProposals } = await orchestrator.resolveDisruption(event);

    const nodeIds = activityProposals.map((p) => p.activityNodeId);
    expect(nodeIds).toContain(LAU_PA_SAT);
    expect(nodeIds).toContain(NIGHT_SAFARI);
    expect(activityProposals).toHaveLength(2);

    const laupaSat = activityProposals.find((p) => p.activityNodeId === LAU_PA_SAT)!;
    expect(laupaSat).toBeDefined();
    expect(["reschedule", "swap", "drop"]).toContain(laupaSat.action);
  });
});
