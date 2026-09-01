/**
 * TrustLayer round-trip tests (spec §3.4 / §3.5).
 *
 * - `validateResolutionPlan` accepts plans with and without the optional
 *   `expires_at` TTL stamp (and rejects malformed ones).
 * - `resolutionPlanToJson` emits canonical, byte-stable JSON: fixed schema
 *   field order regardless of the input's key insertion order, `expires_at`
 *   included only when present, and the round-tripped payload re-validates.
 * - `proposed_resolution.transfer_requote` (spec §2.4) follows the same
 *   optional-field contract: validated when present, emitted deterministically
 *   in canonical JSON, absent plans keep the pre-extension byte format.
 */

import { describe, expect, it } from "vitest";
import { resolutionPlanToJson, validateResolutionPlan } from "@/agents/finance/TrustLayer";
import type { ResolutionPlan, TransferRequote } from "@/agents/finance/TrustLayer";

function basePlan(): ResolutionPlan {
  return {
    incident: "Flight XY123 delayed by 4h",
    impacted_nodes: ["Transfer", "Hotel Check-in (Atlantica Surf House)"],
    proposed_resolution: {
      new_flight: { id: "ATL-SANDBOX-OFR-88431", cost: 189.5 },
      rescheduled_activities: [],
    },
    financial_delta: {
      total_refund: 0,
      total_new_charges: 60.5,
      net_payable: 60.5,
    },
    requires_human_approval: true,
  };
}

describe("validateResolutionPlan — optional TTL field", () => {
  it("accepts a plan without expires_at (pre-extension shape)", () => {
    expect(validateResolutionPlan(basePlan())).toBe(true);
  });

  it("accepts a plan with a finite expires_at stamp", () => {
    const plan = { ...basePlan(), expires_at: Date.parse("2026-08-22T08:15:00Z") };
    expect(validateResolutionPlan(plan)).toBe(true);
  });

  it("rejects a plan whose expires_at is not a finite number", () => {
    expect(validateResolutionPlan({ ...basePlan(), expires_at: "2026-08-22T08:15:00Z" })).toBe(
      false,
    );
    expect(validateResolutionPlan({ ...basePlan(), expires_at: Number.NaN })).toBe(false);
    expect(validateResolutionPlan({ ...basePlan(), expires_at: null })).toBe(false);
  });

  it("still enforces the ledger invariant alongside the TTL stamp", () => {
    const broken = {
      ...basePlan(),
      expires_at: Date.parse("2026-08-22T08:15:00Z"),
      financial_delta: { total_refund: 0, total_new_charges: 60.5, net_payable: 61 },
    };
    expect(validateResolutionPlan(broken)).toBe(false);
  });
});

describe("resolutionPlanToJson — canonical serialization", () => {
  it("includes expires_at when present and omits it when absent", () => {
    const withTtl = { ...basePlan(), expires_at: 1787414100000 };
    const parsedWith = JSON.parse(resolutionPlanToJson(withTtl)) as Record<string, unknown>;
    expect(parsedWith.expires_at).toBe(1787414100000);

    const parsedWithout = JSON.parse(resolutionPlanToJson(basePlan())) as Record<string, unknown>;
    expect("expires_at" in parsedWithout).toBe(false);
  });

  it("is byte-stable regardless of key insertion order", () => {
    const expiresAt = 1787414100000;
    // Same logical plan, two different key insertion orders.
    const orderedFirst: ResolutionPlan = {
      ...basePlan(),
      expires_at: expiresAt,
    };
    const orderedLast = {
      expires_at: expiresAt,
      ...basePlan(),
    } as ResolutionPlan;

    expect(resolutionPlanToJson(orderedFirst)).toBe(resolutionPlanToJson(orderedLast));
  });

  it("emits expires_at in fixed schema position (after requires_human_approval)", () => {
    const json = resolutionPlanToJson({ ...basePlan(), expires_at: 1787414100000 });
    const approvalIndex = json.indexOf('"requires_human_approval"');
    const expiresIndex = json.indexOf('"expires_at"');
    expect(approvalIndex).toBeGreaterThan(-1);
    expect(expiresIndex).toBeGreaterThan(approvalIndex);
  });

  it("round-trips: canonical JSON re-parses to a valid plan", () => {
    const plan = { ...basePlan(), expires_at: 1787414100000 };
    const reparsed = JSON.parse(resolutionPlanToJson(plan));
    expect(validateResolutionPlan(reparsed)).toBe(true);
    expect(reparsed).toEqual(plan);
  });
});

const REQUOTE: TransferRequote = {
  amount: 45,
  from: "OPO",
  to: "LIS",
  reason: "Spatial mismatch: Upstream flight arrives at a different location (OPO instead of LIS).",
};

