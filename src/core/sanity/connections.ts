/**
 * Does the traveller actually make their connection?
 *
 * The graph has always known the rule — `ItineraryGraph.handleDisruption`
 * flags a downstream flight whose slack falls below its minimum — but only
 * ever applied it in the wake of a disruption. Nothing could ASK the question.
 * So "my connection is too tight, I'll never make the second flight" fell
 * through to the generic flight branch, which picked the nearest upcoming leg,
 * declared it four hours late on no evidence, and cancelled three activities.
 * Two different problems, one wrong answer.
 *
 * WHERE A CONNECTION LIVES. Two places, and the first version only looked in
 * one. A traveller who booked two separate flights has a change of planes
 * BETWEEN two legs of the itinerary. A traveller on a one-stop ticket — the
 * far more common shape — has it INSIDE one leg: one booking, one fare, one
 * node, two flown hops (`FlightNode.segments`). Asking about "my connection
 * in Doha" on such a trip used to be answered with "we can't find a change of
 * planes on this trip", which was false, and about the one fact the traveller
 * was surest of.
 *
 * WHAT IS REAL HERE. The gap is arithmetic over the traveller's own booked
 * times. The minimum is the itinerary's own (`minConnectionMinutes`) or the
 * graph's long-standing 45-minute default — the same number the propagation
 * already enforces, not a second rule invented beside it. Where the change
 * crosses a border, the floor rises by the deplaning and immigration minutes
 * `arrivalBuffer` already publishes.
 *
 * WHAT IS NOT KNOWN, and is said out loud rather than papered over: real
 * airport minimum connection times are published per airport and per terminal
 * pair, and we hold none of them. A connection that clears the floor here can
 * still be lost to a terminal change or a re-clear of security. The verdict
 * therefore never promises a connection will work — it reports whether the
 * itinerary's own minimum is met, and by how much.
 */

import type { FlightNode, FlightHop, ItineraryNode } from "../dag/types";
import { airportInfo, crossesBorderControl } from "./airports";
import { arrivalBuffer } from "./invariants";

/** The graph's own default, mirrored so the two can never drift apart. */
export const DEFAULT_CONNECTION_MINUTES = 45;

export interface FlightConnection {
  /** The node that lands. For a change inside one leg, the leg itself. */
  fromId: string;
  /** The node that takes off. For a change inside one leg, the leg itself. */
  toId: string;
  /**
   * For a change of planes INSIDE one leg: the 0-based index of the hop that
   * lands. `null` for a change between two separate legs.
   */
  hop: number | null;
  /** "SIN → FCO" — the whole journey a within-leg change belongs to. */
  journey: string | null;
  /** "SQ634 SIN → DPS". */
  fromLabel: string;
  toLabel: string;
  /** Where the change happens, as an IATA code. */
  atAirport: string;
  /** Display name for that airport, when the reference table knows it. */
  atAirportName: string | null;
  arriveMs: number;
  departMs: number;
  gapMinutes: number;
  /** The minimum this itinerary itself asks for. */
  requiredMinutes: number;
  /** True when the two legs cross a border control at the change. */
  crossesBorder: boolean | null;
}

function label(flight: FlightNode): string {
  return `${flight.flightNumber} ${flight.origin} → ${flight.destination}`;
}

function hopLabel(flight: FlightNode, hop: FlightHop): string {
  return `${hop.reference ?? flight.flightNumber} ${hop.from} → ${hop.to}`;
}

/**
 * The floor a change has to clear: the itinerary's own minimum, raised by
 * what a border crossing really costs — both numbers already published by
 * `arrivalBuffer`, so this never invents a second rule beside the graph's.
 */
function requiredMinutesFor(
  onward: FlightNode,
  crossesBorder: boolean | null,
  inboundOrigin: string,
  inboundDestination: string,
): number {
  let required = onward.minConnectionMinutes ?? DEFAULT_CONNECTION_MINUTES;
  if (crossesBorder === true) {
    const buffer = arrivalBuffer(inboundOrigin, inboundDestination);
    required = Math.max(required, buffer.deplaneMinutes + buffer.borderMinutes);
  }
  return required;
}

