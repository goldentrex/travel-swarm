/**
 * HotelAgent — hotel-reservation protection specialist (spec §2.2, §3.3).
 *
 * Given a hotel_check_in node whose check-in time was shifted by
 * `ItineraryGraph.handleDisruption`, it asks the injected {@link HotelProvider}
 * (RapidAPI Booking.com today) whether a late check-in is feasible, what
 * cancelling would cost, and which alternative rooms exist — then emits a
 * deterministic {@link HotelAssessment}.
 *
 * Deterministic provider calls + deterministic fee math (spec): every
 * provider failure degrades to a conservative "late check-in accepted at no
 * cost" assessment instead of throwing, so hotel protection never sinks the
 * whole recovery plan (spec §4.1 degradation policy).
 */

import type { HotelProvider } from "@/providers/interfaces/HotelProvider";
import type { IsoTimestamp } from "@/providers/interfaces/types";
import { hotelQuotaExhausted } from "@/providers/rapidapi/hotelQuota";

/** Request shape per spec §3.3. */
export interface HotelImpactRequest {
  /** Graph node id, e.g. "hotel-checkin". */
  hotelNodeId: string;
  hotelName: string;
  originalCheckIn: IsoTimestamp;
  /** Post-handleDisruption scheduledTime. */
  shiftedCheckIn: IsoTimestamp;
  guests: number;
  isOverbooked?: boolean;
  /**
   * The TRIP's currency, so a replacement room is quoted in the money the
   * traveller is already counting in.
   *
   * Without it the search fell back to a hard-coded USD, and a live mission
   * on a JPY trip in Tokyo came back offering a room at "97.07 USD" — a
   * real rate, in a currency nothing else on that plan used. The engine has
   * a tier-1 check against exactly that mixture.
   */
  currency?: string;
}

/** Output shape per spec §3.3 (+ agent-layer `degraded` / `note` markers). */
export interface HotelAssessment {
  hotelNodeId: string;
  lateCheckInAvailable: boolean;
  /** 0 if the free-cancellation window is still open. */
  cancellationFee: number;
  currency: string;
  alternativeRooms: {
    roomId: string;
    /** Property name of the alternative (may differ from the original). */
    hotelName?: string;
    ratePerNight: number;
    currency?: string;
    freeCancellationUntil?: IsoTimestamp;
    /** NEW (additive) — property photos surfaced best-effort (max 4). */
    images?: string[];
    /** NEW (additive) — property coordinates when the provider exposes them. */
    latitude?: number;
    longitude?: number;
  }[];
  recommendation: "keep_late_checkin" | "rebook_room" | "keep_as_is";
  /** Net hotel-side cost change (feeds financial_delta via hotel_adjustments). */
  feeDelta: number;
  /** Agent-layer extension: true when provider data was unavailable. */
  degraded?: boolean;
  /** Agent-layer extension: human-readable rationale, display-only. */
  note?: string;
}

export class HotelAgent {
  constructor(private readonly provider: HotelProvider) {}

  /** Which concrete provider backs this agent (useful for audit trails). */
  get providerName(): string {
    return this.provider.providerName;
  }

