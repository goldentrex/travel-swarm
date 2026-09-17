/**
 * The hotel rail was dark on every mission, against a provider that worked.
 *
 * A live battery of 42 missions never produced a single usable hotel verdict:
 * every one degraded to "Hotel policy could not be verified. Contact the
 * property…". The provider was not the problem — a direct probe answered HTTP
 * 200 in 1.7 s with the right property first in the results. The problem was
 * the contract we read it through:
 *
 *   • `late_check_in_available` — a field Booking.com NEVER sends. It sends
 *     the property's own arrival window, `checkin: {from, until}`. 16 of 20
 *     live Tokyo properties state a cutoff.
 *   • `is_free_cancellable` — arrives as `1`, not `true`. The boolean-only
 *     test never fired, so the cancellation fee stayed unknown alongside it.
 *
 * Two field mismatches, and the whole hotel protection layer never ran. The
 * payloads below are REAL, captured from booking-com.p.rapidapi.com on
 * 2026-09-18 for Hotel Gracery Shinjuku (hotel_id 1134837).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { RapidApiHotelProvider } from "@/providers/rapidapi/RapidApiHotelProvider";
import { HotelAgent } from "@/agents/hotel/HotelAgent";
import { resetHotelQuota } from "@/providers/rapidapi/hotelQuota";

/** Verbatim from the live response, trimmed to the fields under test. */
const GRACERY = {
  hotel_id: 1134837,
  hotel_name: "Hotel Gracery Shinjuku",
  checkin: { until: "", from: "14:00" },
  checkout: { from: "", until: "11:00" },
  is_free_cancellable: 1,
  currency_code: "JPY",
  min_total_price: 27971.8,
  latitude: 35.6953566980492,
  longitude: 139.702065289021,
};

/** The same property as most of its neighbours: a stated midnight cutoff. */
const WITH_CUTOFF = { ...GRACERY, checkin: { until: "00:00", from: "14:00" } };
const CLOSES_AT_2200 = { ...GRACERY, checkin: { until: "22:00", from: "15:00" } };

/**
 * The locations payload, verbatim in SHAPE: `dest_id` / `name` / `dest_type`.
 * Reading `hotel_id` / `hotel_name` here is what broke every assessment, so
 * the double must never be "helpfully" given the keys the code used to want.
 */
function providerReturning(property: Record<string, unknown>): RapidApiHotelProvider {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/hotels/locations")) {
        return new Response(
          JSON.stringify([
            {
              name: "Hotel Gracery Shinjuku",
              dest_id: "1134837",
              dest_type: "hotel",
              latitude: GRACERY.latitude,
              longitude: GRACERY.longitude,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ result: [property] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return new RapidApiHotelProvider({ apiKey: "qa-test-key", host: "booking-com.p.rapidapi.com" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetHotelQuota();
});

describe("hotel policies are read from the fields Booking.com actually sends", () => {
  it("accepts a 21:30 arrival at a desk that takes arrivals until midnight", async () => {
    const policies = await providerReturning(WITH_CUTOFF).getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T21:30:00.000Z",
      1,
    );
    expect(policies.lateCheckInAvailable).toBe(true);
    // `is_free_cancellable: 1` — a NUMBER — is what the live API sends.
    expect(policies.cancellationFee).toBe(0);
    expect(policies.currency).toBe("JPY");
  });

  it("refuses a 01:00 arrival at the same desk — midnight is midnight", async () => {
    const policies = await providerReturning(WITH_CUTOFF).getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-16T01:00:00.000Z",
      1,
    );
    expect(policies.lateCheckInAvailable).toBe(false);
  });

  it("reads a property that closes reception at 22:00, both ways", async () => {
    const early = await providerReturning(CLOSES_AT_2200).getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T19:45:00.000Z",
      1,
    );
    expect(early.lateCheckInAvailable).toBe(true);
    const late = await providerReturning(CLOSES_AT_2200).getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T23:10:00.000Z",
      1,
    );
    expect(late.lateCheckInAvailable).toBe(false);
  });

  it("keeps a property that states NO cutoff unverified, rather than assuming yes", async () => {
    // Gracery's own live payload: `until` is "". Four of the twenty results
    // were like this. Silence is not consent — the agent's honest degraded
    // answer ("contact the property") is the correct outcome here, and this
    // test exists so a future convenience default cannot creep in.
    await expect(
      providerReturning(GRACERY).getHotelPolicies(
        "Hotel Gracery Shinjuku",
        "2027-01-15T21:30:00.000Z",
        1,
      ),
    ).rejects.toThrow(/could not be verified/);
  });

  it("treats 00:00 as the end of the day, never the start", async () => {
    // A literal reading of "00:00" as minute 0 would refuse every arrival
    // after midnight-minus-one — i.e. all of them.
    const policies = await providerReturning(WITH_CUTOFF).getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T23:59:00.000Z",
      1,
    );
    expect(policies.lateCheckInAvailable).toBe(true);
  });
});

describe("the property is found by the id the locations endpoint really returns", () => {
  it("matches on dest_id, not on the hotel's name", async () => {
    // `resolveHotel` used to read `hotel_id` (absent) and fall back to the
    // NAME, so the search below compared 1134837 against "Hotel Gracery
    // Shinjuku" and found nothing — every single time.
    const policies = await providerReturning(WITH_CUTOFF).getHotelPolicies(
      "Hotel Gracery Shinjuku",
      "2027-01-15T21:30:00.000Z",
      1,
    );
    expect(policies.hotelName).toBe("Hotel Gracery Shinjuku");
    expect(policies.currency).toBe("JPY");
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
  function quotaExhaustedProvider(): RapidApiHotelProvider {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message:
              "You have exceeded the MONTHLY quota for Requests on your current plan, BASIC.",
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    return new RapidApiHotelProvider({ apiKey: "qa-test-key", host: "booking-com.p.rapidapi.com" });
  }

  it("says WE could not reach the data provider, not that the hotel is unclear", async () => {
    const agent = new HotelAgent(quotaExhaustedProvider());
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

  it("still says 'contact the property' when the property itself is the unknown", async () => {
    // Gracery states no arrival cutoff, so its terms are genuinely unverified
    // — and there the original sentence is the right one.
    const agent = new HotelAgent(providerReturning(GRACERY));
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
