/**
 * GeminiLiaisonAgent unit tests (two-phase assess/resolve flow).
 *
 * fetch is mocked per-test: schema-constrained response parsing, the JSON
 * repair pipeline, fallback to deterministic questions on 429 / missing key /
 * garbage output, constraint translation (model + deterministic paths), and
 * the multi-language fallback dictionary (en/de/es/fr/zh, unknown → en).
 *
 * W1 additions: the deterministic PREFERENCE builder (server-composed
 * questions from the candidate feed's real facts), the flight-number
 * sanitizer rejection, and the new constraint branches
 * (nonstop/same_day/activity-priority).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeminiLiaisonAgent,
  buildDeterministicTradeoffs,
  buildPreferenceTradeoffs,
  deriveConstraintsFromAnswers,
  normalizeLanguage,
} from "@/agents/liaison/GeminiLiaisonAgent";
import type { TradeoffAnswer, TradeoffQuestion } from "@/agents/liaison/GeminiLiaisonAgent";

// ------------------------------------------------------------------- helpers

/** Wrap a Gemini-shaped success payload in a mocked Response. */
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

function agentWith(fetchImpl: typeof fetch): GeminiLiaisonAgent {
  return new GeminiLiaisonAgent({ apiKey: "test-key", fetchImpl });
}

const QUESTIONS_JSON = JSON.stringify([
  {
    id: "flight-tradeoff",
    question: "Which replacement flight suits you best?",
    detail: "Two options were found.",
    options: [
      { id: "cheapest", label: "Cheapest flight", detail: "+€45 fare difference" },
      { id: "fastest", label: "Fastest flight", detail: "Departs in 40 min" },
    ],
  },
  {
    id: "hotel-tradeoff",
    question: "What about your hotel?",
    options: [
      { id: "keep", label: "Keep booking" },
      { id: "rebook", label: "Rebook" },
    ],
  },
]);

const CONTEXT = {
  incident: "Flight XY123 delayed by 4h",
  candidates: [{ option: { id: "OPT-1", price: 189.5 }, fareDifference: { amount: 45 } }],
};

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------- generateTradeoffQuestions

describe("generateTradeoffQuestions — schema-constrained parsing", () => {
  it("parses a well-formed model response into frozen-contract questions", async () => {
    const agent = agentWith(vi.fn(async () => geminiResponse(QUESTIONS_JSON)));
    const questions = await agent.generateTradeoffQuestions(CONTEXT);
    expect(questions).not.toBeNull();
    expect(questions).toHaveLength(2);
    for (const q of questions!) {
      expect(typeof q.id).toBe("string");
      expect(typeof q.question).toBe("string");
      expect(q.options).toHaveLength(2); // frozen contract: exactly 2 options
      for (const o of q.options) {
        expect(typeof o.id).toBe("string");
        expect(typeof o.label).toBe("string");
      }
    }
    expect(questions![0].options[0].detail).toBe("+€45 fare difference");
  });

  it("recovers fenced/trailing-comma output through the repair pipeline", async () => {
    const sloppy = "```json\n" + QUESTIONS_JSON.slice(0, -1) + ",\n]\n```"; // trailing comma + fence
    const agent = agentWith(vi.fn(async () => geminiResponse(sloppy)));
    const questions = await agent.generateTradeoffQuestions(CONTEXT);
    expect(questions).not.toBeNull();
    expect(questions!.length).toBeGreaterThanOrEqual(1);
    expect(questions![0].id).toBe("flight-tradeoff");
  });

  it("drops questions missing their second option and keeps the valid one", async () => {
    const oneValid = JSON.stringify([
      JSON.parse(QUESTIONS_JSON)[0],
      { id: "broken", question: "Only one option", options: [{ id: "a", label: "A" }] },
    ]);
    const agent = agentWith(vi.fn(async () => geminiResponse(oneValid)));
    const questions = await agent.generateTradeoffQuestions(CONTEXT);
    expect(questions).toHaveLength(1);
    expect(questions![0].id).toBe("flight-tradeoff");
  });

  it("deduplicates questions with the same id, keeping only the FIRST", async () => {
    const [first] = JSON.parse(QUESTIONS_JSON);
    const duplicate = JSON.stringify([
      first,
      {
        id: first.id, // same question id as the first entry
        question: "Duplicate question — must be dropped",
        options: [
          { id: "x", label: "X" },
          { id: "y", label: "Y" },
        ],
      },
    ]);
    const agent = agentWith(vi.fn(async () => geminiResponse(duplicate)));
    const questions = await agent.generateTradeoffQuestions(CONTEXT);
    expect(questions).toHaveLength(1);
    expect(questions![0].id).toBe("flight-tradeoff");
    expect(questions![0].question).toBe("Which replacement flight suits you best?");
  });

  it("sends a language directive so user-facing strings match the locale", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      geminiResponse(QUESTIONS_JSON),
    );
    const agent = agentWith(fetchImpl as unknown as typeof fetch);
    await agent.generateTradeoffQuestions({ ...CONTEXT, language: "de-DE" });
    const init = fetchImpl.mock.calls[0]![1]!;
    const body = JSON.parse(String(init.body));
    expect(body.systemInstruction.parts[0].text).toContain('"de"');
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.type).toBe("ARRAY");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
  });
});

describe("generateTradeoffQuestions — degradation to null", () => {
  it("returns null when the API key is missing", async () => {
    const agent = new GeminiLiaisonAgent({ fetchImpl: vi.fn() }); // no env, no config
    await expect(agent.generateTradeoffQuestions(CONTEXT)).resolves.toBeNull();
  });

  it("returns null on HTTP 429", async () => {
    const agent = agentWith(
      vi.fn(async () => new Response("quota", { status: 429, statusText: "Too Many Requests" })),
    );
    await expect(agent.generateTradeoffQuestions(CONTEXT)).resolves.toBeNull();
  });

  it("returns null when fetch rejects (network/timeout)", async () => {
    const agent = agentWith(
      vi.fn(async () => {
        throw new Error("AbortError: timeout");
      }),
    );
    await expect(agent.generateTradeoffQuestions(CONTEXT)).resolves.toBeNull();
  });

  it("returns null on unrepairable garbage output", async () => {
    const agent = agentWith(vi.fn(async () => geminiResponse("I cannot produce JSON, sorry.")));
    await expect(agent.generateTradeoffQuestions(CONTEXT)).resolves.toBeNull();
  });
});

