/**
 * PolicyAgent against a REAL Atlas fare-rule payload.
 *
 * Captured live on 2026-08-31 from `search.do` (LGW→BCN, Vueling, EUR) — the
 * exact `routing.rule` shape the sandbox publishes. Three defects were found
 * with it, and this suite pins all three:
 *
 *  1. The rule was never plumbed through at all: the swarm priced every change
 *     off a hardcoded 25 EUR house default while the carrier published its own
 *     fee for the very fare being quoted.
 *  2. `findCurrency` did not walk ARRAYS, and every Atlas section is an array —
 *     so the currency silently fell back to USD and put a dollar change fee
 *     next to a euro ticket in one ledger.
 *  3. The fee windows are stated in `startMinute`/`endMinute` (MINUTES before
 *     departure). The parser only knew HOUR keys, which it multiplies by 60, so
 *     the windows either vanished or ballooned by 60×.
 */

import { describe, expect, it } from "vitest";
import { PolicyAgent } from "@/agents/policy/PolicyAgent";

/** Verbatim shape of `routing.rule` from the live sandbox response. */
function atlasRule(): Record<string, unknown> {
  return {
    hasBaggage: 1,
    baggageElements: [
      {
        segmentNo: 1,
        baggageType: "CabinBaggageUnderSeat",
        passengerType: 0,
        baggagePiece: 1,
        baggageWeight: -1,
        baggageSize: "40*30*20cm",
        isAllWeight: false,
      },
    ],
    changesRules: [
      {
        changesType: 0,
        changesStatus: "T",
        changesFee: 0.0,
        currency: "EUR",
        revNoshow: "T",
        ruleDetailList: [
          // A year out down to 15 days: the published change fee.
          { ruleId: 75370, status: "H", startMinute: 525600, endMinute: 21600, amount: 52.99, currency: "EUR" },
          // 15 days down to 2 hours: same fee.
          { ruleId: 75371, status: "H", startMinute: 21600, endMinute: 120, amount: 52.99, currency: "EUR" },
          // Inside 2 hours: no change fee published.
          { ruleId: 75372, status: "T", startMinute: 120, endMinute: 0, amount: 0.0, currency: "EUR" },
        ],
      },
    ],
    refundRules: [
      {
        refundType: 0,
        refundStatus: "T",
        refundMethod: "Voucher",
        refundFee: 0.0,
        currency: "EUR",
        ruleDetailList: [
          { ruleId: 57033, status: "T", refundMethod: "Voucher", startMinute: 525600, endMinute: 0, amount: 0.0, currency: "EUR" },
        ],
      },
    ],
  };
}

const agent = new PolicyAgent();

describe("PolicyAgent — real Atlas rule payload", () => {
  it("reads the carrier's own change fee, not a house default", async () => {
    // 10 days out ⇒ inside the 525600→21600 window.
    const verdict = await agent.assessFarePolicy({
      originalFlightId: "flight-0",
      rule: atlasRule(),
      minutesToDeparture: 14_400,
      disruptionKind: "missed_flight",
    });
    expect(verdict.changeFee).toBe(52.99);
    // The 25 EUR default must never surface once a real rule is present.
    expect(verdict.changeFee).not.toBe(25);
  });

  it("finds the currency inside the arrays instead of defaulting to USD", async () => {
    const verdict = await agent.assessFarePolicy({
      originalFlightId: "flight-0",
      rule: atlasRule(),
      minutesToDeparture: 14_400,
      disruptionKind: "delay",
    });
    expect(verdict.currency).toBe("EUR");
  });

  it("falls back to the QUOTED FARE's currency when the rule names none", async () => {
    // A rule with fees but no currency anywhere: the fee must still be
    // denominated like the ticket it applies to, never a hardcoded USD.
    const verdict = await agent.assessFarePolicy({
      originalFlightId: "flight-0",
      rule: { changesRules: [{ changesStatus: "T", ruleDetailList: [{ amount: 30 }] }] },
      minutesToDeparture: 14_400,
      disruptionKind: "delay",
      fallbackCurrency: "GBP",
    });
    expect(verdict.currency).toBe("GBP");
  });

  it("honours the minute-based windows: inside 2h the published fee is 0", async () => {
    const verdict = await agent.assessFarePolicy({
      originalFlightId: "flight-0",
      rule: atlasRule(),
      minutesToDeparture: 60,
      disruptionKind: "missed_flight",
    });
    // Only the 120→0 window applies this close in, and it prices at 0.
    expect(verdict.changeFee).toBe(0);
  });

  it("still reads the baggage allowance from the live shape", async () => {
    const verdict = await agent.assessFarePolicy({
      originalFlightId: "flight-0",
      rule: atlasRule(),
      minutesToDeparture: 14_400,
      disruptionKind: "delay",
    });
    expect(verdict.baggageConstraints.included).toBe(true);
  });


  /**
   * A carrier may publish its rules in its OWN currency: found live on
   * 2026-08-31, VietJet answered a SIN→HND search with a change fee in VND
   * against a USD fare. Zero is zero everywhere, so a FREE change must not
   * split the money panel — it takes the ticket's currency.
   */
  it("a zero fee published in the carrier's currency adopts the fare's", async () => {
    const verdict = await agent.assessFarePolicy({
      originalFlightId: "flight-0",
      rule: {
        changesRules: [
          { changesStatus: "T", currency: "VND", ruleDetailList: [{ amount: 0, currency: "VND" }] },
        ],
      },
      minutesToDeparture: 14_400,
      disruptionKind: "delay",
      fallbackCurrency: "USD",
    });
    expect(verdict.changeFee).toBe(0);
    expect(verdict.currency).toBe("USD");
  });

  it("a NON-zero fee keeps the carrier's currency — no invented exchange rate", async () => {
    const verdict = await agent.assessFarePolicy({
      originalFlightId: "flight-0",
      rule: {
        changesRules: [
          {
            changesStatus: "T",
            currency: "VND",
            ruleDetailList: [{ amount: 900_000, currency: "VND" }],
          },
        ],
      },
      minutesToDeparture: 14_400,
      disruptionKind: "delay",
      fallbackCurrency: "USD",
    });
    expect(verdict.changeFee).toBe(900_000);
    expect(verdict.currency).toBe("VND");
  });
});

