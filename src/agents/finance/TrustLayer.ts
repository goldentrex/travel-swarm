/**
 * TrustLayer — the human-in-the-loop trust boundary for money & bookings.
 *
 * HARD RULE: financial and booking actions are NEVER executed from free-form
 * model text. The AI must emit a deterministic `ResolutionPlan` JSON matching
 * the exact schema below, and a human explicitly approves it before any
 * provider call (booking, refund, charge) is allowed.
 *
 * The schema is intentionally flat and JSON-friendly so the same payload can
 * be rendered as an approval card, logged for audit, and re-parsed on the
 * server with {@link validateResolutionPlan}.
 *
 * No third-party validation libraries — runtime checks are hand-rolled and
 * deterministic below.
 */

/** Plain-text incident summary, e.g. "Flight XY123 delayed by 4h". */
export type Incident = string;

/** Display labels of itinerary nodes impacted by the incident. */
export type ImpactedNodes = string[];

/** The replacement flight being proposed (id from the provider, cost in the trip currency). */
export interface ProposedNewFlight {
  id: string;
  cost: number;
  /** NEW (additive display enrichment) — IATA origin of the replacement leg. */
  origin?: string;
  /** NEW — IATA destination of the replacement leg. */
  destination?: string;
  /** NEW — operating carrier label. */
  airline?: string;
  /** NEW — ISO-8601 departure of the replacement leg. */
  departure?: string;
  /** NEW — ISO-8601 arrival of the replacement leg. */
  arrival?: string;
  /** NEW — ISO-4217 currency `cost` is quoted in. */
  currency?: string;
  /**
   * NEW (additive, trust-layer quality pass) — the marketing flight number
   * (e.g. "8243"), so the settled recap can render "Vueling 8243 · CDG →
   * FCO" instead of the opaque provider routing identifier.
   */
  flight_number?: string;
  /**
   * NEW (additive, at-a-glance comparison) — stop count of the replacement
   * leg: 0 renders "Non-stop". Absent when the provider did not describe the
   * segments, so the card stays silent instead of guessing.
   */
  stops?: number;
  /** NEW (additive) — total travel time in minutes, departure to arrival. */
  durationMinutes?: number;
  /** NEW (additive) — IATA layover airports, in order ("via MAD"). */
  stopAirports?: string[];
  /**
   * NEW (additive) — the replacement journey hop by hop. Carried so the
   * settlement can write it onto the leg: the trip document treats segments as
   * the AUTHORITY on the routing, so a leg rewritten to a new flight while
   * keeping its old segments would describe the previous journey.
   */
  segments?: NewFlightSegment[];
  /**
   * NEW (additive) — how `cost` was established, carried from the FlightAgent's
   * `FareDifference.basis`. `verified` = re-priced by the provider;
   * `search_reference` = the search's published price, not yet re-verified;
   * `synthetic_estimate` = the zero-abort ladder's indicative schedule, which
   * no provider sold. Absent on legacy plans (read as provider-backed). The
   * approval sheet badges anything but `verified`, and the settlement never
   * records a synthetic estimate as a booking.
   */
  fare_basis?: FareBasis;
}

export type FareBasis = "verified" | "search_reference" | "synthetic_estimate";

/** One hop of a replacement flight, as stored on the leg. */
export interface NewFlightSegment {
  carrier?: string;
  reference?: string;
  from?: string;
  to?: string;
  depart?: string;
  arrive?: string;
}

/** One activity moved to a new slot, with its cancellation/change penalty. */
export interface RescheduledActivityProposal {
  name: string;
  /** Human-readable new slot, e.g. "Tomorrow 10 AM". */
  new_time: string;
  penalty: number;
  /** NEW (additive) — machine-readable ISO-8601 companion to `new_time`. */
  new_time_iso?: string;
  /** NEW (additive) — penalty rationale, e.g. the within-24h change-fee reasoning. */
  reason?: string;
  /**
   * NEW (W2, additive) — what happened to this activity. Absent = legacy
   * move (renders exactly as before). `"drop"` = cancelled out of the day
   * by the smart day reorganization — clients render it as a cancelled row
   * (no move arrow); `new_time` carries no slot semantics in that case.
   */
  action?: "reschedule" | "swap" | "drop";
}

/**
 * Additive presentation feed surfaced by the HotelAgent when it found a
 * replacement room (rebook path). Every field is optional — display only,
 * never part of the ledger math.
 */
export interface HotelAlternative {
  name?: string;
  ratePerNight?: number;
  currency?: string;
  freeCancellationUntil?: string;
  lat?: number;
  lng?: number;
  images?: string[];
}

