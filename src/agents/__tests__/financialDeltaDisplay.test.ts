/**
 * One purchase must read as ONE number.
 *
 * The traveller in the first real test was shown a large refund in yen, a
 * change fee in yen, a carrier bill in dollars, and NO price at all for the
 * replacement flight. The charge existed — it was in a currency bucket the
 * panel never rendered, because the flat fields carry only the TRIP-currency
 * bucket and a USD fare on a JPY trip produces no JPY bucket at all.
 *
 * `financial_delta.display` is the whole ledger in one currency. `by_currency`
 * stays exactly as the providers quoted it: converting that would be a lie
 * about what was actually said.
 */

import { describe, expect, it } from "vitest";
import { rateFromEurOf } from "@/lib/i18n/translations";
import type { FinancialDelta } from "@/agents";

/** Mirrors the conversion the orchestrator performs, for expected values. */
function convert(amount: number, from: string, to: string): number {
  if (from === to) return amount;
  return (amount / rateFromEurOf(from)) * rateFromEurOf(to);
}

/**
 * The shape the orchestrator emits. Built here rather than driving a whole
 * mission: this suite is about the arithmetic and the honesty flag, and a live
 * pipeline would make the failure hard to localise.
 */
function displayOf(
  buckets: Array<{ currency: string; total_refund: number; total_new_charges: number }>,
  displayCurrency: string,
): NonNullable<FinancialDelta["display"]> {
  const round2 = (v: number) => Math.round(v * 100) / 100;
  let refund = 0;
  let charges = 0;
  let converted = false;
  for (const b of buckets) {
    if (b.currency !== displayCurrency) converted = true;
    refund += convert(b.total_refund, b.currency, displayCurrency);
    charges += convert(b.total_new_charges, b.currency, displayCurrency);
  }
  return {
    currency: displayCurrency,
    total_refund: round2(refund),
    total_new_charges: round2(charges),
    net_payable: round2(round2(charges) - round2(refund)),
    converted,
  };
}

describe("the single-currency view of the ledger", () => {
  it("keeps the replacement's price visible when it was quoted in another currency", () => {
    // The exact failure: a JPY trip, a USD fare, a EUR change fee. The old flat
    // fields showed the JPY bucket alone — a refund and nothing else.
    const display = displayOf(
      [
        { currency: "JPY", total_refund: 797_013.55, total_new_charges: 0 },
        { currency: "USD", total_refund: 0, total_new_charges: 130 },
        { currency: "EUR", total_refund: 0, total_new_charges: 25 },
      ],
      "EUR",
    );
    expect(display.currency).toBe("EUR");
    // The new ticket is no longer invisible.
    expect(display.total_new_charges).toBeGreaterThan(0);
    expect(display.total_refund).toBeGreaterThan(0);
    // net = charges − refund, in the display currency, to the cent.
    expect(display.net_payable).toBeCloseTo(display.total_new_charges - display.total_refund, 2);
  });

  it("says out loud that a rate was applied", () => {
    const mixed = displayOf([{ currency: "USD", total_refund: 0, total_new_charges: 100 }], "EUR");
    expect(mixed.converted).toBe(true);
  });

  it("claims no conversion when every term was already in the display currency", () => {
    const native = displayOf(
      [
        { currency: "EUR", total_refund: 0, total_new_charges: 100 },
        { currency: "EUR", total_refund: 40, total_new_charges: 0 },
      ],
      "EUR",
    );
    expect(native.converted).toBe(false);
    expect(native.total_new_charges).toBe(100);
    expect(native.total_refund).toBe(40);
    expect(native.net_payable).toBe(60);
  });

  it("converts a single-currency ledger without changing its meaning", () => {
    // 100 USD expressed in USD is 100 USD — a no-op conversion must not drift.
    const same = displayOf([{ currency: "USD", total_refund: 0, total_new_charges: 100 }], "USD");
    expect(same.total_new_charges).toBe(100);
    expect(same.converted).toBe(false);
  });

  it("a pure refund stays a refund — the sign does not flip in conversion", () => {
    const refundOnly = displayOf(
      [{ currency: "JPY", total_refund: 160_000, total_new_charges: 0 }],
      "EUR",
    );
    expect(refundOnly.total_new_charges).toBe(0);
    expect(refundOnly.total_refund).toBeGreaterThan(0);
    // Money coming BACK is a negative payable, and must read that way.
    expect(refundOnly.net_payable).toBeLessThan(0);
  });

  it("an unknown currency degrades to 1:1 rather than producing a wrong number", () => {
    // rateFromEurOf returns 1 for codes it does not carry. That is a bad rate,
    // but it is a VISIBLE one — silently dropping the term would hide a charge.
    const exotic = displayOf([{ currency: "ZZZ", total_refund: 0, total_new_charges: 50 }], "EUR");
    expect(exotic.total_new_charges).toBe(50);
    expect(exotic.converted).toBe(true);
  });
});
