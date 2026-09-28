/**
 * What "YOUR NEW PLAN" is allowed to claim.
 *
 * The card at the top of the Trust Layer is the one a traveller reads as "this
 * is what I will have after approving". Everything in it must therefore be
 * something the swarm is actually doing — not something it considered.
 */

import { describe, it, expect } from "vitest";
import { buildPresentation } from "@/lib/hackathonApi";
import type { ResolutionPlan, HotelAdjustment } from "@/agents/finance/TrustLayer";

/** The smallest plan the presentation builder will accept. */
function plan(): ResolutionPlan {
  return {
    currency: "EUR",
    proposed_resolution: {},
    financial_delta: { net_payable: 0 },
  } as unknown as ResolutionPlan;
}

const APA = {
  name: "APA Hotel Shinjuku Kabukicho Chuo",
  ratePerNight: 32_085,
  currency: "JPY",
  images: ["https://example.test/apa.jpg"],
  lat: 35.6955,
  lng: 139.7016,
};

describe("presentation hotel block", () => {
  /**
   * The live shape that produced the bug: `HotelAgent` degrades to
   * `keep_as_is` (⇒ action "none") when the POLICY lookup fails, while the
   * alternatives search beside it succeeded — so the adjustment carries rooms
   * it never recommended. The plan said "Hotel Gracery Shinjuku: no change
   * needed" and the card showed a different property's name, photos and rate.
   */
  it("shows no hotel when the verdict changes nothing, even if a room was found", () => {
    const adjustments: HotelAdjustment[] = [
      {
        hotel_name: "Hotel Gracery Shinjuku",
        action: "none",
        fee: 0,
        requires_confirmation: true,
        alternative: APA,
      } as unknown as HotelAdjustment,
    ];
    const out = buildPresentation({
      plan: plan(),
      best: null,
      hotelAdjustments: adjustments,
      activityProposals: [],
    });
    expect(out?.hotel).toBeUndefined();
    // …and no pin is dropped on a hotel the traveller is not moving to.
    expect((out?.map_points ?? []).some((p) => p.kind === "hotel")).toBe(false);
  });

  it("shows the replacement room when the swarm is actually rebooking", () => {
    const adjustments: HotelAdjustment[] = [
      {
        hotel_name: "Hotel Gracery Shinjuku",
        action: "rebook",
        fee: 0,
        alternative: APA,
      } as unknown as HotelAdjustment,
    ];
    const out = buildPresentation({
      plan: plan(),
      best: null,
      hotelAdjustments: adjustments,
      activityProposals: [],
    });
    expect(out?.hotel?.name).toBe(APA.name);
    expect(out?.hotel?.action).toBe("rebook");
    expect(out?.hotel?.rate_per_night).toBe(32_085);
  });

  /**
   * A real change with no alternative attached still belongs on the card — a
   * confirmed late check-in is the answer to "what happens to my room".
   */
  it("keeps a real action that carries no alternative", () => {
    const out = buildPresentation({
      plan: plan(),
      best: null,
      hotelAdjustments: [
        {
          hotel_name: "Hotel Gracery Shinjuku",
          action: "late_check_in",
          fee: 0,
        } as unknown as HotelAdjustment,
      ],
      activityProposals: [],
    });
    expect(out?.hotel?.name).toBe("Hotel Gracery Shinjuku");
    expect(out?.hotel?.action).toBe("late_check_in");
  });

  /** A rebook must win over a bystander room found on another night. */
  it("prefers the changing hotel over one that is merely being looked at", () => {
    const out = buildPresentation({
      plan: plan(),
      best: null,
      hotelAdjustments: [
        { hotel_name: "Night 1", action: "none", fee: 0, alternative: APA } as unknown as HotelAdjustment,
        {
          hotel_name: "Night 2",
          action: "rebook",
          fee: 0,
          alternative: { ...APA, name: "Shinjuku Granbell" },
        } as unknown as HotelAdjustment,
      ],
      activityProposals: [],
    });
    expect(out?.hotel?.name).toBe("Shinjuku Granbell");
  });
});