// --------------------------------------------- deterministic fallback + i18n

const FLIGHT_CANDIDATES = [
  { option: { id: "OPT-1", price: 189.5 }, fareDifference: { amount: 45 } },
  { option: { id: "OPT-2", price: 260 }, fareDifference: { amount: 116 } },
];
const HOTEL_CANDIDATES = [{ hotel_name: "Atlantica Surf House", action: "rebook", fee: 0 }];
const ACTIVITY_CANDIDATES = [
  {
    activityNodeId: "activity-surf",
    action: "reschedule",
    newTime: "2026-08-23T10:00:00Z",
    penalty: 0,
    currency: "EUR",
  },
];

describe("buildDeterministicTradeoffs — fallback + localization", () => {
  it("builds flight + hotel questions (exactly 2 options each)", () => {
    const questions = buildDeterministicTradeoffs([...FLIGHT_CANDIDATES, ...HOTEL_CANDIDATES]);
    expect(questions).toHaveLength(2);
    expect(questions.map((q) => q.id)).toEqual(["flight-tradeoff", "hotel-tradeoff"]);
    for (const q of questions) {
      expect(q.options).toHaveLength(2);
      expect(q.options.map((o) => o.id)).toEqual(
        q.id === "flight-tradeoff" ? ["cheapest", "fastest"] : ["keep", "rebook"],
      );
    }
  });

  it("emits only the flight question when no hotel candidate is present", () => {
    const questions = buildDeterministicTradeoffs(FLIGHT_CANDIDATES);
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("flight-tradeoff");
  });

  it("emits the activity question when only hotel candidates exist (no flights)", () => {
    const questions = buildDeterministicTradeoffs(HOTEL_CANDIDATES);
    expect(questions).toHaveLength(2);
    expect(questions.map((q) => q.id)).toEqual(["activity-tradeoff", "hotel-tradeoff"]);
    expect(questions[0].options.map((o) => o.id)).toEqual(["slow_down", "stay_active"]);
  });

  it("emits ONLY the activity question for activity candidates without flights", () => {
    const questions = buildDeterministicTradeoffs(ACTIVITY_CANDIDATES);
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("activity-tradeoff");
    expect(questions[0].options.map((o) => o.id)).toEqual(["slow_down", "stay_active"]);
    // Reschedule-only proposals carry no venue name ⇒ the frozen copy stays
    // byte-identical (no empty parentheses appended).
    expect(questions[0].detail).toBe(
      "No flights are affected — tell us how you'd like to spend the time.",
    );
    expect(questions[0].options[1].detail).toBe("Fill the gap with a new experience");
  });

  it("interpolates real venue/swap names into the activity question details", () => {
    // Activity-cancelled feed carrying a Viator swap: the question names the
    // actual replacement venue while ids/question/labels stay frozen.
    const swapFeed = [
      {
        activityNodeId: "activity-0-0",
        action: "swap",
        newTime: "2026-08-23T10:00:00Z",
        penalty: 0,
        currency: "EUR",
        swap: {
          replacementName: "Lisbon Oceanarium Ticket",
          priceDelta: 0,
          reason: "rain",
        },
      },
    ];
    const questions = buildDeterministicTradeoffs(swapFeed);
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("activity-tradeoff");
    expect(questions[0].question).toBe("How should we reshape your activities?");
    expect(questions[0].detail).toBe(
      "No flights are affected — tell us how you'd like to spend the time. (Lisbon Oceanarium Ticket)",
    );
    expect(questions[0].options.map((o) => o.id)).toEqual(["slow_down", "stay_active"]);
    expect(questions[0].options[1].detail).toBe(
      "Fill the gap with a new experience (Lisbon Oceanarium Ticket)",
    );
    // The slow_down copy carries no venue name (it keeps the frozen text).
    expect(questions[0].options[0].detail).toBe("Fewer bookings, more breathing room");
  });

  it("keeps the flight question byte-identical when flight candidates share the feed", () => {
    // Flight + activity mix: the flight rail wins and its detail NEVER picks
    // up activity interpolation.
    const questions = buildDeterministicTradeoffs([
      ...FLIGHT_CANDIDATES,
      {
        activityNodeId: "activity-0-0",
        action: "swap",
        newTime: "2026-08-23T10:00:00Z",
        penalty: 0,
        currency: "EUR",
        swap: { replacementName: "Lisbon Oceanarium Ticket", priceDelta: 0, reason: "rain" },
      },
    ]);
    const flight = questions.find((q) => q.id === "flight-tradeoff");
    expect(flight).toBeDefined();
    expect(flight?.detail).toBe("The swarm found rebooking options. Tell us what matters most.");
    expect(flight?.detail).not.toContain("Lisbon Oceanarium");
    // No activity question alongside the flight question.
    expect(questions.some((q) => q.id === "activity-tradeoff")).toBe(false);
  });

  it("keeps the flight question first whenever flight candidates exist", () => {
    const questions = buildDeterministicTradeoffs([
      ...HOTEL_CANDIDATES,
      ...ACTIVITY_CANDIDATES,
      ...FLIGHT_CANDIDATES,
    ]);
    expect(questions.map((q) => q.id)).toEqual(["flight-tradeoff", "hotel-tradeoff"]);
  });

  it("returns German strings for 'de'", () => {
    const questions = buildDeterministicTradeoffs(HOTEL_CANDIDATES, "de");
    expect(questions[0].question).toBe("Wie sollen wir Ihre Aktivitäten anpassen?");
    expect(questions[0].options[0].label).toBe("Ruhiger angehen");
    expect(questions[1].options[0].label).toBe("Buchung behalten");
  });

  it("localizes es / fr / zh variants", () => {
    expect(buildDeterministicTradeoffs(FLIGHT_CANDIDATES, "es")[0].options[1].label).toBe(
      "La opción más rápida",
    );
    expect(buildDeterministicTradeoffs(FLIGHT_CANDIDATES, "fr")[0].options[0].label).toBe(
      "L'option la moins chère",
    );
    expect(buildDeterministicTradeoffs(FLIGHT_CANDIDATES, "zh")[0].options[0].label).toBe(
      "最便宜的选项",
    );
  });

  it("localizes the activity-preference question in all five locales", () => {
    const expected: Record<string, [string, string, string]> = {
      en: ["How should we reshape your activities?", "Slow it down", "Keep the day full"],
      de: ["Wie sollen wir Ihre Aktivitäten anpassen?", "Ruhiger angehen", "Den Tag ausfüllen"],
      es: ["¿Cómo adaptamos tus actividades?", "Bajar el ritmo", "Mantener el día completo"],
      fr: ["Comment adapter vos activités ?", "Ralentir le rythme", "Garder la journée remplie"],
      zh: ["我们该如何调整您的活动安排？", "放慢节奏", "保持行程充实"],
    };
    for (const [lang, [question, slow, active]] of Object.entries(expected)) {
      const questions = buildDeterministicTradeoffs(ACTIVITY_CANDIDATES, lang);
      expect(questions[0].id).toBe("activity-tradeoff");
      expect(questions[0].question).toBe(question);
      expect(questions[0].options[0].label).toBe(slow);
      expect(questions[0].options[1].label).toBe(active);
    }
  });

  it("falls back to English for unknown language codes", () => {
    const questions = buildDeterministicTradeoffs(FLIGHT_CANDIDATES, "ja");
    expect(questions[0].options[0].label).toBe("Cheapest option");
    expect(normalizeLanguage("ja")).toBe("en");
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage("zh-CN")).toBe("zh");
  });

  describe("hotelOverbooked — no existing booking survives to 'keep'", () => {
    it("swaps the hotel question for a rebook-only variant when overbooked", () => {
      const questions = buildDeterministicTradeoffs(HOTEL_CANDIDATES, "en", {
        hotelOverbooked: true,
      });
      const hotel = questions.find((q) => q.id === "hotel-tradeoff");
      expect(hotel).toBeDefined();
      expect(hotel?.question).toBe("Your hotel can't take you — what next?");
      // Neither option may imply the traveler still has a room to keep.
      expect(hotel?.options.map((o) => o.id)).toEqual(["nearby", "best_value"]);
      expect(hotel?.options.some((o) => o.id === "keep")).toBe(false);
    });

    it("keeps the ordinary keep/rebook hotel question when NOT overbooked", () => {
      const questions = buildDeterministicTradeoffs(HOTEL_CANDIDATES, "en", {
        hotelOverbooked: false,
      });
      const hotel = questions.find((q) => q.id === "hotel-tradeoff");
      expect(hotel?.question).toBe("What should we do about your hotel?");
      expect(hotel?.options.map((o) => o.id)).toEqual(["keep", "rebook"]);
    });

    it("defaults to the ordinary hotel question when opts is omitted", () => {
      const questions = buildDeterministicTradeoffs(HOTEL_CANDIDATES);
      const hotel = questions.find((q) => q.id === "hotel-tradeoff");
      expect(hotel?.options.map((o) => o.id)).toEqual(["keep", "rebook"]);
    });

    it("localizes the overbooked hotel question in all five locales", () => {
      const expected: Record<string, string> = {
        en: "Your hotel can't take you — what next?",
        de: "Ihr Hotel kann Sie nicht aufnehmen — wie geht es weiter?",
        es: "Tu hotel no puede alojarte — ¿qué hacemos?",
        fr: "Votre hôtel ne peut pas vous accueillir — que faisons-nous ?",
        zh: "酒店无法接待您——接下来怎么办？",
      };
      for (const [lang, question] of Object.entries(expected)) {
        const questions = buildDeterministicTradeoffs(HOTEL_CANDIDATES, lang, {
          hotelOverbooked: true,
        });
        const hotel = questions.find((q) => q.id === "hotel-tradeoff");
        expect(hotel?.question).toBe(question);
      }
    });
  });
});