  async assessHotelImpact(request: HotelImpactRequest): Promise<HotelAssessment> {
    // Unknown policy must not promise that a room is held or fees are zero.
    // Zero here means no verified charge is added; the proposal flags follow-up.
    //
    // WHY the note is chosen rather than fixed: a bare catch told every
    // traveller "Hotel policy could not be verified — contact the property",
    // which sends them to argue with a hotel that has done nothing wrong when
    // the truth is that OUR data plan ran out of requests for the month.
    // Verified live on 2026-09-18: the gateway answered
    // `429 You have exceeded the MONTHLY quota … BASIC` and every hotel
    // verdict in a 42-mission battery degraded with that same misleading
    // sentence. Blaming someone else for our own blindness is the failure
    // mode this whole layer exists to avoid.
    const buildDegraded = (note: string): HotelAssessment => ({
      hotelNodeId: request.hotelNodeId,
      lateCheckInAvailable: false,
      cancellationFee: 0,
      currency: request.currency ?? "USD",
      alternativeRooms: [],
      recommendation: "keep_as_is",
      feeDelta: 0,
      degraded: true,
      note,
    });
    /**
     * The room is gone and we found nothing to put in its place.
     *
     * It names the remedy the traveller is actually owed. Walking a confirmed
     * booking obliges the property to rehouse at its own cost nearly
     * everywhere it happens, and a traveller who does not know that tends to
     * pay twice.
     */
    const NO_REPLACEMENT_NOTE =
      "We could not find a comparable room for these dates. Your other bookings are untouched. " +
      "Ask the property to rehouse you — walking a confirmed booking obliges them to find and pay " +
      "for a comparable room.";
    const UNVERIFIED_NOTE =
      "Hotel policy could not be verified. Contact the property to confirm availability, late arrival and any fees before changing this booking.";
    const OUTAGE_NOTE =
      "We couldn't reach our hotel data provider, so this room's terms are unchecked — not a problem with the property. Your booking is untouched; confirm a late arrival with them if you want certainty.";

    let policyUnknown = false;
    let degradedNote = UNVERIFIED_NOTE;
    let policies;
    try {
      policies = await this.provider.getHotelPolicies(
        request.hotelName,
        request.shiftedCheckIn,
        request.guests,
      );
    } catch {
      policyUnknown = true;
      // The provider records a quota refusal when it sees one, so the honest
      // sentence is available without spending another request to ask.
      if (hotelQuotaExhausted()) degradedNote = OUTAGE_NOTE;
      // The policy lookup is what usually NAMES the currency. When it fails
      // the trip's own is the next best truth, and far better than a
      // hard-coded one: a fallback should not change the money a traveller
      // reads.
      policies = {
        hotelName: request.hotelName,
        lateCheckInAvailable: false,
        cancellationFee: 0,
        currency: request.currency ?? "USD",
      };
    }
    const degradedAssessment = buildDegraded(degradedNote);

    // Alternative rooms are only needed when the late check-in cannot be held.
    //
    // "We could not read the policy" is NOT "the property will not hold the
    // room". The degraded branch sets `lateCheckInAvailable: false` because it
    // must not PROMISE a late arrival — but treating that as a refusal sent us
    // shopping for a replacement on every failed policy read, and the rooms
    // came back attached to a verdict of `keep_as_is`. The traveller then saw
    // a different hotel presented as their new plan under a line saying "no
    // change needed", and we spent two provider calls to produce it.
    //
    // So: search when we KNOW the room cannot be held, or when it is gone.
    // Not when we simply could not ask.
    let alternativeRooms: HotelAssessment["alternativeRooms"] = [];
    if ((!policyUnknown && !policies.lateCheckInAvailable) || request.isOverbooked) {
      try {
        const search = await this.provider.searchAlternativeRooms({
          hotelName: request.hotelName,
          checkIn: request.shiftedCheckIn,
          nights: nightsBetween(request.originalCheckIn, request.shiftedCheckIn),
          guests: request.guests,
          currency: policies.currency,
        });
        alternativeRooms = search.rooms.map((room) => ({
          roomId: room.roomId,
          hotelName: room.hotelName,
          ratePerNight: room.ratePerNight,
          currency: room.currency,
          ...(room.freeCancellationUntil
            ? { freeCancellationUntil: room.freeCancellationUntil }
            : {}),
          // Additive presentation feed — photos + coordinates, best-effort.
          ...(room.images && room.images.length > 0 ? { images: room.images } : {}),
          ...(room.latitude !== undefined ? { latitude: room.latitude } : {}),
          ...(room.longitude !== undefined ? { longitude: room.longitude } : {}),
        }));
      } catch {
        // No alternatives is survivable — the recommendation logic below
        // falls back to keep_as_is.
      }
    }

    if (policyUnknown) {
      // A degraded verdict on an overbooking must still name the situation:
      // the generic note talks about confirming a LATE ARRIVAL, which is not
      // what a walked traveller needs to hear.
      if (request.isOverbooked && alternativeRooms.length === 0) {
        return { ...degradedAssessment, alternativeRooms, note: NO_REPLACEMENT_NOTE };
      }
      return { ...degradedAssessment, alternativeRooms };
    }

    // Deterministic recommendation ladder:
    //  1. Late check-in feasible (and not overbooked) → protect the existing
    //     reservation (free).
    //  2. Not feasible, or the property overbooked the room → rebook into a
    //     replacement IF one was found, whatever the cancellation fee (an
    //     overbooked traveller has no room to "keep" — paying the fee is
    //     still better than arriving to no bed).
    //  3. Not feasible and no replacement was found → keep the booking
    //     as-is and let the property handle the late arrival (most hotels
    //     hold rooms past the standard 3 pm slot).
    const recommendation: HotelAssessment["recommendation"] =
      !policies.lateCheckInAvailable || request.isOverbooked
        ? alternativeRooms.length > 0
          ? "rebook_room"
          : "keep_as_is"
        : "keep_late_checkin";

    // Fee math: only the rebook path moves money on the hotel side, and the
    // cancellation fee is the only provider-grounded amount we have (the
    // original room rate is not part of the graph node schema).
    const feeDelta = recommendation === "rebook_room" ? Math.max(0, policies.cancellationFee) : 0;

    return {
      hotelNodeId: request.hotelNodeId,
      lateCheckInAvailable: policies.lateCheckInAvailable,
      cancellationFee: Math.max(0, policies.cancellationFee),
      currency: policies.currency,
      alternativeRooms,
      recommendation,
      feeDelta,
      note:
        // An overbooked traveller with no replacement found must not be left
        // with a blank row. "keep_as_is" is honest about OUR side — we
        // changed nothing — but on its own it reads as "all fine", which is
        // the opposite of the situation.
        request.isOverbooked && recommendation !== "rebook_room"
          ? NO_REPLACEMENT_NOTE
          : recommendation === "keep_late_checkin"
            ? "Late Check-in (confirmed)"
            : policies.freeCancellationUntil
              ? `Free cancellation until ${policies.freeCancellationUntil}.`
              : undefined,
    };
  }
}

// ------------------------------------------------------------------ internals

/** Stay length estimate: at least 1 night, grown when check-in moves a day. */
function nightsBetween(original: IsoTimestamp, shifted: IsoTimestamp): number {
  const originalMs = Date.parse(original);
  const shiftedMs = Date.parse(shifted);
  if (Number.isNaN(originalMs) || Number.isNaN(shiftedMs)) return 1;
  const daysShifted = Math.floor((shiftedMs - originalMs) / (24 * 60 * 60 * 1000));
  return Math.max(1, 1 + daysShifted);
}
