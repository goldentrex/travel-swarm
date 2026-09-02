/**
 * A replacement has to be a flight the traveller can actually board.
 *
 * Route searches return the disrupted leg alongside the genuine alternatives,
 * and nothing removed it — so running "I missed my flight" on Scoot TR892
 * (SIN → CTS, 22 Dec, 06:10) proposed TR892, SIN → CTS, 22 Dec, 06:10 as its
 * own replacement, with a change fee attached.
 */

import { describe, expect, it } from "vitest";
import { FlightAgent } from "@/agents/flight/FlightAgent";
import type { FlightProvider } from "@/providers/interfaces/FlightProvider";
import type {
  AlternativeFlightsResult,
  BookingConfirmation,
  FareDifference,
  FlightOption,
  FlightRouteContext,
  IsoTimestamp,
} from "@/providers/interfaces/types";

const ORIGINAL_DEPARTURE = "2026-12-22T06:10:00Z";

function option(
  id: string,
  flightNumber: string,
  departureTime: string,
  price = 400,
): FlightOption {
  return {
    id,
    airline: "Scoot",
    flightNumber,
    origin: "SIN",
    destination: "CTS",
    departureTime,
    arrivalTime: "2026-12-22T17:20:00Z",
    price,
    currency: "USD",
  };
}

class Provider implements FlightProvider {
  readonly providerName = "fake";
  constructor(private readonly options: FlightOption[]) {}
  async searchAlternativeFlights(
    flightId: string,
    requestedTime: IsoTimestamp,
  ): Promise<AlternativeFlightsResult> {
    return { referenceFlightId: flightId, requestedTime, options: this.options };
  }
  async calculateFareDifference(oldFlightId: string, newFlightId: string): Promise<FareDifference> {
    return { oldFlightId, newFlightId, amount: 10, currency: "USD", direction: "charge" };
  }
  async bookFlight(flightId: string): Promise<BookingConfirmation> {
    return { confirmationCode: "X", flightId, status: "confirmed", bookedAt: ORIGINAL_DEPARTURE };
  }
}

const missedContext: FlightRouteContext = {
  origin: "SIN",
  destination: "CTS",
  excludeFlight: { flightNumber: "TR892", departureTime: ORIGINAL_DEPARTURE },
  earliestDeparture: ORIGINAL_DEPARTURE,
};

async function candidateIds(options: FlightOption[], ctx?: FlightRouteContext) {
  const agent = new FlightAgent(new Provider(options));
  const assessment = await agent.assessRebookingOptions("flight-0", ORIGINAL_DEPARTURE, ctx);
  return assessment.candidates.map((c) => c.option.id);
}

