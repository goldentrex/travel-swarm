/**
 * W2 — DayReorganizer tests: deterministic greedy rail (ordering, day bounds,
 * arrival floor, drop-only-when-infeasible), the hard validator's rejection
 * rules, and the Gemini agent's success / invalid-output / degradation paths
 * (fetch-mocked exactly like geminiLiaison.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUFFER_MINUTES,
  ARRIVAL_TRANSIT_MARGIN_MINUTES,
  DayReorganizer,
  priorityOrder,
  resequenceDeterministically,
  validateReorgDecisions,
  type DayActivityInput,
  type DayReorgRequest,
} from "@/agents/activity/DayReorganizer";

const DATE = "2026-09-02";
const MINUTE_MS = 60_000;

function activity(
  nodeId: string,
  name: string,
  time: string,
  durationMinutes = 90,
  coords?: { lat: number; lng: number },
): DayActivityInput {
  return { nodeId, name, time, durationMinutes, ...(coords ? { coords } : {}) };
}

/** Two activities on a day that comfortably fits both (no drop ever honest). */
function feasibleRequest(): DayReorgRequest {
  return {
    date: DATE,
    newArrivalTime: `${DATE}T09:00:00.000Z`,
    activities: [
      activity("a-surf", "Surf Lesson", `${DATE}T09:00:00.000Z`, 60),
      activity("a-museum", "Ocean Museum Visit", `${DATE}T11:00:00.000Z`, 60),
    ],
  };
}

/** Arrival so late the day provably cannot hold both 90-minute activities. */
function infeasibleRequest(): DayReorgRequest {
  return {
    date: DATE,
    newArrivalTime: `${DATE}T18:00:00.000Z`,
    activities: [
      activity("a-surf", "Surf Lesson", `${DATE}T10:00:00.000Z`, 90),
      activity("a-museum", "Ocean Museum Visit", `${DATE}T14:00:00.000Z`, 90),
    ],
  };
}

/** Model response envelope mirroring geminiLiaison.test.ts. */
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

function reorganizerWith(fetchImpl: typeof fetch): DayReorganizer {
  return new DayReorganizer({ apiKey: "test-key", fetchImpl });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ------------------------------------------------------- deterministic rail

describe("resequenceDeterministically (greedy fallback)", () => {
  it("packs in chronological priority order from arrival + transit margin", () => {
    const request = feasibleRequest();
    const decisions = resequenceDeterministically(request);
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.action === "retime")).toBe(true);

    const floor = Date.parse(`${DATE}T09:00:00.000Z`) + ARRIVAL_TRANSIT_MARGIN_MINUTES * MINUTE_MS;
    const surf = decisions.find((d) => d.nodeId === "a-surf")!;
    const museum = decisions.find((d) => d.nodeId === "a-museum")!;
    expect(Date.parse(surf.newTime!)).toBe(floor);
    // Second slot = first start + duration + the 120-minute buffer convention.
    expect(Date.parse(museum.newTime!)).toBe(floor + 60 * MINUTE_MS + BUFFER_MINUTES * MINUTE_MS);
  });

  it("honors the traveler's priority activity (protected one goes first)", () => {
    const request = { ...feasibleRequest(), priorityName: "museum" };
    const decisions = resequenceDeterministically(request);
    const floor = Date.parse(`${DATE}T09:00:00.000Z`) + ARRIVAL_TRANSIT_MARGIN_MINUTES * MINUTE_MS;
    const museum = decisions.find((d) => d.nodeId === "a-museum")!;
    expect(Date.parse(museum.newTime!)).toBe(floor);
    expect(museum.reason).toContain("protect");
  });

  it("keeps every slot within the 08:00–22:00 day bounds", () => {
    const decisions = resequenceDeterministically(feasibleRequest());
    const boundsStart = Date.parse(`${DATE}T08:00:00.000Z`);
    const boundsEnd = Date.parse(`${DATE}T22:00:00.000Z`);
    for (const decision of decisions) {
      const start = Date.parse(decision.newTime!);
      const activity = feasibleRequest().activities.find((a) => a.nodeId === decision.nodeId)!;
      expect(start).toBeGreaterThanOrEqual(boundsStart);
      expect(start + activity.durationMinutes * MINUTE_MS).toBeLessThanOrEqual(boundsEnd);
    }
  });

  it("drops ONLY the lowest-priority activity when the day is infeasible", () => {
    const request = infeasibleRequest();
    const decisions = resequenceDeterministically(request);
    expect(decisions).toHaveLength(2);
    const surf = decisions.find((d) => d.nodeId === "a-surf")!;
    const museum = decisions.find((d) => d.nodeId === "a-museum")!;
    // Chronological priority ⇒ the later museum visit is the tail (dropped).
    expect(surf.action).toBe("retime");
    expect(museum.action).toBe("drop");
    expect(museum.newTime).toBeUndefined();
    expect(museum.reason).toContain("lowest-priority");
    // The kept activity starts exactly at arrival + margin.
    const floor = Date.parse(`${DATE}T18:00:00.000Z`) + ARRIVAL_TRANSIT_MARGIN_MINUTES * MINUTE_MS;
    expect(Date.parse(surf.newTime!)).toBe(floor);
  });

  it("drops nothing when the day fits — dropping is proven infeasibility only", () => {
    const decisions = resequenceDeterministically(feasibleRequest());
    expect(decisions.some((d) => d.action === "drop")).toBe(false);
  });

  it("emits decisions in the ORIGINAL input order", () => {
    const request = { ...feasibleRequest(), priorityName: "museum" };
    const decisions = resequenceDeterministically(request);
    expect(decisions.map((d) => d.nodeId)).toEqual(["a-surf", "a-museum"]);
  });

  it("keeps booked slots when the date is unreadable", () => {
    const request: DayReorgRequest = { date: "garbage", activities: feasibleRequest().activities };
    const decisions = resequenceDeterministically(request);
    expect(decisions.every((d) => d.action === "retime")).toBe(true);
    expect(decisions.map((d) => d.newTime)).toEqual(request.activities.map((a) => a.time));
  });
});

