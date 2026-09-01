/**
 * Review fix 4 — weather indoor-swap preservation.
 *
 * Timing-driven requests carry a `weatherHint`. A rain/storm day with ≥2
 * flagged outdoor activities used to route the WHOLE day to the
 * DayReorganizer, which only emits retime/drop — silently killing the
 * pre-existing indoor `swap` behaviour (ActivityAgent.findIndoorSwap,
 * action "swap" with replacement/priceDelta/media).
 *
 * The fix EXEMPTS rain/storm-hinted requests from the reorg bucket: they
 * stay on the legacy per-item ActivityAgent rail (swap-first preserved).
 * The DayReorganizer remains the rail for timing-driven (missed-flight)
 * multi-activity days.
 */

import { describe, expect, it, vi } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { OrchestratorAgent } from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import type { FlightAgent, FlightRebookingAssessment } from "@/agents/flight/FlightAgent";
import { ActivityAgent } from "@/agents/activity/ActivityAgent";
import type { DayReorganizer, DayReorganizationOutcome } from "@/agents/activity/DayReorganizer";
import type { ActivityProvider } from "@/providers/interfaces/ActivityProvider";
import type { ActivitySearchQuery, ActivitySearchResult } from "@/providers/interfaces/types";

const MINUTE_MS = 60_000;
const BASE = Date.parse("2026-09-10T09:00:00Z");
const FLIGHT_ID = "flight-xy123";
const ACTIVITY_A = "activity-surf";
const ACTIVITY_B = "activity-hike";

/** Flight → two outdoor activities the same day (both downstream). */
function buildGraph(): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: FLIGHT_ID,
    type: "flight",
    flightNumber: "XY123",
    origin: "CDG",
    destination: "LIS",
    departureTime: BASE,
    arrivalTime: BASE + 150 * MINUTE_MS, // lands 11:30
    scheduledTime: BASE,
    status: "on_track",
    dependsOn: [],
    arrivalLocationId: "LIS",
  });
  graph.addNode({
    id: ACTIVITY_A,
    type: "activity",
    name: "Surf Lesson",
    durationMinutes: 60,
    scheduledTime: BASE + 270 * MINUTE_MS, // 13:30
    status: "on_track",
    dependsOn: [FLIGHT_ID],
  });
  graph.addNode({
    id: ACTIVITY_B,
    type: "activity",
    name: "Coastal Hike",
    durationMinutes: 90,
    scheduledTime: BASE + 360 * MINUTE_MS, // 15:00
    status: "on_track",
    dependsOn: [FLIGHT_ID],
  });
  return graph;
}

/** Provider that always offers one indoor replacement (drives the swap). */
function indoorSwapProvider(): ActivityProvider {
  return {
    providerName: "indoor-fake",
    async searchActivities(query: ActivitySearchQuery): Promise<ActivitySearchResult> {
      return {
        query: query.query,
        degraded: false,
        options: [
          {
            id: "OCEANARIUM-1",
            name: "Lisbon Oceanarium Ticket",
            price: 25,
            currency: "EUR",
            setting: "indoor",
            image: "https://img.example/oceanarium.jpg",
            rating: 4.8,
          },
        ],
      };
    },
  };
}

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

/** DayReorganizer stub: returns retime decisions for both slots. */
function reorganizerStub(): DayReorganizer {
  return {
    reorganizeDay: async (): Promise<DayReorganizationOutcome> => ({
      decisions: [
        {
          nodeId: ACTIVITY_A,
          action: "retime",
          newTime: "2026-09-10T16:00:00Z",
          reason: "resequenced",
        },
        {
          nodeId: ACTIVITY_B,
          action: "retime",
          newTime: "2026-09-10T18:00:00Z",
          reason: "resequenced",
        },
      ],
      source: "deterministic",
    }),
  } as unknown as DayReorganizer;
}

/** A 4h flight delay flags both same-day activities for rescheduling. */
function makeEvent(evidence?: DisruptionEvent["evidence"]): DisruptionEvent {
  return {
    nodeId: FLIGHT_ID,
    delay: 240,
    description: "Flight XY123 delayed by 4h",
    ...(evidence ? { evidence } : {}),
  };
}

describe("OrchestratorAgent weather indoor-swap preservation (review fix 4)", () => {
  it("rain day with 2 outdoor activities keeps the swap-capable legacy rail (reorg never used)", async () => {
    const stub = reorganizerStub();
    const reorgSpy = vi.spyOn(stub, "reorganizeDay");
    const activityAgent = new ActivityAgent(indoorSwapProvider());
    const orchestrator = new OrchestratorAgent(
      buildGraph(),
      flightStub(),
      null,
      null,
      activityAgent,
      null,
      null,
      stub,
    );

    const rainEvent = makeEvent({
      kind: "weather",
      source: "openweathermap:test",
      confidence: 0.9,
      detail: "Heavy rain 14:00-20:00 local, 92% precip probability",
    });
    const { activityProposals } = await orchestrator.resolveDisruption(rainEvent);

    // The DayReorganizer must NOT have consumed the day — rain/storm requests
    // are exempt and stay on the legacy swap-first rail.
    expect(reorgSpy).not.toHaveBeenCalled();
    // Both outdoor activities resolve to indoor SWAP proposals (not retime/drop).
    expect(activityProposals).toHaveLength(2);
    for (const proposal of activityProposals) {
      expect(proposal.action).toBe("swap");
      expect(proposal.swap).toBeDefined();
      expect(proposal.swap!.replacementName).toBe("Lisbon Oceanarium Ticket");
      expect(proposal.swap!.priceDelta).toBeTypeOf("number");
    }
  });

  it("a timing-driven multi-activity day still routes to the DayReorganizer (control)", async () => {
    const stub = reorganizerStub();
    const reorgSpy = vi.spyOn(stub, "reorganizeDay");
    const activityAgent = new ActivityAgent(indoorSwapProvider());
    const orchestrator = new OrchestratorAgent(
      buildGraph(),
      flightStub(),
      null,
      null,
      activityAgent,
      null,
      null,
      stub,
    );

    // No weather evidence ⇒ timing-driven (missed-flight) day ⇒ reorg bucket.
    const { activityProposals } = await orchestrator.resolveDisruption(makeEvent());

    expect(reorgSpy).toHaveBeenCalledTimes(1);
    expect(activityProposals).toHaveLength(2);
    for (const proposal of activityProposals) {
      expect(proposal.action).toBe("reschedule");
      expect(proposal.reorgSource).toBe("deterministic");
    }
  });
});