/**
 * Hotel-side adjustment produced by the HotelAgent (spec §3.4). Optional on
 * {@link ProposedResolution}: omit or `[]` when no hotel is impacted.
 */
export interface HotelAdjustment {
  /** No hotel action/fee is confirmed while this is true. */
  requires_confirmation?: boolean;
  note?: string;
  hotel_name: string;
  action: "late_check_in" | "rebook" | "none";
  /** Verified fee; zero with requires_confirmation means no verified charge yet. */
  fee: number;
  /** NEW (additive) — best alternative room, feeds the presentation layer. */
  alternative?: HotelAlternative;
  /**
   * NEW (additive) — booked nights the traveller will NOT use, because the
   * replacement flight lands on a later date. Disclosure only: it carries no
   * money (the property's terms for an unused night are unknown to us, and
   * inventing them would break the ledger's honesty rule), and the traveller
   * gets a `confirm_unused_night` follow-up to settle it with the hotel.
   */
  nights_unstayed?: number;
}

/**
 * Audit surface of the PolicyAgent gate (spec §3.4). Display/audit only —
 * money math flows exclusively through `financial_delta` and the ledger rule
 * (fare charge + changeFee + Σ hotel fees + Σ activity penalties/swap deltas).
 */
export interface PolicyVerdictSummary {
  rebookPermitted: boolean;
  changeFee: number;
  recommendedAction: "rebook" | "keep_and_wait" | "refund_and_rebook";
  noShowApplied: boolean;
  /** NEW (additive) — ISO-4217 currency `changeFee` is quoted in. */
  currency?: string;
  /**
   * NEW (additive) — set when `changeFee` is a CONVERSION into the ticket's
   * currency (the carrier published its rule in another one). These carry what
   * the carrier will actually bill, so the panel can read in one currency
   * without hiding the real charge.
   */
  billedChangeFee?: number;
  billedCurrency?: string;
}

/**
 * Transfer re-quote ledger line (spec §2.4). Emitted when a spatial mismatch
 * (rebooked flight lands at a different airport) forces the ride to be
 * re-quoted. Its `amount` is folded into `financial_delta.total_new_charges`
 * by the orchestrator — the invariant `net_payable === total_new_charges -
 * total_refund` still holds.
 */
export interface TransferRequote {
  /** Deterministic re-quote charge, >= 0. */
  amount: number;
  /** New arrival location the ride must now start from (e.g. "OPO"). */
  from: string;
  /** Original pickup location of the disrupted transfer (e.g. "LIS"). */
  to: string;
  /** The spatial-conflict justification surfaced by the DAG. */
  reason: string;
}

export interface ProposedResolution {
  new_flight?: ProposedNewFlight;
  rescheduled_activities: RescheduledActivityProposal[];
  /** NEW (spec §3.4) — omit or [] when no hotel is impacted. */
  hotel_adjustments?: HotelAdjustment[];
  /** NEW (spec §3.4) — PolicyAgent gate audit surface. */
  policy_verdict?: PolicyVerdictSummary;
  /** NEW (spec §2.4) — transfer re-quote on spatial mismatch; omit otherwise. */
  transfer_requote?: TransferRequote;
}

/**
 * Net money movement of the whole plan. Deterministic invariant enforced by
 * {@link validateResolutionPlan}: `net_payable === total_new_charges - total_refund`.
 *
 * Additive `by_currency` segregates the ledger per currency (never
 * converted/mixed): one bucket per currency, each holding the SAME
 * invariant. The legacy top-level triple is the plan-currency bucket
 * (zeros when that bucket carries no terms). Absent on pre-extension plans
 * — the validator treats a missing field as valid.
 */
export interface FinancialDelta {
  total_refund: number;
  total_new_charges: number;
  net_payable: number;
  by_currency?: Array<{
    currency: string;
    total_refund: number;
    total_new_charges: number;
    net_payable: number;
  }>;
  /**
   * The WHOLE ledger in one currency — what the traveller actually reads.
   *
   * `by_currency` is the truthful record: a fare quoted in USD and a change
   * fee billed in EUR really are two different currencies, and collapsing them
   * would be a lie about what the providers said. But it is unreadable as a
   * decision. Worse, the flat fields above are only the TRIP-currency bucket,
   * so a JPY trip rebooked on a USD fare showed the traveller a large refund
   * and NO price for the replacement flight — the charge existed, in a bucket
   * the panel never displayed.
   *
   * This is the same ledger converted at today's rate into a single currency,
   * with `converted` set whenever a rate was applied, so the panel can say so
   * rather than passing a conversion off as a provider quote.
   */
  display?: {
    currency: string;
    total_refund: number;
    total_new_charges: number;
    net_payable: number;
    /** True when at least one term was converted from another currency. */
    converted: boolean;
  };
}