// ------------------------------------------------ translateAnswersToConstraints

const QUESTIONS: TradeoffQuestion[] = [
  {
    id: "flight-tradeoff",
    question: "Which flight?",
    options: [
      { id: "cheapest", label: "Cheapest flight", detail: "+€45 fare difference" },
      { id: "fastest", label: "Fastest flight", detail: "Departs in 40 min" },
    ],
  },
  {
    id: "hotel-tradeoff",
    question: "What about your hotel?",
    options: [
      { id: "keep", label: "Keep booking" },
      { id: "rebook", label: "Rebook" },
    ],
  },
];

describe("translateAnswersToConstraints — model path", () => {
  it("sanitizes a well-formed model response to the frozen contract", async () => {
    const modelJson = JSON.stringify({
      max_price: 45,
      prefer_direct: false,
      keep_hotel: true,
      bogus_field: "dropped",
      notes: 42, // wrong type → dropped
    });
    const agent = agentWith(vi.fn(async () => geminiResponse(modelJson)));
    const constraints = await agent.translateAnswersToConstraints(QUESTIONS, []);
    expect(constraints).toEqual({ max_price: 45, prefer_direct: false, keep_hotel: true });
  });

  it("Task 25 (#2): a PARTIAL model payload merges onto the deterministic answers", async () => {
    // W1 preference questions the traveler actually answered:
    const w1Questions: TradeoffQuestion[] = [
      {
        id: "flight-stops",
        question: "Nonstop, or save money with a stop?",
        options: [
          { id: "nonstop", label: "Fly nonstop", detail: "+€45 fare difference" },
          { id: "cheaper_with_stop", label: "Take the cheaper routing" },
        ],
      },
      {
        id: "activity-priority",
        question: "Which booking should we fight for?",
        options: [
          { id: "keep_night_food_tour", label: "Keep Night Food Tour" },
          { id: "drop_sunrise_surf", label: "Drop Sunrise Surf" },
        ],
      },
    ];
    const answers: TradeoffAnswer[] = [
      { question_id: "flight-stops", option_id: "nonstop" },
      { question_id: "activity-priority", option_id: "keep_night_food_tour" },
    ];
    // The model emits ONLY max_price — the constraints schema has no
    // required array, so pre-fix the answered preference fields were
    // silently discarded. Deterministic-first merge keeps them.
    const agent = agentWith(vi.fn(async () => geminiResponse(JSON.stringify({ max_price: 300 }))));
    const constraints = await agent.translateAnswersToConstraints(w1Questions, answers);
    expect(constraints).toEqual({
      // Answered fields survive (deterministic base)…
      prefer_nonstop: true,
      prefer_direct: true,
      activity_priority: "night food tour",
      // …and the model-only field lands alongside them.
      max_price: 300,
    });
  });
});

