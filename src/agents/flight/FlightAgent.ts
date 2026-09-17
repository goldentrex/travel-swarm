/**
 * FlightAgent — specialist agent for flight disruption recovery.
 *
 * Depends on the abstract `FlightProvider` interface via dependency
 * injection, never on a concrete Atlas/Amadeus/Duffel implementation. Given
 * a disrupted flight, it searches replacement options and prices each one
 * against the traveller's current booking, returning a fully structured
 * assessment for the orchestrator.
 */

import type { FlightProvider } from "@/providers/interfaces/FlightProvider";
import type {
  AlternativeFlightsResult,
  FareDifference,
  FlightOption,
  FlightRouteContext,
  IsoTimestamp,
} from "@/providers/interfaces/types";

/** One replacement candidate with its priced fare delta. */
export interface RebookingCandidate {
  option: FlightOption;
  fareDifference: FareDifference;
}

/** Structured output of {@link FlightAgent.assessRebookingOptions}. */
/**
 * WHY a search produced no bookable replacement.
 *
 * The traveller is told something different in each case, and getting this
 * wrong is worse than saying nothing: blaming the provider's coverage when our
 * own rebooking window rejected perfectly good flights is a lie that sends
 * someone off to book manually for no reason.
 *
 *  - `route_not_covered` — the provider ANSWERED on several distinct dates and
 *    had nothing on any of them. A commercial route has daily service, so an
 *    entire week of empty answers is a gap in the partner's inventory, not an
 *    unlucky day. This is the only verdict allowed to name the partner.
 *  - `no_options_on_date` — the same emptiness, but from a single date. Cannot
 *    distinguish "not covered" from "nothing flying that day", so it must not
 *    claim either.
 *  - `all_options_rejected` — the provider HAD flights and OUR rules removed
 *    them all (the 48h rebooking horizon, the excluded original departure).
 *    Nothing to do with coverage.
 *  - `pricing_unavailable` — usable flights existed but none could be priced.
 *  - `search_declined` — the provider REFUSED to look (a past date, an upstream
 *    rejection). It returns an empty list exactly like a genuine no-inventory
 *    answer, and conflating them told a traveller their partner does not serve
 *    AMS → LHR when their trip dates had simply already passed.
 */
export type NoReplacementReason =
  | "route_not_covered"
  | "no_options_on_date"
  | "all_options_rejected"
  | "pricing_unavailable"
  | "search_declined";

export interface FlightRebookingAssessment {
  originalFlightId: string;
  requestedTime: IsoTimestamp;
  candidates: RebookingCandidate[];
  /** Candidate with the smallest net charge (or largest refund), if any. */
  bestCandidate: RebookingCandidate | null;
  /**
   * NEW (additive) — Atlas sandbox liveness correlation, aggregated from the
   * provider's additive ids (search id on AlternativeFlightsResult, verify
   * ids on each FareDifference) and passed through untouched. Present ONLY
   * when at least one correlation id exists — the Activity Stream emits the
   * `flight/atlas_liveness` proof row from it; degraded/simulated rails
   * never carry it.
   */
  atlasCorrelation?: { searchRequestId?: string; verifyRequestIds: string[] };
  /**
   * NEW (additive) — the calendar dates (yyyy-mm-dd, UTC) the flexible-date
   * search window attempted, in order. Present ONLY when the window loop ran
   * (i.e. a routeContext was supplied); the legacy single-search path omits
   * it entirely.
   */
  searchedDates?: string[];
  /**
   * Why `candidates` is empty, when it is. Absent whenever a bookable
   * replacement was found — the callers only ever read it on the empty rail.
   */
  noReplacementReason?: NoReplacementReason;
  /** How many options the PROVIDER returned, before any rule of ours. The
   *  evidence behind {@link noReplacementReason} — a zero here is the
   *  partner's answer, a zero after filtering is our own doing. */
  providerOptionCount?: number;
  /** The provider's own words when it declined to search — surfaced in the
   *  trace so a refusal is never silently read as "nothing available". */
  searchDeclinedReason?: string;
  /** Why the fare pricings failed, when they did. Present only alongside
   *  `pricing_unavailable`; the Activity Stream quotes it so a support
   *  question has an answer without re-running anything. */
  pricingFailureDetail?: string;
  /**
   * Present when the zero-abort ladder had to create an indicative recovery
   * option because provider inventory could not produce a priced candidate.
   * Synthetic inventory is never represented as an Atlas-confirmed offer.
   */
  fallbackReason?: string;
}

