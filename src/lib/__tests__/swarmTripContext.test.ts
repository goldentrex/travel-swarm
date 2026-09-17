/**
 * swarmTripContext + swarmIntent — hydration, mission targeting and
 * settlement rewrite tests (Task #12 backend). Node env, no network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolutionPlan } from "@/agents";

// ------------------------------------------------ fake trips-table backend
// Same seam pattern as swarmSessionStore.test.ts: only the lazy admin client
// is replaced — a chainable builder whose maybeSingle outcome is scripted.

vi.mock("@/integrations/supabase/client.server", () => {
  let row: Record<string, unknown> | null = null;
  let queryError: { message: string } | null = null;
  let throwOnAccess = false;

  function makeBuilder(): unknown {
    let updatePatch: Record<string, unknown> | null = null;
    const eqFilters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select(_cols?: string) {
        if (updatePatch !== null) {
          // CAS write terminal: the RETURNING clause runs AFTER the rev-bump
          // trigger, so the caller sees the POST-WRITE rev (mirrors prod).
          if (queryError) return Promise.resolve({ data: null, error: queryError });
          if (
            row &&
            typeof row.content_rev === "number" &&
            eqFilters.content_rev === row.content_rev
          ) {
            // Mirror the migration trigger: content_rev only bumps when the
            // patch ACTUALLY differs from the stored row — an idempotent
            // re-write (identical content_json) matches the row but leaves
            // the rev untouched.
            const unchanged =
              JSON.stringify(row.content_json) === JSON.stringify(updatePatch.content_json);
            row.content_json = updatePatch.content_json;
            if (!unchanged) row.content_rev = row.content_rev + 1;
            return Promise.resolve({
              data: [{ content_rev: row.content_rev }],
              error: null,
            });
          }
          // Rev mismatch (or missing row) ⇒ 0 rows updated ⇒ CAS failure.
          return Promise.resolve({ data: [], error: null });
        }
        return builder;
      },
      eq(col: string, value: unknown) {
        eqFilters[col] = value;
        return builder;
      },
      // Soft-delete filter (`loadSwarmTrip` appends `.is("deleted_at", null)`):
      // the fake trips table has no deleted rows, so the filter is a no-op
      // that simply keeps the chain fluent.
      is(_col: string, _value: unknown) {
        return builder;
      },
      update(patch: Record<string, unknown>) {
        updatePatch = patch;
        return builder;
      },
      maybeSingle() {
        if (queryError) return Promise.resolve({ data: null, error: queryError });
        return Promise.resolve({ data: row, error: null });
      },
    };
    return builder;
  }

  const admin = {
    get from() {
      if (throwOnAccess) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY missing");
      return () => makeBuilder();
    },
  };

  return {
    supabaseAdmin: admin,
    __setRow(value: Record<string, unknown> | null): void {
      row = value;
    },
    __setQueryError(error: { message: string } | null): void {
      queryError = error;
    },
    __setThrowOnAccess(value: boolean): void {
      throwOnAccess = value;
    },
    __clear(): void {
      row = null;
      queryError = null;
      throwOnAccess = false;
    },
  };
});

import * as serverModule from "@/integrations/supabase/client.server";
import {
  applySettlementToContent,
  hydrateTripFromContent,
  loadSwarmTrip,
  settlePlanOnTrip,
  toLegStamp,
} from "../swarmTripContext";
import { parseMissionIntentForTrip } from "../swarmIntent";

const tripDbHooks = serverModule as unknown as {
  __setRow(value: Record<string, unknown> | null): void;
  __setQueryError(error: { message: string } | null): void;
  __setThrowOnAccess(value: boolean): void;
  __clear(): void;
};

// ----------------------------------------------------------------- fixture

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tomorrow at 00:00 UTC — keeps every timing assertion in the future. */
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

function basePlan(): ResolutionPlan {
  return {
    incident: "Flight TP437 delayed by 4h",
    impacted_nodes: [],
    proposed_resolution: {
      new_flight: { id: "ATL-SANDBOX-1", cost: 120 },
      rescheduled_activities: [],
    },
    financial_delta: { total_refund: 0, total_new_charges: 120, net_payable: 120 },
    requires_human_approval: true,
  };
}

// --------------------------------------------------------------- hydration

