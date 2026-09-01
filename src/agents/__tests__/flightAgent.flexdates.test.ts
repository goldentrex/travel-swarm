/**
 * Flexible-date search window (Atlas contract): `search.do` prices ONE
 * calendar date per call, so flexible dates are agent-side orchestration —
 * when a routeContext is present the FlightAgent runs ONE complete provider
 * search per calendar date over its configured window, merging results and
 * stopping early once enough usable replacements surface.
 *
 * Root cause behind these tests: the missed SIN → CTS daily flight's ONLY
 * same-day routing is the missed flight itself (correctly rejected), so a
 * single-date search produced zero candidates and one flight-less plan. The
 * real alternatives live on the NEXT days.
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
const DAY_MS = 86_400_000;

function option(
  id: string,
  flightNumber: string,
  departureTime: string,
  price = 400,
): FlightOption {
  const arrival = new Date(Date.parse(departureTime) + 7 * 60 * 60 * 1000).toISOString();
  return {
    id,
    airline: "Scoot",
    flightNumber,
    origin: "SIN",
    destination: "CTS",
    departureTime,
    arrivalTime: arrival,
    price,
    currency: "USD",
  };
}

/** Options keyed by the yyyy-mm-dd date of the dated routeContext received. */
type DateFeed = (departureDate: string) => FlightOption[];

/** Provider fake recording every dated departureDate it was searched with. */
class DatedProvider implements FlightProvider {
  readonly providerName = "fake";
  readonly searchedDepartureDates: (string | undefined)[] = [];

  constructor(
    private readonly optionsFor: DateFeed,
    private readonly failingDates: ReadonlySet<string> = new Set(),
  ) {}

  async searchAlternativeFlights(
    flightId: string,
    requestedTime: IsoTimestamp,
    routeContext?: FlightRouteContext,
  ): Promise<AlternativeFlightsResult> {
    this.searchedDepartureDates.push(routeContext?.departureDate);
    const day = (routeContext?.departureDate ?? "").slice(0, 10);
    if (this.failingDates.has(day)) {
      throw new Error(`sandbox refused to search ${day}`);
    }
    return { referenceFlightId: flightId, requestedTime, options: this.optionsFor(day) };
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
  departureDate: ORIGINAL_DEPARTURE,
  excludeFlight: { flightNumber: "TR892", departureTime: ORIGINAL_DEPARTURE },
  earliestDeparture: ORIGINAL_DEPARTURE,
};

/** The day-N date string (yyyy-mm-dd, UTC) anchored on the missed flight. */
function day(n: number): string {
  return new Date(Date.parse(ORIGINAL_DEPARTURE) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The day-N departure instant for option fixtures. */
function instant(n: number): string {
  return new Date(Date.parse(ORIGINAL_DEPARTURE) + n * DAY_MS).toISOString();
}

describe("FlightAgent flexible-date window", () => {
  it("finds next-day replacements when day-0 only sells the missed flight", async () => {
    // The Atlas sandbox has ONE SIN → CTS routing per day: day 0 is the very
    // flight that was missed (excluded), the real alternatives are day +1/+2.
    const provider = new DatedProvider((date) => {
      switch (date) {
        case day(0):
          return [option("missed", "TR892", ORIGINAL_DEPARTURE)];
        case day(1):
          return [option("next-day", "TR901", instant(1), 420)];
        case day(2):
          // A duplicate id on a later date proves first-occurrence dedup.
          return [
            option("day-after", "TR902", instant(2), 440),
            option("next-day", "TR901", instant(2), 999),
          ];
        default:
          return [];
      }
    });
    const agent = new FlightAgent(provider);

    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );

    const ids = assessment.candidates.map((c) => c.option.id);
    expect(ids).not.toContain("missed");
    expect(ids).toContain("next-day");
    expect(ids).toContain("day-after");
    // Dedup keeps the FIRST occurrence (the day-1 pricing, not the day-2 dupe).
    expect(ids.filter((id) => id === "next-day")).toHaveLength(1);
    expect(assessment.candidates.find((c) => c.option.id === "next-day")?.option.price).toBe(420);
    // Every date of the default window was attempted (never 3 usable ⇒ no
    // early stop) and recorded in order.
    expect(provider.searchedDepartureDates.map((d) => d?.slice(0, 10))).toEqual([
      day(0),
      day(1),
      day(2),
      day(3),
    ]);
    expect(assessment.searchedDates).toEqual([day(0), day(1), day(2), day(3)]);
  });

  it("stops early once day-0 already yields ≥3 usable replacements", async () => {
    const provider = new DatedProvider((date) =>
      date === day(0)
        ? [
            option("alt-1", "TR901", "2026-12-22T09:00:00Z"),
            option("alt-2", "TR902", "2026-12-22T12:00:00Z"),
            option("alt-3", "TR903", "2026-12-22T15:00:00Z"),
          ]
        : [option(`late-${date}`, "TR909", `${date}T06:10:00Z`)],
    );
    const agent = new FlightAgent(provider, { searchWindowDays: 5 });

    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );

    // Exactly ONE provider call — the window closed after the first date.
    expect(provider.searchedDepartureDates).toHaveLength(1);
    expect(assessment.searchedDates).toEqual([day(0)]);
    expect(assessment.candidates.map((c) => c.option.id).sort()).toEqual([
      "alt-1",
      "alt-2",
      "alt-3",
    ]);
  });

  it("keeps the legacy single search (and omits searchedDates) without a routeContext", async () => {
    const provider = new DatedProvider(() => [option("any", "TR900", "2026-12-22T14:00:00Z")]);
    const agent = new FlightAgent(provider);

    const assessment = await agent.assessRebookingOptions("flight-0", ORIGINAL_DEPARTURE);

    expect(provider.searchedDepartureDates).toHaveLength(1);
    expect(assessment.candidates.map((c) => c.option.id)).toEqual(["any"]);
    expect("searchedDates" in assessment).toBe(false);
  });

  it("tolerates a rejecting date — per-date failure never sinks the search", async () => {
    const provider = new DatedProvider(
      (date) => (date === day(1) ? [option("next-day", "TR901", instant(1))] : []),
      new Set([day(0)]), // day 0 throws; day 1 succeeds
    );
    const agent = new FlightAgent(provider, { searchWindowDays: 3 });

    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );

    // Both dates were attempted; the throwing day is recorded AND skipped.
    expect(assessment.searchedDates).toEqual([day(0), day(1), day(2)]);
    expect(assessment.candidates.map((c) => c.option.id)).toEqual(["next-day"]);
    expect(assessment.bestCandidate?.option.id).toBe("next-day");
  });

  it("re-throws when EVERY date rejects — the callers' degrade contract survives", async () => {
    // Total failure is NOT a per-date failure: the search itself is
    // unavailable, and silently returning an empty assessment would
    // masquerade as "found nothing" instead of "provider down".
    const provider = new DatedProvider(() => [], new Set([day(0), day(1)]));
    const agent = new FlightAgent(provider, { searchWindowDays: 2 });

    await expect(
      agent.assessRebookingOptions("flight-0", ORIGINAL_DEPARTURE, missedContext),
    ).rejects.toThrow(/sandbox refused to search/);
  });

  // --------------------------------------------------------- W1 config knobs

  it("earlyStopUsableCount override closes the window at the new threshold", async () => {
    // Day 0 yields 2 usable replacements: with the override the window
    // closes after the FIRST date; with the library default (3) it would
    // have searched on.
    const twoUsable = (date: string) =>
      date === day(0)
        ? [
            option("alt-1", "TR901", "2026-12-22T09:00:00Z"),
            option("alt-2", "TR902", "2026-12-22T12:00:00Z"),
          ]
        : [];
    const tight = new DatedProvider(twoUsable);
    const agentTight = new FlightAgent(tight, { earlyStopUsableCount: 2 });
    const tightAssessment = await agentTight.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );
    expect(tight.searchedDepartureDates).toHaveLength(1);
    expect(tightAssessment.searchedDates).toEqual([day(0)]);

    const loose = new DatedProvider(twoUsable);
    const agentLoose = new FlightAgent(loose, { earlyStopUsableCount: 5 });
    await agentLoose.assessRebookingOptions("flight-0", ORIGINAL_DEPARTURE, missedContext);
    // Never 5 usable ⇒ the whole default 4-day window was searched.
    expect(loose.searchedDepartureDates.map((d) => d?.slice(0, 10))).toEqual([
      day(0),
      day(1),
      day(2),
      day(3),
    ]);
  });

