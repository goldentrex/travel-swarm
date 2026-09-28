/**
 * Type definitions for the itinerary dependency graph (Level-4 core).
 *
 * An itinerary is modelled as a DAG: nodes are timed itinerary events
 * (flights, transfers, hotel check-ins, activities) and edges encode
 * "depends on" relationships. A delay to any node propagates through the
 * graph to every downstream dependent.
 *
 * Zero third-party dependencies — pure TypeScript.
 */

/** A simple minute-granularity duration. `handleDisruption` also accepts a raw number (minutes). */
export interface Duration {
  minutes: number;
}

/**
 * Lifecycle status of an itinerary node:
 * - `on_track`: unaffected, schedule holds.
 * - `delayed`: the disruption source itself.
 * - `updated`: automatically re-timed by propagation (e.g. hotel check-in pushed back).
 * - `requires_rescheduling`: cannot hold, needs a new booking / slot (e.g. an activity in the impact window).
 * - `conflict`: hard constraint violated (e.g. transfer pickup before flight lands).
 */
export type NodeStatus = "on_track" | "delayed" | "updated" | "requires_rescheduling" | "conflict";

/** Fields common to every itinerary node. Times are epoch milliseconds (UTC). */
export interface ItineraryNodeBase {
  id: string;
  /** Primary scheduled time of the node (departure for flights, pickup for transfers, etc.). */
  scheduledTime: number;
  status: NodeStatus;
  /** Ids of upstream nodes this node depends on. */
  dependsOn: string[];
}

/**
 * One flown hop inside a flight leg. A one-stop ticket is ONE leg (one
 * booking, one node, one fare) made of two of these; the change of planes
 * lives between them, inside the leg, not between two legs of the itinerary.
 * Times follow the app's convention: wall-clock at the hop's own airport,
 * stored as epoch ms with a `Z` — so the arrival of one hop and the departure
 * of the next are on the same clock, the one at the airport they share.
 */
export interface FlightHop {
  /** This hop's own flight number when the booking states it. */
  reference?: string;
  carrier?: string;
  /** IATA codes (a city name only when the booking carried no code). */
  from: string;
  to: string;
  departureTime: number;
  arrivalTime: number;
}

export interface FlightNode extends ItineraryNodeBase {
  type: "flight";
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: number;
  arrivalTime: number;
  /** Minimum connection buffer (minutes) required before this flight. */
  minConnectionMinutes?: number;
  /**
   * NEW (additive) — the hop-by-hop routing of a leg that changes planes, in
   * flown order and contiguous (each hop leaves from where the previous one
   * landed; the first leaves from `origin`, the last lands at `destination`).
   * Absent for a non-stop leg and for a leg whose routing the booking never
   * described — a half-described journey is dropped whole rather than kept
   * as a guess. Never fewer than two entries when present.
   */
  segments?: FlightHop[];
  /** Geographic location code (e.g. airport IATA code) where this flight lands. */
  arrivalLocationId?: string;
  /**
   * NEW (additive) — booking facts carried when hydration knows them: the
   * leg's TOTAL fare for the whole party (paid amount outranks the plan
   * price). Reference for the true fare-delta rebooking math; absent when
   * the content carries no usable price (iOS omits the price the same way).
   */
  fare?: { amount: number; currency: string };
  /**
   * NEW (additive) — number of passengers booked on this leg (>= 1), from
   * the leg's own traveler list or, failing that, the trip's party size.
   * Absent when neither is known.
   */
  travelers?: number;
  /**
   * NEW (additive) — the cabin the traveller actually booked ("economy",
   * "premium_economy", "business", "first"), normalised from the leg's own
   * `cabin` field. A rebooking must search the SAME cabin: putting a
   * business-class traveller back in economy is not a recovery, it is a
   * downgrade nobody asked for. Absent when the content never said.
   */
  cabin?: string;
}

export interface TransferNode extends ItineraryNodeBase {
  type: "transfer";
  /** Estimated ride duration in minutes. */
  durationMinutes: number;
  /** Minimum slack (minutes) between upstream arrival and this pickup. */
  minBufferMinutes?: number;
  /** Geographic location code (e.g. airport IATA code) where the transfer picks up. */
  pickupLocationId?: string;
  /**
   * The leg's own two ends, when the trip knows them.
   *
   * A ground leg is the thing a transit strike actually breaks, and without
   * its endpoints the swarm could not even ask how else to cover it — it
   * would answer about some other journey, or about nothing.
   */
  from?: { lat: number; lng: number };
  to?: { lat: number; lng: number };
  /** Human labels for those ends ("Tokyo", "Osaka"), for the route line. */
  fromLabel?: string;
  toLabel?: string;
}

export interface HotelCheckInNode extends ItineraryNodeBase {
  type: "hotel_check_in";
  hotelName: string;
  /**
   * Where the property is, when the trip knows. This is one end of almost
   * every ground question a stranded traveller has — "how do I get from here
   * to the airport now that my ride is gone" — and without it the swarm could
   * only talk about the itinerary, never about the journey between its items.
   */
  coordinates?: { lat: number; lng: number };
}

export interface ActivityNode extends ItineraryNodeBase {
  type: "activity";
  name: string;
  durationMinutes: number;
  /**
   * Where the venue is, when the trip knows (8 of 8 activities carried one on
   * a real trip). It is what lets the swarm ask the venue's OWN schedule
   * whether a re-planned slot is possible, instead of guessing or asking a
   * model to guess — a name alone resolves to the wrong entity too often.
   */
  coordinates?: { lat: number; lng: number };
}

export type ItineraryNode = FlightNode | TransferNode | HotelCheckInNode | ActivityNode;

export type ItineraryNodeType = ItineraryNode["type"];

/** The handling action taken for a node hit by propagated delay. */
export type DisruptionAction = "updated" | "requires_rescheduling" | "conflict";

/** One entry of {@link DisruptionResult.affected}. */
export interface AffectedNodeReport {
  nodeId: string;
  nodeType: ItineraryNodeType;
  action: DisruptionAction;
  previousScheduledTime: number;
  /** Present when the node was re-timed (action `updated`). */
  newScheduledTime?: number;
  /** Human-readable justification, safe to surface in a ResolutionPlan. */
  reason: string;
}

/** Structured outcome of {@link ItineraryGraph.handleDisruption}. */
export interface DisruptionResult {
  sourceNodeId: string;
  delayMinutes: number;
  /** Every downstream node the delay reached, with its handling action. */
  affected: AffectedNodeReport[];
}

/** Tunable propagation thresholds. */
export interface DisruptionPropagationOptions {
  /**
   * Activities scheduled inside OR touching `affected upstream completion +
   * buffer` are marked `requires_rescheduling` (e.g. a surf lesson 2h after
   * landing). Default: 120 minutes.
   */
  activityBufferMinutes?: number;
  /** Minimum connection buffer for downstream flights. Default: 45 minutes. */
  defaultMinConnectionMinutes?: number;
  /** Minimum slack for transfer pickups. Default: 15 minutes. */
  defaultTransferBufferMinutes?: number;
  /** NEW (spec §4): If the disruption source rebooks to a different airport, inject it here for spatial propagation. */
  newArrivalLocationId?: string;
}
