import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayReorganizer, type DayReorgRequest } from "@/agents/activity/DayReorganizer";
import { GeminiLiaisonAgent } from "@/agents/liaison/GeminiLiaisonAgent";
import { GEMINI_MODEL_CASCADE, modelLadder, resetModelCooldowns } from "@/agents/geminiCascade";
import { GeminiCallBudget, readGeminiUsage, type GeminiUsageEvent } from "@/agents/geminiUsage";

const request: DayReorgRequest = {
  date: "2026-10-01",
  newArrivalTime: "2026-10-01T09:00:00.000Z",
  activities: [
    { nodeId: "museum", name: "Museum", time: "2026-10-01T10:00:00.000Z", durationMinutes: 60 },
  ],
};
const modelText = JSON.stringify({
  decisions: [
    {
      nodeId: "museum",
      action: "retime",
      newTime: "2026-10-01T10:00:00.000Z",
      reason: "Fits after arrival",
    },
  ],
});
function response(usageMetadata?: unknown) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: modelText }] } }], usageMetadata }),
  );
}

beforeEach(() => {
  resetModelCooldowns();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("SWARM_GEMINI_LIAISON_MODEL", "");
  vi.stubEnv("SWARM_GEMINI_DAY_REORG_MODEL", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("measured Gemini usage", () => {
  it("accepts only nonnegative integer provider token counts", () => {
    expect(
      readGeminiUsage({
        promptTokenCount: 120,
        thoughtsTokenCount: 15,
        totalTokenCount: 180,
        candidatesTokenCount: -1,
        cachedContentTokenCount: "10",
        secret: "never log me",
      }),
    ).toEqual({ promptTokenCount: 120, thoughtsTokenCount: 15, totalTokenCount: 180 });
    for (const value of [null, {}, { totalTokenCount: Infinity }, { totalTokenCount: 1.5 }]) {
      expect(readGeminiUsage(value)).toBeNull();
    }
  });

  it("records each failed/successful attempt and never invents usage for a refusal", async () => {
    const events: GeminiUsageEvent[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("quota", { status: 429 }))
      .mockResolvedValueOnce(
        response({ promptTokenCount: 80, candidatesTokenCount: 20, totalTokenCount: 100 }),
      );
    const agent = new DayReorganizer({
      apiKey: "private-key",
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 0,
      onUsage: (event) => events.push(event),
    });
    const result = await agent.reorganizeDay(request);
    expect(result.source).toBe("gemini");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      model: GEMINI_MODEL_CASCADE[0],
      outcome: "quota_429",
      usage: null,
    });
    expect(events[1]).toMatchObject({
      model: GEMINI_MODEL_CASCADE[1],
      outcome: "text_received",
      usage: { totalTokenCount: 100 },
      maxOutputTokens: 2400,
    });
    expect(JSON.stringify(events)).not.toContain("private-key");
    expect(JSON.stringify(events)).not.toContain("Museum");
  });

  it("a broken telemetry observer cannot trigger a fallback or retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const agent = new DayReorganizer({
      apiKey: "test",
      fetchImpl,
      maxRetries: 1,
      onUsage: () => {
        throw new Error("observer unavailable");
      },
    });
    expect((await agent.reorganizeDay(request)).source).toBe("gemini");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("liaison routing can use a lighter model and reports its actual usage", async () => {
    vi.stubEnv("SWARM_GEMINI_LIAISON_MODEL", GEMINI_MODEL_CASCADE[1]);
    const events: GeminiUsageEvent[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"priority":"minimize_cost"}' }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
        }),
      ),
    );
    const agent = new GeminiLiaisonAgent({
      apiKey: "test",
      fetchImpl,
      onUsage: (event) => events.push(event),
    });
    await agent.translateAnswersToConstraints([], []);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(GEMINI_MODEL_CASCADE[1]);
    expect(events[0]).toMatchObject({
      model: GEMINI_MODEL_CASCADE[1],
      usage: { totalTokenCount: 25 },
    });
  });

  it("an explicit caller model wins over environment routing", async () => {
    vi.stubEnv("SWARM_GEMINI_DAY_REORG_MODEL", "environment-model");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const agent = new DayReorganizer({ apiKey: "test", fetchImpl, model: "caller-model" });
    await agent.reorganizeDay(request);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/caller-model:");
  });
});

