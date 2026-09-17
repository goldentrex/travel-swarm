/**
 * Common-sense invariants for re-planned itineraries.
 *
 * A plan can satisfy every schema rule and still be absurd: a 13:00 lunch
 * pushed to 21:20 because the flight landed late, a paid museum ticket moved
 * to 22:05, an airport pickup left waiting at 12:45 for a plane that lands at
 * 19:50. Each of those came out of a live settlement. This module is the one
 * place that decides what a displaced item may become, and it is called from
 * BOTH sides of the approval gate — the proposal the traveller reads and the
 * settlement that rewrites their trip — so the two can never disagree.
 *
 * Pure: no network, no clock. Times follow the codebase convention of a
 * wall clock carried in UTC fields (an itinerary "13:00" is 13:00Z), so the
 * hour of day is read with the UTC accessors.
 *
 * The rules, in the order they bind:
 *
 *  1. Importance. Primary transit outranks lodging, which outranks ground
 *     transfers, which outrank timed activities, meals and sightseeing. A
 *     cascade only ever moves or drops the LOWER-ranked item. Nothing here can
 *     reject a replacement flight to protect a lunch.
 *  2. Nothing happens before the traveller is physically there: an activity at
 *     the destination waits for deplaning, border control, baggage and the
 *     ride into town; a pickup at the airport waits for the first three.
 *  3. Circadian sense. Meals keep to their meal; activities do not start in
 *     sleeping hours (23:30–07:30) unless they are night activities by nature.
 *     A soft item that cannot be kept sensibly on its own day is DROPPED, never
 *     quietly moved into the night or onto another day's plan.
 *  4. Lodging and transfers are never dropped — a late check-in and a late
 *     pickup are real, bookable things at any hour.
 */

import { airportInfo, crossesBorderControl } from "./airports";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// ---------------------------------------------------------------- categories

export type ItemCategory =
  | "primary_transit"
  | "lodging"
  | "ground_transfer"
  | "timed_activity"
  | "meal"
  | "soft_activity";

/** Higher wins a conflict. Gaps leave room for future tiers. */
export const IMPORTANCE: Readonly<Record<ItemCategory, number>> = {
  primary_transit: 100,
  lodging: 80,
  ground_transfer: 60,
  timed_activity: 40,
  meal: 20,
  soft_activity: 10,
};

/** True when `lower` must give way to `higher` in a scheduling conflict. */
export function yieldsTo(lower: ItemCategory, higher: ItemCategory): boolean {
  return IMPORTANCE[lower] < IMPORTANCE[higher];
}

const LONG_HAUL_METHODS = new Set(["flight", "plane", "air"]);
const GROUND_METHODS = new Set([
  "car", "taxi", "transfer", "shuttle", "bus", "coach", "private_transfer", "ride", "uber", "pickup",
]);

/** A ride, whatever the trip calls it: "Metro from the airport" is a transfer, not sightseeing. */
const TRANSPORT_TITLE_PATTERN =
  /\b(metro|subway|train|tram|bus|coach|taxi|cab|uber|grab|lyft|shuttle|transfer|pick-?up|ride|express|airport (?:link|line|rail)|(?:from|to) the (?:airport|station|hotel))\b/i;

const MEAL_PATTERN =
  /\b(breakfast|brunch|lunch|dinner|supper|restaurant|trattoria|osteria|bistro|brasserie|caf[eé]|bakery|food (?:centre|center|court|hall)|hawker|izakaya|ramen|sushi|tapas|taverna|meal|tasting menu|pho)\b/i;
const TIMED_PATTERN =
  /\b(museum|museo|mus[eé]e|gallery|galleria|tour|guided|ticket|show|concert|class|lesson|workshop|cruise|tasting|reservation|palace|cathedral|basilica|temple|shrine|colosseum|observatory|exhibition|performance|opera|theat(?:re|er)|match|stadium|entry|admission|planets)\b/i;
const NIGHT_PATTERN =
  /\b(night|nightlife|evening|sunset|late|bar|club|clubbing|concert|show|cabaret|jazz|karaoke|night market|overnight|red-?eye|stargaz\w*|observatory|ghost tour)\b/i;