/** Per-call deadline for one fare-pricing call (Phase B robustness). */
const FARE_PRICING_DEADLINE_MS = 4_000;
/** Only the cheapest N search results are priced — bounds the provider fan-out. */
const MAX_PRICED_CANDIDATES = 5;
/**
 * Retained as a compatibility/export constant for trace consumers. It is no
 * longer an eligibility veto: a late viable flight is preferable to stranding
 * the traveller, and the downstream graph reflows around its real arrival.
 */
export const MAX_REBOOKING_WINDOW_HOURS = 48;

/** Default flexible-date search window (one provider search per calendar day). */
const DEFAULT_SEARCH_WINDOW_DAYS = 4;
/** Window bounds — the Atlas contract's flexible dates are agent-side. */
const MIN_SEARCH_WINDOW_DAYS = 1;
const MAX_SEARCH_WINDOW_DAYS = 7;
/** Early stop: enough usable replacements surfaced ⇒ no further dates. */
const EARLY_STOP_USABLE_COUNT = 3;

export interface FlightAgentConfig {
  /** Per-call fare-pricing deadline override (ms); <= 0 disables the cap. */
  fareDeadlineMs?: number;
  /** Max number of candidates priced (cheapest by fare first). */
  maxPricedCandidates?: number;
  /**
   * Flexible-date window length: how many consecutive calendar dates are
   * searched (one complete provider search per date) when a routeContext is
   * present. Defaults to {@link DEFAULT_SEARCH_WINDOW_DAYS}, clamped to 1..7.
   */
  searchWindowDays?: number;
  /**
   * W1 (additive): usable-replacement count that closes the flexible-date
   * window early. Defaults to {@link EARLY_STOP_USABLE_COUNT}; values below
   * 1 fall back to the default (an early stop at zero would skip every
   * date after the first).
   */
  earlyStopUsableCount?: number;
  /**
   * W1 (additive): WALL-CLOCK budget for the whole flexible-date window
   * (ms). Before each date beyond the first, the loop checks the elapsed
   * time and — once the budget is spent — truncates the window, returning
   * the best-so-far merged options instead of starting another provider
   * search. <= 0 (the default) disables the budget entirely.
   */
  overallDeadlineMs?: number;
}

/** Gap between sequential fare-pricing calls — keeps us under the provider's
 *  QPS limit without making a five-candidate assessment feel slow (~90ms per
 *  call, so five land in well under a second even with the spacing). */
const FARE_PRICING_GAP_MS = 120;
/** Backoff before the single retry of a retryable pricing failure. */
const FARE_PRICING_RETRY_MS = 400;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `Promise.allSettled` semantics for ONE promise. */
async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/**
 * Is this failure worth one more try?
 *
 * The provider's structured errors carry `retryable` (429/503/timeouts set it);
 * anything else — a malformed routing, a credential rejection — will fail
 * identically the second time and retrying only burns the deadline.
 */
function isRetryableFailure(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "retryable" in reason &&
    (reason as { retryable?: unknown }).retryable === true
  );
}

/**
 * Race a promise against a wall-clock deadline. Rejections (incl. the
 * deadline) propagate so {@link Promise.allSettled} can isolate per-call
 * failures without sinking the whole fan-out.
 */
