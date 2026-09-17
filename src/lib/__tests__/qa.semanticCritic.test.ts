/**
 * The semantic critic, on the two things it exists to guarantee.
 *
 * 1. It catches what the rule engine cannot — a venue that is shut, a bed that
 *    cannot be reached until tomorrow — and the engine ACTS on that finding
 *    deterministically: the node is dropped or re-timed, and every amount is
 *    then recomputed by code, never quoted by the model.
 * 2. It is never load-bearing. With no key, a timeout, a 429, a hallucinated
 *    node id or outright garbage on the wire, the pipeline produces the same
 *    honest plan it would have produced anyway.
 *
 * The LLM is a `fetchImpl` stub throughout: these tests never touch the
 * network, and they are the reason the offline behaviour is a fact rather than
 * an intention.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SemanticCritic,
  buildCriticPrompt,
  deterministicCriticisms,
  mergeCriticisms,
  rulingsFor,
  sanitizeCriticisms,
  unstayedNights,
  type CriticContext,
  type Criticism,
} from "@/core/sanity";

// ───────────────────────────────────────────────────────────── the scenario

/**
 * The brief's Test Case 1, as the engine sees it: SIN → NRT, the replacement
 * lands on 6 Nov at 17:15 instead of 5 Nov, the room was booked for the night
 * of the 5th, and Meiji Jingu is on the plan at 20:00.
 *
 * NRT is 75 minutes from town and the arrival is international, so the engine
 * puts the traveller in Tokyo at 17:15 + 20 + 45 + 25 + 75 = 20:00 — which is
 * itself why the shrine slot is nonsense twice over.
 */
function tokyoContext(overrides: Partial<CriticContext> = {}): CriticContext {
  return {
    incident: "Flight SQ632 SIN → NRT cancelled",
    arrival: {
      origin: "SIN",
      airport: "NRT",
      iso: "2026-11-06T17:15:00.000Z",
      ready_for_pickup_iso: "2026-11-06T18:45:00.000Z",
      ready_in_city_iso: "2026-11-06T20:00:00.000Z",
      is_next_day: true,
      original_arrival_iso: "2026-11-05T14:30:00.000Z",
    },
    hotel: {
      node_id: "hotel-0-1",
      name: "Hotel Ryumeikan Tokyo",
      booked_check_in: "2026-11-05T15:00:00.000Z",
      proposed_check_in: "2026-11-05T15:00:00.000Z",
    },
    items: [
      {
        node_id: "activity-0-2",
        name: "Meiji Jingu Shrine",
        proposed_start: "2026-11-05T20:00:00.000Z",
        original_start: "2026-11-05T20:00:00.000Z",
        category: "timed_activity",
        city: "Tokyo",
      },
    ],
    ...overrides,
  };
}

/** A Gemini REST double that answers with `body` (or a status). */
function geminiStub(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(
      status === 200
        ? JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }],
            usageMetadata: { totalTokenCount: 120 },
          })
        : "upstream said no",
      { status, statusText: status === 200 ? "OK" : "Error" },
    ),
  ) as unknown as typeof fetch;
}

// ─────────────────────────────────────────────── 1. the pure rules alone