/**
 * Additive operational layer attached to a plan once a mission ran against a
 * HYDRATED real trip: tells the settlement step exactly which content_json
 * entries to rewrite (disrupted transit leg, activity moves, hotel actions).
 * Optional — demo-graph plans and pre-extension plans never carry it, and the
 * validator treats an absent field as valid.
 */
export interface OperationalSettlement {
  /** The disrupted graph node the mission targeted. */
  disrupted: { nodeId: string; kind: string; label: string };
  /** Replacement flight chosen by the FlightAgent (ISO timestamps). */
  new_flight?: { reference: string; depart: string; arrive: string; carrier?: string };
  /** Activity re-times / swaps proposed by the ActivityAgent. */
  activity_moves?: Array<{
    nodeId: string;
    newTime: string;
    replacementName?: string;
    viatorProductCode?: string;
    /**
     * NEW (W2, additive) — drop marker: the settlement splices this item
     * out of the day WITHOUT re-append (cancellation). `newTime` stays the
     * activity's original slot so the frozen shape keeps validating.
     */
    drop?: boolean;
    /** NEW (W2, additive) — change-line text for a drop (settlement uses a
     *  policy-grounded default when absent). */
    cancellationNote?: string;
  }>;
  /** Hotel protections (late check-in / rebook) with the shifted check-in. */
  hotel_actions?: Array<{ nodeId: string; action: string; note: string; newCheckIn?: string }>;
  /** Confirmation code the settlement stamps on the rewritten flight leg. */
  bookingCode?: string;
  /**
   * NEW (additive) — what the provider actually did with the replacement,
   * known because approval books BEFORE it writes the trip. `confirmed` = a
   * provider order; `recorded` = no provider confirmation (unconfigured,
   * failed, or an indicative option). Absent on direct/legacy settlements,
   * which keep the previous behaviour.
   */
  booking_status?: "confirmed" | "recorded";
}

/**
 * Additive, display-only presentation layer (Phase B contract enrichment).
 * Assembled server-side from the validated plan's specialist outputs so the
 * approval sheet can render hotel/swap media, map pins and a labelled money
 * summary. STRICTLY optional: absent = valid; the validator type-checks it
 * tolerantly when present. Never feeds the ledger math.
 */
export interface ResolutionPresentation {
  hotel?: {
    name: string;
    action: string;
    rate_per_night?: number;
    currency?: string;
    free_cancellation_until?: string;
    lat?: number;
    lng?: number;
    images?: string[];
  };
  activity_swap?: {
    name?: string;
    image?: string;
    price_from?: number;
    currency?: string;
    rating?: number;
  };
  map_points?: Array<{
    label: string;
    lat: number;
    lng: number;
    kind: "airport_origin" | "airport_new" | "hotel" | "activity";
  }>;
  /** Human-readable ledger lines, e.g. "New flight CDG → OPO · +€150.00". */
  ledger_summary?: string[];
  /**
   * What this plan COSTS the rest of the trip, in plain words — "You arrive 2
   * days late: 2 nights and 3 activities you had planned."
   *
   * The money panel says what the traveller pays. This says what they lose,
   * which for a late rebooking is usually the bigger number and was never
   * shown at all: the swarm would re-time the arrival day and say nothing
   * about the days behind it. Absent when a plan costs the itinerary nothing.
   */
  /**
   * Why no replacement flight could be offered, when none could.
   *
   * `partner_coverage` is the only value that names the provider, and the
   * FlightAgent has to prove it first (several distinct dates, every one empty).
   * The traveller acts on this — it is the difference between "wait and retry"
   * and "go book it with the airline yourself".
   */
  no_flight_reason?: {
    kind: "partner_coverage" | "all_too_late" | "pricing_unavailable" | "none_on_date";
    summary: string;
    /** The route, so the message can name it: "SIN → FCO". */
    route?: string;
  };
  trip_impact?: {
    summary: string;
    nights_lost: number;
    activities_lost: number;
    days_lost: number;
    /** Node ids of everything that becomes unreachable. */
    lost_node_ids: string[];
    /** NEW (additive) — invalidated airport/ground transfers. */
    transfers_lost?: number;
    /** NEW (additive) — meals among the lost items (counted apart from activities). */
    meals_lost?: number;
  };
  /**
   * NEW (additive) — the settlement's own change lines, produced by running the
   * SAME transformer that approval runs against the trip as it stands now. The
   * approval sheet lists them so nothing is changed that was not shown.
   */
  settlement_preview?: {
    changes: string[];
    follow_ups: Array<{ kind: string; message: string }>;
  };
}

