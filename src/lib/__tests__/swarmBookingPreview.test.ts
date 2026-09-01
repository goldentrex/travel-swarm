/**
 * The booking trust layer's contract with the traveler.
 *
 * This module answers the question "what do these actually cost?" on the screen
 * immediately before someone taps a button that says "book these for me". Every
 * test here is about that answer telling the truth: a price badged as live must
 * come from a provider, a price badged as an estimate must be the trip's own
 * figure, and a line nobody could price must say so rather than borrow a number
 * or quietly vanish from the sheet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hotelSearch = vi.fn();
const activitySearch = vi.fn();
const hotelConfigured = vi.fn(() => true);
const activityConfigured = vi.fn(() => true);

vi.mock("@/providers", () => ({
  RapidApiHotelProvider: class {
    searchAlternativeRooms = hotelSearch;
  },
  ViatorActivityProvider: class {
    searchActivities = activitySearch;
  },
  rapidApiHotelConfigured: () => hotelConfigured(),
  viatorEdgeConfigured: () => activityConfigured(),
}));

const { buildBookingPreview } = await import("@/lib/swarmBookingPreview");

/** A stay the fake Booking.com will price. */
function stay(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "stay" as const,
    title: "Keio Plaza Hotel Tokyo",
    checkIn: "2026-10-08",
    nights: 2,
    guests: 2,
    ...extra,
  };
}

function activity(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "activity" as const, title: "Shinjuku Gyoen", ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  hotelConfigured.mockReturnValue(true);
  activityConfigured.mockReturnValue(true);
  hotelSearch.mockResolvedValue({
    rooms: [{ hotelName: "Keio Plaza Hotel Tokyo", ratePerNight: 120, currency: "EUR" }],
  });
  activitySearch.mockResolvedValue({
    options: [{ name: "Shinjuku Gyoen Walking Tour", price: 19, currency: "EUR" }],
  });
});

describe("what a live price is allowed to claim", () => {
  it("a stay quote is the nightly rate times the nights actually planned", async () => {
    const preview = await buildBookingPreview([stay("s1")]);
    const line = preview.lines[0];
    expect(line.priceSource).toBe("live_provider");
    expect(line.price).toBe(240); // 120 × 2 nights, not the nightly rate
    expect(line.provider).toBe("Booking.com");
    expect(line.matchedName).toBe("Keio Plaza Hotel Tokyo");
    expect(preview.providersUsed).toContain("Booking.com");
  });

  it("a provider that answers nothing degrades that LINE, never the sheet", async () => {
    hotelSearch.mockResolvedValue({ rooms: [] });
    const preview = await buildBookingPreview([stay("s1", { estimate: 300, currency: "EUR" }), activity("a1")]);
    // The stay falls back to the trip's OWN figure, badged as an estimate…
    expect(preview.lines[0].priceSource).toBe("trip_estimate");
    expect(preview.lines[0].price).toBe(300);
    expect(preview.lines[0].unavailableReason).toBeTruthy();
    // …while the activity is still priced live. One dead lookup is not an outage.
    expect(preview.lines[1].priceSource).toBe("live_provider");
    expect(preview.providersUsed).toEqual(["Viator"]);
    expect(preview.providersDegraded).toEqual(["Booking.com"]);
  });

  it("a provider that throws is caught — a preview never fails as a whole", async () => {
    activitySearch.mockRejectedValue(new Error("viator exploded"));
    const preview = await buildBookingPreview([activity("a1", { estimate: 40, currency: "EUR" })]);
    expect(preview.lines[0].priceSource).toBe("trip_estimate");
    expect(preview.lines[0].price).toBe(40);
  });

  it("a provider that answered for one line is not reported as degraded overall", async () => {
    activitySearch
      .mockResolvedValueOnce({ options: [{ name: "Tour", price: 19, currency: "EUR" }] })
      .mockResolvedValueOnce({ options: [] });
    const preview = await buildBookingPreview([activity("a1"), activity("a2")]);
    expect(preview.providersUsed).toEqual(["Viator"]);
    expect(preview.providersDegraded).toEqual([]);
  });
});

describe("lines nobody can price", () => {
  it("says 'not priced' rather than 'shown as planned' when there is nothing to show", async () => {
    // Live on 2026-09-01: activities with no cost on the trip AND no Viator
    // match came back reading "Shown as planned — too many activities to price
    // at once." under a row displaying no price whatsoever. The copy promised a
    // figure the sheet did not have.
    const many = Array.from({ length: 16 }, (_, i) => activity(`a${i}`));
    const preview = await buildBookingPreview(many);
    const capped = preview.lines.filter((l) => l.priceSource === "unknown");
    expect(capped.length).toBeGreaterThan(0);
    for (const line of capped) {
      expect(line.unavailableReason).toContain("Not priced");
      expect(line.unavailableReason).not.toContain("Shown as planned");
      expect(line.price).toBeUndefined(); // never a zero standing in for unknown
    }
  });

  it("still says 'shown as planned' when the trip's own figure IS shown", async () => {
    const many = Array.from({ length: 16 }, (_, i) =>
      activity(`a${i}`, { estimate: 25, currency: "EUR" }),
    );
    const preview = await buildBookingPreview(many);
    const capped = preview.lines.filter((l) => l.priceSource === "trip_estimate");
    expect(capped.some((l) => l.unavailableReason?.includes("Shown as planned"))).toBe(true);
  });

  it("an unconfigured provider degrades every line of its kind, with a reason", async () => {
    activityConfigured.mockReturnValue(false);
    const preview = await buildBookingPreview([activity("a1")]);
    expect(preview.lines[0].priceSource).toBe("unknown");
    expect(preview.lines[0].unavailableReason).toBeTruthy();
    expect(preview.providersDegraded).toContain("Viator");
    expect(activitySearch).not.toHaveBeenCalled();
  });
});

