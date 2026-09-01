/**
 * ActivityAgent — activity reschedule / swap specialist (spec §2.2, §3.3).
 *
 * Replaces or reschedules impacted activities: weather-driven disruptions
 * (rain / storm) swap outdoor activities for indoor alternatives sourced via
 * the injected {@link ActivityProvider} (Viator through the viator-activities
 * Edge Function), while timing-driven disruptions (missed flight) simply move
 * the same activity to the next acceptable slot.
 *
 * This agent's output replaces BOTH `TODO(post-scaffold)` mocks in the
 * orchestrator: `rescheduledActivities = []` (now real proposals) and
 * `MOCK_ACTIVITY_PENALTY = 20` (now a deterministic penalty derived from
 * Viator's standard free-cancellation-up-to-24h policy).
 *
 * Deterministic by spec: provider failures degrade to a plain reschedule
 * proposal instead of throwing, so activity protection never sinks the plan.
 */

import type { ActivityProvider } from "@/providers/interfaces/ActivityProvider";
import type { ActivityOption, IsoTimestamp } from "@/providers/interfaces/types";
import type { GeminiDegradeReason } from "../geminiDegrade";
import type { DayActivityInput, DayReorgDecision } from "./DayReorganizer";

/** Request shape per spec §3.3 (+ agent-layer optional context fields). */
export interface ActivityRescheduleRequest {
  /** Graph node id, e.g. "activity-surf". */
  activityNodeId: string;
  activityName: string;
  originalTime: IsoTimestamp;
  /** Earliest acceptable slot. */
  windowStart: IsoTimestamp;
  /** Latest acceptable slot. */
  windowEnd: IsoTimestamp;
  weatherHint?: "clear" | "rain" | "storm" | "extreme_heat";
  /** Agent-layer extension: destination label scoping the Viator search. */
  location?: string;
  /** Agent-layer extension: price of the current booking (drives swap priceDelta). */
  originalPrice?: number;
  /** Agent-layer extension: trip currency fallback. */
  currency?: string;
}

/**
 * Additive (W2) — what a Viator slot consult grounded for a moved/dropped
 * bookable activity. The affiliate tier is search/availability/pricing/
 * cancellation-policy ONLY — booking and cancellation endpoints are
 * merchant-only, so every rebook/cancel stays ADVISORY: a policy quote plus
 * a traveler deep-link, never fake-transactional language.
 */
export interface ViatorSlotConsult {
  /** True when at least one search came back live (non-degraded). */
  live: boolean;
  /** The experience is bookable in the new slot (matched product found). */
  available?: boolean;
  /** "from" price per traveller of the best-matching product. */
  priceFrom?: number;
  /** priceFrom minus the original booking price (when it was known). */
  priceDelta?: number;
  currency?: string;
  /** Cancellation-policy QUOTE (Viator standard 24h heuristic). */
  policyNote?: string;
  /** Affiliate deep-link where the traveler rebooks/cancels themselves. */
  productUrl?: string;
  /** Name of the matched product (audit feed). */
  matchedName?: string;
}

/** Output shape per spec §3.3. */
export interface ActivityRescheduleProposal {
  activityNodeId: string;
  /**
   * NEW (additive) — the activity's own venue name. Lets the liaison build
   * the activity-priority keep-X-or-drop-Y question from move/drop
   * proposals (previously only swap replacements were nameable). Swap names
   * keep precedence wherever both exist.
   */
  activityName?: string;
  /**
   * W2 (additive): `"drop"` — the activity is cancelled out of the day
   * (smart day reorganization proved the day infeasible otherwise). Kept
   * entries settle as retimes/swaps exactly as before; drops carry the
   * SAME honest `penalty`/`rationale` (Viator 24h free-cancel heuristic).
   */
  action: "reschedule" | "swap" | "drop";
  newTime: IsoTimestamp;
  /** Real change/cancel fee (replaces MOCK_ACTIVITY_PENALTY=20). */
  penalty: number;
  currency: string;
  /**
   * NEW (additive) — human-readable penalty rationale, e.g. the
   * within-24h change-fee reasoning. Threaded by the orchestrator into
   * `rescheduled_activities[].reason` on the TrustLayer plan.
   */
  rationale?: string;
  /** Only when action === "swap" (e.g. surf lesson → indoor museum slot in rain). */
  swap?: {
    replacementName: string;
    /** Sourced via the viator-activities Edge Function. */
    viatorProductCode?: string;
    /** Folded into financial_delta. */
    priceDelta: number;
    reason: string;
    /** NEW (additive) — provider media for the presentation layer. */
    image?: string;
    rating?: number;
    /** Replacement "from" price per traveller. */
    price?: number;
    /** Replacement price currency. */
    currency?: string;
  };
  /**
   * NEW (W2, additive) — Viator availability/pricing/policy grounding for
   * the new slot. Absent when the consult degraded (the heuristic stands
   * alone — a Viator consult never sinks a plan).
   */
  viatorConsult?: ViatorSlotConsult;
  /**
   * NEW (W2, additive) — which rail produced this proposal when it came
   * from the DayReorganizer ("gemini" | "deterministic"). Absent on the
   * legacy per-item rail. Feeds the `day_reorganization` trace step.
   */
  reorgSource?: "gemini" | "deterministic";
  /**
   * Task 21 (additive) — WHY the Gemini reorg rail degraded when this
   * proposal came from the DayReorganizer's deterministic fallback
   * ({@link GeminiDegradeReason}). Absent when Gemini authored the schedule
   * or the proposal came from the legacy per-item rail. Feeds the
   * `activity/gemini_degraded` trace row.
   */
  reorgDegradeReason?: GeminiDegradeReason;
  reorgDegradeDetail?: string;
}

