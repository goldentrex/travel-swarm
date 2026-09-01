/**
 * Real provider data for the booking trust layer.
 *
 * The sheet that asks a traveler to confirm "book these for me" has to show
 * what is actually true: the real property and its real nightly rate, the real
 * Viator product and its real price, and — where nothing real can be had — say
 * so rather than showing the planner's estimate as though a provider had
 * quoted it.
 *
 * The CLIENT decides what is bookable and what the swarm may handle: iOS's
 * `BookingChecklist` already does that classification, and duplicating it here
 * would guarantee the two drift apart. This module only ENRICHES the lines it
 * is handed, and answers per line so one dead provider can never blank the
 * whole sheet.
 *
 * Nothing here books anything. The swarm records a reservation in the
 * traveler's own trip; no provider is asked to sell, and no payment exists.
 */

import {
  RapidApiHotelProvider,
  ViatorActivityProvider,
  rapidApiHotelConfigured,
  viatorEdgeConfigured,
} from "@/providers";
import type { ActivityProvider, HotelProvider } from "@/providers";

/** One line the client wants priced, as it appears in its own checklist. */
export interface PreviewLineRequest {
  /** Opaque client id — echoed back so the sheet can match rows up. */
  id: string;
  kind: "stay" | "activity" | "transport" | "dining";
  title: string;
  /** The city this line sits in — a multi-city trip must not search the wrong one. */
  city?: string;
  /** Stays: ISO check-in and the number of nights. */
  checkIn?: string;
  nights?: number;
  guests?: number;
  /** Activities: the day it happens on (ISO date). */
  date?: string;
  /** The planner's own estimate, so the answer can say how the real price compares. */
  estimate?: number;
  /** The currency THIS LINE's estimate is denominated in (items keep their own
   *  local currency: a Tokyo hotel is priced in JPY on the timeline). */
  currency?: string;
}

/** Where a price came from. The sheet MUST show this — an estimate presented
 *  as a quote is the whole problem this endpoint exists to solve. */
export type PriceSource = "live_provider" | "trip_estimate" | "unknown";

export interface PreviewLine {
  id: string;
  priceSource: PriceSource;
  /** Present only when a real provider answered. */
  price?: number;
  currency?: string;
  /** The provider that answered, named for the traveler ("Booking.com"). */
  provider?: string;
  /** The real property / product name, when it differs from the planned one. */
  matchedName?: string;
  /** Free cancellation deadline, when the provider publishes one. */
  freeCancellationUntil?: string;
  /** Set when the swarm cannot record this line — and why, in plain words. */
  unavailableReason?: string;
}

export interface BookingPreview {
  lines: PreviewLine[];
  /** Providers that answered at all this run — the sheet says what it used. */
  providersUsed: string[];
  /** Providers that were asked but could not answer. */
  providersDegraded: string[];
}

/**
 * Ceilings so one preview cannot exhaust the Worker's subrequest budget
 * (Cloudflare free plan: 50 per invocation, shared with everything else this
 * request does — trip hydration and the ownership check included).
 *
 * Measured per lookup on 2026-09-01: a stay costs TWO subrequests (resolve the
 * property, then search), an activity costs one. Worst case here is
 * 6×2 + 14×1 = 26, leaving ample room under 50.
 *
 * The old flat 6 was far too tight: a five-day Paris trip has 14 activities, so
 * half the sheet came back unpriced while the total silently omitted them.
 */
const MAX_STAY_LOOKUPS = 6;
const MAX_ACTIVITY_LOOKUPS = 14;

/** Activity lookups run in bounded-concurrency batches: the subrequest count is
 *  identical, but 14 serial Viator calls made the traveler wait ~25s. */
const ACTIVITY_BATCH = 4;