describe("dates that have already gone", () => {
  // Live on 2026-09-01 against a May-2026 trip: Booking.com throws on a past
  // check-in and Viator has no availability to return, so every row read "the
  // live rate could not be checked just now" — blaming a transient outage for
  // something that can never succeed. The traveler is owed the real reason.
  const PAST = "2020-01-05";

  it("says the stay is in the past instead of blaming the provider", async () => {
    const preview = await buildBookingPreview([stay("s1", { checkIn: PAST })]);
    expect(preview.lines[0].unavailableReason).toContain("in the past");
    expect(preview.lines[0].unavailableReason).not.toContain("just now");
    // …and does not spend a provider call discovering it.
    expect(hotelSearch).not.toHaveBeenCalled();
  });

  it("says the day has passed for an activity, without calling Viator", async () => {
    const preview = await buildBookingPreview([activity("a1", { date: PAST })]);
    expect(preview.lines[0].unavailableReason).toContain("already passed");
    expect(activitySearch).not.toHaveBeenCalled();
  });

  it("keeps the trip's own figure when there is one to keep", async () => {
    const preview = await buildBookingPreview([
      activity("a1", { date: PAST, estimate: 42, currency: "EUR" }),
    ]);
    expect(preview.lines[0].priceSource).toBe("trip_estimate");
    expect(preview.lines[0].price).toBe(42);
    expect(preview.lines[0].unavailableReason).toContain("Shown as planned");
  });

  it("today is NOT the past — a same-day booking is still priced", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await buildBookingPreview([activity("a1", { date: today })]);
    expect(activitySearch).toHaveBeenCalled();
  });
});

describe("the subrequest budget", () => {
  it("caps lookups so one preview cannot exhaust the Worker's 50 subrequests", async () => {
    // A stay costs two subrequests, an activity one. The ceilings exist so a
    // long trip cannot spend the budget the ownership check and trip hydration
    // also draw on.
    const lines = [
      ...Array.from({ length: 9 }, (_, i) => stay(`s${i}`)),
      ...Array.from({ length: 20 }, (_, i) => activity(`a${i}`)),
    ];
    await buildBookingPreview(lines);
    expect(hotelSearch.mock.calls.length).toBeLessThanOrEqual(6);
    expect(activitySearch.mock.calls.length).toBeLessThanOrEqual(14);
  });

  it("answers EVERY line it was given, in the order it was given them", async () => {
    // The sheet matches rows to answers by id; a dropped or reordered reply is
    // how a row silently ends up showing another row's price.
    const lines = [stay("s1"), activity("a1"), { id: "t1", kind: "transport" as const, title: "TGV" }];
    const preview = await buildBookingPreview(lines);
    expect(preview.lines.map((l) => l.id)).toEqual(["s1", "a1", "t1"]);
    expect(preview.lines.every((l) => l !== undefined)).toBe(true);
  });
});

describe("one sheet, one currency", () => {
  it("asks every provider to quote in the sheet's currency", async () => {
    await buildBookingPreview([stay("s1", { currency: "JPY" }), activity("a1", { currency: "USD" })], "EUR");
    // The requested quote currency wins over each line's own local currency —
    // otherwise the confirm screen shows three totals for one purchase.
    expect(hotelSearch.mock.calls[0][0]).toMatchObject({ currency: "EUR" });
    expect(activitySearch.mock.calls[0][0]).toMatchObject({ currency: "EUR" });
  });

  it("falls back to the line's own currency when the sheet names none", async () => {
    await buildBookingPreview([stay("s1", { currency: "JPY" })]);
    expect(hotelSearch.mock.calls[0][0]).toMatchObject({ currency: "JPY" });
  });

  it("reports the currency the provider actually answered in, not the one asked for", async () => {
    // Verified against the live API: Booking.com's search-by-coordinates
    // ignores the currency filter and prices in the property's own currency.
    // Echoing back "EUR" would label a JPY figure as euros.
    hotelSearch.mockResolvedValue({
      rooms: [{ hotelName: "Keio Plaza", ratePerNight: 53_130, currency: "JPY" }],
    });
    const preview = await buildBookingPreview([stay("s1")], "EUR");
    expect(preview.lines[0].currency).toBe("JPY");
  });
});

describe("lines the swarm does not price at all", () => {
  it("keeps the trip's own figure for transport and dining without calling a provider", async () => {
    const preview = await buildBookingPreview([
      { id: "t1", kind: "transport", title: "TGV to Lyon", estimate: 89, currency: "EUR" },
      { id: "d1", kind: "dining", title: "Dinner", estimate: 60, currency: "EUR" },
    ]);
    expect(preview.lines.map((l) => l.priceSource)).toEqual(["trip_estimate", "trip_estimate"]);
    expect(hotelSearch).not.toHaveBeenCalled();
    expect(activitySearch).not.toHaveBeenCalled();
  });
});
