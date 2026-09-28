/**
 * Which replacements are worth offering, on the day a flight falls over.
 *
 * The numbers here are the live Atlas sandbox's own, captured 2026-09-19 for
 * SIN→HND on 2026-11-12: AirAsia routings via Kuala Lumpur around €130–€237,
 * VietJet routings via Saigon from €46, and a Scoot non-stop at €199.52. The
 * cheap VietJet routings are the ~30-hour ones.
 */

import { describe, it, expect } from "vitest";
import { rankReplacements } from "@/agents/flight/FlightAgent";
import type { FlightOption } from "@/providers/interfaces/types";

const DEPART = "2026-11-12T12:10:00Z";

function offer(
  id: string,
  airline: string,
  price: number,
  durationMinutes: number,
  departureTime = DEPART,
): FlightOption {
  return {
    id,
    airline,
    flightNumber: id.toUpperCase(),
    origin: "SIN",
    destination: "HND",
    departureTime,
    arrivalTime: new Date(Date.parse(departureTime) + durationMinutes * 60_000).toISOString(),
    price,
    currency: "EUR",
    durationMinutes,
  };
}

const NONSTOP = offer("tr", "Scoot", 199.52, 7 * 60);
const KUL_CHEAP = offer("ak-cheap", "AirAsia", 128.95, 10 * 60 + 30);
const KUL_MID = offer("ak-mid", "AirAsia", 208.62, 11 * 60);
const SGN_CHEAPEST = offer("vj-cheapest", "VietJet", 46.09, 30 * 60);
const SGN_SECOND = offer("vj-second", "VietJet", 61.55, 28 * 60);

describe("rankReplacements", () => {
  it("does not sell a day and a half in airports to save a fare", () => {
    const picked = rankReplacements([SGN_CHEAPEST, SGN_SECOND, KUL_CHEAP, NONSTOP, KUL_MID], 5);
    const ids = picked.map((o) => o.id);
    // 7h is the quickest, so the ceiling is 14h: both 28h+ routings are out.
    expect(ids).not.toContain("vj-cheapest");
    expect(ids).not.toContain("vj-second");
    expect(ids).toContain("ak-cheap");
    expect(ids).toContain("tr");
  });

  it("always offers a real choice: the cheapest AND the quickest", () => {
    const picked = rankReplacements([NONSTOP, KUL_CHEAP, KUL_MID], 2);
    expect(picked).toHaveLength(2);
    // Cheapest of the sane set…
    expect(picked.map((o) => o.id)).toContain("ak-cheap");
    // …and the quickest, which is a different, dearer flight.
    expect(picked.map((o) => o.id)).toContain("tr");
  });

  it("keeps price order for the places left after those two", () => {
    const picked = rankReplacements([KUL_MID, NONSTOP, KUL_CHEAP], 3);
    expect(picked.map((o) => o.id)).toEqual(["ak-cheap", "tr", "ak-mid"]);
  });

  /**
   * A ceiling that leaves nothing has told us nothing. Reporting "no flights"
   * over a rule of ours — while the provider listed several — is the exact
   * failure the four-way no-flight verdict exists to prevent.
   */
  it("falls back to the whole set rather than claiming there is nothing", () => {
    const picked = rankReplacements([SGN_CHEAPEST, SGN_SECOND], 5);
    expect(picked).toHaveLength(2);
  });

  it("keeps an option whose provider publishes no duration at all", () => {
    const silent: FlightOption = {
      id: "no-times",
      airline: "Unknown",
      flightNumber: "XX1",
      origin: "SIN",
      destination: "HND",
      departureTime: DEPART,
      arrivalTime: "",
      price: 90,
      currency: "EUR",
    };
    const picked = rankReplacements([NONSTOP, silent], 2);
    // Silence about a duration is not evidence of a bad one.
    expect(picked.map((o) => o.id)).toContain("no-times");
  });

  it("respects the cap, and returns nothing only when asked for nothing", () => {
    expect(rankReplacements([NONSTOP, KUL_CHEAP], 1)).toHaveLength(1);
    expect(rankReplacements([NONSTOP, KUL_CHEAP], 0)).toHaveLength(0);
    expect(rankReplacements([], 5)).toHaveLength(0);
  });

  it("never returns the same flight twice", () => {
    const picked = rankReplacements([NONSTOP], 5);
    expect(picked).toHaveLength(1);
  });
});
