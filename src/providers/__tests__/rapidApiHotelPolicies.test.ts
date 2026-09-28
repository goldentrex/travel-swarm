/**
 * The hotel rail, read through the listing it actually speaks to.
 *
 * Two histories meet in this file. The first: a live battery of 42 missions
 * never produced one usable hotel verdict, because the contract read fields
 * Booking.com does not send — `late_check_in_available` (never sent; the
 * property states `checkin: {from, until}`) and `is_free_cancellable` as a
 * boolean (it arrives as `1`). The second: that listing's monthly quota ran
 * out on 2026-09-18 and answered `429` to everything, so the provider moved
 * to `booking-com15`, whose paths and payloads are different again.
 *
 * Every payload below is REAL, captured from booking-com15 on 2026-09-18 for
 * Hotel Gracery Shinjuku (hotel id 1134837) and for a Rome city search. The
 * behaviours asserted are the ones that were bought with live evidence;
 * only the shapes around them changed.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { RapidApiHotelProvider } from "@/providers/rapidapi/RapidApiHotelProvider";
import { HotelAgent } from "@/agents/hotel/HotelAgent";
import { resetHotelQuota } from "@/providers/rapidapi/hotelQuota";
import romeCitySearch from "@/providers/rapidapi/__tests__/fixtures/booking15-searchHotels-rome.json";
import romeDetails from "@/providers/rapidapi/__tests__/fixtures/booking15-getHotelDetails-rome.json";
import romeNearby from "@/providers/rapidapi/__tests__/fixtures/bookingcom-searchByCoordinates-rome.json";

const GRACERY = {
  id: "1134837",
  name: "Hotel Gracery Shinjuku",
  latitude: 35.6953566980492,
  longitude: 139.702065289021,
  cityUfi: -246227,
};

/** The destination lookup, verbatim in SHAPE: a `hotel` entry carrying the
 *  property's position AND the id of the city it stands in. */
function destinationBody(): unknown {
  return {
    status: true,
    message: "Success",
    data: [
      {
        dest_id: GRACERY.id,
        search_type: "hotel",
        dest_type: "hotel",
        name: GRACERY.name,
        latitude: GRACERY.latitude,
        longitude: GRACERY.longitude,
        city_ufi: GRACERY.cityUfi,
        city_name: "Tokyo",
        nr_hotels: 1,
      },
    ],
  };
}

/** The dedicated check-in endpoint. `until: null` is the property stating no
 *  cutoff, which is exactly how Gracery's own live payload reads. */
function checkInBody(until: string | null): unknown {
  return {
    status: true,
    message: "Success",
    data: {
      checkinCheckoutTimes: {
        checkinTimeRange: { from: "14:00", fromFormatted: "2:00 PM", until, untilFormatted: until },
        checkoutTimeRange: { from: null, until: "11:00" },
      },
    },
  };
}

/** The property detail, where this listing publishes the cancellation
 *  timeline. Exactly one stage is in force at a time. */
function detailBody(freeCancellable: boolean): unknown {
  return {
    status: true,
    message: "Success",
    data: {
      hotel_id: 1134837,
      hotel_name: GRACERY.name,
      currency_code: "JPY",
      latitude: GRACERY.latitude,
      longitude: GRACERY.longitude,
      block: [
        {
          room_name: "Double Room - Non-Smoking",
          refundable: freeCancellable ? 1 : 0,
          ...(freeCancellable ? { refundable_until: "2026-10-16 23:59:59 +0900" } : {}),
          paymentterms: {
            cancellation: {
              type: freeCancellable ? "free_cancellation" : "non_refundable",
              non_refundable_anymore: freeCancellable ? 0 : 1,
              timeline: {
                currency_code: "JPY",
                stages: freeCancellable
                  ? [
                      {
                        is_effective: 1,
                        is_free: 1,
                        fee: 0,
                        limit_until_raw: "2026-10-16 23:59:59",
                        stage_translation: "Free to cancel",
                      },
                      // A later, costlier stage that is NOT in force: quoting
                      // it would charge the traveller for a decision they can
                      // still make for nothing.
                      { is_effective: 0, is_free: 0, fee: 42813, stage_translation: "Non-refundable" },
                    ]
                  : [{ is_effective: 1, is_free: 0, fee: 42813, stage_translation: "Non-refundable" }],
              },
            },
          },
        },
      ],
    },
  };
}