describe("the sanity rules, with no model at all", () => {
  it("refuses a check-in that precedes the day the traveller lands", () => {
    const found = deterministicCriticisms(tokyoContext());
    const hotel = found.find((c) => c.node_id === "hotel-0-1");
    expect(hotel?.issue_type).toBe("HOTEL_PRECEDES_ARRIVAL");
    // A different DATE is a date shift, not a late check-in.
    expect(hotel?.suggested_action).toBe("SHIFT_DATE");
    expect(hotel?.explanation).toContain("2026-11-06");
  });

  it("refuses anything scheduled before the traveller is physically in town", () => {
    const shrine = deterministicCriticisms(tokyoContext()).find(
      (c) => c.node_id === "activity-0-2",
    );
    expect(shrine?.issue_type).toBe("UNREALISTIC_TRANSIT");
    expect(shrine?.suggested_action).toBe("DROP");
  });

  it("counts the booked night nobody will sleep in — and only when there is one", () => {
    const booked = Date.parse("2026-11-05T15:00:00.000Z");
    expect(unstayedNights(booked, Date.parse("2026-11-06T20:00:00.000Z"))).toBe(1);
    expect(unstayedNights(booked, Date.parse("2026-11-07T20:00:00.000Z"))).toBe(2);
    // A late arrival is NOT a lost night: 01:00 is still the night of the 5th,
    // which is how a hotel's own night counting works.
    expect(unstayedNights(booked, Date.parse("2026-11-06T01:00:00.000Z"))).toBe(0);
    expect(unstayedNights(booked, Date.parse("2026-11-05T23:40:00.000Z"))).toBe(0);
  });

  it("leaves a sane day completely alone", () => {
    const sane = tokyoContext({
      arrival: {
        origin: "SIN",
        airport: "NRT",
        iso: "2026-11-05T08:00:00.000Z",
        ready_for_pickup_iso: "2026-11-05T09:30:00.000Z",
        ready_in_city_iso: "2026-11-05T10:45:00.000Z",
        is_next_day: false,
      },
      hotel: {
        node_id: "hotel-0-1",
        name: "Hotel Ryumeikan Tokyo",
        booked_check_in: "2026-11-05T15:00:00.000Z",
        proposed_check_in: "2026-11-05T15:00:00.000Z",
      },
      items: [
        {
          node_id: "activity-0-2",
          name: "Meiji Jingu Shrine",
          proposed_start: "2026-11-05T13:00:00.000Z",
          original_start: "2026-11-05T13:00:00.000Z",
          category: "timed_activity",
        },
      ],
    });
    expect(deterministicCriticisms(sane)).toEqual([]);
  });

  it("flags a dusk-closing venue after dark even when the clock rules pass", () => {
    // 18:30 is inside the generic activity window (07:30–21:00) and is not a
    // sleeping hour, so ONLY venue knowledge can reject it.
    const found = deterministicCriticisms(
      tokyoContext({
        arrival: {
          origin: "SIN",
          airport: "NRT",
          iso: "2026-11-05T08:00:00.000Z",
          ready_for_pickup_iso: "2026-11-05T09:30:00.000Z",
          ready_in_city_iso: "2026-11-05T10:45:00.000Z",
          is_next_day: false,
        },
        hotel: undefined,
        items: [
          {
            node_id: "activity-0-2",
            name: "Meiji Jingu Shrine",
            proposed_start: "2026-11-05T18:30:00.000Z",
            original_start: "2026-11-05T11:00:00.000Z",
            category: "timed_activity",
          },
        ],
      }),
    );
    expect(found[0]?.issue_type).toBe("CLOSED_VENUE");
    expect(found[0]?.suggested_action).toBe("DROP");
  });

  it("never rules against lodging or a transfer for being late — those are real services", () => {
    const lateNight = deterministicCriticisms(
      tokyoContext({
        hotel: undefined,
        items: [
          {
            node_id: "transfer-1",
            name: "Private transfer from Narita",
            proposed_start: "2026-11-06T23:50:00.000Z",
            original_start: "2026-11-06T23:50:00.000Z",
            category: "ground_transfer",
          },
        ],
      }),
    );
    expect(lateNight).toEqual([]);
  });

  it("catches a slot that quietly slid onto the next day", () => {
    const found = deterministicCriticisms(
      tokyoContext({
        hotel: undefined,
        items: [
          {
            node_id: "activity-0-2",
            name: "teamLab Planets",
            // Already clamped past the arrival, so every clock rule passes —
            // the only thing wrong with it is that it is a different day.
            proposed_start: "2026-11-06T20:30:00.000Z",
            original_start: "2026-11-05T20:00:00.000Z",
            category: "timed_activity",
          },
        ],
      }),
    );
    expect(found[0]?.issue_type).toBe("UNREALISTIC_TRANSIT");
    expect(found[0]?.suggested_action).toBe("DROP");
    expect(found[0]?.explanation).toContain("already has its own plan");
  });
});

// ───────────────────────────────────────── 2. the model, and its guardrails