describe("why there was no replacement — and who to blame for it", () => {
  // Verified against the live Atlas sandbox on 2026-09-02: SIN → FCO, ROM,
  // MXP, CDG, FRA, MUC, BCN and DOH return ZERO routings on every date tried,
  // while SIN → LHR / NRT / AMS / IST / DXB return flights normally. The
  // partner's test dataset simply has no Southern-Europe inventory.
  //
  // That is worth telling a traveller — but ONLY when it is actually true.
  // Saying "our partner doesn't cover Rome" when our own 48h rebooking horizon
  // threw away three perfectly good flights would send someone off to rebook
  // manually for no reason at all.

  const HOUR = 3_600_000;
  const at = (hours: number) =>
    new Date(Date.parse(ORIGINAL_DEPARTURE) + hours * HOUR).toISOString();

  async function assess(options: FlightOption[], ctx?: FlightRouteContext) {
    const agent = new FlightAgent(new Provider(options));
    return agent.assessRebookingOptions("flight-0", ORIGINAL_DEPARTURE, ctx);
  }

  it("blames the partner's coverage ONLY after several empty dates", async () => {
    // A route with daily service does not go a whole week without a flight.
    const assessment = await assess([], missedContext);
    expect((assessment.searchedDates?.length ?? 0) >= 2).toBe(true);
    expect(assessment.noReplacementReason).toBe("route_not_covered");
    expect(assessment.providerOptionCount).toBe(0);
  });

  it("does NOT blame coverage from a single date — that proves nothing", async () => {
    // The legacy single-search path (no routeContext) searches one day. Empty
    // there could be coverage or could be a quiet Tuesday; it must claim neither.
    const assessment = await assess([]);
    expect(assessment.noReplacementReason).toBe("no_options_on_date");
  });

  it("blames OUR rebooking horizon when the partner did have flights", async () => {
    // The exact trap: the provider answered with options, and the 48h ceiling
    // removed every one. Nothing here is the partner's fault.
    const bounded: FlightRouteContext = { ...missedContext, latestDeparture: at(48) };
    const assessment = await assess(
      [option("late-1", "TR900", at(24 * 5)), option("late-2", "TR901", at(24 * 6))],
      bounded,
    );
    expect(assessment.candidates).toEqual([]);
    expect(assessment.noReplacementReason).toBe("all_options_rejected");
    // The evidence that says so: the partner DID return options.
    expect(assessment.providerOptionCount).toBe(2);
  });

  it("a DECLINED search is not evidence of anything", async () => {
    // A provider that refuses to look returns the same empty array as one that
    // looked and found nothing. Only the flag separates them.
    class Declining extends Provider {
      async searchAlternativeFlights(flightId: string, requestedTime: IsoTimestamp) {
        return {
          referenceFlightId: flightId,
          requestedTime,
          options: [],
          searchWasAnswered: false,
          searchDeclinedReason: "Can not search past flights",
        };
      }
    }
    const agent = new FlightAgent(new Declining([]));
    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );
    expect(assessment.noReplacementReason).toBe("search_declined");
    expect(assessment.searchDeclinedReason).toBe("Can not search past flights");
  });

  it("says nothing at all when a replacement was found", async () => {
    const assessment = await assess([option("ok", "TR900", at(6))], missedContext);
    expect(assessment.candidates.length).toBeGreaterThan(0);
    expect(assessment.noReplacementReason).toBeUndefined();
  });
});

