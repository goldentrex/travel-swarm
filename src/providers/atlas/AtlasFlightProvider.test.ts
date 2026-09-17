/**
 * AtlasFlightProvider — real Atlas / Atrip sandbox wiring (Task 10).
 *
 * Covers, with a mocked global fetch:
 *   - "YYYYMMDDHHMM" → ISO parsing and fromDate formatting
 *   - routing → FlightOption mapping (+ price arithmetic)
 *   - mandatory header set (gzip HARD requirement, x-atlas auth pair, Accept: *&#47;*)
 *   - search.do request body shape + envelope business-status mapping
 *     (102 gzip, 109 search limit non-retryable, 110/112/9999 retryable)
 *   - graceful degradation without route context (empty candidates, no call)
 *   - verify.do-based fare difference (client-side delta vs original fare)
 *   - bookFlight verify→order→(best-effort)pay flow
 */

import { afterEach, beforeEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  AtlasApiError,
  AtlasFlightProvider,
  formatAtlasDate,
  parseAtlasDateTime,
  routingToFlightOption,
} from "./AtlasFlightProvider";
import type { FlightOption } from "../interfaces/types";

const BASE_URL = "https://sandbox.test.example";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** One canonical upstream routing (search.do / verify.do `data.routing` shape). */
function makeRouting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routingIdentifier: "RT-123",
    fid: "fid-1",
    currency: "USD",
    adultPrice: 100,
    adultTax: 20,
    transactionFee: 5,
    expireTime: "202608221800",
    fromSegments: [
      {
        depAirport: "CDG",
        arrAirport: "LIS",
        depTime: "202608221300",
        arrTime: "202608221530",
        carrier: "TP",
        operatingCarrier: "TP",
        flightNumber: "TP437",
        duration: 150,
        cabinClass: 1,
      },
    ],
    ...overrides,
  };
}

function makeProvider(): AtlasFlightProvider {
  return new AtlasFlightProvider({
    apiKey: "sk-test",
    clientId: "client-test",
    baseUrl: BASE_URL,
    timeoutMs: 1000,
  });
}

