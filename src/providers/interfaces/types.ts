/**
 * Shared DTO types for the provider abstraction layer.
 *
 * Every concrete provider (Atlas / ATRIP Sandbox today, Amadeus and Duffel in
 * the future) speaks its own wire format, but MUST map responses into these
 * canonical types so that the agent layer stays provider-agnostic.
 */

/** ISO-8601 timestamp string, e.g. "2026-08-19T14:30:00Z". */
export type IsoTimestamp = string;

/** ISO-4217 currency code, e.g. "USD", "EUR", "CNY". */
export type CurrencyCode = string;

/** IATA airport / city code, e.g. "BKI", "SIN". */
export type AirportCode = string;

/** A bookable flight option returned by a provider search. */
/**
 * ONE flown hop inside a {@link FlightOption}. A SIN → CTS itinerary with a
 * connection is two segments (SIN → TPE, TPE → CTS); a non-stop is one.
 *
 * Times are ISO-8601 as the provider quoted them. The trip document stores
 * LOCAL wall-clock stamps instead, so whatever writes these onto a leg must
 * convert — the airport's own clock is what a traveller reads off a boarding
 * pass.
 */
export interface FlightSegment {
  carrier?: string;
  /** Flight number of THIS hop — "VY8462", not the itinerary's headline ref. */
  flightNumber?: string;
  origin: AirportCode;
  destination: AirportCode;
  departureTime: IsoTimestamp;
  arrivalTime: IsoTimestamp;
}

export interface FlightOption {
  /** Provider-specific flight / offer id. */
  id: string;
  /** Operating airline name, e.g. "AirAsia". */
  airline: string;
  /** Marketing flight number, e.g. "XY999". */
  flightNumber: string;
  origin: AirportCode;
  destination: AirportCode;
  departureTime: IsoTimestamp;
  arrivalTime: IsoTimestamp;
  /** Total fare for one passenger, in `currency`. */
  price: number;
  currency: CurrencyCode;
  /**
   * NEW (additive) — number of stops: 0 for a non-stop. Absent when the
   * provider's envelope does not describe the segments, so the UI can say
   * nothing rather than claim "Non-stop".
   */
  stops?: number;
  /** NEW (additive) — total travel time in minutes, departure to arrival. */
  durationMinutes?: number;
  /**
   * NEW (additive) — the provider's REAL fare-rule payload for this fare
   * (Atlas `routing.rule`: changesRules / refundRules / baggageElements).
   * The PolicyAgent interprets it, so a change fee is the carrier's actual
   * published fee instead of a house default. Absent for providers or
   * envelopes that publish no rules — callers then say so rather than
   * inventing one.
   */
  fareRule?: Record<string, unknown>;
  /**
   * NEW (additive) — the journey hop by hop, when the provider describes it.
   *
   * This is the AUTHORITY on the routing wherever it reaches the trip document
   * (see `TransitSegment` on the iOS side): `stops` and `stopAirports` are
   * derived from it, so a leg carrying segments can never contradict its own
   * stop count. Absent when the provider only knows a count.
   */
  segments?: FlightSegment[];
  /** NEW (additive) — IATA codes of the layover airports, in order. */
  stopAirports?: AirportCode[];
  /**
   * Additive provenance marker for the deterministic recovery rail. Provider
   * inventory omits it; an indicative option created after provider failure
   * is explicitly marked so it can never be confused with a live Atlas offer.
   */
  inventorySource?: "synthetic_recovery";
}

/** Result envelope for {@link FlightProvider.searchAlternativeFlights}. */
export interface AlternativeFlightsResult {
  /** The flight that is being replaced / rebooked. */
  referenceFlightId: string;
  /** The desired new departure time the search was anchored to. */
  requestedTime: IsoTimestamp;
  /** Candidate replacements, ordered by provider relevance (best first). */
  options: FlightOption[];
  /**
   * NEW (additive) — liveness correlation id from the Atlas `search.do`
   * envelope (server `uuid` preferred, echoed `requestId` fallback). Rides
   * here so the agent layer can aggregate an `atlasCorrelation` proof for
   * the Activity Stream; absent for providers/envelopes without one.
   */
  atlasSearchRequestId?: string;
  /**
   * Whether an EMPTY `options` array means "we looked and there is nothing"
   * or "we declined to look".
   *
   * Atlas answers HTTP 200 with `routings: []` in both cases, distinguished
   * only by a business status in the envelope: `0` is a real empty answer,
   * while `102 "Can not search past flights"` is a refusal. Treating the two
   * alike made the swarm tell a traveller their partner does not cover
   * AMS → LHR — one of the busiest routes in Europe — when the truth was that
   * the trip's dates had already passed.
   *
   * `false` ⇒ the emptiness proves NOTHING about coverage.
   */
  searchWasAnswered?: boolean;
  /** The upstream's own explanation when it declined (`msg`), for the trace. */
  searchDeclinedReason?: string;
}

