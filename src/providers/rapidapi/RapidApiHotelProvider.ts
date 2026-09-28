/**
 * RapidApiHotelProvider — concrete {@link HotelProvider} backed by the
 * Booking.com API on RapidAPI. Live HTTP implementation (native fetch, zero
 * third-party dependencies), mirroring the AtlasFlightProvider conventions.
 *
 * Configuration (read from environment at construction time):
 * - `RAPIDAPI_KEY`  — required; constructor throws if absent (graceful
 *   degradation: callers check {@link RapidApiHotelProvider.isConfigured}
 *   before constructing and skip hotel-side adjustments when it returns
 *   false — the plan simply omits hotel deltas, mirroring the Atlas
 *   degradation policy in spec §4.1).
 * - `RAPIDAPI_HOST` — required; Booking.com host, e.g.
 *   "booking-com.p.rapidapi.com".
 * - `RAPIDAPI_TIMEOUT_MS` — optional per-request timeout, defaults to 15000.
 *
 * TWO LISTINGS, ONE PROVIDER. `RAPIDAPI_HOST` chooses which Booking.com
 * listing on RapidAPI this speaks to, because within one day both were
 * needed: `booking-com`'s monthly quota ran out and answered `429` to
 * everything, the rail went dark, and a key on `booking-com15` brought it
 * back. Their paths, payloads and per-call economics all differ, so each is
 * measured rather than assumed:
 *
 *   • `booking-com` — PREFERRED. One `/v1/hotels/search-by-coordinates` call
 *     answers everything: asked about Campo de' Fiori, 20 of 20 results were
 *     inside 3 km (nearest 20 m), 17 of 20 published their arrival window and
 *     all 20 their cancellable flag. So the SAME response serves both the
 *     property's own terms and the alternatives beside it — two calls per
 *     mission, on a 530-request month.
 *   • `booking-com15` — FALLBACK. Its coordinate search looks like the right
 *     endpoint and is not: the same question returned 9,922 matches across
 *     Lazio and Umbria, unsorted, with NOT ONE of the first twenty inside
 *     5 km — nearest 11 km, first result 102 km away in Cascia, and
 *     `sort_by=distance_from_landmark` changed nothing. Offering a stranded
 *     traveller a room a hundred kilometres away is the invention this engine
 *     exists to refuse. Its city search is sound (15 of 20 within 3 km), but
 *     the arrival window and the cancellation terms live in two further
 *     endpoints — four calls per mission, on a 50-request month.
 *
 * Error contract: methods NEVER leak raw fetch/JSON exceptions. Every failure
 * surfaces as a {@link RapidApiError} with a discriminated `kind` and a
 * `retryable` hint. Endpoint paths follow the `booking-com15` surface
 * (`/api/v1/hotels/searchDestination`, `/api/v1/hotels/searchHotels`,
 * `/api/v1/hotels/getHotelDetails`, `/api/v1/hotels/getHotelCheckInOutTime`)
 * and must be calibrated against the current RapidAPI listing — exactly the
 * same stance the Atlas provider takes for its sandbox endpoints.
 */

import type { HotelProvider } from "../interfaces/HotelProvider";
import { hotelQuotaExhausted, noteHotelQuotaExhausted, noteHotelQuotaHealthy } from "./hotelQuota";
import type {
  HotelPolicies,
  HotelRoomOption,
  HotelRoomSearchQuery,
  HotelRoomSearchResult,
  IsoTimestamp,
} from "../interfaces/types";

const DEFAULT_RAPIDAPI_HOST = "booking-com.p.rapidapi.com";
/** Required by `booking-com` on every endpoint; it 422s without it. */
const DEFAULT_LOCALE = "en-gb";
/** `booking-com15` labels its results with its own language parameter. */
const LOCALE_15 = "en-us";
/**
 * How far from the overbooked property an alternative may be and still be
 * offered, in kilometres.
 *
 * A city search covers the whole city, and a traveller whose room is gone at
 * midnight cannot use one an hour away. The cap is a judgement and is stated
 * rather than hidden; the list is sorted by real distance, so the first
 * option is always the nearest one that exists.
 */
const MAX_ALTERNATIVE_KM = 12;