/** Last fetch call's init headers, lower-cased keys for stable assertions. */
function capturedHeaders(fetchMock: FetchMock): Record<string, string> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
  const headers = (init.headers ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

describe("parseAtlasDateTime / formatAtlasDate", () => {
  it("parses YYYYMMDDHHMM into an ISO-8601 UTC timestamp", () => {
    expect(parseAtlasDateTime("202608221305")).toBe("2026-08-22T13:05:00.000Z");
    expect(parseAtlasDateTime("202612312359")).toBe("2026-12-31T23:59:00.000Z");
  });

  it("rejects malformed compact timestamps", () => {
    expect(parseAtlasDateTime("2026-08-22T13:00:00Z")).toBeNull();
    expect(parseAtlasDateTime("2026082213")).toBeNull();
    expect(parseAtlasDateTime("202613011200")).toBeNull(); // month 13
    expect(parseAtlasDateTime("202608222561")).toBeNull(); // hour 25
    expect(parseAtlasDateTime(202608221300)).toBeNull();
    expect(parseAtlasDateTime(undefined)).toBeNull();
  });

  it("formats ISO timestamps as YYYYMMDD (UTC)", () => {
    expect(formatAtlasDate("2026-08-22T13:00:00.000Z")).toBe("20260822");
    expect(formatAtlasDate("2026-08-22T23:59:00.000Z")).toBe("20260822");
    expect(formatAtlasDate("not-a-date")).toBeNull();
  });
});

describe("routingToFlightOption mapping", () => {
  it("maps a routing to the canonical FlightOption with price arithmetic", () => {
    const option = routingToFlightOption(makeRouting(), 1) as FlightOption;
    expect(option).not.toBeNull();
    expect(option.id).toBe("RT-123");
    // IATA codes resolve through the curated carrier map (contract: NAME).
    expect(option.airline).toBe("TAP Air Portugal");
    expect(option.flightNumber).toBe("TP437");
    expect(option.origin).toBe("CDG");
    expect(option.destination).toBe("LIS");
    expect(option.departureTime).toBe("2026-08-22T13:00:00.000Z");
    expect(option.arrivalTime).toBe("2026-08-22T15:30:00.000Z");
    // (adultPrice 100 + adultTax 20) * 1 adult + fee 5 = 125
    expect(option.price).toBe(125);
    expect(option.currency).toBe("USD");
  });

  it("scales the fare by adult count and keeps the flat fee", () => {
    const option = routingToFlightOption(makeRouting(), 2) as FlightOption;
    // (100 + 20) * 2 + 5 = 245
    expect(option.price).toBe(245);
  });

  it("honours PER_PAX transactionFeeMode", () => {
    const option = routingToFlightOption(
      makeRouting({ transactionFeeMode: "PER_PAX" }),
      2,
    ) as FlightOption;
    // (100 + 20) * 2 + 5 * 2 = 250
    expect(option.price).toBe(250);
  });

  it("uses the first/last segment for origin/destination on multi-leg routings", () => {
    const routing = makeRouting({
      fromSegments: [
        {
          depAirport: "CDG",
          arrAirport: "MAD",
          depTime: "202608221300",
          arrTime: "202608221500",
          carrier: "IB",
          flightNumber: "IB3401",
          duration: 120,
        },
        {
          depAirport: "MAD",
          arrAirport: "LIS",
          depTime: "202608221600",
          arrTime: "202608221715",
          carrier: "IB",
          flightNumber: "IB3104",
          duration: 75,
        },
      ],
    });
    const option = routingToFlightOption(routing, 1) as FlightOption;
    expect(option.origin).toBe("CDG");
    expect(option.destination).toBe("LIS");
    expect(option.flightNumber).toBe("IB3401");
    expect(option.arrivalTime).toBe("2026-08-22T17:15:00.000Z");
  });

  it("returns null for malformed routings (never throws)", () => {
    expect(routingToFlightOption(undefined, 1)).toBeNull();
    expect(routingToFlightOption({ ...makeRouting(), routingIdentifier: "" }, 1)).toBeNull();
    expect(routingToFlightOption({ ...makeRouting(), adultPrice: "cheap" }, 1)).toBeNull();
    expect(routingToFlightOption({ ...makeRouting(), fromSegments: [] }, 1)).toBeNull();
    expect(
      routingToFlightOption(
        {
          ...makeRouting(),
          fromSegments: [
            {
              depAirport: "CDG",
              arrAirport: "LIS",
              depTime: "garbage",
              arrTime: "202608221530",
              carrier: "TP",
              flightNumber: "TP437",
              duration: 150,
            },
          ],
        },
        1,
      ),
    ).toBeNull();
  });
});

describe("carrier display names (IATA → airline name)", () => {
  /** makeRouting variant with a different first-segment carrier. */
  const routingWithCarrier = (carrier: string, extra: Record<string, unknown> = {}) =>
    makeRouting({
      fromSegments: [
        {
          depAirport: "CDG",
          arrAirport: "LIS",
          depTime: "202608221300",
          arrTime: "202608221530",
          carrier,
          flightNumber: `${carrier}100`,
          ...extra,
        },
      ],
    });

  it("resolves curated IATA codes to display names (VY → Vueling)", () => {
    const option = routingToFlightOption(routingWithCarrier("VY"), 1) as FlightOption;
    expect(option.airline).toBe("Vueling");
  });

  it("passes unknown IATA codes through untouched (never a blank label)", () => {
    const option = routingToFlightOption(routingWithCarrier("ZZ"), 1) as FlightOption;
    expect(option.airline).toBe("ZZ");
  });

  it("prefers the upstream carrierName/airlineName when present", () => {
    const named = routingToFlightOption(
      routingWithCarrier("VY", { carrierName: "Vueling Airlines" }),
      1,
    ) as FlightOption;
    expect(named.airline).toBe("Vueling Airlines");

    const altNamed = routingToFlightOption(
      routingWithCarrier("VY", { airlineName: "Vueling Airways" }),
      1,
    ) as FlightOption;
    expect(altNamed.airline).toBe("Vueling Airways");

    // Non-string / empty names are tolerated — the map still applies.
    const empty = routingToFlightOption(
      routingWithCarrier("VY", { carrierName: "", airlineName: 42 }),
      1,
    ) as FlightOption;
    expect(empty.airline).toBe("Vueling");
  });
});

describe("searchAlternativeFlights", () => {
  let fetchMock: FetchMock;

  beforeAll(() => {
    process.env.ATLAS_API_KEY = "sk-env";
  });
  afterAll(() => {
    delete process.env.ATLAS_API_KEY;
  });
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("degrades gracefully to empty candidates without route context (no HTTP call)", async () => {
    const provider = makeProvider();
    const result = await provider.searchAlternativeFlights(
      "flight-xy123",
      "2026-08-22T13:00:00.000Z",
    );
    expect(result.options).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    // Origin/destination missing or identical also degrade without a call.
    await provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", { origin: "CDG" });
    await provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
      origin: "CDG",
      destination: "CDG",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the mandated header set including gzip (HARD requirement)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, msg: "ok", routings: [makeRouting()] }),
    );
    const provider = makeProvider();
    await provider.searchAlternativeFlights("flight-xy123", "2026-08-22T13:00:00.000Z", {
      origin: "CDG",
      destination: "LIS",
    });
    const headers = capturedHeaders(fetchMock);
    expect(headers["accept-encoding"]).toBe("gzip");
    expect(headers["accept"]).toBe("*/*");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-atlas-client-id"]).toBe("client-test");
    expect(headers["x-atlas-client-secret"]).toBe("sk-test");
    expect(headers["authorization"]).toBeUndefined(); // NOT Bearer auth
  });

  /**
   * REGRESSION — found live on 2026-08-31. `currency` was pinned to the USD
   * sandbox default on every search, so a EUR trip whose disrupted leg had no
   * known fare (the common "original fare unknown" case) was quoted in USD:
   * the traveler saw "Total due now: €25.00 + $52.64" for a Vueling LGW→BCN
   * hop, while Atlas's own payload carried the EUR fare for the same ticket.
   */
  it("quotes in the traveler's currency when the route context names one", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, msg: "ok", routings: [makeRouting()] }),
    );
    const provider = makeProvider();
    await provider.searchAlternativeFlights("flight-xy123", "2026-08-22T13:00:00.000Z", {
      origin: "LGW",
      destination: "BCN",
      currency: "EUR",
    });
    const body = JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body.currency).toBe("EUR");
  });

  it("falls back to the sandbox currency when none is known or it is malformed", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, msg: "ok", routings: [makeRouting()] }),
    );
    const provider = makeProvider();
    await provider.searchAlternativeFlights("flight-xy123", "2026-08-22T13:00:00.000Z", {
      origin: "LGW",
      destination: "BCN",
    });
    let body = JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body.currency).toBe("USD");

    // Garbage never reaches the upstream as a currency.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, msg: "ok", routings: [makeRouting()] }),
    );
    await provider.searchAlternativeFlights("flight-xy123", "2026-08-22T13:00:00.000Z", {
      origin: "LGW",
      destination: "BCN",
      currency: "euros" as never,
    });
    body = JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body.currency).toBe("USD");
  });

  it("posts the documented search.do body and maps routings", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, msg: "ok", routings: [makeRouting()] }),
    );
    const provider = makeProvider();
    const result = await provider.searchAlternativeFlights(
      "flight-xy123",
      "2026-08-22T13:00:00.000Z",
      {
        origin: "cdg",
        destination: "lis",
        departureDate: "2026-08-22T13:00:00.000Z",
      },
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/search.do`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.tripType).toBe("1");
    expect(body.fromCity).toBe("CDG");
    expect(body.toCity).toBe("LIS");
    expect(body.fromDate).toBe("20260822");
    expect(body.adultNum).toBe(1);
    expect(body.childNum).toBe(0);
    expect(body.infantNum).toBe(0);
    expect(body.currency).toBe("USD");
    expect(typeof body.requestId).toBe("string");
    // Recovery inventory is carrier/cabin unrestricted. Atlas includes LCC
    // content by default; its only documented carrier filter is `airlines`,
    // so omission means all airlines rather than an invented include flag.
    expect(body).not.toHaveProperty("airlines");
    expect(body).not.toHaveProperty("cabinClass");
    expect(body).not.toHaveProperty("includeLowCost");
    expect(body).not.toHaveProperty("includeBudgetCarriers");

    expect(result.referenceFlightId).toBe("flight-xy123");
    expect(result.options).toHaveLength(1);
    expect(result.options[0].id).toBe("RT-123");
  });

  it("skips malformed routings but keeps valid ones", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 0,
        routings: [{ broken: true }, makeRouting()],
      }),
    );
    const provider = makeProvider();
    const result = await provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
      origin: "CDG",
      destination: "LIS",
    });
    expect(result.options.map((o) => o.id)).toEqual(["RT-123"]);
  });

  it("returns empty options for an empty routings array / noResultReason", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, routings: [] }));
    const provider = makeProvider();
    const empty = await provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
      origin: "CDG",
      destination: "LIS",
    });
    expect(empty.options).toEqual([]);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, noResultReason: { code: "FLIGHT_SOLD_OUT" } }),
    );
    const noResult = await provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
      origin: "CDG",
      destination: "LIS",
    });
    expect(noResult.options).toEqual([]);
  });

  it('separates the two meanings of status 102 — a declined search is not a broken client', async () => {
    // Upstream reuses 102 for a missing gzip header AND for "Can not search
    // past flights" (verified live 2026-09-02). Mapped together, an ordinary
    // past-dated trip looked like a misconfigured client — and, worse, the
    // thrown error collapsed the whole search so the swarm could not tell the
    // traveller why. A decline is an ANSWER: "we did not look".
    const provider = makeProvider();
    const ctx = { origin: "CDG", destination: "LIS" };

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 102, msg: "Can not search past flights" }),
    );
    const declined = await provider.searchAlternativeFlights(
      "f",
      "2026-08-22T13:00:00.000Z",
      ctx,
    );
    expect(declined.options).toEqual([]);
    // The flag is what stops a coverage claim being read out of this emptiness.
    expect(declined.searchWasAnswered).toBe(false);
    expect(declined.searchDeclinedReason).toBe("Can not search past flights");
  });

  it("still throws on a gzip misconfiguration, which IS a broken client", async () => {
    // The narrowing must not become a blanket swallow: real breakage has to
    // stay loud.
    const provider = makeProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 102, msg: "gzip required" }));
    await expect(
      provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
        origin: "CDG",
        destination: "LIS",
      }),
    ).rejects.toMatchObject({ code: "GZIP_ENCODING_REQUIRED" });
  });

  it("maps envelope business statuses to structured errors", async () => {
    const provider = makeProvider();
    const ctx = { origin: "CDG", destination: "LIS" };

    // 102 — gzip missing: config error, non-retryable.
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 102, msg: "gzip required" }));
    await expect(
      provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", ctx),
    ).rejects.toMatchObject({
      name: "AtlasApiError",
      kind: "business",
      code: "GZIP_ENCODING_REQUIRED",
      upstreamStatus: 102,
      retryable: false,
    });

    // 109 — search limit: non-retryable.
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 109, msg: "limit" }));
    await expect(
      provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", ctx),
    ).rejects.toMatchObject({
      code: "SEARCH_LIMIT_REACHED",
      retryable: false,
    });

    // 110 / 112 / 9999 — transient: retryable.
    for (const status of [110, 112, 9999]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status, msg: "busy" }));
      await expect(
        provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", ctx),
      ).rejects.toMatchObject({ kind: "business", upstreamStatus: status, retryable: true });
    }

    // Unknown non-zero status — non-retryable generic business error.
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 130, msg: "rejected" }));
    await expect(
      provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", ctx),
    ).rejects.toMatchObject({
      kind: "business",
      upstreamStatus: 130,
      retryable: false,
    });
  });

  it("raises invalid_response when the routings key is missing entirely", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, msg: "ok" }));
    const provider = makeProvider();
    await expect(
      provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
        origin: "CDG",
        destination: "LIS",
      }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("captures the envelope correlation ids additively (liveness proof)", async () => {
    // post() retains the envelope requestId/uuid (previously discarded);
    // search.do surfaces them as atlasSearchRequestId (uuid preferred).
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 0,
        requestId: "req-echoed-1234",
        uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        routings: [makeRouting()],
      }),
    );
    const provider = makeProvider();
    const result = await provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
      origin: "CDG",
      destination: "LIS",
    });
    expect(result.atlasSearchRequestId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");

    // requestId-only envelopes fall back to the echoed requestId.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, requestId: "req-only-9876", routings: [] }),
    );
    const fallback = await provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
      origin: "CDG",
      destination: "LIS",
    });
    expect(fallback.atlasSearchRequestId).toBe("req-only-9876");

    // No correlation keys ⇒ the additive field stays absent.
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, routings: [] }));
    const bare = await provider.searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
      origin: "CDG",
      destination: "LIS",
    });
    expect(bare.atlasSearchRequestId).toBeUndefined();
  });
});

describe("calculateFareDifference (verify.do re-pricing)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes the client-side delta vs the original fare (charge)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, sessionId: "sess-1", routing: makeRouting() }),
    );
    const provider = makeProvider();
    const fare = await provider.calculateFareDifference("old-flight", "RT-123", {
      originalFare: 100,
      currency: "USD", // same currency as the verified re-price ⇒ true delta
    });
    expect(fare).toEqual({
      oldFlightId: "old-flight",
      newFlightId: "RT-123",
      amount: 25, // verified 125 − original 100
      currency: "USD",
      direction: "charge",
      basis: "fare_difference",
      originalFare: 100,
      adults: 1,
    });
    // verify.do got the routingIdentifier.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/verify.do`);
    expect(JSON.parse(init.body as string)).toEqual({ routingIdentifier: "RT-123" });
  });

  it("computes refunds when the verified price is lower", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 0,
        sessionId: "sess-1",
        routing: makeRouting({ adultPrice: 40, routingIdentifier: "RT-9" }),
      }),
    );
    const provider = makeProvider();
    const fare = await provider.calculateFareDifference("old", "RT-9", {
      originalFare: 100,
      currency: "usd", // currency match is case-insensitive
    });
    // verified = 40 + 20 + 5 = 65 → refund of 35
    expect(fare.direction).toBe("refund");
    expect(fare.amount).toBe(35);
    expect(fare.basis).toBe("fare_difference");
    expect(fare.originalFare).toBe(100);
  });

  it("quotes the full verified price as a charge when no original fare is known", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, sessionId: "sess-1", routing: makeRouting() }),
    );
    const provider = makeProvider();
    const fare = await provider.calculateFareDifference("old", "RT-123");
    expect(fare.direction).toBe("charge");
    expect(fare.amount).toBe(125);
    expect(fare.basis).toBe("full_fare");
    expect(fare.originalFare).toBeUndefined();
  });

  it("never subtracts a cross-currency original fare — full re-price instead", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, sessionId: "sess-1", routing: makeRouting() }),
    );
    const provider = makeProvider();
    // Original fare known in EUR while the verified re-price is USD ⇒ the
    // honest answer is the FULL verified total, never a mixed-currency delta.
    const fare = await provider.calculateFareDifference("old", "RT-123", {
      originalFare: 100,
      currency: "EUR",
    });
    expect(fare).toMatchObject({
      amount: 125,
      currency: "USD",
      direction: "charge",
      basis: "full_fare",
    });
    expect(fare.originalFare).toBeUndefined();
  });

  it("propagates upstream business failures as AtlasApiError (scripted ids)", async () => {
    // The demo rail's scripted XY777 hits this path: verify.do rejects the
    // unknown routingIdentifier and the caller falls back deterministically.
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, msg: "offer expired" }));
    const provider = makeProvider();
    const error = await provider
      .calculateFareDifference("old", "XY777")
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AtlasApiError);
    expect((error as AtlasApiError).upstreamStatus).toBe(200);
    expect((error as AtlasApiError).retryable).toBe(false);
  });

  it("fails on a missing sessionId", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, routing: makeRouting() }));
    const provider = makeProvider();
    await expect(provider.calculateFareDifference("old", "RT-123")).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("attaches the verify.do envelope correlation id additively (atlasRequestId)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 0,
        uuid: "feedface-cafe-4bad-dead-beef00000001",
        sessionId: "sess-1",
        routing: makeRouting(),
      }),
    );
    const provider = makeProvider();
    const fare = await provider.calculateFareDifference("old", "RT-123");
    expect(fare.atlasRequestId).toBe("feedface-cafe-4bad-dead-beef00000001");

    // No envelope ids ⇒ the additive field stays undefined.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, sessionId: "sess-2", routing: makeRouting() }),
    );
    const bare = await provider.calculateFareDifference("old", "RT-123");
    expect(bare.atlasRequestId).toBeUndefined();
  });
});