describe("hydrateTripFromContent", () => {
  it("maps flights, hotel and activities to typed nodes with correct times", () => {
    const hydrated = hydrateFixture();
    const flight = hydrated.graph.getNode("flight-0");
    expect(flight?.type).toBe("flight");
    if (flight?.type === "flight") {
      expect(flight.flightNumber).toBe("TP437");
      expect(flight.origin).toBe("CDG");
      expect(flight.destination).toBe("LIS");
      expect(flight.departureTime).toBe(Date.parse(at(day1Start, 9, 0)));
      expect(flight.arrivalTime).toBe(Date.parse(at(day1Start, 11, 30)));
    }

    const activity = hydrated.graph.getNode("activity-0-0");
    expect(activity?.type).toBe("activity");
    expect(activity?.scheduledTime).toBe(Date.parse(at(day1Start, 13, 30)));

    const hotel = hydrated.graph.getNode("hotel-0-1");
    expect(hotel?.type).toBe("hotel_check_in");
    if (hotel?.type === "hotel_check_in") {
      expect(hotel.hotelName).toBe("Atlantica Surf House");
    }
    expect(hotel?.scheduledTime).toBe(Date.parse(`${day1Date}T15:00:00Z`));

    // nodeRefs carry the content_json provenance.
    expect(hydrated.nodeRefs["flight-0"]).toMatchObject({ kind: "flight", transitIndex: 0 });
    expect(hydrated.nodeRefs["hotel-0-1"]).toMatchObject({
      kind: "hotel",
      dayIndex: 0,
      itemIndex: 1,
    });
    expect(hydrated.nodeRefs["activity-1-0"]).toMatchObject({
      kind: "activity",
      dayIndex: 1,
      itemIndex: 0,
    });
    expect(hydrated.meta.currency).toBe("EUR");
    expect(hydrated.meta.city).toBe("Lisbon");
  });

  it("hydrates a stay's explicit time over the default check-in hour", () => {
    // Task 19: the stay's own `time` component outranks the conventional
    // 15:00Z default — same helper activities use, so settlement-written
    // times re-hydrate idempotently.
    const content = buildFixtureContent();
    (content.itinerary[0].items[1] as Record<string, unknown>).time = "16:30";
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content);
    expect(hydrated).not.toBeNull();
    const hotel = hydrated!.graph.getNode("hotel-0-1");
    expect(hotel?.type).toBe("hotel_check_in");
    expect(hotel?.scheduledTime).toBe(Date.parse(`${day1Date}T16:30:00Z`));
    expect(hydrated!.nodeRefs["hotel-0-1"].time).toBe(Date.parse(`${day1Date}T16:30:00Z`));
  });

  it("keeps the 15:00Z default when the stay time is missing or unparseable", () => {
    const defaultTime = Date.parse(`${day1Date}T15:00:00Z`);
    // Missing time is covered by the fixture test above; an UNPARSEABLE
    // time string must degrade to the same default, never to NaN or 00:00.
    const content = buildFixtureContent();
    (content.itinerary[0].items[1] as Record<string, unknown>).time = "sometime in the afternoon";
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.graph.getNode("hotel-0-1")?.scheduledTime).toBe(defaultTime);
  });

  it("builds the chronological day chain + arriving-flight dependency", () => {
    const hydrated = hydrateFixture();
    // Day 1: surf lesson (13:30) before hotel check-in (15:00).
    const activity = hydrated.graph.getNode("activity-0-0");
    const hotel = hydrated.graph.getNode("hotel-0-1");
    // The day's FIRST node depends on the flight arriving that day.
    expect(activity?.dependsOn).toContain("flight-0");
    expect(hotel?.dependsOn).toEqual(["activity-0-0"]);
  });

  it("skips malformed legs and rejects empty content", () => {
    expect(hydrateTripFromContent("t", "", "", {})).toBeNull();
    expect(hydrateTripFromContent("t", "", "", null)).toBeNull();
    const malformed = {
      transit_groups: [
        { id: "x", method: "flight", reference: "AF1", depart: "not-a-date", arrive: "nope" },
      ],
      itinerary: [{ day: 1, date: "garbage", items: [{ type: "activity", title: "X" }] }],
    };
    expect(hydrateTripFromContent("t", "", "", malformed)).toBeNull();
  });

  /** Fixture content whose FIRST transit leg carries extra booking facts. */
  function contentWithLeg0(extra: Record<string, unknown>): Record<string, unknown> {
    const content = buildFixtureContent();
    return {
      ...content,
      transit_groups: [{ ...content.transit_groups[0], ...extra }, content.transit_groups[1]],
    };
  }

  function leg0Of(hydrated: ReturnType<typeof hydrateTripFromContent>) {
    const flight = hydrated?.graph.getNode("flight-0");
    expect(flight?.type).toBe("flight");
    return flight?.type === "flight" ? flight : null;
  }

  it("carries the leg price as booking-fact fare and the leg's pax count", () => {
    const hydrated = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({
        booked: true,
        price: { amount: 340, currency: "EUR" },
        travelers: [{ name: "A" }, { name: "B" }],
      }),
    );
    const flight = leg0Of(hydrated);
    expect(flight?.fare).toEqual({ amount: 340, currency: "EUR" });
    expect(flight?.travelers).toBe(2);
  });

  it("lets a recorded payment override the plan price", () => {
    const hydrated = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({
        price: { amount: 340, currency: "EUR" },
        paid: true,
        paid_amount: 37500,
        paid_currency: "JPY",
      }),
    );
    expect(leg0Of(hydrated)?.fare).toEqual({ amount: 37500, currency: "JPY" });
  });

  it("falls back to the root party size when the leg names no travelers", () => {
    const content = {
      ...buildFixtureContent(),
      travelers: [
        { id: "A", name: "A", origin: "Paris" },
        { id: "B", name: "B", origin: "Paris" },
        { id: "C", name: "C", origin: "Paris" },
      ],
    };
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content);
    expect(leg0Of(hydrated)?.travelers).toBe(3);

    // No travelers anywhere ⇒ the field is omitted entirely (never 0).
    const bareFlight = leg0Of(hydrateTripFromContent("t", "", "Lisbon", buildFixtureContent()));
    expect(bareFlight?.travelers).toBeUndefined();
    expect(bareFlight?.fare).toBeUndefined();
  });

  it("omits the fare when the price is absent or malformed", () => {
    const variants: Record<string, unknown>[] = [
      { booked: true }, // no price at all
      { booked: true, price: { amount: "cheap", currency: "EUR" } }, // non-numeric amount
      { booked: true, price: { amount: 120, currency: "  " } }, // blank currency
      { booked: true, price: null }, // null price
    ];
    for (const extra of variants) {
      const hydrated = hydrateTripFromContent("t", "", "Lisbon", contentWithLeg0(extra));
      expect(leg0Of(hydrated)?.fare).toBeUndefined();
    }

    // paid override needs ALL of paid + POSITIVE paid_amount + paid_currency;
    // an incomplete payment record falls back to the plan price instead.
    const hydrated = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({
        booked: true,
        price: { amount: 340, currency: "EUR" },
        paid: true,
        paid_amount: 37500,
        // paid_currency missing ⇒ falls back to the plan price.
      }),
    );
    expect(leg0Of(hydrated)?.fare).toEqual({ amount: 340, currency: "EUR" });
  });

  it("a zero paid_amount never overrides — falls back to the leg price (or omitted)", () => {
    // With a plan price: the zero payment is ignored, price wins (tripBudget
    // parity — a recorded 0 is not a real payment).
    const withPrice = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({
        booked: true,
        price: { amount: 340, currency: "EUR" },
        paid: true,
        paid_amount: 0,
        paid_currency: "JPY",
      }),
    );
    expect(leg0Of(withPrice)?.fare).toEqual({ amount: 340, currency: "EUR" });

    // Without a plan price: the field is omitted entirely (never 0).
    const withoutPrice = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({ paid: true, paid_amount: 0, paid_currency: "JPY" }),
    );
    expect(leg0Of(withoutPrice)?.fare).toBeUndefined();
  });

  /**
   * REGRESSION — found live on 2026-08-31. An UNBOOKED leg carries only the
   * planner's price estimate for a seat nobody bought. Treating that as the
   * fare on file let the rebooking math "refund" the difference: a missed
   * low-cost Vueling hop reported €239.76 back (estimate 285 − new fare 45.24)
   * and a NEGATIVE amount due — the swarm paying you to miss your flight.
   */
  it("an UNBOOKED leg has no original fare — an estimate is not a ticket", () => {
    const unbooked = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({ price: { amount: 285, currency: "EUR" } }),
    );
    expect(leg0Of(unbooked)?.fare).toBeUndefined();

    // Marked as held ⇒ the estimate becomes the fare to compare against.
    const booked = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({ booked: true, price: { amount: 285, currency: "EUR" } }),
    );
    expect(leg0Of(booked)?.fare).toEqual({ amount: 285, currency: "EUR" });

    // A real payment stands on its own, booked flag or not.
    const paid = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({ paid: true, paid_amount: 199, paid_currency: "EUR" }),
    );
    expect(leg0Of(paid)?.fare).toEqual({ amount: 199, currency: "EUR" });
  });

  it("counts only real traveler entries — placeholders like [null] never yield 1", () => {
    // Leg travelers full of placeholders ⇒ ignored, no root party ⇒ omitted.
    const placeholderLeg = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({ travelers: [null, "ghost", 7] }),
    );
    expect(leg0Of(placeholderLeg)?.travelers).toBeUndefined();

    // Mixed real + placeholder entries ⇒ only the real ones count.
    const mixedLeg = hydrateTripFromContent(
      "t",
      "",
      "Lisbon",
      contentWithLeg0({ travelers: [{ name: "A" }, null, { name: "B" }] }),
    );
    expect(leg0Of(mixedLeg)?.travelers).toBe(2);

    // Root party `[null]` alone ⇒ still omitted.
    const placeholderRoot = {
      ...buildFixtureContent(),
      travelers: [null],
    };
    expect(
      leg0Of(hydrateTripFromContent("t", "", "Lisbon", placeholderRoot))?.travelers,
    ).toBeUndefined();
  });
});

// ------------------------------------------------------------ intent parser

