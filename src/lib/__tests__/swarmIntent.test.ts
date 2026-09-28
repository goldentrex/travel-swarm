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
import { isGroundMission } from "@/core/ground";
import type { TripMissionCategory } from "@/lib/swarmIntent";
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
    expect(parsed.mission.description).toContain("Custom request");
    // NEVER a flight. Branch 2 owns flight problems, so anything reaching the
    // custom gate is not one — and putting a flight node on this rail is what
    // turned "my suitcase didn't arrive" into three rebooking proposals at
    // 2,306,617 IDR against the live Worker on 2026-09-18.
    expect(parsed.mission.nodeId).toBe("transfer-2");
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
    expect(parsed.mission.nodeId).not.toMatch(/^flight-/);
  });

  it("a node id WITH an action passes the gate", () => {
    // A transfer id is the only kind that reaches the gate unscathed:
    // flight-/hotel-/activity-prefixed ids double as branch keywords and
    // would be claimed by branches 2/3/4 first.
    const parsed = parseMissionIntentForTrip("please move transfer-2", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("custom");
  });

  it("a node id with NO action does not", () => {
    // "Look at this" states a target and no intent. Guessing what to do with
    // it is how a sentence the parser did not understand became a plan.
    const parsed = parseMissionIntentForTrip("please look at transfer-2", hydrateFixture());
    expect(parsed).toMatchObject({ kind: "error", status: 400, code: "out_of_scope" });
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
  it("vague chatter is refused, and says what we DO handle", () => {
    const parsed = parseMissionIntentForTrip("something is off", hydrateFixture());
    expect(parsed).toMatchObject({ kind: "error", status: 400, code: "out_of_scope" });
    if (parsed.kind !== "error") return;
    expect(parsed.message).toMatch(/missed or delayed flights/i);
  });

  it("an imperative without a plausible trip target is still rejected", () => {
    // Unlike "Change the hotel", "Change the vibe" misses the target keyword;
    // the custom gate requires BOTH halves of the explicit signal.
    const parsed = parseMissionIntentForTrip("change the vibe", hydrateFixture());
    expect(parsed).toMatchObject({ kind: "error", status: 400, code: "out_of_scope" });
  });

  it("refuses the real sentences that produced confident nonsense", () => {
    // All three were accepted and answered by the deployed Worker on
    // 2026-09-18. The last one proposed three flight rebookings.
    for (const text of [
      "help",
      "what's the wifi password at my hotel",
      "my suitcase didn't arrive",
    ]) {
      expect(parseMissionIntentForTrip(text, hydrateFixture())).toMatchObject({
        kind: "error",
        code: "out_of_scope",
      });
    }
  });
});

// ----------------------------------------------- strike & unwell (WS4)

describe("parseMissionIntentForTrip — strike branch", () => {
  it("targets the transfer reactively, and invents no delay for it", () => {
    const parsed = parseMissionIntentForTrip("trains are on strike in Lisbon", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("strike");
    expect(parsed.mission.origin).toBe("reactive");
    expect(parsed.mission.nodeId).toBe("transfer-2");
    // A strike is not "your transfer is four hours late". Nobody said how
    // late anything is, so nothing is late: the four-hour default belongs to
    // a missed flight and to nothing else.
    expect(parsed.mission.delayMinutes).toBe(0);
  });

  it("honours a delay the traveller actually states", () => {
    const parsed = parseMissionIntentForTrip(
      "trains are on strike in Lisbon, everything is running 2 hours behind",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.delayMinutes).toBe(120);
  });

  it("never answers a local transit strike by delaying a long-haul flight", () => {
    // Live on 2026-09-18, "Transit strike tomorrow" on a trip with no ground
    // transfer landed on Flight SQ 366 SIN → FCO, delayed it four hours, and
    // announced "you are not in town until about 14:20" — moving three
    // activities on a causal link that does not exist.
    const parsed = parseMissionIntentForTrip(
      "Transit strike tomorrow",
      hydrateStayFixture({ withActivity: true }),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.origin).toBe("proactive");
    expect(parsed.mission.delayMinutes).toBe(0);
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

  it("a broken ride to the airport is not read as a cancelled activity", () => {
    // Live on 2026-09-18 this matched the activity branch on the word
    // "cancelled", picked "Kansai Airport Departure & Duty-Free" because the
    // names shared the word "airport", and moved the traveller's duty-free
    // shopping to the next afternoon. They had asked how to reach the airport.
    const parsed = parseMissionIntentForTrip(
      "My taxi to the airport is cancelled, what do I do",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).not.toBe("activity_cancelled");
    // And nothing is declared late: no ride was ever said to be running late.
    expect(parsed.mission.delayMinutes).toBe(0);
  });

  it("targets the ground leg itself when the trip has one", () => {
    // So the ground rail answers about the journey that actually broke,
    // rather than about whatever is next on the calendar.
    const parsed = parseMissionIntentForTrip("my transfer never showed up", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toMatch(/^transfer-/);
    expect(parsed.mission.delayMinutes).toBe(0);
    // Short and derived, never the traveller's own sentence: this string is
    // the approval sheet's heading, and at accessibility text size the echoed
    // question filled six bold lines and pushed the answer off the screen.
    expect(parsed.mission.description).toBe("Your ride is gone");
    // And it still passes its OWN gate — every check downstream reads it.
    expect(isGroundMission(parsed.mission.description)).toBe(true);
  });

  it("leaves strikes to the strike branch, which carries their evidence", () => {
    const parsed = parseMissionIntentForTrip("trains are on strike in Lisbon", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("strike");
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

// ------------------------------------------ explicit-node branch (scenario tiles)

/**
 * REGRESSION — the scenario tiles ("Missed flight", "Hotel overbooked",
 * "Activity cancelled", …) ALL send an explicit nodeId. That branch used to
 * hardcode `kind: weather ? "weather" : "delay"` for every non-weather
 * mission, discarding the actual category regardless of which tile launched
 * it or what the intent text said. Every category-gated behaviour downstream
 * — `allowsActivityDrops`, `hotelOverbooked`, the orchestrator's own
 * cancellation detection — silently degraded to the generic path. Live
 * symptom: "Activity cancelled — Lau Pa Sat" produced a plan that never
 * mentioned Lau Pa Sat at all, only an unrelated downstream sibling.
 */
describe("parseMissionIntentForTrip — explicit-node branch classifies like the keyword branches", () => {
  it('an explicit activity node + "cancelled" in the intent → activity_cancelled, not delay', () => {
    const parsed = parseMissionIntentForTrip(
      "Change my activity cancelled Ocean Museum Visit",
      hydrateFixture(),
      "activity-1-0",
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("activity-1-0");
    expect(parsed.mission.kind).toBe("activity_cancelled");
    // The orchestrator's own classifier text-sniffs the description for
    // "cancel" — the generic "Change requested — X" wording never carried
    // that signal, so the disrupted node's own resolution was silently
    // skipped even once `category` was fixed.
    expect(parsed.mission.description).toMatch(/cancel/i);
  });

  it("an explicit activity node WITHOUT cancel wording stays delay (no false positive)", () => {
    const parsed = parseMissionIntentForTrip(
      "Change my day plan around Ocean Museum Visit",
      hydrateFixture(),
      "activity-1-0",
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("delay");
  });

  it('an explicit hotel node + "overbooked" → hotel_overbooked, not the generic hotel category', () => {
    const parsed = parseMissionIntentForTrip(
      "Change my hotel overbooked Atlantica Surf House",
      hydrateFixture(),
      "hotel-0-1",
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("hotel-0-1");
    expect(parsed.mission.kind).toBe("hotel_overbooked");
  });

  it('an explicit flight node + "missed" → missed_flight, not the generic delay category', () => {
    const parsed = parseMissionIntentForTrip(
      "Change my missed flight TP437",
      hydrateFixture(),
      "flight-0",
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("flight-0");
    expect(parsed.mission.kind).toBe("missed_flight");
  });

  it("an explicit flight node with a plain delay stays delay", () => {
    const parsed = parseMissionIntentForTrip(
      "Change my delayed flight TP437 by 3 hours",
      hydrateFixture(),
      "flight-0",
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("delay");
  });

  it("an explicit node still wins over keyword re-targeting — the node is never re-picked", () => {
    // The intent text names the OTHER activity, but the explicit nodeId
    // must still be the one actually targeted.
    const parsed = parseMissionIntentForTrip(
      "Change my activity cancelled Surf Lesson", // names activity-0-0
      hydrateFixture(),
      "activity-1-0", // but the UI picker explicitly chose this one
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("activity-1-0");
    expect(parsed.mission.kind).toBe("activity_cancelled");
  });

  it("weather still short-circuits to the proactive weather category regardless of node kind", () => {
    const parsed = parseMissionIntentForTrip(
      "Storm warning for the surf lesson",
      hydrateFixture(),
      "activity-0-0",
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("weather");
    expect(parsed.mission.origin).toBe("proactive");
    expect(parsed.mission.delayMinutes).toBe(0);
  });
});


describe("a mission heading is short enough to leave room for the plan", () => {
  // It becomes the approval sheet's heading. Photographed at accessibility
  // text size on 2026-09-18, the traveller's own sentence appended to it
  // filled six bold lines and pushed the plan entirely below the fold.
  const LONG = "my hotel is overbooked and honestly this whole trip is going wrong, what do I do now";

  it("never echoes the traveller's sentence back at them", () => {
    for (const text of [
      LONG,
      "heavy rain forecast tomorrow, adapt my outdoor plans please",
      "my activity got cancelled, the tour operator just called me",
      "there is a transit strike tomorrow across the whole city",
      "I'm feeling unwell, lighten my day if you can",
    ]) {
      const parsed = parseMissionIntentForTrip(text, hydrateFixture());
      if (parsed.kind !== "mission") continue;
      expect(parsed.mission.description.length).toBeLessThan(70);
      expect(parsed.mission.description).not.toContain("what do I do");
    }
  });

  it("keeps the words the pipeline itself reads", () => {
    // The orchestrator sniffs `/overbook/i` to know the room is gone, and
    // `classifyDisruptionKind` reads the heading for a cancellation. A
    // shorter heading that drops them silently breaks both.
    const overbooked = parseMissionIntentForTrip(LONG, hydrateFixture());
    expect(overbooked.kind).toBe("mission");
    if (overbooked.kind !== "mission") return;
    expect(overbooked.mission.description).toMatch(/overbook/i);
    expect(overbooked.mission.kind).toBe("hotel_overbooked");

    const cancelled = parseMissionIntentForTrip("my activity got cancelled", hydrateFixture());
    if (cancelled.kind !== "mission") return;
    expect(cancelled.mission.description).toMatch(/cancel/i);
  });
});

describe("the five languages the app actually ships", () => {
  // Measured against the deployed Worker on 2026-09-18: six of nine French,
  // Spanish and German sentences were refused outright, four of them for
  // problems the swarm handles perfectly well. Only the flight branch had
  // ever been translated.
  const CASES: Array<[string, TripMissionCategory]> = [
    ["mon hôtel est surbooké", "hotel_overbooked"],
    ["mi hotel está sobrevendido", "hotel_overbooked"],
    ["mein Hotel ist überbucht", "hotel_overbooked"],
    ["mon activité a été annulée", "activity_cancelled"],
    ["mi actividad ha sido cancelada", "activity_cancelled"],
    ["il y a une grève des transports demain", "strike"],
    ["hay huelga de transporte mañana", "strike"],
    ["es gibt morgen einen Streik", "strike"],
    ["je ne me sens pas bien, allège ma journée", "unwell"],
    ["me siento enfermo, aligera mi día", "unwell"],
    ["ich bin krank, entlaste meinen Tag", "unwell"],
    ["il va pleuvoir demain, adapte mes plans", "weather"],
    ["va a llover mañana", "weather"],
    ["es wird morgen regnen", "weather"],
  ];

  for (const [text, expected] of CASES) {
    it(`"${text}" → ${expected}`, () => {
      const parsed = parseMissionIntentForTrip(text, hydrateFixture());
      expect(parsed.kind).toBe("mission");
      if (parsed.kind !== "mission") return;
      expect(parsed.mission.kind).toBe(expected);
    });
  }

  it("an overbooking in any language still carries the marker the engine reads", () => {
    // The orchestrator sniffs `/overbook/i` on the DESCRIPTION to know the
    // room is gone. A localised heading that dropped it would silently turn
    // every non-English overbooking back into a late check-in.
    for (const text of [
      "mon hôtel est surbooké",
      "mi hotel está sobrevendido",
      "mein Hotel ist überbucht",
    ]) {
      const parsed = parseMissionIntentForTrip(text, hydrateFixture());
      if (parsed.kind !== "mission") throw new Error(`${text} was refused`);
      expect(parsed.mission.description).toMatch(/overbook/i);
    }
  });
});

describe("an airline schedule change is a stated fact, not a default", () => {
  // Verified on the deployed Worker on 2026-09-18: "the airline moved my
  // flight to 6am, that's impossible" produced "Delayed flight SQ634" with a
  // four-hour delay nobody had mentioned, and cancelled three activities off
  // the back of it. The airline had given a time; we invented another.

  it("uses the stated time when the flight moved LATER", () => {
    const parsed = parseMissionIntentForTrip(
      "the airline rescheduled my flight to 18:40",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    // Never the 240-minute default: the shift is booked-vs-stated arithmetic.
    expect(parsed.mission.delayMinutes).not.toBe(240);
    expect(parsed.mission.delayMinutes).toBeGreaterThan(0);
    expect(parsed.mission.description).toMatch(/moved later/i);
  });

  it("refuses honestly when the flight moved EARLIER", () => {
    // `ItineraryGraph.handleDisruption` throws on a negative delay: the whole
    // propagation model is "things move later", and what an earlier departure
    // breaks is everything BEFORE it. That is a different algorithm, not a
    // missing branch — so we say so instead of inventing a delay.
    const parsed = parseMissionIntentForTrip(
      "the airline moved my flight to 6am, that's impossible",
      hydrateFixture(),
    );
    expect(parsed).toMatchObject({ kind: "error", code: "earlier_departure_unsupported" });
    if (parsed.kind !== "error") return;
    expect(parsed.message).toMatch(/earlier/i);
  });

  it("leaves an ordinary missed flight on its own rail", () => {
    // No time stated, no schedule-change wording: the four-hour stand-in for
    // "I need the next departure" is still exactly right here.
    const parsed = parseMissionIntentForTrip("I missed my flight, reroute me", hydrateFixture());
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.kind).toBe("missed_flight");
    expect(parsed.mission.delayMinutes).toBe(240);
  });

  it("does not read a bare number as a time", () => {
    // "moved to gate 12" is not 12 o'clock.
    const parsed = parseMissionIntentForTrip("my flight moved to gate 12", hydrateFixture());
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.description).not.toMatch(/moved later/i);
  });
});