describe("bookFlight (verify → order → best-effort pay)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs verify → order → pay and returns the orderNo as confirmationCode", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: 0, sessionId: "sess-7", routing: makeRouting() }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: 0, orderNo: "ORD-42", totalPrice: 125, currency: "USD" }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 0, orderNo: "ORD-42" }));
    const provider = makeProvider();
    const booking = await provider.bookFlight("RT-123");

    expect(booking.confirmationCode).toBe("ORD-42");
    expect(booking.flightId).toBe("RT-123");
    expect(booking.status).toBe("confirmed");

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([`${BASE_URL}/verify.do`, `${BASE_URL}/order.do`, `${BASE_URL}/pay.do`]);
    // order.do carries the fictional sandbox passenger + the session.
    const orderBody = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(orderBody.sessionId).toBe("sess-7");
    expect(Array.isArray(orderBody.passengers)).toBe(true);
    expect((orderBody.passengers as Array<Record<string, unknown>>)[0].name).toBe("TEST/TRAVELER");
    expect(orderBody.contact).toBeDefined();
    // pay.do uses balance payment.
    expect(
      JSON.parse((fetchMock.mock.calls[2] as [string, RequestInit])[1].body as string),
    ).toEqual({ orderNo: "ORD-42", paymentMethod: 1 });
  });

  it.each([406, 615])("keeps processing payment %s pending", async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, sessionId: "sess-pending" }))
      .mockResolvedValueOnce(jsonResponse({ status: 0, orderNo: "ORD-PENDING" }))
      .mockResolvedValueOnce(jsonResponse({ status }));
    const booking = await makeProvider().bookFlight("RT-123");
    expect(booking.status).toBe("pending");
    expect(booking.confirmationCode).toBe("ORD-PENDING");
  });

  it("still returns the orderNo when pay.do fails (payment never blocks)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: 0, sessionId: "sess-7", routing: makeRouting() }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 0, orderNo: "ORD-43" }))
      .mockResolvedValueOnce(jsonResponse({ status: 403, msg: "balance unavailable" }));
    const provider = makeProvider();
    const booking = await provider.bookFlight("RT-123");
    expect(booking.confirmationCode).toBe("ORD-43");
    expect(booking.status).toBe("pending");
  });

  it("reuses the session cached by a same-request calculateFareDifference", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: 0, sessionId: "sess-cached", routing: makeRouting() }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 0, orderNo: "ORD-44" }))
      .mockResolvedValueOnce(jsonResponse({ status: 0, orderNo: "ORD-44" }));
    const provider = makeProvider();
    await provider.calculateFareDifference("old", "RT-123");
    const booking = await provider.bookFlight("RT-123");
    expect(booking.confirmationCode).toBe("ORD-44");
    // No second verify.do — the cached session was reused.
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([`${BASE_URL}/verify.do`, `${BASE_URL}/order.do`, `${BASE_URL}/pay.do`]);
    const orderBody = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(orderBody.sessionId).toBe("sess-cached");
  });

  it("surfaces a missing orderNo as an invalid_response error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: 0, sessionId: "sess-7", routing: makeRouting() }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 0 }));
    const provider = makeProvider();
    await expect(provider.bookFlight("RT-123")).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  // REGRESSION (live 2026-08-28): order.do rejected the sandbox contact
  // phone "001-5551234567" with business status 410 — upstream demands the
  // "XXXX-XXXXXXXX" shape (4-digit country prefix + 8-digit number). The
  // fixture below replays the captured upstream refusal; the assertion on
  // our own payload guarantees the rejection can never recur.
  it("sends the contact phone in the upstream XXXX-XXXXXXXX format", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: 0, sessionId: "sess-9", routing: makeRouting() }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 0, orderNo: "ORD-45" }))
      .mockResolvedValueOnce(jsonResponse({ status: 0, orderNo: "ORD-45" }));
    const provider = makeProvider();
    await provider.bookFlight("RT-123");
    const orderBody = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as { contact?: { mobile?: string } };
    expect(orderBody.contact?.mobile).toMatch(/^\d{4}-\d{8}$/);
  });

  it("propagates the captured upstream 410 phone-format rejection as non-retryable", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: 0, sessionId: "sess-9", routing: makeRouting() }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 410,
          msg: 'Use the correct format "XXXX-XXXXXXXX" for contact phone. Example: 0001-87291810, 0086-13928109091',
        }),
      );
    const provider = makeProvider();
    const error = await provider.bookFlight("RT-123").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AtlasApiError);
    expect(error).toMatchObject({
      kind: "business",
      upstreamStatus: 410,
      code: "ATLAS_STATUS_410",
      retryable: false,
    });
  });
});