describe("parseMissionIntentForTrip", () => {
  it("targets a flight by its real flight number", () => {
    const parsed = parseMissionIntentForTrip("I missed flight TP437", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("flight-0");
    expect(parsed.mission.kind).toBe("missed_flight");
    expect(parsed.mission.delayMinutes).toBe(240); // default
  });

  it("matches a city word against the trip destination and parses '2h'", () => {
    const parsed = parseMissionIntentForTrip(
      "our flight to Lisbon is delayed 2h",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("flight-0");
    expect(parsed.mission.delayMinutes).toBe(120);
  });

  it("falls back to the nearest upcoming flight and notes the choice", () => {
    const parsed = parseMissionIntentForTrip("my flight is badly delayed", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("flight-0"); // tomorrow < +4 days
    expect(parsed.mission.description).toContain("TP437");
    expect(parsed.mission.description.toLowerCase()).toContain("upcoming");
  });

  it("routes weather intents to the first OUTDOOR activity (proactive)", () => {
    const parsed = parseMissionIntentForTrip(
      "heavy rain expected during our surf lesson",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("activity-0-0"); // Surf Lesson, not the museum
    expect(parsed.mission.origin).toBe("proactive");
    expect(parsed.mission.weatherHint).toBe("rain");
    expect(parsed.mission.kind).toBe("weather");
  });

  it("routes hotel trouble to the hotel_check_in node, tagged overbooked", () => {
    const parsed = parseMissionIntentForTrip("our hotel was overbooked", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("hotel-0-1");
    // "overbook*" in the intent must reach the "hotel_overbooked" category —
    // there is no existing booking left to "keep" once the property has
    // walked you. (Was asserting "hotel": the ternary that was supposed to
    // set this literally read `isOverbooked ? "hotel" : "hotel"`.)
    expect(parsed.mission.kind).toBe("hotel_overbooked");
  });

  it("routes 'cancelled' without hotel vocabulary to the ACTIVITY branch", () => {
    const parsed = parseMissionIntentForTrip("My activity got cancelled", hydrateFixture());
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("activity-0-0");
    expect(parsed.mission.kind).toBe("activity_cancelled");
  });

  it("keeps cancellation wording WITH hotel vocabulary on the hotel branch", () => {
    const parsed = parseMissionIntentForTrip(
      "my hotel reservation got cancelled",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("hotel-0-1");
    expect(parsed.mission.kind).toBe("hotel");
  });

  it("routes unwell/lighten intents to a proactive user_report mission", () => {
    const parsed = parseMissionIntentForTrip(
      "feeling unwell, please lighten the day",
      hydrateFixture(),
    );
    expect(parsed.kind).toBe("mission");
    if (parsed.kind !== "mission") return;
    expect(parsed.mission.nodeId).toBe("activity-0-0"); // earliest activity
    expect(parsed.mission.origin).toBe("proactive");
    expect(parsed.mission.evidence?.kind).toBe("user_report");
    expect(parsed.mission.kind).toBe("unwell");
  });

  it("errors on unknown explicit nodes and unparseable intents", () => {
    const unknown = parseMissionIntentForTrip("reroute", hydrateFixture(), "nope-1");
    expect(unknown).toMatchObject({ kind: "error", status: 404 });
    const noTarget = parseMissionIntentForTrip("just wondering about stuff", hydrateFixture());
    expect(noTarget).toMatchObject({ kind: "mission", mission: { kind: "custom" } });
  });
});

// --------------------------------------------------------------- settlement

describe("applySettlementToContent", () => {
  it("rewrites the disrupted flight leg and reports the change", () => {
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const newDepart = at(day1Start, 21, 10);
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      basePlan(),
      {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        new_flight: {
          reference: "AF1234",
          depart: newDepart,
          arrive: at(day1Start, 23, 40),
          carrier: "Air France",
        },
        bookingCode: "SWARM-ABC123",
      },
    );
    const leg = (next.transit_groups as any[])[0];
    expect(leg.reference).toBe("AF1234");
    expect(leg.carrier).toBe("Air France");
    // Stored as the canonical wall-clock stamp the rest of the trip uses,
    // not as the provider's instant.
    expect(leg.depart).toBe(toLegStamp(newDepart));
    expect(leg.booked).toBe(true);
    expect(leg.booking_reference).toBe("SWARM-ABC123");
    expect(changes.some((c) => c.includes("AF1234") && c.includes("21:10"))).toBe(true);
  });

  it("writes the replacement's hops, and derives the count from them", () => {
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const plan = basePlan();
    // A one-stop replacement: two hops, connecting at BCN.
    (plan.proposed_resolution.new_flight as unknown as Record<string, unknown>).segments = [
      {
        carrier: "Vueling",
        reference: "VY6651",
        from: "LHR",
        to: "BCN",
        depart: at(day1Start, 21, 10),
        arrive: at(day1Start, 23, 5),
      },
      {
        carrier: "Vueling",
        reference: "VY8462",
        from: "BCN",
        to: "LIS",
        depart: at(day2Start, 1, 30),
        arrive: at(day2Start, 2, 40),
      },
    ];
    // A CONTRADICTORY count on the same payload: segments must win, because
    // they are the only source the drawer can render hop by hop.
    (plan.proposed_resolution.new_flight as unknown as Record<string, unknown>).stops = 0;
    (plan.proposed_resolution.new_flight as unknown as Record<string, unknown>).stopAirports = [
      "MAD",
    ];

    const { content: next } = applySettlementToContent(content, hydrated.nodeRefs, plan, {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      new_flight: {
        reference: "VY6651",
        depart: at(day1Start, 21, 10),
        arrive: at(day2Start, 2, 40),
        carrier: "Vueling",
      },
      bookingCode: "SWARM-SEG1",
    });

    const leg = (next.transit_groups as any[])[0];
    expect(leg.segments).toHaveLength(2);
    expect(leg.segments[0].reference).toBe("VY6651");
    expect(leg.segments[1].from.code).toBe("BCN");
    // Stored as local wall-clock, exactly like `depart`/`arrive` — never the
    // provider's Z-suffixed instant.
    expect(leg.segments[0].depart).toBe(toLegStamp(at(day1Start, 21, 10)));
    expect(leg.segments[0].depart).not.toContain("Z");
    // Derived from the hops, NOT taken from the contradictory fields above.
    expect(leg.stops).toBe(1);
    expect(leg.stop_airports).toEqual(["BCN"]);
  });

  it("clears stale hops when the replacement's routing is unknown", () => {
    // The leg starts out describing a two-hop journey. The swarm rebooks it
    // onto a flight whose hops the provider never described. Segments outrank
    // `stops` wherever the leg is read, so leaving the old ones behind would
    // show the PREVIOUS journey under the new flight's name.
    const content = buildFixtureContent();
    (content.transit_groups as any[])[0].segments = [
      { reference: "TP437", from: { code: "CDG" }, to: { code: "OPO" } },
      { reference: "TP438", from: { code: "OPO" }, to: { code: "LIS" } },
    ];
    const hydrated = hydrateFixture();

    const { content: next } = applySettlementToContent(content, hydrated.nodeRefs, basePlan(), {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      new_flight: {
        reference: "AF1234",
        depart: at(day1Start, 21, 10),
        arrive: at(day1Start, 23, 40),
        carrier: "Air France",
      },
      bookingCode: "SWARM-SEG2",
    });

    const leg = (next.transit_groups as any[])[0];
    expect(leg.reference).toBe("AF1234");
    expect(leg.segments).toBeUndefined();
  });

  it("reports flightRewriteLanded and skips a rewrite that already landed", () => {
    // Clarity pass: the rewrite result names whether the leg actually
    // changed; re-applying the SAME booking code is a no-op (the leg already
    // carries the booking reference) so the approve rail can stay honest.
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const operational = {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      new_flight: {
        reference: "AF1234",
        depart: at(day1Start, 21, 10),
        arrive: at(day1Start, 23, 40),
        carrier: "Air France",
      },
      bookingCode: "SWARM-ABC123",
    };
    const first = applySettlementToContent(content, hydrated.nodeRefs, basePlan(), operational);
    expect(first.flightRewriteLanded).toBe(true);

    const second = applySettlementToContent(
      first.content,
      hydrated.nodeRefs,
      basePlan(),
      operational,
    );
    expect(second.flightRewriteLanded).toBe(false);
    const leg = (second.content.transit_groups as any[])[0];
    expect(leg.reference).toBe("AF1234"); // untouched, never re-rewritten
    expect(leg.booking_reference).toBe("SWARM-ABC123");
    expect(second.changes.length).toBe(0);
  });

  it("re-times an activity and moves it across days when the date changes", () => {
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      basePlan(),
      {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        activity_moves: [{ nodeId: "activity-0-0", newTime: at(day2Start, 13, 30) }],
      },
    );
    const itinerary = next.itinerary as any[];
    expect(itinerary[0].items).toHaveLength(1); // surf lesson left day 1
    const day2Items = itinerary[1].items;
    const moved = day2Items.find((i: any) => i.title === "Surf Lesson");
    expect(moved).toBeTruthy();
    expect(moved.time).toBe("13:30");
    expect(changes.some((c) => c.includes("Surf Lesson") && c.includes("tomorrow 13:30"))).toBe(
      true,
    );
  });

  it("same-day retime only updates item.time", () => {
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const { content: next } = applySettlementToContent(content, hydrated.nodeRefs, basePlan(), {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      activity_moves: [{ nodeId: "activity-0-0", newTime: at(day1Start, 17, 45) }],
    });
    const itinerary = next.itinerary as any[];
    expect(itinerary[0].items).toHaveLength(2);
    expect(itinerary[0].items[0].time).toBe("17:45");
  });

  it("swaps an activity for the Viator replacement (title + booking_ref)", () => {
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      basePlan(),
      {
        disrupted: { nodeId: "activity-0-0", kind: "activity", label: "Surf Lesson" },
        activity_moves: [
          {
            nodeId: "activity-0-0",
            newTime: at(day1Start, 15, 0),
            replacementName: "Lisbon Oceanarium Ticket",
            viatorProductCode: "VI-99123",
          },
        ],
      },
    );
    const item = (next.itinerary as any[])[0].items[0];
    expect(item.title).toBe("Lisbon Oceanarium Ticket");
    expect(item.booking_ref).toBe("VI-99123");
    expect(item.time).toBe("15:00");
    expect(changes.some((c) => c.includes("swapped for Lisbon Oceanarium Ticket"))).toBe(true);
  });

  it("applies hotel actions: shifted check_in + additive swarm_note", () => {
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      basePlan(),
      {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        hotel_actions: [
          {
            nodeId: "hotel-0-1",
            action: "late_check_in",
            note: "arrival pushed back 6h",
            newCheckIn: at(day2Start, 1, 0), // shifted past midnight → next day
          },
        ],
      },
    );
    const stay = (next.itinerary as any[])[0].items[1];
    expect(stay.check_in).toBe(day2Date);
    // Finding 5: the action reads as words with its time, not an enum.
    expect(stay.swarm_note).toContain("late check-in at 01:00");
    expect(stay.swarm_note).toContain("arrival pushed back 6h");
    expect(changes.some((c) => c.includes("Atlantica Surf House"))).toBe(true);
  });

  it("settlement round-trip: a re-timed stay re-hydrates at the shifted time (no second shift)", () => {
    // Task 19 idempotency: the newCheckIn branch stamps `item.time` so a
    // later load reads the shifted hour straight — the stay must NOT snap
    // back to the 15:00Z default NOR accrue a second shift.
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    expect(hydrated.graph.getNode("hotel-0-1")?.scheduledTime).toBe(
      Date.parse(`${day1Date}T15:00:00Z`), // baseline default
    );

    const newCheckIn = at(day1Start, 21, 30);
    const { content: settled } = applySettlementToContent(content, hydrated.nodeRefs, basePlan(), {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      hotel_actions: [
        {
          nodeId: "hotel-0-1",
          action: "late_check_in",
          note: "arrival pushed back",
          newCheckIn,
        },
      ],
    });

    // Both the date AND the time component land on the stay item.
    const stay = (settled.itinerary as any[])[0].items[1];
    expect(stay.check_in).toBe(day1Date);
    expect(stay.time).toBe("21:30");

    // Re-hydrate the settled content: the stay comes back at EXACTLY the
    // shifted instant — not 15:00Z, not double-shifted.
    const rehydrated = hydrateTripFromContent("t", "", "Lisbon", settled);
    expect(rehydrated).not.toBeNull();
    const hotel = rehydrated!.graph.getNode("hotel-0-1");
    expect(hotel?.scheduledTime).toBe(Date.parse(`${day1Date}T21:30:00Z`));

    // And a second identical settlement leaves the stored time stable.
    const { content: settledAgain } = applySettlementToContent(
      settled,
      hydrated.nodeRefs,
      basePlan(),
      {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        hotel_actions: [
          {
            nodeId: "hotel-0-1",
            action: "late_check_in",
            note: "arrival pushed back",
            newCheckIn,
          },
        ],
      },
    );
    expect((settledAgain.itinerary as any[])[0].items[1].time).toBe("21:30");
  });

  it("keeps the hotel swarm_note idempotent when the same settlement re-applies", () => {
    // Re-applying the SAME booking code must not stack duplicate notes.
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const operational = {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      hotel_actions: [
        {
          nodeId: "hotel-0-1",
          action: "late_check_in",
          note: "arrival pushed back 6h",
          newCheckIn: at(day2Start, 1, 0),
        },
      ],
      bookingCode: "SWARM-HOTEL-1",
    };
    const first = applySettlementToContent(content, hydrated.nodeRefs, basePlan(), operational);
    const second = applySettlementToContent(
      first.content,
      hydrated.nodeRefs,
      basePlan(),
      operational,
    );
    const firstNote = (first.content.itinerary as any[])[0].items[1].swarm_note;
    const secondNote = (second.content.itinerary as any[])[0].items[1].swarm_note;
    expect(secondNote).toBe(firstNote);
    // A genuinely DIFFERENT note (e.g. a later settlement event) still
    // appends — notes stay additive, never overwritten.
    const third = applySettlementToContent(second.content, hydrated.nodeRefs, basePlan(), {
      ...operational,
      bookingCode: "SWARM-HOTEL-2",
      hotel_actions: [
        {
          nodeId: "hotel-0-1",
          action: "late_check_in",
          note: "check-out shifted 2h",
          newCheckIn: at(day2Start, 1, 0),
        },
      ],
    });
    const thirdNote = (third.content.itinerary as any[])[0].items[1].swarm_note;
    expect(thirdNote).not.toBe(secondNote);
    expect(thirdNote).toContain("check-out shifted 2h");
    expect(thirdNote.length).toBeGreaterThan(secondNote.length);
  });

  it("splices two same-day cross-day moves without index drift", () => {
    const content = buildFixtureContent();
    // Day 1 becomes: [Surf Lesson, Beach Hike, Museum Hop, stay] — move the
    // items at indices 0 AND 2 off the day; a naive ascending splice (or a
    // splice before all edits landed) would grab the wrong second item.
    (content.itinerary[0].items as unknown[]).splice(
      1,
      0,
      { type: "activity", title: "Beach Hike", time: "10:30" },
      { type: "activity", title: "Museum Hop", time: "16:00" },
    );
    const hydrated = hydrateTripFromContent(
      "11111111-2222-3333-4444-555555555555",
      "Lisbon Surf Week",
      "Lisbon",
      content,
    );
    expect(hydrated).not.toBeNull();
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated!.nodeRefs,
      basePlan(),
      {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        activity_moves: [
          { nodeId: "activity-0-0", newTime: at(day2Start, 9, 0) }, // Surf Lesson
          { nodeId: "activity-0-2", newTime: at(day2Start, 11, 0) }, // Museum Hop
        ],
      },
    );
    const itinerary = next.itinerary as any[];
    // Day 1 keeps exactly the two unmoved items, in order.
    expect(itinerary[0].items.map((i: any) => i.title)).toEqual([
      "Beach Hike",
      "Atlantica Surf House",
    ]);
    // The stay item must NOT have been retimed/moved by the second splice.
    expect(itinerary[0].items[1].time).toBeUndefined();
    // Both moved activities landed on day 2 alongside the original one.
    const day2Titles = itinerary[1].items.map((i: any) => i.title);
    expect(day2Titles).toContain("Surf Lesson");
    expect(day2Titles).toContain("Museum Hop");
    expect(day2Titles).toContain("Ocean Museum Visit");
    expect(itinerary[1].items.find((i: any) => i.title === "Museum Hop").time).toBe("11:00");
    expect(changes.filter((c: string) => c.includes("moved to tomorrow")).length).toBe(2);
  });

  it("never mutates its input", () => {
    const content = buildFixtureContent();
    const before = JSON.stringify(content);
    const hydrated = hydrateFixture();
    applySettlementToContent(content, hydrated.nodeRefs, basePlan(), {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      new_flight: {
        reference: "AF1234",
        depart: at(day1Start, 21, 10),
        arrive: at(day1Start, 23, 40),
      },
      activity_moves: [{ nodeId: "activity-0-0", newTime: at(day2Start, 13, 30) }],
      hotel_actions: [{ nodeId: "hotel-0-1", action: "late_check_in", note: "x" }],
    });
    expect(JSON.stringify(content)).toBe(before);
  });

  // W2 — smart day reorganization: drop markers splice the item out WITHOUT
  // any re-append, and coexist with same-day retimes + cross-day moves.

  it("splices a dropped activity out of the day with a cancellation line", () => {
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      basePlan(),
      {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        activity_moves: [
          {
            nodeId: "activity-0-0",
            // `newTime` keeps the original slot (frozen required field) — the
            // additive `drop` marker selects the cancellation branch.
            newTime: at(day1Start, 13, 30),
            drop: true,
          },
        ],
      },
    );
    const itinerary = next.itinerary as any[];
    // Surf Lesson is GONE from day 1; the stay stays untouched.
    expect(itinerary[0].items.map((i: any) => i.title)).toEqual(["Atlantica Surf House"]);
    // …and it was NOT re-appended anywhere else in the itinerary.
    const everyTitle = itinerary.flatMap((d: any) => d.items.map((i: any) => i.title));
    expect(everyTitle).not.toContain("Surf Lesson");
    expect(changes.some((c) => c.includes("Surf Lesson cancelled"))).toBe(true);
    // Default honest policy wording (penalty 0 heuristic).
    expect(changes.some((c) => c.includes("free cancellation until 24h before start"))).toBe(true);
  });

  it("prefers the settlement-supplied cancellationNote wording", () => {
    const content = buildFixtureContent();
    const hydrated = hydrateFixture();
    const { changes } = applySettlementToContent(content, hydrated.nodeRefs, basePlan(), {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      activity_moves: [
        {
          nodeId: "activity-0-0",
          newTime: at(day1Start, 13, 30),
          drop: true,
          cancellationNote: "cancellation inside 24h of start — 15 USD fee applies",
        },
      ],
    });
    expect(
      changes.some(
        (c) =>
          c.includes("Surf Lesson cancelled") &&
          c.includes("cancellation inside 24h of start — 15 USD fee applies"),
      ),
    ).toBe(true);
  });

  it("coexists with same-day retimes and cross-day moves (no index drift)", () => {
    const content = buildFixtureContent();
    // Day 1 becomes: [Surf Lesson, Beach Hike, Museum Hop, stay] — one drop
    // (idx 1), one same-day retime (idx 0) and one cross-day move (idx 2) in
    // a single settlement: the shared descending splice pass must remove the
    // drop and the move without shifting each other.
    (content.itinerary[0].items as unknown[]).splice(
      1,
      0,
      { type: "activity", title: "Beach Hike", time: "10:30" },
      { type: "activity", title: "Museum Hop", time: "16:00" },
    );
    const hydrated = hydrateTripFromContent(
      "11111111-2222-3333-4444-555555555555",
      "Lisbon Surf Week",
      "Lisbon",
      content,
    );
    expect(hydrated).not.toBeNull();
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated!.nodeRefs,
      basePlan(),
      {
        disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
        activity_moves: [
          { nodeId: "activity-0-0", newTime: at(day1Start, 18, 0) }, // retime
          { nodeId: "activity-0-1", newTime: at(day1Start, 10, 30), drop: true }, // drop
          { nodeId: "activity-0-2", newTime: at(day2Start, 11, 0) }, // cross-day
        ],
      },
    );
    const itinerary = next.itinerary as any[];
    // Day 1: Surf Lesson retimed in place; Beach Hike gone; Museum Hop moved
    // out; the stay untouched (and NOT shifted by either splice).
    expect(itinerary[0].items.map((i: any) => i.title)).toEqual([
      "Surf Lesson",
      "Atlantica Surf House",
    ]);
    expect(itinerary[0].items[0].time).toBe("18:00");
    // Day 2: the cross-day move landed NEXT TO the original activity.
    const day2Titles = itinerary[1].items.map((i: any) => i.title);
    expect(day2Titles).toContain("Ocean Museum Visit");
    expect(day2Titles).toContain("Museum Hop");
    // The dropped item appears NOWHERE.
    const everyTitle = itinerary.flatMap((d: any) => d.items.map((i: any) => i.title));
    expect(everyTitle).not.toContain("Beach Hike");
    expect(changes.some((c) => c.includes("Beach Hike cancelled"))).toBe(true);
    expect(changes.some((c) => c.includes("Surf Lesson moved to today 18:00"))).toBe(true);
    expect(changes.some((c) => c.includes("Museum Hop moved to tomorrow 11:00"))).toBe(true);
  });
});

