/**
 * The expensive part of this product does not use a model.
 *
 * WHY THIS TEST EXISTS. A hackathon panel read our cost-control evidence as
 * thin, and they were right about the evidence: what we showed was a fixture
 * benchmark that says, in its own metadata, `liveTokensMeasured: false`. But
 * the strongest cost argument was never a benchmark at all — it is structural,
 * and it had no test naming it.
 *
 * The argument: a disruption mission's whole money path — reflowing the graph
 * downstream, ranking the replacements, reading each carrier's own fare rules,
 * building the ledger, stamping the quote's TTL — is arithmetic over typed
 * state. Not one step of it asks a language model anything. Models are used
 * only where language is genuinely the task (phrasing a trade-off question,
 * resequencing a day, reviewing a plan for nonsense), each behind a hard
 * per-mission ceiling and each with a deterministic rail underneath.
 *
 * So the cost of the part a traveler's money depends on is zero tokens, and
 * that is worth a failing test the day it stops being true.
 *
 * WHAT IS ASSERTED. The orchestrator resolves a missed flight with `fetch`
 * armed to throw — no model call, no supplier call, nothing — and still
 * produces plans, a ledger that balances, and an expiry: the three things the
 * settlement gate is made of. Suppliers are searched BEFORE this point and the
 * language stages run after it, in the API layer; what this pins down is the
 * stretch in between, where the trip is reflowed and the money is decided.
 * Anyone who later routes a money decision through a model will see this test
 * fail, naming the URL they reached for.
 *
 * The second half pins the ceiling itself: a mission is handed a fixed number
 * of model calls and is refused past it, including the calls held in reserve,
 * and a call that could not finish before the platform cancels the worker is
 * never started at all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import { OrchestratorAgent } from "@/agents/orchestrator/OrchestratorAgent";
import type { DisruptionEvent } from "@/agents/orchestrator/OrchestratorAgent";
import { PolicyAgent } from "@/agents/policy/PolicyAgent";
import { GEMINI_CALLS_PER_MISSION } from "@/agents/geminiDegrade";
import { GeminiCallBudget } from "@/agents/geminiUsage";
import type {
  FlightAgent,
  FlightRebookingAssessment,
  RebookingCandidate,
} from "@/agents/flight/FlightAgent";
import type { FareDifference, FlightOption } from "@/providers/interfaces/types";

const MINUTE_MS = 60_000;
const BASE = Date.parse("2026-11-12T08:00:00Z");
const FLIGHT_ID = "flight-sq636";

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
  feeAmount: number,
  arrivalTime: string,
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
    currency: "EUR",
    durationMinutes: 630,
    fareRule: rule("EUR", feeAmount),
  };
  const fareDifference: FareDifference = {
    oldFlightId: FLIGHT_ID,
    newFlightId: id,
    amount: price,
    currency: "EUR",
    direction: "charge",
  };
  return { option, fareDifference };
}

/** Candidates are handed over already fetched — this test is about what the
 *  orchestrator does with them, not about how they were found. */
function flightStub(candidates: RebookingCandidate[]): FlightAgent {
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
  // The downstream legs that make this a graph problem rather than a search:
  // the transfer waits on the flight, the check-in waits on the transfer.
  g.addNode({
    id: "transfer-hnd",
    type: "transfer",
    scheduledTime: BASE + 510 * MINUTE_MS,
    status: "on_track",
    dependsOn: [FLIGHT_ID],
    durationMinutes: 45,
    pickupLocationId: "HND",
  });
  g.addNode({
    id: "hotel-checkin",
    type: "hotel_check_in",
    scheduledTime: BASE + 600 * MINUTE_MS,
    status: "on_track",
    dependsOn: ["transfer-hnd"],
    hotelName: "Tokyo Bay Hotel",
  });
  return g;
}

function event(): DisruptionEvent {
  return {
    nodeId: FLIGHT_ID,
    delay: 120,
    description: "missed flight SQ636",
    fareRule: rule("SGD", 0),
    tripContext: { currency: "EUR", displayCurrency: "SGD" },
  } as unknown as DisruptionEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the money path spends no tokens", () => {
  it("reflows the trip, prices it and stamps a TTL with fetch armed to throw", async () => {
    // Anything reaching the network — a model, a supplier, a rate table —
    // fails the test and names the URL it tried.
    const reached: string[] = [];
    vi.stubGlobal("fetch", (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
      reached.push(url);
      throw new Error(`the money path reached the network: ${url}`);
    });

    const outcome = await new OrchestratorAgent(
      graph(),
      flightStub([
        candidate("EARLY", "Scoot", 120, 40, "2026-11-12T22:40:00Z"),
        candidate("LATER", "AirAsia", 60, 5, "2026-11-13T04:00:00Z"),
      ]),
      new PolicyAgent(),
    ).resolveDisruptionMulti(event());

    expect(reached).toEqual([]);
    expect(outcome.plans.length).toBeGreaterThan(0);

    for (const plan of outcome.plans) {
      const delta = plan.financial_delta;
      // The one invariant the settlement gate is built on, computed here
      // without a single token being spent.
      expect(delta.net_payable).toBeCloseTo(delta.total_new_charges - delta.total_refund, 9);
      // A quote a traveler can act on has to say when it stops being one.
      expect(typeof plan.expires_at).toBe("number");
      expect(plan.expires_at).toBeGreaterThan(Date.now());
    }
  });
});

describe("what a mission may spend is a ceiling, not a hope", () => {
  it("hands out the stated number of calls and then refuses, reserve included", () => {
    const RESERVED = 2;
    const budget = new GeminiCallBudget(GEMINI_CALLS_PER_MISSION + RESERVED, RESERVED);

    // Ordinary callers stop at the line that protects the reserve…
    let granted = 0;
    while (budget.tryReserve()) granted += 1;
    expect(granted).toBe(GEMINI_CALLS_PER_MISSION);
    expect(budget.tryReserve()).toBe(false);

    // …and the reserve itself is finite too, so nothing can spend unbounded.
    let privileged = 0;
    while (budget.tryReserve(true)) privileged += 1;
    expect(privileged).toBe(RESERVED);
    expect(budget.callsUsed).toBe(GEMINI_CALLS_PER_MISSION + RESERVED);
  });

  it("refuses a call that could not finish before the platform cancels us", () => {
    // Cloudflare cancels a `waitUntil` continuation 30 s after the ack, with
    // no error. A call started past the cut-off would be billed and lost.
    const budget = new GeminiCallBudget(5, 0, Date.now() - 1);
    expect(budget.tryReserve()).toBe(false);
    expect(budget.lastRefusal).toBe("deadline");
  });
});
