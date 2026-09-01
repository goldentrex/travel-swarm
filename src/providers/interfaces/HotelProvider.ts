/**
 * Provider-agnostic hotel operations contract.
 *
 * The agent layer (HotelAgent / OrchestratorAgent) depends ONLY on this
 * interface — never on a concrete implementation. Today the sole implementor
 * is `RapidApiHotelProvider` (Booking.com via RapidAPI); other adapters can
 * be dropped in later without touching any agent code.
 */

import type {
  HotelPolicies,
  HotelRoomSearchQuery,
  HotelRoomSearchResult,
  IsoTimestamp,
} from "./types";

export interface HotelProvider {
  /** Human-readable provider name, e.g. "rapidapi-booking". */
  readonly providerName: string;

  /**
   * Fetch the property's disruption-relevant policies: whether a late
   * check-in at the shifted time is feasible and what cancelling now costs.
   *
   * `cancellationFee` is 0 while the free-cancellation window is still open.
   */
  getHotelPolicies(
    hotelName: string,
    checkIn: IsoTimestamp,
    guests: number,
  ): Promise<HotelPolicies>;

  /**
   * Search alternative rooms / rates the traveller could move to when the
   * current reservation cannot be protected.
   */
  searchAlternativeRooms(query: HotelRoomSearchQuery): Promise<HotelRoomSearchResult>;
}