interface DoubleOptions {
  /** The arrival cutoff the property publishes; null means it states none. */
  checkInUntil: string | null;
  freeCancellable?: boolean;
  /** The city search answer, when the test exercises alternatives. */
  citySearch?: unknown;
}

function providerReturning(options: DoubleOptions): {
  provider: RapidApiHotelProvider;
  calls: string[];
} {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/searchDestination")) return json(destinationBody());
      if (url.includes("/getHotelCheckInOutTime")) return json(checkInBody(options.checkInUntil));
      if (url.includes("/getHotelDetails")) return json(detailBody(options.freeCancellable ?? true));
      if (url.includes("/searchHotels")) return json(options.citySearch ?? { data: { hotels: [] } });
      return json({});
    }),
  );
  return {
    provider: new RapidApiHotelProvider({
      apiKey: "qa-test-key",
      host: "booking-com15.p.rapidapi.com",
    }),
    calls,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetHotelQuota();
});

describe("hotel policies are read from the fields the listing actually sends", () => {
  it("accepts a 21:30 arrival at a desk that takes arrivals until midnight", async () => {
    const policies = await providerReturning({ checkInUntil: "00:00" }).provider.getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T21:30:00.000Z",
      1,
    );
    expect(policies.lateCheckInAvailable).toBe(true);
    // The stage in force is the free one, so cancelling now costs nothing —
    // and the deadline that fact expires on is carried with it.
    expect(policies.cancellationFee).toBe(0);
    expect(policies.currency).toBe("JPY");
    expect(policies.freeCancellationUntil).toBe("2026-10-16T14:59:59.000Z");
  });

  it("refuses a 01:00 arrival at the same desk — midnight is midnight", async () => {
    const policies = await providerReturning({ checkInUntil: "00:00" }).provider.getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-16T01:00:00.000Z",
      1,
    );
    expect(policies.lateCheckInAvailable).toBe(false);
  });

  it("reads a property that closes reception at 22:00, both ways", async () => {
    const early = await providerReturning({ checkInUntil: "22:00" }).provider.getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T19:45:00.000Z",
      1,
    );
    expect(early.lateCheckInAvailable).toBe(true);
    const late = await providerReturning({ checkInUntil: "22:00" }).provider.getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T23:10:00.000Z",
      1,
    );
    expect(late.lateCheckInAvailable).toBe(false);
  });

  it("keeps a property that states NO cutoff unverified, rather than assuming yes", async () => {
    // Gracery's own live payload: `until` is null. Silence is not consent —
    // the agent's honest degraded answer ("contact the property") is the
    // correct outcome, and this test exists so a future convenience default
    // cannot creep in.
    await expect(
      providerReturning({ checkInUntil: null }).provider.getHotelPolicies(
        "Hotel Gracery Shinjuku",
        "2027-01-15T21:30:00.000Z",
        1,
      ),
    ).rejects.toThrow(/could not be verified/);
  });

  it("treats 00:00 as the end of the day, never the start", async () => {
    // A literal reading of "00:00" as minute 0 would refuse every arrival
    // after midnight-minus-one — i.e. all of them.
    const policies = await providerReturning({ checkInUntil: "00:00" }).provider.getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T23:59:00.000Z",
      1,
    );
    expect(policies.lateCheckInAvailable).toBe(true);
  });

  it("quotes the cancellation stage in force, never a later one", async () => {
    // The timeline lists what cancelling will cost at every point in the
    // future. Reading the wrong row bills the traveller ¥42,813 for a
    // decision that is free today.
    const free = await providerReturning({ checkInUntil: "00:00", freeCancellable: true }).provider
      .getHotelPolicies("Hotel Gracery Shinjuku", "2027-01-15T21:30:00.000Z", 1);
    expect(free.cancellationFee).toBe(0);
    const owed = await providerReturning({ checkInUntil: "00:00", freeCancellable: false }).provider
      .getHotelPolicies("Hotel Gracery Shinjuku", "2027-01-15T21:30:00.000Z", 1);
    expect(owed.cancellationFee).toBe(42813);
    expect(owed.freeCancellationUntil).toBeUndefined();
  });
});