/**
 * Viator standard policy heuristic: experiences are free-cancel/changeable up
 * to 24h before start. Inside that window a move costs a flat service charge
 * (15 — the figure used in the spec §3.6 worked example); outside it, 0.
 */
const WITHIN_24H_CHANGE_FEE = 15;

/**
 * W2 — Viator slot-consult deadline. The consult is a presentation-grounding
 * fan-out, so it gets a tighter budget than the provider's own fetch timeout:
 * ~6s, overridable through the SAME `VIATOR_TIMEOUT_MS` env convention the
 * provider uses (never slower than 6s unless the operator says so).
 */
const VIATOR_CONSULT_TIMEOUT_MS: number = (() => {
  const env = typeof process !== "undefined" ? Number(process.env?.VIATOR_TIMEOUT_MS) : Number.NaN;
  return Number.isFinite(env) && env > 0 ? env : 6_000;
})();

/** Max parallel Viator searches per slot consult (bounded fan-out). */
const VIATOR_CONSULT_MAX_CALLS = 3;

/**
 * Review fix (assess latency) — per-mission Viator consult BUDGET: only the
 * first N moved/dropped slots are grounded against live Viator availability;
 * later slots keep the honest heuristic proposal WITHOUT a consult (the
 * consult is presentation grounding — never a plan dependency). Without the
 * cap a 2-day disruption could stack ~18 sequential consult fetches inside
 * POST /mission/assess's 20 s budget, and each consult is ≤3 provider
 * subrequests — the cap also protects the Workers Free-plan 50-subrequest
 * ceiling. The agent is constructed once per mission, so the counter is a
 * true per-mission budget shared by BOTH rails (legacy per-item + reorg).
 */
const VIATOR_CONSULTS_PER_MISSION = 6;

export class ActivityAgent {
  constructor(private readonly provider: ActivityProvider) {}

  /** Which concrete provider backs this agent (useful for audit trails). */
  get providerName(): string {
    return this.provider.providerName;
  }

  /** Consults consumed so far this mission (test/audit feed). */
  get viatorConsultsUsed(): number {
    return this.viatorConsultsUsedCount;
  }

  private viatorConsultsUsedCount = 0;

  async proposeRescheduling(
    requests: ActivityRescheduleRequest[],
  ): Promise<ActivityRescheduleProposal[]> {
    // Review fix (assess latency): the per-item proposals are independent —
    // fan them out CONCURRENTLY instead of sequentially awaiting each item
    // (every item may wait on a swap search and/or a Viator slot consult).
    // map order == proposal order, and each proposeFor degrades internally,
    // so semantics are unchanged.
    return Promise.all(requests.map((request) => this.proposeFor(request)));
  }

  // ---------------------------------------------------------------- internals