/**
 * The one `booking-com` query that answers everything: the properties around
 * a point, for the real dates, with their arrival windows and cancellable
 * flags. The parameter NAMES changed with an endpoint rename —
 * `checkin`→`checkin_date`, `adults_count`→`adults_number`,
 * `currency`→`filter_by_currency` — and the API rejects the old ones outright.
 */
function coordinateParams(
  hotel: { latitude: number; longitude: number },
  checkinDate: string,
  checkoutDate: string,
  guests: number,
  currency: string | undefined,
): URLSearchParams {
  return new URLSearchParams({
    latitude: String(hotel.latitude),
    longitude: String(hotel.longitude),
    checkin_date: checkinDate,
    checkout_date: checkoutDate,
    adults_number: String(Math.max(1, Math.trunc(guests))),
    room_number: "1",
    locale: DEFAULT_LOCALE,
    filter_by_currency: currency ?? "USD",
    order_by: "popularity",
    units: "metric",
  });
}

/** Stay query shared by `booking-com15`'s city search and detail lookup. */
function stayParams(
  checkinDate: string,
  checkoutDate: string,
  guests: number,
  currency: string | undefined,
): URLSearchParams {
  return new URLSearchParams({
    arrival_date: checkinDate,
    departure_date: checkoutDate,
    adults: String(Math.max(1, Math.trunc(guests))),
    room_qty: "1",
    units: "metric",
    languagecode: LOCALE_15,
    currency_code: currency ?? "USD",
  });
}

/**
 * The property records out of a search response, whichever listing sent it.
 *
 * `booking-com` returns them flat under `result`; `booking-com15` nests each
 * one under `data.hotels[].property` with the id left on the wrapper. Both
 * spellings and a bare array are accepted so a rename degrades to "no rooms"
 * rather than an exception — `null` means no container was recognised at all,
 * which is a different thing from an empty one and must stay different.
 */
function extractProperties(body: unknown): Record<string, unknown>[] | null {
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const container = Array.isArray(body)
    ? body
    : data && Array.isArray(data.hotels)
      ? data.hotels
      : data && Array.isArray(data.result)
        ? data.result
        : isRecord(body) && Array.isArray(body.result)
          ? body.result
          : isRecord(body) && Array.isArray(body.results)
            ? body.results
            : null;
  if (!container) return null;
  return container.filter(isRecord).map((entry) => {
    if (!isRecord(entry.property)) return entry;
    // Keep the wrapper's own id reachable: `booking-com15` leaves
    // `hotel_id` outside the property it describes.
    return { ...entry.property, hotel_id: entry.property.id ?? entry.hotel_id };
  });
}