describe("the property is found by the id the destination endpoint really returns", () => {
  it("matches on dest_id, not on the hotel's name", async () => {
    const { provider, calls } = providerReturning({ checkInUntil: "00:00" });
    const policies = await provider.getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T21:30:00.000Z",
      1,
    );
    expect(policies.hotelName).toBe("Hotel Gracery Shinjuku");
    expect(policies.currency).toBe("JPY");
    // The numeric id reaches both property endpoints, never the name.
    expect(calls.filter((url) => url.includes("hotel_id=1134837"))).toHaveLength(2);
  });

  it("resolves the property ONCE, however many methods ask for it", async () => {
    // The key is metered by the month, at 50 requests on the plan in use, and
    // both public methods open by naming the same hotel. Without the memo
    // every mission paid twice for the same unchanging answer.
    const { provider, calls } = providerReturning({
      checkInUntil: "00:00",
      citySearch: romeCitySearch,
    });
    await provider.getHotelPolicies("Hotel Gracery Shinjuku", "2027-01-15T21:30:00.000Z", 1);
    await provider.searchAlternativeRooms({
      hotelName: "Hotel Gracery Shinjuku",
      checkIn: "2027-01-15T15:00:00.000Z",
      nights: 1,
      guests: 2,
    });
    expect(calls.filter((url) => url.includes("/searchDestination"))).toHaveLength(1);
  });
});

describe("an alternative room is one the traveller can actually reach", () => {
  /** The Rome city search, real, against a property in Campo de' Fiori. */
  function romeProvider() {
    const { provider, calls } = providerReturning({
      checkInUntil: "00:00",
      citySearch: romeCitySearch,
    });
    // Point the resolved property at Campo de' Fiori so the distances below
    // are measured from where the traveller actually is.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/searchDestination"))
          return json({
            status: true,
            data: [
              {
                dest_id: "999",
                dest_type: "hotel",
                name: "Hotel Campo de' Fiori",
                latitude: 41.8955,
                longitude: 12.4723,
                city_ufi: -126693,
                city_name: "Rome",
              },
            ],
          });
        return json(romeCitySearch);
      }),
    );
    return { provider, calls };
  }

  it("searches the property's own CITY, not a radius around its coordinates", async () => {
    // The coordinate endpoint of this listing answers with a region: asked
    // about Campo de' Fiori it returned 9,922 matches across Lazio and
    // Umbria, the nearest 11 km away and the first 102 km away in Cascia.
    const { provider, calls } = romeProvider();
    await provider.searchAlternativeRooms({
      hotelName: "Hotel Campo de' Fiori",
      checkIn: "2026-10-18T15:00:00.000Z",
      nights: 1,
      guests: 2,
    });
    const search = calls.find((url) => url.includes("/searchHotels"));
    expect(search).toBeDefined();
    expect(search).toContain("search_type=CITY");
    expect(search).toContain("dest_id=-126693");
    expect(calls.some((url) => url.includes("searchHotelsByCoordinates"))).toBe(false);
  });

  it("offers the nearest rooms first, and never one across the region", async () => {
    const { provider } = romeProvider();
    const result = await provider.searchAlternativeRooms({
      hotelName: "Hotel Campo de' Fiori",
      checkIn: "2026-10-18T15:00:00.000Z",
      nights: 1,
      guests: 2,
      currency: "EUR",
    });
    expect(result.rooms.length).toBeGreaterThan(0);
    // Sorted by real distance from the property that fell through. Degrees
    // are not kilometres: at Rome's latitude a degree of longitude is a
    // quarter shorter than one of latitude, so the two orderings differ and
    // only the great-circle one is the traveller's walk.
    const km = (lat: number, lng: number): number => {
      const rad = (deg: number) => (deg * Math.PI) / 180;
      const dLat = rad(lat - 41.8955);
      const dLng = rad(lng - 12.4723);
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(41.8955)) * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * 6371 * Math.asin(Math.sqrt(h));
    };
    const distances = result.rooms.map((room) => km(room.latitude ?? 0, room.longitude ?? 0));
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    // And none of them is across the region.
    expect(Math.max(...distances)).toBeLessThanOrEqual(12);
    // Every one is in Rome, priced in the currency that was asked for.
    for (const room of result.rooms) {
      expect(room.currency).toBe("EUR");
      expect(room.ratePerNight).toBeGreaterThan(0);
      expect(room.latitude).toBeDefined();
    }
  });
});