describe("fare pricing must not stampede the provider", () => {
  // The bug this pins cost a user every single test they ran. Verified against
  // the live Atlas sandbox on 2026-09-02: FIVE concurrent `verify.do` calls
  // return HTTP 429 — all five. Every candidate was then dropped as
  // unpriceable and the traveller was told "we found flights but couldn't
  // price them", route after route, while the identical calls made ONE AT A
  // TIME each succeeded in ~90ms.
  //
  // The provider rate-limits per QPS, so the parallel fan-out was manufacturing
  // the very failure it reported.

  const HOUR = 3_600_000;
  const at = (h: number) => new Date(Date.parse(ORIGINAL_DEPARTURE) + h * HOUR).toISOString();

  /** Records how many pricing calls are in flight at the same moment. */
  class ConcurrencyProbe extends Provider {
    inFlight = 0;
    peak = 0;
    async calculateFareDifference(oldFlightId: string, newFlightId: string) {
      this.inFlight += 1;
      this.peak = Math.max(this.peak, this.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      this.inFlight -= 1;
      return {
        oldFlightId,
        newFlightId,
        amount: 10,
        currency: "USD",
        direction: "charge" as const,
      };
    }
  }

  it("prices candidates ONE AT A TIME, never as a fan-out", async () => {
    const provider = new ConcurrencyProbe([
      option("a", "TR900", at(2), 100),
      option("b", "TR901", at(3), 110),
      option("c", "TR902", at(4), 120),
      option("d", "TR903", at(5), 130),
      option("e", "TR904", at(6), 140),
    ]);
    const agent = new FlightAgent(provider, { fareDeadlineMs: 5_000 });
    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );
    expect(assessment.candidates.length).toBe(5);
    // The whole point: never more than one verify in flight.
    expect(provider.peak).toBe(1);
  }, 20000);

  it("retries a rate-limited pricing instead of dropping the flight", async () => {
    // 429 has been flagged `retryable` in the provider's error taxonomy all
    // along — nothing ever acted on the flag, so one transient refusal lost a
    // perfectly bookable flight.
    class RateLimitedOnce extends Provider {
      attempts = 0;
      async calculateFareDifference(oldFlightId: string, newFlightId: string) {
        this.attempts += 1;
        if (this.attempts === 1) {
          throw Object.assign(new Error("Atlas request to /verify.do failed with HTTP 429."), {
            name: "AtlasApiError",
            retryable: true,
          });
        }
        return {
          oldFlightId,
          newFlightId,
          amount: 42,
          currency: "USD",
          direction: "charge" as const,
        };
      }
    }
    const provider = new RateLimitedOnce([option("a", "TR900", at(2), 100)]);
    const agent = new FlightAgent(provider, { fareDeadlineMs: 5_000 });
    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );
    expect(provider.attempts).toBe(2);
    expect(assessment.candidates.length).toBe(1);
    expect(assessment.noReplacementReason).toBeUndefined();
  }, 20000);

  it("keeps the flight at its LISTED price when the re-price is rate-limited", async () => {
    // The whole point of the fix. Atlas publishes a real price in the search
    // results; a rate-limited `verify.do` says "ask again later", not "this
    // flight is wrong". Dropping it was how a traveller got told no flight
    // existed while the provider was listing fifteen.
    class AlwaysRateLimited extends Provider {
      async calculateFareDifference(): Promise<never> {
        throw Object.assign(new Error("Atlas request to /verify.do failed with HTTP 429."), {
          name: "AtlasApiError",
          retryable: true,
        });
      }
    }
    const provider = new AlwaysRateLimited([option("a", "TR900", at(2), 275)]);
    const agent = new FlightAgent(provider, { fareDeadlineMs: 5_000 });
    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );

    expect(assessment.candidates.length).toBe(1);
    const fare = assessment.candidates[0]!.fareDifference;
    expect(fare.amount).toBe(275);
    // Flagged as UNCONFIRMED so the Trust Layer can say so — an unverified
    // number presented as a quote would be the dishonesty this codebase
    // exists to avoid.
    expect(fare.basis).toBe("search_reference");
  }, 20000);

  it("still drops a flight the provider rejected PERMANENTLY", async () => {
    // A permanent rejection is the provider telling us something real about
    // that flight; keeping it at a stale listed price would be inventing a
    // bookable option.
    class PermanentlyBad extends Provider {
      async calculateFareDifference(): Promise<never> {
        throw Object.assign(new Error("routing no longer available"), {
          name: "AtlasApiError",
          retryable: false,
        });
      }
    }
    const provider = new PermanentlyBad([option("a", "TR900", at(2), 275)]);
    const agent = new FlightAgent(provider, { fareDeadlineMs: 5_000 });
    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );
    expect(assessment.candidates).toEqual([]);
    expect(assessment.noReplacementReason).toBe("pricing_unavailable");
  }, 20000);

  it("does NOT retry a failure the provider called permanent", async () => {
    // Retrying a malformed routing or a rejected credential just burns the
    // deadline and delays the honest answer.
    class HardFail extends Provider {
      attempts = 0;
      async calculateFareDifference(): Promise<never> {
        this.attempts += 1;
        throw Object.assign(new Error("Atlas rejected the configured credentials."), {
          name: "AtlasApiError",
          retryable: false,
        });
      }
    }
    const provider = new HardFail([option("a", "TR900", at(2), 100)]);
    const agent = new FlightAgent(provider, { fareDeadlineMs: 5_000 });
    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );
    expect(provider.attempts).toBe(1);
    expect(assessment.noReplacementReason).toBe("pricing_unavailable");
    // And the reason is quoted, not swallowed — this was invisible before.
    expect(assessment.pricingFailureDetail).toContain("credentials");
  }, 20000);
});