  private async proposeFor(
    request: ActivityRescheduleRequest,
  ): Promise<ActivityRescheduleProposal> {
    const penalty = changePenalty(request.originalTime);
    const rationale = penaltyRationale(penalty);
    const weatherBlocked = request.weatherHint === "rain" || request.weatherHint === "storm";

    // Weather-driven disruptions affecting outdoor activities try an indoor
    // SWAP first; everything else (or a failed swap search) is a RESCHEDULE.
    if (weatherBlocked && looksOutdoor(request.activityName)) {
      const swap = await this.findIndoorSwap(request);
      if (swap) {
        return {
          activityNodeId: request.activityNodeId,
          activityName: request.activityName,
          action: "swap",
          newTime: clampIntoWindow(request, request.originalTime),
          penalty,
          currency: swap.currency,
          rationale,
          swap: {
            replacementName: swap.name,
            viatorProductCode: swap.id,
            priceDelta: swapPriceDelta(request, swap),
            reason: weatherSwapReason(request.weatherHint),
            // Additive provider media for the presentation layer.
            ...(swap.image !== undefined ? { image: swap.image } : {}),
            ...(swap.rating !== undefined ? { rating: swap.rating } : {}),
            price: swap.price,
            currency: swap.currency,
          },
        };
      }
    }

    // Reschedule to the EARLIEST acceptable slot, i.e. the smallest move that
    // actually resolves the conflict — not a blanket +24h.
    //
    // The window is the single source of truth for what "acceptable" means, and
    // each caller already encodes its own intent in it: the timing-driven path
    // opens the window one hour after the original slot (so a shifted arrival
    // retimes the activity WITHIN its own day), while the weather path opens it
    // a full day later (an outdoor activity rained off genuinely belongs on
    // another day). Hardcoding next-day here overrode that and produced the
    // absurd case found live: a flight slipping ~1h pushed "Catedral de
    // Barcelona" from 14:30 to 14:30 THE NEXT DAY — onto a day already holding
    // eight items — when its own afternoon was still perfectly free.
    const newTime = keepInDaytime(clampIntoWindow(request, request.windowStart), request);
    // W2: ground the moved slot against live Viator availability/pricing/
    // policy (≤3 date-ranged searches under a ~6s deadline). Any failure
    // degrades to undefined — the heuristic proposal stands alone.
    const viatorConsult = await this.consultViatorForSlot({
      activityName: request.activityName,
      slotTime: newTime,
      location: request.location,
      currency: request.currency,
      originalPrice: request.originalPrice,
    });
    return {
      activityNodeId: request.activityNodeId,
      activityName: request.activityName,
      action: "reschedule",
      newTime,
      penalty,
      currency: request.currency ?? "USD",
      rationale,
      ...(viatorConsult ? { viatorConsult } : {}),
    };
  }

  /**
   * W2 — Viator slot consult for ONE moved/dropped bookable activity.
   *
   * Fans out ≤3 `searchActivities` calls (exact name + two loose variants)
   * date-ranged on the slot's day (`dateFrom`/`dateTo`), via
   * `Promise.allSettled` and a per-call deadline
   * ({@link VIATOR_CONSULT_TIMEOUT_MS}). The first live result grounds
   * availability, the matched product's `priceFrom` delta and the
   * cancellation-policy quote; its affiliate URL rides along as the honest
   * traveler deep-link (the affiliate tier is search/pricing/policy ONLY —
   * booking and cancellation stay with the traveler on Viator's site).
   *
   * TOTAL: ANY failure (provider degraded, deadline, no results) resolves
   * to `undefined` — a Viator consult never sinks a plan. Never throws.
   */
  async consultViatorForSlot(input: {
    activityName: string;
    slotTime: IsoTimestamp;
    location?: string;
    currency?: string;
    originalPrice?: number;
  }): Promise<ViatorSlotConsult | undefined> {
    try {
      const slotMs = Date.parse(input.slotTime);
      if (!Number.isFinite(slotMs)) return undefined;
      const slotDate = new Date(slotMs).toISOString().slice(0, 10);
      const currency = input.currency ?? "USD";
      const name = input.activityName.trim();
      if (name.length === 0) return undefined;

      // Per-mission budget gate (review fix): only the first N slots of the
      // mission are grounded — the excess keeps the heuristic proposal
      // alone. The increment runs BEFORE the first await, so fan-out order
      // assigns the budget deterministically (request order).
      if (this.viatorConsultsUsedCount >= VIATOR_CONSULTS_PER_MISSION) return undefined;
      this.viatorConsultsUsedCount += 1;

      const queries = [name, `${name} tour`, `${name} experience`]
        .filter((query, index, all) => all.indexOf(query) === index)
        .slice(0, VIATOR_CONSULT_MAX_CALLS);

      const settled = await Promise.allSettled(
        queries.map((query) =>
          this.withDeadline(
            this.provider.searchActivities({
              query,
              location: input.location,
              dateFrom: slotDate,
              dateTo: slotDate,
              currency,
              count: 4,
            }),
          ),
        ),
      );

      // First LIVE (non-degraded) result with options grounds the consult.
      let options: ActivityOption[] | null = null;
      for (const outcome of settled) {
        if (outcome.status !== "fulfilled" || outcome.value.degraded) continue;
        options = outcome.value.options;
        break;
      }
      if (options === null) return undefined;

      const policyNote = cancellationPolicyNote(slotMs);
      if (options.length === 0) {
        // Live search, nothing bookable in the slot: honest unavailability.
        return { live: true, available: false, policyNote };
      }
      const matched = pickMatchingProduct(options, name) ?? null;
      const best = matched ?? options[0];
      const priceDelta =
        input.originalPrice !== undefined && Number.isFinite(input.originalPrice)
          ? Math.round((best.price - input.originalPrice) * 100) / 100
          : undefined;
      return {
        live: true,
        ...(matched !== null ? { available: true, matchedName: matched.name } : {}),
        priceFrom: best.price,
        ...(priceDelta !== undefined ? { priceDelta } : {}),
        currency: best.currency,
        policyNote,
        ...(best.url !== undefined ? { productUrl: best.url } : {}),
      };
    } catch (error) {
      console.warn("[activity] Viator slot consult failed — heuristic stands:", error);
      return undefined;
    }
  }

