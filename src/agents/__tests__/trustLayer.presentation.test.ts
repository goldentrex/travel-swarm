/**
 * Phase B (B3/B4) — TrustLayer contract enrichment round-trip tests.
 *
 * The additive fields (`currency`, `presentation`, enriched `new_flight`,
 * `new_time_iso`/`reason`, `hotel_adjustments[].alternative`) must be:
 *  - ABSENT  → still valid, byte-identical canonical serialization.
 *  - PRESENT → validated tolerantly and carried through resolutionPlanToJson.
 */

import { describe, expect, it } from "vitest";
import { resolutionPlanToJson, validateResolutionPlan } from "@/agents/finance/TrustLayer";
import type { ResolutionPlan } from "@/agents/finance/TrustLayer";

/** Minimal pre-extension plan — no currency, no presentation. */
function basePlan(): ResolutionPlan {
  return {
    incident: "Flight XY123 delayed by 4h",
    impacted_nodes: ["Flight XY123", "Transfer"],
    proposed_resolution: {
      new_flight: { id: "XY777", cost: 189.5 },
      rescheduled_activities: [{ name: "Surf Lesson", new_time: "Tomorrow 10:00", penalty: 20 }],
    },
    financial_delta: { total_refund: 0, total_new_charges: 209.5, net_payable: 209.5 },
    requires_human_approval: true,
  };
}

describe("TrustLayer Phase B enrichment — round-trip", () => {
  it("keeps pre-extension plans (currency/presentation ABSENT) valid and byte-stable", () => {
    const plan = basePlan();
    expect(validateResolutionPlan(plan)).toBe(true);

    const json = resolutionPlanToJson(plan);
    expect(json).not.toContain("presentation");
    expect(json).not.toContain('"currency"');
    // Round-trip: parse → validate → re-serialize byte-identically.
    const parsed = JSON.parse(json);
    expect(validateResolutionPlan(parsed)).toBe(true);
    expect(resolutionPlanToJson(parsed)).toBe(json);
  });

  it("validates and round-trips a fully enriched plan (currency + presentation PRESENT)", () => {
    const plan: ResolutionPlan = {
      ...basePlan(),
      proposed_resolution: {
        new_flight: {
          id: "XY777",
          cost: 189.5,
          origin: "CDG",
          destination: "OPO",
          airline: "Atlas Demo (scripted diversion)",
          departure: "2026-08-22T13:00:00Z",
          arrival: "2026-08-22T15:30:00Z",
          currency: "EUR",
        },
        rescheduled_activities: [
          {
            name: "Surf Lesson",
            new_time: "Tomorrow 10:00",
            penalty: 15,
            new_time_iso: "2026-08-23T10:00:00Z",
            reason:
              "Change lands inside the 24h window before start, so Viator's standard policy applies a flat 15 service charge.",
          },
        ],
        hotel_adjustments: [
          {
            hotel_name: "Atlantica Surf House",
            action: "rebook",
            fee: 30,
            alternative: {
              name: "Atlantica Surf House Annex",
              ratePerNight: 120,
              currency: "EUR",
              freeCancellationUntil: "2026-08-21T18:00:00Z",
              lat: 38.7,
              lng: -9.1,
              images: ["https://img.example/1.jpg", "https://img.example/2.jpg"],
            },
          },
        ],
      },
      currency: "EUR",
      presentation: {
        hotel: {
          name: "Atlantica Surf House Annex",
          action: "rebook",
          rate_per_night: 120,
          currency: "EUR",
          free_cancellation_until: "2026-08-21T18:00:00Z",
          lat: 38.7,
          lng: -9.1,
          images: ["https://img.example/1.jpg"],
        },
        activity_swap: {
          name: "Lisbon Aquarium",
          image: "https://img.example/aquarium.jpg",
          price_from: 25,
          currency: "EUR",
          rating: 4.7,
        },
        map_points: [
          { label: "Paris CDG", lat: 49.0097, lng: 2.5479, kind: "airport_origin" },
          { label: "Porto", lat: 41.2481, lng: -8.6814, kind: "airport_new" },
          { label: "Atlantica Surf House", lat: 38.7, lng: -9.1, kind: "hotel" },
        ],
        ledger_summary: [
          "You pay now — new ticket: +€150.00",
          "You pay now — transfer re-quote: +€45.00",
          "Total due now: €175.00",
        ],
      },
    };

    expect(validateResolutionPlan(plan)).toBe(true);
    const json = resolutionPlanToJson(plan);
    const parsed = JSON.parse(json) as ResolutionPlan;
    expect(validateResolutionPlan(parsed)).toBe(true);

    // All additive fields survive the round-trip.
    expect(parsed.currency).toBe("EUR");
    expect(parsed.proposed_resolution.new_flight?.origin).toBe("CDG");
    expect(parsed.proposed_resolution.new_flight?.destination).toBe("OPO");
    expect(parsed.proposed_resolution.new_flight?.airline).toBe("Atlas Demo (scripted diversion)");
    expect(parsed.proposed_resolution.rescheduled_activities[0].new_time_iso).toBe(
      "2026-08-23T10:00:00Z",
    );
    expect(parsed.proposed_resolution.rescheduled_activities[0].reason).toContain("24h window");
    expect(parsed.proposed_resolution.hotel_adjustments?.[0].alternative?.images).toHaveLength(2);
    expect(parsed.presentation?.map_points).toHaveLength(3);
    expect(parsed.presentation?.ledger_summary?.[0]).toBe("You pay now — new ticket: +€150.00");
    // Canonical output is byte-stable across producers.
    expect(resolutionPlanToJson(parsed)).toBe(json);
  });

  it("rejects a blank currency but accepts any non-empty ISO-4217-ish code", () => {
    expect(validateResolutionPlan({ ...basePlan(), currency: "" })).toBe(false);
    expect(validateResolutionPlan({ ...basePlan(), currency: "   " })).toBe(false);
    expect(validateResolutionPlan({ ...basePlan(), currency: "USD" })).toBe(true);
  });

  it("rejects malformed presentation blocks tolerantly typed", () => {
    // hotel.name must be a non-empty string.
    expect(
      validateResolutionPlan({
        ...basePlan(),
        presentation: { hotel: { name: "", action: "rebook" } },
      }),
    ).toBe(false);
    // map_points kinds are an enum.
    expect(
      validateResolutionPlan({
        ...basePlan(),
        presentation: {
          map_points: [{ label: "X", lat: 1, lng: 2, kind: "restaurant" as never }],
        },
      }),
    ).toBe(false);
    // ledger_summary must be strings.
    expect(
      validateResolutionPlan({
        ...basePlan(),
        presentation: { ledger_summary: [42 as never] },
      }),
    ).toBe(false);
    // An empty presentation object is well-formed (all fields optional).
    expect(validateResolutionPlan({ ...basePlan(), presentation: {} })).toBe(true);
  });

  it("rejects malformed additive new_flight / activity fields", () => {
    expect(
      validateResolutionPlan({
        ...basePlan(),
        proposed_resolution: {
          ...basePlan().proposed_resolution,
          new_flight: { id: "XY777", cost: 10, origin: 42 as never },
        },
      }),
    ).toBe(false);
    expect(
      validateResolutionPlan({
        ...basePlan(),
        proposed_resolution: {
          new_flight: { id: "XY777", cost: 10 },
          rescheduled_activities: [
            { name: "Surf", new_time: "Tomorrow 10:00", penalty: 0, new_time_iso: 7 as never },
          ],
        },
      }),
    ).toBe(false);
  });
});