// ------------------------------------------------- loadSwarmTrip classification

describe("loadSwarmTrip classification (rotated-key hardening)", () => {
  const TRIP_ID = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    tripDbHooks.__clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("a query error → store_unavailable (retryable, NEVER 404)", async () => {
    // E.g. a rotated service key ⇒ PostgREST auth error. No message-matching:
    // ANY store error classifies as retryable.
    tripDbHooks.__setQueryError({ message: "Invalid API key" });
    const result = await loadSwarmTrip(TRIP_ID);
    expect(result.kind).toBe("store_unavailable");
  });

  it("a thrown error (missing credentials) → store_unavailable", async () => {
    tripDbHooks.__setThrowOnAccess(true);
    const result = await loadSwarmTrip(TRIP_ID);
    expect(result.kind).toBe("store_unavailable");
  });

  it("a missing row → not_found", async () => {
    tripDbHooks.__setRow(null);
    const result = await loadSwarmTrip(TRIP_ID);
    expect(result.kind).toBe("not_found");
  });

  it("a row whose content cannot hydrate → unhydratable", async () => {
    tripDbHooks.__setRow({
      id: TRIP_ID,
      title: { en: "Broken Trip" },
      destination: { en: "Nowhere" },
      content_json: { nothing: "usable" },
      content_rev: 1,
    });
    const result = await loadSwarmTrip(TRIP_ID);
    expect(result.kind).toBe("unhydratable");
  });

  it("a valid row → ok with the hydrated trip", async () => {
    tripDbHooks.__setRow({
      id: TRIP_ID,
      title: { en: "Lisbon Surf Week" },
      destination: { en: "Lisbon" },
      content_json: buildFixtureContent(),
      content_rev: 3,
    });
    const result = await loadSwarmTrip(TRIP_ID);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.trip.meta.currency).toBe("EUR");
    expect(result.trip.nodeRefs["flight-0"]).toBeDefined();
  });
});

