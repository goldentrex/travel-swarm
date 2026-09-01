/**
 * Task 21 — Gemini liveness tests: the shared degrade taxonomy, the
 * quota-aware retry (exactly ONE retry on 429/503 after the ~1.5 s backoff,
 * wired only when configured — the assess/sync default stays single-shot),
 * and the per-mission call budget (same instance-counter pattern as
 * ActivityAgent.viatorConsultsUsed). Fetch-mocked exactly like
 * geminiLiaison.test.ts / dayReorganizer.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayReorganizer, type DayReorgRequest } from "@/agents/activity/DayReorganizer";
import { GeminiLiaisonAgent } from "@/agents/liaison/GeminiLiaisonAgent";
import { GEMINI_CALLS_PER_MISSION } from "@/agents/geminiDegrade";

const DATE = "2026-09-02";

/** Two activities on a day that comfortably fits both (never forces a drop). */
function reorgRequest(): DayReorgRequest {
  return {
    date: DATE,
    newArrivalTime: `${DATE}T09:00:00.000Z`,
    activities: [
      { nodeId: "a-surf", name: "Surf Lesson", time: `${DATE}T09:00:00.000Z`, durationMinutes: 60 },
      {
        nodeId: "a-museum",
        name: "Ocean Museum Visit",
        time: `${DATE}T11:00:00.000Z`,
        durationMinutes: 60,
      },
    ],
  };
}

/** Model payload that passes the hard validator (floor = arrival + 60 min). */
const VALID_REORG_TEXT = JSON.stringify({
  decisions: [
    {
      nodeId: "a-surf",
      action: "retime",
      newTime: `${DATE}T10:00:00.000Z`,
      reason: "Resequenced around the delayed arrival.",
    },
    {
      nodeId: "a-museum",
      action: "retime",
      newTime: `${DATE}T13:00:00.000Z`,
      reason: "Resequenced around the delayed arrival.",
    },
  ],
});

/** Model response envelope (same helper as the sibling suites). */
function geminiResponse(modelText: string, status = 200): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: modelText }] } }] }),
    {
      status,
      statusText: status === 200 ? "OK" : "ERR",
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** Free-tier quota rejection (the classify's quota_429 trigger). */
function rateLimited(status = 429): Response {
  return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
    status,
    statusText: "RATE LIMITED",
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.GEMINI_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- DayReorganizer

describe("DayReorganizer — Gemini liveness", () => {
  it("429 → exactly ONE retry after the ~1.5 s backoff → success (2 fetches)", async () => {
    vi.useFakeTimers();
    const callTimes: number[] = [];
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      callTimes.push(Date.now()); // faked clock — measures the backoff
      return callTimes.length === 1 ? rateLimited() : geminiResponse(VALID_REORG_TEXT);
    }) as unknown as typeof fetch;
    const agent = new DayReorganizer({ apiKey: "test-key", fetchImpl, maxRetries: 1 });

    const pending = agent.reorganizeDay(reorgRequest());
    // First attempt already ran and got the 429.
    await vi.advanceTimersByTimeAsync(1_499);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // backoff not elapsed yet
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;

    expect(fetchImpl).toHaveBeenCalledTimes(2); // exactly ONE retry
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(1_500);
    expect(outcome.source).toBe("gemini");
    expect(outcome.degradeReason).toBeUndefined();
    expect(outcome.decisions).toHaveLength(2);
  });

  it("429 + 429 ⇒ degrade quota_429 + deterministic fallback (no throw)", async () => {
    const fetchImpl = vi.fn(async () => rateLimited()) as unknown as typeof fetch;
    const agent = new DayReorganizer({
      apiKey: "test-key",
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 1,
    });
    const outcome = await agent.reorganizeDay(reorgRequest());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(outcome.source).toBe("deterministic");
    expect(outcome.degradeReason).toBe("quota_429");
    expect(agent.lastDegradeReason).toBe("quota_429");
    // The deterministic rail still serves one decision per activity.
    expect(outcome.decisions).toHaveLength(2);
    expect(outcome.decisions.every((d) => d.action === "retime")).toBe(true);
  });

  it("single-shot by default (assess/sync wiring): ONE attempt even on 429", async () => {
    const fetchImpl = vi.fn(async () => rateLimited()) as unknown as typeof fetch;
    const agent = new DayReorganizer({ apiKey: "test-key", fetchImpl }); // no maxRetries
    const outcome = await agent.reorganizeDay(reorgRequest());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.source).toBe("deterministic");
    expect(outcome.degradeReason).toBe("quota_429");
  });

  it("the per-mission budget is a hard ceiling — the call past it is skipped", async () => {
    // Bound to the CONSTANT, not a literal: the budget grew from 3 to 5 to give
    // the model ladder room, and a hardcoded number just moves the drift.
    const fetchImpl = vi.fn(async () => rateLimited()) as unknown as typeof fetch;
    const agent = new DayReorganizer({ apiKey: "test-key", fetchImpl });
    for (let index = 0; index < GEMINI_CALLS_PER_MISSION; index += 1) {
      await agent.reorganizeDay(reorgRequest());
    }
    expect(agent.geminiCallsUsed).toBe(GEMINI_CALLS_PER_MISSION);
    expect(fetchImpl).toHaveBeenCalledTimes(GEMINI_CALLS_PER_MISSION);

    // Budget exhausted: SKIPPED (no further fetch) and classified.
    const outcome = await agent.reorganizeDay(reorgRequest());
    expect(fetchImpl).toHaveBeenCalledTimes(GEMINI_CALLS_PER_MISSION);
    expect(agent.geminiCallsUsed).toBe(GEMINI_CALLS_PER_MISSION);
    expect(outcome.source).toBe("deterministic");
    expect(outcome.degradeReason).toBe("quota_429");
  });

  it("missing key ⇒ degrade missing_key surfaced on the outcome (no fetch)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const agent = new DayReorganizer({ fetchImpl }); // no apiKey, env cleared
    const outcome = await agent.reorganizeDay(reorgRequest());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.source).toBe("deterministic");
    expect(outcome.degradeReason).toBe("missing_key");
    expect(agent.lastDegradeReason).toBe("missing_key");
  });
});

