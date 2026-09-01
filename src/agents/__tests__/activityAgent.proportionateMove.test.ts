/**
 * A rescheduled activity must move as LITTLE as the conflict requires.
 *
 * REGRESSION — found live on 2026-08-31 against the real rail. `proposeFor`
 * hardcoded "next day, same clock time", ignoring the acceptable window it was
 * handed. A Barcelona flight slipping ~1h therefore pushed "Catedral de
 * Barcelona" from 14:30 to 14:30 THE NEXT DAY — onto a day that already held
 * eight items — while its own afternoon stayed free. Schema-valid, and useless
 * to a traveler.
 *
 * The window is now the single source of truth, which also preserves the
 * DIFFERENT intent each caller encodes in it:
 *   - timing-driven conflicts open the window 1h after the slot  ⇒ same day;
 *   - a rained-off outdoor activity opens it 24h later           ⇒ next day.
 */

import { describe, expect, it } from "vitest";
import { ActivityAgent } from "@/agents/activity/ActivityAgent";
import type { ActivityRescheduleRequest } from "@/agents/activity/ActivityAgent";
import type { ActivityProvider } from "@/providers/interfaces/ActivityProvider";
import type { ActivitySearchResult } from "@/providers/interfaces/types";

/** Provider that finds nothing: keeps every proposal on the heuristic path. */
const silentProvider: ActivityProvider = {
  providerName: "test-silent",
  async searchActivities(): Promise<ActivitySearchResult> {
    return { query: {} as never, options: [], degraded: true };
  },
};

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** The live case: "Catedral de Barcelona", 2026-09-10 14:30Z. */
const ORIGINAL = Date.UTC(2026, 8, 10, 14, 30);

function request(overrides: Partial<ActivityRescheduleRequest> = {}): ActivityRescheduleRequest {
  return {
    activityNodeId: "activity-0-1",
    activityName: "Catedral de Barcelona",
    originalTime: new Date(ORIGINAL).toISOString(),
    // Timing-driven window: anything from 1h later, up to 48h out.
    windowStart: new Date(ORIGINAL + HOUR).toISOString(),
    windowEnd: new Date(ORIGINAL + 48 * HOUR).toISOString(),
    ...overrides,
  };
}

const dayOf = (iso: string) => iso.slice(0, 10);

describe("ActivityAgent — a reschedule is proportionate to the conflict", () => {
  it("a timing conflict retimes WITHIN the same day, not onto the next one", async () => {
    const agent = new ActivityAgent(silentProvider);
    const [proposal] = await agent.proposeRescheduling([request()]);

    expect(proposal.action).toBe("reschedule");
    expect(dayOf(proposal.newTime)).toBe("2026-09-10");
    // The smallest acceptable move: the window's own opening slot.
    expect(proposal.newTime).toBe(new Date(ORIGINAL + HOUR).toISOString());
  });

  it("never lands later than it must — the move equals the window start", async () => {
    const agent = new ActivityAgent(silentProvider);
    // A wider conflict (4h) still moves exactly as far as the window opens.
    const [proposal] = await agent.proposeRescheduling([
      request({ windowStart: new Date(ORIGINAL + 4 * HOUR).toISOString() }),
    ]);
    expect(proposal.newTime).toBe(new Date(ORIGINAL + 4 * HOUR).toISOString());
    expect(dayOf(proposal.newTime)).toBe("2026-09-10");
  });

  it("a weather window that opens a day later STILL moves to the next day", async () => {
    const agent = new ActivityAgent(silentProvider);
    const [proposal] = await agent.proposeRescheduling([
      request({
        // The weather path's own bounds: earliest alternative is tomorrow.
        windowStart: new Date(ORIGINAL + DAY).toISOString(),
        windowEnd: new Date(ORIGINAL + 2 * DAY).toISOString(),
      }),
    ]);
    expect(dayOf(proposal.newTime)).toBe("2026-09-11");
  });

  /**
   * REGRESSION — surfaced by the 49-mission live run AFTER the proportionality
   * fix above. "Smallest acceptable move" is right until the activity sits late
   * in the evening: +1h then lands after midnight, and Tokyo really did come
   * back with an activity at 00:30. A move must stay inside the day.
   */
  it("a late-evening activity rolls to the next morning, never past midnight", async () => {
    const agent = new ActivityAgent(silentProvider);
    const lateNight = Date.UTC(2026, 9, 9, 23, 30); // 23:30 — +1h crosses midnight
    const [proposal] = await agent.proposeRescheduling([
      {
        activityNodeId: "activity-1-5",
        activityName: "Cocktails at Paradiso",
        originalTime: new Date(lateNight).toISOString(),
        windowStart: new Date(lateNight + HOUR).toISOString(),
        windowEnd: new Date(lateNight + 48 * HOUR).toISOString(),
      },
    ]);
    const hour = new Date(proposal.newTime).getUTCHours();
    expect(hour).toBeGreaterThanOrEqual(8);
    expect(hour).toBeLessThan(22);
  });

  it("an early-morning slot is not pushed into the small hours either", async () => {
    const agent = new ActivityAgent(silentProvider);
    const preDawn = Date.UTC(2026, 9, 9, 5, 0);
    const [proposal] = await agent.proposeRescheduling([
      {
        activityNodeId: "activity-1-0",
        activityName: "Sunrise viewpoint",
        originalTime: new Date(preDawn).toISOString(),
        windowStart: new Date(preDawn + HOUR).toISOString(),
        windowEnd: new Date(preDawn + 48 * HOUR).toISOString(),
      },
    ]);
    const hour = new Date(proposal.newTime).getUTCHours();
    expect(hour).toBeGreaterThanOrEqual(8);
    expect(hour).toBeLessThan(22);
  });
});

