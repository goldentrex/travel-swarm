/**
 * What a replacement flight COSTS the rest of the trip.
 *
 * The swarm could already rebook a traveller and re-time the day they land on.
 * What it could not do was notice that landing two days late means the first
 * two hotel nights are gone, four activities are unreachable, and — in the
 * worst case — that the flight arrives after the trip it belongs to is over.
 *
 * That gap produced the worst plan the system has shown: a traveller who
 * missed a 23 Dec departure was offered 28 Dec, and nothing anywhere asked
 * what happens to 23–27. A departure ceiling stops the extreme case; this
 * answers the question that actually matters for every candidate inside it —
 * "what do I lose if I take this?" — so a plan can be rejected when it is not
 * a solution at all, and priced honestly when it is.
 *
 * Pure: no network, no clock. Everything is derived from the graph the
 * traveller's own itinerary was hydrated into.
 */

import type { ItineraryGraph } from "./ItineraryGraph";
import type { ItineraryNode } from "./types";

const MINUTE_MS = 60_000;

/**
 * How long the night a check-in buys actually lasts.
 *
 * Not 24h: a room checked into around 15:00 is given up around 11:00 the next
 * morning. Using a full day made the arithmetic say a traveller landing two
 * days late still "caught" the second night, because they arrived two hours
 * before its 24h window closed. They did not — that night was spent in an
 * airport.
 */
const NIGHT_MS = 20 * 60 * MINUTE_MS;

/**
 * When a node stops being reachable — the instant after which landing means
 * you missed it.
 *
 * A hotel check-in is the subtle one. Arriving after the check-in TIME does
 * not lose you the night: you check in late, and the graph already defers the
 * node for exactly that reason. A night is lost only once the night itself is
 * over, so the check-in node is treated as reaching to the end of the night it
 * buys. Using the check-in time alone reported a lost night for a traveller
 * landing three hours late, which is simply not true.
 */
function endOf(node: ItineraryNode): number {
  switch (node.type) {
    case "flight":
      return node.arrivalTime;
    case "transfer":
    case "activity":
      return node.scheduledTime + node.durationMinutes * MINUTE_MS;
    case "hotel_check_in":
      return node.scheduledTime + NIGHT_MS;
  }
}

/** One thing the traveller loses, named the way they would name it. */
export interface LostItem {
  nodeId: string;
  type: ItineraryNode["type"];
  /** Human label — the activity's name, the hotel's name, the flight number. */
  label: string;
  /** When it was supposed to happen. */
  scheduledTime: number;
}

export interface TripConsequence {
  /** Everything that is over before the traveller lands. */
  lost: LostItem[];
  /** How many nights of accommodation are wasted. */
  nightsLost: number;
  /** How many planned activities become unreachable. */
  activitiesLost: number;
  /**
   * NOTHING downstream survives — the replacement lands after the last thing
   * the trip had planned. This is not a rebooking; the traveller would fly out
   * to an itinerary that has already finished.
   */
  arrivesAfterTripEnds: boolean;
  /** Whole days between the original arrival and the new one, rounded down. */
  daysLost: number;
}

/**
 * Evaluate a candidate arrival against everything still ahead of the traveller.
 *
 * `fromMs` scopes the walk to the part of the trip that has not happened yet —
 * the original departure of the disrupted flight. Nodes before it are already
 * behind the traveller and cannot be "lost" by a rebooking.
 */
export function evaluateTripConsequence(
  graph: ItineraryGraph,
  /** Arrival time of the candidate replacement flight, epoch ms. */
  newArrivalMs: number,
  /** Scope: only nodes at or after this instant are still in play. */
  fromMs: number,
  /** The disrupted flight itself — never counted as a loss, it is being replaced. */
  disruptedNodeId?: string,
): TripConsequence {
  const lost: LostItem[] = [];
  let survivors = 0;
  let originalArrivalMs: number | undefined;

  for (const node of graph.getNodes()) {
    if (node.id === disruptedNodeId) {
      if (node.type === "flight") originalArrivalMs = node.arrivalTime;
      continue;
    }
    // Already behind the traveller — a rebooking cannot cost them this.
    if (endOf(node) < fromMs) continue;

    if (endOf(node) <= newArrivalMs) {
      lost.push({
        nodeId: node.id,
        type: node.type,
        label: labelOf(node),
        scheduledTime: node.scheduledTime,
      });
    } else {
      survivors += 1;
    }
  }

  const nightsLost = lost.filter((item) => item.type === "hotel_check_in").length;
  const activitiesLost = lost.filter((item) => item.type === "activity").length;

  // Days lost is measured against the ORIGINAL arrival when we know it: the
  // traveller loses the gap between when they should have landed and when they
  // now will, not the gap since some arbitrary anchor.
  // Only a FINITE baseline can produce a day count. `fromMs` is deliberately
  // allowed to be -Infinity by callers that mean "consider the whole trip",
  // and subtracting that yielded "You arrive Infinity days late" — a sentence
  // shown to a real traveller is not the place to discover a sentinel value.
  const baseline = originalArrivalMs ?? fromMs;
  const daysLost = Number.isFinite(baseline)
    ? Math.max(0, Math.floor((newArrivalMs - baseline) / (24 * 60 * MINUTE_MS)))
    : 0;

  return {
    lost,
    nightsLost,
    activitiesLost,
    // Only meaningful when the trip HAD something downstream to lose: a trip
    // whose graph holds nothing after the flight is not "over", it simply was
    // never planned past that point.
    arrivesAfterTripEnds: survivors === 0 && lost.length > 0,
    daysLost,
  };
}

function labelOf(node: ItineraryNode): string {
  switch (node.type) {
    case "flight":
      return node.flightNumber ?? "Flight";
    case "transfer":
      return "Transfer";
    case "hotel_check_in":
      return node.hotelName;
    case "activity":
      return node.name;
  }
}

/**
 * One sentence a traveller can act on, or null when a plan costs them nothing.
 *
 * Deliberately concrete: "you lose 2 nights and 4 activities" is a decision,
 * "some itinerary items are affected" is not.
 */
export function describeTripConsequence(consequence: TripConsequence): string | null {
  if (consequence.lost.length === 0) return null;
  if (consequence.arrivesAfterTripEnds) {
    return "This lands after everything left in your trip — there would be nothing to arrive for.";
  }
  const parts: string[] = [];
  if (consequence.nightsLost > 0) {
    parts.push(`${consequence.nightsLost} night${consequence.nightsLost > 1 ? "s" : ""}`);
  }
  if (consequence.activitiesLost > 0) {
    parts.push(
      `${consequence.activitiesLost} activit${consequence.activitiesLost > 1 ? "ies" : "y"}`,
    );
  }
  if (parts.length === 0) return null;
  const dayPrefix =
    consequence.daysLost >= 1
      ? `You arrive ${consequence.daysLost} day${consequence.daysLost > 1 ? "s" : ""} late: `
      : "You lose ";
  return `${dayPrefix}${parts.join(" and ")} you had planned.`;
}