  it("earlyStopUsableCount below 1 falls back to the library default (3)", async () => {
    // Day 0 yields 3 usable: the invalid override must behave exactly like
    // the default — the window closes after the first date.
    const provider = new DatedProvider((date) =>
      date === day(0)
        ? [
            option("alt-1", "TR901", "2026-12-22T09:00:00Z"),
            option("alt-2", "TR902", "2026-12-22T12:00:00Z"),
            option("alt-3", "TR903", "2026-12-22T15:00:00Z"),
          ]
        : [],
    );
    const agent = new FlightAgent(provider, { earlyStopUsableCount: 0 });
    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );
    expect(provider.searchedDepartureDates).toHaveLength(1);
    expect(assessment.searchedDates).toEqual([day(0)]);
  });

  it("overallDeadlineMs truncates the window before further dates, returning best-so-far", async () => {
    // A slow day-0 search burns the whole budget; the loop must then break
    // BEFORE date 1 and return the merged day-0 options (never nothing).
    const slowMs = 30;
    class SlowProvider extends DatedProvider {
      override async searchAlternativeFlights(
        flightId: string,
        requestedTime: IsoTimestamp,
        routeContext?: FlightRouteContext,
      ): Promise<AlternativeFlightsResult> {
        await new Promise((resolve) => setTimeout(resolve, slowMs));
        return super.searchAlternativeFlights(flightId, requestedTime, routeContext);
      }
    }
    const provider = new SlowProvider((date) =>
      date === day(0)
        ? [option("day-zero", "TR901", "2026-12-22T09:00:00Z")]
        : [option(`late-${date}`, "TR909", `${date}T06:10:00Z`)],
    );
    const agent = new FlightAgent(provider, { overallDeadlineMs: 20 });

    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );

    // Only the first date ran; best-so-far still carries its candidate.
    expect(provider.searchedDepartureDates).toHaveLength(1);
    expect(assessment.searchedDates).toEqual([day(0)]);
    expect(assessment.candidates.map((c) => c.option.id)).toEqual(["day-zero"]);
    expect(assessment.bestCandidate?.option.id).toBe("day-zero");
  });

  it("a generous overallDeadlineMs lets the whole window run", async () => {
    const provider = new DatedProvider(() => []);
    const agent = new FlightAgent(provider, { overallDeadlineMs: 60_000 });
    const assessment = await agent.assessRebookingOptions(
      "flight-0",
      ORIGINAL_DEPARTURE,
      missedContext,
    );
    expect(provider.searchedDepartureDates.map((d) => d?.slice(0, 10))).toEqual([
      day(0),
      day(1),
      day(2),
      day(3),
    ]);
    expect(assessment.searchedDates).toEqual([day(0), day(1), day(2), day(3)]);
  });
});