describe("priorityOrder", () => {
  it("puts the named activity first, then chronological, nodeId tiebreak", () => {
    const acts = [
      activity("b", "City Walk", `${DATE}T09:00:00.000Z`),
      activity("a", "Surf Lesson", `${DATE}T09:00:00.000Z`),
      activity("c", "Ocean Museum Visit", `${DATE}T08:30:00.000Z`),
    ];
    const ordered = priorityOrder(acts, "museum").map((a) => a.nodeId);
    expect(ordered).toEqual(["c", "a", "b"]);
  });
});

// ------------------------------------------------------------- hard validator

describe("validateReorgDecisions", () => {
  const request = feasibleRequest();
  const floor = `${DATE}T10:00:00.000Z`;
  const validPayload = [
    { nodeId: "a-surf", action: "retime", newTime: floor, reason: "moved" },
    { nodeId: "a-museum", action: "retime", newTime: `${DATE}T13:00:00.000Z`, reason: "moved" },
  ];

  it("accepts a well-formed, feasible schedule", () => {
    const validated = validateReorgDecisions(validPayload, request);
    expect(validated).not.toBeNull();
    expect(validated!.map((d) => d.nodeId).sort()).toEqual(["a-museum", "a-surf"]);
  });

  it("rejects overlapping slots", () => {
    const overlapping = [
      { nodeId: "a-surf", action: "retime", newTime: floor, reason: "x" },
      { nodeId: "a-museum", action: "retime", newTime: `${DATE}T10:30:00.000Z`, reason: "x" },
    ];
    expect(validateReorgDecisions(overlapping, request)).toBeNull();
  });

  it("rejects slots outside the day bounds", () => {
    const tooLate = [
      { nodeId: "a-surf", action: "retime", newTime: `${DATE}T21:30:00.000Z`, reason: "x" },
      { nodeId: "a-museum", action: "retime", newTime: floor, reason: "x" },
    ];
    expect(validateReorgDecisions(tooLate, request)).toBeNull();
  });

  it("rejects a start before arrival + transit margin", () => {
    const tooEarly = [
      { nodeId: "a-surf", action: "retime", newTime: `${DATE}T09:30:00.000Z`, reason: "x" },
      { nodeId: "a-museum", action: "retime", newTime: `${DATE}T13:00:00.000Z`, reason: "x" },
    ];
    expect(validateReorgDecisions(tooEarly, request)).toBeNull();
  });

  it("rejects incomplete coverage and unknown/duplicate nodeIds", () => {
    expect(validateReorgDecisions([validPayload[0]], request)).toBeNull();
    expect(
      validateReorgDecisions(
        [...validPayload, { nodeId: "a-ghost", action: "drop", reason: "x" }],
        request,
      ),
    ).toBeNull();
    expect(validateReorgDecisions([...validPayload, validPayload[0]], request)).toBeNull();
  });

  it("rejects invalid actions and unparseable times", () => {
    expect(
      validateReorgDecisions(
        [
          { nodeId: "a-surf", action: "delete", newTime: floor, reason: "x" },
          { nodeId: "a-museum", action: "retime", newTime: `${DATE}T13:00:00.000Z`, reason: "x" },
        ],
        request,
      ),
    ).toBeNull();
    expect(
      validateReorgDecisions(
        [
          { nodeId: "a-surf", action: "retime", newTime: "whenever", reason: "x" },
          { nodeId: "a-museum", action: "retime", newTime: `${DATE}T13:00:00.000Z`, reason: "x" },
        ],
        request,
      ),
    ).toBeNull();
  });

  it("rejects travel-implausible sequences when coordinates are known", () => {
    const coordinated: DayReorgRequest = {
      date: DATE,
      newArrivalTime: `${DATE}T09:00:00.000Z`,
      activities: [
        // ~36 km apart ⇒ ~70 min transit required between the two slots.
        activity("a-north", "North Beach", `${DATE}T09:00:00.000Z`, 60, { lat: 35.0, lng: 139.0 }),
        activity("a-south", "South Pier", `${DATE}T11:00:00.000Z`, 60, { lat: 35.3, lng: 139.2 }),
      ],
    };
    const tight = [
      { nodeId: "a-north", action: "retime", newTime: floor, reason: "x" },
      // Ends 11:00; next start 11:05 leaves only 5 min of transit.
      { nodeId: "a-south", action: "retime", newTime: `${DATE}T11:05:00.000Z`, reason: "x" },
    ];
    expect(validateReorgDecisions(tight, coordinated)).toBeNull();
  });

  it("rejects a GRATUITOUS drop (day is feasible with everything kept)", () => {
    const lazyDrop = [
      { nodeId: "a-surf", action: "retime", newTime: floor, reason: "x" },
      { nodeId: "a-museum", action: "drop", reason: "not feeling it" },
    ];
    expect(validateReorgDecisions(lazyDrop, request)).toBeNull();
  });

  it("accepts a drop only when infeasibility is proven", () => {
    const hard = infeasibleRequest();
    const honestDrop = [
      { nodeId: "a-surf", action: "retime", newTime: `${DATE}T19:00:00.000Z`, reason: "x" },
      { nodeId: "a-museum", action: "drop", reason: "day too short" },
    ];
    expect(validateReorgDecisions(honestDrop, hard)).not.toBeNull();
  });

  it("Task 25 (#10): rejects a drop of a DIFFERENT activity than the rail drops", () => {
    // Infeasible day: the deterministic rail keeps a-surf and drops the
    // lowest-priority tail (a-museum). The model payload is otherwise fully
    // valid (coverage, bounds, floor) but drops the HIGH-priority surf
    // lesson instead — the dropped-set identity check rejects it (falls to
    // the deterministic resequence).
    const hard = infeasibleRequest();
    const dishonestDrop = [
      { nodeId: "a-surf", action: "drop", reason: "museums are better" },
      { nodeId: "a-museum", action: "retime", newTime: `${DATE}T19:00:00.000Z`, reason: "x" },
    ];
    expect(validateReorgDecisions(dishonestDrop, hard)).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(validateReorgDecisions("nonsense", request)).toBeNull();
    expect(validateReorgDecisions(null, request)).toBeNull();
    expect(validateReorgDecisions([{ nodeId: 42 }], request)).toBeNull();
  });
});