describe("the model ladder on a plain HTTP failure", () => {
  // Measured on the live matrix of 2026-09-01: 8 of 9 Gemini degradations were
  // `http_error`, and NONE of them ever asked a second model. The ladder only
  // advanced on 429/503, on the reasoning that any other failure "is this
  // request's own problem and a different model would repeat it" — but a 500,
  // or a 4xx specific to one model, is a fact about that endpoint. Falling
  // straight to the deterministic rail threw away the intelligence layer for
  // the cost of one more call.

  beforeEach(() => resetModelCooldowns());

  it("tries the NEXT model after an HTTP failure, instead of giving up", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(geminiResponse("boom", 500))
      .mockResolvedValueOnce(geminiResponse(JSON.stringify({ max_price: 45 })));
    const agent = new GeminiLiaisonAgent({ apiKey: "test-key", fetchImpl, maxRetries: 1 });

    const constraints = await agent.translateAnswersToConstraints(QUESTIONS, []);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // …and the two calls went to DIFFERENT models, not the same one twice.
    const modelOf = (call: unknown[]) => String(call[0]).split("/models/")[1]?.split(":")[0];
    expect(modelOf(fetchImpl.mock.calls[0])).not.toBe(modelOf(fetchImpl.mock.calls[1]));
    // The second model's answer is the one the traveler gets.
    expect(constraints).toEqual({ max_price: 45 });
    expect(agent.lastDegradeReason).toBeUndefined();
  });

  it("a one-off HTTP failure does NOT put the model in cooldown", async () => {
    // Only a quota refusal earns a cooldown; sidelining a healthy model for
    // minutes because of a single 500 would be its own outage.
    const first = GEMINI_MODEL_CASCADE[0];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(geminiResponse("boom", 500))
      .mockResolvedValueOnce(geminiResponse(JSON.stringify({ max_price: 10 })));
    const agent = new GeminiLiaisonAgent({ apiKey: "test-key", fetchImpl, maxRetries: 1 });
    await agent.translateAnswersToConstraints(QUESTIONS, []);
    expect(modelLadder()[0]).toBe(first);
  });

  it("still lands on the deterministic rail when EVERY model fails", async () => {
    // Being wrong about a retryable failure costs one extra call, never a
    // worse outcome: the fallback is exactly where it was before.
    const fetchImpl = vi.fn(async () => geminiResponse("boom", 500));
    const agent = new GeminiLiaisonAgent({ apiKey: "test-key", fetchImpl, maxRetries: 1 });
    const constraints = await agent.translateAnswersToConstraints(QUESTIONS, []);
    expect(agent.lastDegradeReason).toBe("http_error");
    expect(constraints).toBeDefined(); // deterministic derivation, never a throw
  });
});