  /**
   * W2 — build a `drop` proposal for a cancelled activity. The penalty and
   * rationale keep the SAME Viator 24h honesty as moves: free cancellation
   * up to 24h before start, flat service charge inside the window. The
   * `rationale` leads with the reorganizer's reason and appends the
   * cancellation-policy quote. `newTime` stays the ORIGINAL slot — the
   * settlement's drop marker removes the item, never re-appends it.
   */
  async createDropProposal(input: {
    activityNodeId: string;
    activityName: string;
    originalTime: IsoTimestamp;
    reason: string;
    location?: string;
    currency?: string;
    originalPrice?: number;
    reorgSource?: "gemini" | "deterministic";
    /** Task 21 (additive): Gemini degrade classify of the reorg rail. */
    reorgDegradeReason?: GeminiDegradeReason;
    reorgDegradeDetail?: string;
  }): Promise<ActivityRescheduleProposal> {
    const penalty = changePenalty(input.originalTime);
    const rationale =
      `${input.reason} ${cancellationPolicyNote(Date.parse(input.originalTime))}`.trim();
    const viatorConsult = await this.consultViatorForSlot({
      activityName: input.activityName,
      slotTime: input.originalTime,
      location: input.location,
      currency: input.currency,
      originalPrice: input.originalPrice,
    });
    return {
      activityNodeId: input.activityNodeId,
      activityName: input.activityName,
      action: "drop",
      newTime: input.originalTime,
      penalty,
      currency: input.currency ?? "USD",
      rationale,
      ...(viatorConsult ? { viatorConsult } : {}),
      ...(input.reorgSource ? { reorgSource: input.reorgSource } : {}),
      ...(input.reorgDegradeReason ? { reorgDegradeReason: input.reorgDegradeReason } : {}),
      ...(input.reorgDegradeDetail ? { reorgDegradeDetail: input.reorgDegradeDetail } : {}),
    };
  }