// ------------------------------------------------------------------ the agent

describe("DayReorganizer.reorganizeDay", () => {
  it("returns empty decisions for an empty day (no Gemini call)", async () => {
    const fetchImpl = vi.fn();
    const agent = reorganizerWith(fetchImpl as unknown as typeof fetch);
    const outcome = await agent.reorganizeDay({ date: DATE, activities: [] });
    expect(outcome).toEqual({ decisions: [], source: "deterministic" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("degrades to the deterministic rail when no API key is available", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const fetchImpl = vi.fn();
    const agent = new DayReorganizer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await agent.reorganizeDay(feasibleRequest());
    expect(outcome.source).toBe("deterministic");
    expect(outcome.decisions).toHaveLength(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a VALID model schedule (source: gemini)", async () => {
    const modelText = JSON.stringify({
      decisions: [
        {
          nodeId: "a-surf",
          action: "retime",
          newTime: `${DATE}T10:00:00.000Z`,
          reason: "after landing",
        },
        {
          nodeId: "a-museum",
          action: "retime",
          newTime: `${DATE}T13:30:00.000Z`,
          reason: "after lunch",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse(modelText));
    const outcome = await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(
      feasibleRequest(),
    );
    expect(outcome.source).toBe("gemini");
    expect(outcome.decisions).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to deterministic when the model output is INVALID", async () => {
    // Overlapping slots fail the validator.
    const modelText = JSON.stringify({
      decisions: [
        { nodeId: "a-surf", action: "retime", newTime: `${DATE}T10:00:00.000Z`, reason: "x" },
        { nodeId: "a-museum", action: "retime", newTime: `${DATE}T10:10:00.000Z`, reason: "x" },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse(modelText));
    const outcome = await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(
      feasibleRequest(),
    );
    expect(outcome.source).toBe("deterministic");
    expect(outcome.decisions.every((d) => d.action === "retime")).toBe(true);
  });

  it("never lets a gratuitous model drop delete an activity", async () => {
    // The guarantee: an activity the day does not force out is NEVER deleted,
    // whatever the model says. How that is honoured changed — the schedule used
    // to be discarded wholesale for it, and the activity is now reinstated
    // in place (see "repairing an unjustified drop" below) — but the property
    // asserted here is the one that matters to the traveler, so it is checked
    // without caring which mechanism delivered it.
    const modelText = JSON.stringify({
      decisions: [
        { nodeId: "a-surf", action: "retime", newTime: `${DATE}T10:00:00.000Z`, reason: "x" },
        { nodeId: "a-museum", action: "drop", reason: "skip it" },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse(modelText));
    const outcome = await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(
      feasibleRequest(),
    );
    expect(outcome.decisions.some((d) => d.action === "drop")).toBe(false);
    // Both activities still have a decision — nothing vanished.
    expect(outcome.decisions.map((d) => d.nodeId).sort()).toEqual(["a-museum", "a-surf"]);
  });

  it("falls back on HTTP errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse("boom", 500));
    const outcome = await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(
      feasibleRequest(),
    );
    expect(outcome.source).toBe("deterministic");
  });

  it("falls back when fetch throws (network failure)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const outcome = await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(
      feasibleRequest(),
    );
    expect(outcome.source).toBe("deterministic");
    expect(outcome.decisions).toHaveLength(2);
  });

  it("falls back on unparseable model text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse("sorry, I cannot help"));
    const outcome = await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(
      feasibleRequest(),
    );
    expect(outcome.source).toBe("deterministic");
  });

  it("strips code fences around the model JSON", async () => {
    const inner = JSON.stringify({
      decisions: [
        { nodeId: "a-surf", action: "retime", newTime: `${DATE}T10:00:00.000Z`, reason: "x" },
        { nodeId: "a-museum", action: "retime", newTime: `${DATE}T13:00:00.000Z`, reason: "x" },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse(`\`\`\`json\n${inner}\n\`\`\``));
    const outcome = await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(
      feasibleRequest(),
    );
    expect(outcome.source).toBe("gemini");
  });

  it("F5: instructs the model to mention the protected activity in its reasons", async () => {
    // Task 20: when the traveler protected an activity, the Gemini system
    // instruction must demand that the protected activity's reason says so.
    const modelText = JSON.stringify({
      decisions: [
        { nodeId: "a-surf", action: "retime", newTime: `${DATE}T10:00:00.000Z`, reason: "x" },
        {
          nodeId: "a-museum",
          action: "retime",
          newTime: `${DATE}T13:30:00.000Z`,
          reason: "keeping Ocean Museum Visit, as you asked",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse(modelText));
    const outcome = await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay({
      ...feasibleRequest(),
      priorityName: "museum",
    });
    expect(outcome.source).toBe("gemini");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    const systemText = body.systemInstruction.parts[0].text;
    expect(systemText).toContain('protect "museum"');
    expect(systemText).toContain("reason");
    // The user prompt still carries the priority name as structured input.
    const userPayload = JSON.parse(body.contents[0].parts[0].text) as {
      priority_activity: string | null;
    };
    expect(userPayload.priority_activity).toBe("museum");
  });

  it("omits the protected-activity instruction when no priority is stated", async () => {
    const modelText = JSON.stringify({
      decisions: [
        { nodeId: "a-surf", action: "retime", newTime: `${DATE}T10:00:00.000Z`, reason: "x" },
        { nodeId: "a-museum", action: "retime", newTime: `${DATE}T13:30:00.000Z`, reason: "x" },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue(geminiResponse(modelText));
    await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(feasibleRequest());
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as {
      systemInstruction: { parts: Array<{ text: string }> };
    };
    expect(body.systemInstruction.parts[0].text).not.toContain("The traveler asked to protect");
  });
});

// ------------------------------------- "lighten my day" — drops are the answer

/**
 * REGRESSION — found live on 2026-09-01. The drop guard is right in general: a
 * model must not quietly delete an activity to make its own scheduling easier,
 * so a drop is only accepted when the day PROVABLY cannot hold everything.
 *
 * But "I'm feeling unwell, lighten my day" and "my activity got cancelled" are
 * requests to remove something. There the guard rejected the model's correct
 * answer — every single time, the only rejection reason the live run produced —
 * and handed back a deterministic schedule that kept every activity: the exact
 * opposite of what the traveler asked for.
 */
describe("repairing an unjustified drop instead of discarding the schedule", () => {
  // Observed live on 2026-09-01, once in 55 missions after the drop ruling
  // removed the rest: the model was told plainly that the day fits and still
  // dropped an activity. The whole schedule was thrown away for it — losing
  // the reordering, the timing and the reasons, all of which may have been
  // good — and the traveler got the deterministic rail instead.
  //
  // The repair reinstates the dropped activity with the rail's own decision
  // and re-runs the SAME validator, so nothing is waived.

  async function reorganizeWithModelText(modelText: string, request: DayReorgRequest) {
    const fetchImpl = vi.fn(async () => geminiResponse(modelText));
    return reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(request);
  }

  it("keeps the model's schedule and puts the dropped activity back", async () => {
    const request = feasibleRequest();
    const outcome = await reorganizeWithModelText(
      JSON.stringify({
        decisions: [
          {
            nodeId: "a-surf",
            action: "retime",
            newTime: `${DATE}T13:00:00.000Z`,
            reason: "moved to the afternoon for better swell",
          },
          // Nothing forced this out — the day fits both comfortably.
          { nodeId: "a-museum", action: "drop", reason: "seemed like a lot for one day" },
        ],
      }),
      request,
    );

    expect(outcome.source).toBe("gemini"); // the model's work survived
    expect(outcome.degradeReason).toBeUndefined();
    // Its own decision is untouched…
    const surf = outcome.decisions.find((d) => d.nodeId === "a-surf");
    expect(surf?.action).toBe("retime");
    expect(surf?.reason).toBe("moved to the afternoon for better swell");
    // …and the activity it tried to delete is back, not dropped.
    const museum = outcome.decisions.find((d) => d.nodeId === "a-museum");
    expect(museum?.action).toBe("retime");
    expect(outcome.decisions.filter((d) => d.action === "drop")).toHaveLength(0);
  });

  it("still discards a schedule that is ALSO broken in some other way", async () => {
    // The repair must never become a way to launder a bad schedule: the same
    // validator runs on the repaired decisions, and this one overlaps.
    const request = feasibleRequest();
    const outcome = await reorganizeWithModelText(
      JSON.stringify({
        decisions: [
          { nodeId: "a-surf", action: "retime", newTime: `${DATE}T23:59:00.000Z`, reason: "late" },
          { nodeId: "a-museum", action: "drop", reason: "no room" },
        ],
      }),
      request,
    );
    expect(outcome.source).toBe("deterministic");
    expect(outcome.degradeReason).toBe("invalid_output");
  });

  it("leaves a JUSTIFIED drop alone — a day that truly cannot fit still drops", async () => {
    const request = infeasibleRequest();
    const railDrops = resequenceDeterministically(request)
      .filter((d) => d.action === "drop")
      .map((d) => d.nodeId);
    expect(railDrops.length).toBeGreaterThan(0);

    const outcome = await reorganizeWithModelText(
      JSON.stringify({ decisions: resequenceDeterministically(request) }),
      request,
    );
    // The rail's own answer is by definition valid; the drop it forces stands.
    expect(outcome.decisions.filter((d) => d.action === "drop").map((d) => d.nodeId))
      .toEqual(railDrops);
  });
});

describe("the drop ruling handed to the model", () => {
  /** The user payload the agent actually sent Gemini. */
  async function sentPayload(request: DayReorgRequest): Promise<Record<string, unknown>> {
    const fetchImpl = vi.fn(async () => geminiResponse("{}"));
    await reorganizerWith(fetchImpl as unknown as typeof fetch).reorganizeDay(request);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    return JSON.parse(body.contents[0].parts[0].text) as Record<string, unknown>;
  }

  // The model was asked to prove infeasibility itself ("NEVER drop unless the
  // day is mathematically infeasible"), i.e. to reproduce the deterministic
  // rail's interval packing and match it exactly. On the live matrix of
  // 2026-09-01 it failed that five times in fourteen missions, each rejected
  // as "dropped [X] but the day only forces []" — it trimmed days that fit.
  // The verdict is computed here and stated, the way `earliest_start` already
  // is; the model is never asked to redo the arithmetic.

  it("tells the model plainly when the day fits, so it drops nothing", async () => {
    const payload = await sentPayload(feasibleRequest());
    expect(String(payload.drop_ruling)).toContain("FITS");
    expect(String(payload.drop_ruling)).toContain("Do NOT drop");
  });

  it("names the exact activities to drop when the day genuinely cannot fit", async () => {
    const payload = await sentPayload(infeasibleRequest());
    const ruling = String(payload.drop_ruling);
    expect(ruling).toContain("cannot fit");
    // Whatever the rail forces, the ruling must name it — the validator
    // compares the two lists for equality, so a vaguer instruction just
    // reproduces the rejection this exists to remove.
    const forced = resequenceDeterministically(infeasibleRequest())
      .filter((d) => d.action === "drop")
      .map((d) => d.nodeId);
    expect(forced.length).toBeGreaterThan(0);
    for (const nodeId of forced) expect(ruling).toContain(nodeId);
  });

  it("stays silent on a lighten-my-day mission, where the drop IS the question", async () => {
    const payload = await sentPayload({ ...feasibleRequest(), allowDiscretionaryDrops: true });
    expect(payload.drop_ruling).toBeUndefined();
  });
});

describe("discretionary drops on a lighten-my-day mission", () => {
  /** The model keeps one activity and drops the other, on a FEASIBLE day. */
  const dropsOne = [
    { nodeId: "a-surf", action: "retime", newTime: `${DATE}T10:00:00.000Z`, reason: "Kept." },
    { nodeId: "a-museum", action: "drop", reason: "Dropped to lighten the day." },
  ];

  it("is refused by default — a feasible day may not lose an activity", () => {
    expect(validateReorgDecisions(dropsOne, feasibleRequest())).toBeNull();
  });

  it("is accepted when the mission asked for a lighter day", () => {
    const request = { ...feasibleRequest(), allowDiscretionaryDrops: true };
    const validated = validateReorgDecisions(dropsOne, request);
    expect(validated).not.toBeNull();
    expect(validated?.find((d) => d.nodeId === "a-museum")?.action).toBe("drop");
  });

  it("still refuses to drop the activity the traveler asked to protect", () => {
    const request = {
      ...feasibleRequest(),
      allowDiscretionaryDrops: true,
      priorityName: "Ocean Museum Visit",
    };
    expect(validateReorgDecisions(dropsOne, request)).toBeNull();
  });

  it("still enforces every other rule in this mode", () => {
    const request = { ...feasibleRequest(), allowDiscretionaryDrops: true };
    // Both retimed onto the same slot: overlapping stays invalid.
    const overlapping = [
      { nodeId: "a-surf", action: "retime", newTime: `${DATE}T10:00:00.000Z`, reason: "x" },
      { nodeId: "a-museum", action: "retime", newTime: `${DATE}T10:00:00.000Z`, reason: "y" },
    ];
    expect(validateReorgDecisions(overlapping, request)).toBeNull();
  });

  it("names the rule it broke, so a rejection is diagnosable", () => {
    let reason = "";
    validateReorgDecisions(dropsOne, feasibleRequest(), (r) => {
      reason = r;
    });
    expect(reason).toContain("a-museum");
  });
});