// ----------------------------------------- settlePlanOnTrip (settle hardening)

describe("settlePlanOnTrip — CAS write, rewrite honesty, post-write rev", () => {
  const TRIP_ID = "11111111-2222-3333-4444-555555555555";

  function seedTrip(): void {
    tripDbHooks.__setRow({
      id: TRIP_ID,
      title: { en: "Lisbon Surf Week" },
      destination: { en: "Lisbon" },
      content_json: buildFixtureContent(),
      content_rev: 3,
    });
  }

  function flightOperational(bookingCode: string) {
    return {
      disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
      new_flight: {
        reference: "AF1234",
        depart: at(day1Start, 21, 10),
        arrive: at(day1Start, 23, 40),
        carrier: "Air France",
      },
      bookingCode,
    };
  }

  beforeEach(() => {
    tripDbHooks.__clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("rewrites the flight leg, lands the rewrite and returns the post-write content_rev", async () => {
    seedTrip();
    const hydrated = hydrateFixture();
    const result = await settlePlanOnTrip(
      TRIP_ID,
      hydrated.nodeRefs,
      basePlan(),
      flightOperational("SWARM-ABC123"),
    );
    expect(result).not.toBeNull();
    if (result === null || !("updatedContent" in result)) {
      throw new Error("expected a settled result");
    }
    expect(result.flightRewriteLanded).toBe(true);
    // A landed rewrite reports NO skip reason.
    if ("flightSkipReason" in result) expect(result.flightSkipReason).toBeUndefined();
    // Seeded rev 3 → the CAS write bumps it; the RETURNING rev is post-write.
    expect(result.contentRev).toBe(4);
    const leg = (result.updatedContent.transit_groups as any[])[0];
    expect(leg.reference).toBe("AF1234");
    expect(leg.booked).toBe(true);
    expect(leg.booking_reference).toBe("SWARM-ABC123");
  });

  it("re-settling the same booking code skips the rewrite (note-idempotent)", async () => {
    seedTrip();
    const hydrated = hydrateFixture();
    const first = await settlePlanOnTrip(
      TRIP_ID,
      hydrated.nodeRefs,
      basePlan(),
      flightOperational("SWARM-ABC123"),
    );
    expect(first).not.toBeNull();
    if (first === null || !("updatedContent" in first)) {
      throw new Error("expected a settled result");
    }
    expect(first.flightRewriteLanded).toBe(true);
    expect(first.contentRev).toBe(4);

    // Second application re-reads the freshly written row: the leg already
    // carries the booking code ⇒ NO rewrite is reported or performed.
    const second = await settlePlanOnTrip(
      TRIP_ID,
      hydrated.nodeRefs,
      basePlan(),
      flightOperational("SWARM-ABC123"),
    );
    expect(second).not.toBeNull();
    if (second === null || !("updatedContent" in second)) {
      throw new Error("expected a settled result");
    }
    expect(second.flightRewriteLanded).toBe(false);
    // Honest skip reporting: the rewrite was attempted but the leg already
    // carried this booking code ⇒ "already_settled" (never a bare false).
    expect(second.flightSkipReason).toBe("already_settled");
    expect(second.changes.length).toBe(0);
    // Idempotent write: the patch is byte-identical to the stored row, so
    // the migration trigger leaves content_rev WHERE IT WAS (no bump).
    expect(second.contentRev).toBe(4);
    const leg = (second.updatedContent.transit_groups as any[])[0];
    expect(leg.reference).toBe("AF1234");
    expect(leg.booking_reference).toBe("SWARM-ABC123");
  });
});

// ------------------------------------------- transit restatements (day items)

/**
 * Real generated trips restate a flight INSIDE a day as an `activity` item
 * (mockTrip's item types are only stay|activity|dining|transit), next to the
 * real leg in `transit_groups`. These guard the two things that must then be
 * true: the swarm never treats such an item as a reschedulable activity, and
 * settlement keeps it in step with the leg it mirrors.
 */
function contentWithRestatedFlight() {
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
        price: { amount: 280, currency: "EUR" },
        booked: true,
      },
    ],
    itinerary: [
      {
        day: 1,
        date: day1Date,
        place: "Lisbon",
        items: [
          {
            type: "activity",
            title: "Flight TP437 CDG → LIS",
            time: "09:00",
            cost: { amount: 280, currency: "EUR" },
            booked: true,
          },
          { type: "activity", title: "Surf Lesson", time: "13:30" },
        ],
      },
    ],
  };
}

