/**
 * OrchestratorAgent — top-level coordinator of the Level-4 agentic pipeline.
 *
 * Responsibilities (in order, spec §2.2 flow):
 *   1. RECEIVE a disruption event (e.g. "flight XY123 delayed by 4h").
 *   2. COMPUTE impact surface via the itinerary dependency graph
 *      (ItineraryGraph.handleDisruption propagates the delay downstream).
 *   3. GATE flight rebooking through the PolicyAgent fare-rule verdict when
 *      the disrupted node is a flight; delegate the FlightAgent only when
 *      `rebookPermitted === true`.
 *   4. PROTECT impacted hotel check-ins via the HotelAgent
 *      (late check-in / cancellation fees / alternative rooms).
 *   5. RESCHEDULE impacted activities via the ActivityAgent — real proposals
 *      and penalties replace the former `rescheduledActivities = []` and
 *      `MOCK_ACTIVITY_PENALTY = 20` scaffold mocks.
 *   6. ASSEMBLE a deterministic `ResolutionPlan` (TrustLayer schema, spec
 *      §3.4 ledger) — the ONLY shape in which money/booking proposals may
 *      leave the agent system, always flagged `requires_human_approval: true`.
 *
 * The orchestrator never books or charges anything itself; it only produces
 * the approval payload. Execution happens downstream, strictly after a human
 * approves the plan.
 *
 * Backward compatibility: the Policy/Hotel/Activity agents are optional
 * constructor arguments. Without them the orchestrator behaves like the
 * original scaffold (flight rebooking always attempted, no hotel/activity
 * deltas), so pre-swarm call sites keep working unchanged.
 */

import { rateFromEurOf, type Currency } from "@/lib/i18n/translations";
import type {
  ActivityNode,
  AffectedNodeReport,
  DisruptionPropagationOptions,
  DisruptionResult,
  Duration,
  HotelCheckInNode,
  ItineraryNode,
} from "@/core/dag";
import { ItineraryGraph } from "@/core/dag";
import {
  EXCESSIVE_JOURNEY,
  arrivalBuffer,
  arrivalWindows,
  clampToWindowStart,
  classifyItem,
  criticCategoryOf,
  describeDropReason,
  deterministicCriticisms,
  isSensibleStart,
  journeyStretchFactor,
  minutesOfDay,
  rulingsFor,
  unstayedNights,
  utcDayIndex,
} from "@/core/sanity";
import { VenueHours, decideFromHours } from "@/core/sanity";
import type { VenueQuery } from "@/core/sanity";
import type {
  CriticContext,
  CriticItem,
  CriticRuling,
  CriticVerdict,
  SemanticCritic,
} from "@/core/sanity";
import type {
  FlightAgent,
  FlightRebookingAssessment,
  NoReplacementReason,
  RebookingCandidate,
} from "@/agents/flight/FlightAgent";
import type { FlightOption, FlightRouteContext } from "@/providers/interfaces/types";
import type {
  WeatherContextProvider,
  EventDisruptionContextProvider,
} from "@/providers/interfaces/ContextProviders";
import type { PolicyAgent, FarePolicyVerdict } from "@/agents/policy/PolicyAgent";
import type { HotelAgent } from "@/agents/hotel/HotelAgent";
import type {
  ActivityAgent,
  ActivityRescheduleProposal,
  ActivityRescheduleRequest,
} from "@/agents/activity/ActivityAgent";
import type { DayActivityInput, DayReorganizer } from "@/agents/activity/DayReorganizer";
import type { ResolutionConstraints } from "@/agents/liaison/GeminiLiaisonAgent";
import { resolutionPlanToJson, validateResolutionPlan } from "@/agents/finance/TrustLayer";
import type {
  FinancialDelta,
  HotelAdjustment,
  ProposedResolution,
  RescheduledActivityProposal,
  ResolutionPlan,
  TransferRequote,
} from "@/agents/finance/TrustLayer";

/** External trigger handed to the orchestrator (spec §3.2 — extended). */
export interface DisruptionEvent {
  /** Id of the disrupted itinerary-graph node. */
  nodeId: string;
  /** Delay amount: minutes as a number, or a `{ minutes }` Duration. */
  delay: number | Duration;
  /** Human-readable incident line, e.g. "Flight XY123 delayed by 4h". */
  description: string;
  /** NEW — who raised the event. Default "reactive" (user/simulate). */
  origin?: "reactive" | "proactive";
  /** NEW — owning trip, required for the background flow (graph hydration). */
  tripId?: string;
  /**
   * NEW — this mission legitimately wants FEWER activities, so the reorganizer
   * may drop one even when the day is feasible with all of them.
   *
   * The drop guard exists to stop a model quietly deleting an activity to make
   * its own schedule easier. But "I'm feeling unwell, lighten my day" and "my
   * activity got cancelled" are requests to remove something — and refusing
   * every drop there threw away the model's correct answer and handed back a
   * deterministic schedule that kept everything, i.e. the opposite of what was
   * asked. Set only for those missions; everything else keeps the strict rule.
   */
  allowsActivityDrops?: boolean;
  /**
   * NEW — the traveller asked for TODAY to be lighter, not for one item to be
   * pushed into tomorrow.
   *
   * `allowsActivityDrops` says a drop is permitted; this says what the mission
   * is actually FOR. The distinction earns its place because the synthesis for
   * a proactive user_report asks for a slot 24–48h out, which is right for "my
   * tour was cancelled, find me another slot" and wrong for "I feel ill".
   * Measured live on 2026-09-18, "I'm feeling unwell, lighten my day" moved
   * exactly one activity to the following evening on all six trips: today was
   * not lightened at all, and tomorrow — which may be a departure day — gained
   * an item the traveller never asked for.
   */
  lightenDay?: boolean;
  /**
   * NEW — the problem is getting from A to B, and NOTHING about the bookings
   * themselves has changed.
   *
   * A cancelled taxi does not change which flight you are on. Live on
   * 2026-09-18, "My taxi to the airport is cancelled" landed on the next
   * flight node, ran a full replacement search over six dates, found none, and
   * headlined the plan "this route isn't covered by our flight partner yet, so
   * this change has to be booked with the airline yourself" — a sentence about
   * a rebooking the traveller never asked for, on a mission about a car.
   *
   * With this set the flight rail stands down. The ground rail answers, the
   * itinerary is left alone, and the plan says the one thing that is true.
   */
  groundOnly?: boolean;
  /**
   * NEW — the traveller asked a QUESTION about the itinerary as booked.
   * Nothing is late, nothing is broken, and no booking may change.
   *
   * "Is my connection too tight?" arrives as a 0-minute delay on the leg at
   * risk, which the graph correctly treats as no impact at all — and the
   * flight rail then went looking for a replacement anyway, because it was
   * gated on "the source is a flight", not on "something is wrong with it".
   * With a live provider that returns a seat, the re-drive shifted the day by
   * the replacement's later arrival, priced a fare and a change fee, and put
   * "Requires your approval" over a rebooking of a flight nobody had missed.
   * Without one, the headline gained "this needs a manual booking". Both are
   * answers to a question that was never asked.
   *
   * With this set every rail that could change a booking stands down. The
   * answer lives in the presentation (the connection verdict), the itinerary
   * is left exactly as it was, and the plan changes nothing.
   */
  adviceOnly?: boolean;
  /** NEW — provider evidence behind proactive alerts. */
  evidence?: {
    kind: "weather" | "event" | "user_report";
    /** e.g. "openweathermap:5004614". */
    source: string;
    /** 0..1. */
    confidence: number;
    /** e.g. "Heavy rain 14:00–20:00 local, 92% precip probability". */
    detail: string;
  };
  /**
   * NEW — carrier for the Atlas `rule` payload (refundRules/changesRules/
   * baggageElements embedded in search.do/verify.do). Optional: without it
   * the PolicyAgent falls back to the passenger-favourable default verdict
   * at reduced confidence.
   */
  fareRule?: Record<string, unknown>;
  /**
   * NEW — hydrated-trip context (real-trip missions): scopes specialist
   * provider searches to the destination and quotes deltas in the trip's
   * currency. Absent on the frozen demo graph.
   */
  tripContext?: {
    city?: string;
    currency?: string;
    /**
     * The currency the TRAVELLER reads in — their app-wide display preference,
     * which is often neither the trip's nor any provider's. The confirm screen
     * is denominated in it so one purchase reads as one number; the untouched
     * per-provider figures stay in `by_currency`.
     */
    displayCurrency?: string;
  };
}

/** Full pipeline outcome: the approval plan plus the raw specialist outputs. */
export interface OrchestrationOutcome {
  plan: ResolutionPlan;
  disruption: DisruptionResult;
  rebookingAssessment: FlightRebookingAssessment | null;
  /** NEW — HotelAgent adjustments feeding proposed_resolution.hotel_adjustments. */
  hotelAdjustments: HotelAdjustment[];
  /** NEW — ActivityAgent proposals feeding rescheduled_activities + penalties. */
  activityProposals: ActivityRescheduleProposal[];
  /** NEW — PolicyAgent gate verdict (null when no policy agent / non-flight). */
  policyVerdict: FarePolicyVerdict | null;
}

/**
 * Raw specialist outputs of the FAST assess phase (two-phase flow, phase 1):
 * the same pipeline as {@link OrchestratorAgent.resolveDisruption} through the
 * specialist fan-outs, but WITHOUT any TrustLayer plan assembly — the
 * hackathon API persists these candidates between assess and resolve.
 */
export interface DisruptionAssessment {
  disruption: DisruptionResult;
  rebookingAssessment: FlightRebookingAssessment | null;
  hotelAdjustments: HotelAdjustment[];
  activityProposals: ActivityRescheduleProposal[];
  policyVerdict: FarePolicyVerdict | null;
  /** Display labels of the impacted nodes (`impacted_nodes` feed). */
  impactedNodes: string[];
  /**
   * ADDITIVE (review fix) — the disrupted flight's TRUE pre-disruption
   * departure (epoch ms), captured BEFORE impact propagation mutated the
   * graph node (`departureTime += delayMs`). Callers must NEVER re-derive
   * this from the shared graph after the pipeline ran — a simulated delay
   * crossing UTC midnight would shift the anchor to the wrong day (the
   * resolve phase pins against this same pre-mutation capture). Absent for
   * non-flight sources.
   */
  originalDepartureMs?: number;
}

/**
 * Multi-plan outcome of the two-phase resolve phase: up to
 * {@link MAX_PLANS_PER_CAROUSEL} DISTINCT ResolutionPlans (W1 per-candidate
 * carousel — one plan per non-dominated candidate, tagged cheapest /
 * fastest / nonstop / same_day / next_day, deduplicated via the canonical
 * {@link resolutionPlanToJson} form), each independently validated, plus the
 * shared pipeline provenance (OrchestrationOutcome fields) and
 * human-readable trace notes about constraint application / dedup.
 */
export interface MultiPlanOutcome {
  /** 1–5 distinct plans, each stamped with its derived `badge`/`badges`. */
  plans: ResolutionPlan[];
  disruption: DisruptionResult;
  rebookingAssessment: FlightRebookingAssessment | null;
  hotelAdjustments: HotelAdjustment[];
  activityProposals: ActivityRescheduleProposal[];
  policyVerdict: FarePolicyVerdict | null;
  /** Deterministic notes: constraint filtering, dedup, degradation. */
  trace: string[];
  /**
   * ADDITIVE (Task 20) — parallel array to {@link plans}: the activity
   * proposals consistent with EACH plan's OWN replacement arrival (re-driven
   * from the untouched baseline, deduped by exact arrival ISO — plans sharing
   * an arrival share one rederive walk and one proposal-set reference).
   * Flight-less plans carry the shared pipeline proposals. The shared
   * {@link activityProposals} field stays plan-0's set for back-compat.
   */
  planActivityProposals: ActivityRescheduleProposal[][];
}

/** Display label for an itinerary node, used in `impacted_nodes`. */
function nodeLabel(node: ItineraryNode): string {
  switch (node.type) {
    case "flight":
      return `Flight ${node.flightNumber}`;
    case "transfer":
      return "Transfer";
    case "hotel_check_in":
      return `Hotel Check-in (${node.hotelName})`;
    case "activity":
      return node.name;
  }
}

/** Deterministic disruption-kind classification from the incident text. */
function classifyDisruptionKind(description: string): "delay" | "missed_flight" | "cancellation" {
  if (/miss(ed|ing)?\b/i.test(description)) return "missed_flight";
  if (/cancel/i.test(description)) return "cancellation";
  return "delay";
}

/** Deterministic weather hint from proactive evidence (drives activity swaps). */
function weatherHintFromEvent(event: DisruptionEvent): "rain" | "storm" | undefined {
  if (event.evidence?.kind !== "weather") return undefined;
  if (/storm|thunder/i.test(event.evidence.detail)) return "storm";
  if (/rain|precip|shower/i.test(event.evidence.detail)) return "rain";
  return undefined;
}

/**
 * Human-readable slot label for rescheduled_activities (UTC-based).
 * Exported so the hackathon API's degraded fallback can reuse the SAME
 * formatter instead of emitting raw ISO strings.
 */
export function formatNewTime(originalIso: string, newIso: string): string {
  const original = new Date(originalIso);
  const next = new Date(newIso);
  if (Number.isNaN(original.getTime()) || Number.isNaN(next.getTime())) return newIso;
  const hhmm = `${String(next.getUTCHours()).padStart(2, "0")}:${String(next.getUTCMinutes()).padStart(2, "0")}`;
  const dayDiff = Math.round(
    (Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()) -
      Date.UTC(original.getUTCFullYear(), original.getUTCMonth(), original.getUTCDate())) /
      (24 * 60 * 60 * 1000),
  );
  if (dayDiff === 1) return `Tomorrow ${hhmm}`;
  if (dayDiff === 0) return `Today ${hhmm}`;
  return `${next.toISOString().slice(0, 10)} ${hhmm}`;
}

/**
 * Deterministic provider quote horizons (spec §3.5 TTL). These are fixed
 * demo horizons: the real provider expiry payload (Atlas / hotel API) is a
 * future plug-in point — until then the constants below define how long a
 * quote stays bookable, and the SHORTEST horizon wins on the final plan.
 */
const ATLAS_QUOTE_TTL_MS = 15 * 60 * 1000; // Atlas sandbox flight quotes: 15 min
const HOTEL_QUOTE_TTL_MS = 30 * 60 * 1000; // Hotel (RapidAPI) quotes: 30 min

/**
 * Spec §2.4 — deterministic transfer re-quote charge. A spatial mismatch
 * forces the traveller to re-book the ride from the new arrival location;
 * until the full Transfer Agent ships (v2) a fixed quote is folded into
 * `total_new_charges` and surfaced as `proposed_resolution.transfer_requote`.
 */
export const TRANSFER_REQUOTE_CHARGE = 45;

// Reason prefix emitted by ItineraryGraph for spatial transfer conflicts.
const SPATIAL_MISMATCH_PREFIX = "Spatial mismatch";

/**
 * Task 20 — arrival-floor sweep buffer: mirrors ItineraryGraph's default
 * activity buffer (120 min). A downstream activity/hotel_check_in that the
 * propagation walk never reached (no AFFECTED upstream) but that is booked
 * at or before `replacement arrival + this buffer` is still inside the
 * traveler's unavailable window and gets flagged by the sweep.
 */
const ARRIVAL_FLOOR_BUFFER_MINUTES = 120;

/**
 * Task 20 — effective delay of a rebooking: minutes from the disrupted
 * flight's TRUE original arrival to the replacement's arrival, clamped ≥ 0.
 * The replacement flight's REAL arrival is the impact driver; the nominal
 * incident delay is only the fallback when the replacement arrival is
 * unknown/unparseable. Exported for unit tests; pure.
 */
export function effectiveDelayMinutes(
  originalArrivalMs: number,
  replacementArrivalIso: string | undefined,
  nominalDelayMinutes: number,
): number {
  const fallback = Number.isFinite(nominalDelayMinutes) ? Math.max(0, nominalDelayMinutes) : 0;
  if (replacementArrivalIso === undefined) return fallback;
  const replacementMs = Date.parse(replacementArrivalIso);
  if (!Number.isFinite(originalArrivalMs) || !Number.isFinite(replacementMs)) {
    return fallback;
  }
  return Math.max(0, Math.round((replacementMs - originalArrivalMs) / 60_000));
}

