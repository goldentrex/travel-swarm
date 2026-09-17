/**
 * HotelAgent — full behavioural coverage.
 *
 * Was 6% covered (effectively untested) before this file: the recommendation
 * ladder had a dead branch (see the fix in HotelAgent.ts — every "not
 * feasible" path resolved to "rebook_room" regardless of whether a
 * replacement room actually existed, so an overbooked traveller with ZERO
 * alternatives found was told to "rebook" into nothing). These tests pin the
 * corrected ladder and the degradation contract (spec §4.1: a provider
 * failure must never sink the whole recovery plan).
 */

import { describe, expect, it, vi } from "vitest";
import { HotelAgent } from "@/agents/hotel/HotelAgent";
import type { HotelImpactRequest } from "@/agents/hotel/HotelAgent";
import type { HotelProvider } from "@/providers/interfaces/HotelProvider";
import type {
  HotelPolicies,
  HotelRoomSearchQuery,
  HotelRoomSearchResult,
} from "@/providers/interfaces/types";

const BASE_REQUEST: HotelImpactRequest = {
  hotelNodeId: "hotel-checkin",
  hotelName: "Hotel Almanac Barcelona",
  originalCheckIn: "2026-10-10T15:00:00.000Z",
  shiftedCheckIn: "2026-10-10T22:00:00.000Z",
  guests: 2,
};

/** Fake provider: canned policy + canned search, both call-counted. */
function makeProvider(opts: {
  policies: HotelPolicies;
  searchResult?: HotelRoomSearchResult;
  policiesError?: unknown;
  searchError?: unknown;
}): { provider: HotelProvider; searchCalls: HotelRoomSearchQuery[] } {
  const searchCalls: HotelRoomSearchQuery[] = [];
  const provider: HotelProvider = {
    providerName: "fake-hotel-provider",
    async getHotelPolicies() {
      if (opts.policiesError) throw opts.policiesError;
      return opts.policies;
    },
    async searchAlternativeRooms(query: HotelRoomSearchQuery) {
      searchCalls.push(query);
      if (opts.searchError) throw opts.searchError;
      return opts.searchResult ?? { query: query.hotelName, rooms: [] };
    },
  };
  return { provider, searchCalls };
}