describe("constructor / env contract", () => {
  it("throws when ATLAS_API_KEY is absent from the environment", () => {
    const saved = process.env.ATLAS_API_KEY;
    delete process.env.ATLAS_API_KEY;
    try {
      expect(() => new AtlasFlightProvider()).toThrow(/ATLAS_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ATLAS_API_KEY = saved;
    }
  });

  it("falls back to the real sandbox base URL when no env URL is set", () => {
    const savedUrl = process.env.ATLAS_SANDBOX_URL;
    const savedLegacy = process.env.ATLAS_BASE_URL;
    const savedKey = process.env.ATLAS_API_KEY;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_BASE_URL;
    process.env.ATLAS_API_KEY = "sk-env";
    try {
      const provider = new AtlasFlightProvider();
      // No public baseUrl accessor — assert via a degraded search (no ctx →
      // no fetch) + a routed search against the default host.
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 0, routings: [] }));
      vi.stubGlobal("fetch", fetchMock);
      return provider
        .searchAlternativeFlights("f", "2026-08-22T13:00:00.000Z", {
          origin: "CDG",
          destination: "LIS",
        })
        .then(() => {
          expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
            "https://sandbox.atriptech.com/search.do",
          );
        })
        .finally(() => {
          vi.unstubAllGlobals();
          if (savedUrl !== undefined) process.env.ATLAS_SANDBOX_URL = savedUrl;
          if (savedLegacy !== undefined) process.env.ATLAS_BASE_URL = savedLegacy;
          if (savedKey !== undefined) process.env.ATLAS_API_KEY = savedKey;
          else delete process.env.ATLAS_API_KEY;
        });
    } catch (err) {
      if (savedUrl !== undefined) process.env.ATLAS_SANDBOX_URL = savedUrl;
      if (savedLegacy !== undefined) process.env.ATLAS_BASE_URL = savedLegacy;
      if (savedKey !== undefined) process.env.ATLAS_API_KEY = savedKey;
      throw err;
    }
  });
});
