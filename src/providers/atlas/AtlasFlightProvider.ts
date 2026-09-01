/**
 * AtlasFlightProvider — concrete {@link FlightProvider} backed by the REAL
 * Atlas Skill / ATRIP sandbox API (live HTTP implementation, native fetch,
 * zero third-party dependencies).
 *
 * Wire protocol (verified against the sandbox — all endpoints POST at the
 * root with a `.do` suffix):
 *   - `/search.do`            — route-based flight search
 *   - `/verify.do`            — re-price a routing, issues the booking session
 *   - `/order.do`             — create the order (fictional sandbox traveler)
 *   - `/pay.do`               — best-effort balance payment (never blocking)
 *
 * Auth is TWO custom headers on every request (NOT Bearer):
 *   `x-atlas-client-id: <ATLAS_CLIENT_ID>` + `x-atlas-client-secret: <ATLAS_API_KEY>`
 * Mandatory headers: `Content-Type: application/json`, `Accept: *` (do NOT
 * send Accept: application/json) and `Accept-Encoding: gzip` (HARD
 * requirement — without it the API answers business status 102).
 *
 * Response envelope: HTTP is ~always 200; success is `body.status === 0`.
 * Business statuses: 102 gzip missing (config error), 109 search limit
 * (non-retryable), 110/112/9999 transient (retryable), 900 credentials
 * rejected.
 *
 * Configuration (read from environment at construction time):
 * - `ATLAS_API_KEY`     — required (sent as x-atlas-client-secret);
 *   constructor throws if absent.
 * - `ATLAS_CLIENT_ID`   — sent as x-atlas-client-id; required for the real
 *   API to accept requests.
 * - `ATLAS_SANDBOX_URL` — preferred base URL variable (matches .env.local);
 *   `ATLAS_BASE_URL` honored as legacy fallback; default
 *   `https://sandbox.atriptech.com`.
 * - `ATLAS_TIMEOUT_MS`  — optional per-request timeout, defaults to 15000
 *   (live searches take several seconds).
 *
 * Route-context contract: the real search API needs origin/destination/date,
 * so `searchAlternativeFlights` consumes the additive {@link FlightRouteContext}.
 * Without it the provider degrades gracefully (empty candidate list) instead
 * of throwing — keeping legacy call sites and the demo fallback rail intact.
 *
 * Fare difference: there is NO upstream fare-difference endpoint — the
 * candidate routingIdentifier is re-priced via `verify.do` and the delta is
 * computed client-side against `routeContext.originalFare` ONLY when it is a
 * finite >= 0 amount quoted in the SAME currency as the verified re-price
 * (case-insensitive match) → `basis: "fare_difference"` (the original fare
 * and the passenger count used are reported alongside). Any other case —
 * unknown original fare or a cross-currency one — quotes the FULL verified
 * total as a charge with `basis: "full_fare"`. Never a silent 0, never a
 * cross-currency subtraction.
 *
 * Error contract: methods NEVER leak raw fetch/JSON exceptions. Every failure
 * surfaces as an {@link AtlasApiError} with a discriminated `kind`, an
 * upstream `code` / `upstreamStatus`, and a `retryable` hint.
 */

import type { FlightProvider } from "../interfaces/FlightProvider";
import type {
  AlternativeFlightsResult,
  BookingConfirmation,
  FareDifference,
  FlightOption,
  FlightSegment,
  FlightRouteContext,
  IsoTimestamp,
} from "../interfaces/types";

const DEFAULT_ATLAS_BASE_URL = "https://sandbox.atriptech.com";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Sandbox quote currency recommended by the Atlas docs — the fallback only. */
const SANDBOX_CURRENCY = "USD";

/** ISO-4217 shape guard: anything else falls back to the sandbox default
 *  rather than sending the upstream a currency it will reject. */