export interface ClassifiableItem {
  /** Itinerary item `type` or graph node `type`. */
  type?: string | null;
  /** Transit leg `method`. */
  method?: string | null;
  title?: string | null;
}

export function classifyItem(item: ClassifiableItem): ItemCategory {
  const type = (item.type ?? "").toLowerCase();
  const method = (item.method ?? "").toLowerCase();
  const title = item.title ?? "";

  if (type === "flight" || LONG_HAUL_METHODS.has(method)) return "primary_transit";
  if (type === "stay" || type === "hotel" || type === "hotel_check_in" || type === "lodging") {
    return "lodging";
  }
  if (type === "transfer" || GROUND_METHODS.has(method)) return "ground_transfer";
  // A day-level "transit" row that restates a flight is primary transit; any
  // other transit row is a ground hop.
  if (type === "transit") {
    return /\bflight\b|\b[A-Z]{2}\s?\d{2,4}\b/.test(title) ? "primary_transit" : "ground_transfer";
  }
  if (type !== "dining" && TRANSPORT_TITLE_PATTERN.test(title)) return "ground_transfer";
  if (type === "dining" || type === "food" || type === "restaurant" || MEAL_PATTERN.test(title)) {
    return "meal";
  }
  if (TIMED_PATTERN.test(title)) return "timed_activity";
  return "soft_activity";
}

export function isNightActivity(title: string | null | undefined): boolean {
  return NIGHT_PATTERN.test(title ?? "");
}

// -------------------------------------------------------------- time of day

/** Sleeping hours: nothing but lodging, transit and night activities. */
export const SLEEP_WINDOW = { startMinutes: 23 * 60 + 30, endMinutes: 7 * 60 + 30 } as const;

export function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function isSleepingHour(ms: number): boolean {
  const m = minutesOfDay(ms);
  return m >= SLEEP_WINDOW.startMinutes || m < SLEEP_WINDOW.endMinutes;
}