/** Operational layer replacing TP437 with IB3125 at 14:00. */
function replacementOperational() {
  return {
    disrupted: { nodeId: "flight-0", kind: "flight", label: "Flight TP437 CDG → LIS" },
    new_flight: {
      reference: "IB3125",
      depart: at(day1Start, 14, 0),
      arrive: at(day1Start, 20, 0),
      carrier: "Iberia",
    },
    bookingCode: "SWARM-NEW1",
  };
}

/** basePlan() with a priced replacement ticket the settlement can stamp. */
function pricedPlan(cost = 268, netPayable = 13): ResolutionPlan {
  return {
    ...basePlan(),
    proposed_resolution: {
      new_flight: { id: "ATL-OFR-2", cost, currency: "EUR" },
      rescheduled_activities: [],
    },
    financial_delta: {
      total_refund: 12,
      total_new_charges: 25,
      net_payable: netPayable,
      by_currency: [
        { currency: "EUR", total_refund: 12, total_new_charges: 25, net_payable: netPayable },
      ],
    },
  };
}

describe("transit restatements are not reschedulable activities", () => {
  it("gives a flight-restating day item no activity node", () => {
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", contentWithRestatedFlight());
    expect(hydrated).not.toBeNull();
    // The restatement (item 0) must NOT become a node the ActivityAgent can
    // move — otherwise the swarm reschedules the traveler's flight.
    expect(hydrated!.graph.getNode("activity-0-0")).toBeUndefined();
    expect(hydrated!.nodeRefs["activity-0-0"]).toBeUndefined();
    // The genuine activity beside it still hydrates.
    expect(hydrated!.graph.getNode("activity-0-1")?.type).toBe("activity");
  });

  it("keeps a genuine activity that merely names the destination city", () => {
    // Narrowness guard: a city word alone must never hide a real activity —
    // only a mode word TOGETHER with an endpoint (or the leg reference) does.
    const content = contentWithRestatedFlight() as any;
    content.itinerary[0].items[1] = { type: "activity", title: "Lisbon Food Tour", time: "16:00" };
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content);
    expect(hydrated!.nodeRefs["activity-0-1"]?.label).toBe("Lisbon Food Tour");
  });

  it("matches a spaced reference the way generated titles write it", () => {
    const content = contentWithRestatedFlight() as any;
    content.itinerary[0].items[0].title = "Overnight flight TP 437";
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content);
    expect(hydrated!.nodeRefs["activity-0-0"]).toBeUndefined();
  });
});