/** The changes of plane a one-stop (or two-stop) leg carries inside itself. */
function connectionsWithinLeg(flight: FlightNode): FlightConnection[] {
  const hops = flight.segments ?? [];
  const out: FlightConnection[] = [];
  for (let i = 0; i < hops.length - 1; i += 1) {
    const from = hops[i];
    const to = hops[i + 1];
    // Hydration guarantees a contiguous chain, but the graph is also built by
    // tests and callers who may not — read the facts, never assume them.
    if (!from.to || !to.from) continue;
    if (from.to.toUpperCase() !== to.from.toUpperCase()) continue;
    // A hop that leaves before the previous one lands is not a routing at
    // all. One that leaves the MINUTE it lands is — a zero-minute change,
    // which the traveller needs told about, not hidden from.
    if (to.departureTime < from.arrivalTime) continue;

    const atAirport = to.from.toUpperCase();
    const crossesBorder = crossesBorderControl(from.from, from.to);
    out.push({
      fromId: flight.id,
      toId: flight.id,
      hop: i,
      journey: `${flight.origin} → ${flight.destination}`,
      fromLabel: hopLabel(flight, from),
      toLabel: hopLabel(flight, to),
      atAirport,
      atAirportName: airportInfo(atAirport)?.city ?? null,
      arriveMs: from.arrivalTime,
      departMs: to.departureTime,
      gapMinutes: Math.round((to.departureTime - from.arrivalTime) / 60_000),
      requiredMinutes: requiredMinutesFor(flight, crossesBorder, from.from, from.to),
      crossesBorder,
    });
  }
  return out;
}

/**
 * Every place the traveller changes planes without leaving the airport —
 * inside a leg that lists its hops, and between two legs that meet.
 *
 * The "without leaving" half is what makes a change BETWEEN legs a connection
 * rather than two separate journeys from the same city, and it is read from
 * the graph rather than from a time threshold: if anything else on the
 * itinerary — a hotel, a meal, a tour — sits between the two legs, the
 * traveller went into town and this is not a connection. No invented window
 * decides it. A change INSIDE a leg needs no such test: nothing of the
 * itinerary can sit between two hops of one ticket.
 *
 * Returned in the order the traveller will meet them.
 */
export function findConnections(nodes: ItineraryNode[]): FlightConnection[] {
  const flights = nodes
    .filter((n): n is FlightNode => n.type === "flight")
    .sort((a, b) => a.departureTime - b.departureTime);
  const others = nodes.filter((n) => n.type !== "flight");
  const out: FlightConnection[] = [];

  for (const flight of flights) out.push(...connectionsWithinLeg(flight));

  for (let i = 0; i < flights.length - 1; i += 1) {
    const from = flights[i];
    const to = flights[i + 1];
    if (!from.destination || !to.origin) continue;
    if (from.destination.toUpperCase() !== to.origin.toUpperCase()) continue;
    if (to.departureTime <= from.arrivalTime) continue;
    const wentIntoTown = others.some(
      (n) => n.scheduledTime > from.arrivalTime && n.scheduledTime < to.departureTime,
    );
    if (wentIntoTown) continue;

    const atAirport = to.origin.toUpperCase();
    const crossesBorder = crossesBorderControl(from.origin, from.destination);
    out.push({
      fromId: from.id,
      toId: to.id,
      hop: null,
      journey: null,
      fromLabel: label(from),
      toLabel: label(to),
      atAirport,
      atAirportName: airportInfo(atAirport)?.city ?? null,
      arriveMs: from.arrivalTime,
      departMs: to.departureTime,
      gapMinutes: Math.round((to.departureTime - from.arrivalTime) / 60_000),
      requiredMinutes: requiredMinutesFor(to, crossesBorder, from.origin, from.destination),
      crossesBorder,
    });
  }
  return out.sort((a, b) => a.arriveMs - b.arriveMs);
}

/** Lower-cased, accents stripped — "Zürich" and "zurich" are one word. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Did the traveller name THIS airport — by code, or by any word of its name? */
function mentionsAirport(folded: string, connection: FlightConnection): boolean {
  const code = connection.atAirport.toLowerCase();
  if (new RegExp(`(^|[^a-z])${code}($|[^a-z])`).test(folded)) return true;
  const name = connection.atAirportName;
  if (!name) return false;
  return fold(name)
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 4)
    .some((word) => folded.includes(word));
}

/**
 * Which change of planes the traveller means.
 *
 * A trip with a stop out AND back has two, and "my connection at Doha" is
 * not a question about whichever comes first. The airport they named wins;
 * then the leg the mission targets (a two-stop journey has two changes on
 * the same node — the next one ahead of them); then the next change still
 * ahead; then the first. Never a guess dressed as a match: with no name, no
 * target and nothing ahead, the caller gets the first and knows why.
 */
