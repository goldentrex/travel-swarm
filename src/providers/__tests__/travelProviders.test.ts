import { afterEach, describe, expect, it, vi } from "vitest";
import { RapidApiHotelProvider } from "../rapidapi/RapidApiHotelProvider";
import { ViatorActivityProvider } from "../viator/ViatorActivityProvider";
const query = {
  hotelName: "Test Hotel",
  checkIn: "2026-10-01T12:00:00Z",
  nights: 2,
  guests: 1,
  currency: "EUR",
};
const location = [{ hotel_id: 1, hotel_name: "Test Hotel", latitude: 48, longitude: 2 }];
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
});

describe("hotel supplier contracts", () => {
  it.each([false, true])("keeps missing property terms unverified (nearby terms: %s)", async (nearby) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json(location))
      .mockResolvedValueOnce(Response.json({ result: [
        { hotel_id: 1, currency_code: "EUR" },
        ...(nearby ? [{ hotel_id: 2, late_check_in_available: true, cancellation_fee: 0, currency_code: "EUR" }] : []),
      ] })));
    await expect(new RapidApiHotelProvider({ apiKey: "test", host: "hotels.invalid" })
      .getHotelPolicies(query.hotelName, query.checkIn, 1))
      .rejects.toMatchObject({ code: "hotel_policy_unverified" });
  });
  it("reads verified terms only from the requested property", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json(location))
      .mockResolvedValueOnce(Response.json({ result: [
        { hotel_id: 2, late_check_in_available: true, cancellation_fee: 0, currency_code: "USD" },
        { hotel_id: 1, late_check_in_available: false, cancellation_fee: 35, currency_code: "EUR" },
      ] })));
    await expect(new RapidApiHotelProvider({ apiKey: "test", host: "hotels.invalid" })
      .getHotelPolicies(query.hotelName, query.checkIn, 1))
      .resolves.toMatchObject({ lateCheckInAvailable: false, cancellationFee: 35, currency: "EUR" });
  });

  it("uses explicit configuration and derives per-night price", async () => {
    vi.stubEnv("RAPIDAPI_KEY", "");
    vi.stubEnv("RAPIDAPI_HOST", "");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(location))
      .mockResolvedValueOnce(
        Response.json({
          result: [
            { hotel_id: 2, hotel_name: "Alternative", min_total_price: 180, currency_code: "EUR" },
            { hotel_id: 3, min_total_price: -5 },
            { hotel_id: 4, min_total_price: "invalid" },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const result = await hotel();
    expect(result.rooms).toHaveLength(1);
    expect(result.rooms[0]).toMatchObject({ roomId: "2", ratePerNight: 90, currency: "EUR" });
  });
  it("distinguishes empty inventory from a malformed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(location))
        .mockResolvedValueOnce(Response.json({ result: [] })),
    );
    expect((await hotel()).rooms).toEqual([]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(location))
        .mockResolvedValueOnce(Response.json({ unknown: [] })),
    );
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