function quoteCurrency(requested: string | undefined): string {
  const cur = (requested ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(cur) ? cur : SANDBOX_CURRENCY;
}

/** HTTP statuses that are safe to retry (transient server/rate-limit issues). */
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Envelope business statuses that are transient and safe to retry. */
const RETRYABLE_BUSINESS_STATUSES = new Set([110, 112, 9999]);

/** Discriminated failure categories for {@link AtlasApiError}. */
export type AtlasApiErrorKind =
  | "http"
  | "network"
  | "timeout"
  | "parse"
  | "invalid_response"
  | "business";

/**
 * Structured error thrown by every AtlasFlightProvider method. Callers can
 * branch on `kind` / `retryable` instead of parsing error-message strings.
 */
export class AtlasApiError extends Error {
  readonly kind: AtlasApiErrorKind;
  /** HTTP status for `kind === "http"`; null for non-HTTP failures. */
  readonly status: number | null;
  /** Upstream error code if one could be derived; null otherwise. */
  readonly code: string | null;
  /** Raw envelope business status (`body.status`) when one was present. */
  readonly upstreamStatus: number | null;
  readonly retryable: boolean;

  constructor(params: {
    kind: AtlasApiErrorKind;
    message: string;
    status?: number | null;
    code?: string | null;
    upstreamStatus?: number | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "AtlasApiError";
    this.kind = params.kind;
    this.status = params.status ?? null;
    this.code = params.code ?? null;
    this.upstreamStatus = params.upstreamStatus ?? null;
    this.retryable = params.retryable ?? false;
  }
}

export interface AtlasFlightProviderConfig {
  apiKey: string;
  baseUrl: string;
  /** Sent as `x-atlas-client-id`; the real API rejects requests without it. */
  clientId?: string;
  timeoutMs: number;
}

/**
 * Parse ATLAS_TIMEOUT_MS defensively: any unparsable, non-finite or
 * non-positive value falls back to the default (never returns NaN).
 */
function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Base-URL resolution order: ATLAS_SANDBOX_URL ?? ATLAS_BASE_URL ?? sandbox
 * default. Single source of truth so health reporting never re-derives it.
 */
function resolveBaseUrl(env: Record<string, string | undefined> | undefined): string {
  return env?.ATLAS_SANDBOX_URL ?? env?.ATLAS_BASE_URL ?? DEFAULT_ATLAS_BASE_URL;
}

/**
 * Resolve Atlas config from the environment. Mirrors the project's existing
 * server-env pattern: `typeof process !== "undefined"` guards so a bundled
 * client never throws "process is not defined". Non-throwing: an explicit
 * constructor config may supply the key instead (tests, DI).
 */
function resolveEnvConfig(): Omit<AtlasFlightProviderConfig, "apiKey"> & { apiKey?: string } {
  const env = typeof process !== "undefined" ? process.env : undefined;
  return {
    apiKey: env?.ATLAS_API_KEY,
    baseUrl: resolveBaseUrl(env),
    clientId: env?.ATLAS_CLIENT_ID,
    timeoutMs: parseTimeoutMs(env?.ATLAS_TIMEOUT_MS),
  };
}

/**
 * Host of the resolved Atlas base URL (same resolution order as the
 * provider). Never throws — an unparsable base URL falls back to the
 * default sandbox host. Used by the health snapshot for honest provenance.
 */
export function resolvedAtlasHost(): string {
  const env = typeof process !== "undefined" ? process.env : undefined;
  try {
    return new URL(resolveBaseUrl(env)).host;
  } catch {
    return new URL(DEFAULT_ATLAS_BASE_URL).host;
  }
}

// --------------------------------------------------------------- mapping

/**
 * IATA carrier code → display name. Atlas `search.do` segments carry ONLY
 * the two-letter IATA code in `carrier`, but the FlightOption contract
 * promises the airline NAME — this static map resolves the codes the
 * sandbox actually sells. Names are sourced from the app's own curated
 * airline list (`src/routes/trips.$tripId.tsx` AIRLINE_BRAND table).
 * Unknown codes fall through to the raw code (never a blank label).
 */
const ATLAS_AIRLINE_NAMES: Record<string, string> = {
  AF: "Air France",
  LH: "Lufthansa",
  BA: "British Airways",
  EK: "Emirates",
  QR: "Qatar Airways",
  SQ: "Singapore Airlines",
  UA: "United",
  AA: "American Airlines",
  DL: "Delta",
  KL: "KLM",
  TK: "Turkish Airlines",
  FR: "Ryanair",
  U2: "easyJet",
  IB: "Iberia",
  AC: "Air Canada",
  NH: "ANA",
  JL: "Japan Airlines",
  TR: "Scoot",
  SL: "Thai Lion Air",
  JQ: "Jetstar",
  "3K": "Jetstar Asia",
  TZ: "Scoot",
  MM: "Peach",
  BC: "Skymark",
  GK: "Jetstar Japan",
  VJ: "VietJet Air",
  VN: "Vietnam Airlines",
  PR: "Philippine Airlines",
  "5J": "Cebu Pacific",
  OD: "Batik Air Malaysia",
  AK: "AirAsia",
  D7: "AirAsia X",
  BR: "EVA Air",
  CI: "China Airlines",
  KE: "Korean Air",
  OZ: "Asiana Airlines",
  MU: "China Eastern",
  CZ: "China Southern",
  CA: "Air China",
  HX: "Hong Kong Airlines",
  UO: "HK Express",
  CX: "Cathay Pacific",
  TG: "Thai Airways",
  MH: "Malaysia Airlines",
  GA: "Garuda Indonesia",
  AM: "Aeromexico",
  AV: "Avianca",
  LA: "LATAM",
  ET: "Ethiopian Airlines",
  KQ: "Kenya Airways",
  WN: "Southwest",
  VY: "Vueling",
  W6: "Wizz Air",
  EW: "Eurowings",
  LX: "Swiss",
  OS: "Austrian",
  SK: "SAS",
  AY: "Finnair",
  TP: "TAP Air Portugal",
  AZ: "ITA Airways",
  TO: "Transavia France",
  HV: "Transavia",
  SN: "Brussels Airlines",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Accepts numbers AND numeric strings (upstream amounts are inconsistent). */
function amount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse the Atlas compact timestamp `"YYYYMMDDHHMM"` into an ISO-8601 UTC
 * string. Upstream times are local airport times WITHOUT a zone designator;
 * they are carried as UTC instants so the canonical FlightOption contract
 * (ISO strings) stays intact. Returns null on any malformed input.
 */
export function parseAtlasDateTime(raw: unknown): IsoTimestamp | null {
  if (typeof raw !== "string" || !/^\d{12}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, 0);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Format an ISO timestamp as the Atlas `fromDate` value `"YYYYMMDD"` (UTC). */
export function formatAtlasDate(iso: IsoTimestamp): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Transaction-fee total honoring the upstream `transactionFeeMode`
 * (PER_PAX / PER_SEGMENT / PER_TICKET / PER_BOOKING; absent mode = flat fee).
 */
function transactionFeeTotal(
  routing: Record<string, unknown>,
  segmentCount: number,
  adults: number,
): number | null {
  const fee = amount(routing.transactionFee);
  if (fee === null) return null;
  const mode = routing.transactionFeeMode;
  if (mode === "PER_PAX") return fee * adults;
  if (mode === "PER_SEGMENT") return fee * adults * Math.max(1, segmentCount);
  if (mode === "PER_TICKET" || mode === "PER_BOOKING") return fee;
  if (mode === undefined || mode === null) return fee;
  return fee; // unknown mode: quote the flat fee rather than fail the offer
}

/**
 * Map ONE upstream routing (search.do / verify.do shape) into the canonical
 * {@link FlightOption}. Returns null — never throws — for malformed routings
 * so a single bad offer cannot sink an otherwise valid search response.
 *
 * Price = (adultPrice + adultTax) * adults + transactionFee (mode-aware).
 */
export function routingToFlightOption(raw: unknown, adults: number): FlightOption | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.routingIdentifier);
  const currency = nonEmptyString(raw.currency);
  const adultPrice = amount(raw.adultPrice);
  const adultTax = amount(raw.adultTax);
  const segments = Array.isArray(raw.fromSegments) ? raw.fromSegments : null;
  if (
    id === null ||
    currency === null ||
    adultPrice === null ||
    adultTax === null ||
    !segments ||
    segments.length === 0
  ) {
    return null;
  }

  const parsedSegments: Array<{
    depAirport: string;
    arrAirport: string;
    depTime: IsoTimestamp;
    arrTime: IsoTimestamp;
    carrier: string;
    flightNumber: string;
    carrierName: string | null;
  }> = [];
  for (const rawSegment of segments) {
    if (!isRecord(rawSegment)) return null;
    const depAirport = nonEmptyString(rawSegment.depAirport);
    const arrAirport = nonEmptyString(rawSegment.arrAirport);
    const depTime = parseAtlasDateTime(rawSegment.depTime);
    const arrTime = parseAtlasDateTime(rawSegment.arrTime);
    const carrier = nonEmptyString(rawSegment.carrier);
    let fn = rawSegment.flightNumber;
    const flightNumber =
      typeof fn === "string" && fn.length > 0
        ? fn
        : typeof fn === "number" && Number.isFinite(fn)
          ? String(fn)
          : null;
    // Tolerant, optional upstream carrier display name (some envelopes
    // expose it as `carrierName`, others as `airlineName`).
    const carrierName =
      nonEmptyString(rawSegment.carrierName) ?? nonEmptyString(rawSegment.airlineName);
    if (!depAirport || !arrAirport || !depTime || !arrTime || !carrier || !flightNumber) {
      return null;
    }
    parsedSegments.push({
      depAirport,
      arrAirport,
      depTime,
      arrTime,
      carrier,
      flightNumber,
      carrierName,
    });
  }

  const fee = transactionFeeTotal(raw, parsedSegments.length, adults);
  if (fee === null) return null;

  const first = parsedSegments[0];
  const last = parsedSegments[parsedSegments.length - 1];
  // Comparison facts the approval card needs to rank one option against
  // another: a 6-hour one-stop and a 2-hour non-stop are not the same
  // product, even at the same fare. Derived from the segments we already
  // parsed, so they cost no extra upstream call.
  const stops = parsedSegments.length - 1;
  const stopAirports = parsedSegments.slice(1).map((segment) => segment.depAirport);
  // Keep the hops themselves, not just the count derived from them. Atlas has
  // always parsed per-segment detail here and then discarded it, so a swarm
  // rebooking could only ever tell the traveller HOW MANY stops it had chosen
  // — never where, on what, or how long the connection was.
  const mappedSegments: FlightSegment[] = parsedSegments.map((segment) => ({
    carrier: segment.carrierName ?? segment.carrier,
    flightNumber: segment.flightNumber,
    origin: segment.depAirport,
    destination: segment.arrAirport,
    departureTime: segment.depTime,
    arrivalTime: segment.arrTime,
  }));
  const departMs = Date.parse(first.depTime);
  const arriveMs = Date.parse(last.arrTime);
  const durationMinutes =
    Number.isFinite(departMs) && Number.isFinite(arriveMs) && arriveMs > departMs
      ? Math.round((arriveMs - departMs) / 60_000)
      : undefined;
  return {
    id,
    // Contract says airline NAME, upstream gives an IATA code: upstream
    // display name wins, then the curated map, then the raw code.
    airline: first.carrierName ?? ATLAS_AIRLINE_NAMES[first.carrier] ?? first.carrier,
    flightNumber: first.flightNumber,
    origin: first.depAirport,
    destination: last.arrAirport,
    departureTime: first.depTime,
    arrivalTime: last.arrTime,
    price: Math.round((adultPrice + adultTax) * adults * 100 + fee * 100) / 100,
    currency,
    stops,
    ...(stopAirports.length > 0 ? { stopAirports } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(mappedSegments.length > 0 ? { segments: mappedSegments } : {}),
    // The routing's REAL rule blob (change/refund windows, baggage). Dropping
    // it is what forced the policy rail onto a hardcoded 25 EUR default while
    // Atlas was publishing the true fee for this very fare on every search.
    ...(isRecord(raw.rule) ? { fareRule: raw.rule as Record<string, unknown> } : {}),
  };
}

/** Total price of a routing object (same arithmetic as the search mapping). */
function routingTotal(raw: unknown, adults: number): { total: number; currency: string } | null {
  const option = routingToFlightOption(raw, adults);
  return option ? { total: option.price, currency: option.currency } : null;
}

function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "AbortError") {
    return /timed?\s?out/i.test(error.message);
  }
  return false;
}

/**
 * Atlas encodes the cabin as an integer on `search.do` / the segment payloads
 * (`cabinClass: 1` = economy in the sandbox fixtures). Unknown or absent
 * cabins return null so the request omits the field entirely — pinning an
 * unknown cabin to economy would silently downgrade a premium ticket.
 */
export function atlasCabinClass(cabin: string | undefined): number | null {
  switch (cabin) {
    case "economy":
      return 1;
    case "premium_economy":
      return 2;
    case "business":
      return 3;
    case "first":
      return 4;
    default:
      return null;
  }
}

/** Per-request id for search.do (uuid when available, deterministic fallback). */
function newRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Fictional sandbox traveler for order.do (docs' TEST/TRAVELER pattern). */
const SANDBOX_PASSENGER: Record<string, unknown> = {
  name: "TEST/TRAVELER",
  passengerType: 0, // adult
  gender: "M",
  birthday: "19900101",
  nationality: "US",
  cardType: "PP",
  cardNum: "E12345678",
  cardIssuePlace: "US",
  cardExpired: "20350101",
};

// Upstream validates the contact phone against "XXXX-XXXXXXXX" (4-digit
// country prefix + 8-digit number, e.g. 0001-87291810) and rejects order.do
// with business status 410 on any other shape — the old 11-digit
// "001-5551234567" could never pass.
const SANDBOX_CONTACT: Record<string, unknown> = {
  name: "TEST/TRAVELER",
  email: "sandbox@example.com",
  mobile: "0001-55512345",
};

interface EnvelopeResult {
  status: number;
  msg: string | null;
  /** Payload keys: everything alongside status/msg (also exposed as `data`). */
  data: Record<string, unknown>;
  /**
   * Additive liveness correlation ids echoed by the Atlas envelope (captured
   * at the payload-extraction skip point). `requestId` mirrors the request's
   * own correlation id; `uuid` is the server-assigned one. Used ONLY for the
   * additive `flight/atlas_liveness` trace proof — never for control flow.
   */
  requestId?: string;
  uuid?: string;
}

export class AtlasFlightProvider implements FlightProvider {
  readonly providerName = "atlas-sandbox";

  private readonly config: AtlasFlightProviderConfig;

  /** routingIdentifier → sessionId cache (verify.do → order.do, same request). */
  private readonly sessionCache = new Map<string, string>();

  constructor(config?: Partial<AtlasFlightProviderConfig>) {
    const fromEnv = resolveEnvConfig();
    // Explicit `undefined` fields must NOT clobber env-derived defaults
    // (a plain spread would overwrite them), and an explicitly provided
    // timeout is validated with the same rules as the env variable.
    const explicitTimeout = config?.timeoutMs;
    const timeoutMs =
      explicitTimeout !== undefined && Number.isFinite(explicitTimeout) && explicitTimeout > 0
        ? explicitTimeout
        : fromEnv.timeoutMs;
    const apiKey = config?.apiKey ?? fromEnv.apiKey;
    if (!apiKey) {
      throw new Error(
        "AtlasFlightProvider: ATLAS_API_KEY is not set. Configure it in the environment before constructing the provider.",
      );
    }
    this.config = {
      apiKey,
      baseUrl: config?.baseUrl ?? fromEnv.baseUrl,
      clientId: config?.clientId ?? fromEnv.clientId,
      timeoutMs,
    };
  }

  async searchAlternativeFlights(
    flightId: string,
    newTime: IsoTimestamp,
    routeContext?: FlightRouteContext,
  ): Promise<AlternativeFlightsResult> {
    const empty: AlternativeFlightsResult = {
      referenceFlightId: flightId,
      requestedTime: newTime,
      options: [],
    };

    // Graceful degradation: the real API is route-based — without an
    // origin/destination pair there is nothing to search for.
    const origin = routeContext?.origin?.trim().toUpperCase();
    const destination = routeContext?.destination?.trim().toUpperCase();
    if (!origin || !destination || origin === destination) return empty;

    const fromDate = formatAtlasDate(routeContext?.departureDate ?? newTime);
    if (!fromDate) return empty;

    const adults = clampAdults(routeContext?.adults);
    // A BUSINESS decline is not a failure to report upward — it is an answer,
    // and a specific one: "we did not look". Letting it throw made the whole
    // search collapse into a generic degrade, and (worse) a window where SOME
    // dates decline and others answer emptily would have counted only the
    // empty ones and concluded a coverage gap from half the evidence.
    let envelope: EnvelopeResult;
    try {
      envelope = await this.searchEnvelope({
      tripType: "1",
      requestId: newRequestId(),
      adultNum: adults,
      childNum: 0,
      infantNum: 0,
      fromCity: origin,
      toCity: destination,
      fromDate,
      // Quote in the traveler's own currency when we know it — verified live
      // on 2026-08-31 that the sandbox honours it (LGW→BCN returned
      // `"currency":"EUR"`, adultPrice 52.98). SANDBOX_CURRENCY stays the
      // fallback for callers that supply no context.
      currency: quoteCurrency(routeContext?.currency),
      // Search the cabin the traveller already holds. Omitted entirely when
      // unknown, so the upstream keeps its own default rather than being
      // pinned to economy by us.
      ...(atlasCabinClass(routeContext?.cabin) !== null
        ? { cabinClass: atlasCabinClass(routeContext?.cabin) }
        : {}),
      });
    } catch (error) {
      // ONLY a request-level decline. A gzip misconfiguration, a search-limit
      // quota or a transient upstream fault must still surface as errors —
      // swallowing those would hide real breakage behind a friendly message.
      if (error instanceof AtlasApiError && error.code === "SEARCH_DECLINED") {
        return {
          ...empty,
          searchWasAnswered: false,
          searchDeclinedReason: error.message,
        };
      }
      throw error;
    }

    // A non-zero business status means Atlas DECLINED the search, not that it
    // looked and found nothing. Verified live 2026-09-02: a past date returns
    // HTTP 200 with `{"routings": [], "status": 102, "msg": "Can not search
    // past flights"}` — indistinguishable from a genuine empty answer unless
    // this field is read, and mistaking it for one accuses the partner of a
    // coverage gap it does not have.
    const declined = envelope.status !== 0;
    if (declined) {
      return {
        ...empty,
        searchWasAnswered: false,
        ...(envelope.msg ? { searchDeclinedReason: envelope.msg } : {}),
      };
    }

    const rawRoutings = envelope.data.routings;
    if (!Array.isArray(rawRoutings)) {
      // Zero results is a VALID outcome (noResultReason payloads); a missing
      // key entirely is not.
      if ("noResultReason" in envelope.data) return { ...empty, searchWasAnswered: true };
      throw new AtlasApiError({
        kind: "invalid_response",
        message: 'Atlas search.do response is missing the "routings" array.',
        code: "SERVICE_RESPONSE_INVALID",
        upstreamStatus: envelope.status,
      });
    }

    const options: FlightOption[] = [];
    for (const raw of rawRoutings) {
      const option = routingToFlightOption(raw, adults);
      if (option) options.push(option);
      else console.warn("[atlas] skipping malformed routing in search.do response");
    }
    // Additive liveness correlation: the search.do envelope id (server uuid
    // preferred, echoed requestId fallback) rides the result so the agent
    // layer can prove the sandbox was actually reached.
    const searchCorrelationId = envelope.uuid ?? envelope.requestId;
    return {
      referenceFlightId: flightId,
      requestedTime: newTime,
      options,
      // status 0 above ⇒ Atlas really did look. An empty `options` here is a
      // genuine answer about its inventory.
      searchWasAnswered: true,
      ...(searchCorrelationId !== undefined ? { atlasSearchRequestId: searchCorrelationId } : {}),
    };
  }

  async calculateFareDifference(
    oldFlightId: string,
    newFlightId: string,
    routeContext?: FlightRouteContext,
  ): Promise<FareDifference> {
    const adults = clampAdults(routeContext?.adults);
    // verify.do re-prices the candidate and issues the booking session.
    const envelope = await this.post("/verify.do", { routingIdentifier: newFlightId });
    const sessionId = nonEmptyString(envelope.data.sessionId);
    if (!sessionId) {
      throw new AtlasApiError({
        kind: "invalid_response",
        message: 'Atlas verify.do response is missing the "sessionId".',
        code: "SERVICE_RESPONSE_INVALID",
        upstreamStatus: envelope.status,
      });
    }
    // Cache for a same-request bookFlight (approve re-verifies otherwise).
    this.sessionCache.set(newFlightId, sessionId);

    // A verify.do response WITHOUT a routing is a hard failure for pricing
    // purposes — there is no re-priced fare to compare against.
    const verified = routingTotal(envelope.data.routing, adults);
    if (!verified) {
      throw new AtlasApiError({
        kind: "invalid_response",
        message: "Atlas verify.do response is missing a re-priceable routing.",
        code: "SERVICE_RESPONSE_INVALID",
        upstreamStatus: envelope.status,
      });
    }

    // Client-side delta: verified price vs the original booking fare. The
    // subtraction is only HONEST when the original fare is a finite >= 0
    // amount quoted in the SAME currency as the verified re-price (case-
    // insensitive); anything else — unknown or cross-currency original —
    // quotes the full verified total as the charge (basis "full_fare").
    // Never a silent 0, never a cross-currency subtraction.
    //
    // LIVENESS CORRELATION DESIGN (single consistent scheme): the search.do
    // envelope id rides AlternativeFlightsResult.atlasSearchRequestId and
    // each verify.do envelope id rides the FareDifference.atlasRequestId
    // additive field below; FlightAgent aggregates both into
    // FlightRebookingAssessment.atlasCorrelation for the trace proof.
    const verifyCorrelationId = envelope.uuid ?? envelope.requestId;
    const originalFare = routeContext?.originalFare;
    const currenciesMatch =
      typeof routeContext?.currency === "string" &&
      routeContext.currency.trim().length > 0 &&
      routeContext.currency.trim().toUpperCase() === verified.currency.toUpperCase();
    if (
      originalFare !== undefined &&
      Number.isFinite(originalFare) &&
      originalFare >= 0 &&
      currenciesMatch
    ) {
      const delta = Math.round((verified.total - originalFare) * 100) / 100;
      return {
        oldFlightId,
        newFlightId,
        amount: Math.abs(delta),
        currency: verified.currency,
        direction: delta < 0 ? "refund" : "charge",
        basis: "fare_difference",
        originalFare,
        adults,
        ...(verifyCorrelationId !== undefined ? { atlasRequestId: verifyCorrelationId } : {}),
      };
    }
    return {
      oldFlightId,
      newFlightId,
      amount: Math.round(verified.total * 100) / 100,
      currency: verified.currency,
      direction: "charge",
      basis: "full_fare",
      adults,
      ...(verifyCorrelationId !== undefined ? { atlasRequestId: verifyCorrelationId } : {}),
    };
  }

  async bookFlight(flightId: string): Promise<BookingConfirmation> {
    // TRUST-LAYER NOTE: must only ever be invoked after the surrounding
    // ResolutionPlan (requires_human_approval: true) received explicit human
    // approval — see src/agents/finance/TrustLayer.ts.

    // 1) verify.do → sessionId (reuse a same-request cache entry when present).
    let sessionId = this.sessionCache.get(flightId);
    if (!sessionId) {
      const verified = await this.post("/verify.do", { routingIdentifier: flightId });
      sessionId = nonEmptyString(verified.data.sessionId) ?? undefined;
      if (!sessionId) {
        throw new AtlasApiError({
          kind: "invalid_response",
          message: 'Atlas verify.do response is missing the "sessionId".',
          code: "SERVICE_RESPONSE_INVALID",
          upstreamStatus: verified.status,
        });
      }
    }

    // 2) order.do with the fictional sandbox traveler → orderNo.
    const order = await this.post("/order.do", {
      sessionId,
      passengers: [SANDBOX_PASSENGER],
      contact: SANDBOX_CONTACT,
    });
    const orderNo = nonEmptyString(order.data.orderNo);
    if (!orderNo) {
      throw new AtlasApiError({
        kind: "invalid_response",
        message: 'Atlas order.do response is missing the "orderNo".',
        code: "SERVICE_RESPONSE_INVALID",
        upstreamStatus: order.status,
      });
    }

    // 3) pay.do BEST-EFFORT: balance payment (paymentMethod 1). Ticketing
    //    convenience only — a payment failure never blocks the approval flow;
    //    the orderNo is returned either way.
    let bookingStatus: BookingConfirmation["status"] = "pending";
    try {
      const pay = await this.post("/pay.do", { orderNo, paymentMethod: 1 });
      // 406 / 615 = payment processing — still counts as accepted upstream.
      bookingStatus =
        pay.status === 0 || pay.status === 406 || pay.status === 615 ? "confirmed" : "pending";
    } catch (error) {
      console.warn(
        "[atlas] best-effort pay.do failed (order kept):",
        error instanceof AtlasApiError ? error.message : error,
      );
    }

    return {
      confirmationCode: orderNo,
      flightId,
      status: bookingStatus,
      bookedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------- internals

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "*/*",
      // HARD upstream requirement — without it the API returns status 102.
      "Accept-Encoding": "gzip",
      "x-atlas-client-secret": this.config.apiKey,
    };
    if (this.config.clientId) {
      headers["x-atlas-client-id"] = this.config.clientId;
    }
    return headers;
  }

  /**
   * Single POST gateway: auth headers, timeout, HTTP handling, JSON parsing
   * and the business-envelope status mapping. Every failure mode becomes an
   * AtlasApiError — raw fetch/JSON exceptions never escape.
   */
  /** `/search.do`, kept separate so the caller can catch business declines. */
  private searchEnvelope(payload: Record<string, unknown>): Promise<EnvelopeResult> {
    return this.post("/search.do", payload);
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<EnvelopeResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      } as RequestInit);
    } catch (error) {
      if (isTimeoutFailure(error)) {
        throw new AtlasApiError({
          kind: "timeout",
          message: `Atlas request to ${path} timed out after ${this.config.timeoutMs}ms.`,
          retryable: true,
          cause: error,
        });
      }
      throw new AtlasApiError({
        kind: "network",
        message: `Atlas request to ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
        cause: error,
      });
    }

    // The body read is part of the failure contract: a stream interruption or
    // a timeout firing during the body phase must surface as an AtlasApiError.
    let rawText: string;
    try {
      rawText = await response.text();
    } catch (error) {
      const kind = isTimeoutFailure(error) ? "timeout" : "network";
      throw new AtlasApiError({
        kind,
        message: `Atlas response body for ${path} could not be read (${kind}).`,
        status: response.status,
        retryable: true,
        cause: error,
      });
    }

    let body: unknown = null;
    if (rawText.length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch (error) {
        throw new AtlasApiError({
          kind: "parse",
          message: `Atlas returned a non-JSON response body for ${path} (HTTP ${response.status}).`,
          status: response.status,
          retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
          cause: error,
        });
      }
    }

    if (!response.ok) {
      const upstream = isRecord(body) ? nonEmptyString(body.msg) : null;
      throw new AtlasApiError({
        kind: "http",
        message:
          response.status === 401 || response.status === 403
            ? "Atlas rejected the configured credentials."
            : (upstream ?? `Atlas request to ${path} failed with HTTP ${response.status}.`),
        status: response.status,
        code:
          response.status === 401 || response.status === 403
            ? "CREDENTIAL_REJECTED"
            : RETRYABLE_HTTP_STATUSES.has(response.status)
              ? "SERVICE_TEMPORARILY_UNAVAILABLE"
              : "SERVICE_REQUEST_FAILED",
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
      });
    }

    if (!isRecord(body)) {
      throw new AtlasApiError({
        kind: "invalid_response",
        message: `Atlas returned a non-object envelope for ${path}.`,
        status: response.status,
        code: "SERVICE_RESPONSE_INVALID",
      });
    }

    const status = body.status;
    if (typeof status !== "number" || !Number.isFinite(status) || !Number.isInteger(status)) {
      throw new AtlasApiError({
        kind: "invalid_response",
        message: `Atlas envelope for ${path} is missing an integer "status".`,
        status: response.status,
        code: "SERVICE_RESPONSE_INVALID",
      });
    }

    if (status !== 0) {
      throw this.businessError(path, status, nonEmptyString(body.msg));
    }

    // Payload = envelope siblings of status/msg. Some deployments also nest
    // them under `data` — both shapes are honored. The envelope's
    // requestId/uuid correlation ids are captured ADDITIVELY here (they were
    // previously discarded) so the liveness proof can quote them.
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "status" || key === "msg" || key === "requestId" || key === "uuid") continue;
      data[key] = value;
    }
    if (isRecord(body.data)) {
      for (const [key, value] of Object.entries(body.data)) {
        if (!(key in data)) data[key] = value;
      }
    }
    const requestId = nonEmptyString(body.requestId) ?? undefined;
    const uuid = nonEmptyString(body.uuid) ?? undefined;
    return {
      status,
      msg: nonEmptyString(body.msg),
      data,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(uuid !== undefined ? { uuid } : {}),
    };
  }

  /** Envelope business-status → structured error mapping. */
  private businessError(path: string, status: number, msg: string | null): AtlasApiError {
    // Status 102 carries two unrelated meanings upstream. One is a config
    // fault on our side (missing gzip); the other is Atlas declining a request
    // it considers invalid — "Can not search past flights", verified live
    // 2026-09-02. Mapping both to GZIP_ENCODING_REQUIRED made a perfectly
    // ordinary past-dated trip look like a broken client.
    if (status === 102 && /past flight/i.test(msg ?? "")) {
      return new AtlasApiError({
        kind: "business",
        message: msg ?? "Atlas declined the search.",
        code: "SEARCH_DECLINED",
        upstreamStatus: status,
        retryable: false,
      });
    }
    if (status === 102) {
      return new AtlasApiError({
        kind: "business",
        message: msg ?? "Atlas requires Accept-Encoding: gzip on every request (status 102).",
        code: "GZIP_ENCODING_REQUIRED",
        upstreamStatus: status,
        retryable: false,
      });
    }
    if (status === 109) {
      return new AtlasApiError({
        kind: "business",
        message: msg ?? "Atlas flight search limit reached (status 109).",
        code: "SEARCH_LIMIT_REACHED",
        upstreamStatus: status,
        retryable: false,
      });
    }
    if (status === 900) {
      return new AtlasApiError({
        kind: "business",
        message: msg ?? "Atlas rejected the configured credentials (status 900).",
        code: "CREDENTIAL_REJECTED",
        upstreamStatus: status,
        retryable: false,
      });
    }
    if (RETRYABLE_BUSINESS_STATUSES.has(status)) {
      return new AtlasApiError({
        kind: "business",
        message: msg ?? `Atlas is temporarily unavailable (status ${status}).`,
        code: "SERVICE_TEMPORARILY_UNAVAILABLE",
        upstreamStatus: status,
        retryable: true,
      });
    }
    return new AtlasApiError({
      kind: "business",
      message: msg ?? `Atlas request to ${path} was rejected (status ${status}).`,
      code: `ATLAS_STATUS_${status}`,
      upstreamStatus: status,
      retryable: false,
    });
  }
}

/** Adults clamped to the upstream-accepted range (1..9), default 1. */
function clampAdults(adults: number | undefined): number {
  if (adults === undefined || !Number.isFinite(adults)) return 1;
  return Math.min(9, Math.max(1, Math.trunc(adults)));
}