describe("bounded model calls under concurrency", () => {
  it("a spent local allowance does not mark a healthy provider as rate-limited", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const agent = new DayReorganizer({
      apiKey: "test",
      fetchImpl,
      maxRetries: 2,
      sharedBudget: new GeminiCallBudget(0),
    });
    expect((await agent.reorganizeDay(request)).source).toBe("deterministic");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(modelLadder()).toEqual([...GEMINI_MODEL_CASCADE]);
  });

  it("parallel retries cannot spend the same final per-agent slot", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("quota", { status: 429 }));
    const agent = new DayReorganizer({
      apiKey: "test",
      fetchImpl,
      maxRetries: 1,
      callBudget: 3,
      retryDelayMs: 100,
    });
    const results = Promise.all([agent.reorganizeDay(request), agent.reorganizeDay(request)]);
    await vi.runAllTimersAsync();
    expect((await results).every((r) => r.source === "deterministic")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(agent.geminiCallsUsed).toBe(3);
  });

  it("liaison and parallel day agents share one resolve allowance", async () => {
    const sharedBudget = new GeminiCallBudget(2);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("quota", { status: 429 }));
    const liaison = new GeminiLiaisonAgent({ apiKey: "test", fetchImpl, sharedBudget });
    const day = new DayReorganizer({ apiKey: "test", fetchImpl, sharedBudget });
    await liaison.translateAnswersToConstraints([], []);
    await Promise.all([
      day.reorganizeDay(request),
      day.reorganizeDay(request),
      day.reorganizeDay(request),
    ]);
    expect(sharedBudget.callsUsed).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("opt-in deterministic constraint routing", () => {
  it("uses zero model requests for exact structured choices", async () => {
    const fetchImpl = vi.fn();
    const agent = new GeminiLiaisonAgent({
      apiKey: "test",
      constraintRouting: "deterministic_known",
      fetchImpl,
    });
    const constraints = await agent.translateAnswersToConstraints(
      [
        {
          id: "stops",
          question: "Stops?",
          options: [
            { id: "nonstop", label: "Direct" },
            { id: "with_stop", label: "Connection" },
          ],
        },
        {
          id: "day",
          question: "Day?",
          options: [
            { id: "same_day", label: "Today" },
            { id: "later_day", label: "Later" },
          ],
        },
      ],
      [
        { question_id: "stops", option_id: "nonstop" },
        { question_id: "day", option_id: "same_day" },
      ],
    );
    expect(constraints).toMatchObject({
      prefer_nonstop: true,
      prefer_direct: true,
      prefer_same_day: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(agent.geminiCallsUsed).toBe(0);
    expect(agent.lastConstraintRoute).toBe("deterministic");
    expect(agent.lastDegradeReason).toBeUndefined();
  });
  /**
   * The question set a real missed-flight assess actually asks.
   *
   * Captured live 2026-09-20 from the QA Japan itinerary: the swarm asks TWO
   * questions, the airport buffer FIRST and the travel day second. The older
   * test above used a stops/day pair the product never emits, so it passed
   * while the allowlist was missing both airport ids — and because the gate is
   * all-or-nothing, that one unlisted id sent every real mission to the model.
   * The routing flag was switched on in production and changed nothing.
   *
   * This test is written from the captured payload for that reason: it fails
   * if the allowlist and the shipped questions ever drift apart again.
   */
  it("takes the local route for the questions a real missed-flight mission asks", async () => {
    const fetchImpl = vi.fn();
    const agent = new GeminiLiaisonAgent({
      apiKey: "test",
      constraintRouting: "deterministic_known",
      fetchImpl,
    });
    const constraints = await agent.translateAnswersToConstraints(
      [
        {
          id: "airport-arrival",
          question: "How soon can you be at the airport?",
          options: [
            { id: "airport_now", label: "I'm already here" },
            { id: "need_time", label: "I need time (3h+)" },
          ],
        },
        {
          id: "flight-day",
          question: "Travel the same day, or save on a later day?",
          options: [
            { id: "same_day", label: "Same day" },
            { id: "cheaper_later", label: "Cheaper later" },
          ],
        },
      ],
      [
        { question_id: "airport-arrival", option_id: "need_time" },
        { question_id: "flight-day", option_id: "same_day" },
      ],
    );

    // The buffer the question's own detail text promised — "at least 3 hours".
    expect(constraints).toMatchObject({
      min_departure_delay_hours: 3,
      prefer_same_day: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(agent.lastConstraintRoute).toBe("deterministic");
  });

  it("keeps the whole payload on the model when one answer is unfamiliar", async () => {
    // All-or-nothing on purpose: a mission that mixes a known routing answer
    // with an activity arbitration must not have half its preferences read by
    // a table that does not understand the other half.
    const fetchImpl = vi.fn(async () =>
      Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }),
    );
    const agent = new GeminiLiaisonAgent({
      apiKey: "test",
      constraintRouting: "deterministic_known",
      fetchImpl,
    });
    await agent.translateAnswersToConstraints(
      [
        {
          id: "airport-arrival",
          question: "How soon can you be at the airport?",
          options: [{ id: "airport_now", label: "Already here" }],
        },
        {
          id: "activities",
          question: "Which one matters more?",
          options: [{ id: "keep_anne_frank_house", label: "Anne Frank House" }],
        },
      ],
      [
        { question_id: "airport-arrival", option_id: "airport_now" },
        { question_id: "activities", option_id: "keep_anne_frank_house" },
      ],
    );
    expect(agent.lastConstraintRoute).toBe("model");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not ask a model to infer preferences when no answers were given", async () => {
    const fetchImpl = vi.fn();
    const agent = new GeminiLiaisonAgent({
      apiKey: "test",
      constraintRouting: "deterministic_known",
      fetchImpl,
    });
    expect(await agent.translateAnswersToConstraints([], [])).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("retains model routing for unfamiliar choice ids", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }),
    );
    const agent = new GeminiLiaisonAgent({
      apiKey: "test",
      constraintRouting: "deterministic_known",
      fetchImpl,
    });
    await agent.translateAnswersToConstraints(
      [
        {
          id: "custom",
          question: "Preference?",
          options: [{ id: "custom_rule", label: "Custom" }],
        },
      ],
      [{ question_id: "custom", option_id: "custom_rule" }],
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(agent.lastConstraintRoute).toBe("model");
  });
});

describe("the shared budget is also the mission's clock", () => {
  // Cloudflare cancels a `ctx.waitUntil` continuation 30 s after the ack,
  // silently. Measured 2026-09-18: three missions in five batteries had
  // their last trace row 18–26 s after the ack and never reached the final
  // save. Every model stage has a deterministic rail behind it, so a call
  // that cannot finish before the cut-off is not started.
  it("refuses a call whose own deadline would run past the cut-off", () => {
    const budget = new GeminiCallBudget(5, 0, Date.now() + 8_000);
    expect(budget.tryReserve(false, 10_000)).toBe(false);
    expect(budget.lastRefusal).toBe("deadline");
    expect(budget.deadlineRefusals).toBe(1);
    // No slot was spent on the refusal.
    expect(budget.callsUsed).toBe(0);
  });

  it("lets a call through while it can still finish, and counts it", () => {
    const budget = new GeminiCallBudget(5, 0, Date.now() + 20_000);
    expect(budget.tryReserve(false, 10_000)).toBe(true);
    expect(budget.lastRefusal).toBeNull();
    expect(budget.callsUsed).toBe(1);
    expect(budget.msLeft).toBeGreaterThan(15_000);
  });

  it("without a deadline the clock never refuses anything", () => {
    const budget = new GeminiCallBudget(1, 0);
    expect(budget.msLeft).toBe(Number.POSITIVE_INFINITY);
    expect(budget.tryReserve(false, 999_999)).toBe(true);
    expect(budget.tryReserve(false, 0)).toBe(false);
    expect(budget.lastRefusal).toBe("calls");
    expect(budget.deadlineRefusals).toBe(0);
  });

  it("a caller past the cut-off degrades as `timeout`, never as a quota problem", async () => {
    // The taxonomy stays frozen at six values; "there was no time for this
    // call" is what `timeout` means, and mislabelling it `quota_429` would
    // sideline a healthy model with a cooldown it did not earn.
    const fetchSpy = vi.fn();
    const budget = new GeminiCallBudget(5, 0, Date.now() + 1_000);
    const reorganizer = new DayReorganizer({
      apiKey: "test",
      fetchImpl: fetchSpy as unknown as typeof fetch,
      sharedBudget: budget,
    });
    await reorganizer.reorganizeDay(request);
    // Never reached the network, and the reason says why in the taxonomy's
    // own words.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reorganizer.lastDegradeReason).toBe("timeout");
    expect(budget.deadlineRefusals).toBe(1);
    expect(budget.callsUsed).toBe(0);
  });
});