describe("the model rail", () => {
  it("adds venue knowledge the rules do not have, and says so", async () => {
    const fetchImpl = geminiStub({
      is_sane: false,
      criticisms: [
        {
          node_id: "activity-0-2",
          issue_type: "CLOSED_VENUE",
          explanation: "Meiji Jingu closes at sunset, about 16:30 in November.",
          suggested_action: "DROP",
        },
      ],
    });
    const critic = new SemanticCritic({ apiKey: "test-key", fetchImpl });
    const verdict = await critic.review(
      tokyoContext({
        hotel: undefined,
        arrival: {
          origin: "SIN",
          airport: "NRT",
          iso: "2026-11-05T08:00:00.000Z",
          ready_for_pickup_iso: "2026-11-05T09:30:00.000Z",
          ready_in_city_iso: "2026-11-05T10:45:00.000Z",
          is_next_day: false,
        },
        items: [
          {
            node_id: "activity-0-2",
            name: "Meiji Jingu Shrine",
            // 15:30 passes every rule INCLUDING the dusk floor (17:00).
            proposed_start: "2026-11-05T15:30:00.000Z",
            original_start: "2026-11-05T11:00:00.000Z",
            category: "timed_activity",
          },
        ],
      }),
    );
    expect(verdict.source).toBe("gemini");
    expect(verdict.is_sane).toBe(false);
    expect(verdict.criticisms[0].explanation).toContain("sunset");
    expect(verdict.degradeReason).toBeUndefined();
  });

  it("cannot clear a violation the rules already proved", async () => {
    // The model is cheerful and wrong: the check-in really does precede the
    // arrival, and no amount of `is_sane: true` may bless it.
    const critic = new SemanticCritic({
      apiKey: "test-key",
      fetchImpl: geminiStub({ is_sane: true, criticisms: [] }),
    });
    const verdict = await critic.review(tokyoContext());
    expect(verdict.is_sane).toBe(false);
    expect(verdict.criticisms.map((c) => c.issue_type)).toContain("HOTEL_PRECEDES_ARRIVAL");
  });

  it("where they disagree about the same node, the proof wins", () => {
    const rules: Criticism[] = [
      {
        node_id: "activity-0-2",
        issue_type: "UNREALISTIC_TRANSIT",
        explanation: "You are not in town until 20:00.",
        suggested_action: "DROP",
      },
    ];
    const model: Criticism[] = [
      {
        node_id: "activity-0-2",
        issue_type: "CLOSED_VENUE",
        explanation: "It would be fine a bit later.",
        suggested_action: "RETIME",
      },
      {
        node_id: "activity-0-3",
        issue_type: "CLOSED_VENUE",
        explanation: "The garden shuts at 17:00.",
        suggested_action: "DROP",
      },
    ];
    const merged = mergeCriticisms(rules, model);
    expect(merged).toHaveLength(2);
    expect(merged[0].suggested_action).toBe("DROP");
    expect(merged[1].node_id).toBe("activity-0-3");
  });

  it("discards criticisms of nodes it was never shown", () => {
    const known = new Set(["activity-0-2"]);
    const kept = sanitizeCriticisms(
      {
        criticisms: [
          {
            node_id: "activity-9-9",
            issue_type: "CLOSED_VENUE",
            explanation: "The Louvre is shut on Tuesdays.",
            suggested_action: "DROP",
          },
          {
            node_id: "activity-0-2",
            issue_type: "closed_venue",
            explanation: "Shut after dark.",
            suggested_action: "drop",
          },
        ],
      },
      known,
    );
    expect(kept).toHaveLength(1);
    expect(kept?.[0].node_id).toBe("activity-0-2");
    // Case is normalized rather than rejected — the payload is still honest.
    expect(kept?.[0].issue_type).toBe("CLOSED_VENUE");
  });

  it("drops entries with an unknown issue type or action", () => {
    const kept = sanitizeCriticisms(
      {
        criticisms: [
          { node_id: "a", issue_type: "TOO_EXPENSIVE", explanation: "x", suggested_action: "DROP" },
          { node_id: "a", issue_type: "CLOSED_VENUE", explanation: "x", suggested_action: "REFUND" },
          { node_id: "a", issue_type: "CLOSED_VENUE", explanation: "", suggested_action: "DROP" },
        ],
      },
      new Set(["a"]),
    );
    expect(kept).toEqual([]);
  });

  it("never sends the traveller's money to the model", () => {
    const prompt = buildCriticPrompt(tokyoContext());
    expect(prompt).not.toMatch(/price|cost|fee|refund|currency|EUR|USD|amount/i);
    // …and it hands over the buffers as ANSWERS, not as arithmetic.
    expect(JSON.parse(prompt).arrival.ready_in_city).toBe("2026-11-06T20:00:00.000Z");
  });
});

// ──────────────────────────────────────────── 3. the offline / failure rails