/** The frozen plan-badge vocabulary (W1 additively widened: the per-candidate
 *  carousel stamps the derived tags nonstop / same_day / next_day alongside
 *  the legacy selection profiles). */
const VALID_PLAN_BADGES: ReadonlySet<string> = new Set([
  "cheapest",
  "fastest",
  "balanced",
  "nonstop",
  "same_day",
  "next_day",
]);

/**
 * The approval payload. `requires_human_approval` is typed as the literal
 * `true` on purpose: a financial resolution plan can, by construction, never
 * declare itself auto-approved.
 */
export interface ResolutionPlan {
  incident: Incident;
  impacted_nodes: ImpactedNodes;
  proposed_resolution: ProposedResolution;
  financial_delta: FinancialDelta;
  requires_human_approval: true;
  /** NEW (two-phase assess/resolve) — selection badge of this plan on a
   *  multi-plan approval card. Absent = single-plan/legacy flow (valid).
   *  W1 (additive): per-candidate carousel adds the derived tags
   *  "nonstop" / "same_day" / "next_day" (clients render unknown badges
   *  through their default case). */
  badge?: "cheapest" | "fastest" | "balanced" | "nonstop" | "same_day" | "next_day";
  /** NEW (additive, clarity pass) — every selection profile this plan
   *  honestly covers. Emitted when the plan list collapses onto one option
   *  several profiles selected (e.g. the single frontier member is BOTH the
   *  cheapest and the fastest). Absent = legacy single-badge flow (valid). */
  badges?: ("cheapest" | "fastest" | "balanced" | "nonstop" | "same_day" | "next_day")[];
  /** NEW (spec §3.5) — Time-To-Live for the live quotes (epoch ms). */
  expires_at?: number;
  /** NEW — real-trip settlement instructions (see OperationalSettlement). */
  operational?: OperationalSettlement;
  /** NEW (additive) — ISO-4217 currency the plan's amounts are quoted in. */
  currency?: string;
  /** NEW (additive) — display-only presentation layer (see above). */
  presentation?: ResolutionPresentation;
}

/** Convenience alias emphasizing the trust-boundary role of the schema. */
export type TrustLayerPlan = ResolutionPlan;

// ---------------------------------------------------------------- validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Additive optional fields: absent = fine; present must be a string. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Additive optional fields: absent = fine; present must be a finite number. */
function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isProposedNewFlight(value: unknown): value is ProposedNewFlight {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.cost) &&
    // Additive display enrichment (Phase B): tolerant presence checks.
    isOptionalString(value.origin) &&
    isOptionalString(value.destination) &&
    isOptionalString(value.airline) &&
    isOptionalString(value.departure) &&
    isOptionalString(value.arrival) &&
    isOptionalString(value.currency) &&
    isOptionalString(value.flight_number) &&
    // Additive comparison facts: finite numbers only (never NaN/Infinity),
    // and a layover list of plain strings.
    isOptionalFiniteNumber(value.stops) &&
    isOptionalFiniteNumber(value.durationMinutes) &&
    (value.stopAirports === undefined || isStringArray(value.stopAirports)) &&
    (value.segments === undefined || isNewFlightSegmentArray(value.segments)) &&
    (value.fare_basis === undefined ||
      value.fare_basis === "verified" ||
      value.fare_basis === "search_reference" ||
      value.fare_basis === "synthetic_estimate")
  );
}

/** Every hop is an object of optional strings — nothing else is admissible. */
function isNewFlightSegmentArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const seg = entry as Record<string, unknown>;
    return ["carrier", "reference", "from", "to", "depart", "arrive"].every(
      (key) => seg[key] === undefined || typeof seg[key] === "string",
    );
  });
}

function isRescheduledActivity(value: unknown): value is RescheduledActivityProposal {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.new_time === "string" &&
    isFiniteNumber(value.penalty) &&
    isOptionalString(value.new_time_iso) &&
    isOptionalString(value.reason) &&
    (value.action === undefined ||
      value.action === "reschedule" ||
      value.action === "swap" ||
      value.action === "drop")
  );
}

function isHotelAlternative(value: unknown): value is HotelAlternative {
  return (
    isRecord(value) &&
    isOptionalString(value.name) &&
    isOptionalFiniteNumber(value.ratePerNight) &&
    isOptionalString(value.currency) &&
    isOptionalString(value.freeCancellationUntil) &&
    isOptionalFiniteNumber(value.lat) &&
    isOptionalFiniteNumber(value.lng) &&
    (value.images === undefined || isStringArray(value.images))
  );
}

