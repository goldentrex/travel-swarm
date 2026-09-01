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
 * Error contract: methods NEVER leak raw fetch/JSON exceptions. Every failure
 * surfaces as a {@link RapidApiError} with a discriminated `kind` and a
 * `retryable` hint. Endpoint paths follow the public Booking.com RapidAPI
 * surface (`/v1/hotels/locations`, `/v1/hotels/searchByCoordinates`,
 * `/v1/hotels/getDetailsByCoordinates`) and must be calibrated against the
 * current RapidAPI listing — exactly the same stance the Atlas provider takes
 * for its sandbox endpoints.
 */

import type { HotelProvider } from "../interfaces/HotelProvider";
import { noteHotelQuotaExhausted, noteHotelQuotaHealthy } from "./hotelQuota";
import type {
  HotelPolicies,
  HotelRoomOption,
  HotelRoomSearchQuery,
  HotelRoomSearchResult,
  IsoTimestamp,
} from "../interfaces/types";

const DEFAULT_RAPIDAPI_HOST = "booking-com.p.rapidapi.com";
/** Required on every endpoint; the API 422s without it. */
const DEFAULT_LOCALE = "en-gb";

/**
 * Query for `/v1/hotels/search-by-coordinates`, the one live endpoint behind
 * both public methods. The parameter NAMES changed with the endpoint rename —
 * `checkin`→`checkin_date`, `adults_count`→`adults_number`,
 * `currency`→`filter_by_currency` — and the API rejects the old ones outright.
 */
function searchParams(
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
  const disabled = String(env?.HOTEL_PROVIDER_DISABLED ?? "").trim().toLowerCase();
  if (disabled === "1" || disabled === "true" || disabled === "on") return false;
  return Boolean(env?.RAPIDAPI_KEY && env?.RAPIDAPI_HOST);
}

function resolveEnvConfig(): RapidApiHotelProviderConfig {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const apiKey = env?.RAPIDAPI_KEY;
  const host = env?.RAPIDAPI_HOST;
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
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
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

/** One resolved property candidate from the locations endpoint. */
interface ResolvedHotel {
  hotelId: string;
  name: string;
  latitude: number;
  longitude: number;
}

export class RapidApiHotelProvider implements HotelProvider {
  readonly providerName = "rapidapi-booking";

  private readonly config: RapidApiHotelProviderConfig;

  constructor(config?: Partial<RapidApiHotelProviderConfig>) {
    const fromEnv = resolveEnvConfig();
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
    // `/v1/hotels/getDetailsByCoordinates` no longer exists (404). The search
    // endpoint carries the same policy signals for the property, so one live
    // endpoint now backs both methods instead of one working and one throwing.
    const body = await this.request(
      "GET",
      `/v1/hotels/search-by-coordinates?${searchParams(hotel, toBookingDate(checkIn), checkOut, guests, "USD")}`,
    );

    // Tolerant policy extraction: the Booking.com RapidAPI surface exposes
    // cancellation terms in varying shapes per property; we walk the payload
    // for the fields we need and fall back to conservative defaults (late
    // check-in accepted, fee 0) when the property publishes nothing.
    const found = collectPolicyFields(body);
    return {
      hotelName: hotel.name,
      lateCheckInAvailable: found.lateCheckIn ?? true,
      cancellationFee: found.cancellationFee ?? 0,
      currency: found.currency ?? "USD",
      freeCancellationUntil: found.freeCancellationUntil,
    };
  }

  async searchAlternativeRooms(query: HotelRoomSearchQuery): Promise<HotelRoomSearchResult> {
    const hotel = await this.resolveHotel(query.hotelName);
    const checkOut = toBookingDate(query.checkIn, Math.max(1, Math.trunc(query.nights)));
    const body = await this.request(
      "GET",
      `/v1/hotels/search-by-coordinates?${searchParams(hotel, toBookingDate(query.checkIn), checkOut, query.guests, query.currency)}`,
    );

    // The live payload nests them under `result` (singular). Both spellings and
    // a bare array are accepted so a future rename degrades to "no rooms"
    // rather than an exception.
    const rawResults = Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body.result)
        ? body.result
        : isRecord(body) && Array.isArray(body.results)
          ? body.results
          : [];
    const rooms: HotelRoomOption[] = [];
    for (const raw of rawResults) {
      if (!isRecord(raw)) continue;
      const priceBreakdown = isRecord(raw.price_breakdown) ? raw.price_breakdown : null;
      const rate = asFiniteNumber(raw.min_total_price ?? priceBreakdown?.gross_price);
      if (rate === null) continue;
      const name = typeof raw.hotel_name === "string" ? raw.hotel_name : query.hotelName;
      // Additive media (best-effort): Booking.com payloads expose property
      // photos under varying keys — collect up to 4 unique URLs.
      const images = collectHotelImages(raw);
      const latitude = asFiniteNumber(raw.latitude);
      const longitude = asFiniteNumber(raw.longitude);
      const room: HotelRoomOption = {
        roomId: String(raw.hotel_id ?? `${hotel.hotelId}-alt-${rooms.length}`),
        hotelName: name,
        ratePerNight: Math.max(0, rate / Math.max(1, Math.trunc(query.nights))),
        currency:
          typeof raw.currency_code === "string" && raw.currency_code.length > 0
            ? raw.currency_code
            : (query.currency ?? "USD"),
        freeCancellationUntil: toIso(
          isRecord(raw.policies) ? raw.policies.free_cancellation_until : undefined,
        ),
        ...(images.length > 0 ? { images } : {}),
        ...(latitude !== null ? { latitude } : {}),
        ...(longitude !== null ? { longitude } : {}),
      };
      rooms.push(room);
    }
    return { query: query.hotelName, rooms };
  }

  // ---------------------------------------------------------------- internals

  /** Resolve a hotel name to Booking.com coordinates via the locations API. */
  private async resolveHotel(hotelName: string): Promise<ResolvedHotel> {
    // `locale` is REQUIRED by the live API; `language_id` was rejected with a
    // 422 naming the missing field, which surfaced as "the rate could not be
    // checked" on every stay.
    const params = new URLSearchParams({ name: hotelName, locale: DEFAULT_LOCALE });
    const body = await this.request("GET", `/v1/hotels/locations?${params}`);
    const candidates = Array.isArray(body) ? body : [];
    for (const raw of candidates) {
      if (!isRecord(raw)) continue;
      const latitude = asFiniteNumber(raw.latitude);
      const longitude = asFiniteNumber(raw.longitude);
      if (latitude === null || longitude === null) continue;
      return {
        hotelId: String(raw.hotel_id ?? hotelName),
        name: typeof raw.hotel_name === "string" ? raw.hotel_name : hotelName,
        latitude,
        longitude,
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
  if (typeof record.free_cancellation_until === "string") {
    found.freeCancellationUntil = toIso(record.free_cancellation_until);
  }
  const fee = asFiniteNumber(record.cancellation_fee ?? record.cancel_fee);
  if (fee !== null) found.cancellationFee = Math.max(0, fee);
  if (typeof record.currency_code === "string" && record.currency_code.length > 0) {
    found.currency = record.currency_code;
  }
  if (typeof record.is_free_cancellable === "boolean" && record.is_free_cancellable) {
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
  target.cancellationFee = target.cancellationFee ?? source.cancellationFee;
  target.currency = target.currency ?? source.currency;
  target.freeCancellationUntil = target.freeCancellationUntil ?? source.freeCancellationUntil;
}

function isComplete(found: PolicyFields): boolean {
  return found.cancellationFee !== undefined && found.freeCancellationUntil !== undefined;
}