describe("TrustLayer additive ledger fields — verdict currency + by_currency", () => {
  /** basePlan enriched with the verdict currency and per-currency buckets. */
  function enrichedPlan(): ResolutionPlan {
    return {
      ...basePlan(),
      proposed_resolution: {
        ...basePlan().proposed_resolution,
        policy_verdict: {
          rebookPermitted: true,
          changeFee: 25,
          recommendedAction: "rebook",
          noShowApplied: false,
          currency: "EUR",
        },
      },
      financial_delta: {
        total_refund: 0,
        total_new_charges: 25,
        net_payable: 25,
        by_currency: [
          { currency: "EUR", total_refund: 0, total_new_charges: 25, net_payable: 25 },
          { currency: "USD", total_refund: 0, total_new_charges: 150, net_payable: 150 },
        ],
      },
    };
  }

  it("verdict currency and by_currency survive canonicalization (order kept)", () => {
    const plan = enrichedPlan();
    expect(validateResolutionPlan(plan)).toBe(true);

    const json = resolutionPlanToJson(plan);
    const parsed = JSON.parse(json) as ResolutionPlan;
    expect(validateResolutionPlan(parsed)).toBe(true);

    // Both additive fields carried through, buckets in their original order.
    expect(parsed.proposed_resolution.policy_verdict?.currency).toBe("EUR");
    expect(parsed.financial_delta.by_currency).toEqual(plan.financial_delta.by_currency);
    expect(parsed.financial_delta.by_currency?.map((bucket) => bucket.currency)).toEqual([
      "EUR",
      "USD",
    ]);
    // Canonical output is byte-stable across producers.
    expect(resolutionPlanToJson(parsed)).toBe(json);
  });

  it("a plan without them serializes unchanged (no new keys emitted)", () => {
    const legacy: ResolutionPlan = {
      ...basePlan(),
      proposed_resolution: {
        ...basePlan().proposed_resolution,
        policy_verdict: {
          rebookPermitted: true,
          changeFee: 25,
          recommendedAction: "rebook",
          noShowApplied: false,
        },
      },
    };
    expect(validateResolutionPlan(legacy)).toBe(true);

    const json = resolutionPlanToJson(legacy);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    // The verdict keeps exactly the four legacy keys.
    expect(Object.keys((parsed.proposed_resolution as any).policy_verdict)).toEqual([
      "rebookPermitted",
      "changeFee",
      "recommendedAction",
      "noShowApplied",
    ]);
    // financial_delta keeps exactly the legacy triple.
    expect(Object.keys((parsed as any).financial_delta)).toEqual([
      "total_refund",
      "total_new_charges",
      "net_payable",
    ]);
    expect(json).not.toContain("by_currency");
    // Round-trip byte-stability.
    const reparsed = parsed as unknown as ResolutionPlan;
    expect(validateResolutionPlan(reparsed)).toBe(true);
    expect(resolutionPlanToJson(reparsed)).toBe(json);
  });

  it("rejects by_currency arrays with duplicate-currency buckets", () => {
    const duplicated: ResolutionPlan = {
      ...basePlan(),
      financial_delta: {
        total_refund: 0,
        total_new_charges: 175,
        net_payable: 175,
        by_currency: [
          { currency: "EUR", total_refund: 0, total_new_charges: 25, net_payable: 25 },
          { currency: "EUR", total_refund: 0, total_new_charges: 150, net_payable: 150 },
        ],
      },
    };
    expect(validateResolutionPlan(duplicated)).toBe(false);
    // Distinct currencies stay valid.
    expect(validateResolutionPlan(enrichedPlan())).toBe(true);
  });
});