function isHotelAdjustment(value: unknown): value is HotelAdjustment {
  return (
    isRecord(value) &&
    typeof value.hotel_name === "string" &&
    (value.action === "late_check_in" || value.action === "rebook" || value.action === "none") &&
    isFiniteNumber(value.fee) &&
    value.fee >= 0 &&
    (value.requires_confirmation === undefined || typeof value.requires_confirmation === "boolean") &&
    (value.note === undefined || typeof value.note === "string") &&
    (value.alternative === undefined || isHotelAlternative(value.alternative)) &&
    (value.nights_unstayed === undefined ||
      (isFiniteNumber(value.nights_unstayed) && value.nights_unstayed >= 0))
  );
}

function isPolicyVerdictSummary(value: unknown): value is PolicyVerdictSummary {
  return (
    isRecord(value) &&
    typeof value.rebookPermitted === "boolean" &&
    isFiniteNumber(value.changeFee) &&
    value.changeFee >= 0 &&
    (value.recommendedAction === "rebook" ||
      value.recommendedAction === "keep_and_wait" ||
      value.recommendedAction === "refund_and_rebook") &&
    typeof value.noShowApplied === "boolean" &&
    // Additive: absent = fine; present must be a string.
    isOptionalString(value.currency)
  );
}

function isTransferRequote(value: unknown): value is TransferRequote {
  return (
    isRecord(value) &&
    isFiniteNumber(value.amount) &&
    value.amount >= 0 &&
    typeof value.from === "string" &&
    value.from.trim().length > 0 &&
    typeof value.to === "string" &&
    value.to.trim().length > 0 &&
    typeof value.reason === "string"
  );
}

function isProposedResolution(value: unknown): value is ProposedResolution {
  if (
    !(
      isRecord(value) &&
      (value.new_flight === undefined || isProposedNewFlight(value.new_flight)) &&
      Array.isArray(value.rescheduled_activities) &&
      value.rescheduled_activities.every(isRescheduledActivity)
    )
  ) {
    return false;
  }
  // NEW optional-field guards (spec §3.5): absent fields stay valid so every
  // pre-extension plan (incl. XY123_EXAMPLE_PLAN) keeps passing.
  if (
    value.hotel_adjustments !== undefined &&
    (!Array.isArray(value.hotel_adjustments) || !value.hotel_adjustments.every(isHotelAdjustment))
  ) {
    return false;
  }
  if (value.policy_verdict !== undefined && !isPolicyVerdictSummary(value.policy_verdict)) {
    return false;
  }
  if (value.transfer_requote !== undefined && !isTransferRequote(value.transfer_requote)) {
    return false;
  }
  return true;
}

function isOperationalSettlement(value: unknown): value is OperationalSettlement {
  if (!isRecord(value)) return false;
  const disrupted = value.disrupted;
  if (
    !isRecord(disrupted) ||
    typeof disrupted.nodeId !== "string" ||
    typeof disrupted.kind !== "string" ||
    typeof disrupted.label !== "string"
  ) {
    return false;
  }
  if (value.new_flight !== undefined) {
    const nf = value.new_flight;
    if (
      !isRecord(nf) ||
      typeof nf.reference !== "string" ||
      typeof nf.depart !== "string" ||
      typeof nf.arrive !== "string" ||
      (nf.carrier !== undefined && typeof nf.carrier !== "string")
    ) {
      return false;
    }
  }
  if (
    value.activity_moves !== undefined &&
    (!Array.isArray(value.activity_moves) ||
      !value.activity_moves.every(
        (move) =>
          isRecord(move) &&
          typeof move.nodeId === "string" &&
          typeof move.newTime === "string" &&
          (move.replacementName === undefined || typeof move.replacementName === "string") &&
          (move.viatorProductCode === undefined || typeof move.viatorProductCode === "string") &&
          (move.drop === undefined || typeof move.drop === "boolean") &&
          (move.cancellationNote === undefined || typeof move.cancellationNote === "string"),
      ))
  ) {
    return false;
  }
  if (
    value.hotel_actions !== undefined &&
    (!Array.isArray(value.hotel_actions) ||
      !value.hotel_actions.every(
        (action) =>
          isRecord(action) &&
          typeof action.nodeId === "string" &&
          typeof action.action === "string" &&
          typeof action.note === "string" &&
          (action.newCheckIn === undefined || typeof action.newCheckIn === "string"),
      ))
  ) {
    return false;
  }
  if (
    value.booking_status !== undefined &&
    value.booking_status !== "confirmed" &&
    value.booking_status !== "recorded"
  ) {
    return false;
  }
  return value.bookingCode === undefined || typeof value.bookingCode === "string";
}

