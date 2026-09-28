/**
 * WHICH stretch of ground is actually at stake.
 *
 * "The metro is on strike" and "my taxi never came" are not questions about
 * the itinerary; they are questions about a journey BETWEEN two of its items,
 * and the engine had no way even to name that journey. This module names it,
 * deterministically, from the graph alone: where the traveller is, where they
 * must be, by when, and how much slack that place demands on arrival.
 *
 * It decides nothing and calls nothing. It answers "what should we look up",
 * so that the lookup (real durations, from {@link GroundLink}) and the writing
 * (what the traveller reads) stay separable and testable apart.
 *
 * WHEN IT RETURNS NULL: whenever the trip does not pin down both ends. A
 * commitment we cannot place on the map is one we must not talk about, because
 * every sentence downstream would be about a journey we invented.
 */

import type { ItineraryNode } from "../dag/types";
import { AIRPORTS } from "../sanity/airports";
import { departureFloorMinutes } from "../sanity/invariants";
import type { GroundPoint } from "./groundLink";

/** The journey the traveller has to make, and the deadline that makes it urgent. */
export interface GroundCommitment {
  from: GroundPoint;
  fromLabel: string;
  to: GroundPoint;
  toLabel: string;
  /** The instant the thing they must catch happens. */
  arriveByMs: number;
  /** Minutes they must already be there, before that instant. */
  bufferMinutes: number;
  /** What is at stake, in words: "Flight NH 175 departs 17:05". */
  deadlineLabel: string;
  /** The node that sets the deadline — so a caller can avoid double-handling it. */
  deadlineNodeId: string;
}

function coordsOf(node: ItineraryNode): GroundPoint | null {
  if (node.type === "activity" || node.type === "hotel_check_in") {
    const c = node.coordinates;
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) return { lat: c.lat, lng: c.lng };
  }
  return null;
}

function labelOf(node: ItineraryNode): string {
  if (node.type === "activity") return node.name;
  if (node.type === "hotel_check_in") return node.hotelName;
  return node.id;
}

/**
 * Where the traveller is setting off FROM: the last placeable thing on their
 * itinerary before the deadline.
 *
 * A hotel outranks an activity at the same moment — at the hours these
 * missions happen the traveller is far more often at their accommodation than
 * mid-visit, and a hotel is a place you leave FROM in a way a walking tour is
 * not.
 */