describe("everything that depends on landing moves with the flight", () => {
  // Reported from a real settled trip: the swarm rebooked the flight to land
  // at 23:40 and wrote it correctly — while the hotel check-in still read
  // 04:15 and the airport transfer 18:30, both hours BEFORE the plane touched
  // down. The flight was the only thing the operational layer listed, so the
  // flight was the only thing that moved.
  //
  // The agents cannot be relied on to list everything: with the hotel provider
  // unavailable there are no `hotel_actions` at all. The settlement itself has
  // to leave the written trip internally consistent.

  /** Arrival day holding a stay, a transfer and an activity — all after the
   *  original 11:30 landing, all impossible after a 20:00 one. */
  function arrivalDayContent() {
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
          price: { amount: 280, currency: "EUR" },
          booked: true,
        },
      ],
      itinerary: [
        {
          day: 1,
          date: day1Date,
          place: "Lisbon",
          items: [
            { type: "stay", title: "Hotel Lisboa", time: "13:00", check_in: day1Date },
            { type: "activity", title: "Metro from the airport", time: "12:30" },
            { type: "dining", title: "Dinner in Alfama", time: "19:00" },
          ],
        },
      ],
    } as Record<string, unknown>;
  }

  it("pushes the stay, the transfer and the meal behind the new landing", () => {
    const content = arrivalDayContent();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      replacementOperational(), // lands 20:00, no hotel_actions, no activity_moves
    );

    const items = (next.itinerary as any[])[0].items;
    const timeOf = (title: string) =>
      items.find((i: any) => i.title === title).time as string;

    // Nothing may still sit before the 20:00 arrival.
    for (const t of ["Hotel Lisboa", "Metro from the airport", "Dinner in Alfama"]) {
      expect(timeOf(t) >= "20:00").toBe(true);
    }
    // Order is preserved — the transfer was earliest, so it stays earliest.
    expect(timeOf("Metro from the airport") < timeOf("Hotel Lisboa")).toBe(true);
    expect(timeOf("Hotel Lisboa") < timeOf("Dinner in Alfama")).toBe(true);
    // The change is reported, not silent.
    expect(changes.some((c) => c.includes("Arrival cascade"))).toBe(true);
  });

  it("re-dates the stay's check_in, or hydration snaps the room back", () => {
    const content = arrivalDayContent();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      replacementOperational(),
    );
    const stay = (next.itinerary as any[])[0].items.find((i: any) => i.type === "stay");
    expect(stay.check_in).toBe(day1Date);
    expect(stay.time >= "20:00").toBe(true);
  });

  it("leaves entries that were ALREADY before the old landing alone", () => {
    // Breakfast at the ORIGIN on a departure day was never waiting on this
    // flight. Pushing it past the arrival would be inventing a change the
    // traveller never asked for — this is why the rule keys off the OLD
    // arrival rather than simply "anything earlier than the new one".
    const content = arrivalDayContent();
    (content.itinerary as any[])[0].items.unshift({
      type: "dining",
      title: "Breakfast before the airport",
      time: "07:00", // before the 11:30 original arrival
    });
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      replacementOperational(),
    );
    const breakfast = (next.itinerary as any[])[0].items.find(
      (i: any) => i.title === "Breakfast before the airport",
    );
    expect(breakfast.time).toBe("07:00");
  });

  it("corrects an agent's check-in that lands BEFORE the flight it waits for", () => {
    // Seen live: the hotel agent moved a check-in to 01:00 for a replacement
    // that lands at 01:05 — the room taken five minutes before the plane
    // touched down. Its instruction comes from propagating the NOMINAL delay,
    // not the replacement the traveller actually chose, so deferring to it
    // blindly just writes a broken trip more politely.
    const content = arrivalDayContent();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const stayNodeId = Object.entries(hydrated.nodeRefs).find(
      ([, ref]) => ref.kind === "hotel",
    )![0];

    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      {
        ...replacementOperational(), // lands 20:00
        hotel_actions: [
          {
            nodeId: stayNodeId,
            action: "late_check_in",
            note: "deferred",
            // Impossible: 19:00 is before the 20:00 landing.
            newCheckIn: at(day1Start, 19, 0),
          },
        ],
      },
    );
    const stay = (next.itinerary as any[])[0].items.find((i: any) => i.type === "stay");
    expect(stay.time >= "20:00").toBe(true);
  });

  it("leaves a POSSIBLE agent placement exactly where the agent put it", () => {
    // The backstop must not become a second opinion: an instruction that works
    // is respected to the minute.
    const content = arrivalDayContent();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const stayNodeId = Object.entries(hydrated.nodeRefs).find(
      ([, ref]) => ref.kind === "hotel",
    )![0];

    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      {
        ...replacementOperational(), // lands 20:00
        hotel_actions: [
          {
            nodeId: stayNodeId,
            action: "late_check_in",
            note: "deferred",
            newCheckIn: at(day1Start, 22, 30), // comfortably after the landing
          },
        ],
      },
    );
    const stay = (next.itinerary as any[])[0].items.find((i: any) => i.type === "stay");
    expect(stay.time).toBe("22:30");
  });

  it("anchors a stay on its own check_in date, not the day it is filed under", () => {
    // Real trips carry stays whose `check_in` differs from the itinerary day
    // holding them — hydration reads `check_in` first, so a cascade that
    // judged the day's date would move the wrong night (or miss it entirely).
    const content = arrivalDayContent();
    const items = (content.itinerary as any[])[0].items;
    // Filed under day 1, but the room is actually for the NEXT night.
    items.find((i: any) => i.type === "stay").check_in = day2Date;
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      replacementOperational(), // lands 20:00 on day 1
    );
    const stay = (next.itinerary as any[])[0].items.find((i: any) => i.type === "stay");
    // 13:00 on day 2 is comfortably after a day-1 20:00 landing — untouched.
    expect(stay.time).toBe("13:00");
    expect(stay.check_in).toBe(day2Date);
  });

  it("does nothing at all when the replacement lands no later", () => {
    // A same-time rebooking must not shuffle a perfectly good day.
    const content = arrivalDayContent();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const sameTime = {
      ...replacementOperational(),
      new_flight: {
        reference: "IB3125",
        depart: at(day1Start, 9, 0),
        arrive: at(day1Start, 11, 30),
        carrier: "Iberia",
      },
    };
    const { content: next, changes } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      sameTime,
    );
    const items = (next.itinerary as any[])[0].items;
    expect(items.find((i: any) => i.type === "stay").time).toBe("13:00");
    expect(items.find((i: any) => i.title === "Dinner in Alfama").time).toBe("19:00");
    expect(changes.some((c) => c.includes("Arrival cascade"))).toBe(false);
  });
});