describe("our own outage is never described as the property's opacity", () => {
  /**
   * Live on 2026-09-18 the gateway answered
   * `429 You have exceeded the MONTHLY quota for Requests on your current
   * plan, BASIC`, and every hotel verdict in a 42-mission battery came back
   * telling the traveller to "contact the property" — sending them to argue
   * with a hotel that had done nothing wrong.
   */
  function quotaExhaustedProvider(): { provider: RapidApiHotelProvider; calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify({
            message:
              "You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.",
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    return {
      provider: new RapidApiHotelProvider({
        apiKey: "qa-test-key",
        host: "booking-com15.p.rapidapi.com",
      }),
      calls,
    };
  }

  it("says WE could not reach the data provider, not that the hotel is unclear", async () => {
    const agent = new HotelAgent(quotaExhaustedProvider().provider);
    const assessment = await agent.assessHotelImpact({
      hotelNodeId: "hotel-0",
      hotelName: "Hotel Gracery Shinjuku",
      originalCheckIn: "2027-01-15T15:00:00.000Z",
      shiftedCheckIn: "2027-01-15T21:30:00.000Z",
      guests: 1,
    });
    expect(assessment.degraded).toBe(true);
    expect(assessment.note).toMatch(/couldn't reach our hotel data provider/);
    expect(assessment.note).toMatch(/not a problem with the property/);
    expect(assessment.note).not.toMatch(/Contact the property to confirm/);
    // Nothing is promised and nothing is charged either way.
    expect(assessment.recommendation).toBe("keep_as_is");
    expect(assessment.feeDelta).toBe(0);
  });

  it("stops spending the allowance once the key has been refused", async () => {
    // Every attempt is a request off a MONTHLY budget. Asking again to be
    // told "no" again is the one thing this rail must not do.
    const { provider, calls } = quotaExhaustedProvider();
    await expect(
      provider.getHotelPolicies("Hotel Gracery Shinjuku", "2027-01-15T21:30:00.000Z", 1),
    ).rejects.toThrow();
    const spentOnTheFirstRefusal = calls.length;
    await expect(
      provider.getHotelPolicies("Hotel Gracery Shinjuku", "2027-01-15T21:30:00.000Z", 1),
    ).rejects.toThrow(/not spending another request/);
    expect(calls.length).toBe(spentOnTheFirstRefusal);
  });

  it("still says 'contact the property' when the property itself is the unknown", async () => {
    // A property that states no arrival cutoff is genuinely unverified — and
    // there the original sentence is the right one.
    const agent = new HotelAgent(providerReturning({ checkInUntil: null }).provider);
    const assessment = await agent.assessHotelImpact({
      hotelNodeId: "hotel-0",
      hotelName: "Hotel Gracery Shinjuku",
      originalCheckIn: "2027-01-15T15:00:00.000Z",
      shiftedCheckIn: "2027-01-15T21:30:00.000Z",
      guests: 1,
    });
    expect(assessment.degraded).toBe(true);
    expect(assessment.note).toMatch(/Contact the property to confirm/);
  });
});

describe("the cancellation fee is the one the traveller actually owes", () => {
  /**
   * Hotel Campo de' Fiori, captured live on 2026-09-18 for a 20 November
   * stay. The trap is that `paymentterms` carries TWO timelines of identical
   * shape — `cancellation` and `prepayment` — and the prepayment's only
   * stage is €291.60, the room's own price. Read as a cancellation fee it
   * billed a traveller for a booking that was free to cancel for another two
   * months. The ledger audit caught it; no schema could have.
   */
  it("reads the cancellation timeline, never the prepayment one", async () => {
    const detail = romeDetails;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/searchDestination"))
          return json({
            status: true,
            data: [
              {
                dest_id: "88498",
                dest_type: "hotel",
                name: "Hotel Campo de' Fiori",
                latitude: 41.8955,
                longitude: 12.4723,
                city_ufi: -126693,
                city_name: "Rome",
              },
            ],
          });
        if (url.includes("/getHotelCheckInOutTime"))
          return json({
            data: { checkinCheckoutTimes: { checkinTimeRange: { from: "15:00", until: "23:00" } } },
          });
        return json(detail);
      }),
    );
    const policies = await new RapidApiHotelProvider({
      apiKey: "qa-test-key",
      host: "booking-com15.p.rapidapi.com",
    }).getHotelPolicies("Hotel Campo de' Fiori", "2026-11-20T21:00:00.000Z", 1);
    // Free today, and the date that stops being true is carried with it.
    expect(policies.cancellationFee).toBe(0);
    expect(policies.currency).toBe("EUR");
    expect(policies.freeCancellationUntil).toMatch(/^2026-11-17/);
    // The prepayment's €291.60 must never reach the ledger as a fee.
    expect(policies.cancellationFee).not.toBe(291.6);
  });

  it("picks the stage the clock is in, not the first one flagged active", async () => {
    // Both stages of this property carry `is_effective: 1`, so "the first
    // effective one" is not a rule — it just happened to be the free one
    // here and would be the wrong one elsewhere. After the free window
    // closes, what the traveller owes is the next stage.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          const json = (body: unknown) =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          if (url.includes("/searchDestination"))
            return json({
              status: true,
              data: [
                {
                  dest_id: "88498",
                  dest_type: "hotel",
                  name: "Hotel Campo de' Fiori",
                  latitude: 41.8955,
                  longitude: 12.4723,
                  city_ufi: -126693,
                },
              ],
            });
          if (url.includes("/getHotelCheckInOutTime"))
            return json({
              data: {
                checkinCheckoutTimes: { checkinTimeRange: { from: "15:00", until: "23:00" } },
              },
            });
          return json(romeDetails);
        }),
      );
      const policies = await new RapidApiHotelProvider({
        apiKey: "qa-test-key",
        host: "booking-com15.p.rapidapi.com",
      }).getHotelPolicies("Hotel Campo de' Fiori", "2026-11-20T21:00:00.000Z", 1);
      expect(policies.cancellationFee).toBe(291.6);
      expect(policies.freeCancellationUntil).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the overbooked hotel is never offered as its own replacement", () => {
  /**
   * `booking-com`'s neighbourhood search around Campo de' Fiori, captured
   * live on 2026-09-19. Twenty properties, all inside 3 km, and the
   * traveller's own among them.
   *
   * The trap is that each result carries TWO identifiers: `hotel_id: 88498`
   * and `id: "property_card_88498"`, a UI card handle. Reading the second
   * one, the self-exclusion never matched — and the swarm answered "your
   * room is gone" with the same hotel that had just walked them.
   */
  it("excludes the property by its hotel id, not by a card handle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes("/v1/hotels/locations"))
          return json([
            {
              dest_id: "88498",
              dest_type: "hotel",
              name: "Boutique Hotel Campo de' Fiori",
              latitude: 41.895596,
              longitude: 12.472896,
              city_name: "Rome",
            },
          ]);
        return json(romeNearby);
      }),
    );
    const result = await new RapidApiHotelProvider({
      apiKey: "qa-test-key",
      host: "booking-com.p.rapidapi.com",
    }).searchAlternativeRooms({
      hotelName: "Hotel Campo de' Fiori",
      checkIn: "2026-11-20T15:00:00.000Z",
      nights: 1,
      guests: 2,
      currency: "EUR",
    });
    expect(result.rooms.length).toBeGreaterThan(0);
    expect(result.rooms.map((room) => room.roomId)).not.toContain("88498");
    expect(result.rooms.map((room) => room.hotelName)).not.toContain(
      "Boutique Hotel Campo de' Fiori",
    );
    // And the rooms are identified by the property, not by a card handle.
    for (const room of result.rooms) {
      expect(room.roomId).not.toMatch(/property_card/);
      expect(room.currency).toBe("EUR");
    }
  });
});
