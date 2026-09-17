import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenWeatherProvider } from "../openweathermap/OpenWeatherProvider";
import { PredictHQProvider } from "../predicthq/PredictHQProvider";

const weather = () =>
  new OpenWeatherProvider({
    apiKey: "test-secret",
    baseUrl: "https://weather.invalid",
  }).getRainForecast(48, 2, 3);
const events = () =>
  new PredictHQProvider({
    apiToken: "test-token",
    baseUrl: "https://events.invalid",
  }).findDisruptiveEvents({
    latitude: 48,
    longitude: 2,
    from: "2026-09-15T00:00:00Z",
    to: "2026-09-16T00:00:00Z",
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

for (const [name, run, empty] of [
  ["weather", weather, { hourly: [] }],
  ["events", events, { results: [] }],
] as const) {
  describe(`${name} provider contract`, () => {
    it("accepts explicit credentials without environment credentials", async () => {
      vi.stubEnv("OPENWEATHER_API_KEY", "");
      vi.stubEnv("PREDICTHQ_API_TOKEN", "");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(empty)));
      const result = await run();
      expect("windows" in result ? result.windows : result.events).toEqual([]);
    });
    it.each([
      [401, false],
      [429, true],
      [503, true],
    ])("classifies HTTP %s", async (status, retryable) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ error: "failed" }, { status: Number(status) })),
      );
      await expect(run()).rejects.toMatchObject({ kind: "http", status, retryable });
    });
    it("rejects a malformed success body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ unexpected: [] })));
      await expect(run()).rejects.toMatchObject({ kind: "invalid_response", retryable: false });
    });
    it("classifies non-JSON responses", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("<html>unavailable</html>", { status: 503 })),
      );
      await expect(run()).rejects.toMatchObject({ kind: "parse", retryable: true });
    });
    it.each([
      ["TimeoutError", "timeout"],
      ["TypeError", "network"],
    ])("classifies %s", async (name, kind) => {
      const error = new Error("request failed");
      error.name = name;
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
      await expect(run()).rejects.toMatchObject({ kind, retryable: true });
    });
  });
}

it("weather errors do not include query credentials", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const error = await weather().catch((error) => error);
  expect(error.message).not.toContain("test-secret");
  expect(error.message).not.toContain("appid");
});

it("sorts rain steps, excludes past rain and respects the requested horizon", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
  const base = Date.now() / 1000;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        hourly: [
          { dt: base + 3600, pop: 0.8 },
          { dt: base - 7200, pop: 1 },
          { dt: base, pop: 0.6 },
          { dt: base + 3 * 3600, pop: 1 },
        ],
      }),
    ),
  );
  expect((await weather()).windows).toEqual([
    {
      start: "2026-09-15T12:00:00.000Z",
      end: "2026-09-15T14:00:00.000Z",
      probability: 0.8,
      description: "",
    },
  ]);
});

it("ignores malformed events and retains valid provider evidence", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({
          results: [
            null,
            { id: "bad", title: "Invalid", start: "unknown" },
            {
              id: "event-1",
              title: "Rail strike",
              start: "2026-09-15T12:00:00Z",
              category: "disasters",
            },
          ],
        }),
      ),
  );
  const result = await events();
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({
    id: "event-1",
    name: "Rail strike",
    start: "2026-09-15T12:00:00.000Z",
  });
  expect(result.source).toBe("predicthq:v1-events");
});
