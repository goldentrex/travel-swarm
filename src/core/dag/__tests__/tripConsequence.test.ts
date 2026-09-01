/**
 * "What do I lose if I take this plan?"
 *
 * The swarm could rebook a flight and re-time the arrival day, but nothing
 * asked what a late arrival does to the REST of the trip. That is how a
 * traveller who missed a 23 Dec departure was offered 28 Dec: every rule
 * passed, and the five nights and dozen activities in between were simply
 * never looked at.
 */

import { describe, expect, it } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { describeTripConsequence, evaluateTripConsequence } from "@/core/dag/tripConsequence";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** 23 Dec 06:10 UTC — the departure the traveller actually missed. */
const DEPART = Date.parse("2026-12-23T06:10:00Z");
const ARRIVE = Date.parse("2026-12-23T17:20:00Z");

/** A week-long trip: the flight, four nights, and one activity per day. */
function tripGraph(): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: "flight-0",
    type: "flight",
    scheduledTime: DEPART,
    arrivalTime: ARRIVE,
    departureTime: DEPART,
    origin: "SIN",
    destination: "CTS",
    flightNumber: "TR892",
    status: "on_track",
    dependsOn: [],
  });
  for (let night = 0; night < 4; night += 1) {
    graph.addNode({
      id: `hotel-${night}`,
      type: "hotel_check_in",
      scheduledTime: ARRIVE + night * DAY + 2 * HOUR,
      hotelName: "Keio Plaza",
      status: "on_track",
      dependsOn: night === 0 ? ["flight-0"] : [],
    });
    graph.addNode({
      id: `activity-${night}`,
      type: "activity",
      scheduledTime: ARRIVE + night * DAY + 20 * HOUR,
      durationMinutes: 120,
      name: `Day ${night + 1} outing`,
      status: "on_track",
      dependsOn: [],
    });
  }
  return graph;
}

describe("what a late arrival costs the rest of the trip", () => {
  it("costs nothing when the replacement lands the same day", () => {
    const c = evaluateTripConsequence(tripGraph(), ARRIVE + 3 * HOUR, DEPART, "flight-0");
    expect(c.lost).toEqual([]);
    expect(c.nightsLost).toBe(0);
    expect(c.activitiesLost).toBe(0);
    expect(c.arrivesAfterTripEnds).toBe(false);
    expect(describeTripConsequence(c)).toBeNull();
  });

  it("names exactly what a two-day slip destroys", () => {
    const c = evaluateTripConsequence(tripGraph(), ARRIVE + 2 * DAY, DEPART, "flight-0");
    // Nights 1 and 2 are gone; the day-1 and day-2 outings are over.
    expect(c.nightsLost).toBe(2);
    expect(c.activitiesLost).toBe(2);
    expect(c.daysLost).toBe(2);
    expect(c.arrivesAfterTripEnds).toBe(false);
    expect(describeTripConsequence(c)).toBe(
      "You arrive 2 days late: 2 nights and 2 activities you had planned.",
    );
  });

  it("recognises a replacement that lands after the trip is over", () => {
    // The 28 Dec case. Nothing survives — the traveller would fly out to an
    // itinerary that already finished.
    const c = evaluateTripConsequence(tripGraph(), ARRIVE + 5 * DAY, DEPART, "flight-0");
    expect(c.arrivesAfterTripEnds).toBe(true);
    expect(describeTripConsequence(c)).toBe(
      "This lands after everything left in your trip — there would be nothing to arrive for.",
    );
  });

  it("never counts the disrupted flight itself as a loss", () => {
    // It is being REPLACED, not lost — counting it would inflate every plan.
    const c = evaluateTripConsequence(tripGraph(), ARRIVE + 2 * DAY, DEPART, "flight-0");
    expect(c.lost.some((item) => item.nodeId === "flight-0")).toBe(false);
  });

  it("ignores what is already behind the traveller", () => {
    // A node that finished before the disrupted departure cannot be lost by a
    // rebooking — it already happened.
    const graph = tripGraph();
    graph.addNode({
      id: "activity-past",
      type: "activity",
      scheduledTime: DEPART - 2 * DAY,
      durationMinutes: 60,
      name: "Pre-trip dinner",
      status: "on_track",
      dependsOn: [],
    });
    const c = evaluateTripConsequence(graph, ARRIVE + 2 * DAY, DEPART, "flight-0");
    expect(c.lost.some((item) => item.nodeId === "activity-past")).toBe(false);
  });

  it("never says 'Infinity days late' when the walk has no anchor", () => {
    // Callers pass -Infinity for `fromMs` to mean "consider the whole trip".
    // Subtracting that produced the sentence "You arrive Infinity days late:
    // 11 activities you had planned", which reached a live plan payload.
    const c = evaluateTripConsequence(
      tripGraph(),
      ARRIVE + 2 * DAY,
      Number.NEGATIVE_INFINITY,
      undefined,
    );
    expect(Number.isFinite(c.daysLost)).toBe(true);
    expect(describeTripConsequence(c)).not.toContain("Infinity");
  });

  it("does not call an itinerary 'over' when it was never planned past the flight", () => {
    // A one-leg graph has nothing downstream. That is not the same as arriving
    // after the trip ended, and reporting it as such would refuse every
    // perfectly good rebooking on a thin itinerary.
    const graph = new ItineraryGraph();
    graph.addNode({
      id: "flight-0",
      type: "flight",
      scheduledTime: DEPART,
      arrivalTime: ARRIVE,
      departureTime: DEPART,
      origin: "SIN",
      destination: "CTS",
      flightNumber: "TR892",
      status: "on_track",
      dependsOn: [],
    });
    const c = evaluateTripConsequence(graph, ARRIVE + 5 * DAY, DEPART, "flight-0");
    expect(c.arrivesAfterTripEnds).toBe(false);
    expect(describeTripConsequence(c)).toBeNull();
  });

  it("reports a loss with no whole day slipped as a plain loss, not '0 days late'", () => {
    // The day-1 outing runs ARRIVE+20h → ARRIVE+22h. Landing at +23h misses it,
    // but less than a full day has slipped, so the copy must not say "1 day".
    const c = evaluateTripConsequence(tripGraph(), ARRIVE + 23 * HOUR, DEPART, "flight-0");
    expect(c.daysLost).toBe(0);
    expect(c.activitiesLost).toBeGreaterThan(0);
    expect(describeTripConsequence(c)).toMatch(/^You lose /);
  });

  it("a late check-in is NOT a lost night — you check in late", () => {
    // Landing three hours after the check-in slot costs nothing: the graph
    // defers the check-in, and the room is still yours that night.
    const c = evaluateTripConsequence(tripGraph(), ARRIVE + 5 * HOUR, DEPART, "flight-0");
    expect(c.nightsLost).toBe(0);
  });
});
