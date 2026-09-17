/**
 * Nexus Swarm — real-trip hydration & settlement (SPEC §4.2/§4.4 extension).
 *
 * The hackathon API originally ran every mission against a FROZEN demo
 * graph (the since-RETIRED demo rail — `hackathonDemo.ts` was removed in
 * the real-trip migration, WS5). This module bridges the swarm pipeline to
 * REAL trips stored in the `trips` table:
 *
 *   1. {@link loadSwarmTrip} hydrates a trip row into an `ItineraryGraph`
 *      plus a `nodeRefs` map that remembers which content_json entry each
 *      graph node came from (transit_groups index / day+item indices).
 *   2. {@link applySettlementToContent} is a PURE transformer that rewrites
 *      a deep copy of content_json according to an approved plan's
 *      `operational` layer (replacement flight, activity moves/swaps, hotel
 *      actions) and emits human-readable change sentences.
 *   3. {@link settlePlanOnTrip} persists that rewrite with the same
 *      `content_rev` compare-and-swap discipline as src/lib/tripSave.ts
 *      (one retry on conflict, never throws).
 *
 * Every function here is total: failures surface as `null` (or, for
 * {@link loadSwarmTrip}, a classified {@link SwarmTripLoadResult}) so the
 * API layer keeps its JSON-only, never-throw contract.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ItineraryGraph } from "@/core/dag";
import type { ResolutionPlan, OperationalSettlement } from "@/agents";
import {
  airportInfo,
  arrivalBuffer,
  classifyItem,
  describeDropReason,
  earliestAfterLanding,
  isSensibleStart,
  minutesOfDay,
  placeDisplacedItem,
  unstayedNights,
} from "@/core/sanity";

// -------------------------------------------------------------------- types

export type SwarmNodeKind = "flight" | "transfer" | "hotel" | "activity";

/** Where a graph node came from inside content_json. */
export interface SwarmNodeRef {
  kind: SwarmNodeKind;
  /** Index into `itinerary[]` (day nodes only). */
  dayIndex?: number;
  /** Index into `itinerary[dayIndex].items[]` (day nodes only). */
  itemIndex?: number;
  /** Index into `transit_groups[]` (transit nodes only). */
  transitIndex?: number;
  /** Human-readable label, e.g. "Flight TP437 CDG → LIS". */
  label: string;
  /** Scheduled time, epoch ms (UTC). */
  time: number;
}

export interface HydratedTripMeta {
  tripId: string;
  title: string;
  destination: string;
  /** Destination city word(s) used to scope provider searches / intent match. */
  city: string;
  /** ISO-4217 currency of the trip (falls back to EUR). */
  currency: string;
}

export interface HydratedTrip {
  graph: ItineraryGraph;
  meta: HydratedTripMeta;
  nodeRefs: Record<string, SwarmNodeRef>;
  /**
   * The content_json this graph was hydrated from. Carried so the proposal can
   * be previewed through the SAME settlement transformer that will later write
   * the trip — what the traveller is shown before approving is then, by
   * construction, what approving does.
   */
  content?: Record<string, unknown>;
}

/**
 * Something the settlement could not finish on the traveller's behalf.
 *
 * Deliberately narrow. A booking the swarm really made needs nothing more; this
 * is only for the cases where claiming otherwise would strand someone: an
 * indicative flight nobody has ticketed, a pre-booked pickup now waiting at the
 * wrong hour, a paid ticket that has to be refunded by its seller.
 */
/** What a settlement did to the itinerary, item by item — for disclosure. */
export interface SettlementEffects {
  /** Titles of itinerary items re-timed (explicitly or by the arrival cascade). */
  moved: string[];
  /** Items removed, with the category that decided their fate. */
  cancelled: Array<{ title: string; category: string }>;
  /** Ground-transfer legs re-anchored to the new arrival. */
  transfersRetimed: number;
}

export interface SettlementFollowUp {
  kind:
    | "book_replacement_flight"
    | "retime_pickup_with_provider"
    | "claim_refund"
    /** A booked night the traveller will not use, because they now land the
     *  next day. We do not know the property's terms for it and will not
     *  invent them — the traveller is told to ask, and no money moves. */
    | "confirm_unused_night";
  /** One sentence the traveller can act on. */
  message: string;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** Default check-in hour when content only carries a date. */
const HOTEL_CHECKIN_HOUR_UTC = 15;
/** Default duration for itinerary activities without one. */
const DEFAULT_ACTIVITY_DURATION_MINUTES = 90;

// ------------------------------------------------------------------ helpers

/** Flatten a BiText-ish value (`string` or `{ en, ... }`) to plain text. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.en === "string") return record.en;
    for (const v of Object.values(record)) {
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Tolerant finite-number coercion: numbers only, never NaN/Infinity. */
function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Canonical wall-clock form of a leg stamp: "YYYY-MM-DDTHH:MM", built from the
 * digits actually written and ignoring any zone suffix. Null when the value
 * carries no date.
 *
 * The whole app reads a leg's times literally — a flight's times are already
 * local to its airports — so a stamp must survive a read/write round trip
 * unchanged. Writing a provider's `…T06:10:00Z` onto a leg made the timeline
 * show 06:10 for a flight that departs 14:10 locally.
 */
export function toLegStamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = /\d{4}-\d{2}-\d{2}/.exec(value);
  if (!day) return null;
  // Only a time AFTER the date, introduced by a "T" or a space, counts: the
  // "09:00" inside a trailing "+09:00" offset is a zone, not a clock reading.
  const rest = value.slice(day.index + day[0].length);
  const time = /[T\s](\d{1,2}):(\d{2})/.exec(rest);
  if (!time) return `${day[0]}T00:00`;
  const hh = String(Math.min(23, Number(time[1]))).padStart(2, "0");
  return `${day[0]}T${hh}:${time[2]}`;
}

/**
 * Parse a leg stamp to epoch ms, reading it as WALL CLOCK (the written digits,
 * anchored to UTC) rather than as an instant. Paired with {@link hhmmOf} and
 * {@link isoDateOf}, which also format in UTC, this makes every read/write
 * round trip preserve the time the traveler sees. `Date.parse` alone would
 * shift an offset-bearing stamp by that offset and then write the shifted
 * time back onto the trip.
 */