/**
 * NEW (additive) — route context for providers whose upstream search API is
 * route-based (origin/destination/date) rather than flight-id-based, e.g.
 * the real Atlas / Atrip `search.do`. The orchestrator derives it from the
 * disrupted flight node. Every field is optional on the call sites: without
 * it, route-based providers degrade gracefully (empty candidate list).
 */
export interface FlightRouteContext {
  /** Origin IATA of the disrupted leg, e.g. "CDG". */
  origin?: AirportCode;
  /** Destination IATA of the disrupted leg, e.g. "LIS". */
  destination?: AirportCode;
  /** ISO timestamp of the desired new departure (formatted upstream). */
  departureDate?: IsoTimestamp;
  /** Adults travelling (defaults to 1 upstream). */
  adults?: number;
  /** Fare paid for the original booking, when known — fare-delta reference. */
  originalFare?: number;
  /** Currency of `originalFare` / preferred quote currency. */
  currency?: CurrencyCode;
  /**
   * Cabin to search, normalised ("economy" | "premium_economy" | "business" |
   * "first"). Carries the cabin the traveller ALREADY booked, so a recovery
   * keeps them in it. Absent ⇒ the provider's default (economy).
   */
  cabin?: string;
  /**
   * Candidates departing BEFORE this instant are not replacements. Set when
   * the traveller missed the flight: that departure is gone, so anything at or
   * before it cannot carry them — including same-day options earlier than the
   * one they missed.
   */
  earliestDeparture?: IsoTimestamp;
  /**
   * Deprecated compatibility hint. Recovery no longer treats this as a hard
   * veto: a late viable flight is retained and downstream stays/activities
   * are reflowed around its actual arrival.
   */
  latestDeparture?: IsoTimestamp;
  /**
   * The exact departure being replaced. Route searches return it alongside the
   * real alternatives, and without this the swarm cheerfully proposed the very
   * flight the traveller had just missed — same number, same time — with a
   * change fee attached. Matched on number AND departure instant, so a LATER
   * departure of the same flight number stays a valid replacement.
   */
  excludeFlight?: { flightNumber: string; departureTime: IsoTimestamp };
}

/**
 * Direction of a fare difference:
 * - `refund`: the traveller gets money back (amount > 0 means credit).
 * - `charge`: the traveller must pay extra (amount > 0 means payable).
 */
export type FareDirection = "refund" | "charge";

/** Result of {@link FlightProvider.calculateFareDifference}. */
export interface FareDifference {
  oldFlightId: string;
  newFlightId: string;
  /** Absolute magnitude of the difference, always >= 0. */
  amount: number;
  currency: CurrencyCode;
  direction: FareDirection;
  /**
   * NEW (additive) — what `amount` actually measures:
   * - `fare_difference`: a true delta against a KNOWN original fare (same
   *   currency as the verified re-price).
   * - `full_fare`: the original fare was unknown (or quoted in another
   *   currency), so `amount` is the FULL verified re-price charged as-is.
   * Absent on legacy/pre-extension providers (treat like `full_fare`).
   */
  basis?: "fare_difference" | "full_fare" | "search_reference" | "synthetic_estimate";
  /** NEW (additive) — the original fare subtracted, only on `fare_difference` basis. */
  originalFare?: number;
  /** NEW (additive) — passenger count the quote was computed for (>= 1). */
  adults?: number;
  /**
   * NEW (additive) — liveness correlation id from the Atlas `verify.do`
   * envelope that produced this quote. Part of the single consistent
   * correlation scheme aggregated by FlightAgent into
   * `FlightRebookingAssessment.atlasCorrelation` (search id on the result
   * envelope, verify ids here); absent for non-Atlas providers.
   */
  atlasRequestId?: string;
}

export type BookingStatus = "confirmed" | "pending" | "failed" | "recorded";

/** Result of {@link FlightProvider.bookFlight}. */
export interface BookingConfirmation {
  /** Provider / PNR confirmation code handed to the traveller. */
  confirmationCode: string;
  flightId: string;
  status: BookingStatus;
  bookedAt: IsoTimestamp;
  /**
   * Provenance of the record. Absent for provider-issued confirmations;
   * `"swarm_settlement"` marks a locally RECORDED booking (the swarm approve
   * path degrades provider failures into a local record instead of a 5xx).
   */
  source?: string;
}

// --------------------------------------------------------------------- hotel