const MAP_POINT_KINDS = new Set<string>(["airport_origin", "airport_new", "hotel", "activity"]);

/** Tolerant type-check of the additive presentation layer (absent = valid). */
function isResolutionPresentation(value: unknown): value is ResolutionPresentation {
  if (!isRecord(value)) return false;
  if (value.hotel !== undefined) {
    const hotel = value.hotel;
    if (
      !isRecord(hotel) ||
      typeof hotel.name !== "string" ||
      hotel.name.trim().length === 0 ||
      typeof hotel.action !== "string" ||
      hotel.action.trim().length === 0 ||
      !isOptionalFiniteNumber(hotel.rate_per_night) ||
      !isOptionalString(hotel.currency) ||
      !isOptionalString(hotel.free_cancellation_until) ||
      !isOptionalFiniteNumber(hotel.lat) ||
      !isOptionalFiniteNumber(hotel.lng) ||
      (hotel.images !== undefined && !isStringArray(hotel.images))
    ) {
      return false;
    }
  }
  if (value.activity_swap !== undefined) {
    const swap = value.activity_swap;
    if (
      !isRecord(swap) ||
      !isOptionalString(swap.name) ||
      !isOptionalString(swap.image) ||
      !isOptionalFiniteNumber(swap.price_from) ||
      !isOptionalString(swap.currency) ||
      !isOptionalFiniteNumber(swap.rating)
    ) {
      return false;
    }
  }
  if (value.map_points !== undefined) {
    if (
      !Array.isArray(value.map_points) ||
      !value.map_points.every(
        (point) =>
          isRecord(point) &&
          typeof point.label === "string" &&
          isFiniteNumber(point.lat) &&
          isFiniteNumber(point.lng) &&
          typeof point.kind === "string" &&
          MAP_POINT_KINDS.has(point.kind),
      )
    ) {
      return false;
    }
  }
  if (value.ledger_summary !== undefined && !isStringArray(value.ledger_summary)) {
    return false;
  }
  if (value.trip_impact !== undefined) {
    const impact = value.trip_impact;
    if (
      !isRecord(impact) ||
      !isOptionalFiniteNumber(impact.transfers_lost) ||
      !isOptionalFiniteNumber(impact.meals_lost)
    ) {
      return false;
    }
  }
  if (value.settlement_preview !== undefined) {
    const preview = value.settlement_preview;
    if (
      !isRecord(preview) ||
      !isStringArray(preview.changes) ||
      !Array.isArray(preview.follow_ups) ||
      !preview.follow_ups.every(
        (entry) => isRecord(entry) && typeof entry.kind === "string" && typeof entry.message === "string",
      )
    ) {
      return false;
    }
  }
  return true;
}

function isFinancialDelta(value: unknown): value is FinancialDelta {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.total_refund)) return false;
  if (!isFiniteNumber(value.total_new_charges)) return false;
  if (!isFiniteNumber(value.net_payable)) return false;
  // Deterministic financial arithmetic — never trust a model's rounding.
  if (Math.abs(value.total_new_charges - value.total_refund - value.net_payable) >= 1e-9) {
    return false;
  }
  // Additive per-currency segregation: absent = fine (pre-extension plans);
  // present must be well-formed buckets, each holding the same invariant.
  if (value.by_currency !== undefined) {
    if (!Array.isArray(value.by_currency)) return false;
    // One bucket per currency — a duplicate currency would double-count the
    // ledger (case-sensitive, matching how buckets are produced).
    const seenCurrencies = new Set<string>();
    for (const bucket of value.by_currency) {
      if (
        !isRecord(bucket) ||
        typeof bucket.currency !== "string" ||
        bucket.currency.trim().length === 0 ||
        seenCurrencies.has(bucket.currency) ||
        !isFiniteNumber(bucket.total_refund) ||
        !isFiniteNumber(bucket.total_new_charges) ||
        !isFiniteNumber(bucket.net_payable) ||
        Math.abs(bucket.total_new_charges - bucket.total_refund - bucket.net_payable) >= 1e-9
      ) {
        return false;
      }
      seenCurrencies.add(bucket.currency);
    }
  }
  return true;
}

/**
 * Deterministic runtime validation of an untrusted payload against the
 * ResolutionPlan schema. Suitable as the single gate before rendering an
 * approval card or executing any approved action.
 */