function parseEpoch(value: unknown): number | null {
  const stamp = toLegStamp(value);
  if (stamp === null) {
    // Not a dated stamp at all — fall back to the tolerant parse so genuinely
    // ISO instants elsewhere still work.
    if (typeof value !== "string") return null;
    const loose = Date.parse(value);
    return Number.isFinite(loose) ? loose : null;
  }
  const ms = Date.parse(`${stamp}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** "YYYY-MM-DD" (UTC) of an epoch-ms instant. */
function isoDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "HH:MM" (UTC) of an epoch-ms instant. */
function hhmmOf(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/**
 * Normalise a leg's free-text cabin onto the four fare families providers
 * understand. Trip content writes these many ways ("Business", "business
 * class", "BUSINESS", "premium economy", "Prem Eco"), and an unrecognised
 * value must yield null rather than a guess — a wrong cabin prices the wrong
 * product.
 */
function normalizeCabin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.toLowerCase().replace(/[^a-z]/g, "");
  if (text.length === 0) return null;
  if (text.includes("first")) return "first";
  if (text.includes("business")) return "business";
  if (text.includes("premium") || text.includes("premeco")) return "premium_economy";
  if (text.includes("economy") || text.includes("coach")) return "economy";
  return null;
}

/** Minutes since midnight for an "HH:MM"-style time string; null on garbage. */
function timeStringToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{1,2})[:h.](\d{2})\s*$/i.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// ------------------------------------------------- transit restatement match

/**
 * Mode words that identify a day item restating a transit leg, per leg
 * `method`. Best-effort across the shipped languages — the same spirit as
 * iOS's `TripDetailView.transitModeWords`, which hides these restatements in
 * the timeline. Not exhaustive by design: see {@link findTransitRestatements}
 * for why a miss is safer than a false positive.
 */
const TRANSIT_MODE_WORDS: Record<string, string[]> = {
  flight: ["flight", "flights", "fly", "flying", "plane", "vol", "avion"],
  train: ["train", "rail", "railway", "tgv"],
  bus: ["bus", "coach", "autocar"],
  car: ["transfer", "drive", "driving", "taxi", "shuttle", "navette"],
  ferry: ["ferry", "boat"],
};

/** Comparison form for reference tokens: "AF 276" and "AF276" must match. */
function normalizeRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** One day item that merely restates a `transit_groups` leg. */
export interface TransitRestatement {
  dayIndex: number;
  itemIndex: number;
  transitIndex: number;
}

/**
 * Locate day items that RESTATE a transit leg rather than describing a
 * separate plan — e.g. an `activity` item titled "Flight TP437 CDG → LIS" or
 * "Overnight flight AF 276" alongside the real leg in `transit_groups`.
 * Trip generation emits these routinely (item types are only
 * stay|activity|dining|transit, so a flight can only be restated as one of
 * those), and iOS already hides them from the timeline.
 *
 * The swarm needs them for two reasons:
 *   1. Hydration must NOT turn them into `activity` graph nodes — the
 *      ActivityAgent would otherwise "reschedule" the traveler's flight to
 *      another day like a surf lesson, leaving a phantom leg in the itinerary.
 *   2. Settlement must rewrite them alongside the leg, so the day view never
 *      keeps showing the replaced flight's number, time and fare.
 *
 * Matching mirrors iOS's `isDuplicateTransitItem`: the leg's own reference
 * (the one token a restatement reliably repeats), or the leg's mode word
 * together with either endpoint's city/code. Deliberately narrow — a MISS
 * only costs the old behaviour, while a FALSE POSITIVE would hide a genuine
 * activity from the swarm entirely.
 */
export function findTransitRestatements(content: unknown): TransitRestatement[] {
  const root = asRecord(content);
  if (!root) return [];
  const transitGroups = Array.isArray(root.transit_groups) ? root.transit_groups : [];
  const itinerary = Array.isArray(root.itinerary) ? root.itinerary : [];
  if (transitGroups.length === 0 || itinerary.length === 0) return [];

  // Pre-digest each leg once: reference token, mode words, endpoint words.
  const legs = transitGroups.map((raw, transitIndex) => {
    const leg = asRecord(raw);
    if (!leg) return null;
    const method = asString(leg.method)?.toLowerCase() ?? "";
    const reference = asString(leg.reference);
    const origin = asRecord(leg.origin);
    const destination = asRecord(leg.destination);
    const endpoints = [
      asString(origin?.city),
      asString(origin?.code),
      asString(destination?.city),
      asString(destination?.code),
    ]
      .filter((v): v is string => v !== null)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 1);
    const departMs = parseEpoch(leg.depart);
    return {
      transitIndex,
      // References shorter than 3 chars are too generic to match on.
      reference: reference && normalizeRef(reference).length >= 3 ? normalizeRef(reference) : null,
      modeWords: TRANSIT_MODE_WORDS[method] ?? [],
      endpoints,
      departDate: departMs !== null ? isoDateOf(departMs) : null,
    };
  });

  const matches: TransitRestatement[] = [];
  itinerary.forEach((rawDay: unknown, dayIndex: number) => {
    const day = asRecord(rawDay);
    if (!day) return;
    const dayDate = asString(day.date);
    const items = Array.isArray(day.items) ? day.items : [];
    items.forEach((rawItem: unknown, itemIndex: number) => {
      const item = asRecord(rawItem);
      if (!item) return;
      const type = asString(item.type)?.toLowerCase() ?? "";
      // Only the types hydration would otherwise turn into activity nodes.
      if (type !== "activity" && type !== "restaurant" && type !== "dining" && type !== "transit") {
        return;
      }
      const title = textOf(item.title).toLowerCase();
      if (!title) return;
      const normalizedTitle = normalizeRef(title);

      for (const leg of legs) {
        if (!leg) continue;
        // Scope to the leg's own travel day when BOTH dates are known: a
        // return flight's restatement must never match the outbound leg.
        if (leg.departDate && dayDate && leg.departDate !== dayDate) continue;
        const referenceHit = leg.reference !== null && normalizedTitle.includes(leg.reference);
        const modeHit = leg.modeWords.some((word) => title.includes(word));
        const endpointHit = leg.endpoints.some((word) => title.includes(word));
        if (referenceHit || (modeHit && endpointHit)) {
          matches.push({ dayIndex, itemIndex, transitIndex: leg.transitIndex });
          return;
        }
      }
    });
  });
  return matches;
}

// --------------------------------------------------------------- hydration

/**
 * Pure builder behind {@link loadSwarmTrip}: maps one trip's content_json to
 * an ItineraryGraph + nodeRefs. Deterministic mapping rules:
 *
 *   - transit_groups method "flight"  → flight node `flight-<idx>`
 *     (flightNumber = reference || carrier; invalid dates skip the leg).
 *   - transit_groups train/bus/car    → transfer node `transfer-<idx>`.
 *   - itinerary items type stay/hotel → hotel_check_in `hotel-<d>-<i>`
 *     (time from check_in date, else the day date, at 15:00 UTC).
 *   - itinerary items activity/dining → activity `activity-<d>-<i>`
 *     (day date + item.time; duration defaults to 90 min).
 *
 * Edges: chronological chain per day; the day's FIRST node additionally
 * depends on the flight arriving that same day (when present). Malformed
 * entries are skipped. Returns null when nothing useful could be built.
 */
export function hydrateTripFromContent(
  tripId: string,
  rowTitle: string,
  rowDestination: string,
  content: unknown,
): HydratedTrip | null {
  const root = asRecord(content);
  if (!root) return null;

  const graph = new ItineraryGraph();
  const nodeRefs: Record<string, SwarmNodeRef> = {};

  // ── 1. Transit legs ──────────────────────────────────────────────────────
  const transitGroups = Array.isArray(root.transit_groups) ? root.transit_groups : [];
  const flightArrivals: Array<{
    id: string;
    arrivalMs: number;
    destinationText: string;
    destinationCode?: string;
  }> = [];

  transitGroups.forEach((raw: unknown, idx: number) => {
    const leg = asRecord(raw);
    if (!leg) return;
    const method = asString(leg.method)?.toLowerCase() ?? "";
    const departMs = parseEpoch(leg.depart);
    if (departMs === null) return; // malformed date → skip the leg

    const origin = asRecord(leg.origin);
    const destination = asRecord(leg.destination);
    const originCode = asString(origin?.code) ?? asString(origin?.city);
    const destCode = asString(destination?.code) ?? asString(destination?.city);
    // Spatial anchors accept IATA codes ONLY: provider candidates carry IATA
    // codes, so anchoring to a city name would fabricate spatial mismatches
    // (and spurious re-quote charges) on real trips. Absent → field omitted.
    const destCodeTrimmed = asString(destination?.code)?.trim();
    const destIata = destCodeTrimmed ? destCodeTrimmed : undefined;

    if (method === "flight") {
      const arriveMs = parseEpoch(leg.arrive);
      const flightNumber = asString(leg.reference) ?? asString(leg.carrier);
      if (arriveMs === null || !flightNumber || !originCode || !destCode) return;
      // Booking facts (additive): the leg's money — a recorded payment WINS
      // (paid flag + POSITIVE paid_amount + non-empty paid_currency,
      // mirroring tripBudget.ts's effective-line rule), else the leg's plan
      // price when its amount is finite and its currency non-empty.
      // Otherwise the field is omitted entirely — same honesty as iOS
      // omitting a nil price, and downstream fare math must never guess an
      // original fare.
      const price = asRecord(leg.price);
      const paidAmount = asFiniteNumber(leg.paid_amount);
      const paidCurrency = asString(leg.paid_currency);
      const priceAmount = asFiniteNumber(price?.amount);
      const priceCurrency = asString(price?.currency);
      //
      // The `price` fallback requires `booked`: only a ticket the traveler
      // actually HOLDS has an original fare to compare a rebooking against. An
      // unbooked leg's `price` is the planner's ESTIMATE for a seat nobody
      // bought — and feeding it to the fare-delta math made a missed low-cost
      // Vueling hop report a €239.76 "refund" (estimate 285 − new fare 45.24)
      // and a NEGATIVE amount due, i.e. the swarm paying the traveler to miss
      // their flight. Same paid ▸ booked ▸ planned ladder the spend model uses.
      const legFare =
        Boolean(leg.paid) && paidAmount !== null && paidAmount > 0 && paidCurrency !== null
          ? { amount: paidAmount, currency: paidCurrency }
          : Boolean(leg.booked) && priceAmount !== null && priceCurrency !== null
            ? { amount: priceAmount, currency: priceCurrency }
            : null;
      // Party size on the leg: the leg's own travelers first, else the
      // trip's root party. Only REAL entries count (non-null objects), so a
      // placeholder `[null]` never yields travelers: 1. Omitted when neither
      // yields at least 1 traveler.
      const legTravelerCount = Array.isArray(leg.travelers)
        ? (leg.travelers as unknown[]).filter((traveler) => asRecord(traveler) !== null).length
        : 0;
      const rootTravelerCount = Array.isArray(root.travelers)
        ? (root.travelers as unknown[]).filter((traveler) => asRecord(traveler) !== null).length
        : 0;
      const legTravelers =
        legTravelerCount > 0 ? legTravelerCount : rootTravelerCount > 0 ? rootTravelerCount : null;
      // The cabin the traveller actually booked, so a rebooking searches the
      // SAME one. Without it every recovery quoted economy — silently
      // downgrading a business-class ticket and quoting a fare difference
      // against the wrong product.
      const legCabin = normalizeCabin(leg.cabin);
      const id = `flight-${idx}`;
      graph.addNode({
        id,
        type: "flight",
        flightNumber,
        origin: originCode,
        destination: destCode,
        departureTime: departMs,
        arrivalTime: arriveMs,
        scheduledTime: departMs,
        status: "on_track",
        dependsOn: [],
        // Spatial anchor (spec §2): where the flight lands, so downstream
        // transfer pickups can be checked for location mismatches.
        ...(destIata ? { arrivalLocationId: destIata } : {}),
        // Booking facts feed the true fare-delta wiring (paid ▸ price).
        ...(legFare ? { fare: legFare } : {}),
        ...(legTravelers !== null ? { travelers: legTravelers } : {}),
        ...(legCabin !== null ? { cabin: legCabin } : {}),
      });
      nodeRefs[id] = {
        kind: "flight",
        transitIndex: idx,
        label: `Flight ${flightNumber} ${originCode} → ${destCode}`,
        time: departMs,
      };
      flightArrivals.push({
        id,
        arrivalMs: arriveMs,
        destinationText: `${destCode} ${asString(destination?.city) ?? ""}`.trim(),
        ...(destIata ? { destinationCode: destIata } : {}),
      });
      return;
    }

    // train / bus / car → transfer node
    const id = `transfer-${idx}`;
    const durationHrs =
      typeof leg.durationHrs === "number" && Number.isFinite(leg.durationHrs)
        ? leg.durationHrs
        : null;
    // Link the pickup to the flight landing the same day at the same place.
    const matchingFlights = flightArrivals.filter(
      (f) =>
        isoDateOf(f.arrivalMs) === isoDateOf(departMs) &&
        f.arrivalMs <= departMs &&
        (originCode === null || f.destinationText.toLowerCase().includes(originCode.toLowerCase())),
    );
    const dependsOn = matchingFlights.map((f) => f.id).slice(-1);
    // Spatial anchor (spec §2): pickup happens where the matched upstream
    // flight lands — IATA code only. Transfers without a flight dependency
    // omit the field entirely (they can never trigger the DAG spatial check).
    const pickupLocationId = matchingFlights[matchingFlights.length - 1]?.destinationCode;
    graph.addNode({
      id,
      type: "transfer",
      durationMinutes: durationHrs !== null ? Math.max(5, Math.round(durationHrs * 60)) : 30,
      scheduledTime: departMs,
      status: "on_track",
      dependsOn,
      ...(pickupLocationId ? { pickupLocationId } : {}),
    });
    nodeRefs[id] = {
      kind: "transfer",
      transitIndex: idx,
      label: `Transfer (${method || "ground"}) ${originCode ?? "?"} → ${destCode ?? "?"}`,
      time: departMs,
    };
  });

  // ── 2. Itinerary days ────────────────────────────────────────────────────
  const itinerary = Array.isArray(root.itinerary) ? root.itinerary : [];

  // Day items that merely RESTATE a transit leg get no activity node: the
  // leg above already represents them, and treating one as an activity lets
  // the ActivityAgent reschedule the traveler's flight to another day.
  const restatedItemKeys = new Set(
    findTransitRestatements(root).map((m) => `${m.dayIndex}:${m.itemIndex}`),
  );

  itinerary.forEach((rawDay: unknown, dayIndex: number) => {
    const day = asRecord(rawDay);
    if (!day) return;
    const dayDate = asString(day.date);
    const dayStartMs = dayDate ? Date.parse(`${dayDate}T00:00:00Z`) : NaN;
    if (!Number.isFinite(dayStartMs)) return; // malformed day → skip

    interface Pending {
      id: string;
      scheduledTime: number;
      add: (dependsOn: string[]) => void;
      ref: SwarmNodeRef;
    }
    const pendings: Pending[] = [];

    const items = Array.isArray(day.items) ? day.items : [];
    items.forEach((rawItem: unknown, itemIndex: number) => {
      const item = asRecord(rawItem);
      if (!item) return;
      const type = asString(item.type)?.toLowerCase() ?? "";
      const title = textOf(item.title);
      if (!title) return;

      if (type === "stay" || type === "hotel") {
        const checkIn = asString(item.check_in);
        const checkInMs = checkIn ? Date.parse(`${checkIn}T00:00:00Z`) : NaN;
        const baseMs = Number.isFinite(checkInMs) ? checkInMs : dayStartMs;
        // The stay's own time component (e.g. "16:30") outranks the default
        // check-in hour — the SAME `timeStringToMinutes` helper activities
        // use below, so settlement-written times re-hydrate idempotently.
        // Absent/unparseable ⇒ the conventional 15:00Z check-in.
        const timeMin = timeStringToMinutes(item.time);
        const scheduledTime = baseMs + (timeMin ?? HOTEL_CHECKIN_HOUR_UTC * 60) * MINUTE_MS;
        const id = `hotel-${dayIndex}-${itemIndex}`;
        pendings.push({
          id,
          scheduledTime,
          ref: { kind: "hotel", dayIndex, itemIndex, label: title, time: scheduledTime },
          add: (dependsOn) =>
            graph.addNode({
              id,
              type: "hotel_check_in",
              hotelName: title,
              scheduledTime,
              status: "on_track",
              dependsOn,
            }),
        });
        return;
      }

      if (type === "activity" || type === "restaurant" || type === "dining") {
        // A restatement of a transit leg is not a reschedulable activity.
        if (restatedItemKeys.has(`${dayIndex}:${itemIndex}`)) return;
        const timeMin = timeStringToMinutes(item.time) ?? 12 * 60; // untimed → noon
        const scheduledTime = dayStartMs + timeMin * MINUTE_MS;
        const id = `activity-${dayIndex}-${itemIndex}`;
        pendings.push({
          id,
          scheduledTime,
          ref: { kind: "activity", dayIndex, itemIndex, label: title, time: scheduledTime },
          add: (dependsOn) =>
            graph.addNode({
              id,
              type: "activity",
              name: title,
              durationMinutes: DEFAULT_ACTIVITY_DURATION_MINUTES,
              scheduledTime,
              status: "on_track",
              dependsOn,
            }),
        });
      }
      // Other item types (transit placeholders etc.) carry no graph node.
    });

    if (pendings.length === 0) return;
    pendings.sort((a, b) => a.scheduledTime - b.scheduledTime);

    // The day's FIRST node also depends on the flight arriving that day.
    const arrivingFlight = flightArrivals.find((f) => isoDateOf(f.arrivalMs) === dayDate);

    let previousId: string | null = null;
    for (const pending of pendings) {
      const dependsOn: string[] = [];
      if (previousId) dependsOn.push(previousId);
      if (!previousId && arrivingFlight) dependsOn.push(arrivingFlight.id);
      pending.add(dependsOn);
      nodeRefs[pending.id] = pending.ref;
      previousId = pending.id;
    }
  });

  if (Object.keys(nodeRefs).length === 0) return null; // nothing useful → reject

  const destination = rowDestination || textOf(root.destination);
  return {
    graph,
    meta: {
      tripId,
      title: rowTitle || textOf(root.title),
      destination,
      city: destination,
      currency: (asString(root.local_currency_code) ?? "EUR").toUpperCase(),
    },
    nodeRefs,
    content: root,
  };
}

/**
 * Discriminated outcome of {@link loadSwarmTrip} — the old `null` collapse
 * conflated store failures (e.g. a rotated service key ⇒ PostgREST auth
 * errors) with genuinely missing trips, so the API answered 404 for a
 * RETRYABLE outage. Classification:
 *   - ok                → the row was fetched and hydrated.
 *   - store_unavailable → ANY store failure (query error or thrown error);
 *                         retryable — the API maps it to 503.
 *   - not_found         → the query succeeded but no row matched.
 *   - unhydratable      → the row exists but its content cannot hydrate.
 */
export type SwarmTripLoadResult =
  | { kind: "ok"; trip: HydratedTrip }
  | { kind: "store_unavailable" }
  | { kind: "not_found" }
  | { kind: "unhydratable" };

/**
 * Load one trip row and hydrate it into a graph. NEVER throws: every failure
 * resolves to a classified {@link SwarmTripLoadResult} — store errors (query
 * `error` OR thrown error) become `store_unavailable` (retryable; NO brittle
 * message-matching), a missing row becomes `not_found`, unusable content
 * becomes `unhydratable`, and the API layer maps each kind to its own
 * response (503 vs 404) instead of one opaque 404.
 */
export async function loadSwarmTrip(tripId: string): Promise<SwarmTripLoadResult> {
  try {
    // Loosely-typed handle: the generated Database type predates content_rev,
    // and `supabaseAdmin` is a lazy proxy whose FIRST property access throws
    // when credentials are missing — caught below like everywhere else.
    const sb = supabaseAdmin as unknown as { from: (table: string) => any };
    const { data, error } = await sb
      .from("trips")
      .select("id,title,destination,content_json,content_rev")
      .eq("id", tripId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) {
      console.warn(`[swarm-trip] loadSwarmTrip store failure (kind=store_unavailable):`, error);
      return { kind: "store_unavailable" };
    }
    if (!data) return { kind: "not_found" };
    const row = asRecord(data);
    if (!row) return { kind: "not_found" };
    const trip = hydrateTripFromContent(
      tripId,
      textOf(row.title),
      textOf(row.destination),
      row.content_json,
    );
    if (!trip) return { kind: "unhydratable" };
    return { kind: "ok", trip };
  } catch (error) {
    console.warn(`[swarm-trip] loadSwarmTrip failed (kind=store_unavailable):`, error);
    return { kind: "store_unavailable" };
  }
}

// ---------------------------------------------------------------- settlement

/**
 * The replacement ticket's own price, from the plan the human approved.
 * Returns null unless BOTH a finite cost and a non-empty currency are
 * present — the settlement must never stamp a guessed fare or a null
 * currency onto the trip.
 */
function replacementFareOf(plan: ResolutionPlan): { amount: number; currency: string } | null {
  const newFlight = plan.proposed_resolution?.new_flight;
  if (!newFlight) return null;
  const amount = asFiniteNumber(newFlight.cost);
  const currency = asString(newFlight.currency);
  if (amount === null || amount < 0 || currency === null) return null;
  return { amount, currency: currency.toUpperCase() };
}

/**
 * The replacement journey's SHAPE, for the leg the timeline renders: total
 * duration in hours, stop count and layover airports. Duration falls back to
 * the leg's own new depart→arrive span when the provider quoted none, since
 * that is always knowable. Every field is null when it cannot be established,
 * so settlement leaves the existing value alone rather than inventing one.
 */
function replacementRoutingOf(
  plan: ResolutionPlan,
  newFlight: { depart: string; arrive: string },
): {
  durationHrs: number | null;
  stops: number | null;
  stopAirports: string[] | null;
  segments: Array<Record<string, unknown>> | null;
} {
  const quoted = plan.proposed_resolution?.new_flight;
  const quotedMinutes = asFiniteNumber(quoted?.durationMinutes);
  const departMs = Date.parse(newFlight.depart);
  const arriveMs = Date.parse(newFlight.arrive);
  const spanMinutes =
    Number.isFinite(departMs) && Number.isFinite(arriveMs) && arriveMs > departMs
      ? (arriveMs - departMs) / MINUTE_MS
      : null;
  const minutes = quotedMinutes !== null && quotedMinutes > 0 ? quotedMinutes : spanMinutes;

  const stops = asFiniteNumber(quoted?.stops);
  const airports = Array.isArray(quoted?.stopAirports)
    ? quoted.stopAirports.filter((code): code is string => asString(code) !== null)
    : null;

  // The hops, converted to the leg's own storage contract: LOCAL wall-clock
  // "YYYY-MM-DDTHH:MM" stamps, exactly like `depart`/`arrive` above. A
  // provider's Z-suffixed instant written straight through would make the
  // drawer quote UTC for a connection the traveller waits out on an airport
  // clock.
  const rawSegments = Array.isArray(quoted?.segments) ? quoted.segments : null;
  const segments =
    rawSegments && rawSegments.length > 0
      ? rawSegments.map((segment) => ({
          ...(asString(segment.carrier) !== null ? { carrier: segment.carrier } : {}),
          ...(asString(segment.reference) !== null ? { reference: segment.reference } : {}),
          ...(asString(segment.from) !== null ? { from: { code: segment.from } } : {}),
          ...(asString(segment.to) !== null ? { to: { code: segment.to } } : {}),
          ...(asString(segment.depart) !== null
            ? { depart: toLegStamp(segment.depart) ?? segment.depart }
            : {}),
          ...(asString(segment.arrive) !== null
            ? { arrive: toLegStamp(segment.arrive) ?? segment.arrive }
            : {}),
        }))
      : null;

  // Segments are the AUTHORITY: when we have them, the count and the layover
  // list are DERIVED, never taken from a separate field that could disagree.
  const derivedStops = segments ? Math.max(0, segments.length - 1) : null;
  const derivedAirports = segments
    ? segments
        .slice(0, -1)
        .map((segment) => segment.to?.code)
        .filter((code): code is string => typeof code === "string" && code.length > 0)
    : null;

  return {
    durationHrs: minutes !== null ? Math.round((minutes / 60) * 100) / 100 : null,
    stops: derivedStops ?? (stops !== null && stops >= 0 ? Math.round(stops) : null),
    stopAirports: derivedAirports ?? airports,
    segments,
  };
}

/**
 * Net payable of the approved plan expressed in `currency` — read from the
 * per-currency ledger when present, else the single-currency total. Null when
 * the plan carries no figure for that currency, so callers leave money alone
 * rather than converting at a rate the swarm never quoted.
 */
function netPayableInCurrency(plan: ResolutionPlan, currency: string | null): number | null {
  if (!currency) return null;
  const wanted = currency.toUpperCase();
  const delta = plan.financial_delta;
  if (!delta) return null;
  if (Array.isArray(delta.by_currency)) {
    const row = delta.by_currency.find(
      (entry) => asString(entry?.currency)?.toUpperCase() === wanted,
    );
    if (row) {
      const net = asFiniteNumber(row.net_payable);
      return net;
    }
    // A per-currency ledger that does NOT mention this currency means the
    // plan charged nothing in it.
    if (delta.by_currency.length > 0) return null;
  }
  return asFiniteNumber(delta.net_payable);
}

/**
 * Swap an old flight reference for the new one inside a restating item's
 * title, preserving the surrounding wording ("Overnight flight AF276 to
 * Tokyo" → "Overnight flight IB3125 to Tokyo"). Handles both plain strings
 * and BiText maps, and returns null when the reference does not literally
 * appear (a mode-word match) so the caller leaves the title untouched
 * rather than inventing one.
 */
function restateTitle(title: unknown, oldReference: string, newReference: string): unknown | null {
  // Tolerant of the spacing variants a generated title may use ("AF 276").
  const pattern = new RegExp(
    oldReference
      .split("")
      .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s-]*"),
    "gi",
  );
  const swap = (value: string): string | null =>
    pattern.test(value) ? value.replace(pattern, newReference) : null;

  if (typeof title === "string") return swap(title);
  const record = asRecord(title);
  if (!record) return null;
  let changed = false;
  const out: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    const replaced = swap(value);
    if (replaced !== null) {
      out[key] = replaced;
      changed = true;
    }
  }
  return changed ? out : null;
}

/**
 * PURE settlement transformer: deep-clones `content` and applies the plan's
 * operational layer. The input is never mutated. Returns the new content, a
 * human-readable changes list ("Flight → new flight AF1234, departs 09:10")
 * and `flightRewriteLanded` — whether the replacement-flight leg rewrite
 * actually landed (clarity pass: the approve handler must never report a
 * flight settlement as applied when the rewrite was skipped). When a flight
 * rewrite was attempted but did not land, `flightSkipReason` distinguishes
 * WHY (already settled vs. leg not found) so the handler can report
 * honestly instead of guessing.
 */
/**
 * Keep the day row that restates a flight pointing at the same booking —
 * reference only. The LEG is the booking authority: the journey view hides a
 * restating row as a duplicate of its leg card unless that row is itself
 * flagged booked or paid, so copying those flags made a settled flight appear
 * twice. A row the traveller flagged by hand keeps its own flags.
 */
function mirrorBookingState(leg: Record<string, unknown>, item: Record<string, unknown>): void {
  if (typeof leg.booking_reference === "string") item.booking_reference = leg.booking_reference;
  else delete item.booking_reference;
}

/**
 * "Hotel Campo de' Fiori", never "Hotel Hotel Campo de' Fiori". A property
 * whose own name already says what it is keeps that name; anything else is
 * introduced as a hotel so the change line still reads.
 */
export function hotelChangeLabel(name: string): string {
  const trimmed = name.trim();
  if (/\b(hotel|h[oô]tel|hostel|inn|resort|ryokan|lodge|guest ?house|motel|suites?|palace|apartments?|b&b|riad|pousada|parador|albergo|hostal)\b/i.test(trimmed)) {
    return trimmed;
  }
  return `Hotel ${trimmed}`;
}

/**
 * Is there ANOTHER day of the trip already holding a room at `label` for
 * `date`? A stay is filed one row per night, and its own `check_in` wins over
 * the day it sits under (real trips carry both), so the comparison is against
 * the row's effective date rather than its day's.
 */
function staysOnDate(
  itinerary: unknown[],
  label: string,
  date: string,
  exceptDayIndex: number,
): boolean {
  for (let dayIndex = 0; dayIndex < itinerary.length; dayIndex += 1) {
    if (dayIndex === exceptDayIndex) continue;
    const day = asRecord(itinerary[dayIndex]);
    const items = Array.isArray(day?.items) ? (day.items as unknown[]) : [];
    const dayDate = asString(day?.date);
    for (const raw of items) {
      const entry = asRecord(raw);
      if (!entry || asString(entry.type) !== "stay") continue;
      if (textOf(entry.title) !== label) continue;
      if ((asString(entry.check_in) ?? dayDate) === date) return true;
    }
  }
  return false;
}

/** "Fri 6 Nov", the date part of a check-in that moved off its booked day. */
export function checkInDateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * A hotel action in words: "late check-in at 21:20", not "late_check_in".
 *
 * When the replacement flight lands on a LATER DATE, the time alone is a lie
 * by omission — "check-in moves to 19:15" reads as tonight. `bookedCheckInMs`
 * turns it into "check-in moves to Fri 6 Nov at 19:15", which is the fact the
 * traveller needs to understand that the night before is gone.
 */
export function hotelActionPhrase(
  action: string,
  newCheckInMs?: number,
  bookedCheckInMs?: number,
): string {
  switch (action) {
    case "late_check_in": {
      if (newCheckInMs === undefined || !Number.isFinite(newCheckInMs)) return "late check-in";
      const nights =
        bookedCheckInMs !== undefined ? unstayedNights(bookedCheckInMs, newCheckInMs) : 0;
      return nights > 0
        ? `check-in moves to ${checkInDateLabel(newCheckInMs)} at ${hhmmOf(newCheckInMs)}`
        : `late check-in at ${hhmmOf(newCheckInMs)}`;
    }
    case "rebook":
      return "room needs rebooking";
    case "none":
      return "no change needed";
    default:
      return action.replace(/_/g, " ");
  }
}

export function applySettlementToContent(
  content: Record<string, unknown>,
  nodeRefs: Record<string, SwarmNodeRef>,
  plan: ResolutionPlan,
  operational: OperationalSettlement,
): {
  content: Record<string, unknown>;
  changes: string[];
  flightRewriteLanded: boolean;
  flightSkipReason?: "already_settled" | "leg_not_found";
  /** What the traveller still has to do themselves — empty when nothing. */
  followUps: SettlementFollowUp[];
  effects: SettlementEffects;
} {
  const next = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  const changes: string[] = [];
  const followUps: SettlementFollowUp[] = [];
  const effects: SettlementEffects = { moved: [], cancelled: [], transfersRetimed: 0 };
  const settledAt = new Date().toISOString();
  /** Pre-rewrite endpoints of the disrupted leg (for the transfer re-anchor). */
  let previousDestinationCode: string | null = null;
  let previousDestinationCity: string | null = null;
  let previousOriginCode: string | null = null;
  let flightRewriteLanded = false;
  let flightSkipReason: "already_settled" | "leg_not_found" | undefined;
  /** The disrupted leg's arrival BEFORE the rewrite (NaN when unknown). */
  let previousArrivalMs = Number.NaN;
  /** "dayIndex:itemIndex" of every entry an EXPLICIT step already repositioned.
   *  The arrival cascade is a backstop, not a second opinion — it defers to
   *  these unless the placement is outright impossible. */
  const settledItemKeys = new Set<string>();
  /** The day entries that RESTATE the flight itself. These are never cascaded:
   *  the flight's own row sits at its DEPARTURE time, which is before the
   *  arrival by definition, and "moving it after landing" is nonsense. */
  const legRestatementKeys = new Set<string>();

  /**
   * Keep the money trail of anything the settlement removes. The item leaves
   * the day, but a ticket the traveller paid for does not stop existing — it
   * becomes a refund to claim, and the record of it must survive.
   */
  const cancellations: Record<string, unknown>[] = Array.isArray(next.swarm_cancellations)
    ? (next.swarm_cancellations as Record<string, unknown>[])
    : [];
  const archiveCancellation = (item: Record<string, unknown>, label: string, reason: string): void => {
    const paidAmount = asFiniteNumber(item.paid_amount);
    const paidCurrency = asString(item.paid_currency);
    cancellations.push({
      title: label,
      reason,
      cancelled_at: settledAt,
      ...(item.booked === true ? { was_booked: true } : {}),
      ...(item.paid === true && paidAmount !== null ? { paid_amount: paidAmount } : {}),
      ...(item.paid === true && paidCurrency ? { paid_currency: paidCurrency } : {}),
    });
    next.swarm_cancellations = cancellations;
    if (item.paid === true && paidAmount !== null && paidAmount > 0) {
      followUps.push({
        kind: "claim_refund",
        message: `${label} was paid (${paidAmount}${paidCurrency ? ` ${paidCurrency}` : ""}) — request a refund from the seller.`,
      });
    }
  };
  const recordCancellation = (item: Record<string, unknown>, label: string, reason: string): void => {
    archiveCancellation(item, label, reason);
    effects.cancelled.push({
      title: label,
      category: classifyItem({ type: asString(item.type), title: textOf(item.title) || label }),
    });
    changes.push(`${label} cancelled — ${reason}`);
  };

  const itinerary = Array.isArray(next.itinerary) ? (next.itinerary as unknown[]) : [];
  const transitGroups = Array.isArray(next.transit_groups)
    ? (next.transit_groups as unknown[])
    : [];

  const dayAt = (dayIndex: number): Record<string, unknown> | null => asRecord(itinerary[dayIndex]);
  const itemsAt = (dayIndex: number): unknown[] | null => {
    const day = dayAt(dayIndex);
    return day && Array.isArray(day.items) ? (day.items as unknown[]) : null;
  };

  // Restatement map is computed from the PRE-rewrite content: the match keys
  // off the leg's CURRENT reference, which step 1 is about to replace.
  const restatements = findTransitRestatements(next);

  // ── 1. Replacement flight → rewrite the disrupted transit leg ────────────
  const newFlight = operational.new_flight;
  const disruptedRef = nodeRefs[operational.disrupted.nodeId];
  if (
    newFlight &&
    disruptedRef?.kind === "flight" &&
    typeof disruptedRef.transitIndex === "number"
  ) {
    const leg = asRecord(transitGroups[disruptedRef.transitIndex]);
    // Idempotent re-apply: when this exact booking code is already stamped on
    // the leg, the settlement landed before — skip instead of rewriting (and
    // report `flightRewriteLanded: false` so approve never claims success).
    const alreadySettled =
      leg !== null &&
      typeof operational.bookingCode === "string" &&
      leg.booking_reference === operational.bookingCode;
    if (leg && !alreadySettled) {
      const oldReference = asString(leg.reference);
      // Captured BEFORE the overwrite — step 4 needs to know which itinerary
      // entries used to sit after the old landing, because those are exactly
      // the ones that depend on arriving.
      previousArrivalMs = parseEpoch(leg.arrive) ?? Number.NaN;
      previousDestinationCode = asString(asRecord(leg.destination)?.code)?.toUpperCase() ?? null;
      previousDestinationCity = asString(asRecord(leg.destination)?.city);
      previousOriginCode = asString(asRecord(leg.origin)?.code)?.toUpperCase() ?? null;
      leg.reference = newFlight.reference;
      if (newFlight.carrier) leg.carrier = newFlight.carrier;
      // Write the canonical wall-clock form so this leg reads like every
      // other one — a provider's Z-suffixed instant would otherwise make the
      // timeline quote UTC for a flight the traveler boards at a local time.
      leg.depart = toLegStamp(newFlight.depart) ?? newFlight.depart;
      leg.arrive = toLegStamp(newFlight.arrive) ?? newFlight.arrive;
      // Booking state follows what the provider actually did — exactly what a
      // traveller booking this leg by hand would record. A priced, provider-
      // backed fare is a booking. An INDICATIVE recovery option (the zero-
      // abort ladder's synthetic schedule) is not: no airline sold that seat,
      // and marking it booked would send someone to the airport without a
      // ticket. Its schedule is still written — the rest of the day has to be
      // planned around a realistic arrival — but it stays visibly unbooked.
      const fareBasis = plan.proposed_resolution.new_flight?.fare_basis;
      const replacementDestination = asString(plan.proposed_resolution.new_flight?.destination)?.toUpperCase();
      if (replacementDestination && replacementDestination !== previousDestinationCode) {
        const info = airportInfo(replacementDestination);
        const destination = asRecord(leg.destination) ?? {};
        destination.code = replacementDestination;
        if (info) destination.city = info.city;
        leg.destination = destination;
      }
      // A provider that did not confirm the order (unconfigured, failed) left
      // no ticket either — same honest state as an estimate.
      const unconfirmed = fareBasis === "synthetic_estimate" || operational.booking_status === "recorded";
      if (unconfirmed) {
        if (typeof leg.booking_reference === "string" && leg.booking_reference.length > 0) {
          leg.previous_booking_reference = leg.booking_reference;
        }
        delete leg.booking_reference;
        leg.booked = false;
        leg.booking_source = fareBasis === "synthetic_estimate" ? "swarm_indicative" : "swarm_unconfirmed";
        followUps.push({
          kind: "book_replacement_flight",
          message:
            fareBasis === "synthetic_estimate"
              ? `Flight ${newFlight.reference} is an estimated schedule, not a ticket — ` +
                "book the replacement with the airline before travelling."
              : `No ticket was confirmed for flight ${newFlight.reference} — ` +
                "book it with the airline before travelling.",
        });
      } else {
        leg.booked = true;
        leg.booking_reference = operational.bookingCode ?? `SWARM-${newFlight.reference}`;
        leg.booking_source = "swarm_settlement";
        leg.settled_at = settledAt;
      }

      // Routing: the replacement may be a completely different shape of
      // journey — a 6 h one-stop where the original was a 2 h non-stop. The
      // timeline reads these off the leg, so a settlement that rewrote only
      // the times left it describing the OLD journey's duration.
      const routing = replacementRoutingOf(plan, newFlight);
      if (routing.durationHrs !== null) leg.durationHrs = routing.durationHrs;
      if (routing.stops !== null) {
        leg.stops = routing.stops;
        // Explicit empty list for a non-stop, so the timeline can tell
        // "non-stop" from "routing unknown".
        leg.stop_airports = routing.stopAirports ?? [];
      }
      // Segments are the AUTHORITY on the routing wherever this leg is read,
      // so they must NEVER be left describing the previous journey. This leg
      // is now a different flight: either we know its hops and write them, or
      // we do not and the old ones have to go — a leg rewritten from a
      // SIN→TPE→CTS itinerary onto a non-stop LHR→LIS otherwise kept its two
      // stale hops and, because they outrank `stops`, showed them.
      if (routing.segments) {
        leg.segments = routing.segments;
      } else {
        delete leg.segments;
      }

      // Money: the leg now IS the replacement ticket, so it must carry the
      // replacement ticket's price. Without this the trip budget keeps
      // quoting the fare of a flight the traveler no longer holds.
      const newFare = replacementFareOf(plan);
      const legCurrency = asString(asRecord(leg.price)?.currency);
      if (newFare) {
        leg.price = { amount: newFare.amount, currency: newFare.currency };
      }
      // A leg the traveler had already PAID for keeps its payment record —
      // but the settlement's net payable is real money leaving the account
      // today, so the recorded amount grows by it. Same currency only: mixing
      // currencies into one `paid_amount` would silently corrupt the budget.
      const paidAmount = asFiniteNumber(leg.paid_amount);
      const paidCurrency = asString(leg.paid_currency) ?? legCurrency;
      const netDue = netPayableInCurrency(plan, paidCurrency);
      if (
        Boolean(leg.paid) &&
        paidAmount !== null &&
        paidAmount > 0 &&
        paidCurrency &&
        netDue !== null &&
        netDue !== 0
      ) {
        leg.paid_amount = Math.round((paidAmount + netDue) * 100) / 100;
        leg.paid_currency = paidCurrency;
      }

      flightRewriteLanded = true;
      changes.push(
        `Flight → new flight ${newFlight.reference}, departs ${hhmmOf(Date.parse(newFlight.depart) || 0)}`,
      );

      // Keep any day item that merely RESTATES this leg in step with it —
      // otherwise the day view keeps showing the replaced flight's number
      // and time next to the new one.
      for (const match of restatements) {
        if (match.transitIndex !== disruptedRef.transitIndex) continue;
        const item = asRecord(itemsAt(match.dayIndex)?.[match.itemIndex]);
        if (!item) continue;
        const departMs = Date.parse(newFlight.depart);
        if (Number.isFinite(departMs)) item.time = hhmmOf(departMs);
        if (oldReference) {
          settledItemKeys.add(`${match.dayIndex}:${match.itemIndex}`);
          legRestatementKeys.add(`${match.dayIndex}:${match.itemIndex}`);
          const retitled = restateTitle(item.title, oldReference, newFlight.reference);
          if (retitled !== null) item.title = retitled;
        }
        // Mirror the leg's money so the item and the leg never disagree.
        if (newFare && asRecord(item.cost)) {
          item.cost = { amount: newFare.amount, currency: newFare.currency };
        }
        // …and the booking it belongs to (reference only — see mirrorBookingState).
        mirrorBookingState(leg, item);
      }
    } else {
      flightSkipReason = alreadySettled ? "already_settled" : "leg_not_found";
    }
  } else if (newFlight) {
    // A replacement flight was requested but the disrupted node no longer
    // resolves to a transit leg — report the skip honestly.
    flightSkipReason = "leg_not_found";
  }

  // ── 2. Hotel actions → shifted check_in + additive swarm_note ────────────
  // Applied BEFORE any itinerary splices below: the nodeRef day/item indices
  // address the ORIGINAL array positions, which splices would shift.
  for (const action of operational.hotel_actions ?? []) {
    const ref = nodeRefs[action.nodeId];
    if (!ref || ref.kind !== "hotel") continue;
    if (typeof ref.dayIndex !== "number" || typeof ref.itemIndex !== "number") continue;
    const item = asRecord(itemsAt(ref.dayIndex)?.[ref.itemIndex]);
    if (!item) continue;
    settledItemKeys.add(`${ref.dayIndex}:${ref.itemIndex}`);

    const shiftedCheckInMs = action.newCheckIn ? Date.parse(action.newCheckIn) : Number.NaN;
    // What the traveller actually booked — the anchor a lost night is counted
    // from. `ref.time` is the hydrated check-in; the stored `check_in` date is
    // the fallback when the node was never given an hour.
    const bookedCheckInMs = Number.isFinite(ref.time)
      ? ref.time
      : Date.parse(`${asString(item.check_in) ?? ""}T00:00:00.000Z`);
    // A check-in pushed onto a LATER NIGHT is a booked night nobody will sleep
    // in. It is recorded on the stay, stated as its own change line, and
    // handed to the traveller as a follow-up — never quietly folded into a
    // time change, and never turned into money we have no right to promise.
    const nightsLost = unstayedNights(bookedCheckInMs, shiftedCheckInMs);
    // Does the trip ALREADY hold a room for the night the traveller now
    // arrives on? A multi-night stay is one row per night, so re-dating the
    // first row forward would put two rows on the same night and the timeline
    // would show the room twice — the "phantom" day-one card. When the later
    // night is already covered, the first row keeps its own date and is marked
    // unused instead of being moved on top of its own successor.
    const successorCoversTheNight =
      nightsLost > 0 &&
      Number.isFinite(shiftedCheckInMs) &&
      staysOnDate(itinerary, ref.label, isoDateOf(shiftedCheckInMs), ref.dayIndex);
    if (action.newCheckIn && !successorCoversTheNight) {
      const shiftedMs = shiftedCheckInMs;
      if (Number.isFinite(shiftedMs)) {
        item.check_in = isoDateOf(shiftedMs);
        // Also stamp the time component: hydration reads `item.time` through
        // `timeStringToMinutes`, so WITHOUT this the re-timed stay would snap
        // back to the default 15:00Z on the next load. With it, re-hydration
        // is idempotent (the shifted hour survives every round trip).
        item.time = hhmmOf(shiftedMs);
      }
    }
    if (nightsLost > 0) {
      // The row stands for a night that will not be slept in. The journey
      // views read this to render it as unused rather than as a booking the
      // traveller still has to honour.
      item.unstayed = true;
      item.nights_unstayed = nightsLost;
      item.unstayed_from = isoDateOf(bookedCheckInMs);
      const nightWord = nightsLost === 1 ? "night" : "nights";
      changes.push(
        `${hotelChangeLabel(ref.label)}: ${nightsLost} booked ${nightWord} from ${checkInDateLabel(bookedCheckInMs)} will not be used — you now land on ${checkInDateLabel(shiftedCheckInMs)}.`,
      );
      followUps.push({
        kind: "confirm_unused_night",
        message: `You arrive a day later, so ${nightsLost} ${nightWord} at ${hotelChangeLabel(ref.label)} from ${checkInDateLabel(bookedCheckInMs)} goes unused — ask the property whether it can be released or credited before you travel.`,
      });
    }
    const phrase = hotelActionPhrase(action.action, shiftedCheckInMs, bookedCheckInMs);
    const note = `Swarm settlement (${phrase}): ${action.note || plan.incident}`;
    // Idempotent append (clarity pass): a repeated settlement of the same
    // plan (same booking code / note) never duplicates the swarm_note.
    const existingNote = typeof item.swarm_note === "string" ? item.swarm_note : "";
    const noteAlreadyPresent =
      existingNote.length > 0 &&
      (existingNote.includes(note) ||
        (typeof operational.bookingCode === "string" &&
          operational.bookingCode.length > 0 &&
          existingNote.includes(operational.bookingCode)));
    if (!noteAlreadyPresent) {
      item.swarm_note = existingNote.length > 0 ? `${existingNote} | ${note}` : note;
    }
    changes.push(`${hotelChangeLabel(ref.label)}: ${phrase}`);
  }

  // ── 3. Activity moves / swaps ────────────────────────────────────────────
  // Two-phase to avoid array-index drift: (a) every in-place edit (retime /
  // swap title) happens FIRST while all nodeRef indices are still valid;
  // (b) cross-day splices are then applied per day in DESCENDING itemIndex
  // order, so an earlier removal can never shift a later ref's position.
  interface CrossDayMove {
    dayIndex: number;
    itemIndex: number;
    item: Record<string, unknown>;
    targetDate: string;
  }
  const crossDayMoves: CrossDayMove[] = [];
  // W2 (additive): dropped activities are spliced out WITHOUT any re-append —
  // the item leaves the itinerary entirely. Collected alongside cross-day
  // moves so phase (b) splices everything in one descending pass.
  interface DropSplice {
    dayIndex: number;
    itemIndex: number;
  }
  const dropSplices: DropSplice[] = [];
  for (const move of operational.activity_moves ?? []) {
    const ref = nodeRefs[move.nodeId];
    if (!ref || ref.kind !== "activity") continue;
    if (typeof ref.dayIndex !== "number" || typeof ref.itemIndex !== "number") continue;

    // W2 drop branch: the item is cancelled out of the day (smart day
    // reorganization proved it infeasible otherwise). No retime, no target
    // day — just the splice + an honest cancellation change line.
    if (move.drop === true) {
      if (!itemsAt(ref.dayIndex)) continue;
      dropSplices.push({ dayIndex: ref.dayIndex, itemIndex: ref.itemIndex });
      const droppedItem = asRecord(itemsAt(ref.dayIndex)?.[ref.itemIndex]);
      if (droppedItem) {
        archiveCancellation(droppedItem, ref.label, move.cancellationNote ?? "cancelled by the day reorganization");
        effects.cancelled.push({
          title: ref.label,
          category: classifyItem({ type: asString(droppedItem.type), title: textOf(droppedItem.title) || ref.label }),
        });
      }
      changes.push(
        move.cancellationNote
          ? `${ref.label} cancelled — ${move.cancellationNote}`
          : `${ref.label} cancelled — free cancellation until 24h before start`,
      );
      continue;
    }

    const newMs = Date.parse(move.newTime);
    if (!Number.isFinite(newMs)) continue;

    const sourceDay = dayAt(ref.dayIndex);
    const sourceItems = itemsAt(ref.dayIndex);
    if (!sourceDay || !sourceItems) continue;
    const item = asRecord(sourceItems[ref.itemIndex]);
    if (!item) continue;

    // Last line of defence: the proposal path already enforces the invariants,
    // but a plan persisted before they existed must not write a museum visit
    // at 02:00 onto a real trip.
    const moveCategory = classifyItem({ type: asString(item.type), title: textOf(item.title) || ref.label });
    const moveVerdict = isSensibleStart(
      moveCategory,
      textOf(item.title) || ref.label,
      newMs,
      minutesOfDay(ref.time),
    );
    if (!moveVerdict.ok) {
      dropSplices.push({ dayIndex: ref.dayIndex, itemIndex: ref.itemIndex });
      recordCancellation(item, ref.label, describeDropReason(moveVerdict.reason));
      continue;
    }

    const sourceDate = asString(sourceDay.date) ?? isoDateOf(ref.time);
    const targetDate = isoDateOf(newMs);
    const name = ref.label;

    // Swap: replace the title + record the Viator product as the booking ref.
    if (move.replacementName) {
      item.title = move.replacementName;
      if (move.viatorProductCode) item.booking_ref = move.viatorProductCode;
    }
    item.time = hhmmOf(newMs);

    let dayLabel = "today";
    const dayDiff = Math.round(
      (Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${sourceDate}T00:00:00Z`)) /
        (24 * HOUR_MS),
    );
    if (dayDiff === 1) dayLabel = "tomorrow";
    else if (dayDiff !== 0) dayLabel = targetDate;

    if (targetDate !== sourceDate) {
      // Remember the removal; the actual splice waits until every in-place
      // edit has landed (phase b below).
      crossDayMoves.push({
        dayIndex: ref.dayIndex,
        itemIndex: ref.itemIndex,
        item,
        targetDate,
      });
    }

    effects.moved.push(name);
    changes.push(
      move.replacementName
        ? `${name} swapped for ${move.replacementName} (${dayLabel} ${hhmmOf(newMs)})`
        : `${name} moved to ${dayLabel} ${hhmmOf(newMs)}`,
    );
  }

  // (b) Splice removals per day, DESCENDING itemIndex — cross-day moves and
  // W2 drops share ONE pass so neither removal can shift the other's index.
  const removals = [
    ...crossDayMoves.map((move) => ({ dayIndex: move.dayIndex, itemIndex: move.itemIndex })),
    ...dropSplices,
  ];
  removals.sort((a, b) => a.dayIndex - b.dayIndex || b.itemIndex - a.itemIndex);
  for (const removal of removals) {
    const items = itemsAt(removal.dayIndex);
    if (!items) continue;
    items.splice(removal.itemIndex, 1);
  }
  // Then append each moved item to its target day (created at the end of
  // the itinerary when missing).
  for (const move of crossDayMoves) {
    let targetDay = itinerary.find((d) => asRecord(d)?.date === move.targetDate) as
      | Record<string, unknown>
      | undefined;
    if (!targetDay) {
      targetDay = {
        day: itinerary.length + 1,
        date: move.targetDate,
        place: textOf(next.destination) || "",
        travelers: [],
        items: [],
      };
      itinerary.push(targetDay);
    }
    const targetItems = Array.isArray(targetDay.items)
      ? (targetDay.items as unknown[])
      : (targetDay.items = []);
    targetItems.push(move.item);
  }

  // ── 4. Arrival cascade → everything that depends on landing follows ──────
  //
  // The steps above only write what the agents explicitly LISTED. When the
  // hotel provider is unavailable there are no `hotel_actions`, and when the
  // day reorganizer had nothing to say there are no `activity_moves` — so a
  // settlement could rewrite the flight and leave the rest of the day exactly
  // where it was. A real trip came back with the replacement landing at 23:40
  // while the hotel check-in still read 04:15 and the airport transfer 18:30,
  // both hours before the plane touched down.
  //
  // This is the backstop: whatever the agents produced, the written trip has
  // to be internally consistent.
  //
  // The rule is deliberately narrow — move ONLY what was already after the OLD
  // arrival. Something that sat before the old landing (breakfast at the origin
  // on a departure day) was never waiting on this flight and must stay put;
  // something that sat after it plainly was, and is now impossible.
  const cascadeArrivalMs = newFlight ? (parseEpoch(newFlight.arrive) ?? Number.NaN) : Number.NaN;
  if (flightRewriteLanded && Number.isFinite(cascadeArrivalMs) && Number.isFinite(previousArrivalMs)) {
    // How long after touchdown the traveller can actually be somewhere. Sized
    // per route (border control only when there is a border, the real ride
    // into THIS city) instead of one flat number for every airport on earth.
    const replacementOrigin =
      asString(plan.proposed_resolution.new_flight?.origin)?.toUpperCase() ?? previousOriginCode;
    const replacementDestination =
      asString(plan.proposed_resolution.new_flight?.destination)?.toUpperCase() ?? previousDestinationCode;
    const buffer = arrivalBuffer(replacementOrigin, replacementDestination);
    const readyForPickupMs = cascadeArrivalMs + buffer.readyForPickupMinutes * MINUTE_MS;
    const readyInCityMs = cascadeArrivalMs + buffer.readyInCityMinutes * MINUTE_MS;

    // ── 4a. Ground transfers waiting at the airport ──────────────────────────
    //
    // The cascade below only ever looked at itinerary items, so a pre-booked
    // pickup in transit_groups stayed at 12:45 for a plane landing at 19:50.
    // A transfer is waiting on this flight when it leaves from where the flight
    // used to land, after it used to land. It is re-anchored to when the
    // traveller is really standing in arrivals, and follows the flight if the
    // replacement lands at a different airport.
    let transfersMoved = 0;
    const disruptedTransitIndex = disruptedRef?.transitIndex;
    transitGroups.forEach((rawLeg, index) => {
      if (index === disruptedTransitIndex) return;
      const leg = asRecord(rawLeg);
      if (!leg) return;
      if (classifyItem({ method: asString(leg.method) }) !== "ground_transfer") return;
      const departMs = parseEpoch(leg.depart);
      if (departMs === null) return;
      const origin = asRecord(leg.origin);
      const originCode = asString(origin?.code)?.toUpperCase() ?? null;
      const originCity = asString(origin?.city)?.toLowerCase() ?? null;
      const leavesFromArrival =
        (originCode !== null && originCode === previousDestinationCode) ||
        (originCode === null &&
          originCity !== null &&
          previousDestinationCity !== null &&
          originCity === previousDestinationCity.toLowerCase());
      const waitingOnTheOldLanding =
        departMs >= previousArrivalMs - 30 * MINUTE_MS && departMs <= previousArrivalMs + 12 * 60 * MINUTE_MS;
      if (!leavesFromArrival || !waitingOnTheOldLanding) return;

      let touched = false;
      if (
        replacementDestination &&
        originCode !== null &&
        originCode !== replacementDestination
      ) {
        const info = airportInfo(replacementDestination);
        leg.origin = { ...(origin ?? {}), code: replacementDestination, ...(info ? { city: info.city } : {}) };
        // A terminal belongs to the airport it was written for.
        delete (leg.origin as Record<string, unknown>).terminal;
        touched = true;
      }
      const pickupMs = earliestAfterLanding(
        departMs,
        previousArrivalMs,
        cascadeArrivalMs,
        buffer.readyForPickupMinutes,
      );
      if (departMs < pickupMs) {
        leg.depart = toLegStamp(new Date(pickupMs).toISOString());
        touched = true;
      }
      if (!touched) return;
      transfersMoved += 1;
      effects.transfersRetimed += 1;
      const newDepartMs = parseEpoch(leg.depart) ?? departMs;
      changes.push(
        `Airport transfer re-timed to ${hhmmOf(newDepartMs)} to meet the new arrival`,
      );
      if (leg.booked === true) {
        followUps.push({
          kind: "retime_pickup_with_provider",
          message:
            `Your booked transfer now needs to meet you at ${hhmmOf(newDepartMs)}` +
            `${replacementDestination ? ` at ${replacementDestination}` : ""} — ` +
            "confirm the new pickup time with the transfer company.",
        });
      }
    });

    // ── 4b. Everything on the itinerary that depended on landing ────────────
    //
    // Every entry, across every day — matched on its TRUE instant rather than
    // on the day it happens to be filed under. A stay carries its own
    // `check_in` date, which can differ from its day's `date`; hydration reads
    // `check_in` first, so anything scoped by day index alone would judge the
    // wrong moment.
    interface Scheduled {
      item: Record<string, unknown>;
      key: string;
      dayIndex: number;
      itemIndex: number;
      atMs: number;
    }
    const scheduled: Scheduled[] = [];
    for (const [dayIndex, rawDay] of itinerary.entries()) {
      const day = asRecord(rawDay);
      const items = itemsAt(dayIndex);
      if (!day || !items) continue;
      const dayStartMs = Date.parse(`${asString(day.date) ?? ""}T00:00:00Z`);
      for (const [itemIndex, raw] of items.entries()) {
        const item = asRecord(raw);
        if (!item) continue;
        const itemType = asString(item.type)?.toLowerCase() ?? "";
        const isStay = itemType === "stay" || itemType === "hotel";
        // Mirror hydration exactly: a stay is anchored on its check-in date.
        const checkInMs = isStay
          ? Date.parse(`${asString(item.check_in) ?? ""}T00:00:00Z`)
          : Number.NaN;
        const baseMs = Number.isFinite(checkInMs) ? checkInMs : dayStartMs;
        if (!Number.isFinite(baseMs)) continue;
        const minutes = timeStringToMinutes(item.time);
        if (minutes === null) continue; // untimed entries are not "stranded"
        scheduled.push({
          item,
          key: `${dayIndex}:${itemIndex}`,
          dayIndex,
          itemIndex,
          atMs: baseMs + minutes * MINUTE_MS,
        });
      }
    }
    scheduled.sort((a, b) => a.atMs - b.atMs);

    let cursorMs = cascadeArrivalMs;
    let movedCount = 0;
    const movedLabels: string[] = [];
    // Check-ins an explicit hotel action already placed after the landing. They
    // are processed in their ORIGINAL order below, so without reserving them up
    // front a dinner could be booked for the very minute the traveller is
    // still dropping their bags.
    const BAG_DROP_MS = 30 * MINUTE_MS;
    const occupied = scheduled
      .filter(
        (entry) =>
          settledItemKeys.has(entry.key) &&
          entry.atMs >= readyInCityMs &&
          ["stay", "hotel"].includes(asString(entry.item.type)?.toLowerCase() ?? ""),
      )
      .map((entry) => ({ start: entry.atMs, end: entry.atMs + BAG_DROP_MS }));
    const clearOfOccupied = (ms: number): number => {
      let at = ms;
      for (const window of occupied) {
        if (at >= window.start && at < window.end) at = window.end;
      }
      return at;
    };
    const cascadeDrops: Array<{ dayIndex: number; itemIndex: number }> = [];

    for (const entry of scheduled) {
      // The flight's own row is not a thing that waits for the flight.
      if (legRestatementKeys.has(entry.key)) continue;
      // An explicit placement is respected — but only when it is POSSIBLE.
      //
      // The hotel action's new check-in comes from the graph propagation of the
      // NOMINAL delay, not from the replacement the traveller actually chose.
      // Live proof: an agent moved a check-in to 01:00 for a flight that lands
      // at 01:05, five minutes after the room was supposedly taken.
      const explicitlyPlaced = settledItemKeys.has(entry.key);
      if (explicitlyPlaced && entry.atMs >= readyInCityMs) {
        if (entry.atMs >= cursorMs) cursorMs = entry.atMs;
        continue;
      }
      // Was it already waiting on the old landing, and is it now impossible?
      //
      // The trigger is the ARRIVAL, judged against when the traveller can
      // really be there: settling a plan must fix what the new flight broke,
      // not re-plan a day that still works.
      const title = textOf(entry.item.title);
      const category = classifyItem({ type: asString(entry.item.type), title });
      const wasWaitingOnTheOldLanding = entry.atMs >= previousArrivalMs;
      const earliestMs = explicitlyPlaced
        ? readyInCityMs
        : earliestAfterLanding(
            entry.atMs,
            previousArrivalMs,
            cascadeArrivalMs,
            category === "ground_transfer" ? buffer.readyForPickupMinutes : buffer.readyInCityMinutes,
          );
      const isNowImpossible = entry.atMs < earliestMs;
      if (!isNowImpossible || !(wasWaitingOnTheOldLanding || explicitlyPlaced)) {
        if (entry.atMs >= cursorMs) cursorMs = entry.atMs;
        continue;
      }

      // A ride into town is anchored on the arrivals hall, not on the queue of
      // things that happen once the traveller is in town.
      const placementFloor =
        category === "ground_transfer" || category === "lodging"
          ? earliestMs
          : clearOfOccupied(Math.max(cursorMs, earliestMs));
      const placement = placeDisplacedItem({ category, title, originalMs: entry.atMs }, placementFloor);
      if (placement.action === "keep") continue;
      if (placement.action === "drop") {
        // Importance decides who gives way: never the flight, never the bed.
        cascadeDrops.push({ dayIndex: entry.dayIndex, itemIndex: entry.itemIndex });
        recordCancellation(entry.item, title || "An activity", describeDropReason(placement.reason));
        continue;
      }
      entry.item.time = hhmmOf(placement.atMs);
      if (title) effects.moved.push(title);
      movedLabels.push(`${title || "An item"} → ${hhmmOf(placement.atMs)}`);
      if (category === "lodging") {
        // The stay's own check-in date moves with it, or hydration snaps the
        // room straight back on the next load. A late check-in consumes no
        // slot in the day: the bed does not block the evening.
        entry.item.check_in = isoDateOf(placement.atMs);
        movedCount += 1;
        // Dropping bags takes a moment; the bed itself does not block the evening.
        cursorMs = Math.max(cursorMs, placement.atMs + 30 * MINUTE_MS);
        continue;
      }
      movedCount += 1;
      cursorMs =
        category === "ground_transfer"
          ? Math.max(cursorMs, placement.atMs)
          : placement.atMs + 45 * MINUTE_MS;
    }

    // Splice cascade drops per day, DESCENDING, so indices stay valid.
    cascadeDrops.sort((a, b) => a.dayIndex - b.dayIndex || b.itemIndex - a.itemIndex);
    for (const drop of cascadeDrops) itemsAt(drop.dayIndex)?.splice(drop.itemIndex, 1);

    if (movedCount > 0) {
      // Name what moved: "1 item moved" told the traveller something changed
      // without telling them what, on the one screen meant to disclose it.
      changes.push(
        movedLabels.length <= 3
          ? `Arrival cascade: ${movedLabels.join(", ")}`
          : `Arrival cascade: ${movedCount} items moved after the new landing`,
      );
    }
    void transfersMoved;
  }

  return {
    content: next,
    changes,
    flightRewriteLanded,
    ...(flightSkipReason !== undefined ? { flightSkipReason } : {}),
    followUps,
    effects,
  };
}

