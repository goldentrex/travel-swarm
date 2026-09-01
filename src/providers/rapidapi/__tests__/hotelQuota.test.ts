/**
 * The hotel rail's memory of a quota refusal.
 *
 * Why it exists: `/health` is the one signal the app and the operator read to
 * answer "is the hotel rail usable?", and it probes the RapidAPI gateway root.
 * Verified against the live gateway on 2026-09-01, that root answers `404`
 * whatever the key's state, while a real endpoint on the SAME key answered
 * `429 "You have exceeded the MONTHLY quota for Requests on your current plan,
 * BASIC"`. So health reported `hotelAuthorized: true` while every hotel lookup
 * in the app was failing — the check said fine when it was not.
 *
 * Probing a real endpoint would spend a request from the budget that is
 * running out, so the real lookups do the learning and this remembers it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  hotelQuotaExhausted,
  hotelQuotaNote,
  noteHotelQuotaExhausted,
  noteHotelQuotaHealthy,
  resetHotelQuota,
} from "@/providers/rapidapi/hotelQuota";

describe("hotel quota memory", () => {
  beforeEach(() => resetHotelQuota());

  it("starts silent — an unprobed key is not a refused one", () => {
    expect(hotelQuotaExhausted()).toBe(false);
    expect(hotelQuotaNote()).toBeNull();
  });

  it("remembers a refusal, and the gateway's own words for it", () => {
    noteHotelQuotaExhausted("You have exceeded the MONTHLY quota for Requests");
    expect(hotelQuotaExhausted()).toBe(true);
    // The operator needs to know WHICH limit was hit: a monthly cap means a new
    // key or a plan change, a burst limit means waiting a minute.
    expect(hotelQuotaNote()).toContain("MONTHLY");
  });

  it("a call that goes through clears it immediately", () => {
    noteHotelQuotaExhausted("nope");
    noteHotelQuotaHealthy();
    expect(hotelQuotaExhausted()).toBe(false);
    expect(hotelQuotaNote()).toBeNull();
  });

  it("forgets on its own, so a stale refusal cannot condemn a working key", () => {
    const t0 = 1_000_000;
    noteHotelQuotaExhausted("burst", t0);
    expect(hotelQuotaExhausted(t0 + 10 * 60_000)).toBe(true);
    expect(hotelQuotaExhausted(t0 + 20 * 60_000)).toBe(false);
  });

  it("a long note is truncated rather than pasted whole into /health", () => {
    noteHotelQuotaExhausted("x".repeat(5000));
    expect((hotelQuotaNote() ?? "").length).toBeLessThanOrEqual(200);
  });
});