export function validateResolutionPlan(plan: unknown): plan is ResolutionPlan {
  if (!isRecord(plan)) return false;
  if (typeof plan.incident !== "string" || plan.incident.length === 0) return false;
  if (!isStringArray(plan.impacted_nodes)) return false;
  if (!isProposedResolution(plan.proposed_resolution)) return false;
  if (!isFinancialDelta(plan.financial_delta)) return false;
  // Additive-field guard: an ABSENT operational stays valid (every pre-
  // extension plan), but a malformed one rejects the payload.
  if (plan.operational !== undefined && !isOperationalSettlement(plan.operational)) return false;
  if (plan.expires_at !== undefined && !isFiniteNumber(plan.expires_at)) return false;
  // Two-phase badge: absent = valid (legacy single-plan flow); present must be
  // one of the frozen badge values (W1 additively widened with the derived
  // per-candidate tags nonstop / same_day / next_day).
  if (
    plan.badge !== undefined &&
    (typeof plan.badge !== "string" || !VALID_PLAN_BADGES.has(plan.badge))
  ) {
    return false;
  }
  // Additive multi-badge list: absent = valid (legacy plans); present must be
  // a NON-EMPTY array whose values all belong to the frozen badge union, with
  // no duplicates (duplicate identities would break `ForEach(id: \.self)`
  // rendering on the clients).
  if (plan.badges !== undefined) {
    if (!Array.isArray(plan.badges) || plan.badges.length === 0) return false;
    const seen = new Set<string>();
    for (const value of plan.badges) {
      if (typeof value !== "string" || !VALID_PLAN_BADGES.has(value)) return false;
      if (seen.has(value)) return false;
      seen.add(value);
    }
  }
  // Phase B additive fields: absent = valid; present must be well-formed.
  if (
    plan.currency !== undefined &&
    (typeof plan.currency !== "string" || plan.currency.trim().length === 0)
  ) {
    return false;
  }
  if (plan.presentation !== undefined && !isResolutionPresentation(plan.presentation)) return false;
  return plan.requires_human_approval === true;
}

/**
 * Serialize a plan to canonical JSON. The object is explicitly rebuilt in
 * schema field order (regardless of the input's key insertion order), so the
 * output is byte-stable across producers — audit- and hash-friendly.
 */
