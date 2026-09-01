/**
 * Who gets blamed when there is no replacement flight.
 *
 * The traveller asked for exactly one guarantee here: only say "our partner
 * doesn't cover this destination" when we are SURE that is what happened.
 * Everything else about this feature is downstream of that promise.
 *
 * Verified against the live Atlas sandbox on 2026-09-02: SIN → FCO / ROM / MXP
 * / CDG / FRA / MUC / BCN return zero routings on every date tried, while
 * SIN → LHR / NRT / AMS / IST / DXB answer normally. The gap is real — but a
 * live matrix run the same day also produced a trip where the partner returned
 * FIFTEEN options that simply could not be priced. Under a naive
 * "no candidates ⇒ not covered" rule that trip would have been told the route
 * was unsupported, which is flatly untrue.
 */

import { describe, expect, it } from "vitest";
import { noReplacementHeadline } from "@/agents/orchestrator/OrchestratorAgent";

describe("only a proven coverage gap may name the partner", () => {
  it("names the partner and sends the traveller to the airline", () => {
    const line = noReplacementHeadline("route_not_covered");
    expect(line).toContain("partner");
    // The actionable half: what the traveller must now do themselves.
    expect(line).toMatch(/yourself/);
  });

  it("blames OUR horizon — never the partner — when we rejected the flights", () => {
    const line = noReplacementHeadline("all_options_rejected");
    expect(line).not.toContain("partner");
    expect(line).not.toMatch(/cover/);
    // It must say flights WERE found, or it reads as an absence of inventory.
    expect(line).toMatch(/found/);
  });

  it("a pricing failure is not a coverage gap", () => {
    const line = noReplacementHeadline("pricing_unavailable");
    expect(line).not.toContain("partner");
    expect(line).not.toMatch(/cover/);
    // Retryable — the opposite advice from "go book it yourself".
    expect(line).toMatch(/again/);
  });

  it("a single empty date claims neither coverage nor availability", () => {
    const line = noReplacementHeadline("no_options_on_date");
    expect(line).not.toContain("partner");
    expect(line).not.toMatch(/cover/);
  });

  it("a REFUSED search is never a coverage claim", () => {
    // The one that nearly shipped wrong. Atlas answers HTTP 200 with
    // `{"routings": [], "status": 102, "msg": "Can not search past flights"}`
    // for a date in the past — byte-identical to a genuine empty answer unless
    // the business status is read. A live matrix run on 2026-09-02 duly
    // reported that our partner "doesn't cover AMS → LHR", one of the busiest
    // routes in Europe, because that trip's dates had already passed.
    const line = noReplacementHeadline("search_declined");
    expect(line).not.toContain("partner");
    expect(line).not.toMatch(/cover/);
  });

  it("an unknown reason falls back to the neutral wording, never to blame", () => {
    // Defensive: a future reason added without updating this table must not
    // silently inherit the accusation.
    const line = noReplacementHeadline(undefined);
    expect(line).not.toContain("partner");
    expect(line).not.toMatch(/cover/);
  });
});
