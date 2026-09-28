/**
 * Each plan's money must describe that plan's own flight.
 *
 * Found on a live mission 2026-09-19: the carousel offered an AirAsia routing
 * via Kuala Lumpur, and its money panel charged a change fee of VND 1 100 000.
 * Both halves were real; they belonged to different flights. The verdict was
 * computed ONCE, from the pipeline's single cheapest candidate — a VietJet
 * routing via Saigon, whose fare rules the Atlas sandbox publishes in VND —
 * and then stamped onto every plan in the carousel.
 *
 * (Probed the same day: AirAsia SIN→HND routings publish their rules in
 * MYR/SGD, VietJet's in VND. Nothing about either was wrong; pairing them was.)
 */

import { describe, expect, it } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { OrchestratorAgent } from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import { PolicyAgent } from "@/agents/policy/PolicyAgent";
import type {
  FlightAgent,
  FlightRebookingAssessment,
  RebookingCandidate,
} from "@/agents/flight/FlightAgent";
import type { FareDifference, FlightOption } from "@/providers/interfaces/types";

const MINUTE_MS = 60_000;
const BASE = Date.parse("2026-11-12T08:00:00Z");
const FLIGHT_ID = "flight-sq636";

/** An Atlas-shaped rule blob: one change window, priced in `currency`. */
function rule(currency: string, amount: number): Record<string, unknown> {
  return {
    changesRules: {
      changesStatus: "T",
      currency,
      ruleDetailList: [{ amount, currency, startMinute: 525_600, endMinute: 0 }],
    },
    refundRules: { refundStatus: "T", currency, ruleDetailList: [] },
  };
}

function candidate(
  id: string,
  airline: string,
  price: number,
  fareCurrency: string,
  ruleCurrency: string,
  ruleAmount: number,
  arrivalTime = "2026-11-12T22:40:00Z",
): RebookingCandidate {
  const option: FlightOption = {
    id,
    airline,
    flightNumber: id,
    origin: "SIN",
    destination: "HND",
    departureTime: "2026-11-12T12:10:00Z",
    arrivalTime,
    price,
    currency: fareCurrency,
    durationMinutes: 630,
    fareRule: rule(ruleCurrency, ruleAmount),
  };
  const fareDifference: FareDifference = {
    oldFlightId: FLIGHT_ID,
    newFlightId: id,
    amount: price,
    currency: fareCurrency,
    direction: "charge",
  };
  return { option, fareDifference };
}

function flightStub(candidates: RebookingCandidate[]): FlightAgent {
  // The pipeline's "best" is the cheapest — the very selection that used to
  // decide the whole carousel's money.
  const bestCandidate = [...candidates].sort((a, b) => a.option.price - b.option.price)[0] ?? null;
  return {
    assessRebookingOptions: async (
      flightId: string,
      newTime: string,
    ): Promise<FlightRebookingAssessment> => ({
      originalFlightId: flightId,
      requestedTime: newTime,
      candidates,
      bestCandidate,
    }),
  } as unknown as FlightAgent;
}

function graph(): ItineraryGraph {
  const g = new ItineraryGraph();
  g.addNode({
    id: FLIGHT_ID,
    type: "flight",
    flightNumber: "SQ636",
    origin: "SIN",
    destination: "HND",
    departureTime: BASE,
    arrivalTime: BASE + 480 * MINUTE_MS,
    scheduledTime: BASE,
    status: "on_track",
    dependsOn: [],
    arrivalLocationId: "HND",
  });
  return g;
}

function event(): DisruptionEvent {
  return {
    nodeId: FLIGHT_ID,
    delay: 120,
    description: "missed flight SQ636",
    // The ticket's own rule, as the client sends it: changes permitted, so the
    // rebooking gate opens and the candidates are actually assessed.
    fareRule: rule("SGD", 0),
    tripContext: { currency: "EUR", displayCurrency: "SGD" },
  } as unknown as DisruptionEvent;
}