export function resolutionPlanToJson(plan: ResolutionPlan): string {
  const proposedResolution: ProposedResolution = {
    rescheduled_activities: plan.proposed_resolution.rescheduled_activities.map((activity) => {
      const entry: RescheduledActivityProposal = {
        name: activity.name,
        new_time: activity.new_time,
        penalty: activity.penalty,
      };
      // Additive fields emitted only when present (fixed schema position).
      if (activity.new_time_iso !== undefined) entry.new_time_iso = activity.new_time_iso;
      if (activity.reason !== undefined) entry.reason = activity.reason;
      if (activity.action !== undefined) entry.action = activity.action;
      return entry;
    }),
  };

  if (plan.proposed_resolution.new_flight) {
    proposedResolution.new_flight = canonicalNewFlight(plan.proposed_resolution.new_flight);
  }

  // Extended fields are emitted ONLY when present, in fixed schema order,
  // so pre-extension plans serialize byte-identically to the old format.
  if (plan.proposed_resolution.hotel_adjustments !== undefined) {
    proposedResolution.hotel_adjustments = plan.proposed_resolution.hotel_adjustments.map(
      (adjustment) => {
        const entry: HotelAdjustment = {
          hotel_name: adjustment.hotel_name,
          action: adjustment.action,
          fee: adjustment.fee,
        };
        if (adjustment.requires_confirmation !== undefined) entry.requires_confirmation = adjustment.requires_confirmation;
        if (adjustment.note !== undefined) entry.note = adjustment.note;
        if (adjustment.alternative !== undefined) {
          entry.alternative = canonicalizeJson(adjustment.alternative) as HotelAlternative;
        }
        return entry;
      },
    );
  }
  if (plan.proposed_resolution.policy_verdict !== undefined) {
    const policyVerdict: PolicyVerdictSummary = {
      rebookPermitted: plan.proposed_resolution.policy_verdict.rebookPermitted,
      changeFee: plan.proposed_resolution.policy_verdict.changeFee,
      recommendedAction: plan.proposed_resolution.policy_verdict.recommendedAction,
      noShowApplied: plan.proposed_resolution.policy_verdict.noShowApplied,
    };
    // Additive field emitted ONLY when present (fixed schema position), so
    // pre-extension verdicts serialize byte-identically to the old format.
    if (plan.proposed_resolution.policy_verdict.currency !== undefined) {
      policyVerdict.currency = plan.proposed_resolution.policy_verdict.currency;
    }
    proposedResolution.policy_verdict = policyVerdict;
  }
  if (plan.proposed_resolution.transfer_requote !== undefined) {
    proposedResolution.transfer_requote = {
      amount: plan.proposed_resolution.transfer_requote.amount,
      from: plan.proposed_resolution.transfer_requote.from,
      to: plan.proposed_resolution.transfer_requote.to,
      reason: plan.proposed_resolution.transfer_requote.reason,
    };
  }

  const financialDelta: FinancialDelta = {
    total_refund: plan.financial_delta.total_refund,
    total_new_charges: plan.financial_delta.total_new_charges,
    net_payable: plan.financial_delta.net_payable,
  };
  // Additive per-currency segregation emitted ONLY when present — buckets
  // are copied in their existing order, so pre-extension plans serialize
  // byte-identically to the legacy triple-only format.
  if (plan.financial_delta.by_currency !== undefined) {
    financialDelta.by_currency = plan.financial_delta.by_currency.map((bucket) => ({
      currency: bucket.currency,
      total_refund: bucket.total_refund,
      total_new_charges: bucket.total_new_charges,
      net_payable: bucket.net_payable,
    }));
  }

  const canonical: ResolutionPlan = {
    incident: plan.incident,
    impacted_nodes: [...plan.impacted_nodes],
    proposed_resolution: proposedResolution,
    financial_delta: financialDelta,
    requires_human_approval: true,
  };
  // Two-phase badge: emitted ONLY when present, in fixed schema position
  // (right after requires_human_approval, before expires_at), so legacy
  // plans serialize byte-identically to the pre-badge format.
  if (plan.badge !== undefined) {
    canonical.badge = plan.badge;
  }
  // Additive multi-badge list emitted ONLY when present, fixed schema
  // position right after `badge` (before expires_at) — legacy plans keep
  // serializing byte-identically to the single-badge format.
  if (plan.badges !== undefined) {
    canonical.badges = [...plan.badges];
  }
  if (plan.expires_at !== undefined) {
    canonical.expires_at = plan.expires_at;
  }
  // The operational layer is emitted ONLY when present, so pre-extension
  // plans serialize byte-identically to the old format. Keys are rebuilt in
  // recursively sorted order so the output is byte-stable regardless of the
  // producer's key insertion order.
  if (plan.operational !== undefined) {
    canonical.operational = canonicalizeJson(plan.operational) as OperationalSettlement;
  }
  // Phase B additive fields: emitted ONLY when present, after the operational
  // layer, so pre-extension plans keep their byte-identical format.
  if (plan.currency !== undefined) {
    canonical.currency = plan.currency;
  }
  if (plan.presentation !== undefined) {
    canonical.presentation = canonicalizeJson(plan.presentation) as ResolutionPresentation;
  }
  return JSON.stringify(canonical, null, 2);
}

/**
 * Rebuild `new_flight` in fixed schema field order (base fields first, then
 * the additive display fields in declared order) — byte-stable output.
 */
function canonicalNewFlight(flight: ProposedNewFlight): ProposedNewFlight {
  const entry: ProposedNewFlight = { id: flight.id, cost: flight.cost };
  if (flight.origin !== undefined) entry.origin = flight.origin;
  if (flight.destination !== undefined) entry.destination = flight.destination;
  if (flight.airline !== undefined) entry.airline = flight.airline;
  if (flight.departure !== undefined) entry.departure = flight.departure;
  if (flight.arrival !== undefined) entry.arrival = flight.arrival;
  if (flight.currency !== undefined) entry.currency = flight.currency;
  // Additive field emitted ONLY when present (fixed schema position after
  // `currency`), so pre-extension plans serialize byte-identically.
  if (flight.flight_number !== undefined) entry.flight_number = flight.flight_number;
  if (flight.stops !== undefined) entry.stops = flight.stops;
  if (flight.durationMinutes !== undefined) entry.durationMinutes = flight.durationMinutes;
  if (flight.stopAirports !== undefined) entry.stopAirports = [...flight.stopAirports];
  if (flight.segments !== undefined) {
    entry.segments = flight.segments.map((segment) => ({ ...segment }));
  }
  if (flight.fare_basis !== undefined) entry.fare_basis = flight.fare_basis;
  return entry;
}

/**
 * Deep-rebuild any JSON value with object keys sorted recursively (arrays
 * keep element order). Guarantees byte-stable serialization regardless of
 * the producer's key insertion order.
 */
function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
