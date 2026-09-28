/**
 * A weather alert we did not verify must say so — every time, not sometimes.
 *
 * The disclosure used to be written only when the provider was REACHED and
 * failed. Every earlier exit fell through silently: no city on the event, a
 * geocode that found nothing, no provider configured. And the geocoder asked
 * Nominatim's strict `city=` parameter with the trip's decorated destination
 * — "Rome, Italy", "Japan (Tokyo, Osaka, Kyoto)" — which matches nothing.
 *
 * Measured against the deployed Worker on 2026-09-18: of six live weather
 * missions, ONE disclosed. The other five headlined "Weather alert — Rome,
 * Italy" and moved a booked activity on the strength of it. A plausible claim
 * with no source is the defect this engine exists to refuse, so the
 * disclosure is the default here and a confirmation has to be earned.
 */

import { describe, expect, it, vi } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { OrchestratorAgent } from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import type { WeatherContextProvider } from "@/providers/interfaces/ContextProviders";
import type { RainForecastResult } from "@/providers/interfaces/types";

const OUTDOOR = "activity-0-0";

/** One outdoor activity, carrying the venue's own coordinates like a real trip. */
function tripGraph(withCoordinates = true): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: OUTDOOR,
    type: "activity",
    name: "Piazza Santa Maria in Trastevere",
    durationMinutes: 90,
    scheduledTime: Date.now() + 20 * 3_600_000,
    status: "on_track",
    dependsOn: [],
    ...(withCoordinates ? { coordinates: { lat: 41.8896, lng: 12.4695 } } : {}),
  });
  return graph;
}

function weatherEvent(city: string): DisruptionEvent {
  return {
    nodeId: OUTDOOR,
    delay: 0,
    description: `Weather alert — ${city}`,
    origin: "proactive",
    tripContext: { city },
    evidence: {
      kind: "weather",
      source: "mission-intent",
      confidence: 0.6,
      detail: "Heavy rain forecast tomorrow",
    },
  };
}

function provider(result: RainForecastResult | Error): WeatherContextProvider {
  return {
    providerName: "fake-weather",
    async getRainForecast(): Promise<RainForecastResult> {
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as WeatherContextProvider;
}

const forecast = (
  windows: RainForecastResult["windows"],
  coversHorizon = true,
): RainForecastResult => ({ latitude: 41.8896, longitude: 12.4695, windows, coversHorizon, source: "fake" });

/** Run the pipeline and read the headline it settled on. */
async function headlineFor(
  weather: WeatherContextProvider | null,
  options: { city?: string; coordinates?: boolean } = {},
): Promise<string> {
  const event = weatherEvent(options.city ?? "Rome, Italy");
  // graph, flight, policy, hotel, activity, WEATHER — the branch under test
  // needs the weather slot and an activity agent that can be asked.
  const orchestrator = new OrchestratorAgent(
    tripGraph(options.coordinates ?? true),
    null,
    null,
    null,
    { proposeRescheduling: async () => [] } as never,
    weather,
  );
  await orchestrator.resolveDisruptionMulti(event);
  // The branch rewrites the event's description to what it actually found.
  return event.description;
}

describe("a weather alert is only confirmed when it was really checked", () => {
  it("discloses when the provider is not configured at all", async () => {
    expect(await headlineFor(null)).toMatch(/not independently confirmed/);
  });

  it("discloses when the provider refuses the key", async () => {
    // The live case: OpenWeather answers 401 because the key carries no One
    // Call subscription. The traveller's word still stands, and stands alone.
    const headline = await headlineFor(provider(new Error("HTTP 401")));
    expect(headline).toMatch(/not independently confirmed/);
    expect(headline).toContain("Rome, Italy");
  });

  it("discloses when the forecast stops before the window it was asked about", async () => {
    // An empty answer from a forecast that does not reach that far is not
    // "clear skies". Presenting it as such would invent the one thing the
    // traveller acts on.
    expect(await headlineFor(provider(forecast([], false)))).toMatch(/not independently confirmed/);
  });

  it("says clear skies ONLY on a real, covering, empty forecast", async () => {
    const headline = await headlineFor(provider(forecast([], true)));
    expect(headline).toMatch(/clear skies/);
    expect(headline).not.toMatch(/not independently confirmed/);
  });

  it("confirms rain when the provider actually found some", async () => {
    const headline = await headlineFor(
      provider(
        forecast([
          {
            start: new Date(Date.now() + 3_600_000).toISOString(),
            end: new Date(Date.now() + 10_800_000).toISOString(),
            probability: 0.9,
            description: "moderate rain",
          },
        ]),
      ),
    );
    expect(headline).toMatch(/Confirmed rain/);
  });

  it("never leaves the bare claim standing, whatever the destination is called", async () => {
    // These four are the QA corpus's own destinations. Under the old
    // geocoder every one of them resolved to nothing, and the headline was
    // left asserting a weather alert as established fact.
    for (const city of [
      "Rome, Italy",
      "Tokyo, Japan",
      "London, United Kingdom",
      "Japan (Tokyo, Osaka, Kyoto)",
    ]) {
      const headline = await headlineFor(provider(new Error("HTTP 401")), { city });
      expect(headline, `destination "${city}"`).toMatch(/not independently confirmed/);
    }
  });
});

describe("the coordinates come from the trip before they come from a search", () => {
  it("asks the provider about the venue's own position, never a city centroid", async () => {
    const seen: Array<[number, number]> = [];
    const spy = {
      providerName: "fake-weather",
      async getRainForecast(latitude: number, longitude: number): Promise<RainForecastResult> {
        seen.push([latitude, longitude]);
        return forecast([]);
      },
    } as unknown as WeatherContextProvider;
    await headlineFor(spy);
    // The activity's own coordinates, to the decimal — no network, nothing
    // to fail on a decorated place name.
    expect(seen).toEqual([[41.8896, 12.4695]]);
  });

  it("does not invent a position when the trip carries none", async () => {
    // Without coordinates the only route left is geocoding, which is a
    // network call the test forbids: the honest outcome is the disclosure.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const headline = await headlineFor(provider(forecast([])), { coordinates: false });
    expect(headline).toMatch(/not independently confirmed/);
    vi.unstubAllGlobals();
  });
});