describe("translateAnswersToConstraints — deterministic fallback (never throws)", () => {
  const ANSWERS: TradeoffAnswer[] = [
    { question_id: "flight-tradeoff", option_id: "cheapest" },
    { question_id: "hotel-tradeoff", option_id: "keep" },
  ];

  it("derives constraints from option ids when fetch rejects", async () => {
    const agent = agentWith(
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const constraints = await agent.translateAnswersToConstraints(QUESTIONS, ANSWERS);
    expect(constraints.max_price).toBe(45); // parsed from "+€45 fare difference"
    expect(constraints.keep_hotel).toBe(true);
  });

  it("derives constraints when the API key is missing", async () => {
    const agent = new GeminiLiaisonAgent({ fetchImpl: vi.fn() });
    const constraints = await agent.translateAnswersToConstraints(QUESTIONS, [
      { question_id: "flight-tradeoff", option_id: "fastest" },
      { question_id: "hotel-tradeoff", option_id: "rebook" },
    ]);
    expect(constraints.prefer_earliest).toBe(true);
    expect(constraints.keep_hotel).toBe(false);
  });

  it("falls back deterministically on unrepairable model garbage", async () => {
    const agent = agentWith(vi.fn(async () => geminiResponse("not json at all")));
    const constraints = await agent.translateAnswersToConstraints(QUESTIONS, ANSWERS);
    expect(constraints.keep_hotel).toBe(true);
  });
});

describe("deriveConstraintsFromAnswers — heuristics", () => {
  it("maps well-known option ids", () => {
    const constraints = deriveConstraintsFromAnswers(QUESTIONS, [
      { question_id: "q1", option_id: "direct-nonstop" },
      { question_id: "q2", option_id: "yes" },
      { question_id: "q3", option_id: "tomorrow" },
    ]);
    expect(constraints.prefer_direct).toBe(true);
    expect(constraints.keep_hotel).toBe(true);
    expect(constraints.prefer_earliest).toBe(true);
  });

  it("extracts max_price only from CURRENCY-ANCHORED amounts", () => {
    const questions: TradeoffQuestion[] = [
      {
        id: "q-price",
        question: "Which flight?",
        options: [{ id: "cheapest", label: "Cheapest flight", detail: "+€89,90 fare difference" }],
      },
      {
        id: "q-usd",
        question: "Budget cap?",
        options: [{ id: "budget", label: "Keep it cheap", detail: "around USD 120 total" }],
      },
    ];
    const constraints = deriveConstraintsFromAnswers(questions, [
      { question_id: "q-price", option_id: "cheapest" },
      { question_id: "q-usd", option_id: "budget" },
    ]);
    // €89,90 parses (comma decimal); USD 120 caps via Math.min.
    expect(constraints.max_price).toBe(89.9);
  });

  it("does NOT derive max_price from bare numbers like 'Option 2'", () => {
    const questions: TradeoffQuestion[] = [
      {
        id: "q-bare",
        question: "Which flight?",
        options: [{ id: "cheapest", label: "Option 2", detail: "budget pick" }],
      },
    ];
    const constraints = deriveConstraintsFromAnswers(questions, [
      { question_id: "q-bare", option_id: "cheapest" },
    ]);
    // No currency context ⇒ no max_price; the preference lands in `notes`.
    expect(constraints.max_price).toBeUndefined();
    expect(constraints.notes).toBe("Option 2");
  });

  it("never throws on empty input", () => {
    expect(deriveConstraintsFromAnswers([], [])).toEqual({});
  });
});

// --------------------------------------------- W1 preference builder (primary)

/** Flight-shaped RebookingCandidate fixture for the preference builder. */
function flightCandidate(config: {
  id: string;
  amount: number;
  departure: string;
  arrival?: string;
  currency?: string;
  stops?: number;
  airline?: string;
}): unknown {
  return {
    option: {
      id: config.id,
      airline: config.airline ?? "Atlas Sandbox",
      departureTime: config.departure,
      arrivalTime: config.arrival ?? "2026-08-22T18:00:00Z",
      ...(config.stops !== undefined ? { stops: config.stops } : {}),
    },
    fareDifference: {
      oldFlightId: "flight-xy123",
      newFlightId: config.id,
      amount: config.amount,
      currency: config.currency ?? "EUR",
      direction: "charge",
    },
  };
}

/** Two at-risk activities with NAMEABLE venues (swap replacements). */
const TWO_ACTIVITIES = [
  {
    activityNodeId: "activity-0-0",
    action: "swap",
    newTime: "2026-08-23T10:00:00Z",
    penalty: 0,
    currency: "EUR",
    swap: { replacementName: "Lisbon Oceanarium Ticket", priceDelta: 0, reason: "rain" },
  },
  {
    activityNodeId: "activity-0-1",
    action: "swap",
    newTime: "2026-08-23T14:00:00Z",
    penalty: 0,
    currency: "EUR",
    swap: { replacementName: "Beach Surf Lesson", priceDelta: 0, reason: "rain" },
  },
];

describe("buildPreferenceTradeoffs — W1 preference builder (primary rail)", () => {
  it("builds the stops question when both routings exist and the stop is cheaper", () => {
    const feed = [
      flightCandidate({ id: "D1", amount: 120, departure: "2026-08-22T15:30:00Z" }),
      flightCandidate({
        id: "S1",
        amount: 70,
        departure: "2026-08-22T13:00:00Z",
        arrival: "2026-08-22T17:30:00Z",
        stops: 1,
      }),
    ];
    const questions = buildPreferenceTradeoffs(feed);
    expect(questions.map((q) => q.id)).toEqual(["flight-stops", "budget-cap"]);

    const stops = questions[0];
    expect(stops.options.map((o) => o.id)).toEqual(["nonstop", "cheaper_with_stop"]);
    // Server-composed details carry REAL facts: airline, duration, from-price.
    expect(stops.options[0].detail).toContain("Atlas Sandbox");
    expect(stops.options[0].detail).toContain("2h 30m");
    expect(stops.options[0].detail).toContain("nonstop");
    expect(stops.options[0].detail).toContain("from €120");
    expect(stops.options[1].detail).toContain("1 stop");
    expect(stops.options[1].detail).toContain("from €70");

    // The budget cap option's label carries the currency-anchored cheapest
    // price — the anchor deriveConstraintsFromAnswers' regex extracts.
    expect(questions[1].options[0].label).toBe("Keep it under €70");

    // Frozen contract: exactly 2 options each; length-capped composition.
    for (const q of questions) {
      expect(q.options).toHaveLength(2);
      for (const o of q.options) {
        expect(o.label.length).toBeLessThanOrEqual(48);
        expect((o.detail ?? "").length).toBeLessThanOrEqual(96);
      }
    }
  });

  it("a stop candidate CHEAPER than the fare already paid nets a refund — never renders a negative price", () => {
    // The stop routing's fareDifference is a REFUND (the traveller gets
    // money back, not a charge) — `net` is therefore negative internally.
    // Regression for a live bug: the detail string read "from $-43.09".
    const feed = [
      flightCandidate({ id: "D1", amount: 25.96, departure: "2026-08-22T15:30:00Z" }),
      {
        option: {
          id: "S1",
          airline: "VietJet Air",
          departureTime: "2026-08-22T13:00:00Z",
          arrivalTime: "2026-08-22T19:00:00Z",
          stops: 1,
        },
        fareDifference: {
          oldFlightId: "flight-xy123",
          newFlightId: "S1",
          amount: 43.09,
          currency: "USD",
          direction: "refund",
        },
      },
    ];
    const questions = buildPreferenceTradeoffs(feed);
    const stops = questions.find((q) => q.id === "flight-stops")!;
    const withStop = stops.options.find((o) => o.id === "cheaper_with_stop")!;
    expect(withStop.detail).not.toContain("-43.09");
    expect(withStop.detail).not.toContain("$-");
    expect(withStop.detail).toContain("refunds $43.09");
  });

  it("builds the cross-date question when a later day undercuts the same day", () => {
    const feed = [
      flightCandidate({ id: "T1", amount: 110, departure: "2026-08-22T15:30:00Z" }),
      flightCandidate({
        id: "T2",
        amount: 60,
        departure: "2026-08-23T09:30:00Z",
        arrival: "2026-08-23T12:00:00Z",
      }),
    ];
    const questions = buildPreferenceTradeoffs(feed);
    expect(questions[0].id).toBe("flight-day");
    expect(questions[0].options.map((o) => o.id)).toEqual(["same_day", "cheaper_later"]);
    expect(questions[0].options[0].detail).toContain("from €110");
    expect(questions[0].options[1].detail).toContain("from €60");
    expect(questions[0].options[1].detail).toContain("departs 2026-08-23");
  });

  it("slot 1 keeps the flight question that discriminates MORE (fare gap)", () => {
    // Stops gap 140 (200 vs 60) beats the cross-date gap 90 (150 vs 60).
    const stopsWins = buildPreferenceTradeoffs([
      flightCandidate({ id: "D1", amount: 200, departure: "2026-08-22T09:00:00Z" }),
      flightCandidate({ id: "S1", amount: 150, departure: "2026-08-22T11:00:00Z", stops: 1 }),
      flightCandidate({ id: "N1", amount: 60, departure: "2026-08-23T09:00:00Z", stops: 1 }),
    ]);
    expect(stopsWins[0].id).toBe("flight-stops");

    // Flipped: cross-date gap 150 (200 vs 50) beats the stops gap 10
    // (60 vs 50). The later-day CHEAPEST is direct here — a later-day stop
    // would widen the stops gap instead (minStop sees every date).
    const dayWins = buildPreferenceTradeoffs([
      flightCandidate({ id: "D1", amount: 200, departure: "2026-08-22T09:00:00Z" }),
      flightCandidate({ id: "N1", amount: 60, departure: "2026-08-23T09:00:00Z" }),
      flightCandidate({ id: "S1", amount: 50, departure: "2026-08-23T15:00:00Z", stops: 1 }),
    ]);
    expect(dayWins[0].id).toBe("flight-day");
  });

  it("builds the activity-priority keep-X-or-drop-Y question for ≥2 at-risk venues", () => {
    const questions = buildPreferenceTradeoffs([
      flightCandidate({ id: "T1", amount: 110, departure: "2026-08-22T15:30:00Z" }),
      ...TWO_ACTIVITIES,
    ]);
    // Slot 1 has no discriminating flight fact (single candidate) ⇒ the
    // activity question takes the FIRST slot.
    expect(questions.map((q) => q.id)).toEqual(["activity-priority"]);
    const activity = questions[0];
    expect(activity.options.map((o) => o.id)).toEqual([
      "keep_lisbon_oceanarium_ticket",
      "drop_lisbon_oceanarium_ticket",
    ]);
    expect(activity.options[0].label).toBe("Keep Lisbon Oceanarium Ticket");
    expect(activity.options[1].label).toBe("Drop Lisbon Oceanarium Ticket");
    expect(activity.options[1].detail).toContain("we keep Beach Surf Lesson instead");
  });

  it("builds the activity-priority question from MOVE-ONLY proposals via activityName", () => {
    // Task 19: reschedule-only proposals carry no swap replacement — the
    // additive `activityName` field is what makes them nameable.
    const TWO_MOVE_ONLY = [
      {
        activityNodeId: "activity-0-0",
        action: "reschedule",
        newTime: "2026-08-23T10:00:00Z",
        penalty: 0,
        currency: "EUR",
        activityName: "Sintra Palace Walk",
      },
      {
        activityNodeId: "activity-0-1",
        action: "reschedule",
        newTime: "2026-08-23T14:00:00Z",
        penalty: 0,
        currency: "EUR",
        activityName: "Belem Tower Visit",
      },
    ];
    const questions = buildPreferenceTradeoffs([
      flightCandidate({ id: "T1", amount: 110, departure: "2026-08-22T15:30:00Z" }),
      ...TWO_MOVE_ONLY,
      { hotel_name: "Atlantica Surf House", action: "rebook", fee: 0 },
    ]);

    // Frozen contract: ≤2 questions served (pool also had hotel-tradeoff).
    expect(questions.map((q) => q.id)).toEqual(["activity-priority", "hotel-tradeoff"]);
    const activity = questions[0];
    // BOTH venue names surface in the question copy.
    expect(activity.detail).toContain("Sintra Palace Walk");
    expect(activity.detail).toContain("Belem Tower Visit");
    // Option ids keep the keep_<slug>/drop_<slug> shape.
    expect(activity.options.map((o) => o.id)).toEqual([
      "keep_sintra_palace_walk",
      "drop_sintra_palace_walk",
    ]);
    expect(activity.options[0].label).toBe("Keep Sintra Palace Walk");
    expect(activity.options[1].label).toBe("Drop Sintra Palace Walk");
    expect(activity.options[1].detail).toContain("we keep Belem Tower Visit instead");
    // Quiz contract unchanged: ≤2 questions × exactly 2 options.
    expect(questions.length).toBeLessThanOrEqual(2);
    for (const q of questions) expect(q.options).toHaveLength(2);
  });

  it("falls back to candidate.name — and yields no name when nothing is nameable", () => {
    // A proposal with neither swap nor activityName still names itself
    // through the legacy `name` field.
    const namedFallback = buildPreferenceTradeoffs([
      { activityNodeId: "activity-0-0", action: "reschedule", name: "Tram 28 Ride" },
      { activityNodeId: "activity-0-1", action: "reschedule", name: "Fado Night" },
    ]);
    expect(namedFallback.map((q) => q.id)).toEqual(["activity-priority"]);
    expect(namedFallback[0].options.map((o) => o.id)).toEqual([
      "keep_tram_28_ride",
      "drop_tram_28_ride",
    ]);

    // A proposal without activityName, replacementName OR name contributes
    // nothing: only ONE nameable venue remains ⇒ no activity-priority
    // question at all (needs ≥2 names).
    const halfNamed = buildPreferenceTradeoffs([
      { activityNodeId: "activity-0-0", action: "reschedule" },
      { activityNodeId: "activity-0-1", action: "reschedule", name: "Fado Night" },
    ]);
    expect(halfNamed).toEqual([]);
  });

  it("serves the hotel keep/rebook question (and the overbooked variant)", () => {
    const flight = flightCandidate({ id: "T1", amount: 110, departure: "2026-08-22T15:30:00Z" });
    const hotel = [{ hotel_name: "Atlantica Surf House", action: "rebook", fee: 0 }];

    const keep = buildPreferenceTradeoffs([flight, ...hotel]);
    expect(keep.map((q) => q.id)).toEqual(["hotel-tradeoff"]);
    expect(keep[0].options.map((o) => o.id)).toEqual(["keep", "rebook"]);

    const overbooked = buildPreferenceTradeoffs([flight, ...hotel], "en", {
      hotelOverbooked: true,
    });
    expect(overbooked[0].options.map((o) => o.id)).toEqual(["nearby", "best_value"]);
  });

  it("serves the first two priority slots only (flight, activity) on a full feed", () => {
    const questions = buildPreferenceTradeoffs([
      flightCandidate({ id: "D1", amount: 120, departure: "2026-08-22T15:30:00Z" }),
      flightCandidate({ id: "S1", amount: 70, departure: "2026-08-22T13:00:00Z", stops: 1 }),
      ...TWO_ACTIVITIES,
      { hotel_name: "Atlantica Surf House", action: "rebook", fee: 0 },
    ]);
    expect(questions.map((q) => q.id)).toEqual(["flight-stops", "activity-priority"]);
  });

  it("returns [] when nothing discriminates (iOS tolerates zero questions)", () => {
    const questions = buildPreferenceTradeoffs([
      flightCandidate({ id: "T1", amount: 110, departure: "2026-08-22T15:30:00Z" }),
    ]);
    expect(questions).toEqual([]);
  });

  it("localizes the preference strings", () => {
    const feed = [
      flightCandidate({ id: "D1", amount: 120, departure: "2026-08-22T15:30:00Z" }),
      flightCandidate({ id: "S1", amount: 70, departure: "2026-08-22T13:00:00Z", stops: 1 }),
    ];
    const de = buildPreferenceTradeoffs(feed, "de");
    expect(de[0].question).toBe("Direkt fliegen oder mit Zwischenstopp sparen?");
    expect(de[0].options[0].label).toBe("Direktflug");
    expect(de[1].options[0].label).toBe("Unter €70 bleiben");
  });
});

// --------------------------------- W1 sanitizer: flight-number rejection

describe("generateTradeoffQuestions — flight-number rejection (W1 hardening)", () => {
  it("rejects a payload whose option LABEL carries a flight number", async () => {
    const poisoned = JSON.stringify([
      {
        id: "flight-tradeoff",
        question: "Which flight?",
        options: [
          { id: "a", label: "Take TR892 at 09:55" },
          { id: "b", label: "Later option" },
        ],
      },
    ]);
    const agent = agentWith(vi.fn(async () => geminiResponse(poisoned)));
    await expect(agent.generateTradeoffQuestions(CONTEXT)).resolves.toBeNull();
  });

  it("rejects a payload whose option DETAIL carries a flight number", async () => {
    const poisoned = JSON.stringify([
      {
        id: "flight-tradeoff",
        question: "Which flight?",
        options: [
          { id: "a", label: "Option one", detail: "Board XY 456 at gate A3" },
          { id: "b", label: "Option two" },
        ],
      },
    ]);
    const agent = agentWith(vi.fn(async () => geminiResponse(poisoned)));
    await expect(agent.generateTradeoffQuestions(CONTEXT)).resolves.toBeNull();
  });
});

// --------------------------------- W1 constraint branches (preference ids)

describe("deriveConstraintsFromAnswers — W1 preference ids", () => {
  const STOP_QUESTION: TradeoffQuestion = {
    id: "flight-stops",
    question: "Nonstop, or save money with a stop?",
    options: [
      { id: "nonstop", label: "Fly nonstop" },
      { id: "cheaper_with_stop", label: "Take the cheaper routing" },
    ],
  };
  const DAY_QUESTION: TradeoffQuestion = {
    id: "flight-day",
    question: "Travel the same day, or save on a later day?",
    options: [
      { id: "same_day", label: "Fly the same day" },
      { id: "cheaper_later", label: "Save on a later day" },
    ],
  };
  const ACTIVITY_QUESTION: TradeoffQuestion = {
    id: "activity-priority",
    question: "Two activities are at risk — which one do we protect?",
    options: [
      { id: "keep_surf_lesson", label: "Keep Surf Lesson" },
      { id: "drop_surf_lesson", label: "Drop Surf Lesson" },
    ],
  };

  it("nonstop sets prefer_nonstop AND prefer_direct", () => {
    const constraints = deriveConstraintsFromAnswers(
      [STOP_QUESTION],
      [{ question_id: "flight-stops", option_id: "nonstop" }],
    );
    expect(constraints.prefer_nonstop).toBe(true);
    expect(constraints.prefer_direct).toBe(true);
  });

  it("cheaper_with_stop clears both non-stop preferences", () => {
    const constraints = deriveConstraintsFromAnswers(
      [STOP_QUESTION],
      [{ question_id: "flight-stops", option_id: "cheaper_with_stop" }],
    );
    expect(constraints.prefer_nonstop).toBe(false);
    expect(constraints.prefer_direct).toBe(false);
  });

  it("same_day / cheaper_later drive prefer_same_day", () => {
    const same = deriveConstraintsFromAnswers(
      [DAY_QUESTION],
      [{ question_id: "flight-day", option_id: "same_day" }],
    );
    expect(same.prefer_same_day).toBe(true);
    const later = deriveConstraintsFromAnswers(
      [DAY_QUESTION],
      [{ question_id: "flight-day", option_id: "cheaper_later" }],
    );
    expect(later.prefer_same_day).toBe(false);
  });

  it("keep_<slug> records the KEPT activity as activity_priority", () => {
    const constraints = deriveConstraintsFromAnswers(
      [ACTIVITY_QUESTION],
      [{ question_id: "activity-priority", option_id: "keep_surf_lesson" }],
    );
    expect(constraints.activity_priority).toBe("surf lesson");
    // The keep_ branch must NEVER trip the keep_hotel heuristic.
    expect(constraints.keep_hotel).toBeUndefined();
  });

  it("drop_<slug> on a keep_X/drop_X pair records a note (never the wrong priority)", () => {
    // The builder's pair shares ONE slug — the activity the traveler wants
    // kept only exists in the detail text, so the deterministic rail must
    // NOT resolve drop_X into "protect X"; the choice lands in notes.
    const constraints = deriveConstraintsFromAnswers(
      [ACTIVITY_QUESTION],
      [{ question_id: "activity-priority", option_id: "drop_surf_lesson" }],
    );
    expect(constraints.activity_priority).toBeUndefined();
    expect(constraints.notes).toBe("Drop Surf Lesson");
  });

  it("drop_<slug> with a DIFFERENT keep_ sibling resolves to that sibling", () => {
    const pair: TradeoffQuestion = {
      id: "activity-priority",
      question: "Which one do we protect?",
      options: [
        { id: "keep_oceanarium", label: "Keep Oceanarium" },
        { id: "drop_surf_lesson", label: "Drop Surf Lesson" },
      ],
    };
    const constraints = deriveConstraintsFromAnswers(
      [pair],
      [{ question_id: "activity-priority", option_id: "drop_surf_lesson" }],
    );
    expect(constraints.activity_priority).toBe("oceanarium");
  });

  it("budget_cap extracts max_price from the builder's currency-anchored label", () => {
    const budgetQuestion: TradeoffQuestion = {
      id: "budget-cap",
      question: "How strict should we be on price?",
      options: [
        { id: "budget_cap", label: "Keep it under €70" },
        { id: "allow_pricier", label: "Allow pricier options" },
      ],
    };
    const capped = deriveConstraintsFromAnswers(
      [budgetQuestion],
      [{ question_id: "budget-cap", option_id: "budget_cap" }],
    );
    expect(capped.max_price).toBe(70);
    const open = deriveConstraintsFromAnswers(
      [budgetQuestion],
      [{ question_id: "budget-cap", option_id: "allow_pricier" }],
    );
    expect(open.max_price).toBeUndefined();
    expect(open.notes).toBe("Allow pricier options");
  });

  it("round-trips builder output: answering the built budget question caps max_price", () => {
    const feed = [
      flightCandidate({ id: "D1", amount: 120, departure: "2026-08-22T15:30:00Z" }),
      flightCandidate({ id: "S1", amount: 70, departure: "2026-08-22T13:00:00Z", stops: 1 }),
    ];
    const questions = buildPreferenceTradeoffs(feed);
    const constraints = deriveConstraintsFromAnswers(questions, [
      { question_id: "budget-cap", option_id: "budget_cap" },
    ]);
    expect(constraints.max_price).toBe(70);
  });
});

// ------------------------------------------- overload cascade (live defect)

import {
  GEMINI_MODEL_CASCADE,
  modelLadder,
  resetModelCooldowns,
} from "@/agents/geminiCascade";

/**
 * REGRESSION — found live on 2026-08-31 via `wrangler tail`.
 *
 * Google answered `gemini-3.7-flash` with HTTP 503 "this model is currently
 * experiencing high demand". The retry re-asked the SAME saturated model, hit
 * the same wall, and burned the shared 10s deadline — so every real mission
 * degraded to the deterministic derivation while the Activity Stream still
 * showed "Liaison Agent ✓". The retry must go to a different, lighter model.
 */
describe("overloaded primary model — the retry changes model", () => {
  beforeEach(() => resetModelCooldowns());

  const OVERLOADED = () =>
    new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE" } }), {
      status: 503,
      statusText: "Service Unavailable",
    });

  it("a 503 on the primary retries on the lighter fallback model", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      // Primary is saturated; the lighter tier answers.
      if (urls.length === 1) return OVERLOADED();
      return geminiResponse(JSON.stringify({ max_price: 60 }));
    }) as unknown as typeof fetch;

    const agent = new GeminiLiaisonAgent({
      apiKey: "test-key",
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 0,
      model: "primary-model",
    });
    const constraints = await agent.translateAnswersToConstraints(QUESTIONS, []);

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("primary-model");
    // The next rung is the shared ladder's first entry.
    expect(urls[1]).toContain(GEMINI_MODEL_CASCADE[0]);
    // …and the answer comes back from the model path, not the deterministic one.
    expect(constraints.max_price).toBe(60);
  });

  it("a healthy primary is never second-guessed", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return geminiResponse(JSON.stringify({ max_price: 45 }));
    }) as unknown as typeof fetch;

    const agent = new GeminiLiaisonAgent({
      apiKey: "test-key",
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 0,
      model: "primary-model",
    });
    await agent.translateAnswersToConstraints(QUESTIONS, []);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("primary-model");
  });

  /**
   * REGRESSION — found live on 2026-09-01. Many missions carry NO trade-off
   * answers (a weather or activity mission resolves from 0 answers), so the
   * model correctly replies `{}`. Treating that as unusable output logged an
   * error, marked the mission `gemini_degraded`, and made a perfectly healthy
   * model look broken on a third of live missions — burying the real failures.
   */
  it("an empty object is a valid answer, not a degrade", async () => {
    const agent = agentWith(vi.fn(async () => geminiResponse("{}")));
    const constraints = await agent.translateAnswersToConstraints(QUESTIONS, []);
    expect(constraints).toEqual({});
    expect(agent.lastDegradeReason).toBeUndefined();
  });

  it("genuinely unusable output IS still a degrade", async () => {
    // A bare string is not an object: nothing to merge, and the deterministic
    // derivation has to stand in.
    const agent = agentWith(vi.fn(async () => geminiResponse('"not an object"')));
    await agent.translateAnswersToConstraints(QUESTIONS, []);
    expect(agent.lastDegradeReason).toBe("invalid_output");
  });
});