describe("HotelAgent", () => {
  it("exposes the backing provider's name", () => {
    const { provider } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: true,
        cancellationFee: 0,
        currency: "EUR",
      },
    });
    expect(new HotelAgent(provider).providerName).toBe("fake-hotel-provider");
  });

  it("late check-in feasible, not overbooked: keeps the reservation and never searches alternatives", async () => {
    const searchAlternativeRooms = vi.fn();
    const provider: HotelProvider = {
      providerName: "fake",
      async getHotelPolicies() {
        return {
          hotelName: BASE_REQUEST.hotelName,
          lateCheckInAvailable: true,
          cancellationFee: 30,
          currency: "EUR",
        };
      },
      searchAlternativeRooms,
    };
    const result = await new HotelAgent(provider).assessHotelImpact(BASE_REQUEST);
    expect(result.recommendation).toBe("keep_late_checkin");
    expect(result.feeDelta).toBe(0);
    expect(result.alternativeRooms).toEqual([]);
    expect(result.degraded).toBeUndefined();
    expect(searchAlternativeRooms).not.toHaveBeenCalled();
  });

  it("late check-in NOT feasible, free cancellation, a replacement room exists: rebooks at no extra cost", async () => {
    const { provider } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: false,
        cancellationFee: 0,
        currency: "EUR",
        freeCancellationUntil: "2026-10-09T23:59:00.000Z",
      },
      searchResult: {
        query: BASE_REQUEST.hotelName,
        rooms: [{ roomId: "R1", hotelName: "Nearby Hotel", ratePerNight: 120, currency: "EUR" }],
      },
    });
    const result = await new HotelAgent(provider).assessHotelImpact(BASE_REQUEST);
    expect(result.recommendation).toBe("rebook_room");
    expect(result.feeDelta).toBe(0);
    expect(result.alternativeRooms).toHaveLength(1);
    expect(result.note).toBe("Free cancellation until 2026-10-09T23:59:00.000Z.");
  });

  it("late check-in NOT feasible, cancellation is charged, a replacement exists: rebooks and passes the fee through as feeDelta", async () => {
    const { provider } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: false,
        cancellationFee: 45.5,
        currency: "EUR",
      },
      searchResult: {
        query: BASE_REQUEST.hotelName,
        rooms: [{ roomId: "R1", hotelName: "Nearby Hotel", ratePerNight: 90, currency: "EUR" }],
      },
    });
    const result = await new HotelAgent(provider).assessHotelImpact(BASE_REQUEST);
    expect(result.recommendation).toBe("rebook_room");
    expect(result.feeDelta).toBe(45.5);
    expect(result.cancellationFee).toBe(45.5);
  });

  it("late check-in NOT feasible and NO replacement was found: honestly keeps the booking as-is (never invents a rebook with nothing to rebook into)", async () => {
    const { provider, searchCalls } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: false,
        cancellationFee: 20,
        currency: "EUR",
      },
      searchResult: { query: BASE_REQUEST.hotelName, rooms: [] },
    });
    const result = await new HotelAgent(provider).assessHotelImpact(BASE_REQUEST);
    expect(result.recommendation).toBe("keep_as_is");
    expect(result.feeDelta).toBe(0);
    expect(searchCalls).toHaveLength(1);
  });

  it("overbooked: forces the rebook path even when the property still claims late check-in is available", async () => {
    const { provider } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: true,
        cancellationFee: 0,
        currency: "EUR",
      },
      searchResult: {
        query: BASE_REQUEST.hotelName,
        rooms: [{ roomId: "R1", hotelName: "Overflow Hotel", ratePerNight: 150, currency: "EUR" }],
      },
    });
    const result = await new HotelAgent(provider).assessHotelImpact({
      ...BASE_REQUEST,
      isOverbooked: true,
    });
    expect(result.recommendation).toBe("rebook_room");
  });

  it("overbooked with no alternatives found: keeps as-is rather than lying that a room was rebooked", async () => {
    const { provider } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: true,
        cancellationFee: 0,
        currency: "EUR",
      },
      searchResult: { query: BASE_REQUEST.hotelName, rooms: [] },
    });
    const result = await new HotelAgent(provider).assessHotelImpact({
      ...BASE_REQUEST,
      isOverbooked: true,
    });
    expect(result.recommendation).toBe("keep_as_is");
    expect(result.feeDelta).toBe(0);
  });

  it("getHotelPolicies throws: degrades to the unverified policy instead of failing the whole plan", async () => {
    const { provider } = makeProvider({
      policies: {} as HotelPolicies,
      policiesError: new Error("network down"),
    });
    const result = await new HotelAgent(provider).assessHotelImpact(BASE_REQUEST);
    expect(result).toEqual({
      hotelNodeId: BASE_REQUEST.hotelNodeId,
      lateCheckInAvailable: false,
      cancellationFee: 0,
      currency: "USD",
      alternativeRooms: [],
      recommendation: "keep_as_is",
      feeDelta: 0,
      degraded: true,
      note: "Hotel policy could not be verified. Contact the property to confirm availability, late arrival and any fees before changing this booking.",
    });
  });

  it("searchAlternativeRooms throws: survives with no alternatives rather than failing the plan", async () => {
    const { provider } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: false,
        cancellationFee: 15,
        currency: "EUR",
      },
      searchError: new Error("provider timeout"),
    });
    const result = await new HotelAgent(provider).assessHotelImpact(BASE_REQUEST);
    expect(result.degraded).toBeUndefined();
    expect(result.alternativeRooms).toEqual([]);
    expect(result.recommendation).toBe("keep_as_is");
  });

  it("clamps a negative provider-reported cancellation fee to zero (never invents a negative charge)", async () => {
    const { provider } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: false,
        cancellationFee: -10,
        currency: "EUR",
      },
      searchResult: { query: BASE_REQUEST.hotelName, rooms: [] },
    });
    const result = await new HotelAgent(provider).assessHotelImpact(BASE_REQUEST);
    expect(result.cancellationFee).toBe(0);
    expect(result.feeDelta).toBe(0);
  });

  it("derives the alternative-room search's `nights` from how far check-in shifted", async () => {
    const { provider, searchCalls } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: false,
        cancellationFee: 0,
        currency: "EUR",
      },
      searchResult: { query: BASE_REQUEST.hotelName, rooms: [] },
    });
    await new HotelAgent(provider).assessHotelImpact({
      ...BASE_REQUEST,
      originalCheckIn: "2026-10-10T15:00:00.000Z",
      shiftedCheckIn: "2026-10-12T15:00:00.000Z", // shifted 2 full days later
    });
    expect(searchCalls[0]?.nights).toBe(3);
  });

  it("passes through images and coordinates on alternative rooms when the provider supplies them", async () => {
    const { provider } = makeProvider({
      policies: {
        hotelName: BASE_REQUEST.hotelName,
        lateCheckInAvailable: false,
        cancellationFee: 0,
        currency: "EUR",
      },
      searchResult: {
        query: BASE_REQUEST.hotelName,
        rooms: [
          {
            roomId: "R1",
            hotelName: "Nearby Hotel",
            ratePerNight: 100,
            currency: "EUR",
            images: ["https://example.com/a.jpg"],
            latitude: 41.38,
            longitude: 2.17,
          },
        ],
      },
    });
    const result = await new HotelAgent(provider).assessHotelImpact(BASE_REQUEST);
    expect(result.alternativeRooms[0]).toMatchObject({
      images: ["https://example.com/a.jpg"],
      latitude: 41.38,
      longitude: 2.17,
    });
  });
});