// ----------------------------------------------------------- GeminiLiaisonAgent

describe("GeminiLiaisonAgent — Gemini liveness", () => {
  it("429 → retry → success: exactly 2 fetches and the model constraints win", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      attempt += 1;
      return attempt === 1 ? rateLimited() : geminiResponse(JSON.stringify({ max_price: 40 }));
    }) as unknown as typeof fetch;
    const agent = new GeminiLiaisonAgent({
      apiKey: "test-key",
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 1,
    });
    const constraints = await agent.translateAnswersToConstraints([], []);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(constraints.max_price).toBe(40); // model output, not the fallback
    expect(agent.lastDegradeReason).toBeUndefined();
  });

  it("429 + 429 ⇒ deterministic constraints + quota_429 reason (no throw)", async () => {
    const fetchImpl = vi.fn(async () => rateLimited()) as unknown as typeof fetch;
    const agent = new GeminiLiaisonAgent({
      apiKey: "test-key",
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 1,
    });
    const constraints = await agent.translateAnswersToConstraints([], []);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(constraints).toEqual({}); // deterministic derivation of no answers
    expect(agent.lastDegradeReason).toBe("quota_429");
  });

  it("single-shot by default (assess wiring): ONE attempt even on 429", async () => {
    const fetchImpl = vi.fn(async () => rateLimited()) as unknown as typeof fetch;
    const agent = new GeminiLiaisonAgent({ apiKey: "test-key", fetchImpl }); // no maxRetries
    const constraints = await agent.translateAnswersToConstraints([], []);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(constraints).toEqual({});
    expect(agent.lastDegradeReason).toBe("quota_429");
  });

  it("the per-mission budget is a hard ceiling — the translate past it is skipped", async () => {
    const fetchImpl = vi.fn(async () => rateLimited()) as unknown as typeof fetch;
    const agent = new GeminiLiaisonAgent({ apiKey: "test-key", fetchImpl });
    for (let index = 0; index < GEMINI_CALLS_PER_MISSION; index += 1) {
      await agent.translateAnswersToConstraints([], []);
    }
    expect(agent.geminiCallsUsed).toBe(GEMINI_CALLS_PER_MISSION);

    const constraints = await agent.translateAnswersToConstraints([], []);
    expect(fetchImpl).toHaveBeenCalledTimes(GEMINI_CALLS_PER_MISSION); // skipped
    expect(agent.geminiCallsUsed).toBe(GEMINI_CALLS_PER_MISSION);
    expect(constraints).toEqual({});
  });

  it("missing key ⇒ deterministic constraints + missing_key reason (no fetch)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const agent = new GeminiLiaisonAgent({ fetchImpl }); // no apiKey, env cleared
    const constraints = await agent.translateAnswersToConstraints([], []);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(constraints).toEqual({});
    expect(agent.lastDegradeReason).toBe("missing_key");
  });
});