// -------------------------------------------------------------- persistence

export type SettlePlanResult =
  | {
      updatedContent: Record<string, unknown>;
      changes: string[];
      /** Clarity pass: whether the replacement-flight leg rewrite actually
       *  landed (false ⇒ skipped — e.g. already settled with this booking
       *  code, or the leg no longer resolves). */
      flightRewriteLanded: boolean;
      /** Clarity pass (additive): WHY a flight rewrite was attempted but did
       *  not land. Absent when no flight rewrite was attempted or it landed. */
      flightSkipReason?: "already_settled" | "leg_not_found";
      /** Clarity pass (additive): post-write `trips.content_rev` so the
       *  client can seed its optimistic-concurrency registry without a
       *  refetch. Absent when the rev is unreadable. */
      contentRev?: number;
      /** What the traveller still has to do themselves (additive). */
      followUps?: SettlementFollowUp[];
    }
  | { conflict: true }
  | null;

/** Read the freshest (content_json, content_rev) pair; null on any failure. */
async function readTripRow(
  tripId: string,
): Promise<{ content: Record<string, unknown>; rev: number } | null> {
  try {
    const sb = supabaseAdmin as unknown as { from: (table: string) => any };
    const { data, error } = await sb
      .from("trips")
      .select("content_json,content_rev")
      .eq("id", tripId)
      .maybeSingle();
    if (error || !data) return null;
    const row = asRecord(data);
    const content = asRecord(row?.content_json);
    const rev = typeof row?.content_rev === "number" ? (row.content_rev as number) : null;
    return content && rev !== null ? { content, rev } : null;
  } catch {
    return null;
  }
}

