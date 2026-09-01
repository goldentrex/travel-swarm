/**
 * OpenWeatherProvider — {@link WeatherContextProvider} backed by
 * OpenWeatherMap (spec §2.3: weather context for the proactive monitor).
 *
 * Configuration (read from environment at construction time):
 * - `OPENWEATHER_API_KEY`  — required; constructor throws if absent
 *   (check {@link openWeatherConfigured} first to degrade gracefully).
 * - `OPENWEATHER_BASE_URL` — optional override, defaults to the public API.
 * - `OPENWEATHER_TIMEOUT_MS` — optional per-request timeout, defaults 10000.
 *
 * Rain detection is deterministic: One Call 3.0 hourly steps with
 * precipitation probability ≥ 0.5 (or a rain-family `weather.main`) are merged
 * into contiguous {@link RainWindow}s. Error contract mirrors
 * AtlasFlightProvider: every failure surfaces as a structured
 * {@link WeatherApiError} with `kind` / `retryable`, never raw exceptions.
 */

import type { WeatherContextProvider } from "../interfaces/ContextProviders";
import type { RainForecastResult, RainWindow } from "../interfaces/types";

const DEFAULT_OPENWEATHER_BASE_URL = "https://api.openweathermap.org";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HORIZON_HOURS = 48;
/** Hourly precipitation probability at/above which a step counts as rain. */
const RAIN_PROBABILITY_THRESHOLD = 0.5;
/** One Call `weather.main` families treated as rain regardless of `pop`. */
const RAIN_WEATHER_MAINS = new Set(["rain", "drizzle", "thunderstorm"]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type WeatherApiErrorKind = "http" | "network" | "timeout" | "parse" | "invalid_response";

/** Structured error thrown by OpenWeatherProvider. */
export class WeatherApiError extends Error {
  readonly kind: WeatherApiErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(params: {
    kind: WeatherApiErrorKind;
    message: string;
    status?: number | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "WeatherApiError";
    this.kind = params.kind;
    this.status = params.status ?? null;
    this.retryable = params.retryable ?? false;
  }
}

export interface OpenWeatherProviderConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

/** Graceful-degradation probe: true when OPENWEATHER_API_KEY is present. */
export function openWeatherConfigured(): boolean {
  const env = typeof process !== "undefined" ? process.env : undefined;
  return Boolean(env?.OPENWEATHER_API_KEY);
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function resolveEnvConfig(): OpenWeatherProviderConfig {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const apiKey = env?.OPENWEATHER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OpenWeatherProvider: OPENWEATHER_API_KEY is not set. Check openWeatherConfigured() before constructing the provider to degrade gracefully.",
    );
  }
  return {
    apiKey,
    baseUrl: env?.OPENWEATHER_BASE_URL ?? DEFAULT_OPENWEATHER_BASE_URL,
    timeoutMs: parseTimeoutMs(env?.OPENWEATHER_TIMEOUT_MS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class OpenWeatherProvider implements WeatherContextProvider {
  readonly providerName = "openweathermap";

  private readonly config: OpenWeatherProviderConfig;

  constructor(config?: Partial<OpenWeatherProviderConfig>) {
    const fromEnv = resolveEnvConfig();
    const explicitTimeout = config?.timeoutMs;
    const timeoutMs =
      explicitTimeout !== undefined && Number.isFinite(explicitTimeout) && explicitTimeout > 0
        ? explicitTimeout
        : fromEnv.timeoutMs;
    this.config = {
      apiKey: config?.apiKey ?? fromEnv.apiKey,
      baseUrl: (config?.baseUrl ?? fromEnv.baseUrl).replace(/\/+$/, ""),
      timeoutMs,
    };
  }

  async getRainForecast(
    latitude: number,
    longitude: number,
    horizonHours: number = DEFAULT_HORIZON_HOURS,
  ): Promise<RainForecastResult> {
    const params = new URLSearchParams({
      lat: String(latitude),
      lon: String(longitude),
      exclude: "current,minutely,daily,alerts",
      appid: this.config.apiKey,
    });
    const body = await this.request("GET", `/data/3.0/onecall?${params}`);
    if (!isRecord(body) || !Array.isArray(body.hourly)) {
      throw new WeatherApiError({
        kind: "invalid_response",
        message: 'OpenWeatherMap One Call response is missing the "hourly" array.',
      });
    }

    const horizonMs = Math.max(1, Math.trunc(horizonHours)) * 60 * 60 * 1000;
    const nowMs = Date.now();
    const windows: RainWindow[] = [];
    let open: { startMs: number; endMs: number; probability: number; description: string } | null =
      null;

    for (const rawStep of body.hourly) {
      if (!isRecord(rawStep)) continue;
      const dt = typeof rawStep.dt === "number" ? rawStep.dt * 1000 : NaN;
      if (!Number.isFinite(dt) || dt > nowMs + horizonMs) continue;
      const pop = typeof rawStep.pop === "number" ? rawStep.pop : 0;
      const weather =
        Array.isArray(rawStep.weather) && isRecord(rawStep.weather[0])
          ? (rawStep.weather[0] as Record<string, unknown>)
          : null;
      const main = typeof weather?.main === "string" ? weather.main.toLowerCase() : "";
      const description = typeof weather?.description === "string" ? weather.description : "";
      const isRain = pop >= RAIN_PROBABILITY_THRESHOLD || RAIN_WEATHER_MAINS.has(main);

      if (isRain) {
        const stepEnd = dt + 60 * 60 * 1000;
        if (open && dt <= open.endMs) {
          open.endMs = stepEnd;
          open.probability = Math.max(open.probability, pop);
          if (description.length > open.description.length) open.description = description;
        } else {
          if (open) windows.push(toRainWindow(open));
          open = { startMs: dt, endMs: stepEnd, probability: pop, description };
        }
      }
    }
    if (open) windows.push(toRainWindow(open));

    return {
      latitude,
      longitude,
      windows,
      source: "openweathermap:onecall-3.0",
    };
  }

  // ---------------------------------------------------------------- internals

  private async request(method: "GET", path: string): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      } as RequestInit);
    } catch (error) {
      const timeout = isTimeoutFailure(error);
      throw new WeatherApiError({
        kind: timeout ? "timeout" : "network",
        message: `OpenWeatherMap request to ${path} ${timeout ? "timed out" : "failed"}.`,
        retryable: true,
        cause: error,
      });
    }

    let body: unknown = null;
    const rawText = await response.text().catch((error) => {
      throw new WeatherApiError({
        kind: isTimeoutFailure(error) ? "timeout" : "network",
        message: `OpenWeatherMap response body for ${path} could not be read.`,
        status: response.status,
        retryable: true,
        cause: error,
      });
    });
    if (rawText.length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch (error) {
        throw new WeatherApiError({
          kind: "parse",
          message: `OpenWeatherMap returned a non-JSON body for ${path} (status ${response.status}).`,
          status: response.status,
          retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
          cause: error,
        });
      }
    }

    if (!response.ok) {
      throw new WeatherApiError({
        kind: "http",
        message: `OpenWeatherMap request to ${path} failed with HTTP ${response.status}.`,
        status: response.status,
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
      });
    }
    return body;
  }
}

function toRainWindow(open: {
  startMs: number;
  endMs: number;
  probability: number;
  description: string;
}): RainWindow {
  return {
    start: new Date(open.startMs).toISOString(),
    end: new Date(open.endMs).toISOString(),
    probability: Math.min(1, Math.max(0, open.probability)),
    description: open.description,
  };
}

function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  if (error instanceof Error && error.name === "AbortError") {
    return /timed?\s?out/i.test(error.message);
  }
  return false;
}