describe("the critic is never load-bearing", () => {
  /** `degrades: false` ⇒ switched off on purpose, which is a configuration
   *  rather than a failure and must NOT be classified as one. */
  const cases: Array<[string, () => SemanticCritic, boolean?]> = [
    ["no API key at all", () => new SemanticCritic({ apiKey: "" })],
    ["explicitly disabled", () => new SemanticCritic({ apiKey: "k", enabled: false }), false],
    [
      "a 429 from every model",
      () => new SemanticCritic({ apiKey: "k", fetchImpl: geminiStub(null, 429) }),
    ],
    [
      "a 500 from every model",
      () => new SemanticCritic({ apiKey: "k", fetchImpl: geminiStub(null, 500) }),
    ],
    [
      "prose instead of JSON",
      () =>
        new SemanticCritic({
          apiKey: "k",
          fetchImpl: vi.fn(async () =>
            new Response(
              JSON.stringify({ candidates: [{ content: { parts: [{ text: "I think it's fine!" }] } }] }),
              { status: 200 },
            ),
          ) as unknown as typeof fetch,
        }),
    ],
    [
      "a network reset",
      () =>
        new SemanticCritic({
          apiKey: "k",
          fetchImpl: vi.fn(async () => {
            throw new Error("ECONNRESET");
          }) as unknown as typeof fetch,
        }),
    ],
  ];

  for (const [label, build, degrades = true] of cases) {
    it(`falls back to the pure rules on ${label}`, async () => {
      const verdict = await build().review(tokyoContext());
      expect(verdict.source).toBe("deterministic");
      // The deterministic findings are ALL still there — the day is still safe.
      expect(verdict.criticisms.map((c) => c.issue_type)).toEqual([
        "HOTEL_PRECEDES_ARRIVAL",
        "UNREALISTIC_TRANSIT",
      ]);
      // A failure is classified so an operator can grep for it; a switch that
      // was never flipped on has nothing to classify.
      expect(verdict.degradeReason !== undefined).toBe(degrades);
    });
  }

  it("honours its per-mission call budget instead of hammering the model", async () => {
    const fetchImpl = geminiStub({ is_sane: true, criticisms: [] });
    const critic = new SemanticCritic({ apiKey: "k", fetchImpl, callBudget: 2 });
    for (let i = 0; i < 4; i += 1) await critic.review(tokyoContext());
    expect(critic.geminiCallsUsed).toBe(2);
    expect(critic.lastDegradeReason).toBe("quota_429");
  });

  it("spends nothing on a day with nothing on it", async () => {
    const fetchImpl = geminiStub({ is_sane: true, criticisms: [] });
    const critic = new SemanticCritic({ apiKey: "k", fetchImpl });
    const verdict = await critic.review(tokyoContext({ hotel: undefined, items: [] }));
    expect(critic.geminiCallsUsed).toBe(0);
    expect(verdict.is_sane).toBe(true);
  });
});

// ──────────────────────────────────────────────── 4. turning verdicts into acts

describe("what the orchestrator is told to do about it", () => {
  it("a shrine with no sensible slot left today is dropped, not pushed to tomorrow", () => {
    const context = tokyoContext();
    const rulings = rulingsFor(
      {
        is_sane: false,
        source: "gemini",
        criticisms: [
          {
            node_id: "activity-0-2",
            issue_type: "CLOSED_VENUE",
            explanation: "Meiji Jingu closes at sunset.",
            suggested_action: "RETIME",
          },
        ],
      },
      context,
    );
    // RETIME was asked for; there is no sensible slot left on the 5th, and the
    // 6th is not ours to fill — so the honest answer is a drop.
    expect(rulings.get("activity-0-2")).toMatchObject({ action: "drop" });
  });

  it("re-times within the day when the day still has room", () => {
    const context = tokyoContext({
      arrival: {
        origin: "SIN",
        airport: "NRT",
        iso: "2026-11-05T05:00:00.000Z",
        ready_for_pickup_iso: "2026-11-05T06:30:00.000Z",
        ready_in_city_iso: "2026-11-05T07:45:00.000Z",
        is_next_day: false,
      },
      hotel: undefined,
      items: [
        {
          node_id: "activity-0-2",
          name: "Sensoji Temple",
          proposed_start: "2026-11-05T06:00:00.000Z",
          original_start: "2026-11-05T10:00:00.000Z",
          category: "timed_activity",
        },
      ],
    });
    const rulings = rulingsFor(
      {
        is_sane: false,
        source: "gemini",
        criticisms: [
          {
            node_id: "activity-0-2",
            issue_type: "UNREALISTIC_TRANSIT",
            explanation: "You are not in Asakusa before 07:45.",
            suggested_action: "RETIME",
          },
        ],
      },
      context,
    );
    const ruling = rulings.get("activity-0-2");
    expect(ruling?.action).toBe("retime");
    if (ruling?.action === "retime") {
      expect(new Date(ruling.atMs).toISOString()).toBe("2026-11-05T07:45:00.000Z");
    }
  });

  it("honours a date shift for the bed, and only for the bed", () => {
    const context = tokyoContext();
    const rulings = rulingsFor(
      {
        is_sane: false,
        source: "deterministic",
        criticisms: deterministicCriticisms(context),
      },
      context,
    );
    const hotel = rulings.get("hotel-0-1");
    expect(hotel?.action).toBe("shift_date");
    if (hotel?.action === "shift_date") {
      // Moved to the arrival day, at the first hour the traveller is in town.
      expect(new Date(hotel.toMs).toISOString()).toBe("2026-11-06T20:00:00.000Z");
    }
  });
});