/** basePlan with the re-quote ledger line folded in (60.5 fare + 45 re-quote). */
function planWithRequote(): ResolutionPlan {
  const plan = basePlan();
  plan.proposed_resolution.transfer_requote = { ...REQUOTE };
  plan.financial_delta = {
    total_refund: 0,
    total_new_charges: 105.5,
    net_payable: 105.5,
  };
  return plan;
}

describe("validateResolutionPlan — transfer_requote", () => {
  it("accepts a plan carrying a well-formed transfer_requote", () => {
    expect(validateResolutionPlan(planWithRequote())).toBe(true);
  });

  it("still accepts plans without transfer_requote (pre-extension shape)", () => {
    expect(validateResolutionPlan(basePlan())).toBe(true);
  });

  it("rejects a transfer_requote with a missing amount", () => {
    const plan = planWithRequote();
    const { amount: _amount, ...rest } = REQUOTE;
    plan.proposed_resolution.transfer_requote = rest as unknown as TransferRequote;
    expect(validateResolutionPlan(plan)).toBe(false);
  });

  it("rejects a transfer_requote with a non-finite or negative amount", () => {
    expect(
      validateResolutionPlan({
        ...planWithRequote(),
        proposed_resolution: {
          ...planWithRequote().proposed_resolution,
          transfer_requote: { ...REQUOTE, amount: Number.NaN },
        },
      }),
    ).toBe(false);
    expect(
      validateResolutionPlan({
        ...planWithRequote(),
        proposed_resolution: {
          ...planWithRequote().proposed_resolution,
          transfer_requote: { ...REQUOTE, amount: -1 },
        },
      }),
    ).toBe(false);
  });

  it("rejects a transfer_requote with missing from/to/reason", () => {
    const variants = [
      { ...REQUOTE, from: 42 },
      { ...REQUOTE, to: undefined },
      { reason: REQUOTE.reason, amount: REQUOTE.amount },
    ];
    for (const variant of variants) {
      const plan = planWithRequote();
      plan.proposed_resolution.transfer_requote = variant as unknown as TransferRequote;
      expect(validateResolutionPlan(plan)).toBe(false);
    }
  });
});

describe("resolutionPlanToJson — transfer_requote canonical serialization", () => {
  it("includes transfer_requote when present and omits it when absent", () => {
    const parsedWith = JSON.parse(resolutionPlanToJson(planWithRequote())) as {
      proposed_resolution: Record<string, unknown>;
    };
    expect(parsedWith.proposed_resolution.transfer_requote).toEqual(REQUOTE);

    const parsedWithout = JSON.parse(resolutionPlanToJson(basePlan())) as {
      proposed_resolution: Record<string, unknown>;
    };
    expect("transfer_requote" in parsedWithout.proposed_resolution).toBe(false);
  });

  it("is byte-stable regardless of transfer_requote key insertion order", () => {
    const requoteFirst: ResolutionPlan = {
      ...basePlan(),
      proposed_resolution: {
        transfer_requote: { ...REQUOTE },
        new_flight: { id: "ATL-SANDBOX-OFR-88431", cost: 189.5 },
        rescheduled_activities: [],
      },
      financial_delta: { total_refund: 0, total_new_charges: 105.5, net_payable: 105.5 },
    };
    expect(resolutionPlanToJson(requoteFirst)).toBe(resolutionPlanToJson(planWithRequote()));
  });

  it("emits transfer_requote after the base proposed_resolution fields", () => {
    const json = resolutionPlanToJson(planWithRequote());
    const newFlightIndex = json.indexOf('"new_flight"');
    const activitiesIndex = json.indexOf('"rescheduled_activities"');
    const requoteIndex = json.indexOf('"transfer_requote"');
    expect(newFlightIndex).toBeGreaterThan(-1);
    expect(requoteIndex).toBeGreaterThan(newFlightIndex);
    expect(requoteIndex).toBeGreaterThan(activitiesIndex);
  });

  it("round-trips: canonical JSON with transfer_requote re-parses to a valid, equal plan", () => {
    const plan = planWithRequote();
    const reparsed = JSON.parse(resolutionPlanToJson(plan));
    expect(validateResolutionPlan(reparsed)).toBe(true);
    expect(reparsed).toEqual(plan);
  });
});