describe("a carousel plan carries its OWN flight's fare policy", () => {
  it("never charges one airline's change fee on another airline's plan", async () => {
    // Cheaper but far later (the 30-hour Saigon routing) vs dearer and
    // sooner: neither dominates, so both reach the carousel.
    const vietjet = candidate(
      "VJ-SGN",
      "VietJet",
      46.09,
      "EUR",
      "VND",
      1_100_000,
      "2026-11-13T18:00:00Z",
    );
    const airasia = candidate("AK-KUL", "AirAsia", 128.95, "EUR", "MYR", 180);

    const outcome = await new OrchestratorAgent(
      graph(),
      flightStub([vietjet, airasia]),
      new PolicyAgent(),
    ).resolveDisruptionMulti(event());

    const byFlight = new Map(
      outcome.plans.map((plan) => [
        plan.proposed_resolution.new_flight?.id,
        plan.proposed_resolution.policy_verdict,
      ]),
    );
    expect(byFlight.size).toBeGreaterThan(1);

    // Each verdict quotes the currency ITS carrier published…
    expect(byFlight.get("VJ-SGN")?.billedCurrency).toBe("VND");
    expect(byFlight.get("AK-KUL")?.billedCurrency).toBe("MYR");
    // …and no plan carries the other one's.
    expect(byFlight.get("AK-KUL")?.billedCurrency).not.toBe("VND");
  });

  /**
   * Photographed 2026-09-20: a Scoot plan badged CHEAPEST at "You pay now
   * 96.25 €", beside an AirAsia plan that hands 1.65 € BACK. Both figures
   * were right. The badge ranked on the fare difference alone, and the €120
   * change fee that made the difference sat outside the comparison.
   */
  it("calls the plan that costs LESS the cheapest, fee included", async () => {
    // Small fare, brutal change fee.
    const dearOnceChanged = candidate(
      "SCOOT",
      "Scoot",
      10,
      "EUR",
      "EUR",
      120,
      "2026-11-12T22:40:00Z",
    );
    // Bigger fare, almost no fee — and genuinely the cheaper of the two.
    const cheapOnceChanged = candidate(
      "AIRASIA",
      "AirAsia",
      50,
      "EUR",
      "EUR",
      5,
      "2026-11-13T04:00:00Z",
    );

    const outcome = await new OrchestratorAgent(
      graph(),
      flightStub([dearOnceChanged, cheapOnceChanged]),
      new PolicyAgent(),
    ).resolveDisruptionMulti(event());

    const badgesFor = (id: string) =>
      outcome.plans.find((plan) => plan.proposed_resolution.new_flight?.id === id)?.badges ?? [];

    expect(badgesFor("AIRASIA")).toContain("cheapest");
    expect(badgesFor("SCOOT")).not.toContain("cheapest");
    // …and the carousel opens on it, rather than on the dearer plan.
    expect(outcome.plans[0]?.proposed_resolution.new_flight?.id).toBe("AIRASIA");
  });

  /**
   * The same blind spot one step earlier: dominance judged on the fare alone
   * drops the option that is cheaper once the fee is counted, so it never
   * reaches the carousel to be badged at all.
   */
  it("does not drop a cheaper-after-fees option as dominated", async () => {
    // Earlier AND a smaller fare — dominant on both axes, until the fee.
    const earlyAndDear = candidate("EARLY", "Scoot", 10, "EUR", "EUR", 200, "2026-11-12T20:00:00Z");
    const laterAndCheap = candidate(
      "LATER",
      "AirAsia",
      60,
      "EUR",
      "EUR",
      0,
      "2026-11-13T02:00:00Z",
    );

    const outcome = await new OrchestratorAgent(
      graph(),
      flightStub([earlyAndDear, laterAndCheap]),
      new PolicyAgent(),
    ).resolveDisruptionMulti(event());

    const ids = outcome.plans.map((plan) => plan.proposed_resolution.new_flight?.id);
    expect(ids).toContain("LATER");
  });

  it("still converts into the fare's currency so one panel reads as one bill", async () => {
    const airasia = candidate("AK-KUL", "AirAsia", 128.95, "EUR", "MYR", 180);
    const outcome = await new OrchestratorAgent(
      graph(),
      flightStub([airasia]),
      new PolicyAgent(),
    ).resolveDisruptionMulti(event());

    const verdict = outcome.plans[0]?.proposed_resolution.policy_verdict;
    // Shown in the fare's own currency, with the carrier's exact figure kept.
    expect(verdict?.currency).toBe("EUR");
    expect(verdict?.billedChangeFee).toBe(180);
    expect(verdict?.billedCurrency).toBe("MYR");
    expect(verdict?.changeFee).toBeGreaterThan(0);
    expect(verdict?.changeFee).toBeLessThan(180);
  });
});
