/**
 * Provider-agnostic context contracts for the proactive (background monitor)
 * path of the swarm: weather forecasts that can trigger rain-driven activity
 * protection, and external event feeds that flag disruption-prone windows
 * (spec §2.3 — OpenWeatherMap + PredictHQ).
 *
 * The agent layer never depends on a concrete implementation; today these are
 * backed by `OpenWeatherProvider` and `PredictHQProvider`.
 */

import type { EventDisruptionQuery, EventDisruptionResult, RainForecastResult } from "./types";

/** Weather context source: forecast lookups + rain-trigger detection. */
export interface WeatherContextProvider {
  /** Human-readable provider name, e.g. "openweathermap". */
  readonly providerName: string;

  /**
   * Fetch the precipitation outlook for a coordinate within a horizon
   * (defaults to 48h). Returns contiguous rain windows ordered by start time;
   * an empty `windows` array means no rain is forecast.
   */
  getRainForecast(
    latitude: number,
    longitude: number,
    horizonHours?: number,
  ): Promise<RainForecastResult>;
}

/** External event-disruption context source (large events, severe weather…). */
export interface EventDisruptionContextProvider {
  /** Human-readable provider name, e.g. "predicthq". */
  readonly providerName: string;

  /**
   * List events near a coordinate inside a time window that could disrupt the
   * itinerary (crowds, road closures, severe weather systems).
   */
  findDisruptiveEvents(query: EventDisruptionQuery): Promise<EventDisruptionResult>;
}
