/**
 * Review fix 2 — assess-phase latency: ActivityAgent Viator consult fan-out.
 *
 * Two guarantees the W2 agent layer must hold:
 *   (a) CAP — at most VIATOR_CONSULTS_PER_MISSION (6) slots are grounded
 *       against live Viator per mission, so a wide disruption cannot stack
 *       ~18 sequential consult fetches inside POST /mission/assess's 20 s
 *       budget (nor blow the Workers Free-plan 50-subrequest ceiling).
 *   (b) CONCURRENCY — the consults that DO run fan out together
 *       (Promise.all/allSettled), never awaited one-by-one.
 *
 * The fake provider counts in-flight calls and total calls so both
 * properties are observable without any network.
 */

import { describe, expect, it } from "vitest";
import { ActivityAgent } from "@/agents/activity/ActivityAgent";
import type { ActivityRescheduleRequest } from "@/agents/activity/ActivityAgent";
import type { DayActivityInput, DayReorgDecision } from "@/agents/activity/DayReorganizer";
import type { ActivityProvider } from "@/providers/interfaces/ActivityProvider";
import type { ActivitySearchQuery, ActivitySearchResult } from "@/providers/interfaces/types";

interface ProviderStats {
  totalCalls: number;
  inFlight: number;
  maxInFlight: number;
}

/** Provider that holds each search briefly and counts overlapping calls. */
function makeCountingProvider(holdMs: number): {
  provider: ActivityProvider;
  stats: ProviderStats;
} {
  const stats: ProviderStats = { totalCalls: 0, inFlight: 0, maxInFlight: 0 };
  const provider: ActivityProvider = {
    providerName: "counting-fake",
    async searchActivities(query: ActivitySearchQuery): Promise<ActivitySearchResult> {
      stats.totalCalls += 1;
      stats.inFlight += 1;
      if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight;
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      stats.inFlight -= 1;
      return {
        query: query.query,
        degraded: false,
        options: [
          {
            id: "PROD-1",
            name: `${query.query} Option`,
            price: 50,
            currency: "EUR",
            setting: "indoor",
          },
        ],
      };
    },
  };
  return { provider, stats };
}

/** Timing-driven (no weatherHint) request ⇒ reschedule path ⇒ Viator consult. */
function timingRequest(index: number): ActivityRescheduleRequest {
  return {
    activityNodeId: `activity-${index}`,
    activityName: `City Walking Tour ${index}`,
    originalTime: "2026-09-10T10:00:00Z",
    windowStart: "2026-09-10T11:00:00Z",
    windowEnd: "2026-09-12T10:00:00Z",
    currency: "EUR",
  };
}

describe("ActivityAgent Viator consult fan-out (review fix 2)", () => {
  it("caps consults at the per-mission budget and runs them concurrently (legacy rail)", async () => {
    const { provider, stats } = makeCountingProvider(25);
    const agent = new ActivityAgent(provider);

    // 8 timing-driven slots, but only 6 consults are allowed per mission.
    const requests = Array.from({ length: 8 }, (_, i) => timingRequest(i));
    const proposals = await agent.proposeRescheduling(requests);

    expect(proposals).toHaveLength(8);
    // (a) CAP: exactly the budget is consumed — never more.
    expect(agent.viatorConsultsUsed).toBe(6);
    // Only the first 6 proposals carry a live consult; the excess keep the
    // honest heuristic proposal alone.
    const grounded = proposals.filter((proposal) => proposal.viatorConsult !== undefined);
    expect(grounded).toHaveLength(6);
    // Each consult fans out exactly 3 searches ⇒ 6 × 3 = 18 provider calls,
    // and the 2 over-budget slots issue NONE.
    expect(stats.totalCalls).toBe(18);
    // (b) CONCURRENCY: far more than a single consult's 3 queries overlap —
    // several consults are in flight at once (a sequential loop tops out at 3).
    expect(stats.maxInFlight).toBeGreaterThan(3);
  });

  it("caps and fans out concurrently on the day-reorganization rail too", async () => {
    const { provider, stats } = makeCountingProvider(25);
    const agent = new ActivityAgent(provider);

    const activities: DayActivityInput[] = Array.from({ length: 8 }, (_, i) => ({
      nodeId: `activity-${i}`,
      name: `Museum Visit ${i}`,
      time: "2026-09-10T10:00:00Z",
      durationMinutes: 90,
    }));
    const decisions: DayReorgDecision[] = activities.map((activity, i) => ({
      nodeId: activity.nodeId,
      action: "retime",
      newTime: `2026-09-10T${String(11 + i).padStart(2, "0")}:00:00Z`,
      reason: "resequenced",
    }));

    const proposals = await agent.proposalsFromReorganization(decisions, {
      activities,
      currency: "EUR",
      reorgSource: "deterministic",
    });

    expect(proposals).toHaveLength(8);
    expect(agent.viatorConsultsUsed).toBe(6); // shared per-mission budget
    expect(proposals.filter((p) => p.viatorConsult !== undefined)).toHaveLength(6);
    expect(stats.totalCalls).toBe(18);
    expect(stats.maxInFlight).toBeGreaterThan(3);
  });
});