/**
 * Fall back to the trip's own figure — or, when the trip has none either, say
 * plainly that the line has no price at all.
 *
 * `reason` describes why the LIVE lookup did not happen or did not land. It is
 * written for the case where an estimate survives ("shown as planned"), so it
 * must not be shown verbatim when there is nothing to show: `noEstimateReason`
 * carries the wording for that case. Getting this wrong put "Shown as planned"
 * under rows displaying no price whatsoever.
 */
function estimateLine(
  line: PreviewLineRequest,
  reason?: string,
  noEstimateReason?: string,
): PreviewLine {
  const hasEstimate = typeof line.estimate === "number";
  const shown = hasEstimate ? reason : (noEstimateReason ?? reason);
  return {
    id: line.id,
    priceSource: hasEstimate ? "trip_estimate" : "unknown",
    ...(hasEstimate ? { price: line.estimate } : {}),
    ...(line.currency ? { currency: line.currency } : {}),
    ...(shown ? { unavailableReason: shown } : {}),
  };
}

/**
 * True when an ISO date is strictly before today (UTC).
 *
 * A past date is not a provider failure. Booking.com throws on a check-in that
 * has gone by and Viator has no availability to return, and the sheet then told
 * the traveler "the live rate could not be checked just now" — blaming a
 * transient outage for something that will never succeed.
 */
function hasAlreadyPassed(date: string | undefined): boolean {
  if (!date) return false;
  const day = Date.parse(`${date.slice(0, 10)}T23:59:59Z`);
  return Number.isFinite(day) && day < Date.now();
}

async function priceStay(
  provider: HotelProvider,
  line: PreviewLineRequest,
  quoteCurrency?: string,
): Promise<PreviewLine> {
  if (!line.checkIn) return estimateLine(line, "No check-in date to price against.");
  if (hasAlreadyPassed(line.checkIn)) {
    return estimateLine(
      line,
      "Shown as planned — this stay is in the past.",
      "Not priced — this stay is in the past.",
    );
  }
  try {
    const result = await provider.searchAlternativeRooms({
      hotelName: line.title,
      checkIn: line.checkIn,
      nights: Math.max(1, line.nights ?? 1),
      guests: Math.max(1, line.guests ?? 2),
      ...(quoteCurrency ?? line.currency
        ? { currency: (quoteCurrency ?? line.currency) as string }
        : {}),
    });
    const best = result.rooms?.[0];
    if (!best) return estimateLine(line, "No live rate found for these dates.");
    const nights = Math.max(1, line.nights ?? 1);
    return {
      id: line.id,
      priceSource: "live_provider",
      price: Math.round(best.ratePerNight * nights * 100) / 100,
      currency: best.currency,
      provider: "Booking.com",
      matchedName: best.hotelName,
      ...(best.freeCancellationUntil ? { freeCancellationUntil: best.freeCancellationUntil } : {}),
    };
  } catch (error) {
    console.warn(`[booking-preview] hotel lookup failed for "${line.title}":`, error);
    return estimateLine(line, "The live rate could not be checked just now.");
  }
}

async function priceActivity(
  provider: ActivityProvider,
  line: PreviewLineRequest,
  quoteCurrency?: string,
): Promise<PreviewLine> {
  if (hasAlreadyPassed(line.date)) {
    return estimateLine(
      line,
      "Shown as planned — this day has already passed.",
      "Not priced — this day has already passed.",
    );
  }
  try {
    const result = await provider.searchActivities({
      query: line.title,
      ...(line.city ? { location: line.city } : {}),
      ...(line.date ? { dateFrom: line.date, dateTo: line.date } : {}),
      ...(quoteCurrency ?? line.currency
        ? { currency: (quoteCurrency ?? line.currency) as string }
        : {}),
      count: 1,
      settingPreference: "any",
    });
    const best = result.options?.[0];
    if (!best || typeof best.price !== "number") {
      return estimateLine(line, "No live listing matched this experience.");
    }
    return {
      id: line.id,
      priceSource: "live_provider",
      price: best.price,
      currency: best.currency ?? quoteCurrency ?? line.currency ?? "EUR",
      provider: "Viator",
      ...(best.name && best.name !== line.title ? { matchedName: best.name } : {}),
    };
  } catch {
    return estimateLine(line, "The listing could not be checked just now.");
  }
}