describe("new_flight.flight_number — additive field", () => {
  /** basePlan whose new_flight carries the full display enrichment. */
  function planWithFlightNumber(): ResolutionPlan {
    const plan = basePlan();
    plan.proposed_resolution.new_flight = {
      id: "ATL-SANDBOX-OFR-88431",
      cost: 189.5,
      origin: "CDG",
      destination: "FCO",
      airline: "Vueling",
      flight_number: "8243",
    };
    return plan;
  }

  it("validates plans with and without flight_number", () => {
    expect(validateResolutionPlan(planWithFlightNumber())).toBe(true);
    // Absent key stays valid (pre-extension shape).
    expect(validateResolutionPlan(basePlan())).toBe(true);
    // Present but non-string ⇒ rejected.
    const broken = planWithFlightNumber();
    (broken.proposed_resolution.new_flight as { flight_number: unknown }).flight_number = 8243;
    expect(validateResolutionPlan(broken)).toBe(false);
  });

  it("canonical JSON emits flight_number only when present, in fixed position", () => {
    const withNumber = JSON.parse(resolutionPlanToJson(planWithFlightNumber())) as {
      proposed_resolution: { new_flight: Record<string, unknown> };
    };
    expect(withNumber.proposed_resolution.new_flight.flight_number).toBe("8243");

    const withoutNumber = JSON.parse(resolutionPlanToJson(basePlan())) as {
      proposed_resolution: { new_flight: Record<string, unknown> };
    };
    expect("flight_number" in withoutNumber.proposed_resolution.new_flight).toBe(false);

    // Fixed schema position: after the other additive display fields.
    const json = resolutionPlanToJson(planWithFlightNumber());
    const airlineIndex = json.indexOf('"airline"');
    const currencyOrAirline = airlineIndex;
    const flightNumberIndex = json.indexOf('"flight_number"');
    expect(currencyOrAirline).toBeGreaterThan(-1);
    expect(flightNumberIndex).toBeGreaterThan(currencyOrAirline);
  });

  it("round-trips with and without the key", () => {
    const withNumber = planWithFlightNumber();
    const reparsedWith = JSON.parse(resolutionPlanToJson(withNumber));
    expect(validateResolutionPlan(reparsedWith)).toBe(true);
    expect(reparsedWith).toEqual(withNumber);

    const without = basePlan();
    const reparsedWithout = JSON.parse(resolutionPlanToJson(without));
    expect(validateResolutionPlan(reparsedWithout)).toBe(true);
    expect(reparsedWithout).toEqual(without);
  });
});

describe("validateResolutionPlan — two-phase badge", () => {
  it("accepts a plan without a badge (legacy single-plan flow)", () => {
    expect(validateResolutionPlan(basePlan())).toBe(true);
  });

  it("accepts each frozen badge value", () => {
    for (const badge of ["cheapest", "fastest", "balanced"] as const) {
      expect(validateResolutionPlan({ ...basePlan(), badge })).toBe(true);
    }
  });

  it("rejects a badge outside the frozen value set", () => {
    expect(validateResolutionPlan({ ...basePlan(), badge: "premium" })).toBe(false);
    expect(validateResolutionPlan({ ...basePlan(), badge: 42 })).toBe(false);
    expect(validateResolutionPlan({ ...basePlan(), badge: null })).toBe(false);
  });
});

describe("resolutionPlanToJson — badge canonical serialization", () => {
  it("includes badge only when present", () => {
    const withBadge = JSON.parse(resolutionPlanToJson({ ...basePlan(), badge: "cheapest" }));
    expect(withBadge.badge).toBe("cheapest");

    const withoutBadge = JSON.parse(resolutionPlanToJson(basePlan())) as Record<string, unknown>;
    expect("badge" in withoutBadge).toBe(false);
  });

  it("emits badge right after requires_human_approval (before expires_at)", () => {
    const json = resolutionPlanToJson({
      ...basePlan(),
      badge: "fastest",
      expires_at: 1787414100000,
    });
    const approvalIndex = json.indexOf('"requires_human_approval"');
    const badgeIndex = json.indexOf('"badge"');
    const expiresIndex = json.indexOf('"expires_at"');
    expect(approvalIndex).toBeGreaterThan(-1);
    expect(badgeIndex).toBeGreaterThan(approvalIndex);
    expect(expiresIndex).toBeGreaterThan(badgeIndex);
  });

  it("is byte-stable regardless of badge key insertion order", () => {
    const badgeFirst = { badge: "balanced", ...basePlan() } as ResolutionPlan;
    expect(resolutionPlanToJson(badgeFirst)).toBe(
      resolutionPlanToJson({ ...basePlan(), badge: "balanced" }),
    );
  });

  it("round-trips: canonical JSON with badge re-parses to a valid, equal plan", () => {
    const plan = { ...basePlan(), badge: "cheapest" } as ResolutionPlan;
    const reparsed = JSON.parse(resolutionPlanToJson(plan));
    expect(validateResolutionPlan(reparsed)).toBe(true);
    expect(reparsed).toEqual(plan);
  });
});