  /**
   * W2 — convert DayReorganizer decisions into settlement-ready proposals
   * (the orchestrator's reorg rail). Retimed entries become `reschedule`
   * proposals at the validated new slot; dropped entries become `drop`
   * proposals via {@link createDropProposal}. Every entry carries the
   * reorganizer's reason (penalty rationale appended for moves) and the
   * Viator consult when it grounds. TOTAL: never throws.
   */
  async proposalsFromReorganization(
    decisions: DayReorgDecision[],
    context: {
      activities: DayActivityInput[];
      location?: string;
      currency?: string;
      reorgSource: "gemini" | "deterministic";
      /** Task 21 (additive): Gemini degrade classify of the reorg rail. */
      reorgDegradeReason?: GeminiDegradeReason;
      reorgDegradeDetail?: string;
    },
  ): Promise<ActivityRescheduleProposal[]> {
    const byId = new Map(context.activities.map((activity) => [activity.nodeId, activity]));
    // Review fix (assess latency): the per-decision proposals are
    // independent — fan out the Viator slot consults CONCURRENTLY instead of
    // sequentially awaiting one per decision. map order == proposal order,
    // and each branch degrades internally, so semantics are unchanged.
    const jobs = decisions.map(async (decision): Promise<ActivityRescheduleProposal | null> => {
      const activity = byId.get(decision.nodeId);
      if (!activity) return null;
      if (decision.action === "drop") {
        return this.createDropProposal({
          activityNodeId: activity.nodeId,
          activityName: activity.name,
          originalTime: activity.time,
          reason: decision.reason,
          location: context.location,
          currency: context.currency,
          reorgSource: context.reorgSource,
          ...(context.reorgDegradeReason ? { reorgDegradeReason: context.reorgDegradeReason } : {}),
          ...(context.reorgDegradeDetail ? { reorgDegradeDetail: context.reorgDegradeDetail } : {}),
        });
      }
      const newTime = decision.newTime ?? activity.time;
      const penalty = changePenalty(activity.time);
      const rationale = `${decision.reason} ${penaltyRationale(penalty)}`.trim();
      const viatorConsult = await this.consultViatorForSlot({
        activityName: activity.name,
        slotTime: newTime,
        location: context.location,
        currency: context.currency,
      });
      return {
        activityNodeId: activity.nodeId,
        activityName: activity.name,
        action: "reschedule",
        newTime,
        penalty,
        currency: context.currency ?? "USD",
        rationale,
        ...(viatorConsult ? { viatorConsult } : {}),
        reorgSource: context.reorgSource,
        ...(context.reorgDegradeReason ? { reorgDegradeReason: context.reorgDegradeReason } : {}),
        ...(context.reorgDegradeDetail ? { reorgDegradeDetail: context.reorgDegradeDetail } : {}),
      };
    });
    const settled = await Promise.all(jobs);
    return settled.filter((proposal): proposal is ActivityRescheduleProposal => proposal !== null);
  }

  /** Search the provider for an indoor replacement; null on any shortfall. */
  private async findIndoorSwap(request: ActivityRescheduleRequest): Promise<ActivityOption | null> {
    try {
      const result = await this.provider.searchActivities({
        query: "indoor experiences",
        location: request.location ?? request.activityName,
        currency: request.currency ?? "USD",
        count: 4,
        settingPreference: "indoor",
      });
      if (result.degraded) return null;
      const candidate = result.options.find(
        (option) =>
          option.setting === "indoor" &&
          option.name.toLowerCase() !== request.activityName.toLowerCase(),
      );
      return candidate ?? null;
    } catch {
      return null;
    }
  }

  /** Race a provider promise against the slot-consult deadline. */
  private withDeadline<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("viator consult deadline exceeded")),
        VIATOR_CONSULT_TIMEOUT_MS,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

// ------------------------------------------------------------------ internals

/** Free change more than 24h out; flat service charge inside the window. */
function changePenalty(originalTime: IsoTimestamp): number {
  const originalMs = Date.parse(originalTime);
  if (Number.isNaN(originalMs)) return WITHIN_24H_CHANGE_FEE;
  return originalMs - Date.now() >= 24 * 60 * 60 * 1000 ? 0 : WITHIN_24H_CHANGE_FEE;
}

/**
 * Human-readable penalty rationale (display-only; threaded by the
 * orchestrator into `rescheduled_activities[].reason`).
 */
function penaltyRationale(penalty: number): string {
  if (penalty <= 0) {
    return "Change is more than 24h before start — Viator's standard policy allows free changes up to 24h ahead.";
  }
  return `Change lands inside the 24h window before start, so Viator's standard policy applies a flat ${WITHIN_24H_CHANGE_FEE} service charge.`;
}

/**
 * W2 — cancellation-policy QUOTE for a slot (Viator standard heuristic).
 * Honest affiliate wording: cancellation is the TRAVELER's action on
 * Viator's site — this is a policy quote, never a transactional promise.
 */
function cancellationPolicyNote(slotMs: number): string {
  const freeWindow = !Number.isFinite(slotMs) || slotMs - Date.now() >= 24 * 60 * 60 * 1000;
  if (freeWindow) {
    return "Free cancellation until 24h before start under Viator's standard policy (cancel via your Viator booking page).";
  }
  return `Cancellation inside the 24h window before start incurs a flat ${WITHIN_24H_CHANGE_FEE} service charge under Viator's standard policy (cancel via your Viator booking page).`;
}

