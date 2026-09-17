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