export function pickConnection(
  connections: FlightConnection[],
  options: { text?: string | null; nodeId?: string | null; nowMs: number },
): FlightConnection | undefined {
  if (connections.length === 0) return undefined;
  const upcomingOf = (list: FlightConnection[]) =>
    list.find((c) => c.departMs >= options.nowMs) ?? list[0];

  if (options.text) {
    const folded = fold(options.text);
    const named = connections.filter((c) => mentionsAirport(folded, c));
    if (named.length > 0) return upcomingOf(named);
  }
  if (options.nodeId) {
    const onNode = connections.filter((c) => c.toId === options.nodeId);
    if (onNode.length > 0) return upcomingOf(onNode);
  }
  return upcomingOf(connections);
}

export type ConnectionVerdict =
  /** The booked gap is below the minimum this itinerary asks for. */
  | { kind: "below_minimum"; shortByMinutes: number }
  /** It clears that minimum. NOT a promise that it will work — see the header. */
  | { kind: "clears_minimum"; spareMinutes: number };

export function judgeConnection(connection: FlightConnection): ConnectionVerdict {
  const spare = connection.gapMinutes - connection.requiredMinutes;
  return spare < 0
    ? { kind: "below_minimum", shortByMinutes: -spare }
    : { kind: "clears_minimum", spareMinutes: spare };
}

/** "1 h 12" / "48 min" — the way a duration is read aloud. */
function human(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${String(rest).padStart(2, "0")}`;
}

/**
 * The connection in plain words, with the numbers it was judged on and the
 * limits of what we can tell them.
 */
export function describeConnection(
  connection: FlightConnection,
  verdict: ConnectionVerdict,
): string[] {
  const where = connection.atAirportName
    ? `${connection.atAirportName} (${connection.atAirport})`
    : connection.atAirport;
  const withinLeg = connection.hop !== null;
  // What the border floor is FOR differs by shape, and the sentence must not
  // claim more than the shape supports. Two separate legs land the traveller
  // in the country: immigration is certain. Two hops of one ticket usually
  // stay airside, where the same minutes cover a passport or security check
  // that may or may not happen — the floor is kept (it errs towards the
  // traveller making the flight), the wording is not overstated.
  const borderNote = connection.crossesBorder === true
    ? withinLeg
      ? ", which allows for a passport or security check at the change"
      : ", which includes clearing immigration"
    : "";
  const borderClearedNote = connection.crossesBorder === true
    ? withinLeg
      ? ", passport and security checks allowed for"
      : ", immigration included"
    : "";
  const lines = [
    `${connection.fromLabel} lands ${hhmm(connection.arriveMs)}; ` +
      `${connection.toLabel} leaves ${hhmm(connection.departMs)} — ` +
      `${human(connection.gapMinutes)} at ${where}` +
      (withinLeg && connection.journey ? `, on your ${connection.journey} journey.` : "."),
  ];
  if (verdict.kind === "below_minimum") {
    lines.push(
      `That is ${human(verdict.shortByMinutes)} short of the ${human(
        connection.requiredMinutes,
      )} this itinerary allows for the change${borderNote}.`,
    );
  } else {
    lines.push(
      `That clears the ${human(connection.requiredMinutes)} this itinerary allows${borderClearedNote}, ` +
        `with ${human(verdict.spareMinutes)} to spare.`,
    );
  }
  if (withinLeg) {
    // A stable fact of how tickets work, not a number and not a guess: on one
    // ticket a missed connection is the carrier's to repair. The most useful
    // thing a worried traveller can be told, and the cheapest — it costs them
    // nothing to ask before they buy anything.
    lines.push(
      "When both hops are on one ticket, a missed connection is the airline's to fix — " +
        "ask them to rebook you before buying anything yourself.",
    );
  }
  // Said every time, in both directions: we do not hold airport minimum
  // connection times, and a traveller who reads "it clears the minimum" as
  // "you will make it" has been misled by us.
  lines.push(
    "We don't hold the official minimum connection time for this airport — a terminal " +
      "change or a second security check can still eat the gap. Worth confirming with the airline.",
  );
  return lines;
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** The traveller is asking about a CONNECTION, in any language the app ships. */
const CONNECTION_INTENT =
  /\b(connection|connecting|layover|stopover|transfer between|second (flight|leg)|next (flight|leg))\b|correspondance|escale|conexi[óo]n|escala|anschluss|umsteige|zwischenstopp|转机|中转/i;

export function isConnectionMission(description: string): boolean {
  return CONNECTION_INTENT.test(description);
}