/**
 * Price every line, within each provider's measured subrequest budget.
 *
 * Stays are serial (two subrequests each); activities run in small concurrent
 * batches — same subrequest count, far less waiting.
 *
 * `quoteCurrency` is the currency the SHEET is denominated in — the traveler's
 * display currency. Every provider is asked to quote in it, so the confirm
 * screen can state one total in one currency. Without it each provider answers
 * in its own (a Tokyo hotel in JPY, a Viator product in USD) and the traveler
 * is shown three separate totals for one purchase. It is deliberately NOT
 * `line.currency`: that stays the estimate's own local denomination.
 */
export async function buildBookingPreview(
  lines: PreviewLineRequest[],
  quoteCurrency?: string,
): Promise<BookingPreview> {
  const hotelProvider = rapidApiHotelConfigured() ? new RapidApiHotelProvider() : null;
  const activityProvider = viatorEdgeConfigured() ? new ViatorActivityProvider() : null;

  const used = new Set<string>();
  const degraded = new Set<string>();
  if (!hotelProvider) degraded.add("Booking.com");
  if (!activityProvider) degraded.add("Viator");

  // Answers are written back by INDEX so the reply keeps the caller's order —
  // the sheet matches rows by id, and a reordered reply would still be correct
  // but far harder to reason about when reading a captured payload.
  const out: PreviewLine[] = new Array(lines.length);
  const activityWork: Array<{ index: number; line: PreviewLineRequest }> = [];

  let stayLookups = 0;
  let activityBudget = 0;

  for (const [index, line] of lines.entries()) {
    if (line.kind === "stay") {
      if (!hotelProvider) {
        out[index] = estimateLine(line, "Live rates are unavailable right now.");
        continue;
      }
      if (stayLookups >= MAX_STAY_LOOKUPS) {
        out[index] = estimateLine(
          line,
          "Shown as planned — too many stays to price at once.",
          "Not priced — too many stays to check in one go.",
        );
        continue;
      }
      stayLookups += 1;
      // Stays stay serial: two subrequests each, and the property resolution is
      // the heaviest call in the whole preview.
      const priced = await priceStay(hotelProvider, line, quoteCurrency);
      if (priced.priceSource === "live_provider") used.add("Booking.com");
      else degraded.add("Booking.com");
      out[index] = priced;
      continue;
    }

    if (line.kind === "activity") {
      if (!activityProvider) {
        out[index] = estimateLine(line, "Live listings are unavailable right now.");
        continue;
      }
      if (activityBudget >= MAX_ACTIVITY_LOOKUPS) {
        out[index] = estimateLine(
          line,
          "Shown as planned — too many activities to price at once.",
          "Not priced — too many activities to check in one go.",
        );
        continue;
      }
      activityBudget += 1;
      activityWork.push({ index, line });
      continue;
    }

    // Flights are already priced by the rail that quoted them, and a table is
    // not inventory anyone sells — both keep the trip's own figure.
    out[index] = estimateLine(line);
  }

  for (let i = 0; i < activityWork.length; i += ACTIVITY_BATCH) {
    const batch = activityWork.slice(i, i + ACTIVITY_BATCH);
    const priced = await Promise.all(
      batch.map(({ line }) => priceActivity(activityProvider as ActivityProvider, line, quoteCurrency)),
    );
    priced.forEach((answer, offset) => {
      if (answer.priceSource === "live_provider") used.add("Viator");
      else degraded.add("Viator");
      out[batch[offset].index] = answer;
    });
  }

  return {
    lines: out,
    providersUsed: [...used],
    // A provider that answered for one line and failed for another is not
    // "degraded" overall — only report the ones that never came through.
    providersDegraded: [...degraded].filter((p) => !used.has(p)),
  };
}