function originBefore(
  nodes: ItineraryNode[],
  beforeMs: number,
  excludeId: string,
  /** Set only for an airport run — see {@link ALREADY_AT_AIRPORT_KM}. */
  terminal?: GroundPoint,
): ItineraryNode | null {
  const placeable = nodes
    .filter((n) => {
      if (n.id === excludeId || n.scheduledTime > beforeMs) return false;
      const here = coordsOf(n);
      if (here === null) return false;
      // Somewhere you already are is not somewhere you travel from.
      return !terminal || distanceKm(here, terminal) > ALREADY_AT_AIRPORT_KM;
    })
    .sort((a, b) => b.scheduledTime - a.scheduledTime);
  if (placeable.length === 0) return null;
  const mostRecentMs = placeable[0].scheduledTime;
  const sameMoment = placeable.filter((n) => n.scheduledTime === mostRecentMs);
  return sameMoment.find((n) => n.type === "hotel_check_in") ?? placeable[0];
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/**
 * The next thing the traveller has to physically get to.
 *
 * A flight wins over everything else: it is the only commitment on a trip that
 * cannot be re-timed by showing up late, and it is the one the traveller is
 * asking about when they say their ride to the airport is gone. Failing that,
 * the next timed activity — a tour with a start time is a real deadline too.
 */
/**
 * Within this of the AIRPORT you are already at the airport, so there is no
 * ride to re-plan. The same three kilometres `timingRisk` uses to decide a
 * traveller is at the terminal rather than on their way to it.
 *
 * It earns its place: without it, the most recent placeable item before a
 * flight is often "Kansai Airport Departure & Duty-Free", and the engine
 * answered a transit strike with "Car or taxi: about 1 min" — true, and
 * useless.
 *
 * It is deliberately NOT applied in town. Two kilometres across Rome is a
 * genuine journey a strike can break; two kilometres from a terminal is the
 * terminal. Applying one rule to both refused to answer for a hotel 1.9 km
 * from the Colosseum.
 */
const ALREADY_AT_AIRPORT_KM = 3;

function distanceKm(a: GroundPoint, b: GroundPoint): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface GroundCommitmentOptions {
  /**
   * The node the traveller's mission is ABOUT. When it is a ground leg with
   * both ends known — the Tokyo→Osaka train a strike is closing — that leg is
   * the journey to answer for, ahead of anything merely chronological.
   */
  disruptedNodeId?: string;
  /**
   * The traveller named the airport, so only an airport run is an answer.
   *
   * Live on 2026-09-18, "My taxi to the airport is cancelled" was answered
   * with the walk from their hotel to a lunch reservation — real durations,
   * for a journey nobody had asked about. When the question names the
   * airport, answering about anything else is worse than saying nothing.
   */
  mustBeAirportRun?: boolean;
}

export function nextGroundCommitment(
  nodes: ItineraryNode[],
  nowMs: number,
  options: GroundCommitmentOptions = {},
): GroundCommitment | null {
  // No horizon. An earlier version only looked 36 hours ahead, which sounded
  // sensible and was a number I made up: it silently refused to answer on
  // every trip that had not started yet, which is most of them. If a traveller
  // says their ride is gone, the ride they mean is the next one, whenever it
  // is — and Routes models traffic for a future hour perfectly well.
  //
  // KNOWN IMPRECISION: `scheduledTime` is wall-clock local (the app's storage
  // convention) and `nowMs` is a real instant, so "upcoming" is off by the
  // destination's UTC offset. On a trip already under way that can pick a leg
  // a few hours either side of the right one. It is left as-is deliberately:
  // every other selection in the swarm compares the same two frames, and the
  // commitment is always NAMED to the traveller ("Flight AZ 328 departs
  // 18:00") so a wrong one is visible rather than silent. The place this
  // error actually hurt — pricing traffic at the wrong hour — is resolved
  // properly in `ground-options`, from the destination's real offset.
  const upcoming = nodes
    .filter((n) => n.scheduledTime >= nowMs)
    .sort((a, b) => a.scheduledTime - b.scheduledTime);

  // The broken leg itself, when the mission names one and the trip placed both
  // of its ends. A strike on the Tokyo→Osaka train is a question about Tokyo →
  // Osaka, and answering about the airport run instead is answering somebody
  // else's question.
  //
  // Unless they named the airport. On a trip that HAS a ground leg — the
  // Tokyo→Osaka train — the mission parser targets it, so "my taxi to the
  // airport is cancelled" would have been answered with the Tokyo→Osaka
  // journey. What the traveller said wins over what the parser could target.
  if (options.disruptedNodeId && !options.mustBeAirportRun) {
    const disrupted = nodes.find((n) => n.id === options.disruptedNodeId);
    if (disrupted?.type === "transfer" && disrupted.from && disrupted.to) {
      return {
        from: disrupted.from,
        fromLabel: disrupted.fromLabel ?? "your departure point",
        to: disrupted.to,
        toLabel: disrupted.toLabel ?? "your destination",
        // Measured against the ARRIVAL, because that is what the rest of the
        // day is pinned to — and because the set-off times below are derived
        // from it. Naming the departure instead put "leg leaves 09:30" beside
        // "set off by 05:28" and read as a contradiction.
        arriveByMs: disrupted.scheduledTime + disrupted.durationMinutes * 60_000,
        bufferMinutes: departureFloorMinutes("ground"),
        deadlineLabel: `Your ${disrupted.fromLabel ?? "ground"} → ${
          disrupted.toLabel ?? "onward"
        } leg is due in at ${hhmm(disrupted.scheduledTime + disrupted.durationMinutes * 60_000)}`,
        deadlineNodeId: disrupted.id,
      };
    }
  }

  // Chronological, and a flight does not jump the queue.
  //
  // An earlier version searched every flight FIRST, which is right when the
  // traveller named the airport and wrong otherwise. Live on 2026-09-18,
  // "Transit strike tomorrow" in Rome was answered with the run to Fiumicino
  // for a flight days away — a real journey, on the wrong day. The strike is
  // tomorrow; the journey that matters is tomorrow's.
  //
  // `mustBeAirportRun` still forces the airport, because that is the traveller
  // saying which journey they mean.
  for (const node of upcoming) {
    if (node.type === "activity" && !options.mustBeAirportRun) {
      const to = coordsOf(node);
      if (!to) continue;
      const origin = originBefore(nodes, node.scheduledTime, node.id);
      const from = origin ? coordsOf(origin) : null;
      if (!origin || !from) continue;
      return {
        from,
        fromLabel: labelOf(origin),
        to,
        toLabel: node.name,
        arriveByMs: node.scheduledTime,
        bufferMinutes: 0,
        deadlineLabel: `${node.name} starts ${hhmm(node.scheduledTime)}`,
        deadlineNodeId: node.id,
      };
    }
    if (node.type !== "flight") continue;
    const airport = AIRPORTS[node.origin?.toUpperCase() ?? ""];
    if (!airport) continue;
    const origin = originBefore(nodes, node.departureTime, node.id, {
      lat: airport.lat,
      lng: airport.lng,
    });
    const from = origin ? coordsOf(origin) : null;
    if (!origin || !from) continue;
    const legMinutes = Math.round((node.arrivalTime - node.departureTime) / 60_000);
    return {
      from,
      fromLabel: labelOf(origin),
      to: { lat: airport.lat, lng: airport.lng },
      toLabel: `${airport.city} (${node.origin.toUpperCase()})`,
      arriveByMs: node.departureTime,
      bufferMinutes: departureFloorMinutes("flight", legMinutes),
      deadlineLabel: `Flight ${node.flightNumber} departs ${hhmm(node.departureTime)}`,
      deadlineNodeId: node.id,
    };
  }

  // They asked about the airport and we cannot place a single airport run.
  // Silence is the answer; a different journey is not.
  return null;
}

/**
 * Does this mission turn on getting from A to B?
 *
 * Deliberately narrow. A broad reading would drag ordinary rescheduling
 * missions into the ground rail and spend a paid lookup on them; these words
 * are the ones travellers use when the MOVEMENT itself has failed.
 */
const GROUND_TROUBLE = new RegExp(
  [
    "strike",
    "gr[èe]ve",
    "huelga",
    "streik",
    "taxi",
    "uber",
    "cab\\b",
    "lift\\b",
    "ride\\b",
    "pickup",
    "pick-up",
    "transfer",
    "shuttle",
    "navette",
    "metro",
    "m[ée]tro",
    "subway",
    "underground",
    "tube\\b",
    "tram",
    "\\bbus\\b",
    "train",
  ].join("|"),
  "i",
);

/** Words that mean the connection is GONE, not merely inconvenient. */
const GROUND_FAILURE =
  /\b(cancel\w*|annul\w*|strike|gr[èe]ve|huelga|streik|no[- ]?show|never (came|showed|turned)|didn'?t (come|show|arrive|turn)|stranded|stuck|missed|gone)\b/i;

/**
 * The FLIGHT is the thing that broke, so this is not a ground problem however
 * many ground words the sentence happens to carry.
 *
 * Without this, "my flight is cancelled because of an air traffic control
 * strike" reads as ground trouble ("strike") plus a failure ("cancelled") —
 * and a ground mission stands the flight rail down. The traveller would be
 * told how to reach an airport for a plane that is not going anywhere.
 */
const FLIGHT_IS_THE_CASUALTY =
  /\b(flight|vol|vuelo|flug)\b[^.!?]{0,40}\b(cancel\w*|annul\w*|delay\w*|miss\w*|grounded)\b|\b(cancel\w*|annul\w*|delay\w*|miss\w*)\b[^.!?]{0,40}\b(flight|vol|vuelo|flug)\b/i;

export function isGroundMission(description: string): boolean {
  if (FLIGHT_IS_THE_CASUALTY.test(description)) return false;
  return GROUND_TROUBLE.test(description) && GROUND_FAILURE.test(description);
}

/** The traveller named the airport, in any language the app ships. */
const NAMES_AIRPORT = /\b(airport|a[ée]roport|aeropuerto|flughafen|aeroporto)\b|空港|机场|機場/i;

export function namesAirport(description: string): boolean {
  return NAMES_AIRPORT.test(description);
}

/**
 * Beyond this, asking about walking spends a billed request to be told what
 * everyone already knows. Derived, not invented: `ground-options` refuses a
 * walk over 75 minutes, and nobody covers ten kilometres in seventy-five
 * minutes on foot.
 *
 * Without it a Tokyo → Osaka strike printed "On foot: 112 h 52 — too far to
 * be realistic" next to the answer that mattered.
 */
const WALKABLE_KM = 10;

/** Which modes are worth paying to price for this journey. */
export function modesWorthAsking(commitment: GroundCommitment): string[] {
  const far = distanceKm(commitment.from, commitment.to) > WALKABLE_KM;
  return far ? ["DRIVE", "TRANSIT"] : ["DRIVE", "TRANSIT", "WALK"];
}

/**
 * A short headline for a ground mission, derived rather than echoed.
 *
 * The plan's `incident` becomes the heading of the approval sheet, and
 * photographed at accessibility text size on 2026-09-18 the traveller's own
 * sentence — "Getting around: My taxi to the airport is cancelled, what do I
 * do" — filled six bold lines and pushed the answer entirely below the fold,
 * on a screen whose only purpose is that answer. The codebase had already
 * learned this once (see `personalize`); the ground branch reintroduced it.
 *
 * It stays machine-readable on purpose: every gate downstream reads this same
 * string, so the words that classify the mission have to survive into it.
 */
export function groundHeadline(description: string): string {
  return namesAirport(description) ? "Your ride to the airport is gone" : "Your ride is gone";
}
