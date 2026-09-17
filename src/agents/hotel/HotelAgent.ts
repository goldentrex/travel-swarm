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
    const degradedAssessment: HotelAssessment = {
      hotelNodeId: request.hotelNodeId,
      lateCheckInAvailable: false,
      cancellationFee: 0,
      currency: "USD",
      alternativeRooms: [],
      recommendation: "keep_as_is",
      feeDelta: 0,
      degraded: true,
      note: "Hotel policy could not be verified. Contact the property to confirm availability, late arrival and any fees before changing this booking.",
    };

    let policyUnknown = false;
    let policies;
    try {
      policies = await this.provider.getHotelPolicies(
        request.hotelName,
        request.shiftedCheckIn,
        request.guests,
      );
    } catch {
      policyUnknown = true;
      policies = { hotelName: request.hotelName, lateCheckInAvailable: false, cancellationFee: 0, currency: "USD" };
    }

    // Alternative rooms are only needed when the late check-in cannot be held.
    let alternativeRooms: HotelAssessment["alternativeRooms"] = [];
    if (!policies.lateCheckInAvailable || request.isOverbooked) {
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

    if (policyUnknown) return { ...degradedAssessment, alternativeRooms };

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
        recommendation === "keep_late_checkin"
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