describe("how LATE a replacement may be", () => {
  // Found on the first real user test, and it is the worst plan the swarm has
  // produced: a traveller whose trip began 23 Dec said "I missed my flight" and
  // was offered the SAME flight number FIVE DAYS LATER as the leading plan.
  //
  // It broke no rule, which is the point. The only two rules were "not the
  // flight you missed" and "leaves after it", and a flight five days out
  // satisfies both. Accepting it means writing off the days in between — on a
  // week-long holiday, writing off the holiday.
  //
  // `latestDeparture` is the missing half of the pair.

  const HOUR = 3_600_000;
  const at = (hours: number) =>
    new Date(Date.parse(ORIGINAL_DEPARTURE) + hours * HOUR).toISOString();

  const bounded: FlightRouteContext = {
    ...missedContext,
    latestDeparture: at(48),
  };

  it("rejects the five-days-later rebooking that started all this", async () => {
    const ids = await candidateIds(
      [
        option("same-day", "TR900", at(9)),
        option("five-days", "TR892", at(24 * 5)), // 27 Dec — what the user saw
      ],
      bounded,
    );
    expect(ids).toEqual(["same-day"]);
  });

  it("still accepts a next-day replacement — thin routes are real", async () => {
    // The bound is not "same day": a route with one flight a day must still be
    // rebookable, or the rule trades one useless answer for another.
    const ids = await candidateIds(
      [option("next-day", "TR900", at(26)), option("day-after", "TR901", at(47))],
      bounded,
    );
    expect(ids).toEqual(["next-day", "day-after"]);
  });

  it("takes the ceiling literally at its edge", async () => {
    const ids = await candidateIds(
      [option("just-inside", "TR900", at(47.9)), option("just-outside", "TR901", at(48.1))],
      bounded,
    );
    expect(ids).toEqual(["just-inside"]);
  });

  it("returns NOTHING rather than something absurd when only late options exist", async () => {
    // The honest outcome. "No rebooking works within two days" is a true and
    // useful answer; a proposal that silently cancels five days of holiday is
    // neither.
    const ids = await candidateIds(
      [option("too-late", "TR892", at(24 * 5)), option("way-too-late", "TR893", at(24 * 9))],
      bounded,
    );
    expect(ids).toEqual([]);
  });

  it("leaves price-shopping alone when no ceiling is given", async () => {
    // The ceiling belongs to a rebooking. A search with no `latestDeparture`
    // (browsing, flexible dates) keeps every option it finds.
    const ids = await candidateIds(
      [option("later", "TR892", at(24 * 5)), option("sooner", "TR900", at(9))],
      missedContext,
    );
    expect(ids).toContain("later");
    expect(ids).toContain("sooner");
  });
});

describe("rebooking candidates", () => {
  it("never offers the missed flight back as its own replacement", async () => {
    const ids = await candidateIds(
      [
        option("same", "TR892", ORIGINAL_DEPARTURE),
        option("later", "TR900", "2026-12-22T14:00:00Z"),
      ],
      missedContext,
    );
    expect(ids).not.toContain("same");
    expect(ids).toContain("later");
  });

  it("drops same-day departures earlier than the one that was missed", async () => {
    // That aircraft has gone, and so has every earlier one.
    const ids = await candidateIds(
      [
        option("earlier", "TR100", "2026-12-22T04:00:00Z"),
        option("later", "TR900", "2026-12-22T14:00:00Z"),
      ],
      missedContext,
    );
    expect(ids).toEqual(["later"]);
  });

  it("keeps a LATER departure of the same flight number", async () => {
    // TR892 flies daily; tomorrow's TR892 is a perfectly good replacement,
    // which is why the exclusion matches on departure instant too.
    const ids = await candidateIds(
      [option("tomorrow", "TR 892", "2026-12-23T06:10:00Z")],
      missedContext,
    );
    expect(ids).toEqual(["tomorrow"]);
  });

  it("leaves candidates untouched when no constraints are supplied", async () => {
    // Legacy callers (and id-based providers) keep their behaviour exactly.
    const ids = await candidateIds([
      option("same", "TR892", ORIGINAL_DEPARTURE),
      option("later", "TR900", "2026-12-22T14:00:00Z"),
    ]);
    expect(ids.sort()).toEqual(["later", "same"]);
  });
});