/** Great-circle kilometres between two points. */
function distanceKm(
  from: { latitude: number; longitude: number },
  toLat: number,
  toLng: number,
): number {
  const R = 6371;
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = rad(toLat - from.latitude);
  const dLng = rad(toLng - from.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.latitude)) * Math.cos(rad(toLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** HTTP statuses that are safe to retry (transient server/rate-limit issues). */
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Discriminated failure categories for {@link RapidApiError}. */
export type RapidApiErrorKind = "http" | "network" | "timeout" | "parse" | "invalid_response";

/**
 * Structured error thrown by every RapidApiHotelProvider method. Callers can
 * branch on `kind` / `retryable` instead of parsing error-message strings.
 */
export class RapidApiError extends Error {
  readonly kind: RapidApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(params: {
    kind: RapidApiErrorKind;
    message: string;
    status?: number | null;
    code?: string | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "RapidApiError";
    this.kind = params.kind;
    this.status = params.status ?? null;
    this.code = params.code ?? null;
    this.retryable = params.retryable ?? false;
  }
}

export interface RapidApiHotelProviderConfig {
  apiKey: string;
  host: string;
  timeoutMs: number;
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Graceful-degradation probe: true when the environment carries everything the
 * provider needs. The orchestration layer checks this BEFORE constructing the
 * provider and degrades the plan (no hotel deltas) instead of failing.
 */
export function rapidApiHotelConfigured(): boolean {
  const env = typeof process !== "undefined" ? process.env : undefined;
  // Explicit off switch, separate from "is a key present". A metered key with
  // few credits left should be silenceable without deleting it from the
  // environment — pulling the key makes every other check read as
  // misconfiguration, which is a different (and misleading) state.
  const disabled = String(env?.HOTEL_PROVIDER_DISABLED ?? "")
    .trim()
    .toLowerCase();
  if (disabled === "1" || disabled === "true" || disabled === "on") return false;
  return Boolean(env?.RAPIDAPI_KEY && env?.RAPIDAPI_HOST);
}

function resolveEnvConfig(
  config?: Partial<RapidApiHotelProviderConfig>,
): RapidApiHotelProviderConfig {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const apiKey = config?.apiKey ?? env?.RAPIDAPI_KEY;
  const host = config?.host ?? env?.RAPIDAPI_HOST;
  if (!apiKey || !host) {
    throw new Error(
      "RapidApiHotelProvider: RAPIDAPI_KEY and RAPIDAPI_HOST must be set. " +
        "Check rapidApiHotelConfigured() before constructing the provider to degrade gracefully.",
    );
  }
  return { apiKey, host, timeoutMs: parseTimeoutMs(env?.RAPIDAPI_TIMEOUT_MS) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = value.replace(/[^\d.-]/g, "");
    if (!/^-?\d+(?:\.\d+)?$/.test(numeric)) return null;
    const parsed = Number(numeric);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIso(value: unknown): IsoTimestamp | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** YYYY-MM-DD date required by the Booking.com RapidAPI query parameters. */
function toBookingDate(iso: IsoTimestamp, plusDays = 0): string {
  const date = new Date(iso);
  if (plusDays !== 0) date.setUTCDate(date.getUTCDate() + plusDays);
  return date.toISOString().slice(0, 10);
}

/** One resolved property from the destination endpoint. */
interface ResolvedHotel {
  hotelId: string;
  name: string;
  latitude: number;
  longitude: number;
  /**
   * The property's own city, as the listing ids it (`city_ufi`). It arrives
   * with the property lookup, so searching the city for an alternative room
   * costs no second resolution.
   */
  cityDestId: string | null;
  cityName: string | null;
}

export class RapidApiHotelProvider implements HotelProvider {
  readonly providerName = "rapidapi-booking";

  private readonly config: RapidApiHotelProviderConfig;
  /**
   * One resolution per property per instance. The key is metered by the
   * MONTH, and both public methods start by naming the same hotel — without
   * this, every mission paid twice for the same unchanging answer.
   */
  private readonly resolved = new Map<string, Promise<ResolvedHotel>>();

  /**
   * Which listing `RAPIDAPI_HOST` points at. The two answer the same
   * questions through different endpoints and at different costs; see the
   * header for what was measured on each.
   */
  private get usesListing15(): boolean {
    return /booking-com15/i.test(this.config.host);
  }

  constructor(config?: Partial<RapidApiHotelProviderConfig>) {
    const fromEnv = resolveEnvConfig(config);
    const explicitTimeout = config?.timeoutMs;
    const timeoutMs =
      explicitTimeout !== undefined && Number.isFinite(explicitTimeout) && explicitTimeout > 0
        ? explicitTimeout
        : fromEnv.timeoutMs;
    this.config = {
      apiKey: config?.apiKey ?? fromEnv.apiKey,
      host: config?.host ?? fromEnv.host,
      timeoutMs,
    };
  }

  async getHotelPolicies(
    hotelName: string,
    checkIn: IsoTimestamp,
    guests: number,
  ): Promise<HotelPolicies> {
    const hotel = await this.resolveHotel(hotelName);
    const checkOut = toBookingDate(checkIn, 1);
    const found = this.usesListing15
      ? await this.policyFields15(hotel, checkIn, checkOut, guests)
      : await this.policyFieldsCoordinates(hotel, checkIn, checkOut, guests);

    // Does the property still take an arrival at the hour we are asking about?
    // Answered from its OWN stated window when it states one — a 21:30 arrival
    // at a desk that closes at midnight is accepted, a 01:00 one is not.
    const arrivalMinutes = arrivalMinutesIntoNight(checkIn);
    const lateCheckIn =
      found.lateCheckIn ??
      (found.checkInUntilMinutes !== undefined && arrivalMinutes !== null
        ? arrivalMinutes <= found.checkInUntilMinutes
        : undefined);
    if (lateCheckIn === undefined || found.cancellationFee === undefined || found.currency === undefined) {
      throw new RapidApiError({ kind: "invalid_response", code: "hotel_policy_unverified",
        message: "The requested hotel's late-arrival and cancellation terms could not be verified." });
    }
    return {
      hotelName: hotel.name,
      lateCheckInAvailable: lateCheckIn,
      cancellationFee: found.cancellationFee,
      currency: found.currency,
      freeCancellationUntil: found.freeCancellationUntil,
    };
  }

  /**
   * `booking-com`: the terms of the property itself, read out of the same
   * neighbourhood search that will also supply the alternatives.
   *
   * Policies must belong to the REQUESTED property, never to the first nearby
   * result — the match is on the id the locations endpoint returned, and a
   * search that does not contain the property leaves everything unknown.
   */
  private async policyFieldsCoordinates(
    hotel: ResolvedHotel,
    checkIn: IsoTimestamp,
    checkOut: string,
    guests: number,
  ): Promise<PolicyFields> {
    const body = await this.request(
      "GET",
      `/v1/hotels/search-by-coordinates?${coordinateParams(hotel, toBookingDate(checkIn), checkOut, guests, "USD")}`,
    );
    const property = (extractProperties(body) ?? []).find(
      (raw) => String(raw.hotel_id ?? raw.id ?? "") === hotel.hotelId,
    );
    return collectPolicyFields(property);
  }

  /**
   * `booking-com15`: the same two facts, from two endpoints, because this
   * listing's search publishes neither. The arrival window comes from the
   * check-in endpoint, the cancellation terms from the property detail, and
   * both are asked about the SAME id so nothing drifts onto a neighbour.
   */
  private async policyFields15(
    hotel: ResolvedHotel,
    checkIn: IsoTimestamp,
    checkOut: string,
    guests: number,
  ): Promise<PolicyFields> {
    const [checkInBody, detailBody] = await Promise.all([
      this.request(
        "GET",
        `/api/v1/hotels/getHotelCheckInOutTime?hotel_id=${encodeURIComponent(hotel.hotelId)}&adults=${Math.max(1, Math.trunc(guests))}&room_qty=1`,
      ),
      this.request(
        "GET",
        `/api/v1/hotels/getHotelDetails?hotel_id=${encodeURIComponent(hotel.hotelId)}&${stayParams(toBookingDate(checkIn), checkOut, guests, undefined)}`,
      ),
    ]);
    const found = collectPolicyFields(checkInBody);
    mergePolicyFields(found, collectPolicyFields(detailBody));
    return found;
  }

  async searchAlternativeRooms(query: HotelRoomSearchQuery): Promise<HotelRoomSearchResult> {
    const hotel = await this.resolveHotel(query.hotelName);
    const nights = Math.max(1, Math.trunc(query.nights));
    const checkOut = toBookingDate(query.checkIn, nights);
    // WHERE to look differs by listing, and it is the whole difference
    // between a usable answer and a regional one — see the header.
    let body: unknown;
    if (this.usesListing15) {
      // The property's OWN city, never a radius around its coordinates.
      if (!hotel.cityDestId) {
        throw new RapidApiError({
          kind: "invalid_response",
          code: "hotel_city_unknown",
          message: `Booking.com RapidAPI did not say which city "${query.hotelName}" is in, so no comparable room could be searched.`,
        });
      }
      body = await this.request(
        "GET",
        `/api/v1/hotels/searchHotels?dest_id=${encodeURIComponent(hotel.cityDestId)}&search_type=CITY&${stayParams(toBookingDate(query.checkIn), checkOut, query.guests, query.currency)}`,
      );
    } else {
      body = await this.request(
        "GET",
        `/v1/hotels/search-by-coordinates?${coordinateParams(hotel, toBookingDate(query.checkIn), checkOut, query.guests, query.currency)}`,
      );
    }

    const rawResults = extractProperties(body);
    if (!rawResults)
      throw new RapidApiError({
        kind: "invalid_response",
        message: "Hotel search returned no recognized result array.",
      });
    const rooms: Array<HotelRoomOption & { __km: number }> = [];
    for (const entry of rawResults) {
      if (!isRecord(entry)) continue;
      // `property` is where this listing puts them; a flat entry still works.
      const raw = isRecord(entry.property) ? entry.property : entry;
      const gross = isRecord(raw.priceBreakdown) && isRecord(raw.priceBreakdown.grossPrice)
        ? raw.priceBreakdown.grossPrice
        : null;
      const priceBreakdown = isRecord(raw.price_breakdown) ? raw.price_breakdown : null;
      const rate = asFiniteNumber(gross?.value ?? raw.min_total_price ?? priceBreakdown?.gross_price);
      if (rate === null || rate < 0) continue;
      const name =
        typeof raw.name === "string"
          ? raw.name
          : typeof raw.hotel_name === "string"
            ? raw.hotel_name
            : query.hotelName;
      // The traveller's own property is not an alternative to itself.
      //
      // `hotel_id` FIRST, and it matters: `booking-com` also sends an `id`
      // that is a UI card handle — "property_card_88498" beside
      // `hotel_id: 88498`. Reading that one, the comparison never matched
      // and the swarm offered an overbooked traveller the very hotel that
      // had just walked them, live on 2026-09-19.
      const id = String(raw.hotel_id ?? raw.id ?? entry.hotel_id ?? "");
      if (id && id === hotel.hotelId) continue;
      const latitude = asFiniteNumber(raw.latitude);
      const longitude = asFiniteNumber(raw.longitude);
      // Without a position we cannot say it is near, so we do not offer it.
      if (latitude === null || longitude === null) continue;
      const km = distanceKm(hotel, latitude, longitude);
      if (km > MAX_ALTERNATIVE_KM) continue;
      const images = collectHotelImages(raw);
      rooms.push({
        roomId: id || `${hotel.hotelId}-alt-${rooms.length}`,
        hotelName: name,
        ratePerNight: Math.max(0, rate / nights),
        currency:
          typeof gross?.currency === "string" && gross.currency.length > 0
            ? gross.currency
            : typeof raw.currency === "string" && raw.currency.length > 0
              ? raw.currency
              : typeof raw.currency_code === "string" && raw.currency_code.length > 0
                ? raw.currency_code
                : (query.currency ?? "USD"),
        freeCancellationUntil: toIso(
          isRecord(raw.policies) ? raw.policies.free_cancellation_until : undefined,
        ),
        ...(images.length > 0 ? { images } : {}),
        latitude,
        longitude,
        __km: km,
      });
    }
    // Nearest first: a city search is ordered by the listing's own ranking,
    // and the traveller's question is "how far do I have to drag my bags".
    rooms.sort((a, b) => a.__km - b.__km);
    return {
      query: query.hotelName,
      rooms: rooms.map(({ __km: _km, ...room }) => room),
    };
  }

  // ---------------------------------------------------------------- internals

  /** Resolve a hotel name to its property id, position and city — once. */
  private async resolveHotel(hotelName: string): Promise<ResolvedHotel> {
    const key = hotelName.trim().toLowerCase();
    const memo = this.resolved.get(key);
    if (memo) return memo;
    const pending = this.resolveHotelUncached(hotelName);
    this.resolved.set(key, pending);
    // A failed resolution must not be remembered as the answer: the next
    // mission deserves a real attempt, not a cached exception.
    pending.catch(() => this.resolved.delete(key));
    return pending;
  }

  private async resolveHotelUncached(hotelName: string): Promise<ResolvedHotel> {
    // `booking-com` answers a NAME search at /v1/hotels/locations with a bare
    // array; `booking-com15` answers /searchDestination with {data: [...]}.
    const body = this.usesListing15
      ? await this.request(
          "GET",
          `/api/v1/hotels/searchDestination?${new URLSearchParams({ query: hotelName })}`,
        )
      : await this.request(
          "GET",
          `/v1/hotels/locations?${new URLSearchParams({ name: hotelName, locale: DEFAULT_LOCALE })}`,
        );
    const candidates = Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body.data)
        ? body.data
        : [];
    // A name search returns cities and districts as well as properties. A
    // real property is preferred; anything else is only better than nothing.
    const ordered = [
      ...candidates.filter((raw) => isRecord(raw) && raw.dest_type === "hotel"),
      ...candidates.filter((raw) => !isRecord(raw) || raw.dest_type !== "hotel"),
    ];
    for (const raw of ordered) {
      if (!isRecord(raw)) continue;
      const latitude = asFiniteNumber(raw.latitude);
      const longitude = asFiniteNumber(raw.longitude);
      if (latitude === null || longitude === null) continue;
      // The live endpoints answer with `dest_id` / `name`, not `hotel_id` /
      // `hotel_name`. Reading the wrong keys made `hotelId` fall back to the
      // hotel's NAME, and the caller then looked for a property whose numeric
      // id equalled "Hotel Gracery Shinjuku" — which nothing ever does. Every
      // hotel assessment in a live battery of 42 degraded on that comparison.
      const id = raw.hotel_id ?? raw.dest_id;
      const label = raw.hotel_name ?? raw.name;
      // `city_ufi` is the property's own city id on `booking-com15`, and it
      // is what makes that listing's alternative search cost one call.
      const cityUfi = asFiniteNumber(
        raw.city_ufi ?? (raw.dest_type === "city" ? raw.dest_id : undefined),
      );
      return {
        hotelId: String(id ?? hotelName),
        name: typeof label === "string" && label.length > 0 ? label : hotelName,
        latitude,
        longitude,
        cityDestId: cityUfi !== null ? String(cityUfi) : null,
        cityName:
          typeof raw.city_name === "string" && raw.city_name.length > 0 ? raw.city_name : null,
      };
    }
    throw new RapidApiError({
      kind: "invalid_response",
      message: `Booking.com RapidAPI could not resolve hotel "${hotelName}".`,
      code: "hotel_not_found",
    });
  }

  private buildHeaders(): Record<string, string> {
    return {
      "X-RapidAPI-Key": this.config.apiKey,
      "X-RapidAPI-Host": this.config.host,
      Accept: "application/json",
    };
  }

  /**
   * Single HTTP gateway: auth headers, timeout, response-status handling and
   * JSON parsing. Every failure mode is converted into a RapidApiError —
   * raw fetch/JSON exceptions never escape.
   */
  private async request(method: "GET", path: string): Promise<unknown> {
    // A key that was refused minutes ago is still refused, and every attempt
    // is a request off a MONTHLY allowance — 50 on the plan in use. Spending
    // it to be told "no" again is the one thing this rail must not do, so a
    // remembered exhaustion short-circuits before the network.
    if (hotelQuotaExhausted()) {
      throw new RapidApiError({
        kind: "http",
        status: 429,
        code: "hotel_quota_exhausted",
        message:
          "Booking.com RapidAPI refused this key for quota within the last 15 minutes; not spending another request to hear it again.",
        retryable: true,
      });
    }
    const url = `https://${this.config.host}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      } as RequestInit);
    } catch (error) {
      if (isTimeoutFailure(error)) {
        throw new RapidApiError({
          kind: "timeout",
          message: `Booking.com RapidAPI request to ${path} timed out after ${this.config.timeoutMs}ms.`,
          retryable: true,
          cause: error,
        });
      }
      throw new RapidApiError({
        kind: "network",
        message: `Booking.com RapidAPI request to ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
        cause: error,
      });
    }

    let body: unknown = null;
    let rawText: string;
    try {
      rawText = await response.text();
    } catch (error) {
      const kind = isTimeoutFailure(error) ? "timeout" : "network";
      throw new RapidApiError({
        kind,
        message: `Booking.com RapidAPI response body for ${path} could not be read (${kind}).`,
        status: response.status,
        retryable: true,
        cause: error,
      });
    }
    if (rawText.length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch (error) {
        throw new RapidApiError({
          kind: "parse",
          message: `Booking.com RapidAPI returned non-JSON response body for ${path} (status ${response.status}).`,
          status: response.status,
          retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
          cause: error,
        });
      }
    }

    if (!response.ok) {
      // Remember a quota refusal: the /health gateway probe structurally
      // cannot see one (the root answers 404 whatever the key's state), so
      // without this the rail reports itself healthy while every lookup fails.
      if (response.status === 429) {
        const note =
          body !== null && typeof body === "object" && "message" in body
            ? String((body as { message: unknown }).message)
            : rawText.slice(0, 200);
        noteHotelQuotaExhausted(note);
      }
      throw new RapidApiError({
        kind: "http",
        message: `Booking.com RapidAPI request to ${path} failed with HTTP ${response.status}.`,
        status: response.status,
        code: null,
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
      });
    }

    noteHotelQuotaHealthy();
    return body;
  }
}

// ------------------------------------------------------------------ helpers

/**
 * Best-effort property photo collection (max 4 unique URLs): Booking.com
 * search payloads surface photos as `max_photo_url` / `main_photo_url` and
 * sometimes as a `photos` array of strings or `{ url }` records.
 */
function collectHotelImages(raw: Record<string, unknown>): string[] {
  const images: string[] = [];
  const push = (value: unknown): void => {
    if (images.length >= 4) return;
    if (typeof value === "string" && value.length > 0 && !images.includes(value)) {
      images.push(value);
    }
  };
  push(raw.max_photo_url);
  push(raw.main_photo_url);
  if (Array.isArray(raw.photos)) {
    for (const photo of raw.photos) {
      if (images.length >= 4) break;
      if (isRecord(photo)) push(photo.url ?? photo.url_max300);
      else push(photo);
    }
  }
  return images;
}

function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "AbortError") {
    return /timed?\s?out/i.test(error.message);
  }
  return false;
}

