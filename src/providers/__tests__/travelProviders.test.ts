import { afterEach, describe, expect, it, vi } from "vitest";
import { RapidApiHotelProvider } from "../rapidapi/RapidApiHotelProvider";
import { ViatorActivityProvider } from "../viator/ViatorActivityProvider";
import { resetHotelQuota } from "@/providers/rapidapi/hotelQuota";

const query = {
  hotelName: "Test Hotel",
  checkIn: "2026-10-01T12:00:00Z",
  nights: 2,
  guests: 1,
  currency: "EUR",
};
/** `booking-com`'s /v1/hotels/locations answers with a BARE array. */
const location = [
  {
    dest_id: "1",
    dest_type: "hotel",
    name: "Test Hotel",
    latitude: 48,
    longitude: 2,
    city_ufi: -1456928,
    city_name: "Paris",
  },
];
/** One flat property, as the coordinate search returns them. */
const nearby = (
  id: number,
  price: number | string | null,
  extra: Record<string, unknown> = {},
) => ({
  hotel_id: id,
  hotel_name: `Property ${id}`,
  latitude: 48.002,
  longitude: 2.002,
  currency_code: "EUR",
  ...(price === null ? {} : { min_total_price: price }),
  ...extra,
});
/** A city-search entry, as `booking-com15` nests it. */
const cityHotel = (
  id: number,
  price: number | string | null,
  extra: Record<string, unknown> = {},
) => ({
  hotel_id: id,
  property: {
    id,
    name: `Property ${id}`,
    latitude: 48.002,
    longitude: 2.002,
    currency: "EUR",
    priceBreakdown: price === null ? {} : { grossPrice: { value: price, currency: "EUR" } },
    ...extra,
  },
});
const hotel = () =>
  new RapidApiHotelProvider({ apiKey: "test", host: "hotels.invalid" }).searchAlternativeRooms(
    query,
  );
const activities = () =>
  new ViatorActivityProvider({
    supabaseUrl: "https://edge.invalid",
    supabaseKey: "test",
    viatorApiKey: "",
  }).searchActivities({ query: "museum", currency: "EUR" });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // A 429 in one case must not silence the next: the memo is a fact about
  // the key, and these doubles each stand for a different key's day.
  resetHotelQuota();
});