/** CAS write: succeeds only when content_rev still equals `expectedRev`.
 * Returns the POST-WRITE rev (the RETURNING clause runs after the rev-bump
 * trigger — same discipline as src/lib/tripSave.ts), or null when 0 rows
 * matched / the write failed. */
async function casUpdateTripContent(
  tripId: string,
  expectedRev: number,
  content: Record<string, unknown>,
): Promise<{ newRev: number | null } | null> {
  try {
    const sb = supabaseAdmin as unknown as { from: (table: string) => any };
    const { data, error } = await sb
      .from("trips")
      .update({ content_json: content })
      .eq("id", tripId)
      .eq("content_rev", expectedRev)
      .select("content_rev");
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const rev = asRecord(data[0])?.content_rev;
    return { newRev: typeof rev === "number" ? rev : null };
  } catch {
    return null;
  }
}

/**
 * Every nodeId the plan's operational layer addresses must exist in the
 * (possibly rebuilt) nodeRefs — otherwise the concurrent write reshaped the
 * itinerary and settling would hit the wrong entries.
 */
function refsMatchOperational(
  refs: Record<string, SwarmNodeRef>,
  operational: OperationalSettlement,
): boolean {
  if (!refs[operational.disrupted.nodeId]) return false;
  for (const move of operational.activity_moves ?? []) {
    if (!refs[move.nodeId]) return false;
  }
  for (const action of operational.hotel_actions ?? []) {
    if (!refs[action.nodeId]) return false;
  }
  return true;
}