async function geocodeCity(city: string): Promise<{ lat: number; lng: number } | null> {
  // The STRUCTURED `city=` parameter is strict: it matches a bare city name
  // and nothing else. A trip is titled by its destination, so what arrives
  // here is "Rome, Italy", "London, United Kingdom", "Japan (Tokyo, Osaka,
  // Kyoto)" — and every one of those returned nothing, silently. Measured
  // live on 2026-09-18, only "Bali" resolved, 1 trip of 6.
  //
  // The free-form `q=` parameter is what a person would type, and the first
  // segment of the name is the place: everything after a comma is the
  // administrative tail the search does not need, and a parenthesis opens a
  // list of cities rather than naming one.
  const query = city.split(/[(,]/)[0].trim() || city.trim();
  if (!query) return null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      {
        headers: { "User-Agent": "AIGlobePlanner-Hackathon/1.0" },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any[];
    if (data && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) return { lat, lng };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Where the mission actually is, for a provider that needs a point.
 *
 * The trip already knows. Its activities and its hotels carry the venue's own
 * coordinates, hydrated from `content_json`, and the mission names one of
 * them. Reading that costs no network, cannot fail on a decorated place name,
 * and is the spot the traveller is standing on rather than a city centroid —
 * which for "is it raining on this walk" is a better question answered.
 *
 * Order: the mission's own node, then the nearest other node in time that has
 * coordinates (the same day's plans are the same weather), then geocoding the
 * destination name as a last resort.
 */
async function missionCoordinates(
  graph: ItineraryGraph,
  nodeId: string,
  city: string | undefined,
): Promise<{ lat: number; lng: number } | null> {
  const coordsOf = (node: ItineraryNode | undefined): { lat: number; lng: number } | null => {
    if (!node) return null;
    const point =
      node.type === "activity" || node.type === "hotel_check_in" ? node.coordinates : undefined;
    return point && Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
  };

  const target = graph.getNode(nodeId);
  const own = coordsOf(target);
  if (own) return own;

  const anchor = target?.scheduledTime ?? 0;
  const nearest = graph
    .getNodes()
    .map((node) => ({ node, point: coordsOf(node) }))
    .filter(
      (entry): entry is { node: ItineraryNode; point: { lat: number; lng: number } } =>
        entry.point !== null,
    )
    .sort(
      (a, b) => Math.abs(a.node.scheduledTime - anchor) - Math.abs(b.node.scheduledTime - anchor),
    )[0];
  if (nearest) return nearest.point;

  return city ? geocodeCity(city) : null;
}

/** Signed net fare impact of a rebooking candidate (charge positive, refund negative). */
function candidateNetCharge(candidate: RebookingCandidate): number {
  const { amount, direction } = candidate.fareDifference;
  return direction === "charge" ? amount : -amount;
}

/** Arrival epoch in ms; unparseable arrivals sort LAST (worst-case). */
function candidateArrivalMs(candidate: RebookingCandidate): number {
  const t = Date.parse(candidate.option.arrivalTime);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Whether two ISO timestamps fall on the SAME UTC calendar day. Returns
 * `null` when either timestamp is unparseable — such pairs KEEP the legacy
 * comparability (they remain comparable, exactly as before this guard).
 */
function sameUtcDay(aIso: string, bIso: string): boolean | null {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const dayA = new Date(a);
  const dayB = new Date(b);
  return (
    dayA.getUTCFullYear() === dayB.getUTCFullYear() &&
    dayA.getUTCMonth() === dayB.getUTCMonth() &&
    dayA.getUTCDate() === dayB.getUTCDate()
  );
}

/**
 * Pareto frontier of the priced candidates: an option that is BOTH costlier
 * AND later than another option (same quote currency) is never a rational
 * pick, so it is filtered out BEFORE profile selection. Candidate B is
 * dominated when some A exists with `netCharge(A) <= netCharge(B)` AND
 * `arrival(A) <= arrival(B)`, at least one strict, AND identical
 * `fareDifference.currency`. Cross-currency pairs are NON-comparable (no
 * FX conversion in the trust layer) and both members are kept.
 *
 * Same-day comparability guard: dominance additionally requires BOTH
 * `option.departureTime` values to parse AND fall on the SAME UTC calendar
 * day ({@link sameUtcDay}). A next-day departure is a genuinely different
 * travel plan — the missed daily flight's only replacement is usually the
 * next day's, and those are (by definition) costlier AND later; filtering
 * them collapsed every missed-flight frontier to one option. Unparseable
 * pairs keep the legacy comparability (null ⇒ comparable).
 * Pure + order-preserving: kept candidates stay in their input order.
 */
/**
 * The headline clause for a search that produced no bookable replacement.
 *
 * Only `route_not_covered` is allowed to name the partner, and only because
 * the FlightAgent proves it first: the provider answered on several distinct
 * dates and had nothing on any of them. Every other case keeps the blame where
 * it belongs — usually with our own rebooking rules.
 */
export function noReplacementHeadline(reason: NoReplacementReason | undefined): string {
  switch (reason) {
    case "route_not_covered":
      return (
        "this route isn't covered by our flight partner yet, so this change has " +
        "to be booked with the airline yourself"
      );
    case "all_options_rejected":
      return (
        "the flights we found all leave too late to still be a rebooking — " +
        "changing this one means replanning the trip around it"
      );
    case "pricing_unavailable":
      return "we found flights but could not price them just now — worth trying again shortly";
    case "search_declined":
      // NOT a coverage claim: the provider refused to look at all.
      return "the flight search could not be run for these dates; this needs a manual booking";
    default:
      return "no replacement flight found on this date; this needs a manual booking";
  }
}

/**
 * Collapse the provider's pricing basis into the three things a traveller
 * needs told apart: a provider-verified fare, a search price nobody re-checked,
 * and an estimate nobody sold.
 */
export function fareBasisOf(
  candidate: RebookingCandidate,
): "verified" | "search_reference" | "synthetic_estimate" {
  if (
    candidate.fareDifference.basis === "synthetic_estimate" ||
    candidate.option.inventorySource === "synthetic_recovery"
  ) {
    return "synthetic_estimate";
  }
  if (candidate.fareDifference.basis === "search_reference") return "search_reference";
  return "verified";
}

export function nonDominatedCandidates(
  candidates: RebookingCandidate[],
  /**
   * What a candidate costs. Defaults to the fare difference; the orchestrator
   * passes fare PLUS the carrier's own change fee. Dominance decided on the
   * fare alone can drop the option that is genuinely cheaper once the fee is
   * counted — the same blind spot that badged a dearer plan "cheapest".
   */
  costOf: (candidate: RebookingCandidate) => number = candidateNetCharge,
): RebookingCandidate[] {
  return candidates.filter((b) => {
    const chargeB = costOf(b);
    const arrivalB = candidateArrivalMs(b);
    return !candidates.some((a) => {
      if (a === b) return false;
      if (a.fareDifference.currency !== b.fareDifference.currency) return false;
      // Next-day departures are never dominated by same-route earlier days.
      if (sameUtcDay(a.option.departureTime, b.option.departureTime) === false) return false;
      const chargeA = costOf(a);
      const arrivalA = candidateArrivalMs(a);
      return (
        chargeA <= chargeB && arrivalA <= arrivalB && (chargeA < chargeB || arrivalA < arrivalB)
      );
    });
  });
}

/**
 * W1 per-candidate carousel cap: one plan per non-dominated candidate,
 * bounded so the session jsonb (and the approval carousel) stays small.
 */
export const MAX_PLANS_PER_CAROUSEL = 5;

/** Frozen badge vocabulary in canonical order (mirrors the TrustLayer
 *  validator): drives the post-dedup union stamp. */
const BADGE_ORDER: ReadonlyArray<NonNullable<ResolutionPlan["badge"]>> = [
  "cheapest",
  "fastest",
  "balanced",
  "nonstop",
  "same_day",
  "next_day",
];

/**
 * The PURE constraint filtering shared by resolveDisruptionMulti and the
 * hackathon API's discrimination filter: `max_price` narrows the pool
 * (all-filtered ⇒ keep everything and note the exception, so the traveler
 * is never offered NOTHING), `prefer_direct`/`prefer_nonstop` prefer
 * non-stop routings, and the Pareto frontier drops costlier-and-later
 * options. Order-preserving; returns the filtering trace notes alongside.
 */
export function applyConstraintsToCandidates(
  candidates: RebookingCandidate[],
  constraints?: ResolutionConstraints,
  /**
   * What one candidate COSTS, for ranking and for the budget ceiling.
   *
   * Defaults to the fare difference alone, which is all a caller without the
   * fare rules can know. `resolveDisruptionMulti` passes the real number: the
   * fare difference PLUS the change fee that candidate's own carrier
   * publishes. Without it a plan can be labelled "cheapest" while costing the
   * most — photographed 2026-09-20 with a €96.25 Scoot plan badged cheapest
   * beside an AirAsia one that hands €1.65 BACK, because the €120 change fee
   * was not in the comparison.
   */
  costOf: (candidate: RebookingCandidate) => number = candidateNetCharge,
): { candidates: RebookingCandidate[]; notes: string[] } {
  const notes: string[] = [];
  let pool = [...candidates];
  if (constraints?.max_price !== undefined && pool.length > 0) {
    const ceiling = constraints.max_price;
    const within = pool.filter((candidate) => costOf(candidate) <= ceiling);
    if (within.length === 0) {
      notes.push(`max_price ${ceiling} exceeded by every candidate — keeping the cheapest option`);
    } else if (within.length < pool.length) {
      notes.push(`max_price ${ceiling} filtered out ${pool.length - within.length} candidate(s)`);
      // W1e additive echo: the traveler's budget answer is visible in the
      // trace (stamped at FILTER time — the selection core below may run on
      // an already-filtered pool and would never see the narrowing itself).
      notes.push("keeping plans within your budget, as you asked");
      pool = within;
    }
  }
  // A PREFERENCE, not a filter. It used to drop every option with a stop, and
  // on a route where one flight is direct that left the traveller with a
  // single plan and no alternatives — they answered a question and lost their
  // choices for it. `selectPlanCandidates` PINS the non-stop options to the
  // front instead, which is what "prefer" has always meant for
  // `prefer_same_day` and `prefer_earliest`; the rest stay offered behind it.
  if (
    (constraints?.prefer_direct === true || constraints?.prefer_nonstop === true) &&
    pool.length > 0
  ) {
    const direct = pool.filter(isDirectCandidate);
    if (direct.length > 0 && direct.length < pool.length) {
      notes.push(
        `prefer_direct — ${direct.length} non-stop candidate(s) come first, ` +
          `${pool.length - direct.length} option(s) with a stop still offered`,
      );
    }
  }
  // Pareto frontier BEFORE selection: an option that is costlier AND later
  // than another same-currency option is never offered.
  const frontier = nonDominatedCandidates(pool, costOf);
  if (frontier.length < pool.length) {
    notes.push(
      `${pool.length - frontier.length} dominated option(s) filtered (costlier and later) — not offered`,
    );
    pool = frontier;
  }
  return { candidates: pool, notes };
}

/**
 * W1 plan selection core (pure): constraint filtering
 * ({@link applyConstraintsToCandidates}) → deterministic base ordering
 * (cheapest net first, then arrival, then option id) → constraint PINNING
 * (candidates matching an active preference — nonstop / same-day / earliest
 * arrival — move to the front, stable) → the {@link MAX_PLANS_PER_CAROUSEL}
 * cap. Every ordering effect pushes one human-readable trace note, including
 * the W1e echo lines ("prioritising nonstop, as you asked") that make the
 * traveler's answers visibly matter. Shared by resolveDisruptionMulti and
 * the discrimination filter so both reason over the SAME plan rail.
 */
export function selectPlanCandidates(
  candidates: RebookingCandidate[],
  constraints?: ResolutionConstraints,
  anchorDepartureMs?: number,
  /** See `applyConstraintsToCandidates` — the real cost of a candidate. */
  costOf: (candidate: RebookingCandidate) => number = candidateNetCharge,
): { ordered: RebookingCandidate[]; notes: string[] } {
  const { candidates: pool, notes } = applyConstraintsToCandidates(candidates, constraints, costOf);
  const base = [...pool].sort(
    (a, b) =>
      costOf(a) - costOf(b) ||
      candidateArrivalMs(a) - candidateArrivalMs(b) ||
      a.option.id.localeCompare(b.option.id),
  );

  // W1e pinning: one entry per ACTIVE preference, applied in fixed order.
  const anchorIso =
    anchorDepartureMs !== undefined ? new Date(anchorDepartureMs).toISOString() : undefined;
  const pins: Array<{ echo: string; test: (candidate: RebookingCandidate) => boolean }> = [];
  if (constraints?.prefer_nonstop === true || constraints?.prefer_direct === true) {
    pins.push({ echo: "prioritising nonstop, as you asked", test: isDirectCandidate });
  }
  if (constraints?.prefer_same_day === true && anchorIso !== undefined) {
    pins.push({
      echo: "prioritising same-day departure, as you asked",
      test: (candidate) => sameUtcDay(candidate.option.departureTime, anchorIso) === true,
    });
  }
  if (constraints?.prefer_earliest === true && base.length > 0) {
    const minArrival = Math.min(...base.map(candidateArrivalMs));
    pins.push({
      echo: "prioritising earliest arrival, as you asked",
      test: (candidate) => candidateArrivalMs(candidate) === minArrival,
    });
  }

  // An option that takes several times as long as the route physically needs
  // is not a trade-off, it is an ordeal — and it must never be the one the
  // traveller is shown FIRST while a sane one exists. Applied BEFORE the
  // preference pins so an explicit answer ("same day", "nonstop") can still
  // pull a candidate forward: the traveller's own choice outranks our
  // judgement, this only orders what they did not speak to.
  //
  // Demoted, never dropped: someone counting every euro may genuinely accept a
  // long layover, and arrival time never vetoes a real flight.
  let ordered = base;
  const stretchOf = (candidate: RebookingCandidate) =>
    journeyStretchFactor(
      candidate.option.origin,
      candidate.option.destination,
      candidate.option.departureTime,
      candidate.option.arrivalTime,
    );
  const excessive = base.filter((c) => (stretchOf(c) ?? 0) > EXCESSIVE_JOURNEY);
  if (excessive.length > 0 && excessive.length < base.length) {
    const sane = base.filter((c) => !excessive.includes(c));
    ordered = [...sane, ...excessive];
    const worst = excessive.map((c) => ({ c, f: stretchOf(c) ?? 0 })).sort((a, b) => b.f - a.f)[0];
    notes.push(
      `${excessive.length} option(s) take over ${EXCESSIVE_JOURNEY}× the normal flying time ` +
        `(worst: ${worst.c.option.flightNumber ?? worst.c.option.id} at ${worst.f.toFixed(1)}×) — ` +
        `offered, but not first`,
    );
  }

  for (const pin of pins) {
    const pinned = ordered.filter(pin.test);
    if (pinned.length === 0 || pinned.length === ordered.length) continue;
    const rest = ordered.filter((candidate) => !pin.test(candidate));
    const reordered = [...pinned, ...rest];
    // Echo ONLY when the pin actually changed the ordering.
    if (reordered.some((candidate, index) => candidate !== ordered[index])) {
      notes.push(pin.echo);
      ordered = reordered;
    }
  }

  if (ordered.length > MAX_PLANS_PER_CAROUSEL) {
    notes.push(
      `${ordered.length - MAX_PLANS_PER_CAROUSEL} further option(s) beyond the ${MAX_PLANS_PER_CAROUSEL}-plan carousel cap — not offered`,
    );
    ordered = ordered.slice(0, MAX_PLANS_PER_CAROUSEL);
  }
  return { ordered, notes };
}

/**
 * Non-stop probe for `prefer_direct`. FlightOption carries no stops field
 * today, so candidates exposing `stops`/`layovers` (future provider feed)
 * are filtered; absent metadata is treated as direct.
 */
function isDirectCandidate(candidate: RebookingCandidate): boolean {
  const option = candidate.option as FlightOption & { stops?: unknown; layovers?: unknown };
  const stops =
    typeof option.stops === "number"
      ? option.stops
      : typeof option.layovers === "number"
        ? option.layovers
        : 0;
  return stops <= 0;
}

export class OrchestratorAgent {
  constructor(
    private readonly graph: ItineraryGraph,
    /** Nullable (clarity pass): non-flight missions run live without an
     *  Atlas provider — the flight branch's null-guard below falls through
     *  to the existing degrade path (rebookingAssessment stays null). */
    private readonly flightAgent: FlightAgent | null,
    private readonly policyAgent: PolicyAgent | null = null,
    private readonly hotelAgent: HotelAgent | null = null,
    private readonly activityAgent: ActivityAgent | null = null,
    private readonly weatherProvider: WeatherContextProvider | null = null,
    private readonly eventProvider: EventDisruptionContextProvider | null = null,
    /**
     * W2 (additive, optional): the Gemini day reorganizer. When wired AND a
     * disrupted day carries ≥2 timing-flagged activities, the whole day is
     * resequenced as ONE unit (retimes + at most one honest drop). Absent or
     * degraded ⇒ every activity stays on the legacy per-item ActivityAgent
     * rail — the reorganizer never sinks a plan.
     */
    private readonly dayReorganizer: DayReorganizer | null = null,
    /**
     * The LLM sanity critic (additive, optional). It sits between candidate
     * selection and the plans the traveller is shown, and it may only ever
     * DROP or RE-TIME nodes — never price anything. Absent, unreachable or
     * degraded ⇒ {@link deterministicCriticisms} alone, which is exactly what
     * every offline test and CI run exercises.
     */
    private readonly semanticCritic: SemanticCritic | null = null,
    /**
     * The venue schedules (additive, optional). This is the one source that
     * can say CATEGORICALLY whether a door is open at a re-planned slot —
     * Google's published weekly hours, cached, compared by arithmetic. Absent
     * ⇒ nothing is ever decided from opening hours, exactly as before.
     */
    private readonly venueHours: VenueHours | null = null,
  ) {}

  // Task 20 — rederive context captured by runDisruptionPipeline: the
  // untouched baseline graph, the disruption event and the nominal delay.
  // The orchestrator is constructed once per mission and the pipeline runs
  // once per call, so these fields unambiguously describe the last run.
  private redriveBaseline: ItineraryGraph | null = null;
  private redriveEvent: DisruptionEvent | null = null;
  private redriveNominalMinutes: number | null = null;

  /**
   * "How far ahead of my flight am I changing it", anchored on the BOOKED
   * departure, and the flight the change applies to. Captured once per
   * mission so every per-plan policy read uses the same basis.
   */
  private policyDepartureBasisMs: number | null = null;
  private policySourceFlightId: string | null = null;
  /**
   * One policy read per replacement offer, keyed by the offer's own id.
   *
   * The carousel asks for a verdict once per PLAN, and several plans often
   * settle on the same flight; the fare rule is the offer's own and cannot
   * change between two reads of it.
   */
  private readonly policyVerdictByOption = new Map<string, FarePolicyVerdict | null>();

  /** Nodes whose slot the venue's own schedule decided this resolve. */
  private hoursDecided = new Set<string>();

  /** Every criticism acted on during the last resolve, for the session trace. */
  private criticVerdicts: CriticVerdict[] = [];
  /** Per-plan lost-night count keyed by the selection's arrival ISO. */
  private criticNightsUnstayed = new Map<string, number>();

  /** What the critic found on the last {@link resolveDisruptionMulti} call. */
  get lastCriticVerdicts(): readonly CriticVerdict[] {
    return this.criticVerdicts;
  }

  /**
   * Run the full disruption-recovery pipeline and emit a TrustLayer plan.
   *
   * Legacy single-plan rail (SPEC §2.2 / the frozen `/mission` contract):
   * the plan is assembled from the SAME pipeline that feeds the two-phase
   * multi-plan path, selecting the FlightAgent's cheapest `bestCandidate`
   * exactly as before.
   */
  async resolveDisruption(event: DisruptionEvent): Promise<OrchestrationOutcome> {
    const pipeline = await this.runDisruptionPipeline(event);
    this.criticVerdicts = [];
    this.criticNightsUnstayed = new Map();
    this.hoursDecided = new Set();
    // The legacy single-plan rail gets the SAME review as the carousel when no
    // replacement was found. A guardrail test pins the two byte-identical
    // there, and it is right to: a safety review that only one rail performs
    // is a rail that ships unreviewed plans.
    if (
      (pipeline.rebookingAssessment?.bestCandidate ?? null) === null &&
      pipeline.activityProposals.length > 0
    ) {
      pipeline.activityProposals = await this.critiqueWithoutArrival(
        pipeline.activityProposals,
        event,
        [],
      );
    }
    const plan = this.assembleResolutionPlan(
      event,
      pipeline,
      pipeline.rebookingAssessment?.bestCandidate ?? null,
      {
        hotelAdjustments: pipeline.hotelAdjustments,
        includeTransferRequote: pipeline.spatialTransferReport !== null,
      },
    );
    return {
      plan,
      disruption: pipeline.disruption,
      rebookingAssessment: pipeline.rebookingAssessment,
      hotelAdjustments: pipeline.hotelAdjustments,
      activityProposals: pipeline.activityProposals,
      policyVerdict: pipeline.policyVerdict,
    };
  }

  /**
   * FAST candidate-gathering pass for the two-phase assess phase: runs the
   * identical pipeline (impact propagation → policy gate → flight assessment
   * → parallel hotel/activity fan-out) but returns the RAW specialist outputs
   * without assembling any TrustLayer plan. The hackathon API persists these
   * candidates on the swarm session between the assess and resolve calls.
   */
  async assessDisruption(event: DisruptionEvent): Promise<DisruptionAssessment> {
    const pipeline = await this.runDisruptionPipeline(event);
    return {
      disruption: pipeline.disruption,
      rebookingAssessment: pipeline.rebookingAssessment,
      hotelAdjustments: pipeline.hotelAdjustments,
      activityProposals: pipeline.activityProposals,
      policyVerdict: pipeline.policyVerdict,
      impactedNodes: pipeline.impactedNodes,
      // The pipeline already captures the TRUE pre-disruption departure
      // BEFORE handleDisruption mutates the graph — thread it through so
      // the API layer never re-reads the (now shifted) node.
      ...(pipeline.originalDepartureMs !== undefined
        ? { originalDepartureMs: pipeline.originalDepartureMs }
        : {}),
    };
  }

  /**
   * Two-phase resolve rail (W1 per-candidate carousel): run the pipeline
   * ONCE, then assemble up to {@link MAX_PLANS_PER_CAROUSEL} ResolutionPlans
   * — ONE plan per non-dominated rebooking candidate:
   *
   *   - 0 candidates ⇒ the degraded flight-less rail (single plan)
   *   - 1 candidate  ⇒ ONE honest plan (`badges` names the profiles it
   *                    covers; no badge-stamped copies)
   *   - ≥2 candidates ⇒ one plan per candidate after constraint filtering,
   *                    PINNING (prefer_nonstop / prefer_same_day /
   *                    prefer_earliest move matching plans to the front,
   *                    with additive "…, as you asked" echo trace lines)
   *                    and the 5-plan cap. Each plan carries derived tags:
   *                    cheapest (min net), fastest (min arrival), nonstop,
   *                    same_day / next_day vs. the original departure.
   *
   * Constraints from the liaison phase are applied where applicable:
   * `max_price` filters candidates (all-filtered ⇒ keep the cheapest and
   * note it in `trace`), `prefer_direct`/`prefer_nonstop` prefer non-stop
   * candidates, `keep_hotel: false` drops hotel adjustments that merely
   * preserve the booking, `prefer_earliest` pins earliest arrivals first.
   *
   * Plans are deduplicated on their canonical {@link resolutionPlanToJson}
   * form (minimum 1 plan always emitted), each plan independently computes
   * its financial delta and a FRESH quote TTL, and each must pass
   * {@link validateResolutionPlan}.
   */
  async resolveDisruptionMulti(
    event: DisruptionEvent,
    constraints?: ResolutionConstraints,
  ): Promise<MultiPlanOutcome> {
    const pipeline = await this.runDisruptionPipeline(event, constraints);
    const trace: string[] = [];
    this.criticVerdicts = [];
    this.criticNightsUnstayed = new Map();
    this.hoursDecided = new Set();
    // ONE timestamp for every plan assembled below: the per-plan TTL stamps
    // must be identical so the canonical-JSON dedup can collapse profiles
    // that select the same candidate (a ticking millisecond clock between
    // loop iterations would otherwise serialize them differently).
    const now = Date.now();

    // ── Hotel constraint: drop booking-preserving adjustments on request ──
    let hotelAdjustments = pipeline.hotelAdjustments;
    if (constraints?.keep_hotel === false && hotelAdjustments.length > 0) {
      // Drop what PRESERVES the booking — not what explains it.
      //
      // The filter used to keep only `rebook`, which silently deleted the one
      // row an overbooked traveller needs: "we could not find a comparable
      // room, ask the property to rehouse you". That row preserves nothing; it
      // is the answer. Live on 2026-09-18 the traveller answered "don't keep
      // the hotel", and the plan came back with no mention of the hotel at all
      // on a mission that was entirely about the hotel.
      const kept = hotelAdjustments.filter(
        (adjustment) => adjustment.action === "rebook" || adjustment.requires_confirmation === true,
      );
      const dropped = hotelAdjustments.length - kept.length;
      if (dropped > 0) {
        trace.push(`keep_hotel=false — dropped ${dropped} booking-preserving hotel adjustment(s)`);
        hotelAdjustments = kept;
      }
    }

    // ── Flight candidate filtering (shared pure core, W1) ─────────────────
    // `applyConstraintsToCandidates` is the SAME pure filter the hackathon
    // API's discrimination filter simulates: max_price narrowing, non-stop
    // preference and the Pareto frontier (legacy trace strings preserved).
    const rawCandidates = pipeline.rebookingAssessment
      ? [...pipeline.rebookingAssessment.candidates]
      : [];
    // What each candidate really costs — fare difference AND the change fee
    // its own carrier publishes — converted to one currency so options quoted
    // in different money can be compared at all. Resolved BEFORE the Pareto
    // filter, because dominance judged on the fare alone drops the option
    // that is cheaper once the fee is counted, and it then never reaches the
    // carousel to be ranked or badged. The policy read is memoised per offer,
    // so the plans assembled below reuse these very verdicts.
    const costByCandidate = new Map<RebookingCandidate, number>();
    for (const candidate of rawCandidates) {
      costByCandidate.set(candidate, await this.candidateCostEur(candidate, event));
    }
    const costOf = (candidate: RebookingCandidate) =>
      costByCandidate.get(candidate) ?? candidateNetCharge(candidate);
    const { candidates: constrained, notes: filterNotes } = applyConstraintsToCandidates(
      rawCandidates,
      constraints,
      costOf,
    );
    trace.push(...filterNotes);

    // Continuous-reflow policy: arrival time never vetoes a real flight. The
    // per-candidate rederive below moves or drops downstream activities and
    // protects hotel check-in around the selected arrival, even when that
    // means rebuilding the remainder of the trip.
    const candidates = constrained;

    // ── Plan selection (W1 per-candidate carousel) ────────────────────────
    const originalArrivalLocation =
      pipeline.source && pipeline.source.type === "flight"
        ? pipeline.source.arrivalLocationId
        : undefined;

    type Profile = {
      badge: NonNullable<ResolutionPlan["badge"]>;
      chosen: RebookingCandidate | null;
      /** Additive badge stamp: every tag the ONE plan honestly covers. */
      badges?: NonNullable<ResolutionPlan["badges"]>;
    };
    const selections: Profile[] = [];
    if (candidates.length === 0) {
      // Degraded rail: no priced candidates ⇒ exactly ONE flight-less plan.
      trace.push(
        pipeline.rebookingAssessment === null
          ? "no flight rebooking assessment — emitting a single plan"
          : "no priced candidates — emitting a single plan without a replacement flight",
      );
      selections.push({ badge: "balanced", chosen: null });
    } else {
      // A single-member frontier still goes through the SAME derivation as a
      // carousel: badges are a COMPARISON result, never a stamp. Hardcoding
      // ["cheapest","fastest"] here asserted two superlatives without
      // measuring either, and silently dropped the `nonstop` / `same_day`
      // tags the option had honestly earned. With one candidate the
      // comparison legitimately returns both — the difference is that it is
      // now determined rather than assumed.
      if (candidates.length === 1) {
        trace.push("single non-dominated option — offering one honest plan");
      }
      // W1: ONE plan per non-dominated candidate. Constraint pinning (the
      // traveler's answers move matching plans to the front), the additive
      // echo trace lines and the 5-plan carousel cap live in the shared
      // pure selection core (re-filtering an already-filtered pool is a
      // silent no-op, so no duplicated trace notes).
      const { ordered, notes } = selectPlanCandidates(
        candidates,
        constraints,
        pipeline.originalDepartureMs,
        costOf,
      );
      trace.push(...notes);
      // Tag derivation (frozen badge order): cheapest = unique min net,
      // fastest = unique min arrival, nonstop from the stops probe, and
      // same_day/next_day measured against the flight's TRUE original
      // departure. The PRIMARY badge is the first tag; "balanced" is only
      // the honest no-tag fallback.
      const byNet = [...ordered].sort(
        (a, b) =>
          costOf(a) - costOf(b) ||
          candidateArrivalMs(a) - candidateArrivalMs(b) ||
          a.option.id.localeCompare(b.option.id),
      );
      const byArrival = [...ordered].sort(
        (a, b) =>
          candidateArrivalMs(a) - candidateArrivalMs(b) ||
          costOf(a) - costOf(b) ||
          a.option.id.localeCompare(b.option.id),
      );
      const cheapest = byNet[0];
      const fastest = byArrival[0];
      const anchorIso =
        pipeline.originalDepartureMs !== undefined
          ? new Date(pipeline.originalDepartureMs).toISOString()
          : undefined;
      for (const candidate of ordered) {
        const tags: Array<NonNullable<ResolutionPlan["badge"]>> = [];
        if (candidate === cheapest) tags.push("cheapest");
        if (candidate === fastest) tags.push("fastest");
        if (isDirectCandidate(candidate)) tags.push("nonstop");
        if (anchorIso !== undefined) {
          const dayRelation = sameUtcDay(candidate.option.departureTime, anchorIso);
          if (dayRelation === true) tags.push("same_day");
          else if (dayRelation === false) tags.push("next_day");
        }
        selections.push({
          badge: tags[0] ?? "balanced",
          chosen: candidate,
          badges: tags.length > 0 ? tags : ["balanced"],
        });
      }
    }

    // ── Task 25 (#1): HOISTED per-plan rederive — BEFORE assembly ─────────
    // Each SELECTED candidate's OWN replacement arrival drives a rederive
    // walk (deduped by EXACT arrival ISO) BEFORE plan assembly, so the plan
    // BODY (rescheduled_activities + financial_delta) and the downstream
    // presentation/operational layers all derive from the SAME per-arrival
    // walk — the approved money lines match the settlement moves. Budget
    // priority: the shared pipeline walk (step 3 of runDisruptionPipeline)
    // consumed the shared ActivityAgent budgets FIRST; which day degrades
    // under concurrent reorgs is intentionally not guaranteed. Flight-less
    // selections (chosen === null) and the 0-candidate / non-flight rails
    // never run a walk here — those plans keep the shared pipeline
    // proposals byte-identical.
    const rederiveActive =
      this.activityAgent !== null &&
      pipeline.source !== undefined &&
      pipeline.source.type === "flight";
    const rederivedByArrival = new Map<string, ActivityRescheduleProposal[]>();
    const proposalsForCandidate = async (
      candidate: RebookingCandidate | null,
    ): Promise<ActivityRescheduleProposal[] | undefined> => {
      if (!rederiveActive || candidate === null) return undefined;
      const arrivalIso = candidate.option.arrivalTime;
      let proposals = rederivedByArrival.get(arrivalIso);
      if (proposals === undefined) {
        proposals = await this.rederiveActivityProposalsForArrival(
          arrivalIso,
          constraints,
          candidate.option.destination,
        );
        // ── The semantic critic, at the ONE point where its verdict can
        //    still change the plan without touching the ledger. It reads the
        //    proposal SET, not the assembled plan: what it drops or re-times
        //    here is what `assembleResolutionPlan` then prices, so every
        //    amount the traveller sees is computed by the deterministic engine
        //    from the post-critique itinerary. Nothing downstream of this
        //    point asks the model anything.
        proposals = await this.applyVenueHours(
          proposals,
          this.redriveBaseline ?? this.graph,
          trace,
        );
        proposals = await this.applySemanticCritique(candidate, proposals, trace);
        rederivedByArrival.set(arrivalIso, proposals);
      }
      return proposals;
    };

    // ── The critic on a mission with NO replacement flight ────────────────
    // Runs BEFORE assembly, because a verdict reached afterwards is a verdict
    // thrown away: the first wiring reviewed the proposals once the plans were
    // already built, so a live mission traced
    // "UNREALISTIC_TRANSIT — Kabukicho & Omoide Yokocho Stroll dropped"
    // while the plan it shipped still carried that stroll, rescheduled to
    // 08:00. The trace said one thing and the traveller got another.
    //
    // The per-candidate hook covers plans that HAVE a replacement flight. This
    // covers the rest: weather, hotel and cancelled-activity missions, and a
    // flight mission whose provider returned nothing at all.
    if ((!rederiveActive || candidates.length === 0) && pipeline.activityProposals.length > 0) {
      pipeline.activityProposals = await this.applyVenueHours(
        pipeline.activityProposals,
        this.redriveBaseline ?? this.graph,
        trace,
      );
      pipeline.activityProposals = await this.critiqueWithoutArrival(
        pipeline.activityProposals,
        event,
        trace,
      );
    }

    // ── Assembly + canonical dedup (badge stamped AFTER the comparison so
    //    two profiles picking the identical resolution collapse — the dedup
    //    key stays badge-blind, and `badges` is stamped the same way) ──────
    const plans: ResolutionPlan[] = [];
    const seen = new Set<string>();
    // How many selections converge on each canonical plan (drives the
    // post-dedup badge stamp below), and WHICH badges the converging
    // selections carry — including EVERY tag of their `badges` lists, so
    // the stamp reflects the actually-converging selections, never a
    // hardcoded literal.
    const canonicalProfileCount = new Map<string, number>();
    const canonicalBadges = new Map<string, Set<NonNullable<ResolutionPlan["badge"]>>>();
    const canonicals: string[] = [];
    for (const { badge, chosen, badges } of selections) {
      // The transfer re-quote applies to a plan only when ITS flight lands at
      // a different location than the original arrival (the spatial report
      // itself was raised during propagation with the cheapest candidate).
      const includeTransferRequote =
        pipeline.spatialTransferReport !== null &&
        (chosen === null || chosen.option.destination !== originalArrivalLocation);
      // Task 25 (#1): thread THIS selection's own per-arrival proposal set
      // into the plan body (undefined ⇒ the shared pipeline set, unchanged).
      const selectionProposals = await proposalsForCandidate(chosen);
      // THIS plan's flight, THIS plan's fare rule. Sharing one verdict across
      // the carousel put a VietJet change fee, in VND, on an AirAsia plan.
      const selectionVerdict = await this.policyVerdictForCandidate(chosen, event);
      const plan = this.assembleResolutionPlan(event, pipeline, chosen, {
        hotelAdjustments: this.discloseUnstayedNights(hotelAdjustments, chosen),
        includeTransferRequote,
        stampMs: now,
        ...(selectionProposals !== undefined ? { activityProposals: selectionProposals } : {}),
        ...(selectionVerdict !== null ? { policyVerdict: selectionVerdict } : {}),
      });
      if (!validateResolutionPlan(plan)) {
        trace.push(`${badge} plan failed Trust Layer validation — dropped`);
        continue;
      }
      const canonical = resolutionPlanToJson(plan);
      canonicalProfileCount.set(canonical, (canonicalProfileCount.get(canonical) ?? 0) + 1);
      const convergingBadges =
        canonicalBadges.get(canonical) ?? new Set<NonNullable<ResolutionPlan["badge"]>>();
      convergingBadges.add(badge);
      if (badges) {
        for (const tag of badges) convergingBadges.add(tag);
      }
      canonicalBadges.set(canonical, convergingBadges);
      if (seen.has(canonical)) {
        trace.push(`${badge} plan duplicates an earlier selection — deduplicated`);
        continue;
      }
      seen.add(canonical);
      canonicals.push(canonical);
      // A badge is the RESULT of a comparison. A plan with no replacement
      // flight compared nothing, so it claims nothing — "balanced" on an empty
      // answer is a label about a choice that was never made.
      if (plan.proposed_resolution.new_flight === undefined) {
        plans.push(plan);
      } else {
        plans.push({ ...plan, badge, ...(badges !== undefined ? { badges } : {}) });
      }
    }

    // Post-dedup collapse: the plan list narrowed to exactly ONE plan that
    // several selections converged on — stamp the union of the badges the
    // ACTUALLY converging selections carry, in the frozen {@link BADGE_ORDER}
    // (cheap re-stamp when the winning selection already carries `badges`).
    if (plans.length === 1) {
      const singleCanonical = canonicals[0];
      if (singleCanonical !== undefined && (canonicalProfileCount.get(singleCanonical) ?? 0) > 1) {
        const converging = canonicalBadges.get(singleCanonical);
        const union = BADGE_ORDER.filter((value) => converging?.has(value));
        if (union.length > 0) {
          plans[0] = { ...plans[0], badges: [...union] };
        }
      }
    }

    if (plans.length === 0) {
      // Defensive last resort: the legacy single-plan selection (badge-less).
      const fallbackChosen = pipeline.rebookingAssessment?.bestCandidate ?? null;
      // Task 25 (#1): the fallback body threads its OWN arrival's proposal
      // set too (reuses the hoisted arrival-deduped map when present).
      const fallbackProposals = await proposalsForCandidate(fallbackChosen);
      const fallback = this.assembleResolutionPlan(event, pipeline, fallbackChosen, {
        hotelAdjustments: this.discloseUnstayedNights(hotelAdjustments, fallbackChosen),
        includeTransferRequote: pipeline.spatialTransferReport !== null,
        stampMs: now,
        ...(fallbackProposals !== undefined ? { activityProposals: fallbackProposals } : {}),
      });
      plans.push(fallback);
      trace.push("all profiled plans invalid — emitted a single fallback plan");
    }

    // ── Task 20 — per-plan activity proposals (Task 25: the walks already
    //    ran HOISTED before assembly above; this block only indexes the
    //    arrival-deduped map per emitted plan) ─────────────────────────────
    // Each plan carries the activity proposals consistent with ITS OWN
    // replacement arrival: rederived from the untouched baseline, deduped by
    // EXACT arrival ISO (plans sharing an arrival share one walk and one
    // proposal-set reference; the dedup map is iterated in plan order, so the
    // shared ActivityAgent's per-mission Viator budget is consumed
    // deterministically). Flight-less plans carry the shared pipeline
    // proposals — with zero candidates / a non-flight source NOTHING here
    // runs a walk, keeping the nominal output byte-identical.
    const planActivityProposals: ActivityRescheduleProposal[][] = [];
    if (rederiveActive) {
      for (const plan of plans) {
        const arrivalIso = plan.proposed_resolution.new_flight?.arrival;
        if (arrivalIso === undefined) {
          planActivityProposals.push(pipeline.activityProposals);
          continue;
        }
        // The plan's `new_flight.arrival` IS the selection's arrival ISO the
        // hoisted walk keyed on — the map hit reuses the SAME proposal-set
        // reference (defensive re-walk only if the key is ever absent).
        let proposals = rederivedByArrival.get(arrivalIso);
        if (proposals === undefined) {
          proposals = await this.rederiveActivityProposalsForArrival(
            arrivalIso,
            constraints,
            // Task 25 (#5): same spatial rule as the hoisted walks.
            plan.proposed_resolution.new_flight?.destination,
          );
          rederivedByArrival.set(arrivalIso, proposals);
        }
        planActivityProposals.push(proposals);
      }
    } else {
      for (let i = 0; i < plans.length; i += 1) {
        planActivityProposals.push(pipeline.activityProposals);
      }
    }
    // Shared field stays plan-0's set for back-compat.
    const sharedActivityProposals = planActivityProposals[0] ?? pipeline.activityProposals;

    // F5 — the traveler's protected-activity answer is visible in the trace
    // (mirrors the W1e "..., as you asked" echo style): echo when the
    // `activity_priority` constraint was actually CONSUMED by a day
    // reorganization (the only rail that reads it) in the shared pipeline or
    // any per-plan walk.
    if (constraints?.activity_priority !== undefined) {
      const consumed = planActivityProposals.some((set) =>
        set.some((proposal) => proposal.reorgSource !== undefined),
      );
      if (consumed) {
        trace.push(`protecting ${constraints.activity_priority}, as you asked`);
      }
    }

    return {
      plans,
      disruption: pipeline.disruption,
      rebookingAssessment: pipeline.rebookingAssessment,
      hotelAdjustments,
      activityProposals: sharedActivityProposals,
      policyVerdict: pipeline.policyVerdict,
      trace,
      planActivityProposals,
    };
  }

  // ---------------------------------------------------------------- internals

  /**
   * Shared pipeline steps 1–4 (spec §2.2 flow) behind resolveDisruption,
   * assessDisruption and resolveDisruptionMulti — ONE run of impact
   * propagation, policy gate, flight assessment (incl. the spatial
   * re-propagation), parallel hotel/activity fan-out and the transfer
   * re-quote detection. Plan assembly happens OUTSIDE so each rail can
   * select differently.
   */
  private async runDisruptionPipeline(
    event: DisruptionEvent,
    /** W2 (additive): liaison constraints — feed the day reorganizer's
     *  priority ordering (`activity_priority`) and free-text `notes`. The
     *  assess/legacy rails pass nothing (undefined ⇒ chronological order). */
    constraints?: ResolutionConstraints,
  ): Promise<{
    source: ItineraryNode | undefined;
    disruption: DisruptionResult;
    policyVerdict: FarePolicyVerdict | null;
    rebookingAssessment: FlightRebookingAssessment | null;
    hotelAdjustments: HotelAdjustment[];
    activityProposals: ActivityRescheduleProposal[];
    spatialTransferReport: AffectedNodeReport | null;
    impactedNodes: string[];
    /** W1: the flight's TRUE pre-disruption departure (epoch ms) — the
     *  anchor for the same_day / next_day carousel badges and pinning. */
    originalDepartureMs: number | undefined;
    /** Task 20: the untouched pre-propagation graph snapshot — the rederive
     *  walks re-propagate from it per replacement arrival. */
    baseline: ItineraryGraph;
  }> {
    // Read the TRUE pre-disruption schedule before handleDisruption mutates
    // it — see the ROOT-CAUSE note below on why this capture has to happen
    // here, before step 1, not be reconstructed from the post-shift node.
    const preDisruptionNode = this.graph.getNode(event.nodeId);
    const originalDepartureTime =
      preDisruptionNode && preDisruptionNode.type === "flight"
        ? preDisruptionNode.departureTime
        : undefined;

    // Task 20 — untouched baseline snapshot captured BEFORE the nominal
    // propagation mutates the graph. The real-arrival re-drive (below) and
    // the per-plan rederive walks re-propagate from THIS state, never from
    // the already-shifted live graph (no double-shift).
    const baseline = this.graph.clone();
    // Captured for the rederive walks: the nominal incident delay in minutes.
    this.redriveEvent = event;
    this.redriveBaseline = baseline;
    this.redriveNominalMinutes =
      typeof event.delay === "number" ? event.delay : event.delay.minutes;

    // 1) Impact surface: propagate the delay through the dependency graph.
    let disruption = this.graph.handleDisruption(event.nodeId, event.delay);

    // 2) Policy gate, then flight rebooking (only when the source is a flight).
    const source = this.graph.getNode(event.nodeId);
    // Post-nominal arrival of the disrupted flight (original + nominal
    // delay) — the re-drive gate compares the replacement's REAL arrival
    // against THIS, not against the untouched schedule.
    const postNominalArrivalMs =
      source && source.type === "flight" ? source.arrivalTime : undefined;
    let policyVerdict: FarePolicyVerdict | null = null;
    let rebookingAssessment: FlightRebookingAssessment | null = null;
    // `groundOnly`: the flight is fine, the way to reach it is not. Searching
    // for a replacement seat here produces an answer to a question nobody
    // asked, and its "no coverage" explanation then headlines the plan.
    // `adviceOnly`: the same, for a question about the itinerary as booked.
    if (source && source.type === "flight" && !event.groundOnly && !event.adviceOnly) {
      if (this.policyAgent) {
        policyVerdict = await this.policyAgent.assessFarePolicy({
          originalFlightId: source.id,
          rule: event.fareRule ?? {},
          minutesToDeparture: Math.max(0, Math.round((source.departureTime - Date.now()) / 60_000)),
          disruptionKind: classifyDisruptionKind(event.description),
        });
      }
      // Gate: rebook only when permitted (or when no policy agent is wired,
      // preserving the pre-swarm behaviour for backward compatibility).
      if (!policyVerdict || policyVerdict.rebookPermitted) {
        const newTime = new Date(source.departureTime).toISOString();
        // NEW (additive): route-based providers (real Atlas `search.do`) need
        // the disrupted leg's origin/destination/date — derived straight from
        // the flight node. Id-based providers simply ignore the context.
        // Missed-flight guard: a PAST departure cannot be rebooked on its own
        // (already-spent) date — route APIs only sell future-dated seats, so
        // "I missed my flight" intents anchor the search on the next calendar
        // day (UTC). Future departures keep their own date.
        // Use the untouched booked departure for this decision. `source` has
        // already been shifted by handleDisruption above, so a large nominal
        // delay can otherwise make a departed flight look future-dated.
        const nowMs = Date.now();
        const originalDepartureMs =
          originalDepartureTime !== undefined ? originalDepartureTime : source.departureTime;
        const departureIsPast = originalDepartureMs < nowMs;
        const futureRecoveryAnchor = new Date(nowMs + 2 * 3600_000).toISOString();
        // ROOT CAUSE (found live, reproduced against real Atlas): `newTime` is
        // `source.departureTime` AFTER `handleDisruption` already shifted it
        // forward by the mission's delay — a "missed flight" mission with no
        // explicit "delayed by Xh" wording defaults to a 240-minute delay
        // (swarmIntent's DEFAULT_DELAY_MINUTES), AND the UI's "which flight did
        // you miss" picker sends an explicit nodeId, which classifies as
        // "delay" rather than "missed_flight" — so `newTime` silently became
        // "09:55 + 4h = 13:55" while the traveler's real flight, and every
        // Atlas candidate for it, still departs at 09:55. Comparing THAT
        // against Atlas's honest 09:55 result never matched, and the flight
        // the traveler just missed came back as its own "cheapest" fix.
        // `originalDepartureTime` (captured before handleDisruption mutated
        // the node) is the traveler's TRUE booked departure regardless of any
        // simulated delay — that is what "never offer this back" and "nothing
        // before this" must both be measured against.
        const originalDepartureIso =
          originalDepartureTime !== undefined
            ? new Date(originalDepartureTime).toISOString()
            : newTime;
        // Historical/demo fixtures are searched on a sellable future date.
        // Their eligibility window MUST move with that search anchor: keeping
        // the floor/ceiling on the stale itinerary date guarantees that every
        // real provider result is classified as "too late". For a genuinely
        // upcoming trip, preserve the booked departure as the anchor.
        const recoveryAnchorIso = departureIsPast ? futureRecoveryAnchor : originalDepartureIso;
        let earliestDepartureIso = recoveryAnchorIso;
        if (constraints?.min_departure_delay_hours !== undefined) {
          const delayMs = nowMs + constraints.min_departure_delay_hours * 3600_000;
          const recoveryAnchorMs = Date.parse(recoveryAnchorIso);
          earliestDepartureIso = new Date(Math.max(delayMs, recoveryAnchorMs)).toISOString();
        }

        const routeContext: FlightRouteContext = {
          origin: source.origin,
          destination: source.destination,
          departureDate: departureIsPast ? futureRecoveryAnchor : newTime,
          // Additive booking facts from hydration: party size + the leg's
          // known fare feed the true fare-delta math inside the provider
          // (absent fields ⇒ the provider quotes the full verified re-price).
          ...(source.travelers !== undefined ? { adults: source.travelers } : {}),
          ...(source.fare?.amount !== undefined ? { originalFare: source.fare.amount } : {}),
          // Quote currency. The leg's own fare currency wins; otherwise fall
          // back to the TRIP's currency — the same value this plan is stamped
          // with below. Without this fallback a leg with an unknown fare (very
          // common: "original fare unknown — quoting full verified re-price")
          // left the provider on its USD sandbox default, so a EUR trip showed
          // the traveler "Total due now: €25.00 + $52.64" for a Vueling
          // LGW→BCN hop — two currencies, neither actionable, and the USD
          // figure reads ~17% higher than the EUR fare Atlas also returned.
          ...(source.fare?.currency !== undefined
            ? { currency: source.fare.currency }
            : event.tripContext?.currency !== undefined
              ? { currency: event.tripContext.currency }
              : {}),
          // Cabin is intentionally not forwarded for disruption recovery.
          // Atlas's LCC inventory often has no RBD/cabin metadata; pinning the
          // original cabin can erase every viable replacement.
          // Never offer the disrupted departure back as its own replacement —
          // anchored on the flight's TRUE original departure (see above).
          excludeFlight: {
            flightNumber: source.flightNumber,
            departureTime: originalDepartureIso,
          },
          // Nothing at or before the recovery anchor is usable. For a future
          // trip this is the original departure; for a historical/demo fixture
          // it is the sellable future date sent to the provider.
          earliestDeparture: earliestDepartureIso,
        };
        // Null-guard (clarity pass): missions wired without a flight agent
        // (non-flight missions running live without Atlas) skip the call and
        // leave `rebookingAssessment` null — the callers' existing degrade
        // path for a missing assessment. Every existing trace key unchanged.
        if (this.flightAgent !== null) {
          rebookingAssessment = await this.flightAgent.assessRebookingOptions(
            source.id,
            newTime,
            routeContext,
          );

          // Re-assess the fare policy against the REAL rule the provider
          // publishes for the fare we are about to quote. The pass above could
          // only use whatever the caller supplied, which in practice is a
          // labelled house default — so the change fee the traveler was asked
          // to approve was not the carrier's. Verified live on 2026-08-31: a
          // Vueling LGW→BCN fare publishes a 52.99 EUR change fee and
          // voucher-only refunds, while the default claimed 25 EUR.
          //
          // Anchored on the ORIGINAL departure: "how far ahead of my flight am
          // I changing it" is measured against the booked time, not the time
          // the simulated delay pushed the node to.
          const departureBasis = originalDepartureTime ?? source.departureTime;
          this.policyDepartureBasisMs = departureBasis;
          this.policySourceFlightId = source.id;
          policyVerdict =
            (await this.policyVerdictForCandidate(
              rebookingAssessment?.bestCandidate ?? null,
              event,
            )) ?? policyVerdict;

          // Spatial constraint: if the replacement flight arrives at a DIFFERENT
          // location than the original booking, re-run the propagation with the
          // new arrival location so downstream transfers can raise a spatial
          // conflict (spec §2). Guarded on arrivalLocationId presence: graphs
          // without spatial anchors keep the pure-chronological behaviour.
          const bestFlight = rebookingAssessment?.bestCandidate?.option;
          if (
            bestFlight &&
            source.arrivalLocationId &&
            bestFlight.destination !== source.arrivalLocationId
          ) {
            // Re-run handleDisruption with 0 delay (chronological already applied) but new spatial location
            const spatialDisruption = this.graph.handleDisruption(event.nodeId, 0, {
              newArrivalLocationId: bestFlight.destination,
            });
            // Merge spatial effects into the main disruption report. Guard:
            // ONLY a spatial report may overwrite an existing conflict reason —
            // a non-spatial report never clobbers any existing reason.
            for (const report of spatialDisruption.affected) {
              const existing = disruption.affected.find((a) => a.nodeId === report.nodeId);
              if (!existing) {
                disruption.affected.push(report);
              } else if (report.action === "conflict") {
                const reportIsSpatial = report.reason.startsWith(SPATIAL_MISMATCH_PREFIX);
                if (reportIsSpatial) {
                  existing.action = "conflict";
                  existing.reason = report.reason;
                }
              }
            }
          }
        }
      }
    }

    // Task 20 — real-arrival re-drive: the replacement flight's REAL arrival
    // is the impact driver (the nominal delay is only the no-candidate
    // fallback). When the best candidate lands LATER than the post-nominal
    // arrival, the whole impact surface is recomputed from the untouched
    // baseline with the effective (true-arrival) delay — ONE propagation, so
    // the live graph ends at the true-arrival state with NO double-shift.
    // Pure CPU: no network I/O, no Gemini. Guardrails: a non-flight source
    // or a missing candidate keeps the nominal behaviour byte-identical.
    const bestArrivalIso = rebookingAssessment?.bestCandidate?.option.arrivalTime;
    const realArrivalMs = bestArrivalIso !== undefined ? Date.parse(bestArrivalIso) : NaN;
    if (
      source &&
      source.type === "flight" &&
      rebookingAssessment?.bestCandidate &&
      Number.isFinite(realArrivalMs) &&
      postNominalArrivalMs !== undefined &&
      realArrivalMs > postNominalArrivalMs
    ) {
      const baselineSource = baseline.getNode(event.nodeId);
      const originalArrivalMs =
        baselineSource && baselineSource.type === "flight"
          ? baselineSource.arrivalTime
          : Number.NaN;
      const redriveDelay = effectiveDelayMinutes(
        originalArrivalMs,
        bestArrivalIso,
        this.redriveNominalMinutes ?? 0,
      );
      this.graph.restoreFrom(baseline);
      // The spatial re-run above applied on the nominal state; restoring the
      // baseline erased it, so the re-drive re-applies the SAME spatial rule
      // in its single propagation pass (different replacement destination ⇒
      // arrival-location swap), leaving the merge guard upstream untouched.
      const replacement = rebookingAssessment.bestCandidate.option;
      const spatialOptions: DisruptionPropagationOptions =
        baselineSource &&
        baselineSource.type === "flight" &&
        baselineSource.arrivalLocationId &&
        replacement.destination !== baselineSource.arrivalLocationId
          ? { newArrivalLocationId: replacement.destination }
          : {};
      disruption = this.graph.handleDisruption(event.nodeId, redriveDelay, spatialOptions);
      this.applyArrivalFloorSweep(this.graph, disruption, realArrivalMs);
    }

    // 3) Hotel protection + activity rescheduling run in PARALLEL — the two
    //    specialist fan-outs are independent (both read-only over the graph).
    const [hotelAdjustments, activityProposals] = await Promise.all([
      this.assessHotels(disruption, event.description, event.tripContext?.currency),
      this.proposeActivityRescheduling(
        disruption,
        event,
        constraints,
        // W2: the CHOSEN candidate's arrival is the floor every reorganized
        // slot must clear (the flight assessment completes before this
        // fan-out, so the arrival is known here).
        rebookingAssessment?.bestCandidate?.option.arrivalTime,
      ),
    ]);

    // 4) Transfer re-quote detection (spec §2.4): a spatial-mismatch conflict
    //    on an impacted transfer means the ride must be re-quoted from the
    //    new arrival location — one deterministic ledger term.
    //    NOTE: one re-quote per plan (first spatial transfer conflict);
    //    per-conflict accounting would require a schema change (v2).
    const spatialTransferReport =
      disruption.affected.find(
        (report) =>
          report.nodeType === "transfer" &&
          report.action === "conflict" &&
          report.reason.startsWith(SPATIAL_MISMATCH_PREFIX),
      ) ?? null;

    const sourceIsUnreportedHotel =
      !!source &&
      source.type === "hotel_check_in" &&
      !disruption.affected.some((report) => report.nodeId === source.id);
    const impactedNodes = disruption.affected.flatMap(({ nodeId }) => {
      const node = this.graph.getNode(nodeId);
      return node ? [nodeLabel(node)] : [];
    });
    // Hotel-source disruptions (e.g. "hotel overbooked"): the graph reports
    // the downstream surface only, so the disrupted hotel itself must be
    // surfaced explicitly in the impact summary.
    if (sourceIsUnreportedHotel && source) {
      impactedNodes.unshift(nodeLabel(source));
    }

    return {
      source,
      disruption,
      policyVerdict,
      rebookingAssessment,
      hotelAdjustments,
      activityProposals,
      spatialTransferReport,
      impactedNodes,
      originalDepartureMs: originalDepartureTime,
      baseline,
    };
  }

  // -------------------------------------------------------- semantic critic

  /**
   * Run the semantic critic over ONE candidate's re-planned day and enact its
   * verdict on the PROPOSALS, before any plan is assembled from them.
   *
   * The placement is the whole design. The critic is the last thing that can
   * change WHAT is in a plan and the first thing that is forbidden from
   * touching what it COSTS: `assembleResolutionPlan` runs afterwards and
   * recomputes `financial_delta` from the surviving proposals with the same
   * deterministic ledger rule it always used. A dropped activity keeps its own
   * penalty and currency, so the identity
   * `net_payable = total_new_charges − total_refund` is maintained by
   * construction, not by asking a model to respect it.
   *
   * TOTAL: the critic itself never throws, and this method treats any
   * shortfall (no critic wired, no arrival, nothing to judge) as "no
   * criticisms" — the proposals pass through untouched.
   */
  private async applySemanticCritique(
    candidate: RebookingCandidate,
    proposals: ActivityRescheduleProposal[],
    trace: string[],
  ): Promise<ActivityRescheduleProposal[]> {
    const context = this.buildCriticContext(candidate, proposals);
    if (context === null) return proposals;

    const verdict = this.semanticCritic
      ? await this.semanticCritic.review(context)
      : {
          is_sane: true,
          criticisms: deterministicCriticisms(context),
          source: "deterministic" as const,
        };
    const settled: CriticVerdict = {
      ...verdict,
      is_sane: verdict.criticisms.length === 0,
    };
    this.criticVerdicts.push(settled);
    if (settled.criticisms.length === 0) return proposals;

    const rulings = rulingsFor(settled, context);

    // The hotel ruling is a DISCLOSURE, not a money move: the check-in anchor
    // is already deferred deterministically by the arrival-floor sweep, so all
    // that is recorded here is how many booked nights that costs the traveller
    // — which the plan then states in words instead of hiding behind a time.
    if (context.hotel) {
      const hotelRuling = rulings.get(context.hotel.node_id);
      if (hotelRuling && hotelRuling.action !== "drop") {
        const anchorMs = hotelRuling.action === "shift_date" ? hotelRuling.toMs : hotelRuling.atMs;
        const nights = unstayedNights(Date.parse(context.hotel.booked_check_in), anchorMs);
        if (nights > 0) {
          this.criticNightsUnstayed.set(candidate.option.arrivalTime, nights);
          trace.push(
            `critic: arrival on a later day — ${nights} booked night(s) at ${context.hotel.name} will not be used`,
          );
        }
      }
    }

    return this.applyCriticRulings(proposals, rulings, this.redriveBaseline ?? this.graph, trace);
  }

  /**
   * Check every proposed slot against the venue's own published schedule, and
   * enact what it says.
   *
   * This runs BEFORE the critic and outranks it: a schedule is a fact, and the
   * model is an opinion about the world. Where the hours answer, nobody needs
   * to be asked. Where they do not — an unresolved venue, a name that matched
   * the wrong entity — nothing is decided from them and the item stands.
   *
   * TOTAL: any failure leaves every proposal untouched.
   */
  private async applyVenueHours(
    proposals: ActivityRescheduleProposal[],
    graph: ItineraryGraph,
    trace: string[],
  ): Promise<ActivityRescheduleProposal[]> {
    if (!this.venueHours || proposals.length === 0) return proposals;

    const queries: VenueQuery[] = [];
    for (const proposal of proposals) {
      if (proposal.action === "drop" || proposal.action === "swap") continue;
      const node = graph.getNode(proposal.activityNodeId);
      if (!node || node.type !== "activity" || !node.coordinates) continue;
      const atMs = Date.parse(proposal.newTime);
      if (!Number.isFinite(atMs)) continue;
      queries.push({
        nodeId: proposal.activityNodeId,
        name: proposal.activityName ?? node.name,
        lat: node.coordinates.lat,
        lng: node.coordinates.lng,
        atIso: new Date(atMs).toISOString(),
      });
    }
    if (queries.length === 0) return proposals;

    const verdicts = await this.venueHours.lookup(queries);
    if (verdicts.size === 0) return proposals;

    return proposals.map((proposal) => {
      const node = graph.getNode(proposal.activityNodeId);
      const name = proposal.activityName ?? (node && node.type === "activity" ? node.name : "");
      const slotMs = Date.parse(proposal.newTime);
      if (!Number.isFinite(slotMs)) return proposal;
      const outcome = decideFromHours(verdicts.get(proposal.activityNodeId), name, slotMs);
      switch (outcome.action) {
        case "keep":
          // Open at the proposed hour: the schedule has spoken for it too.
          if (verdicts.get(proposal.activityNodeId)?.openAtSlot === true) {
            this.hoursDecided.add(proposal.activityNodeId);
          }
          return proposal;
        case "move": {
          this.hoursDecided.add(proposal.activityNodeId);
          trace.push(
            `hours: ${name} → ${new Date(outcome.atMs).toISOString().slice(11, 16)} (the venue opens then)`,
          );
          return {
            ...proposal,
            newTime: new Date(outcome.atMs).toISOString(),
            rationale: outcome.reason,
          };
        }
        case "drop":
          trace.push(`hours: ${name} cancelled — the venue's own schedule says it is shut`);
          return { ...proposal, action: "drop" as const, rationale: outcome.reason };
        case "flag":
          // The hours are real but may describe the place next door. The
          // traveller keeps the booking and is told what we checked.
          trace.push(`hours: ${name} — checked a nearby venue, left as booked`);
          return { ...proposal, rationale: outcome.reason };
      }
    });
  }

  /**
   * What the critic is shown: the RESULTING DAY, not just the engine's edits.
   *
   * It used to see only the items the engine proposed to move — which are
   * exactly the items the deterministic rules already have an opinion about.
   * Measured across three live batteries: the model returned 3 findings in 14
   * consultations and every one of them was about a node the rules had already
   * ruled, so the merge dropped it and the model added nothing. It was being
   * handed a set of solved cases and asked to contribute.
   *
   * The absurdity only a model can catch is the item nobody touched — a
   * nightlife stroll left at 10:00 because nothing displaced it. So every
   * activity sharing a calendar day with the re-plan is included, whether the
   * engine moved it or not.
   */
  private buildDayItems(
    proposals: ActivityRescheduleProposal[],
    graph: ItineraryGraph,
    extraDayMs: number[] = [],
  ): CriticItem[] {
    const items: CriticItem[] = [];
    const covered = new Set<string>();
    const days = new Set<number>(extraDayMs.map(utcDayIndex));

    for (const proposal of proposals) {
      if (proposal.action === "drop") continue;
      const node = graph.getNode(proposal.activityNodeId);
      const name = proposal.activityName ?? (node && node.type === "activity" ? node.name : "");
      if (!name) continue;
      const atMs = Date.parse(proposal.newTime);
      if (Number.isFinite(atMs)) days.add(utcDayIndex(atMs));
      covered.add(proposal.activityNodeId);
      items.push({
        node_id: proposal.activityNodeId,
        name,
        proposed_start: proposal.newTime,
        ...(node ? { original_start: new Date(node.scheduledTime).toISOString() } : {}),
        category: criticCategoryOf("activity", name),
        ...(this.hoursDecided.has(proposal.activityNodeId) ? { hoursVerified: true } : {}),
      });
    }

    // …and everything else standing on those same days, untouched.
    for (const node of graph.getNodes()) {
      if (node.type !== "activity" || covered.has(node.id)) continue;
      if (!days.has(utcDayIndex(node.scheduledTime))) continue;
      const iso = new Date(node.scheduledTime).toISOString();
      items.push({
        node_id: node.id,
        name: node.name,
        proposed_start: iso,
        original_start: iso,
        category: criticCategoryOf("activity", node.name),
        untouched: true,
      });
    }
    return items;
  }

  /**
   * Enact the critic's rulings. A ruling on an item the engine never moved
   * becomes a NEW proposal — that is the whole point of showing it the day.
   *
   * Such a proposal carries penalty 0, because no agent ever quoted terms for
   * an item nobody intended to touch. That is honest rather than convenient:
   * the settlement still archives the cancellation and, when the item was
   * paid, still raises the refund to claim.
   */
  private applyCriticRulings(
    proposals: ActivityRescheduleProposal[],
    rulings: Map<string, CriticRuling>,
    graph: ItineraryGraph,
    trace: string[],
  ): ActivityRescheduleProposal[] {
    const label = (id: string) =>
      graph.getNode(id)?.type === "activity" ? (graph.getNode(id) as ActivityNode).name : id;
    const applied = proposals.map((proposal) => {
      const ruling = rulings.get(proposal.activityNodeId);
      if (!ruling || proposal.action === "swap") return proposal;
      if (ruling.action === "drop") {
        trace.push(
          `critic: ${ruling.issue} — ${proposal.activityName ?? proposal.activityNodeId} dropped`,
        );
        return { ...proposal, action: "drop" as const, rationale: ruling.reason };
      }
      if (ruling.action === "retime") {
        const iso = new Date(ruling.atMs).toISOString();
        if (iso === proposal.newTime) return proposal;
        trace.push(
          `critic: ${ruling.issue} — ${proposal.activityName ?? proposal.activityNodeId} re-timed`,
        );
        return { ...proposal, newTime: iso, rationale: ruling.reason };
      }
      return proposal;
    });

    const known = new Set(proposals.map((p) => p.activityNodeId));
    for (const [nodeId, ruling] of rulings) {
      if (known.has(nodeId)) continue;
      const node = graph.getNode(nodeId);
      if (!node || node.type !== "activity") continue;
      if (ruling.action === "shift_date") continue;
      const name = label(nodeId);
      if (ruling.action === "drop") {
        trace.push(`critic: ${ruling.issue} — ${name} dropped (untouched by the re-plan)`);
        applied.push({
          activityNodeId: nodeId,
          activityName: name,
          action: "drop",
          newTime: new Date(node.scheduledTime).toISOString(),
          penalty: 0,
          currency: "EUR",
          rationale: ruling.reason,
        } as ActivityRescheduleProposal);
        continue;
      }
      const iso = new Date(ruling.atMs).toISOString();
      trace.push(`critic: ${ruling.issue} — ${name} re-timed (untouched by the re-plan)`);
      applied.push({
        activityNodeId: nodeId,
        activityName: name,
        action: "reschedule",
        newTime: iso,
        penalty: 0,
        currency: "EUR",
        rationale: ruling.reason,
      } as ActivityRescheduleProposal);
    }
    return applied;
  }

  /**
   * Review a re-planned day that has no replacement flight behind it.
   *
   * Same critic, same rulings, same deterministic floor — only the arrival is
   * missing, so the rules that measure against a landing stand down and the
   * ones about hours and venues do the work. Returns the proposals untouched
   * when there is nothing to say.
   */
  private async critiqueWithoutArrival(
    proposals: ActivityRescheduleProposal[],
    event: DisruptionEvent,
    trace: string[],
  ): Promise<ActivityRescheduleProposal[]> {
    const graph = this.redriveBaseline ?? this.graph;
    const items = this.buildDayItems(proposals, graph);
    if (items.length === 0) return proposals;

    // A delayed flight with no rebooking still HAS an arrival — it is simply
    // later. Supplying it is what lets the "this could only happen on another
    // day" rule fire honestly, while a weather or activity mission (no flight
    // source) rightly has none, so a deliberate move to tomorrow stands.
    const source = this.graph.getNode(event.nodeId);
    let arrival: CriticContext["arrival"];
    if (source && source.type === "flight" && Number.isFinite(source.arrivalTime)) {
      const { readyForPickupMs, readyInCityMs } = arrivalWindows(
        source.origin,
        source.destination,
        source.arrivalTime,
      );
      const booked = this.redriveBaseline?.getNode(event.nodeId);
      const bookedArrivalMs =
        booked && booked.type === "flight" ? booked.arrivalTime : source.arrivalTime;
      arrival = {
        ...(source.origin ? { origin: source.origin } : {}),
        ...(source.destination ? { airport: source.destination } : {}),
        iso: new Date(source.arrivalTime).toISOString(),
        ready_in_city_iso: new Date(readyInCityMs).toISOString(),
        ready_for_pickup_iso: new Date(readyForPickupMs).toISOString(),
        is_next_day: utcDayIndex(source.arrivalTime) > utcDayIndex(bookedArrivalMs),
        original_arrival_iso: new Date(bookedArrivalMs).toISOString(),
      };
    }

    const context: CriticContext = {
      incident: event.description ?? "Disrupted trip",
      ...(arrival ? { arrival } : {}),
      items,
    };
    const verdict = this.semanticCritic
      ? await this.semanticCritic.review(context)
      : {
          is_sane: true,
          criticisms: deterministicCriticisms(context),
          source: "deterministic" as const,
        };
    const settled: CriticVerdict = { ...verdict, is_sane: verdict.criticisms.length === 0 };
    this.criticVerdicts.push(settled);
    if (settled.criticisms.length === 0) return proposals;

    const rulings = rulingsFor(settled, context);
    return this.applyCriticRulings(proposals, rulings, graph, trace);
  }

  /**
   * The facts the critic is allowed to see for ONE candidate: where and when
   * it lands, the buffers that follow from that route, the hotel check-in it
   * implies, and each proposed slot beside the slot it was booked for.
   *
   * `null` when there is nothing to judge — no flight source, an unparseable
   * arrival, or a day with neither an activity nor a hotel on it.
   */
  private buildCriticContext(
    candidate: RebookingCandidate,
    proposals: ActivityRescheduleProposal[],
  ): CriticContext | null {
    const baseline = this.redriveBaseline;
    const event = this.redriveEvent;
    if (!baseline || !event) return null;
    const source = baseline.getNode(event.nodeId);
    if (!source || source.type !== "flight") return null;
    const arrivalMs = Date.parse(candidate.option.arrivalTime);
    if (!Number.isFinite(arrivalMs)) return null;
    // Graph nodes carry epoch ms, not ISO (see core/dag types).
    const originalArrivalMs = source.arrivalTime;

    const { readyForPickupMs, readyInCityMs } = arrivalWindows(
      candidate.option.origin,
      candidate.option.destination,
      arrivalMs,
    );

    // The arrival day is included even when nothing on it was moved: that is
    // where an untouched absurdity is most likely to sit.
    const items = this.buildDayItems(proposals, baseline, [arrivalMs]);

    // The hotel the traveller is heading to: its BOOKED check-in, and the one
    // this candidate implies (the arrival-floor rule — a room is reached when
    // they are really in town, never earlier than booked).
    let hotel: CriticContext["hotel"];
    for (const node of baseline.getDownstream(event.nodeId)) {
      if (node.type !== "hotel_check_in") continue;
      hotel = {
        node_id: node.id,
        name: node.hotelName,
        booked_check_in: new Date(node.scheduledTime).toISOString(),
        proposed_check_in: new Date(Math.max(node.scheduledTime, readyInCityMs)).toISOString(),
      };
      break;
    }
    if (items.length === 0 && !hotel) return null;

    return {
      incident: event.description ?? "Disrupted flight",
      arrival: {
        ...(candidate.option.origin ? { origin: candidate.option.origin } : {}),
        ...(candidate.option.destination ? { airport: candidate.option.destination } : {}),
        iso: new Date(arrivalMs).toISOString(),
        ready_in_city_iso: new Date(readyInCityMs).toISOString(),
        ready_for_pickup_iso: new Date(readyForPickupMs).toISOString(),
        is_next_day:
          Number.isFinite(originalArrivalMs) &&
          utcDayIndex(arrivalMs) > utcDayIndex(originalArrivalMs),
        ...(Number.isFinite(originalArrivalMs)
          ? { original_arrival_iso: new Date(originalArrivalMs).toISOString() }
          : {}),
      },
      ...(hotel ? { hotel } : {}),
      items,
    };
  }

  /**
   * Stamp the lost-night count this candidate implies onto its hotel
   * adjustments. Disclosure only — `fee` is untouched, because the property's
   * terms for a night nobody sleeps in are not ours to guess, and a number we
   * invented would land in a ledger the traveller is asked to approve.
   */
  private discloseUnstayedNights(
    adjustments: HotelAdjustment[],
    chosen: RebookingCandidate | null,
  ): HotelAdjustment[] {
    if (chosen === null || adjustments.length === 0) return adjustments;
    const nights = this.criticNightsUnstayed.get(chosen.option.arrivalTime);
    if (nights === undefined || nights <= 0) return adjustments;
    return adjustments.map((adjustment) =>
      adjustment.action === "late_check_in"
        ? { ...adjustment, nights_unstayed: nights }
        : adjustment,
    );
  }

  /**
   * Task 20 — arrival-floor sweep (single documented rule): after a
   * real-arrival re-propagation, ANY downstream `activity` /
   * `hotel_check_in` node NOT already reported, whose booked slot lies at or
   * before `realArrival + activity buffer`, is still inside the traveler's
   * unavailable window — the propagation walk never reached it (no AFFECTED
   * upstream, e.g. behind an unflagged transfer) yet it cannot happen before
   * the traveler lands. Flag it WITHOUT topology changes: activities become
   * `requires_rescheduling`; hotel check-ins are re-timed to the arrival and
   * reported `updated` (mirroring the propagation's own hotel semantics).
   * Deterministic: downstream iteration order is topological and stable.
   */
  private applyArrivalFloorSweep(
    graph: ItineraryGraph,
    disruption: DisruptionResult,
    realArrivalMs: number,
  ): void {
    const floorMs = realArrivalMs + ARRIVAL_FLOOR_BUFFER_MINUTES * 60_000;
    const reported = new Set(disruption.affected.map((report) => report.nodeId));
    for (const node of graph.getDownstream(disruption.sourceNodeId)) {
      if (reported.has(node.id)) continue;
      if (node.scheduledTime > floorMs) continue;
      if (node.type === "activity") {
        node.status = "requires_rescheduling";
        disruption.affected.push({
          nodeId: node.id,
          nodeType: node.type,
          action: "requires_rescheduling",
          previousScheduledTime: node.scheduledTime,
          reason:
            "Arrival-floor sweep: booked at or before the replacement arrival + buffer, ahead of the propagation window.",
        });
      } else if (node.type === "hotel_check_in") {
        const previous = node.scheduledTime;
        const next = Math.max(previous, realArrivalMs);
        node.scheduledTime = next;
        node.status = "updated";
        disruption.affected.push({
          nodeId: node.id,
          nodeType: node.type,
          action: "updated",
          previousScheduledTime: previous,
          newScheduledTime: next,
          reason:
            "Arrival-floor sweep: check-in booked at or before the replacement arrival + buffer — deferred to the arrival.",
        });
      }
    }
  }

  /**
   * Task 20 — per-plan activity rederive: re-propagate the disruption from
   * the untouched baseline with ONE plan's OWN replacement arrival (its
   * effective delay), run the arrival-floor sweep, then the existing
   * {@link proposeActivityRescheduling} on the derived surface — so each
   * carousel plan carries activity moves consistent with ITS OWN arrival.
   *
   * The SHARED {@link ActivityAgent} instance runs every walk: the
   * per-mission Viator consult budget (VIATOR_CONSULTS_PER_MISSION) spans
   * ALL plans, never per-plan budgets. Pure CPU up to the existing activity
   * fan-out; deterministic (a pure function of the baseline graph, the
   * arrival ISO and the constraints). Returns [] on any shortfall (no
   * activity agent, no pipeline run yet, non-flight source) — callers treat
   * that as "no per-plan moves", never an error.
   */
  async rederiveActivityProposalsForArrival(
    arrivalIso: string,
    constraints?: ResolutionConstraints,
    /**
     * Task 25 (#5, additive): the SELECTED replacement's destination — the
     * rederive walk re-applies the SAME spatial rule the live re-drive does
     * (different replacement destination ⇒ arrival-location swap), so a
     * different-airport rebooking flags its spatial transfer conflicts in
     * the per-plan walk exactly like the pipeline re-drive. Absent ⇒ the
     * pure-chronological walk (pre-fix behaviour).
     */
    replacementDestination?: string,
  ): Promise<ActivityRescheduleProposal[]> {
    if (!this.activityAgent) return [];
    const baseline = this.redriveBaseline;
    const event = this.redriveEvent;
    if (!baseline || !event) return [];
    const source = baseline.getNode(event.nodeId);
    if (!source || source.type !== "flight") return [];
    const arrivalMs = Date.parse(arrivalIso);
    if (!Number.isFinite(arrivalMs)) return [];
    const delay = effectiveDelayMinutes(
      source.arrivalTime,
      arrivalIso,
      this.redriveNominalMinutes ?? 0,
    );
    const derived = baseline.clone();
    // Task 25 (#5): mirror the pipeline re-drive's spatialOptions (see the
    // re-drive block in runDisruptionPipeline) — a replacement landing at a
    // DIFFERENT location swaps the arrival location in the walk itself.
    const spatialOptions: DisruptionPropagationOptions =
      source.arrivalLocationId &&
      replacementDestination !== undefined &&
      replacementDestination !== source.arrivalLocationId
        ? { newArrivalLocationId: replacementDestination }
        : {};
    const disruption = derived.handleDisruption(event.nodeId, delay, spatialOptions);
    this.applyArrivalFloorSweep(derived, disruption, arrivalMs);
    return this.proposeActivityRescheduling(disruption, event, constraints, arrivalIso, derived);
  }

  /**
   * The fare policy for ONE replacement offer — the offer this plan proposes,
   * never another plan's.
   *
   * WHY THIS IS PER CANDIDATE. The verdict used to be computed once, from the
   * pipeline's single cheapest candidate, and then stamped onto every plan in
   * the carousel. Verified against the live Atlas sandbox on 2026-09-19 for
   * SIN→HND: the AirAsia routings via KUL publish their rules in MYR/SGD, and
   * the VietJet routings via SGN publish theirs in VND. Ranking by price alone
   * made a €46 VietJet routing the pipeline's best candidate, so the AirAsia
   * plan the traveller was reading carried VietJet's VND 1 100 000 change fee.
   * The money panel described a flight that plan does not book.
   *
   * Returns null when there is nothing better than the caller's existing
   * verdict: no policy agent, no candidate, or an offer carrying no rule.
   */
  private async policyVerdictForCandidate(
    candidate: RebookingCandidate | null,
    event: DisruptionEvent,
  ): Promise<FarePolicyVerdict | null> {
    const rule = candidate?.option.fareRule;
    const flightId = this.policySourceFlightId;
    if (!this.policyAgent || !candidate || !flightId) return null;
    if (!rule || Object.keys(rule).length === 0) return null;

    const cached = this.policyVerdictByOption.get(candidate.option.id);
    if (cached !== undefined) return cached;

    const departureBasis = this.policyDepartureBasisMs ?? Date.now();
    const verdict = await this.policyAgent.assessFarePolicy({
      originalFlightId: flightId,
      rule,
      minutesToDeparture: Math.max(0, Math.round((departureBasis - Date.now()) / 60_000)),
      disruptionKind: classifyDisruptionKind(event.description),
      // One currency in the money panel: the fee follows the ticket it
      // applies to whenever the rule itself names none.
      fallbackCurrency: candidate.option.currency,
    });
    if (verdict) {
      verdict.ruleSource = "provider_published";
      // A carrier may publish its rules in its own currency. Convert through
      // the SAME EUR rate table the timeline, budget and PDF use — never a
      // rate invented here — and keep what the carrier will actually bill
      // alongside it.
      const fareCurrency = candidate.option.currency;
      if (fareCurrency && verdict.changeFee > 0 && verdict.currency !== fareCurrency) {
        const from = rateFromEurOf(verdict.currency as Currency);
        const to = rateFromEurOf(fareCurrency as Currency);
        if (from > 0 && to > 0) {
          verdict.billedChangeFee = verdict.changeFee;
          verdict.billedCurrency = verdict.currency;
          verdict.changeFee =
            Math.round(((verdict.changeFee / from) * to + Number.EPSILON) * 100) / 100;
          verdict.currency = fareCurrency;
        }
      }
    }
    this.policyVerdictByOption.set(candidate.option.id, verdict);
    return verdict;
  }

  /**
   * What one candidate costs the traveller, in EUR — everything they pay to
   * take it, not just the fare.
   *
   * The fare difference is only half the bill: changing a ticket also costs
   * whatever the carrier's own rule charges, and that fee is per offer. A
   * badge derived from the fare alone called a €96.25 plan "cheapest" beside
   * one that hands €1.65 back, because the €120 change fee sat outside the
   * comparison. EUR is the common ground: two candidates may be quoted in
   * different currencies, and unranked is not an option when one of them has
   * to be called the cheapest.
   */
  private async candidateCostEur(
    candidate: RebookingCandidate,
    event: DisruptionEvent,
  ): Promise<number> {
    const toEur = (amount: number, currency: string | undefined): number => {
      const rate = rateFromEurOf((currency ?? "EUR") as Currency);
      return rate > 0 ? amount / rate : amount;
    };
    const fare = toEur(candidateNetCharge(candidate), candidate.fareDifference.currency);
    const verdict = await this.policyVerdictForCandidate(candidate, event);
    const fee =
      verdict && verdict.changeFee > 0
        ? toEur(verdict.changeFee, verdict.currency ?? candidate.option.currency)
        : 0;
    return fare + fee;
  }

  /**
   * Assemble ONE deterministic TrustLayer plan around a SELECTED rebooking
   * candidate (legacy rail passes the cheapest bestCandidate; the multi-plan
   * rail passes the per-profile pick). Financial delta, TTL and the transfer
   * re-quote are all computed for this selection alone.
   */
  private assembleResolutionPlan(
    event: DisruptionEvent,
    pipeline: {
      disruption: DisruptionResult;
      policyVerdict: FarePolicyVerdict | null;
      activityProposals: ActivityRescheduleProposal[];
      spatialTransferReport: AffectedNodeReport | null;
      impactedNodes: string[];
      /** null when no flight rebooking was ever attempted (a non-flight
       *  disruption); non-null — even with an EMPTY `.candidates` — when a
       *  flight search ran and came back with nothing. Distinguishing these
       *  is the whole point of threading this through: only the second case
       *  means the traveler is being shown a plan that solves nothing. */
      rebookingAssessment: FlightRebookingAssessment | null;
    },
    chosen: RebookingCandidate | null,
    options: {
      hotelAdjustments: HotelAdjustment[];
      includeTransferRequote: boolean;
      /**
       * Single timestamp used for ALL quote-TTL stamps of the plan. The
       * multi-plan rail captures `Date.now()` ONCE per resolve call and
       * threads it through every assembly so two profiles selecting the
       * same candidate serialize to the IDENTICAL canonical form — a fresh
       * `Date.now()` per assembly would defeat the canonical-JSON dedup
       * whenever the millisecond clock ticks between loop iterations.
       * Defaults to `Date.now()` so the legacy single-plan rail is unchanged.
       */
      stampMs?: number;
      /**
       * Task 25 (#1, additive): the activity proposal set consistent with
       * this SELECTION's own replacement arrival (a per-plan rederive walk).
       * When present it overrides the SHARED pipeline proposals for the plan
       * BODY (rescheduled_activities + financial_delta), so body,
       * presentation and operational all derive from the same per-arrival
       * walk. Absent (legacy rail, non-flight, rederive inactive) ⇒ the
       * shared `pipeline.activityProposals`, exactly as pre-fix.
       */
      activityProposals?: ActivityRescheduleProposal[];
      /**
       * The fare policy of THIS plan's own replacement offer. Absent ⇒ the
       * shared pipeline verdict (legacy rail, or an offer that publishes no
       * rule). See `policyVerdictForCandidate` for why a carousel must not
       * share one: the fee and the currency belong to a specific flight.
       */
      policyVerdict?: FarePolicyVerdict | null;
    },
  ): ResolutionPlan {
    const spatialTransferReport = options.includeTransferRequote
      ? pipeline.spatialTransferReport
      : null;
    // Task 25 (#1): body derives from the per-selection proposal set when
    // supplied, otherwise from the shared pipeline walk.
    const activityProposals = options.activityProposals ?? pipeline.activityProposals;
    // This plan's own flight policy when the caller resolved one; the shared
    // pipeline verdict otherwise. `undefined` means "not supplied"; an
    // explicit `null` is a caller saying there is no verdict for this plan.
    const policyVerdict =
      options.policyVerdict !== undefined ? options.policyVerdict : pipeline.policyVerdict;

    const proposedResolution = this.buildProposedResolution(event, chosen, {
      hotelAdjustments: options.hotelAdjustments,
      activityProposals,
      policyVerdict,
      spatialTransferReport,
    });
    const financialDelta = this.buildFinancialDelta(
      chosen,
      {
        policyVerdict,
        hotelAdjustments: options.hotelAdjustments,
        activityProposals,
        rebooked: chosen !== null,
        transferRequote: spatialTransferReport !== null,
      },
      // Same currency expression as the plan's currency stamp below: the
      // ledger's home bucket (foreign fares segregate into their own).
      event.tripContext?.currency ?? "EUR",
      // …and the currency the traveller reads in, for the single-currency
      // `display` view. Falls back to the trip's when the client sent none.
      event.tripContext?.displayCurrency ?? event.tripContext?.currency ?? "EUR",
    );

    // TTL (shortest expires_at wins) — computed FRESH at assembly time so a
    // resolve-phase rerun restarts the quote horizons. Both stamps share the
    // SAME timestamp (options.stampMs ?? Date.now()) so sibling plans of one
    // resolve call serialize identically for the canonical dedup.
    const now = options.stampMs ?? Date.now();
    let expiresAt: number | undefined;
    if (chosen) {
      expiresAt = now + ATLAS_QUOTE_TTL_MS;
    }
    if (options.hotelAdjustments.length > 0) {
      const hotelExpires = now + HOTEL_QUOTE_TTL_MS;
      expiresAt = expiresAt ? Math.min(expiresAt, hotelExpires) : hotelExpires;
    }

    // A flight search that ran and came back with ZERO options used to
    // produce a plan that looked exactly like every other one — same
    // "requires human approval" card, "€0.00 to pay", no `new_flight` — with
    // nothing telling the traveler their itinerary still has an unresolved
    // gap. The headline is the one thing every presentation of this plan is
    // guaranteed to show, so that is where the honesty has to live.
    const flightSearchFoundNothing = chosen === null && pipeline.rebookingAssessment !== null;
    // …and WHY it found nothing, because the four reasons ask the traveller to
    // do four different things. "No replacement found" alone reads as "we
    // searched everywhere and the flight does not exist", when in truth one
    // partner with a partial dataset was asked once. Verified live on
    // 2026-09-02: the Atlas sandbox returns zero routings for SIN → Rome,
    // Milan, Paris, Frankfurt, Munich and Barcelona on every date, while
    // London, Tokyo, Amsterdam, Istanbul and Dubai answer normally.
    const incident = flightSearchFoundNothing
      ? `${event.description} — ${noReplacementHeadline(
          pipeline.rebookingAssessment?.noReplacementReason,
        )}`
      : event.description;

    return {
      incident,
      impacted_nodes: pipeline.impactedNodes,
      proposed_resolution: proposedResolution,
      financial_delta: financialDelta,
      requires_human_approval: true, // enforced by the type system: always literal `true`
      ...(expiresAt ? { expires_at: expiresAt } : {}),
      // Additive (Phase B): the currency every amount is quoted in — the
      // hydrated trip's currency when present, EUR default on the demo graph.
      currency: event.tripContext?.currency ?? "EUR",
    };
  }

  /**
   * HotelAgent fan-out over impacted hotel_check_in nodes.
   *
   * Hotel-source guard: ItineraryGraph.handleDisruption re-times the
   * disrupted SOURCE node in place and reports only the DOWNSTREAM surface
   * (reachableFrom/topologicalDownstream exclude the source), so when the
   * disruption source IS itself a hotel_check_in ("hotel overbooked") it
   * never enters `disruption.affected`. Without this guard the fan-out would
   * be structurally empty — no hotel_adjustments and, consequently, no
   * 30-minute quote TTL on the plan. The source node is synthesized into the
   * fan-out so hotel-source missions behave like every other hotel mission.
   */
  private async assessHotels(
    disruption: DisruptionResult,
    intentDesc: string,
    /** The trip's own currency, so a replacement room is quoted in it. */
    tripCurrency?: string,
  ): Promise<HotelAdjustment[]> {
    const roomIsGone = /overbook/i.test(intentDesc);
    if (!this.hotelAgent) {
      // Silence is an answer here, and the wrong one. An overbooked traveller
      // has no bed tonight; returning an empty list produced a plan that
      // never mentioned the hotel at all, on the one mission that is
      // ENTIRELY about the hotel. Say plainly that we could not look.
      const source = this.graph.getNode(disruption.sourceNodeId);
      if (roomIsGone && source && source.type === "hotel_check_in") {
        return [
          {
            hotel_name: (source as HotelCheckInNode).hotelName,
            action: "none",
            fee: 0,
            requires_confirmation: true,
            note:
              "The property says your room is gone, and we cannot search for a replacement right now. " +
              "Your other bookings are untouched. Ask the property to rehouse you — they owe you a " +
              "comparable room at their expense when they walk a confirmed booking.",
          },
        ];
      }
      return [];
    }
    const reports = [...disruption.affected];
    const sourceNode = this.graph.getNode(disruption.sourceNodeId);
    if (
      sourceNode &&
      sourceNode.type === "hotel_check_in" &&
      !reports.some((report) => report.nodeId === sourceNode.id)
    ) {
      // handleDisruption already committed the source's shifted schedule, so
      // the original check-in is recovered by undoing the applied delay.
      const hotelSource = sourceNode as HotelCheckInNode;
      reports.push({
        nodeId: hotelSource.id,
        nodeType: "hotel_check_in",
        action: "updated",
        previousScheduledTime: hotelSource.scheduledTime - disruption.delayMinutes * 60_000,
        newScheduledTime: hotelSource.scheduledTime,
        reason: "Disrupted hotel check-in assessed directly at the source.",
      });
    }
    const adjustments: HotelAdjustment[] = [];
    for (const report of reports) {
      const node = this.graph.getNode(report.nodeId);
      if (!node || node.type !== "hotel_check_in") continue;
      const hotelNode = node as HotelCheckInNode;
      const shiftedMs = report.newScheduledTime ?? hotelNode.scheduledTime;
      const isOverbooked = report.nodeId === disruption.sourceNodeId && roomIsGone;
      const assessment = await this.hotelAgent.assessHotelImpact({
        hotelNodeId: hotelNode.id,
        hotelName: hotelNode.hotelName,
        originalCheckIn: new Date(report.previousScheduledTime).toISOString(),
        shiftedCheckIn: new Date(shiftedMs).toISOString(),
        guests: 1,
        isOverbooked: isOverbooked,
        // Quote a replacement room in the money the rest of the plan uses.
        ...(tripCurrency ? { currency: tripCurrency } : {}),
      });
      // Additive (Phase B): surface the best alternative room (when the
      // provider found one) as display-only presentation feed.
      const bestAlternative = assessment.alternativeRooms[0];
      adjustments.push({
        hotel_name: hotelNode.hotelName,
        ...(assessment.degraded ? { requires_confirmation: true } : {}),
        ...(assessment.note ? { note: assessment.note } : {}),
        action:
          assessment.recommendation === "keep_late_checkin"
            ? "late_check_in"
            : assessment.recommendation === "rebook_room"
              ? "rebook"
              : "none",
        fee: Math.max(0, assessment.feeDelta),
        ...(bestAlternative
          ? {
              alternative: {
                name: bestAlternative.hotelName ?? hotelNode.hotelName,
                ratePerNight: bestAlternative.ratePerNight,
                currency: bestAlternative.currency ?? assessment.currency,
                ...(bestAlternative.freeCancellationUntil
                  ? { freeCancellationUntil: bestAlternative.freeCancellationUntil }
                  : {}),
                ...(bestAlternative.latitude !== undefined
                  ? { lat: bestAlternative.latitude }
                  : {}),
                ...(bestAlternative.longitude !== undefined
                  ? { lng: bestAlternative.longitude }
                  : {}),
                ...(bestAlternative.images && bestAlternative.images.length > 0
                  ? { images: bestAlternative.images }
                  : {}),
              },
            }
          : {}),
      });
    }
    return adjustments;
  }

  /**
   * ActivityAgent fan-out over nodes flagged `requires_rescheduling`.
   *
   * Proactive weather edge case: missions carry `delay: 0`, and
   * ItineraryGraph.handleDisruption treats a zero delay as a no-op (empty
   * `affected`), so no request would ever reach the ActivityAgent. When a
   * proactive weather event targets an activity node directly and the graph
   * produced no reschedule requests, synthesize one request for that node
   * (its own scheduledTime/durationMinutes window + the weather hint) so the
   * outdoor→indoor swap path still runs. The same synthesis applies to
   * proactive `user_report` missions (strike-without-transit / unwell): they
   * also carry delay 0 and target an activity node directly. The financial
   * ledger is untouched
   * by this synthesis: any resulting proposal flows through the normal
   * buildProposedResolution/buildFinancialDelta path, and zero-cost
   * (non-flight) sources keep `net_payable` consistent.
   */
  /**
   * Every activity proposal passes the common-sense invariants before any plan
   * is built from it — the ONE choke point shared by the main pipeline and
   * every per-plan rederive, so no carousel page can carry a slot the others
   * would have refused.
   *
   * A retime into sleeping hours, past the item's sensible window (a 13:00
   * lunch at 21:20), or before the traveller can physically be in town becomes
   * an honest drop, keeping the SAME penalty and rationale so the ledger is
   * untouched. Swaps are left alone: their price delta is already folded into
   * the ledger, and a weather swap keeps its own slot by design.
   */
  private async proposeActivityRescheduling(
    disruption: DisruptionResult,
    event: DisruptionEvent,
    constraints?: ResolutionConstraints,
    newArrivalIso?: string,
    graph: ItineraryGraph = this.graph,
  ): Promise<ActivityRescheduleProposal[]> {
    const proposals = await this.proposeActivityReschedulingUnchecked(
      disruption,
      event,
      constraints,
      newArrivalIso,
      graph,
    );
    if (proposals.length === 0) return proposals;

    const source = graph.getNode(disruption.sourceNodeId);
    const arrivalMs = newArrivalIso ? Date.parse(newArrivalIso) : Number.NaN;
    const readyInCityMs =
      Number.isFinite(arrivalMs) && source && source.type === "flight"
        ? arrivalMs + arrivalBuffer(source.origin, source.destination).readyInCityMinutes * 60_000
        : undefined;
    const originalMsOf = new Map(
      disruption.affected.map((report) => [report.nodeId, report.previousScheduledTime]),
    );

    return proposals.map((proposal) => {
      if (proposal.action !== "reschedule") return proposal;
      const node = graph.getNode(proposal.activityNodeId);
      const name = proposal.activityName ?? (node && node.type === "activity" ? node.name : "");
      const proposedMs = Date.parse(proposal.newTime);
      if (!Number.isFinite(proposedMs)) return proposal;
      const originalMs = originalMsOf.get(proposal.activityNodeId) ?? proposedMs;
      // Two floors, in order: the traveller cannot be there before they land,
      // and an item cannot start before the hour it makes sense at (a night
      // view is not a 16:00 item). Both RAISE the slot; neither drops it.
      const landedMs =
        readyInCityMs !== undefined ? Math.max(proposedMs, readyInCityMs) : proposedMs;
      const atMs = clampToWindowStart(
        classifyItem({ type: "activity", title: name }),
        name,
        landedMs,
        minutesOfDay(originalMs),
      );
      // An arrival that pushes the only remaining slot onto ANOTHER CALENDAR
      // DAY is a drop, not a move: tomorrow already has its own plan. This is
      // the rule `placeDisplacedItem` enforces on the settlement cascade, and
      // the proposal path could slip past it — a 20:00 activity on the 5th,
      // with a replacement landing on the 6th, quietly became a 19:15 activity
      // on the 6th and was shown as a re-time.
      //
      // A proposal that CHOSE another day on its own is untouched: the weather
      // rail deliberately moves a rained-off walk to tomorrow, and that is a
      // decision rather than a side effect.
      const clampCrossedDay =
        atMs !== proposedMs &&
        utcDayIndex(proposedMs) === utcDayIndex(originalMs) &&
        utcDayIndex(atMs) !== utcDayIndex(originalMs);
      if (clampCrossedDay) {
        return {
          ...proposal,
          action: "drop" as const,
          newTime: new Date(originalMs).toISOString(),
          rationale: `Cancelled — ${describeDropReason("would_move_to_another_day")}.${
            proposal.rationale ? ` ${proposal.rationale}` : ""
          }`,
        };
      }
      const verdict = isSensibleStart(
        classifyItem({ type: "activity", title: name }),
        name,
        atMs,
        minutesOfDay(originalMs),
      );
      if (!verdict.ok) {
        return {
          ...proposal,
          action: "drop" as const,
          // Frozen shape: a drop keeps the original slot as its newTime.
          newTime: new Date(originalMs).toISOString(),
          rationale: `Cancelled — ${describeDropReason(verdict.reason)}.${
            proposal.rationale ? ` ${proposal.rationale}` : ""
          }`,
        };
      }
      return atMs === proposedMs
        ? proposal
        : { ...proposal, newTime: new Date(atMs).toISOString() };
    });
  }

  private async proposeActivityReschedulingUnchecked(
    disruption: DisruptionResult,
    event: DisruptionEvent,
    /** W2 (additive): liaison constraints — `activity_priority`/`notes`
     *  drive the day reorganizer's priority ordering. */
    constraints?: ResolutionConstraints,
    /** W2 (additive): the chosen replacement flight's arrival ISO — the
     *  start-floor every reorganized slot must clear. */
    newArrivalIso?: string,
    /** Task 20 (additive): the graph the derived disruption belongs to —
     *  the live graph by default; a rederive walk passes its own clone. */
    graph: ItineraryGraph = this.graph,
  ): Promise<ActivityRescheduleProposal[]> {
    if (!this.activityAgent) return [];
    // A broken connection does not reshuffle the itinerary.
    //
    // Live on 2026-09-18, "Transit strike tomorrow" produced a correct ground
    // plan AND moved one restaurant to the following evening — for a strike
    // that is itself tomorrow. We cannot verify the strike, cannot know which
    // lines it closes, and therefore cannot say which items become
    // unreachable. Moving one at random is a guess wearing the clothes of a
    // plan. The ground card answers the question; the itinerary stands.
    //
    // A question about the itinerary as booked (`adviceOnly`) stands the rail
    // down for the same reason: nothing has moved, so nothing may be moved.
    if (event.groundOnly || event.adviceOnly) return [];
    const requests = disruption.affected
      .filter(({ action }) => action === "requires_rescheduling")
      .flatMap((report) => {
        const node = graph.getNode(report.nodeId);
        if (!node || node.type !== "activity") return [];
        const activityNode = node as ActivityNode;
        const originalMs = report.previousScheduledTime;
        return [
          {
            activityNodeId: activityNode.id,
            activityName: activityNode.name,
            originalTime: new Date(originalMs).toISOString(),
            // Acceptable rebooking window: 1h after the original slot up to
            // 48h later (deterministic; the agent clamps inside it).
            windowStart: new Date(originalMs + 60 * 60 * 1000).toISOString(),
            windowEnd: new Date(originalMs + 48 * 60 * 60 * 1000).toISOString(),
            weatherHint: weatherHintFromEvent(event),
            // Hydrated-trip context scopes the provider search + currency.
            location: event.tripContext?.city,
            currency: event.tripContext?.currency,
          },
        ];
      });

    // Bug fix (disrupted activity itself silently unresolved): `disruption.affected`
    // — the source of `requests` above — only ever lists DOWNSTREAM nodes;
    // `ItineraryGraph.handleDisruption` excludes the disrupted node itself
    // (see its docs). So a direct activity cancellation whose node ALSO has an
    // in-graph dependent (a later same-day activity) produced a real request
    // for that dependent — making `requests` non-empty — while the cancelled
    // activity itself never got a request synthesized below, because the old
    // gate ("only synthesize when NOTHING else was requested") treated the
    // sibling's request as proof the direct target was already handled. Live
    // symptom: "Activity cancelled — Lau Pa Sat" produced a plan that only
    // mentioned Night Safari (a downstream reschedule) and said nothing about
    // Lau Pa Sat at all. The correct gate is per-node: only skip synthesis
    // when THIS node specifically already has a request, not when the day had
    // any requests at all.
    const targetAlreadyRequested = (nodeId: string): boolean =>
      requests.some((request) => request.activityNodeId === nodeId);

    const isActivityCancellation =
      event.origin === "reactive" && classifyDisruptionKind(event.description) === "cancellation";

    let finalWeatherHint = weatherHintFromEvent(event);
    let eventTitle = event.description;

    // Corroborate what the traveller told us, and never pretend we did.
    //
    // These providers only ever CONFIRM a report. If the check cannot run we
    // proceed on the traveller's word — but the plan must SAY so, and that is
    // where this was wrong. The disclosure used to be written only when the
    // provider was reached and failed. Every earlier exit, a missing city, a
    // geocode that found nothing, no provider configured, fell through
    // silently and left the headline asserting "Weather alert — Rome, Italy"
    // as an established fact. Measured live on 2026-09-18: 1 of 6 weather
    // missions disclosed, 5 claimed. A plausible claim with no source is the
    // defect this engine exists to refuse, so the disclosure is now the
    // DEFAULT and a confirmation has to be earned.
    if (event.origin === "proactive" && event.evidence !== undefined) {
      const place = event.tripContext?.city ?? "your destination";
      const coords = await missionCoordinates(graph, event.nodeId, event.tripContext?.city);

      if (event.evidence.kind === "weather") {
        const forecast =
          coords && this.weatherProvider
            ? await this.weatherProvider
                .getRainForecast(coords.lat, coords.lng, 48)
                .catch((error: unknown) => {
                  console.warn(
                    "[orchestrator] weather check unavailable — taking the traveller's word:",
                    error,
                  );
                  return null;
                })
            : null;
        // A forecast that stops before the window asked about is not an
        // answer. Reporting it as clear skies would invent the one thing the
        // traveller would act on.
        const usable = forecast !== null && forecast.coversHorizon !== false;
        if (!usable) {
          eventTitle = `Weather reported in ${place} (not independently confirmed)`;
          finalWeatherHint = "rain";
        } else if (forecast.windows.length === 0) {
          // Checked, and dry. The finding has to reach the plan BEFORE the
          // early return, or the traveller reads "Weather alert — Rome" over
          // a plan that changes nothing, which is the one case where we know
          // the answer and keep it to ourselves.
          event.description = `Real weather checked for ${place}: clear skies!`;
          return []; // Empty requests means no adjustments
        } else {
          eventTitle = `Confirmed rain in ${place}: adapting itinerary`;
          finalWeatherHint = "rain";
        }
      } else if (event.evidence.kind === "event") {
        const found =
          coords && this.eventProvider
            ? await this.eventProvider
                .findDisruptiveEvents({
                  latitude: coords.lat,
                  longitude: coords.lng,
                  radiusKm: 25,
                  from: new Date().toISOString(),
                  to: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
                })
                .catch((error: unknown) => {
                  console.warn(
                    "[orchestrator] event check unavailable — taking the traveller's word:",
                    error,
                  );
                  return null;
                })
            : null;
        if (found === null) {
          eventTitle = `Disruption reported in ${place} (not independently confirmed)`;
        } else if (found.events.length === 0) {
          event.description = `Real event check for ${place}: no disruptions found!`;
          return [];
        } else {
          eventTitle = `Confirmed disruption: ${found.events[0].name}`;
        }
      }
    }

    // Update event description so the TrustLayer displays the actual finding
    event.description = eventTitle;

    // Proactive weather recovery, direct activity cancellation, or a
    // proactive user_report (strike-without-transit / feeling-unwell
    // missions carry delay 0 and target the activity directly): synthesize
    // a request so the ActivityAgent produces real retime/swap proposals.
    const isProactiveUserReport =
      event.origin === "proactive" && event.evidence?.kind === "user_report";

    // "Lighten my day" is about a DAY, so the whole day is put on the table.
    // One request per activity, all with a window inside that same day, which
    // is what routes them to the DayReorganizer as a single unit — and that
    // rail, with `allowsActivityDrops`, is the only one that can actually
    // REMOVE something rather than shuffle it into tomorrow.
    if (event.lightenDay) {
      const target = graph.getNode(event.nodeId);
      if (target) {
        const day = new Date(target.scheduledTime).toISOString().slice(0, 10);
        const sameDay = graph
          .getNodes()
          .filter(
            (node): node is ActivityNode =>
              node.type === "activity" &&
              new Date(node.scheduledTime).toISOString().slice(0, 10) === day,
          )
          .sort((a, b) => a.scheduledTime - b.scheduledTime);
        for (const activityNode of sameDay) {
          if (targetAlreadyRequested(activityNode.id)) continue;
          requests.push({
            activityNodeId: activityNode.id,
            activityName: activityNode.name,
            originalTime: new Date(activityNode.scheduledTime).toISOString(),
            // Inside the SAME calendar day, on purpose: a cross-day window is
            // routed to the per-item legacy rail, which can only move things.
            windowStart: `${day}T06:00:00.000Z`,
            windowEnd: `${day}T23:00:00.000Z`,
            // Being unwell is not weather: no indoor-swap hint, so the
            // reorganizer trims the day instead of substituting venues.
            weatherHint: undefined,
            location: event.tripContext?.city,
            currency: event.tripContext?.currency,
          });
        }
      }
      // No early return: these flow into the SAME dispatch as every other
      // request below, so a lightened day is reorganized, validated and
      // costed by exactly the machinery that handles a missed flight.
    }

    if (
      !targetAlreadyRequested(event.nodeId) &&
      ((event.origin === "proactive" && event.evidence?.kind === "weather") ||
        isActivityCancellation ||
        isProactiveUserReport)
    ) {
      const targetNode = graph.getNode(event.nodeId);
      if (targetNode && targetNode.type === "activity") {
        const activityNode = targetNode as ActivityNode;
        requests.push({
          activityNodeId: activityNode.id,
          activityName: activityNode.name,
          originalTime: new Date(activityNode.scheduledTime).toISOString(),
          // Rebooking window anchored on the activity's own slot: earliest
          // alternative is the next day (weather window), latest is 48h out
          // (same deterministic bounds as the timing-driven path above).
          windowStart: new Date(activityNode.scheduledTime + 24 * 60 * 60 * 1000).toISOString(),
          windowEnd: new Date(activityNode.scheduledTime + 48 * 60 * 60 * 1000).toISOString(),
          weatherHint: finalWeatherHint,
          location: event.tripContext?.city,
          currency: event.tripContext?.currency,
        });
      }
    }

    if (requests.length === 0) return [];

    // W2 — smart day reorganization: a day carrying ≥2 timing-flagged
    // activities is resequenced as ONE unit by the DayReorganizer (Gemini
    // draft + hard validator, deterministic greedy fallback). Single-activity
    // days — and any day whose reorganization degrades to null — stay on the
    // legacy per-item ActivityAgent rail below.
    //
    // Review fix (weather indoor-swap preservation): rain/storm-hinted
    // requests NEVER enter a reorg bucket — the DayReorganizer only emits
    // retime/drop decisions and would silently kill the ActivityAgent's
    // swap-first indoor replacement behaviour. Those requests stay on the
    // legacy rail; the DayReorganizer remains the rail for timing-driven
    // (missed-flight / delay) multi-activity days.
    //
    // Bug fix (direct activity cancellation silently dropped): a cancelled
    // activity's synthesized request (above) asks for a slot 24-48h LATER —
    // a different day than `originalTime`. The DayReorganizer only resequences
    // ONE calendar day, so bucketing this request by `originalTime`'s date put
    // it in a same-day reorg it structurally cannot satisfy; the model had no
    // in-window slot to offer it, emitted no decision for it, and the item was
    // left silently unchanged in the itinerary — the traveler who reported it
    // cancelled saw a plan that talked about a DIFFERENT activity and never
    // mentioned the one they asked about. A cross-day window request goes to
    // the legacy per-item rail instead, which searches its own real window.
    if (this.dayReorganizer) {
      const byDay = new Map<string, ActivityRescheduleRequest[]>();
      const legacyRequests: ActivityRescheduleRequest[] = [];
      for (const request of requests) {
        const isCrossDayWindow =
          request.windowStart.slice(0, 10) !== request.originalTime.slice(0, 10);
        if (request.weatherHint === "rain" || request.weatherHint === "storm" || isCrossDayWindow) {
          legacyRequests.push(request);
          continue;
        }
        const date = request.originalTime.slice(0, 10);
        const bucket = byDay.get(date);
        if (bucket) bucket.push(request);
        else byDay.set(date, [request]);
      }
      const reorgProposals: ActivityRescheduleProposal[] = [];
      // Review fix (assess latency): the day groups are independent — run
      // their reorganizations CONCURRENTLY instead of sequentially awaiting
      // each (a Gemini draft can take up to its full deadline per day).
      // allSettled keeps one degraded day on the legacy rail without
      // disturbing its siblings, and map order keeps the output stable.
      const dayEntries = [...byDay.entries()];
      const outcomes = await Promise.allSettled(
        dayEntries.map(([date, dayRequests]) =>
          dayRequests.length >= 2
            ? this.runDayReorganization(
                date,
                dayRequests,
                constraints,
                newArrivalIso,
                graph,
                event.allowsActivityDrops === true,
              )
            : Promise.resolve(null),
        ),
      );
      outcomes.forEach((outcome, index) => {
        const [, dayRequests] = dayEntries[index];
        const proposals = outcome.status === "fulfilled" ? outcome.value : null;
        if (proposals !== null) {
          reorgProposals.push(...proposals);
        } else {
          legacyRequests.push(...dayRequests);
        }
      });
      if (reorgProposals.length > 0) {
        const legacyProposals =
          legacyRequests.length > 0
            ? await this.activityAgent.proposeRescheduling(legacyRequests)
            : [];
        return [...legacyProposals, ...reorgProposals];
      }
    }

    return await this.activityAgent.proposeRescheduling(requests);
  }

  /**
   * W2 — reorganize ONE day's timing-flagged activities as a unit. Builds
   * the {@link DayActivityInput} set from the graph (booked slot + duration;
   * coords when the node carries them), hands it to the DayReorganizer with
   * the new arrival floor and the traveler's stated priorities, and converts
   * the validated decisions into settlement-ready proposals via
   * {@link ActivityAgent.proposalsFromReorganization}. Returns `null` on ANY
   * shortfall (no reorganizer, malformed date, empty decisions, exception) —
   * the caller then routes that day's requests through the legacy rail.
   */
  private async runDayReorganization(
    date: string,
    dayRequests: ActivityRescheduleRequest[],
    constraints?: ResolutionConstraints,
    newArrivalIso?: string,
    /** Task 20 (additive): the graph the day's nodes live in — the live
     *  graph by default; a rederive walk passes its own clone. */
    graph: ItineraryGraph = this.graph,
    /** The mission asked for a lighter day — see `allowsActivityDrops`. */
    allowDrops = false,
  ): Promise<ActivityRescheduleProposal[] | null> {
    if (!this.dayReorganizer || !this.activityAgent) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    try {
      const activities: DayActivityInput[] = dayRequests.map((request) => {
        const node = graph.getNode(request.activityNodeId);
        const durationMinutes =
          node && node.type === "activity" ? (node as ActivityNode).durationMinutes : undefined;
        return {
          nodeId: request.activityNodeId,
          name: request.activityName,
          time: request.originalTime,
          // Frozen demo graph nodes carry no duration — the reorganizer's own
          // 90-minute planning convention fills the gap deterministically.
          durationMinutes: durationMinutes ?? 90,
        };
      });
      const outcome = await this.dayReorganizer.reorganizeDay({
        date,
        activities,
        ...(newArrivalIso !== undefined ? { newArrivalTime: newArrivalIso } : {}),
        ...(constraints?.activity_priority !== undefined
          ? { priorityName: constraints.activity_priority }
          : {}),
        ...(constraints?.notes !== undefined ? { notes: constraints.notes } : {}),
        ...(allowDrops ? { allowDiscretionaryDrops: true } : {}),
      });
      if (outcome.decisions.length === 0) return null;
      return await this.activityAgent.proposalsFromReorganization(outcome.decisions, {
        activities,
        location: dayRequests[0]?.location,
        currency: dayRequests[0]?.currency,
        reorgSource: outcome.source,
        // Task 21 (additive): thread the Gemini degrade classify to the
        // proposals so hackathonApi can emit `activity/gemini_degraded`.
        ...(outcome.degradeReason !== undefined
          ? { reorgDegradeReason: outcome.degradeReason }
          : {}),
        ...(outcome.degradeDetail !== undefined
          ? { reorgDegradeDetail: outcome.degradeDetail }
          : {}),
      });
    } catch (error) {
      console.error("[orchestrator] day reorganization degraded — legacy rail", error);
      return null;
    }
  }

  private buildProposedResolution(
    event: DisruptionEvent,
    chosen: RebookingCandidate | null,
    context: {
      hotelAdjustments: HotelAdjustment[];
      activityProposals: ActivityRescheduleProposal[];
      policyVerdict: FarePolicyVerdict | null;
      spatialTransferReport: AffectedNodeReport | null;
    },
  ): ProposedResolution {
    const best = chosen;

    // Real ActivityAgent output replaces the former `rescheduledActivities=[]`
    // mock: one entry per proposal, labelled with the itinerary node name.
    const rescheduledActivities: RescheduledActivityProposal[] = context.activityProposals.map(
      (proposal) => {
        const node = this.graph.getNode(proposal.activityNodeId);
        const name = node && node.type === "activity" ? node.name : proposal.activityNodeId;
        const originalIso = node ? new Date(node.scheduledTime).toISOString() : proposal.newTime;
        // W2 drop rows: cancelled out of the day — no slot, no move arrow.
        // `new_time` keeps its frozen string type ("Cancelled"); the additive
        // `action` marker tells clients to render a cancelled row.
        const dropped = proposal.action === "drop";
        return {
          name,
          new_time: dropped ? "Cancelled" : formatNewTime(originalIso, proposal.newTime),
          penalty: proposal.penalty,
          // Additive (Phase B): machine-readable companion to `new_time` plus
          // the penalty rationale (e.g. the within-24h change-fee reasoning).
          ...(dropped ? {} : { new_time_iso: proposal.newTime }),
          ...(proposal.rationale ? { reason: proposal.rationale } : {}),
          ...(proposal.action !== undefined ? { action: proposal.action } : {}),
        };
      },
    );

    const proposed: ProposedResolution = best
      ? {
          new_flight: {
            id: best.option.id,
            cost: best.option.price,
            // Additive display enrichment (Phase B) — straight from the
            // chosen FlightOption; feeds the approval sheet + map points.
            origin: best.option.origin,
            destination: best.option.destination,
            airline: best.option.airline,
            departure: best.option.departureTime,
            arrival: best.option.arrivalTime,
            currency: best.option.currency,
            // Additive (trust-layer quality pass): the marketing flight
            // number, so the settled recap can render "Vueling 8243 · …"
            // instead of the opaque provider routing identifier.
            flight_number: best.option.flightNumber,
            // How the price was established — the approval sheet badges an
            // estimate, and the settlement never books one.
            fare_basis: fareBasisOf(best),
            // Additive comparison facts: emitted only when the provider
            // described the segments, so the card never claims "Non-stop"
            // about a routing it could not read.
            ...(typeof best.option.stops === "number" && Number.isFinite(best.option.stops)
              ? { stops: best.option.stops }
              : {}),
            ...(typeof best.option.durationMinutes === "number" &&
            Number.isFinite(best.option.durationMinutes)
              ? { durationMinutes: best.option.durationMinutes }
              : {}),
            ...(Array.isArray(best.option.stopAirports) && best.option.stopAirports.length > 0
              ? { stopAirports: [...best.option.stopAirports] }
              : {}),
            // The hops themselves, so the settlement can write a routing the
            // traveller can open rather than a bare count.
            ...(Array.isArray(best.option.segments) && best.option.segments.length > 0
              ? {
                  segments: best.option.segments.map((segment) => ({
                    ...(segment.carrier !== undefined ? { carrier: segment.carrier } : {}),
                    ...(segment.flightNumber !== undefined
                      ? { reference: segment.flightNumber }
                      : {}),
                    from: segment.origin,
                    to: segment.destination,
                    depart: segment.departureTime,
                    arrive: segment.arrivalTime,
                  })),
                }
              : {}),
          },
          rescheduled_activities: rescheduledActivities,
        }
      : {
          rescheduled_activities: rescheduledActivities,
        };

    // Spec §3.4: hotel deltas are omitted when nothing is impacted.
    if (context.hotelAdjustments.length > 0) {
      proposed.hotel_adjustments = context.hotelAdjustments;
    }
    if (context.policyVerdict) {
      proposed.policy_verdict = {
        rebookPermitted: context.policyVerdict.rebookPermitted,
        changeFee: context.policyVerdict.changeFee,
        recommendedAction: context.policyVerdict.recommendedAction,
        ...(context.policyVerdict.billedCurrency !== undefined
          ? {
              billedChangeFee: context.policyVerdict.billedChangeFee,
              billedCurrency: context.policyVerdict.billedCurrency,
            }
          : {}),
        noShowApplied: context.policyVerdict.noShowRule.applies,
        // Additive: the currency `changeFee` is quoted in (presentation +
        // ledger bucket selection).
        ...(context.policyVerdict.currency !== undefined
          ? { currency: context.policyVerdict.currency }
          : {}),
      };
    }
    if (context.spatialTransferReport) {
      // Spec §2.4 — surface the deterministic ride re-quote on the approval
      // card: from the NEW arrival airport to the transfer's original pickup.
      const transferNode = this.graph.getNode(context.spatialTransferReport.nodeId);
      const pickupLocationId =
        transferNode && transferNode.type === "transfer"
          ? (transferNode.pickupLocationId ?? "")
          : "";
      const newFlightDestination = chosen?.option.destination ?? "";
      const requote: TransferRequote = {
        amount: TRANSFER_REQUOTE_CHARGE,
        from: newFlightDestination,
        to: pickupLocationId,
        reason: context.spatialTransferReport.reason,
      };
      proposed.transfer_requote = requote;
    }
    return proposed;
  }

  /**
   * Spec §3.4 ledger — every agent feeds one bookkeeping rule, segregated
   * PER CURRENCY (segregation, NOT conversion — no amount is ever silently
   * mixed across currencies):
   *   fare term          → fare.currency (its own bucket when foreign)
   *   policy change fee  → policyVerdict.currency ?? ledgerCurrency
   *   hotel / activity / transfer re-quote → ledgerCurrency
   *
   * Additive `by_currency` exposes one `{ currency, total_refund,
   * total_new_charges, net_payable }` bucket per currency (ledgerCurrency
   * bucket first when present, the rest alphabetical); the invariant
   * `net_payable === total_new_charges - total_refund` holds PER bucket.
   *
   * Legacy contract kept: `total_refund/total_new_charges/net_payable` are
   * the ledgerCurrency bucket (all zero when that bucket has no terms).
   */
  private buildFinancialDelta(
    chosen: RebookingCandidate | null,
    context: {
      policyVerdict: FarePolicyVerdict | null;
      hotelAdjustments: HotelAdjustment[];
      activityProposals: ActivityRescheduleProposal[];
      rebooked: boolean;
      transferRequote: boolean;
    },
    ledgerCurrency: string,
    /** The currency the confirm screen is denominated in — the traveller's own
     *  preference when the client sent one, else the trip's. */
    displayCurrency: string = ledgerCurrency,
  ): FinancialDelta {
    const fare = chosen?.fareDifference ?? null;

    const buckets = new Map<string, { charges: number; refund: number }>();
    const bucketOf = (currency: string): { charges: number; refund: number } => {
      let bucket = buckets.get(currency);
      if (!bucket) {
        bucket = { charges: 0, refund: 0 };
        buckets.set(currency, bucket);
      }
      return bucket;
    };

    if (fare) {
      const bucket = bucketOf(fare.currency);
      if (fare.direction === "refund") bucket.refund += fare.amount;
      else bucket.charges += fare.amount;
    }

    // Policy change fee applies only when a flight change is actually
    // proposed (a denied or unused rebooking incurs no change fee). Its
    // currency comes from the verdict itself, falling back to the ledger's.
    if (context.rebooked && context.policyVerdict) {
      const bucket = bucketOf(context.policyVerdict.currency ?? ledgerCurrency);
      bucket.charges += Math.max(0, context.policyVerdict.changeFee);
    }

    // Local-service terms are always quoted in the ledger currency.
    const ledgerBucket = bucketOf(ledgerCurrency);
    for (const adjustment of context.hotelAdjustments) {
      ledgerBucket.charges += Math.max(0, adjustment.fee);
    }
    for (const proposal of context.activityProposals) {
      ledgerBucket.charges += Math.max(0, proposal.penalty);
      if (proposal.swap) {
        ledgerBucket.charges += Math.max(0, proposal.swap.priceDelta);
      }
    }

    // Spec §2.4 — transfer re-quote ledger term: a spatial mismatch on an
    // impacted transfer adds the deterministic ride re-quote to the charges
    // (mirrored in proposed_resolution.transfer_requote), so the frozen
    // net_payable === total_new_charges - total_refund invariant holds.
    if (context.transferRequote) {
      ledgerBucket.charges += TRANSFER_REQUOTE_CHARGE;
    }

    const round2 = (value: number) => Math.round(value * 100) / 100;
    // Drop buckets with no terms. `bucketOf(ledgerCurrency)` is created
    // unconditionally for the local-service terms, so a trip whose ledger
    // currency carries none (a JPY trip rebooked on a USD fare with a EUR
    // change fee) emitted an all-zero JPY bucket — and since the legacy
    // scalars ARE the ledger bucket, `net_payable` then read 0 while the
    // traveller genuinely owed $454.55 + €25.00.
    const byCurrency = [...buckets.entries()]
      .filter(([, bucket]) => round2(bucket.charges) !== 0 || round2(bucket.refund) !== 0)
      .map(([currency, bucket]) => {
        const charges = round2(bucket.charges);
        const refund = round2(bucket.refund);
        return {
          currency,
          total_refund: refund,
          total_new_charges: charges,
          net_payable: round2(charges - refund),
        };
      });
    // Deterministic order: the ledger-currency bucket first when present,
    // remaining currencies alphabetically.
    byCurrency.sort((a, b) => {
      if (a.currency === ledgerCurrency) return -1;
      if (b.currency === ledgerCurrency) return 1;
      return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
    });

    // The single-currency view the traveller actually reads. Converting is not
    // a rounding convenience: the flat fields below are only the ledger-currency
    // bucket, so a JPY trip rebooked on a USD fare showed a large refund and NO
    // price for the replacement — the charge sat in a bucket nothing displayed.
    //
    // Conversion goes through the app's own EUR rate table, the same one the
    // timeline and budget use, so a converted change fee cannot drift from the
    // rest of the trip.
    const toDisplay = (amount: number, from: string): number => {
      if (from === displayCurrency) return amount;
      const fromRate = rateFromEurOf(from as Currency);
      const toRate = rateFromEurOf(displayCurrency as Currency);
      if (!(fromRate > 0) || !(toRate > 0)) return amount;
      return (amount / fromRate) * toRate;
    };
    let displayRefund = 0;
    let displayCharges = 0;
    let converted = false;
    for (const bucket of byCurrency) {
      if (bucket.currency !== displayCurrency) converted = true;
      displayRefund += toDisplay(bucket.total_refund, bucket.currency);
      displayCharges += toDisplay(bucket.total_new_charges, bucket.currency);
    }
    const display = {
      currency: displayCurrency,
      total_refund: round2(displayRefund),
      total_new_charges: round2(displayCharges),
      net_payable: round2(round2(displayCharges) - round2(displayRefund)),
      converted,
    };

    // Legacy fields = the ledgerCurrency bucket (zeros when absent).
    const ledger = byCurrency.find((entry) => entry.currency === ledgerCurrency);
    return {
      total_refund: ledger?.total_refund ?? 0,
      total_new_charges: ledger?.total_new_charges ?? 0,
      net_payable: ledger?.net_payable ?? 0,
      by_currency: byCurrency,
      ...(byCurrency.length > 0 ? { display } : {}),
    };
  }
}
