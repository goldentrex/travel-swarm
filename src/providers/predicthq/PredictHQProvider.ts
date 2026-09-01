/**
 * PredictHQProvider — {@link EventDisruptionContextProvider} backed by the
 * PredictHQ Events API (spec §2.3: event-disruption context for the proactive
 * monitor).
 *
 * Configuration (read from environment at construction time):
 * - `PREDICTHQ_API_TOKEN`  — required bearer token; constructor throws if
 *   absent (check {@link predictHQConfigured} first to degrade gracefully).
 * - `PREDICTHQ_BASE_URL`   — optional override, defaults to api.predicthq.com.
 * - `PREDICTHQ_TIMEOUT_MS` — optional per-request timeout, defaults 10000.
 *
 * Error contract mirrors AtlasFlightProvider: every failure surfaces as a
 * structured {@link PredictHQError} with `kind` / `retryable`, never raw
 * fetch/JSON exceptions.
 */

import type { EventDisruptionContextProvider } from "../interfaces/ContextProviders";
import type {
  EventDisruptionInfo,
  EventDisruptionQuery,
  EventDisruptionResult,
} from "../interfaces/types";

const DEFAULT_PREDICTHQ_BASE_URL = "https://api.predicthq.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 20;

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type PredictHQErrorKind = "http" | "network" | "timeout" | "parse" | "invalid_response";

/** Structured error thrown by PredictHQProvider. */
export class PredictHQError extends Error {
  readonly kind: PredictHQErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(params: {
    kind: PredictHQErrorKind;
    message: string;
    status?: number | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "PredictHQError";
    this.kind = params.kind;
    this.status = params.status ?? null;
    this.retryable = params.retryable ?? false;
  }
}

export interface PredictHQProviderConfig {
  apiToken: string;
  baseUrl: string;
  timeoutMs: number;
}

/** Graceful-degradation probe: true when PREDICTHQ_API_TOKEN is present. */
export function predictHQConfigured(): boolean {
  const env = typeof process !== "undefined" ? process.env : undefined;
  return Boolean(env?.PREDICTHQ_API_TOKEN);
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function resolveEnvConfig(): PredictHQProviderConfig {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const apiToken = env?.PREDICTHQ_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "PredictHQProvider: PREDICTHQ_API_TOKEN is not set. Check predictHQConfigured() before constructing the provider to degrade gracefully.",
    );
  }
  return {
    apiToken,
    baseUrl: env?.PREDICTHQ_BASE_URL ?? DEFAULT_PREDICTHQ_BASE_URL,
    timeoutMs: parseTimeoutMs(env?.PREDICTHQ_TIMEOUT_MS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export class PredictHQProvider implements EventDisruptionContextProvider {
  readonly providerName = "predicthq";

  private readonly config: PredictHQProviderConfig;

  constructor(config?: Partial<PredictHQProviderConfig>) {
    const fromEnv = resolveEnvConfig();
    const explicitTimeout = config?.timeoutMs;
    const timeoutMs =
      explicitTimeout !== undefined && Number.isFinite(explicitTimeout) && explicitTimeout > 0
        ? explicitTimeout
        : fromEnv.timeoutMs;
    this.config = {
      apiToken: config?.apiToken ?? fromEnv.apiToken,
      baseUrl: (config?.baseUrl ?? fromEnv.baseUrl).replace(/\/+$/, ""),
      timeoutMs,
    };
  }

  async findDisruptiveEvents(query: EventDisruptionQuery): Promise<EventDisruptionResult> {
    const radiusKm = Math.max(1, Math.trunc(query.radiusKm ?? 25));
    const params = new URLSearchParams({
      location_around: `${query.latitude},${query.longitude},${radiusKm}km`,
      "start.gte": query.from,
      "start.lt": query.to,
      sort: "start",
      limit: String(MAX_RESULTS),
    });
    const body = await this.request("GET", `/v1/events/?${params}`);

    if (!isRecord(body) || !Array.isArray(body.results)) {
      throw new PredictHQError({
        kind: "invalid_response",
        message: 'PredictHQ events response is missing the "results" array.',
      });
    }

    const events: EventDisruptionInfo[] = [];
    for (const raw of body.results) {
      if (!isRecord(raw)) continue;
      const id = typeof raw.id === "string" ? raw.id : "";
      const name = typeof raw.title === "string" ? raw.title : "";
      const start = toIso(raw.start);
      if (!id || !name || !start) continue;
      const place =
        isRecord(raw.place) && typeof raw.place.scope === "string"
          ? placeName(raw.place)
          : undefined;
      events.push({
        id,
        name,
        category: typeof raw.category === "string" ? raw.category : "unknown",
        start,
        end: toIso(raw.end),
        location: place,
      });
    }

    return { query, events, source: "predicthq:v1-events" };
  }

  // ---------------------------------------------------------------- internals

  private async request(method: "GET", path: string): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      } as RequestInit);
    } catch (error) {
      const timeout = isTimeoutFailure(error);
      throw new PredictHQError({
        kind: timeout ? "timeout" : "network",
        message: `PredictHQ request to ${path} ${timeout ? "timed out" : "failed"}.`,
        retryable: true,
        cause: error,
      });
    }

    let body: unknown = null;
    const rawText = await response.text().catch((error) => {
      throw new PredictHQError({
        kind: isTimeoutFailure(error) ? "timeout" : "network",
        message: `PredictHQ response body for ${path} could not be read.`,
        status: response.status,
        retryable: true,
        cause: error,
      });
    });
    if (rawText.length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch (error) {
        throw new PredictHQError({
          kind: "parse",
          message: `PredictHQ returned a non-JSON body for ${path} (status ${response.status}).`,
          status: response.status,
          retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
          cause: error,
        });
      }
    }

    if (!response.ok) {
      throw new PredictHQError({
        kind: "http",
        message: `PredictHQ request to ${path} failed with HTTP ${response.status}.`,
        status: response.status,
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
      });
    }
    return body;
  }
}

function placeName(place: Record<string, unknown>): string | undefined {
  const parts = [place.name, place.county, place.region, place.country].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "AbortError") {
    return /timed?\s?out/i.test(error.message);
  }
  return false;
}