/**
 * Deterministic product match for the consult: word-overlap scoring between
 * the activity name and each Viator product title (words > 3 chars). null
 * when nothing shares a significant word — the consult then quotes the top
 * result WITHOUT claiming it is the same experience.
 */
function pickMatchingProduct(
  options: ActivityOption[],
  activityName: string,
): ActivityOption | null {
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3),
    );
  const wanted = words(activityName);
  if (wanted.size === 0) return null;
  let best: ActivityOption | null = null;
  let bestScore = 0;
  for (const option of options) {
    const candidateWords = words(option.name);
    let score = 0;
    for (const word of wanted) {
      if (candidateWords.has(word)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  }
  return best;
}

/**
 * Price delta of a swap: replacement price minus the current booking price.
 * The original price is not part of the graph node schema, so when it is not
 * supplied the full replacement price is charged (conservative — never
 * understate money). Negative deltas (cheaper swap) stay negative here; the
 * orchestrator folds only positive deltas into financial_delta charges.
 */
function swapPriceDelta(request: ActivityRescheduleRequest, replacement: ActivityOption): number {
  const baseline = request.originalPrice ?? 0;
  return Math.round((replacement.price - baseline) * 100) / 100;
}

/** Deterministic clamp of a candidate slot into the acceptable window. */
/** Activities belong between these hours (UTC wall clock, the trip convention). */
const DAY_OPENS_HOUR = 8;
const DAY_CLOSES_HOUR = 22;

/**
 * Keep a rescheduled slot inside daylight hours.
 *
 * Moving by the smallest acceptable amount is right, but a late-evening
 * activity plus one hour lands after midnight — the live run put a Tokyo
 * activity at 00:30. When the slot falls outside the day, roll forward to the
 * next morning's opening hour instead, still clamped into the caller's window.
 */
function keepInDaytime(
  candidate: IsoTimestamp,
  request: ActivityRescheduleRequest,
): IsoTimestamp {
  const ms = Date.parse(candidate);
  if (Number.isNaN(ms)) return candidate;
  const at = new Date(ms);
  const hour = at.getUTCHours();
  if (hour >= DAY_OPENS_HOUR && hour < DAY_CLOSES_HOUR) return candidate;
  const nextMorning = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    // Before the day opens ⇒ this morning; after it closes ⇒ tomorrow's.
    at.getUTCDate() + (hour >= DAY_CLOSES_HOUR ? 1 : 0),
    DAY_OPENS_HOUR,
  );
  return clampIntoWindow(request, new Date(nextMorning).toISOString());
}

function clampIntoWindow(
  request: ActivityRescheduleRequest,
  candidate: IsoTimestamp,
): IsoTimestamp {
  const candidateMs = Date.parse(candidate);
  const startMs = Date.parse(request.windowStart);
  const endMs = Date.parse(request.windowEnd);
  if (Number.isNaN(candidateMs)) return request.windowStart;
  if (!Number.isNaN(startMs) && candidateMs < startMs) return request.windowStart;
  if (!Number.isNaN(endMs) && candidateMs > endMs) return request.windowEnd;
  return new Date(candidateMs).toISOString();
}

function weatherSwapReason(hint: ActivityRescheduleRequest["weatherHint"]): string {
  switch (hint) {
    case "storm":
      return "Outdoor activity swapped for an indoor alternative due to storm conditions.";
    case "rain":
      return "Outdoor activity moved indoors due to heavy rain.";
    default:
      return "Outdoor activity swapped due to adverse weather.";
  }
}

/**
 * Lightweight outdoor detection on the activity NAME alone (provider tagging
 * still applies to every searched replacement). Kept in the agent layer so
 * the agent stays provider-agnostic.
 */
const OUTDOOR_NAME_TERMS = [
  "surf",
  "beach",
  "hik",
  "kayak",
  "snorkel",
  "div",
  "sail",
  "boat",
  "cruise",
  "zipline",
  "raft",
  "trek",
  "safari",
  "outdoor",
  "climbing",
  "biking",
  "cycling",
  "horseback",
  "horse riding",
  "paragliding",
  "golf",
  "fishing",
];

function looksOutdoor(activityName: string): boolean {
  const haystack = activityName.toLowerCase();
  return OUTDOOR_NAME_TERMS.some((term) => haystack.includes(term));
}