describe("settlement keeps money and the day view in step with the leg", () => {
  it("stamps the replacement fare on the rewritten leg", () => {
    const content = contentWithRestatedFlight();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      replacementOperational(),
    );
    // Without this the trip budget keeps quoting the fare of a flight the
    // traveler no longer holds.
    expect((next.transit_groups as any[])[0].price).toEqual({ amount: 268, currency: "EUR" });
  });

  it("never stamps a fare the plan did not quote", () => {
    const content = contentWithRestatedFlight();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    // basePlan()'s new_flight carries a cost but NO currency ⇒ unusable.
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      basePlan(),
      replacementOperational(),
    );
    expect((next.transit_groups as any[])[0].price).toEqual({ amount: 280, currency: "EUR" });
  });

  it("retitles, retimes and reprices the day item restating the leg", () => {
    const content = contentWithRestatedFlight();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      replacementOperational(),
    );
    const item = (next.itinerary as any[])[0].items[0];
    expect(item.title).toBe("Flight IB3125 CDG → LIS");
    expect(item.time).toBe("14:00");
    expect(item.cost).toEqual({ amount: 268, currency: "EUR" });
    expect(item.booking_reference).toBe("SWARM-NEW1");
    // It must stay on its own day — never spliced to another one.
    expect((next.itinerary as any[]).length).toBe(1);
  });

  it("grows a recorded payment by the net payable, in that currency only", () => {
    const content = contentWithRestatedFlight() as any;
    content.transit_groups[0].paid = true;
    content.transit_groups[0].paid_amount = 280;
    content.transit_groups[0].paid_currency = "EUR";
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      replacementOperational(),
    );
    // 280 already paid + 13 due today = the real out-of-pocket for this leg.
    expect((next.transit_groups as any[])[0].paid_amount).toBe(293);
    expect((next.transit_groups as any[])[0].paid_currency).toBe("EUR");
  });

  it("leaves a recorded payment alone when the plan charges another currency", () => {
    const content = contentWithRestatedFlight() as any;
    content.transit_groups[0].paid = true;
    content.transit_groups[0].paid_amount = 320;
    content.transit_groups[0].paid_currency = "USD";
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      replacementOperational(),
    );
    // Mixing currencies into one paid_amount would silently corrupt the budget.
    expect((next.transit_groups as any[])[0].paid_amount).toBe(320);
    expect((next.transit_groups as any[])[0].paid_currency).toBe("USD");
  });
});

describe("settlement records the replacement journey's shape on the leg", () => {
  /** Plan whose replacement is a 6h one-stop via Madrid. */
  function oneStopPlan(): ResolutionPlan {
    return {
      ...basePlan(),
      proposed_resolution: {
        new_flight: {
          id: "ATL-OFR-2",
          cost: 268,
          currency: "EUR",
          stops: 1,
          stopAirports: ["MAD"],
          durationMinutes: 360,
        },
        rescheduled_activities: [],
      },
      financial_delta: { total_refund: 0, total_new_charges: 25, net_payable: 25 },
    };
  }

  it("writes stops, layovers and the new duration onto the leg", () => {
    const content = contentWithRestatedFlight();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      oneStopPlan(),
      replacementOperational(),
    );
    const leg = (next.transit_groups as any[])[0];
    expect(leg.stops).toBe(1);
    expect(leg.stop_airports).toEqual(["MAD"]);
    // 14:00 → 20:00 — the leg must stop describing the OLD 2.5 h journey.
    expect(leg.durationHrs).toBe(6);
  });

  it("marks a non-stop replacement with an empty layover list", () => {
    const content = contentWithRestatedFlight();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const plan = oneStopPlan();
    plan.proposed_resolution.new_flight = {
      id: "ATL-OFR-1",
      cost: 412,
      currency: "EUR",
      stops: 0,
      durationMinutes: 150,
    };
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      plan,
      replacementOperational(),
    );
    const leg = (next.transit_groups as any[])[0];
    // 0 with an explicit empty list ⇒ the timeline can say "Non-stop"; a
    // MISSING stops field means unknown and must stay silent.
    expect(leg.stops).toBe(0);
    expect(leg.stop_airports).toEqual([]);
  });

  it("derives the duration from the new times when the plan quotes none", () => {
    const content = contentWithRestatedFlight();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    // basePlan()'s new_flight carries no durationMinutes at all.
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      basePlan(),
      replacementOperational(),
    );
    expect((next.transit_groups as any[])[0].durationHrs).toBe(6);
  });

  it("leaves routing untouched when the plan describes none", () => {
    const content = contentWithRestatedFlight();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      basePlan(),
      replacementOperational(),
    );
    const leg = (next.transit_groups as any[])[0];
    // Never claim "Non-stop" about a routing the swarm could not read.
    expect(leg.stops).toBeUndefined();
    expect(leg.stop_airports).toBeUndefined();
  });
});

describe("leg stamps are read and written as wall clock", () => {
  it("normalizes every shape the generator or a provider may write", () => {
    expect(toLegStamp("2026-12-22T08:00")).toBe("2026-12-22T08:00");
    expect(toLegStamp("2026-12-22T08:00:00Z")).toBe("2026-12-22T08:00");
    expect(toLegStamp("2026-12-22T08:00:00.000+09:00")).toBe("2026-12-22T08:00");
    expect(toLegStamp("2026-12-22 08:00")).toBe("2026-12-22T08:00");
    expect(toLegStamp("2026-12-22T8:05")).toBe("2026-12-22T08:05");
    expect(toLegStamp("2026-12-22")).toBe("2026-12-22T00:00");
    // A bare offset is not a clock time.
    expect(toLegStamp("2026-12-22+09:00")).toBe("2026-12-22T00:00");
    expect(toLegStamp("22 Dec 08:00")).toBeNull();
  });

  it("settles a Z-suffixed replacement as the local time the traveler boards", () => {
    const content = contentWithRestatedFlight();
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content)!;
    const operational = {
      ...replacementOperational(),
      new_flight: {
        reference: "IB3125",
        // What a provider hands back: an instant with a zone.
        depart: `${day1Date}T14:10:00.000Z`,
        arrive: `${day1Date}T20:00:00.000Z`,
        carrier: "Iberia",
      },
    };
    const { content: next } = applySettlementToContent(
      content,
      hydrated.nodeRefs,
      pricedPlan(),
      operational,
    );
    const leg = (next.transit_groups as any[])[0];
    // The timeline reads these digits literally, so they must be the digits
    // the traveler was shown — never a UTC restatement of them.
    expect(leg.depart).toBe(`${day1Date}T14:10`);
    expect(leg.arrive).toBe(`${day1Date}T20:00`);
  });

  it("hydrates a leg whose stamps carry a zone offset", () => {
    const content = contentWithRestatedFlight() as any;
    content.transit_groups[0].depart = `${day1Date}T09:00:00+09:00`;
    content.transit_groups[0].arrive = `${day1Date}T11:30:00+09:00`;
    const hydrated = hydrateTripFromContent("t", "", "Lisbon", content);
    // 09:00 as WRITTEN, not 00:00 UTC — an offset must not move the leg.
    expect(hydrated!.nodeRefs["flight-0"].time).toBe(Date.parse(`${day1Date}T09:00:00Z`));
  });
});