interface PolicyFields {
  lateCheckIn?: boolean;
  cancellationFee?: number;
  currency?: string;
  freeCancellationUntil?: IsoTimestamp;
  /**
   * The LATEST minute-of-day the property still takes an arrival, as it states
   * it (`checkin.until`). "00:00" means midnight — the END of the day — so it
   * reads as 1440, not 0. Absent when the property states no cutoff, which is
   * genuinely unknown and must stay unknown.
   */
  checkInUntilMinutes?: number;
}

/**
 * How far into the HOTEL NIGHT an arrival falls, in minutes from that night's
 * own start — which is what a reception desk actually counts.
 *
 * A 01:00 arrival is minute 60 of the calendar day but minute 1500 of the
 * night before, and a desk that closes at midnight has long shut. Comparing
 * bare minutes-of-day made 01:00 look earlier than 23:59 and let it through.
 * The 06:00 pivot is the same one the settlement uses to decide whether a
 * booked night went unused.
 */
const NIGHT_ROLLOVER_MINUTES = 6 * 60;
function arrivalMinutesIntoNight(iso: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes < NIGHT_ROLLOVER_MINUTES ? minutes + 1440 : minutes;
}

/** "23:30" → 1410. "00:00" is the END of the day (1440), never the start. */
function checkInCutoffMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return null;
  return minutes === 0 ? 1440 : minutes;
}

