/**
 * swarmIntent — custom free-text parser contract tests (task #15 follow-up).
 *
 * Locks down the routing rules the iOS E2E custom-mission tests depend on:
 *   - the two committed E2E phrases must resolve to the `custom` branch,
 *   - activity/hotel vocabulary must NEVER fall through to custom,
 *   - vague chatter must yield the 400 invalid_intent descriptor.
 *
 * The fixture mirrors swarmTripContext.test.ts (same hydration rules:
 * flight-0/flight-1, hotel-0-1, activity-<day>-<item>) so node ids are the
 * ones a real hydrated trip would produce.
 */

import { describe, expect, it } from "vitest";
import { hydrateTripFromContent } from "../swarmTripContext";
import { parseMissionIntentForTrip } from "../swarmIntent";

// ----------------------------------------------------------------- fixture

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tomorrow at 00:00 UTC — keeps every "upcoming" assertion in the future. */
const day1Start = (() => {
  const d = new Date(Date.now() + DAY_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
})();
const day2Start = day1Start + DAY_MS;

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const day1Date = isoDate(day1Start);
const day2Date = isoDate(day2Start);
const at = (dayStartMs: number, hh: number, mm: number) =>
  new Date(dayStartMs + hh * 3_600_000 + mm * 60_000).toISOString();

/** 2 flights (inbound + outbound), 1 hotel, 2 activities (one outdoor). */
function buildFixtureContent() {
  return {
    title: { en: "Lisbon Surf Week" },
    destination: { en: "Lisbon" },
    local_currency_code: "EUR",
    transit_groups: [
      {
        id: "tg0",
        method: "flight",
        origin: { code: "CDG", city: "Paris" },
        destination: { code: "LIS", city: "Lisbon" },
        carrier: "TAP Air Portugal",
        reference: "TP437",
        depart: at(day1Start, 9, 0),
        arrive: at(day1Start, 11, 30),
      },
      {
        id: "tg1",
        method: "flight",
        origin: { code: "LIS", city: "Lisbon" },
        destination: { code: "CDG", city: "Paris" },
        carrier: "TAP Air Portugal",
        reference: "TP438",
        depart: at(day1Start + 4 * DAY_MS, 18, 0),
        arrive: at(day1Start + 4 * DAY_MS, 21, 0),
      },
      {
        id: "tg2",
        method: "taxi",
        origin: { city: "Lisbon" },
        destination: { city: "Costa da Caparica" },
        depart: at(day1Start, 12, 0),
        durationHrs: 0.5,
      },
    ],
    itinerary: [
      {
        day: 1,
        date: day1Date,
        place: "Lisbon",
        items: [
          { type: "activity", title: "Surf Lesson", time: "13:30" },
          { type: "stay", title: "Atlantica Surf House", check_in: day1Date },
        ],
      },
      {
        day: 2,
        date: day2Date,
        place: "Lisbon",
        items: [{ type: "activity", title: "Ocean Museum Visit", time: "10:00" }],
      },
    ],
  };
}

function hydrateFixture() {
  const hydrated = hydrateTripFromContent(
    "11111111-2222-3333-4444-555555555555",
    "Lisbon Surf Week",
    "Lisbon",
    buildFixtureContent(),
  );
  expect(hydrated).not.toBeNull();
  return hydrated!;
}

/** No-transit twin of the fixture: 1 hotel + (optionally) 1 activity,
 *  zero transit_groups — exercises the strike/unwell no-transit paths. */
function hydrateStayFixture(opts: { withActivity: boolean }) {
  const content = buildFixtureContent();
  const stayOnly: typeof content = {
    ...content,
    transit_groups: [],
    itinerary: [
      {
        day: 1,
        date: day1Date,
        place: "Lisbon",
        items: [
          ...(opts.withActivity ? [{ type: "activity", title: "Surf Lesson", time: "13:30" }] : []),
          { type: "stay", title: "Atlantica Surf House", check_in: day1Date },
        ],
      },
    ],
  };
  const hydrated = hydrateTripFromContent(
    "11111111-2222-3333-4444-555555555555",
    "Lisbon Surf Week",
    "Lisbon",
    stayOnly,
  );
  expect(hydrated).not.toBeNull();
  return hydrated!;
}

// ------------------------------------------- custom branch (E2E phrases)

describe("parseMissionIntentForTrip — custom free-text branch", () => {
  it("committed E2E phrase #1: imperative + transfer target → custom", () => {
    // GlobePlannerUITests custom-mission phrase: no flight/hotel/activity/
    // weather/strike/unwell keyword may fire before the custom gate.
    const parsed = parseMissionIntentForTrip(
      "Reschedule the taxi ride to the surf spot to the next morning",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("custom");
    expect(parsed.mission.origin).toBe("reactive");
    expect(parsed.mission.description).toContain("Custom request for");
    // The custom fallback targets the first UPCOMING node of the trip
    // (tomorrow's inbound flight in this fixture).
    expect(parsed.mission.nodeId).toBe("flight-0");
  });

  it('committed E2E phrase #2: "Custom request:" prefix → custom', () => {
    const parsed = parseMissionIntentForTrip(
      "Custom request: drop the museum visit and free up the afternoon",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("custom");
    expect(parsed.mission.origin).toBe("reactive");
    expect(parsed.mission.nodeId).toBe("flight-0");
  });

  it("a literal node id in the text also triggers the custom gate", () => {
    // A transfer id is the only kind that reaches the gate unscathed:
    // flight-/hotel-/activity-prefixed ids double as branch keywords and
    // would be claimed by branches 2/3/4 first.
    const parsed = parseMissionIntentForTrip("please look at transfer-2", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("custom");
  });
});

// ------------------------------------------------------------ rerouting guards

describe("parseMissionIntentForTrip — keyword branches beat the custom gate", () => {
  it('"Cancel the museum visit" routes to the ACTIVITY branch, not custom', () => {
    const parsed = parseMissionIntentForTrip("Cancel the museum visit", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("activity_cancelled");
    // Name-matched activity: the museum, not the surf lesson.
    expect(parsed.mission.nodeId).toBe("activity-1-0");
  });

  it('hotel vocabulary ("My hotel is overbooked") routes to the HOTEL branch, tagged overbooked', () => {
    const parsed = parseMissionIntentForTrip("My hotel is overbooked", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    // Was asserting "hotel" — the ternary that was supposed to set this ONLY
    // ever produced "hotel" on both branches (a dead ternary bug), so this
    // test had locked the bug in as expected behavior. "overbook*" in the
    // intent text must reach the "hotel_overbooked" category: there is no
    // existing booking left to "keep" once the property has walked you.
    expect(parsed.mission.kind).toBe("hotel_overbooked");
    expect(parsed.mission.nodeId).toBe("hotel-0-1");
  });

  it("imperative + hotel target still lands on the hotel branch (branch 3 < gate 7)", () => {
    const parsed = parseMissionIntentForTrip(
      "please reschedule my hotel check-in",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("hotel");
    expect(parsed.mission.nodeId).toBe("hotel-0-1");
  });

  it("weather vocabulary wins over imperative custom phrasing", () => {
    const parsed = parseMissionIntentForTrip(
      "reschedule everything, the storm forecast is terrible",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("weather");
    expect(parsed.mission.origin).toBe("proactive");
  });
});

// --------------------------------------------------------------- vague text

describe("a missed flight is recognised in the languages the app ships", () => {
  // The scenario tiles send canonical English, so this went unnoticed: the
  // classifier tested only /miss(ed|ing)/, and a French traveller typing
  // "j'ai loupé mon vol" was filed as a DELAY. That is not a cosmetic
  // mislabel — `missed_flight` is what gates the missed-flight trade-off
  // questions ("how soon can you be at the airport?"), so the traveller who
  // most needed to be asked was silently not asked.
  //
  // The app ships en/fr/es/de/zh-Hans; so does this.

  const cases: Array<[string, string]> = [
    ["en", "I missed my flight, reroute me"],
    ["fr", "J'ai loupé mon vol, trouve-moi autre chose"],
    ["fr", "J'ai raté mon vol"],
    ["es", "Perdí mi vuelo"],
    ["de", "Ich habe meinen Flug verpasst"],
    ["zh", "我错过了航班"],
  ];

  for (const [lang, text] of cases) {
    it(`${lang}: "${text}" is a missed flight, not a delay`, () => {
      const parsed = parseMissionIntentForTrip(text, hydrateFixture());
      expect(parsed.kind).toBe("mission");
      if (parsed.kind !== "mission") return;
      expect(parsed.mission.kind).toBe("missed_flight");
    });
  }

  it("a genuine DELAY is still a delay — the widening must not swallow it", () => {
    const parsed = parseMissionIntentForTrip("My flight is delayed by 4 hours", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("delay");
  });
});

describe("parseMissionIntentForTrip — vague text is rejected", () => {
  it("vague chatter yields custom fallback", () => {
    const parsed = parseMissionIntentForTrip("something is off", hydrateFixture());
    expect(parsed).toMatchObject({
      kind: "mission",
      mission: {
        kind: "custom",
      },
    });
  });

  it("an imperative without a plausible trip target is still rejected", () => {
    // Unlike "Change the hotel", "Change the vibe" misses the target keyword;
    // the custom gate requires BOTH halves of the explicit signal.
    const parsed = parseMissionIntentForTrip("change the vibe", hydrateFixture());
    expect(parsed).toMatchObject({ kind: "mission", mission: { kind: "custom" } });
  });
});

// ----------------------------------------------- strike & unwell (WS4)

describe("parseMissionIntentForTrip — strike branch", () => {
  it("keeps reactive transfer targeting (with the parsed delay) when a transfer exists", () => {
    const parsed = parseMissionIntentForTrip("trains are on strike in Lisbon", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("strike");
    expect(parsed.mission.origin).toBe("reactive");
    expect(parsed.mission.nodeId).toBe("transfer-2");
    expect(parsed.mission.delayMinutes).toBe(240); // default, unchanged
  });

  it("targets the first upcoming activity (proactive user_report, delay 0) when no transit node exists", () => {
    const parsed = parseMissionIntentForTrip(
      "there is a strike tomorrow",
      hydrateStayFixture({ withActivity: true }),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("strike");
    expect(parsed.mission.nodeId).toBe("activity-0-0");
    expect(parsed.mission.origin).toBe("proactive");
    expect(parsed.mission.delayMinutes).toBe(0);
    expect(parsed.mission.evidence?.kind).toBe("user_report");
    expect(parsed.mission.evidence?.detail).toBe("transit_strike");
  });

  it("yields 400 no_actionable_nodes when neither transit nor activity nodes exist (hotels are never strike fallbacks)", () => {
    // The orchestrator only synthesizes rescheduling requests for activity
    // nodes, so a hotel target would produce zero proposals — the branch
    // must refuse instead (same shape as the unwell no-activities rail).
    const parsed = parseMissionIntentForTrip(
      "there is a strike tomorrow",
      hydrateStayFixture({ withActivity: false }),
    );
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.status).toBe(400);
    expect(parsed.code).toBe("no_actionable_nodes");
  });
});

describe("parseMissionIntentForTrip — unwell branch", () => {
  it("yields 400 no_actionable_nodes when the trip has zero activities", () => {
    const parsed = parseMissionIntentForTrip(
      "feeling unwell, please lighten my schedule",
      hydrateStayFixture({ withActivity: false }),
    );
    expect(parsed).toMatchObject({
      kind: "error",
      status: 400,
      code: "no_actionable_nodes",
    });
  });

  it("never falls through to the greedy custom branch on a zero-activity trip", () => {
    const parsed = parseMissionIntentForTrip(
      "I am exhausted, lighten things up",
      hydrateStayFixture({ withActivity: false }),
    );
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.code).toBe("no_actionable_nodes");
  });
});

// ------------------------------- flight-less trips keep their other branches

describe("parseMissionIntentForTrip — a flight-less trip is not a flight problem", () => {
  // REGRESSION. `FLIGHT_INTENT_PATTERN` is deliberately broad ("I'm delayed"
  // must target the right flight on a trip that HAS flights), but the
  // no-flights branch short-circuited on that same broad pattern. So on a
  // rail/stay-only trip, any mission containing "delay" or "miss" was answered
  // "This trip has no flights to reroute" — confidently wrong, and it hid the
  // hotel / strike / unwell / custom branches that actually applied.

  it("an overbooked hotel is still a hotel mission when the wording says 'miss'", () => {
    const parsed = parseMissionIntentForTrip(
      "The hotel is overbooked and I will miss check-in tonight",
      hydrateStayFixture({ withActivity: false }),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind === "mission") {
      expect(parsed.mission.kind).toBe("hotel_overbooked");
    }
  });

  it("a strike that 'delayed' everything is not answered with 'no flights to reroute'", () => {
    const parsed = parseMissionIntentForTrip(
      "A transport strike delayed everything today",
      hydrateStayFixture({ withActivity: true }),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind === "mission") {
      expect(parsed.mission.kind).not.toBe("delay");
    }
  });

  it("still answers honestly when the mission really does name a flight", () => {
    const parsed = parseMissionIntentForTrip(
      "My flight is delayed by 3 hours",
      hydrateStayFixture({ withActivity: false }),
    );
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") {
      expect(parsed.status).toBe(404);
      expect(parsed.code).toBe("unknown_flight");
    }
  });

  it("a bare flight number on a flight-less trip is still an honest 404", () => {
    const parsed = parseMissionIntentForTrip(
      "TP437 is cancelled",
      hydrateStayFixture({ withActivity: false }),
    );
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") expect(parsed.code).toBe("unknown_flight");
  });

  /**
   * REGRESSION — caught by the 49-mission live run. Narrowing the 404 to
   * "air-travel vocabulary" was right, but the branch is also reached when the
   * trip HAS flights and the wording simply is not a flight intent. Testing the
   * vocabulary alone then answered "this trip has no flights to reroute" to a
   * traveler whose TAXI was cancelled, on a trip with two flights.
   */
  it("a cancelled taxi to the airport is not a flight mission, on a trip WITH flights", () => {
    const parsed = parseMissionIntentForTrip(
      "My taxi to the airport is cancelled, what do I do",
      hydrateFixture(),
    );
    expect(parsed.kind).not.toBe("error");
    if (parsed.kind === "error") return;
    expect(parsed.mission.kind).not.toBe("delay");
  });

  it("a spaced designator (AF 007 / SQ 635) targets its own leg", () => {
    // Real trip content writes both "VY6215" and "AF 007"; only the unspaced
    // form used to match, so most legs could not be named or targeted.
    const parsed = parseMissionIntentForTrip("TP 437 is cancelled", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind === "mission") {
      expect(parsed.mission.nodeId).toBe("flight-0");
      expect(parsed.mission.description).toContain("TP437");
    }
  });
});

