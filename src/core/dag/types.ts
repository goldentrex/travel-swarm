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

export interface FlightNode extends ItineraryNodeBase {
  type: "flight";
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: number;
  arrivalTime: number;
  /** Minimum connection buffer (minutes) required before this flight. */
  minConnectionMinutes?: number;
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
}

export interface HotelCheckInNode extends ItineraryNodeBase {
  type: "hotel_check_in";
  hotelName: string;
}

export interface ActivityNode extends ItineraryNodeBase {
  type: "activity";
  name: string;
  durationMinutes: number;
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
