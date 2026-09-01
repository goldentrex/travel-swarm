/**
 * Phase B (B1.2 / B4) — FlightAgent fare-pricing fan-out robustness.
 *
 * The agent prices only the cheapest N candidates (cap 5) concurrently via
 * Promise.allSettled with a per-call deadline: rejections and timeouts are
 * EXCLUDED from the assessment, never fatal.
 */

import { describe, expect, it } from "vitest";
import { FlightAgent } from "@/agents/flight/FlightAgent";
import type { FlightProvider } from "@/providers/interfaces/FlightProvider";
import type {
  AlternativeFlightsResult,
  BookingConfirmation,
  FareDifference,
  FlightOption,
  IsoTimestamp,
} from "@/providers/interfaces/types";

function makeOption(id: string, price: number): FlightOption {
  return {
    id,
    airline: "Fake Air",
    flightNumber: id,
    origin: "CDG",
    destination: "LIS",
    departureTime: "2026-08-22T13:00:00Z",
    arrivalTime: "2026-08-22T15:30:00Z",
    price,
    currency: "EUR",
  };
}

/** Configurable provider fake recording every pricing call. */
class FakeFlightProvider implements FlightProvider {
  readonly providerName = "fake";
  readonly pricedIds: string[] = [];

  constructor(
    private readonly options: FlightOption[],
    private readonly pricing: (newFlightId: string) => Promise<FareDifference>,
  ) {}

  async searchAlternativeFlights(
    flightId: string,
    requestedTime: IsoTimestamp,
  ): Promise<AlternativeFlightsResult> {
    return { referenceFlightId: flightId, requestedTime, options: this.options };
  }

  calculateFareDifference(oldFlightId: string, newFlightId: string): Promise<FareDifference> {
    this.pricedIds.push(newFlightId);
    return this.pricing(newFlightId);
  }

  async bookFlight(flightId: string): Promise<BookingConfirmation> {
    return {
      confirmationCode: "FAKE-1",
      flightId,
      status: "confirmed",
      bookedAt: new Date().toISOString(),
    };
  }
}

function fareFor(newFlightId: string, amount: number): FareDifference {
  return {
    oldFlightId: "flight-xy123",
    newFlightId,
    amount,
    currency: "EUR",
    direction: "charge",
  };
}

describe("FlightAgent Promise.allSettled fan-out", () => {
  it("caps pricing at the 5 cheapest candidates", async () => {
    const options = [
      makeOption("expensive-1", 900),
      makeOption("cheap-3", 120),
      makeOption("cheap-1", 100),
      makeOption("expensive-2", 950),
      makeOption("cheap-2", 110),
      makeOption("cheap-5", 140),
      makeOption("cheap-4", 130),
    ];
    const provider = new FakeFlightProvider(options, async (id) => fareFor(id, 10));
    const agent = new FlightAgent(provider);

    const assessment = await agent.assessRebookingOptions("flight-xy123", "2026-08-22T13:00:00Z");

    // Only the 5 cheapest were priced; the two 900+ options never reached pricing.
    expect(provider.pricedIds.sort()).toEqual(
      ["cheap-1", "cheap-2", "cheap-3", "cheap-4", "cheap-5"].sort(),
    );
    expect(assessment.candidates).toHaveLength(5);
  });

  it("excludes rejected pricings without sinking the assessment", async () => {
    const options = [makeOption("ok-1", 100), makeOption("boom", 110), makeOption("ok-2", 120)];
    const provider = new FakeFlightProvider(options, async (id) => {
      if (id === "boom") throw new Error("sandbox refused to price");
      return fareFor(id, id === "ok-1" ? 30 : 20);
    });
    const agent = new FlightAgent(provider);

    const assessment = await agent.assessRebookingOptions("flight-xy123", "2026-08-22T13:00:00Z");

    expect(assessment.candidates.map((c) => c.option.id).sort()).toEqual(["ok-1", "ok-2"]);
    // Best = smallest net charge among the survivors.
    expect(assessment.bestCandidate?.option.id).toBe("ok-2");
  });

  it("excludes a hung pricing call via the per-call deadline", async () => {
    const options = [makeOption("fast", 100), makeOption("hung", 105)];
    const provider = new FakeFlightProvider(options, (id) => {
      if (id === "hung") return new Promise<FareDifference>(() => {}); // never settles
      return Promise.resolve(fareFor(id, 25));
    });
    // Short deadline override keeps the test fast; production default is 4s.
    const agent = new FlightAgent(provider, { fareDeadlineMs: 30 });

    const started = Date.now();
    const assessment = await agent.assessRebookingOptions("flight-xy123", "2026-08-22T13:00:00Z");

    expect(assessment.candidates).toHaveLength(1);
    expect(assessment.candidates[0].option.id).toBe("fast");
    expect(assessment.bestCandidate?.option.id).toBe("fast");
    // The deadline bounded the wait (generous upper bound — no hang).
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns an empty assessment (no throw) when every pricing rejects", async () => {
    const options = [makeOption("a", 100), makeOption("b", 110)];
    const provider = new FakeFlightProvider(options, async () => {
      throw new Error("pricing outage");
    });
    const agent = new FlightAgent(provider);

    const assessment = await agent.assessRebookingOptions("flight-xy123", "2026-08-22T13:00:00Z");

    expect(assessment.candidates).toEqual([]);
    expect(assessment.bestCandidate).toBeNull();
    expect(assessment.originalFlightId).toBe("flight-xy123");
  });

  it("respects the maxPricedCandidates config override", async () => {
    const options = [makeOption("c1", 100), makeOption("c2", 110), makeOption("c3", 120)];
    const provider = new FakeFlightProvider(options, async (id) => fareFor(id, 5));
    const agent = new FlightAgent(provider, { maxPricedCandidates: 2 });

    const assessment = await agent.assessRebookingOptions("flight-xy123", "2026-08-22T13:00:00Z");

    expect(provider.pricedIds.sort()).toEqual(["c1", "c2"]);
    expect(assessment.candidates).toHaveLength(2);
  });
});