/** Property-level policies relevant to disruption recovery. */
export interface HotelPolicies {
  hotelName: string;
  /** Whether the property accepts a delayed arrival at the shifted time. */
  lateCheckInAvailable: boolean;
  /** Fee (in `currency`) charged when cancelling now; 0 inside the free window. */
  cancellationFee: number;
  currency: CurrencyCode;
  /** End of the free-cancellation window, when the provider exposes one. */
  freeCancellationUntil?: IsoTimestamp;
}

/** Query for {@link HotelProvider.searchAlternativeRooms}. */
export interface HotelRoomSearchQuery {
  hotelName: string;
  checkIn: IsoTimestamp;
  /** Length of stay in nights (>= 1). */
  nights: number;
  guests: number;
  currency?: CurrencyCode;
}

/** One bookable room / rate the traveller could move to. */
export interface HotelRoomOption {
  roomId: string;
  hotelName: string;
  ratePerNight: number;
  currency: CurrencyCode;
  freeCancellationUntil?: IsoTimestamp;
  /** NEW (additive) — property photo URLs surfaced best-effort (max 4). */
  images?: string[];
  /** NEW (additive) — property coordinates when the provider exposes them. */
  latitude?: number;
  longitude?: number;
}

/** Result envelope for {@link HotelProvider.searchAlternativeRooms}. */
export interface HotelRoomSearchResult {
  query: string;
  rooms: HotelRoomOption[];
}

// ------------------------------------------------------------------ activity

/** Where an activity takes place — drives weather-based swaps. */
export type ActivitySetting = "indoor" | "outdoor" | "unknown";

/** A bookable activity / experience returned by a provider search. */
export interface ActivityOption {
  /** Provider product id (e.g. a Viator product code). */
  id: string;
  name: string;
  /** Tracked / affiliate product URL when the provider supplies one. */
  url?: string;
  /** "from" price per traveller; 0 when the provider does not expose one. */
  price: number;
  currency: CurrencyCode;
  durationMinutes?: number;
  /** Deterministic indoor/outdoor tagging applied by the provider mapping. */
  setting: ActivitySetting;
  /** NEW (additive) — hero image URL when the provider supplies one. */
  image?: string;
  /** NEW (additive) — aggregated traveller rating when exposed. */
  rating?: number;
}

/** Query for {@link ActivityProvider.searchActivities}. */
export interface ActivitySearchQuery {
  /** Free-text term, typically the activity name. */
  query: string;
  /** Place label used to scope the search to a destination. */
  location?: string;
  dateFrom?: string;
  dateTo?: string;
  currency?: CurrencyCode;
  /** Max number of results (provider may cap). */
  count?: number;
  /** Prefer results with this setting; "any" disables filtering. */
  settingPreference?: ActivitySetting | "any";
}

/** Result envelope for {@link ActivityProvider.searchActivities}. */
export interface ActivitySearchResult {
  query: string;
  options: ActivityOption[];
  /**
   * True when the provider could not reach upstream (missing key / network)
   * and returned an empty-but-valid result instead of throwing — callers
   * degrade instead of failing the whole plan.
   */
  degraded: boolean;
}

// ------------------------------------------------------------------- context

/** One contiguous rain window extracted from a forecast. */
export interface RainWindow {
  start: IsoTimestamp;
  end: IsoTimestamp;
  /** Precipitation probability 0..1. */
  probability: number;
  /** Provider weather description, e.g. "heavy intensity rain". */
  description: string;
}

/** Result envelope for weather context providers. */
export interface RainForecastResult {
  latitude: number;
  longitude: number;
  /** Rain windows inside the requested horizon, ordered by start time. */
  windows: RainWindow[];
  /** Provenance string, e.g. "openweathermap:onecall-3.0". */
  source: string;
}

/** Query window for event-disruption context lookups. */
export interface EventDisruptionQuery {
  latitude: number;
  longitude: number;
  /** Search radius in kilometres (provider may cap). */
  radiusKm?: number;
  from: IsoTimestamp;
  to: IsoTimestamp;
}

/** One external event that could disrupt the itinerary. */
export interface EventDisruptionInfo {
  id: string;
  name: string;
  /** Provider category label, e.g. "severe-weather", "concerts". */
  category: string;
  start: IsoTimestamp;
  end?: IsoTimestamp;
  /** Human-readable place label when the provider supplies one. */
  location?: string;
}

/** Result envelope for event-disruption context providers. */
export interface EventDisruptionResult {
  query: EventDisruptionQuery;
  events: EventDisruptionInfo[];
  /** Provenance string, e.g. "predicthq:v1-events". */
  source: string;
}