describe("TrustLayer additive badges — dual-badge wire field", () => {
  it("absent badges stay valid and emit NO key (legacy bytes unchanged)", () => {
    const plan = basePlan();
    expect(validateResolutionPlan(plan)).toBe(true);
    const json = resolutionPlanToJson(plan);
    expect(json).not.toContain("badges");
    // Round-trip byte-stability of the legacy format.
    expect(resolutionPlanToJson(JSON.parse(json))).toBe(json);
  });

  it("accepts non-empty arrays of the frozen badge union", () => {
    expect(validateResolutionPlan({ ...basePlan(), badges: ["cheapest", "fastest"] })).toBe(true);
    expect(validateResolutionPlan({ ...basePlan(), badges: ["balanced"] })).toBe(true);
    // The full frozen union is a valid set too.
    expect(
      validateResolutionPlan({ ...basePlan(), badges: ["cheapest", "fastest", "balanced"] }),
    ).toBe(true);
  });

  it("rejects empty arrays, unknown values and non-array shapes", () => {
    expect(validateResolutionPlan({ ...basePlan(), badges: [] })).toBe(false);
    expect(validateResolutionPlan({ ...basePlan(), badges: ["premium" as never] })).toBe(false);
    expect(validateResolutionPlan({ ...basePlan(), badges: ["cheapest", "luxury" as never] })).toBe(
      false,
    );
    expect(validateResolutionPlan({ ...basePlan(), badges: "cheapest" as never })).toBe(false);
  });

  it("rejects duplicate badge values (duplicate identities break ForEach)", () => {
    // `["cheapest","cheapest"]` used to pass validation, but clients render
    // badges with `ForEach(id: \.self)` — duplicate identities are unsafe.
    expect(validateResolutionPlan({ ...basePlan(), badges: ["cheapest", "cheapest"] })).toBe(false);
    expect(
      validateResolutionPlan({ ...basePlan(), badges: ["fastest", "balanced", "fastest"] }),
    ).toBe(false);
    // Order does not matter — ANY repeated value rejects.
    expect(
      validateResolutionPlan({ ...basePlan(), badges: ["balanced", "cheapest", "balanced"] }),
    ).toBe(false);
  });

  it("emits badges right after badge in fixed position, round-trip byte-stable", () => {
    const plan: ResolutionPlan = {
      ...basePlan(),
      badge: "cheapest",
      badges: ["cheapest", "fastest"],
    };
    const json = resolutionPlanToJson(plan);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "incident",
      "impacted_nodes",
      "proposed_resolution",
      "financial_delta",
      "requires_human_approval",
      "badge",
      "badges",
    ]);
    expect(parsed.badge).toBe("cheapest");
    expect(parsed.badges).toEqual(["cheapest", "fastest"]);
    // Canonical bytes are stable across producers/round-trips.
    expect(resolutionPlanToJson(parsed as unknown as ResolutionPlan)).toBe(json);
  });
});