function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fare pricing deadline exceeded (${deadlineMs}ms)`)),
      deadlineMs,
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

/**
 * Whether a search result can actually replace the disrupted leg.
 *
 * Two rejections, both from the same principle — a replacement the traveller
 * cannot board is not a replacement:
 *   • the exact departure being replaced (same flight number AND same
 *     departure instant). A LATER departure of the same number is fine, which
 *     is why the time is part of the match.
 *   • anything departing at or before `earliestDeparture`, set when the flight
 *     was MISSED: that aircraft has gone, and so has every earlier one.
 */
function isUsableReplacement(
  option: { flightNumber: string; departureTime: string },
  routeContext?: FlightRouteContext,
): boolean {
  const exclude = routeContext?.excludeFlight;
  if (exclude) {
    const sameNumber = flightNumbersMatch(option.flightNumber, exclude.flightNumber);
    const sameDeparture = Date.parse(option.departureTime) === Date.parse(exclude.departureTime);
    if (sameNumber && sameDeparture) return false;
  }
  const departs = Date.parse(option.departureTime);
  const earliest = routeContext?.earliestDeparture;
  if (earliest) {
    const floor = Date.parse(earliest);
    if (Number.isFinite(departs) && Number.isFinite(floor) && departs <= floor) return false;
  }
  return true;
}

/** "TR 892" and "TR892" are the same flight, as are "TO4516" and "4516". */
function flightNumbersMatch(fn1: string, fn2: string): boolean {
  const norm1 = fn1.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const norm2 = fn2.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (norm1 === norm2) return true;
  // Fallback: if the digits match and one is a suffix of the other (missing carrier code)
  return norm1.endsWith(norm2) || norm2.endsWith(norm1);
}

const HOUR_MS = 3_600_000;

/**
 * There is no last rung that invents a flight.
 *
 * There used to be: when the provider had no inventory, `synthesizeRecoveryCandidate`
 * fabricated one — a flight number, a real airline's name, a schedule and a
 * price — under a "zero-abort guarantee". A live battery of 42 missions showed
 * what that bought: 6 of the 11 flight-bearing plans rested on a flight that
 * does not exist, including "SQ912 · Singapore → London · 3h00 · £194".
 *
 * It also made the honest answer unreachable. `noReplacementReason` below is
 * only computed when `candidates.length === 0`, and the fabricated candidate
 * guaranteed that never happened — so `route_not_covered`, `search_declined`,
 * `pricing_unavailable` and `all_options_rejected`, the four-way verdict built
 * precisely to decide when we may name the partner, were dead code.
 *
 * An empty answer is now an empty answer, with the reason the provider's own
 * behaviour proves. Everything downstream already handles a flight-less plan:
 * `noReplacementHeadline`, `presentation.no_flight_reason`, the degraded
 * single-plan rail, and `noReplacementWording.test.ts` which pins that only
 * `route_not_covered` may say "partner".
 */

export class FlightAgent {
  private readonly fareDeadlineMs: number;
  private readonly maxPricedCandidates: number;
  private readonly searchWindowDays: number;
  private readonly earlyStopUsableCount: number;
  private readonly overallDeadlineMs: number;

  constructor(
    private readonly provider: FlightProvider | null,
    config: FlightAgentConfig = {},
  ) {
    this.fareDeadlineMs = config.fareDeadlineMs ?? FARE_PRICING_DEADLINE_MS;
    this.maxPricedCandidates = config.maxPricedCandidates ?? MAX_PRICED_CANDIDATES;
    const windowDays = Math.trunc(config.searchWindowDays ?? DEFAULT_SEARCH_WINDOW_DAYS);
    this.searchWindowDays = Number.isFinite(windowDays)
      ? Math.min(MAX_SEARCH_WINDOW_DAYS, Math.max(MIN_SEARCH_WINDOW_DAYS, windowDays))
      : DEFAULT_SEARCH_WINDOW_DAYS;
    const earlyStop = Math.trunc(config.earlyStopUsableCount ?? EARLY_STOP_USABLE_COUNT);
    this.earlyStopUsableCount =
      Number.isFinite(earlyStop) && earlyStop >= 1 ? earlyStop : EARLY_STOP_USABLE_COUNT;
    const deadline = config.overallDeadlineMs ?? 0;
    this.overallDeadlineMs = Number.isFinite(deadline) && deadline > 0 ? deadline : 0;
  }

  /** Which concrete provider backs this agent (useful for audit trails). */
  get providerName(): string {
    return this.provider?.providerName ?? "internal-recovery";
  }

  /**
   * Query the injected provider for alternative flights around `newTime` and
   * price them against `flightId`.
   *
   * NEW (additive): `routeContext` (origin/destination/date of the disrupted
   * leg) is forwarded to the provider search AND fare-pricing calls — real
   * route-based APIs (Atlas `search.do`) need it; id-based providers ignore
   * it.
   *
   * Flexible-date window: the Atlas contract searches ONE calendar date per
   * `search.do` call, so flexible dates are agent-side orchestration — when a
   * `routeContext` is present this runs ONE complete provider search per
   * calendar date over offsets 0..searchWindowDays-1 (anchored on
   * `routeContext.departureDate` ?? `newTime`, UTC-safe day arithmetic).
   * Options merge deduped by `option.id` (first occurrence wins); a per-date
   * rejection is skipped and never sinks the search. Total failure continues
   * to the internal indicative fallback instead of aborting. EARLY STOP: after each date, once
   * ≥ earlyStopUsableCount options pass {@link isUsableReplacement} against
   * the ORIGINAL routeContext the window closes. W1 WALL-CLOCK BUDGET: when
   * `overallDeadlineMs` is set, each date beyond the first is skipped once
   * the budget is spent — the window truncates and the best-so-far options
   * are returned. The attempted dates ride along
   * as the additive `searchedDates`. Without a `routeContext` the legacy
   * single search runs exactly as before.
   *
   * Phase B robustness: only the cheapest {@link MAX_PRICED_CANDIDATES}
   * options are priced, and the fare-difference calls fan out concurrently
   * via `Promise.allSettled`, each bounded by a ~4s deadline. A rejected or
   * timed-out candidate is EXCLUDED, never fatal — a slow sandbox can no
   * longer stall or sink the rebooking assessment.
   */
  async assessRebookingOptions(
    flightId: string,
    newTime: IsoTimestamp,
    routeContext?: FlightRouteContext,
  ): Promise<FlightRebookingAssessment> {
    let search: AlternativeFlightsResult;
    let searchedDates: string[] | undefined;
    /** Dates the provider genuinely LOOKED at — declines do not count. */
    let windowAnsweredDates: number | undefined;
    /** The upstream's own words when it declined, for the trace. */
    let windowDeclineReason: string | undefined;

    if (routeContext) {
      // Flexible-date window: one complete provider search per calendar date.
      const mergedOptions: FlightOption[] = [];
      const seenIds = new Set<string>();
      const dates: string[] = [];
      let searchRequestId: string | undefined;
      let succeeded = 0;
      let answeredDates = 0;
      let declineReason: string | undefined;
      let lastError: unknown;
      // UTC-safe day arithmetic: shift the base instant by whole 24h blocks
      // and re-emit the same ISO representation the provider formats upstream.
      const baseIso = routeContext.departureDate ?? newTime;
      const baseMs = Date.parse(baseIso);
      const dateFor = (offset: number): IsoTimestamp =>
        Number.isFinite(baseMs) ? new Date(baseMs + offset * 86_400_000).toISOString() : baseIso;
      // W1: the wall-clock anchor for the optional `overallDeadlineMs` budget.
      const windowStartedAt = Date.now();

      if (this.provider === null) declineReason = "flight provider is not configured";

      for (let offset = 0; this.provider !== null && offset < this.searchWindowDays; offset += 1) {
        // W1 wall-clock budget: BEFORE each additional date, check the
        // elapsed time — once spent, truncate the window and return the
        // best-so-far merged options (the first date always runs so the
        // search can never silently return nothing on a deadline).
        if (
          offset > 0 &&
          this.overallDeadlineMs > 0 &&
          Date.now() - windowStartedAt >= this.overallDeadlineMs
        ) {
          break;
        }
        const datedContext: FlightRouteContext = {
          ...routeContext,
          departureDate: dateFor(offset),
        };
        dates.push((datedContext.departureDate ?? baseIso).slice(0, 10));
        try {
          const dated = await this.provider.searchAlternativeFlights(
            flightId,
            newTime,
            datedContext,
          );
          succeeded += 1;
          // A date the provider DECLINED (past date, upstream refusal) proves
          // nothing about coverage — count only the dates it actually looked at.
          if (dated.searchWasAnswered !== false) answeredDates += 1;
          else if (declineReason === undefined && dated.searchDeclinedReason) {
            declineReason = dated.searchDeclinedReason;
          }
          // Carry the FIRST non-undefined correlation id across dates.
          if (searchRequestId === undefined && dated.atlasSearchRequestId !== undefined) {
            searchRequestId = dated.atlasSearchRequestId;
          }
          for (const option of dated.options) {
            if (!seenIds.has(option.id)) {
              seenIds.add(option.id);
              mergedOptions.push(option);
            }
          }
        } catch (error) {
          // Per-date failure never sinks the search — skip the date.
          lastError = error;
          continue;
        }
        // Early stop: usability is measured against the ORIGINAL routeContext
        // (the dated clones only shift the search day, not the exclusions).
        const usableCount = mergedOptions.filter((option) =>
          isUsableReplacement(option, routeContext),
        ).length;
        if (usableCount >= this.earlyStopUsableCount) break;
      }

      // Total provider failure is not a graph failure. Preserve its reason and
      // continue with an empty search; the deterministic synthesizer below is
      // the final rung of the recovery ladder.
      if (succeeded === 0 && lastError !== undefined) {
        declineReason = lastError instanceof Error ? lastError.message : String(lastError);
      }

      windowAnsweredDates = answeredDates;
      windowDeclineReason = declineReason;
      search = {
        referenceFlightId: flightId,
        requestedTime: newTime,
        options: mergedOptions,
        searchWasAnswered: answeredDates > 0,
        ...(declineReason !== undefined ? { searchDeclinedReason: declineReason } : {}),
        ...(searchRequestId !== undefined ? { atlasSearchRequestId: searchRequestId } : {}),
      };
      searchedDates = dates;
    } else {
      search = this.provider
        ? await this.provider.searchAlternativeFlights(flightId, newTime, routeContext)
        : {
            referenceFlightId: flightId,
            requestedTime: newTime,
            options: [],
            searchWasAnswered: false,
            searchDeclinedReason: "flight provider is not configured",
          };
    }

    // A REPLACEMENT has to be a different departure. Route searches return the
    // disrupted flight among the results, and nothing downstream removed it —
    // so a "missed flight" mission proposed the very flight that was missed,
    // identical number and time, with a change fee attached.
    // Counted separately on purpose. "The partner had nothing" and "the partner
    // had flights we rejected" look identical once the array is empty, and the
    // traveller is owed a different sentence for each.
    const providerOptionCount = search.options.length;
    const usableOptions = [...search.options].filter((option) =>
      isUsableReplacement(option, routeContext),
    );
    const options = usableOptions
      // Cap the fan-out at the cheapest options by published fare.
      .sort((a, b) => a.price - b.price)
      .slice(0, Math.max(0, Math.trunc(this.maxPricedCandidates)));

    // SEQUENTIAL, not a fan-out. Verified against the live Atlas sandbox on
    // 2026-09-02: five concurrent `verify.do` calls return HTTP 429 — all five
    // of them. Every candidate was then dropped as unpriceable, and the
    // traveller was told "we found flights but couldn't price them" on route
    // after route, while the very same calls made one at a time all succeeded
    // in ~90ms each. The provider rate-limits per QPS (its own error taxonomy
    // documents a `110 QPS` business status), so the parallel `allSettled`
    // fan-out was guaranteeing the failure it then reported.
    //
    // One retry on a retryable failure, too: `RETRYABLE_HTTP_STATUSES` has
    // flagged 429 as retryable all along and nothing ever acted on the flag.
    const settled: Array<PromiseSettledResult<FareDifference>> = [];
    for (const [index, option] of options.entries()) {
      if (this.provider === null) break;
      // Space the calls out enough to stay under the provider's rate limit.
      if (index > 0) await delay(FARE_PRICING_GAP_MS);
      let attempt: PromiseSettledResult<FareDifference> = await settle(
        withDeadline(
          this.provider.calculateFareDifference(flightId, option.id, routeContext),
          this.fareDeadlineMs,
        ),
      );
      if (attempt.status === "rejected" && isRetryableFailure(attempt.reason)) {
        await delay(FARE_PRICING_RETRY_MS);
        attempt = await settle(
          withDeadline(
            this.provider.calculateFareDifference(flightId, option.id, routeContext),
            this.fareDeadlineMs,
          ),
        );
      }
      settled.push(attempt);
    }

    const candidates: RebookingCandidate[] = [];
    /** Why each pricing failed — see the logging note below. */
    const pricingFailures: string[] = [];
    /** How many candidates fell back to the search's published price. */
    let referencePriced = 0;
    settled.forEach((result, index) => {
      const option = options[index];
      if (result.status === "fulfilled") {
        candidates.push({ option, fareDifference: result.value });
        return;
      }
      // The re-price failed — but the SEARCH already published a real price for
      // this flight, and throwing the flight away over a rate-limited
      // confirmation call is how a traveller ended up being told no flight
      // existed while the provider was listing fifteen.
      //
      // Only for RETRYABLE failures (429, timeouts): those say "ask again
      // later", not "this flight is wrong". A permanent rejection still drops
      // the candidate, because there the provider is telling us something real.
      if (option && isRetryableFailure(result.reason) && option.price > 0) {
        referencePriced += 1;
        candidates.push({
          option,
          fareDifference: {
            oldFlightId: flightId,
            newFlightId: option.id,
            amount: option.price,
            currency: option.currency,
            direction: "charge",
            // NOT verified. The Trust Layer must say so.
            basis: "search_reference",
            adults: routeContext?.adults ?? 1,
          },
        });
      }
      // A rejected pricing still degrades to the remaining candidates rather
      // than failing the assessment — but it is no longer SILENT. When every
      // pricing rejects, the traveller is told "we found flights but couldn't
      // price them", and with nothing logged there was no way to tell whether
      // that meant a provider outage, a deadline, or the Worker's subrequest
      // cap. That question cost a full debugging session; the answer belongs
      // in the logs the first time it happens.
      const reason = result.reason;
      pricingFailures.push(
        `${option?.flightNumber ?? option?.id ?? `#${index}`}: ` +
          `${reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)}`,
      );
    });
    if (pricingFailures.length > 0) {
      console.warn(
        `[flight] ${pricingFailures.length}/${options.length} fare pricings failed ` +
          `(${referencePriced} kept at the search's published price) — ` +
          pricingFailures.slice(0, 5).join(" | "),
      );
    }

    // What the provider's own behaviour says about an empty result — recorded
    // for the trace and the incident line. It no longer gates a fabricated
    // candidate; it simply explains the emptiness.
    let fallbackReason: string | undefined;
    if (candidates.length === 0) {
      fallbackReason =
        windowDeclineReason ??
        search.searchDeclinedReason ??
        (providerOptionCount === 0
          ? "provider returned no inventory after the broadened date search"
          : usableOptions.length === 0
            ? "provider options had already departed"
            : "provider options could not be re-priced");
    }

    // Best = smallest net outlay: charges add, refunds subtract.
    let bestCandidate: RebookingCandidate | null = null;
    let bestNet = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const { amount, direction } = candidate.fareDifference;
      const net = direction === "charge" ? amount : -amount;
      if (net < bestNet) {
        bestNet = net;
        bestCandidate = candidate;
      }
    }

    // Additive liveness aggregation (passed through untouched): the search
    // correlation id plus every fulfilled verify.do id, in candidate order.
    // Omitted entirely when the provider surfaced no ids (non-Atlas rails,
    // degraded runs) so the trace proof stays honest.
    const verifyRequestIds = candidates
      .map((candidate) => candidate.fareDifference.atlasRequestId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const searchRequestId = search.atlasSearchRequestId;
    const atlasCorrelation =
      searchRequestId !== undefined || verifyRequestIds.length > 0
        ? {
            ...(searchRequestId !== undefined ? { searchRequestId } : {}),
            verifyRequestIds,
          }
        : undefined;

    // Only reached when the provider ANSWERED — a search that failed outright
    // throws above, so an empty result here is a real answer, not an outage.
    let noReplacementReason: NoReplacementReason | undefined;
    if (candidates.length === 0) {
      // Dates the provider actually LOOKED at. `searchedDates` counts dates we
      // ASKED about, and the two diverge whenever Atlas declines — which is
      // precisely when a coverage claim would be wrong.
      const answeredDates =
        windowAnsweredDates ?? (search.searchWasAnswered === false ? 0 : 1);
      if (answeredDates === 0) {
        noReplacementReason = "search_declined";
      } else if (providerOptionCount === 0) {
        // Several distinct dates it really examined, every one empty ⇒ the
        // partner does not serve this route. One date cannot tell coverage from
        // availability, so it gets the weaker verdict and claims neither.
        noReplacementReason = answeredDates >= 2 ? "route_not_covered" : "no_options_on_date";
      } else if (usableOptions.length === 0) {
        noReplacementReason = "all_options_rejected";
      } else {
        noReplacementReason = "pricing_unavailable";
      }
    }

    return {
      originalFlightId: flightId,
      requestedTime: newTime,
      candidates,
      bestCandidate,
      providerOptionCount,
      ...(atlasCorrelation !== undefined ? { atlasCorrelation } : {}),
      ...(searchedDates !== undefined ? { searchedDates } : {}),
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
      ...(pricingFailures.length > 0
        ? { pricingFailureDetail: pricingFailures.slice(0, 3).join(" | ") }
        : {}),
      ...(noReplacementReason !== undefined
        ? {
            noReplacementReason,
            ...(windowDeclineReason !== undefined
              ? { searchDeclinedReason: windowDeclineReason }
              : search.searchDeclinedReason !== undefined
                ? { searchDeclinedReason: search.searchDeclinedReason }
                : {}),
          }
        : {}),
    };
  }
}
