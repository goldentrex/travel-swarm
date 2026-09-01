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
import { ItineraryGraph, evaluateTripConsequence } from "@/core/dag";
import type {
  FlightAgent,
  FlightRebookingAssessment,
  NoReplacementReason,
  RebookingCandidate,
} from "@/agents/flight/FlightAgent";
import { MAX_REBOOKING_WINDOW_HOURS } from "@/agents/flight/FlightAgent";
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
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(city)}&format=json&limit=1`,
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

export function nonDominatedCandidates(candidates: RebookingCandidate[]): RebookingCandidate[] {
  return candidates.filter((b) => {
    const chargeB = candidateNetCharge(b);
    const arrivalB = candidateArrivalMs(b);
    return !candidates.some((a) => {
      if (a === b) return false;
      if (a.fareDifference.currency !== b.fareDifference.currency) return false;
      // Next-day departures are never dominated by same-route earlier days.
      if (sameUtcDay(a.option.departureTime, b.option.departureTime) === false) return false;
      const chargeA = candidateNetCharge(a);
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
): { candidates: RebookingCandidate[]; notes: string[] } {
  const notes: string[] = [];
  let pool = [...candidates];
  if (constraints?.max_price !== undefined && pool.length > 0) {
    const ceiling = constraints.max_price;
    const within = pool.filter((candidate) => candidateNetCharge(candidate) <= ceiling);
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
  if (
    (constraints?.prefer_direct === true || constraints?.prefer_nonstop === true) &&
    pool.length > 0
  ) {
    const direct = pool.filter(isDirectCandidate);
    if (direct.length > 0 && direct.length < pool.length) {
      notes.push(`prefer_direct — kept ${direct.length} non-stop candidate(s)`);
      pool = direct;
    }
  }
  // Pareto frontier BEFORE selection: an option that is costlier AND later
  // than another same-currency option is never offered.
  const frontier = nonDominatedCandidates(pool);
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
): { ordered: RebookingCandidate[]; notes: string[] } {
  const { candidates: pool, notes } = applyConstraintsToCandidates(candidates, constraints);
  const base = [...pool].sort(
    (a, b) =>
      candidateNetCharge(a) - candidateNetCharge(b) ||
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

  let ordered = base;
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
  ) {}

  // Task 20 — rederive context captured by runDisruptionPipeline: the
  // untouched baseline graph, the disruption event and the nominal delay.
  // The orchestrator is constructed once per mission and the pipeline runs
  // once per call, so these fields unambiguously describe the last run.
  private redriveBaseline: ItineraryGraph | null = null;
  private redriveEvent: DisruptionEvent | null = null;
  private redriveNominalMinutes: number | null = null;

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
    // ONE timestamp for every plan assembled below: the per-plan TTL stamps
    // must be identical so the canonical-JSON dedup can collapse profiles
    // that select the same candidate (a ticking millisecond clock between
    // loop iterations would otherwise serialize them differently).
    const now = Date.now();

    // ── Hotel constraint: drop booking-preserving adjustments on request ──
    let hotelAdjustments = pipeline.hotelAdjustments;
    if (constraints?.keep_hotel === false && hotelAdjustments.length > 0) {
      const kept = hotelAdjustments.filter((adjustment) => adjustment.action === "rebook");
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
    const { candidates: constrained, notes: filterNotes } = applyConstraintsToCandidates(
      rawCandidates,
      constraints,
    );
    trace.push(...filterNotes);

    // ── Coherence gate: does the traveller still HAVE a trip on arrival? ───
    //
    // A departure ceiling stops the absurd cases; this catches the ones inside
    // it that are still not solutions. If a replacement lands after everything
    // left in the itinerary, the traveller would fly out to a holiday that has
    // already finished. That is not a cheaper plan, it is a different (empty)
    // trip, and offering it as a rebooking is the failure this whole pass
    // exists to end.
    //
    // Deliberately NOT covered by the "never offer nothing" rule that governs
    // max_price: when every candidate lands too late, the honest output is the
    // flight-less plan the degraded rail already produces — it says plainly
    // that no replacement was found and the trip needs replanning.
    const disruptedNodeId = pipeline.source?.id;
    const disruptedDepartureMs =
      pipeline.source && pipeline.source.type === "flight"
        ? pipeline.source.scheduledTime
        : undefined;
    let candidates = constrained;
    if (disruptedDepartureMs !== undefined && constrained.length > 0) {
      const survivors = constrained.filter((candidate) => {
        const arrivalMs = Date.parse(candidate.option.arrivalTime);
        if (!Number.isFinite(arrivalMs)) return true;
        // `pipeline.baseline`, NOT the live graph: by this point the live
        // graph has already absorbed a propagation, and a previous candidate's
        // simulation has re-timed the hotel to match ITS late arrival. Asking
        // the mutated graph what a late arrival costs gets the answer "nothing"
        // — it has already moved the trip to fit.
        return !evaluateTripConsequence(
          pipeline.baseline,
          arrivalMs,
          disruptedDepartureMs,
          disruptedNodeId,
        ).arrivesAfterTripEnds;
      });
      const dropped = constrained.length - survivors.length;
      if (dropped > 0) {
        trace.push(
          `dropped ${dropped} replacement${dropped > 1 ? "s" : ""} landing after the rest of the trip is over`,
        );
      }
      candidates = survivors;
    }

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
      );
      trace.push(...notes);
      // Tag derivation (frozen badge order): cheapest = unique min net,
      // fastest = unique min arrival, nonstop from the stops probe, and
      // same_day/next_day measured against the flight's TRUE original
      // departure. The PRIMARY badge is the first tag; "balanced" is only
      // the honest no-tag fallback.
      const byNet = [...ordered].sort(
        (a, b) =>
          candidateNetCharge(a) - candidateNetCharge(b) ||
          candidateArrivalMs(a) - candidateArrivalMs(b) ||
          a.option.id.localeCompare(b.option.id),
      );
      const byArrival = [...ordered].sort(
        (a, b) =>
          candidateArrivalMs(a) - candidateArrivalMs(b) ||
          candidateNetCharge(a) - candidateNetCharge(b) ||
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
        rederivedByArrival.set(arrivalIso, proposals);
      }
      return proposals;
    };

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
      const plan = this.assembleResolutionPlan(event, pipeline, chosen, {
        hotelAdjustments,
        includeTransferRequote,
        stampMs: now,
        ...(selectionProposals !== undefined ? { activityProposals: selectionProposals } : {}),
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
      plans.push({ ...plan, badge, ...(badges !== undefined ? { badges } : {}) });
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
        hotelAdjustments,
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
    if (source && source.type === "flight") {
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
        const departureIsPast = source.departureTime < Date.now();
        const nextDayUtc = (() => {
          const now = new Date();
          return new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
          ).toISOString();
        })();
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
        let earliestDepartureIso = originalDepartureIso;
        if (constraints?.min_departure_delay_hours !== undefined) {
          const delayMs = Date.now() + constraints.min_departure_delay_hours * 3600_000;
          const originalMs = Date.parse(originalDepartureIso);
          earliestDepartureIso = new Date(Math.max(delayMs, originalMs)).toISOString();
        }

        const routeContext: FlightRouteContext = {
          origin: source.origin,
          destination: source.destination,
          departureDate: departureIsPast ? nextDayUtc : newTime,
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
          // Keep the traveller in the cabin they booked — searching economy
          // for a business ticket is a downgrade, and prices the delta
          // against the wrong product.
          ...(source.cabin !== undefined ? { cabin: source.cabin } : {}),
          // Never offer the disrupted departure back as its own replacement —
          // anchored on the flight's TRUE original departure (see above).
          excludeFlight: {
            flightNumber: source.flightNumber,
            departureTime: originalDepartureIso,
          },
          // Nothing at or before the ORIGINAL departure is ever a usable
          // replacement, in ANY disruption flavor: whatever triggered this
          // search, the itinerary as booked is already compromised, so an
          // option that would have needed to leave earlier than (or exactly
          // when) the traveler's own flight offers nothing. Unconditional —
          // it no longer depends on classifying "missed" vs. "delayed", which
          // is what let this floor go silently unset for the explicit-node
          // mission path.
          earliestDeparture: earliestDepartureIso,
          // …and the CEILING, measured from the departure that was lost. The
          // floor alone let a rebooking land arbitrarily far in the future:
          // the first real user test produced a replacement FIVE DAYS after the
          // flight the traveller missed, as the leading plan, because it was
          // the cheapest option that happened to depart "after" the original.
          // Past this horizon the honest answer is that no rebooking works.
          latestDeparture: new Date(
            Date.parse(originalDepartureIso) + MAX_REBOOKING_WINDOW_HOURS * 3600_000,
          ).toISOString(),
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
          const realRule = rebookingAssessment?.bestCandidate?.option.fareRule;
          if (this.policyAgent && realRule && Object.keys(realRule).length > 0) {
            const departureBasis = originalDepartureTime ?? source.departureTime;
            policyVerdict = await this.policyAgent.assessFarePolicy({
              originalFlightId: source.id,
              rule: realRule,
              minutesToDeparture: Math.max(
                0,
                Math.round((departureBasis - Date.now()) / 60_000),
              ),
              disruptionKind: classifyDisruptionKind(event.description),
              // One currency in the money panel: the fee follows the ticket it
              // applies to whenever the rule itself names none.
              fallbackCurrency: rebookingAssessment?.bestCandidate?.option.currency,
            });
            if (policyVerdict) {
              policyVerdict.ruleSource = "provider_published";
              // One currency in the money panel. A carrier may publish its
              // rules in its own currency (VietJet quotes VND against a USD
              // fare, which put "+VND 1100000" beside "$5.39" in one ledger).
              // Convert through the SAME EUR rate table the timeline, budget
              // and PDF use — never a rate invented here — and keep what the
              // carrier will actually bill alongside it.
              const fareCurrency = rebookingAssessment?.bestCandidate?.option.currency;
              if (
                fareCurrency &&
                policyVerdict.changeFee > 0 &&
                policyVerdict.currency !== fareCurrency
              ) {
                const from = rateFromEurOf(policyVerdict.currency as Currency);
                const to = rateFromEurOf(fareCurrency as Currency);
                if (from > 0 && to > 0) {
                  policyVerdict.billedChangeFee = policyVerdict.changeFee;
                  policyVerdict.billedCurrency = policyVerdict.currency;
                  policyVerdict.changeFee =
                    Math.round(((policyVerdict.changeFee / from) * to + Number.EPSILON) * 100) / 100;
                  policyVerdict.currency = fareCurrency;
                }
              }
            }
          }

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
      this.assessHotels(disruption, event.description),
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
    },
  ): ResolutionPlan {
    const spatialTransferReport = options.includeTransferRequote
      ? pipeline.spatialTransferReport
      : null;
    // Task 25 (#1): body derives from the per-selection proposal set when
    // supplied, otherwise from the shared pipeline walk.
    const activityProposals = options.activityProposals ?? pipeline.activityProposals;

    const proposedResolution = this.buildProposedResolution(event, chosen, {
      hotelAdjustments: options.hotelAdjustments,
      activityProposals,
      policyVerdict: pipeline.policyVerdict,
      spatialTransferReport,
    });
    const financialDelta = this.buildFinancialDelta(
      chosen,
      {
        policyVerdict: pipeline.policyVerdict,
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
  ): Promise<HotelAdjustment[]> {
    if (!this.hotelAgent) return [];
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
      const isOverbooked =
        report.nodeId === disruption.sourceNodeId && /overbook/i.test(intentDesc);
      const assessment = await this.hotelAgent.assessHotelImpact({
        hotelNodeId: hotelNode.id,
        hotelName: hotelNode.hotelName,
        originalCheckIn: new Date(report.previousScheduledTime).toISOString(),
        shiftedCheckIn: new Date(shiftedMs).toISOString(),
        guests: 1,
        isOverbooked: isOverbooked,
      });
      // Additive (Phase B): surface the best alternative room (when the
      // provider found one) as display-only presentation feed.
      const bestAlternative = assessment.alternativeRooms[0];
      adjustments.push({
        hotel_name: hotelNode.hotelName,
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
  private async proposeActivityRescheduling(
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

    // W2: whether the impact surface produced ANY timing-disrupted activity
    // BEFORE the day reorganizer (below) may consume them — the proactive
    // synthesis block must gate on the ORIGINAL state so a reorg that eats
    // every request never silently triggers proactive synthesis.
    const hadInitialRequests = requests.length > 0;

    const isActivityCancellation =
      event.origin === "reactive" && classifyDisruptionKind(event.description) === "cancellation";

    let finalWeatherHint = weatherHintFromEvent(event);
    let eventTitle = event.description;

    // Actually check OpenWeather and PredictHQ if this is a proactive simulation
    if (event.origin === "proactive") {
      const city = event.tripContext?.city;
      if (city) {
        const coords = await geocodeCity(city);
        if (coords) {
          if (event.evidence?.kind === "weather" && this.weatherProvider) {
            const forecast = await this.weatherProvider.getRainForecast(coords.lat, coords.lng, 48);
            if (forecast.windows.length === 0) {
              // No rain expected in reality!
              eventTitle = `Real weather checked for ${city}: clear skies!`;
              return []; // Empty requests means no adjustments
            } else {
              eventTitle = `Confirmed rain in ${city}: adapting itinerary`;
              finalWeatherHint = "rain";
            }
          } else if (event.evidence?.kind === "event" && this.eventProvider) {
            // It's a strike/event alert, check PredictHQ
            const events = await this.eventProvider.findDisruptiveEvents({
              latitude: coords.lat,
              longitude: coords.lng,
              radiusKm: 25,
              from: new Date().toISOString(),
              to: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
            });
            if (events.events.length === 0) {
              eventTitle = `Real event check for ${city}: no disruptions found!`;
              return [];
            } else {
              eventTitle = `Confirmed disruption: ${events.events[0].name}`;
            }
          }
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
    if (
      !hadInitialRequests &&
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
    if (this.dayReorganizer) {
      const byDay = new Map<string, ActivityRescheduleRequest[]>();
      const legacyRequests: ActivityRescheduleRequest[] = [];
      for (const request of requests) {
        if (request.weatherHint === "rain" || request.weatherHint === "storm") {
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