function utcDayIndex(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export type MealPeriod = "breakfast" | "lunch" | "dinner";

export function mealPeriod(title: string | null | undefined, originalMinutes: number): MealPeriod {
  const t = title ?? "";
  if (/\b(breakfast|brunch|petit[- ]d[eé]jeuner|desayuno|fr[üu]hst[üu]ck)\b/i.test(t)) return "breakfast";
  if (/\b(dinner|supper|d[iî]ner|cena|abendessen)\b/i.test(t)) return "dinner";
  if (/\b(lunch|d[eé]jeuner|almuerzo|mittagessen)\b/i.test(t)) return "lunch";
  if (originalMinutes < 10 * 60 + 30) return "breakfast";
  if (originalMinutes < 16 * 60) return "lunch";
  return "dinner";
}

/** The window a displaced item may still START in, minutes of day. null = any hour. */
export function reasonableStartWindow(
  category: ItemCategory,
  title: string | null | undefined,
  originalMinutes: number,
): { earliest: number; latest: number } | null {
  switch (category) {
    case "primary_transit":
    case "lodging":
    case "ground_transfer":
      return null;
    case "meal": {
      switch (mealPeriod(title, originalMinutes)) {
        case "breakfast":
          return { earliest: 6 * 60 + 30, latest: 10 * 60 + 30 };
        case "lunch":
          return { earliest: 11 * 60, latest: 15 * 60 };
        case "dinner":
          return { earliest: 17 * 60 + 30, latest: 22 * 60 + 30 };
      }
      break;
    }
    case "timed_activity":
    case "soft_activity":
      return isNightActivity(title)
        ? { earliest: 17 * 60, latest: SLEEP_WINDOW.startMinutes }
        : { earliest: SLEEP_WINDOW.endMinutes, latest: 21 * 60 };
  }
  return null;
}

// ----------------------------------------------------------- arrival buffer

export interface ArrivalBuffer {
  deplaneMinutes: number;
  borderMinutes: number;
  baggageMinutes: number;
  cityTransitMinutes: number;
  /** Landing → standing in arrivals, ready for a pickup. */
  readyForPickupMinutes: number;
  /** Landing → at a downtown hotel or activity. */
  readyInCityMinutes: number;
  /** null when either airport is unknown. */
  international: boolean | null;
}

/**
 * The legacy flat buffer (90 min) is kept for trips whose airports are not in
 * the reference table: better an understood default than an invented one.
 */
export const DEFAULT_READY_IN_CITY_MINUTES = 90;
const DEPLANE_MINUTES = 20;
const BORDER_MINUTES = 45;
const BAGGAGE_MINUTES = 25;
/** Policy band for the ride into town: never assume less than 45 or more than 90. */
const CITY_TRANSIT_FLOOR = 45;
const CITY_TRANSIT_CEILING = 90;

export function arrivalBuffer(origin: string | null | undefined, destination: string | null | undefined): ArrivalBuffer {
  const destinationInfo = airportInfo(destination);
  const international = crossesBorderControl(origin, destination);
  if (!destinationInfo || international === null) {
    return {
      deplaneMinutes: DEPLANE_MINUTES,
      borderMinutes: 0,
      baggageMinutes: BAGGAGE_MINUTES,
      cityTransitMinutes: DEFAULT_READY_IN_CITY_MINUTES - DEPLANE_MINUTES - BAGGAGE_MINUTES,
      readyForPickupMinutes: DEPLANE_MINUTES + BAGGAGE_MINUTES,
      readyInCityMinutes: DEFAULT_READY_IN_CITY_MINUTES,
      international,
    };
  }
  const borderMinutes = international ? BORDER_MINUTES : 0;
  const cityTransitMinutes = Math.min(
    CITY_TRANSIT_CEILING,
    Math.max(CITY_TRANSIT_FLOOR, destinationInfo.cityTransitMinutes),
  );
  const readyForPickupMinutes = DEPLANE_MINUTES + borderMinutes + BAGGAGE_MINUTES;
  return {
    deplaneMinutes: DEPLANE_MINUTES,
    borderMinutes,
    baggageMinutes: BAGGAGE_MINUTES,
    cityTransitMinutes,
    readyForPickupMinutes,
    readyInCityMinutes: readyForPickupMinutes + cityTransitMinutes,
    international,
  };
}

/**
 * The earliest an item that was waiting on a landing can now happen.
 *
 * Two principles, both from real trips. A traveller who had planned a tight
 * connection (a pickup 20 minutes after landing) accepted that gap: a
 * replacement landing at the same time must not re-plan their day. But an
 * item that had room to spare must not be squeezed below a realistic buffer
 * just because the plane is later. So the gap they accepted is kept, capped
 * at the realistic buffer.
 */
export function earliestAfterLanding(
  itemMs: number,
  previousArrivalMs: number,
  newArrivalMs: number,
  bufferMinutes: number,
): number {
  const acceptedGapMs = Math.max(0, itemMs - previousArrivalMs);
  return newArrivalMs + Math.min(acceptedGapMs, bufferMinutes * MINUTE_MS);
}

// ------------------------------------------------------ displaced placement

export type DropReason = "sleeping_hours" | "outside_meal_or_opening_window" | "would_move_to_another_day";

export type Placement =
  | { action: "keep" }
  | { action: "move"; atMs: number }
  | { action: "drop"; reason: DropReason };

export interface DisplacedItem {
  category: ItemCategory;
  title?: string | null;
  /** Where it was scheduled, epoch ms (wall clock in UTC fields). */
  originalMs: number;
}

/**
 * Decide what happens to an item the new arrival made impossible.
 *
 * `earliestMs` is the first instant the traveller can actually be there. The
 * item is moved to exactly that instant when doing so still makes sense for
 * what the item IS; otherwise it is dropped with a reason a person would
 * accept. It is never pushed onto another calendar day — tomorrow already has
 * its own plan, and silently stacking into it is how a day of eight items
 * became a day of eleven.
 */
export function placeDisplacedItem(item: DisplacedItem, earliestMs: number): Placement {
  if (item.category === "primary_transit") return { action: "keep" };
  const atMs = Math.max(item.originalMs, earliestMs);
  if (item.category === "lodging" || item.category === "ground_transfer") {
    return atMs === item.originalMs ? { action: "keep" } : { action: "move", atMs };
  }
  if (atMs === item.originalMs) return { action: "keep" };
  if (utcDayIndex(atMs) !== utcDayIndex(item.originalMs)) {
    return { action: "drop", reason: "would_move_to_another_day" };
  }
  const verdict = isSensibleStart(item.category, item.title, atMs, minutesOfDay(item.originalMs));
  return verdict.ok ? { action: "move", atMs } : { action: "drop", reason: verdict.reason };
}

/** Plain-language reason, for change lines and plan rows. */
export function describeDropReason(reason: DropReason): string {
  switch (reason) {
    case "sleeping_hours":
      return "the only remaining slot is during sleeping hours";
    case "outside_meal_or_opening_window":
      return "you land too late for it to still make sense that day";
    case "would_move_to_another_day":
      return "it could only happen on another day, which already has its own plan";
  }
}

// ------------------------------------------------ proposal-time rescheduling

export interface ProposedMove {
  name: string;
  new_time: string;
  new_time_iso?: string;
  penalty: number;
  reason?: string;
  action?: "reschedule" | "swap" | "drop";
}

/**
 * Is `atMs` a sensible START for this item, judged on the clock alone?
 * Lodging, transit and transfers are always acceptable — a late check-in and a
 * late pickup are real services.
 */
export function isSensibleStart(
  category: ItemCategory,
  title: string | null | undefined,
  atMs: number,
  originalMinutes: number = minutesOfDay(atMs),
): { ok: true } | { ok: false; reason: DropReason } {
  if (category === "primary_transit" || category === "lodging" || category === "ground_transfer") {
    return { ok: true };
  }
  const window = reasonableStartWindow(category, title, originalMinutes);
  if (window && minutesOfDay(atMs) > window.latest) {
    return { ok: false, reason: "outside_meal_or_opening_window" };
  }
  if (isSleepingHour(atMs) && !isNightActivity(title)) return { ok: false, reason: "sleeping_hours" };
  return { ok: true };
}

/**
 * Enforce the invariants on an agent's reschedule proposal before a traveller
 * ever reads it. A slot in sleeping hours or past the item's sensible window
 * becomes an honest drop; a slot before the traveller can be in town is
 * brought forward to the first real one, then judged again.
 *
 * Unlike an arrival cascade, a proposal MAY land on another day: the weather
 * path deliberately moves a rained-off outdoor activity to tomorrow, and that
 * is a decision, not a side effect.
 *
 * The penalty is untouched — the cancellation terms that applied to the move
 * apply to the drop — so the ledger identity is unaffected.
 */
export function enforceMoveSanity(
  proposal: ProposedMove,
  context: { readyInCityMs?: number; originalMs?: number } = {},
): ProposedMove {
  if (proposal.action === "drop" || typeof proposal.new_time_iso !== "string") return proposal;
  const proposedMs = Date.parse(proposal.new_time_iso);
  if (!Number.isFinite(proposedMs)) return proposal;
  const category = classifyItem({ title: proposal.name });
  const originalMinutes = minutesOfDay(context.originalMs ?? proposedMs);
  const atMs =
    typeof context.readyInCityMs === "number" && Number.isFinite(context.readyInCityMs)
      ? Math.max(proposedMs, context.readyInCityMs)
      : proposedMs;
  const verdict = isSensibleStart(category, proposal.name, atMs, originalMinutes);
  if (!verdict.ok) {
    const { new_time_iso: _slot, ...rest } = proposal;
    return {
      ...rest,
      action: "drop",
      reason: `Cancelled — ${describeDropReason(verdict.reason)}.`,
    };
  }
  if (atMs === proposedMs) return proposal;
  const iso = new Date(atMs).toISOString();
  return { ...proposal, new_time_iso: iso, new_time: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` };
}