/**
 * Walk an arbitrary Booking.com payload for disruption-relevant policy
 * fields. Deliberately tolerant: different property payloads expose the
 * fields under different keys; anything not found stays `undefined` and the
 * agent applies conservative defaults.
 */
function collectPolicyFields(body: unknown, depth = 0): PolicyFields {
  const found: PolicyFields = {};
  if (depth > 6 || body === null || typeof body !== "object") return found;

  if (Array.isArray(body)) {
    for (const item of body) {
      mergePolicyFields(found, collectPolicyFields(item, depth + 1));
      if (isComplete(found)) return found;
    }
    return found;
  }

  const record = body as Record<string, unknown>;
  if (typeof record.late_check_in_available === "boolean") found.lateCheckIn = record.late_check_in_available;
  // Booking.com never sends `late_check_in_available`. What it DOES send is
  // the property's own stated arrival window, `checkin: {from, until}` — and
  // reading it is the difference between a working hotel rail and one that
  // degrades on every single mission, which is what a live battery of 42
  // found. 16 of 20 real Tokyo properties state a cutoff; the other 4 leave it
  // blank, and blank stays unknown rather than becoming a convenient "yes".
  const checkinBlock = isRecord(record.checkin) ? record.checkin : null;
  const cutoff = checkInCutoffMinutes(checkinBlock?.until);
  if (cutoff !== null) found.checkInUntilMinutes = found.checkInUntilMinutes ?? cutoff;
  // `booking-com15` spells the same fact three ways depending on the
  // endpoint: `checkin.untilTime` on a city search result,
  // `checkinCheckoutTimes.checkinTimeRange.until` on the dedicated
  // check-in endpoint. A `null` there is the property stating no cutoff,
  // which stays unknown rather than becoming a convenient "yes".
  const camelCutoff = checkInCutoffMinutes(checkinBlock?.untilTime);
  if (camelCutoff !== null) found.checkInUntilMinutes = found.checkInUntilMinutes ?? camelCutoff;
  const checkinRange = isRecord(record.checkinTimeRange) ? record.checkinTimeRange : null;
  const rangeCutoff = checkInCutoffMinutes(checkinRange?.until);
  if (rangeCutoff !== null) found.checkInUntilMinutes = found.checkInUntilMinutes ?? rangeCutoff;
  // The stay's own refundability deadline, stated per booked room — but only
  // while it is still ahead. A deadline that has passed is not a free
  // cancellation window, it is history, and "Free cancellation until 17
  // November" read on the 19th is a promise the property will not honour.
  if (typeof record.refundable_until === "string") {
    const until = toIso(record.refundable_until);
    if (until && Date.parse(until) > Date.now()) {
      found.freeCancellationUntil = found.freeCancellationUntil ?? until;
    }
  }
  // The cancellation TIMELINE — and ONLY that one.
  //
  // `paymentterms` carries TWO timelines of identical shape: `cancellation`
  // and `prepayment`. Reading whichever came first charged a traveller
  // €291.60 as a "cancellation fee" on a room that was freely cancellable
  // for another two months — it was the prepayment, i.e. the room's own
  // price, relabelled. Caught by the ledger audit on 2026-09-18, not by any
  // schema: both numbers are real, and only one answers the question.
  //
  // Which stage is in force is decided by the CLOCK, not by `is_effective`:
  // that flag is set on every stage of the active policy (both, on the Rome
  // property), so `find(is_effective)` silently meant "the first one". The
  // stage that applies is the first whose window has not closed yet.
  const terms = isRecord(record.cancellation) ? record.cancellation : null;
  const timeline = terms && isRecord(terms.timeline) ? terms.timeline : null;
  if (timeline && Array.isArray(timeline.stages)) {
    const stages = timeline.stages.filter(isRecord);
    const now = Date.now();
    const closesAt = (stage: Record<string, unknown>): number => {
      const raw = stage.limit_until_raw ?? stage.date_until ?? stage.limit_until;
      const ms = typeof raw === "string" ? Date.parse(raw.replace(" ", "T")) : NaN;
      return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
    };
    // The first window still open; failing that, the last one — once every
    // window has closed, the final stage is what the property charges.
    const inForce = stages.find((stage) => closesAt(stage) > now) ?? stages[stages.length - 1];
    if (inForce) {
      const stageFee = asFiniteNumber(inForce.fee ?? inForce.stage_fee);
      if (stageFee !== null) found.cancellationFee = found.cancellationFee ?? Math.max(0, stageFee);
      if (inForce.is_free === 1 || inForce.is_free === true) {
        found.cancellationFee = found.cancellationFee ?? 0;
        const until = toIso(
          typeof inForce.limit_until_raw === "string"
            ? inForce.limit_until_raw.replace(" ", "T")
            : undefined,
        );
        if (until && Date.parse(until) > Date.now()) {
          found.freeCancellationUntil = found.freeCancellationUntil ?? until;
        }
      }
    }
  }
  const fee = asFiniteNumber(record.cancellation_fee ?? record.cancel_fee);
  if (fee !== null) found.cancellationFee = found.cancellationFee ?? Math.max(0, fee);
  if (typeof record.currency_code === "string" && record.currency_code.length > 0) {
    found.currency = found.currency ?? record.currency_code;
  }
  // `is_free_cancellable` arrives as 1/0, not true/false — every one of the 20
  // live results carried a NUMBER, so the boolean-only test never fired and
  // the fee stayed unknown alongside it.
  const freeCancellable = record.is_free_cancellable;
  if (freeCancellable === true || freeCancellable === 1) {
    found.cancellationFee = found.cancellationFee ?? 0;
  }
  for (const value of Object.values(record)) {
    if (value === null || typeof value !== "object") continue;
    mergePolicyFields(found, collectPolicyFields(value, depth + 1));
    if (isComplete(found)) return found;
  }
  return found;
}

function mergePolicyFields(target: PolicyFields, source: PolicyFields): void {
  target.lateCheckIn = target.lateCheckIn ?? source.lateCheckIn;
  target.checkInUntilMinutes = target.checkInUntilMinutes ?? source.checkInUntilMinutes;
  target.cancellationFee = target.cancellationFee ?? source.cancellationFee;
  target.currency = target.currency ?? source.currency;
  target.freeCancellationUntil = target.freeCancellationUntil ?? source.freeCancellationUntil;
}

function isComplete(found: PolicyFields): boolean {
  const arrivalKnown = found.lateCheckIn !== undefined || found.checkInUntilMinutes !== undefined;
  return arrivalKnown && found.cancellationFee !== undefined && found.currency !== undefined;
}