/**
 * Apply an approved plan's operational layer to the trip's content_json with
 * compare-and-swap on `content_rev`: 0 matched rows ⇒ re-read once and retry
 * with FRESHLY REBUILT nodeRefs (the concurrent write may have moved items;
 * if the plan's nodeIds no longer resolve, report `{ conflict: true }`
 * instead of settling against stale indices); a second miss reports
 * `{ conflict: true }` instead of clobbering another device's edits.
 * NEVER throws — load/update failures resolve to `null`.
 */
export async function settlePlanOnTrip(
  tripId: string,
  nodeRefs: Record<string, SwarmNodeRef>,
  plan: ResolutionPlan,
  operational: OperationalSettlement,
): Promise<SettlePlanResult> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const row = await readTripRow(tripId);
      if (!row) return attempt === 0 ? null : { conflict: true };
      let refs = nodeRefs;
      if (attempt > 0) {
        // Re-hydrate from the freshly re-read content: the competing writer
        // may have reordered/removed entries, which silently invalidates the
        // day/item indices captured at mission time.
        const rehydrated = hydrateTripFromContent(tripId, "", "", row.content);
        if (!rehydrated || !refsMatchOperational(rehydrated.nodeRefs, operational)) {
          return { conflict: true };
        }
        refs = rehydrated.nodeRefs;
      }
      const { content, changes, flightRewriteLanded, flightSkipReason, followUps } = applySettlementToContent(
        row.content,
        refs,
        plan,
        operational,
      );
      const written = await casUpdateTripContent(tripId, row.rev, content);
      if (written) {
        return {
          updatedContent: content,
          changes,
          flightRewriteLanded,
          ...(flightSkipReason !== undefined ? { flightSkipReason } : {}),
          ...(written.newRev !== null ? { contentRev: written.newRev } : {}),
          followUps,
        };
      }
      // 0 rows ⇒ concurrent write; loop re-reads and re-applies once.
    }
    return { conflict: true };
  } catch (error) {
    console.warn("[swarm-trip] settlePlanOnTrip failed:", error);
    return null;
  }
}