describe("hotel supplier contracts", () => {
  /** `booking-com`: the locations lookup, then one neighbourhood search. */
  const coordinateListing = (searchBody: unknown) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/hotels/locations")) return Response.json(location);
      return Response.json(searchBody);
    });

  it("keeps missing property terms unverified", async () => {
    // The search found the property but it publishes neither an arrival
    // window nor a cancellable flag. Half-known is unverified, and the
    // engine's honest degraded answer is the correct outcome; a convenient
    // default is not.
    vi.stubGlobal("fetch", coordinateListing({ result: [nearby(1, 120)] }));
    await expect(
      new RapidApiHotelProvider({ apiKey: "test", host: "hotels.invalid" }).getHotelPolicies(
        query.hotelName,
        query.checkIn,
        1,
      ),
    ).rejects.toMatchObject({ code: "hotel_policy_unverified" });
  });

  it("reads the terms of the property it asked about, not a neighbour's", async () => {
    // One search answers for a whole neighbourhood, so the terms have to be
    // picked out of it by id. Reading the first result instead would quote
    // the hotel next door's cancellation policy as this one's.
    vi.stubGlobal(
      "fetch",
      coordinateListing({
        result: [
          nearby(2, 90, { checkin: { from: "15:00", until: "00:00" }, is_free_cancellable: 1 }),
          nearby(1, 120, { checkin: { from: "15:00", until: "22:00" }, cancellation_fee: 35 }),
        ],
      }),
    );
    await expect(
      new RapidApiHotelProvider({ apiKey: "test", host: "hotels.invalid" }).getHotelPolicies(
        query.hotelName,
        "2026-10-01T23:30:00Z",
        1,
      ),
      // 23:30 is past the requested property's own 22:00 cutoff, and its fee
      // is 35 — the neighbour's midnight desk and free cancellation are not
      // this traveller's terms.
    ).resolves.toMatchObject({ lateCheckInAvailable: false, cancellationFee: 35, currency: "EUR" });
  });

  it("asks each listing its own endpoints", async () => {
    // `RAPIDAPI_HOST` is the whole switch. Asking `booking-com15` for a
    // coordinate search is what returned a room 102 km away; asking
    // `booking-com` for a city search would 404.
    const asked: string[] = [];
    const record = (body: unknown) =>
      vi.fn(async (input: RequestInfo | URL) => {
        asked.push(String(input));
        const url = String(input);
        if (url.includes("locations") || url.includes("searchDestination"))
          return Response.json(url.includes("searchDestination") ? { data: location } : location);
        return Response.json(body);
      });

    vi.stubGlobal("fetch", record({ result: [] }));
    await new RapidApiHotelProvider({ apiKey: "t", host: "booking-com.p.rapidapi.com" })
      .searchAlternativeRooms(query);
    expect(asked.some((url) => url.includes("/v1/hotels/locations"))).toBe(true);
    expect(asked.some((url) => url.includes("/v1/hotels/search-by-coordinates"))).toBe(true);

    asked.length = 0;
    vi.stubGlobal("fetch", record({ data: { hotels: [] } }));
    await new RapidApiHotelProvider({ apiKey: "t", host: "booking-com15.p.rapidapi.com" })
      .searchAlternativeRooms(query);
    expect(asked.some((url) => url.includes("/api/v1/hotels/searchDestination"))).toBe(true);
    expect(asked.some((url) => url.includes("search_type=CITY"))).toBe(true);
    expect(asked.some((url) => url.includes("searchHotelsByCoordinates"))).toBe(false);
  });

  it("uses explicit configuration and derives per-night price", async () => {
    vi.stubEnv("RAPIDAPI_KEY", "");
    vi.stubEnv("RAPIDAPI_HOST", "");
    const fetcher = coordinateListing({
      result: [
        nearby(2, 180),
        // A rate that is absent, negative or unreadable is not a price.
        nearby(3, -5),
        nearby(4, "invalid"),
        nearby(5, null),
        // No position: we cannot say it is near, so we do not offer it.
        { hotel_id: 6, hotel_name: "Nowhere", min_total_price: 100, currency_code: "EUR" },
        // The traveller's own property is not an alternative to itself.
        nearby(1, 120),
      ],
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await hotel();
    expect(result.rooms).toHaveLength(1);
    expect(result.rooms[0]).toMatchObject({ roomId: "2", ratePerNight: 90, currency: "EUR" });
  });

  it("distinguishes empty inventory from a malformed response", async () => {
    vi.stubGlobal("fetch", coordinateListing({ result: [] }));
    expect((await hotel()).rooms).toEqual([]);
    vi.stubGlobal("fetch", coordinateListing({ unknown: [] }));
    await expect(hotel()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([
    [401, false],
    [429, true],
    [503, true],
  ])("classifies HTTP %s", async (status, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ message: "test" }, { status: Number(status) })),
    );
    await expect(hotel()).rejects.toMatchObject({ kind: "http", status, retryable });
    resetHotelQuota();
  });

  it.each([
    ["TimeoutError", "timeout"],
    ["TypeError", "network"],
  ])("classifies %s", async (name, kind) => {
    const error = new Error("offline");
    error.name = name;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(hotel()).rejects.toMatchObject({ kind, retryable: true });
  });

  it("rejects an unresolvable hotel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
    await expect(hotel()).rejects.toMatchObject({
      kind: "invalid_response",
      code: "hotel_not_found",
    });
  });
});

describe("activity supplier contracts", () => {
  it("preserves an empty successful search", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ products: [] })));
    expect(await activities()).toMatchObject({ options: [], degraded: false });
  });
  it.each([401, 429, 503])("degrades HTTP %s without throwing", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "test" }, { status })));
    expect(await activities()).toMatchObject({ options: [], degraded: true });
  });
  it.each(["TimeoutError", "TypeError"])("degrades %s without throwing", async (name) => {
    const error = new Error("offline");
    error.name = name;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    expect(await activities()).toMatchObject({ options: [], degraded: true });
  });
  it("does not call a malformed Partner response a healthy empty search", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ unknown: [] })));
    const provider = new ViatorActivityProvider({
      supabaseUrl: "",
      supabaseKey: "",
      viatorApiKey: "test",
      viatorBase: "https://partner.invalid",
    });
    expect(await provider.searchActivities({ query: "museum" })).toMatchObject({
      options: [],
      degraded: true,
    });
  });
});
