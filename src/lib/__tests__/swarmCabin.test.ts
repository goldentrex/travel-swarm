/**
 * Cabin continuity through a swarm recovery.
 *
 * A rebooking that puts a business-class traveller back in economy is not a
 * recovery — it is an unrequested downgrade, and it prices the fare delta
 * against the wrong product. Nothing in `src/agents` referenced `cabin` at
 * all before this, so every recovery searched the provider default.
 */
import { describe, expect, it } from "vitest";

import { hydrateTripFromContent } from "@/lib/swarmTripContext";
import { atlasCabinClass } from "@/providers/atlas/AtlasFlightProvider";

function contentWithCabin(cabin: unknown): Record<string, unknown> {
  return {
    days: [],
    transit_groups: [
      {
        id: "tg0",
        method: "flight",
        reference: "TP437",
        origin: { code: "CDG", city: "Paris" },
        destination: { code: "LIS", city: "Lisbon" },
        depart: "2026-09-10T09:00",
        arrive: "2026-09-10T11:30",
        ...(cabin === undefined ? {} : { cabin }),
      },
    ],
  };
}

function flightNodeCabin(cabin: unknown): string | undefined {
  const hydrated = hydrateTripFromContent(
    "11111111-2222-3333-4444-555555555555",
    "Trip",
    "Lisbon",
    contentWithCabin(cabin),
  );
  const node = hydrated?.graph.getNode("flight-0");
  return node && node.type === "flight" ? node.cabin : undefined;
}

describe("cabin hydration from the trip leg", () => {
  it("carries the booked cabin onto the flight node", () => {
    expect(flightNodeCabin("Business")).toBe("business");
    expect(flightNodeCabin("business class")).toBe("business");
    expect(flightNodeCabin("FIRST")).toBe("first");
    expect(flightNodeCabin("Premium Economy")).toBe("premium_economy");
    expect(flightNodeCabin("Economy")).toBe("economy");
  });

  it("leaves the cabin absent rather than guessing", () => {
    // A wrong cabin prices the wrong product, so an unreadable value must
    // yield nothing at all and let the provider keep its own default.
    expect(flightNodeCabin(undefined)).toBeUndefined();
    expect(flightNodeCabin("")).toBeUndefined();
    expect(flightNodeCabin("saver fare")).toBeUndefined();
    expect(flightNodeCabin(42)).toBeUndefined();
  });
});

describe("atlasCabinClass", () => {
  it("maps the four fare families onto the upstream integers", () => {
    expect(atlasCabinClass("economy")).toBe(1);
    expect(atlasCabinClass("premium_economy")).toBe(2);
    expect(atlasCabinClass("business")).toBe(3);
    expect(atlasCabinClass("first")).toBe(4);
  });

  it("returns null for an unknown cabin so the request omits the field", () => {
    // Omitting is the safe default: pinning an unknown cabin to economy (1)
    // would silently downgrade a premium ticket.
    expect(atlasCabinClass(undefined)).toBeNull();
    expect(atlasCabinClass("saver")).toBeNull();
  });
});
