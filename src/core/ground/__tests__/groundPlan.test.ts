/**
 * The ground layer's contract, pinned where it is cheapest to check.
 *
 * These cover the two failures the live battery of 2026-09-18 exposed —
 * "Transit strike tomorrow" producing nothing at all, and "My taxi to the
 * airport is cancelled" producing a rescheduled duty-free stop — plus the
 * rule that keeps the fix honest: nothing is said about a journey whose ends
 * the trip does not actually pin down.
 */

import { describe, expect, it } from "vitest";
import type { ItineraryNode } from "../../dag/types";
import {
  groundHeadline,
  isGroundMission,
  modesWorthAsking,
  namesAirport,
  nextGroundCommitment,
} from "../groundPlan";
import {
  describeGround,
  humanDuration,
  latestDeparture,
  viableOptions,
  type GroundOption,
} from "../groundLink";

const NOW = Date.parse("2026-09-18T06:00:00Z");
const h = (hours: number) => NOW + hours * 3_600_000;

/** A hotel in central Kyoto and a flight out of Kansai. */
function kyotoTrip(overrides: Partial<Record<string, unknown>> = {}): ItineraryNode[] {
  void overrides;
  return [
    {
      id: "hotel-0-0",
      type: "hotel_check_in",
      hotelName: "Kyoto Granvia",
      scheduledTime: h(-14),
      status: "on_track",
      dependsOn: [],
      coordinates: { lat: 34.9858, lng: 135.7588 },
    },
    {
      id: "flight-1",
      type: "flight",
      flightNumber: "NH 175",
      origin: "KIX",
      destination: "HND",
      departureTime: h(8),
      arrivalTime: h(9.5),
      scheduledTime: h(8),
      status: "on_track",
      dependsOn: [],
    },
  ];
}

describe("nextGroundCommitment", () => {
  it("names the airport run: from where they sleep to the airport they fly from", () => {
    const commitment = nextGroundCommitment(kyotoTrip(), NOW);
    expect(commitment).not.toBeNull();
    expect(commitment!.fromLabel).toBe("Kyoto Granvia");
    expect(commitment!.toLabel).toContain("KIX");
    expect(commitment!.arriveByMs).toBe(h(8));
    expect(commitment!.deadlineLabel).toContain("NH 175");
    // A 90-minute hop is short-haul: the two-hour floor, not the three-hour one.
    expect(commitment!.bufferMinutes).toBe(120);
    expect(commitment!.deadlineNodeId).toBe("flight-1");
  });

  it("uses the long-haul floor for a long leg", () => {
    const nodes = kyotoTrip();
    (nodes[1] as { arrivalTime: number }).arrivalTime = h(8 + 11);
    expect(nextGroundCommitment(nodes, NOW)!.bufferMinutes).toBe(180);
  });

  it("says nothing when the trip cannot place the traveller on the map", () => {
    // A hotel with no coordinates is not a starting point we may describe.
    const nodes = kyotoTrip();
    delete (nodes[0] as { coordinates?: unknown }).coordinates;
    expect(nextGroundCommitment(nodes, NOW)).toBeNull();
  });

  it("says nothing about an airport outside the reference table", () => {
    const nodes = kyotoTrip();
    (nodes[1] as { origin: string }).origin = "ZZZ";
    expect(nextGroundCommitment(nodes, NOW)).toBeNull();
  });

  it("skips a flight it cannot place and answers about the one it can", () => {
    // The OUTBOUND leg has nothing placeable before it — we do not know where
    // the traveller lives. Stopping at the first flight gave up on the return
    // run, which starts from a hotel we know exactly.
    const nodes: ItineraryNode[] = [
      {
        id: "flight-out",
        type: "flight",
        flightNumber: "AZ 317",
        origin: "CDG",
        destination: "FCO",
        departureTime: h(2),
        arrivalTime: h(4),
        scheduledTime: h(2),
        status: "on_track",
        dependsOn: [],
      },
      {
        id: "hotel-0-0",
        type: "hotel_check_in",
        hotelName: "Hotel Campo de' Fiori",
        scheduledTime: h(6),
        status: "on_track",
        dependsOn: [],
        coordinates: { lat: 41.8955, lng: 12.4723 },
      },
      {
        id: "flight-back",
        type: "flight",
        flightNumber: "AZ 318",
        origin: "FCO",
        destination: "CDG",
        departureTime: h(80),
        arrivalTime: h(82),
        scheduledTime: h(80),
        status: "on_track",
        dependsOn: [],
      },
    ];
    const commitment = nextGroundCommitment(nodes, NOW);
    expect(commitment!.deadlineNodeId).toBe("flight-back");
    expect(commitment!.fromLabel).toBe("Hotel Campo de' Fiori");
    expect(commitment!.toLabel).toContain("FCO");
  });

  it("answers about the airport when the traveller said airport, not the train", () => {
    // On a trip that HAS a ground leg the mission parser targets it, so "my
    // taxi to the airport is cancelled" would have been answered with the
    // Tokyo→Osaka journey. What the traveller said wins.
    const nodes: ItineraryNode[] = [
      ...kyotoTrip(),
      {
        id: "transfer-2",
        type: "transfer",
        durationMinutes: 150,
        scheduledTime: h(2),
        status: "on_track",
        dependsOn: [],
        from: { lat: 35.6812, lng: 139.7671 },
        to: { lat: 34.7025, lng: 135.4959 },
        fromLabel: "TYO",
        toLabel: "OSK",
      },
    ];
    // Without the airport in the question, the broken leg is the answer.
    expect(
      nextGroundCommitment(nodes, NOW, { disruptedNodeId: "transfer-2" })!.toLabel,
    ).toBe("OSK");
    // With it, the airport run is.
    const airport = nextGroundCommitment(nodes, NOW, {
      disruptedNodeId: "transfer-2",
      mustBeAirportRun: true,
    });
    expect(airport!.toLabel).toContain("KIX");
  });

  it("says nothing rather than answering about a different journey", () => {
    // Live on 2026-09-18, "My taxi to the airport is cancelled" was answered
    // with the walk from the hotel to a lunch reservation — real durations,
    // for a question nobody asked.
    const nodes: ItineraryNode[] = [
      {
        id: "hotel-0-0",
        type: "hotel_check_in",
        hotelName: "Hotel Campo de' Fiori",
        scheduledTime: h(-2),
        status: "on_track",
        dependsOn: [],
        coordinates: { lat: 41.8955, lng: 12.4723 },
      },
      {
        id: "activity-0-1",
        type: "activity",
        name: "Da Fortunato al Pantheon",
        durationMinutes: 90,
        scheduledTime: h(1),
        status: "on_track",
        dependsOn: [],
        coordinates: { lat: 41.8992, lng: 12.4768 },
      },
    ];
    expect(nextGroundCommitment(nodes, NOW, { mustBeAirportRun: true })).toBeNull();
    // Without the airport in the question, the lunch run is a fair answer.
    expect(nextGroundCommitment(nodes, NOW)).not.toBeNull();
  });

  it("falls back to the next placeable activity when no flight is ahead", () => {
    const nodes: ItineraryNode[] = [
      {
        id: "hotel-0-0",
        type: "hotel_check_in",
        hotelName: "Hotel Trastevere",
        scheduledTime: h(-14),
        status: "on_track",
        dependsOn: [],
        coordinates: { lat: 41.8892, lng: 12.4696 },
      },
      {
        id: "activity-1-0",
        type: "activity",
        name: "Colosseum guided tour",
        durationMinutes: 120,
        scheduledTime: h(4),
        status: "on_track",
        dependsOn: [],
        coordinates: { lat: 41.8902, lng: 12.4922 },
      },
    ];
    const commitment = nextGroundCommitment(nodes, NOW);
    expect(commitment!.toLabel).toBe("Colosseum guided tour");
    expect(commitment!.bufferMinutes).toBe(0);
  });

  it("still answers for a trip that has not started yet", () => {
    // An earlier 36-hour horizon refused every future trip, which is most of
    // them: the traveller asking about a ride three weeks out gets the same
    // real answer as the one asking about tonight.
    const nodes = kyotoTrip();
    (nodes[1] as { scheduledTime: number }).scheduledTime = h(24 * 21);
    (nodes[1] as { departureTime: number }).departureTime = h(24 * 21);
    (nodes[1] as { arrivalTime: number }).arrivalTime = h(24 * 21 + 1.5);
    expect(nextGroundCommitment(nodes, NOW)).not.toBeNull();
  });

  it("ignores a commitment that has already passed", () => {
    const nodes = kyotoTrip();
    (nodes[1] as { scheduledTime: number }).scheduledTime = h(-2);
    (nodes[1] as { departureTime: number }).departureTime = h(-2);
    expect(nextGroundCommitment(nodes, NOW)).toBeNull();
  });
});

describe("modesWorthAsking", () => {
  it("stops paying to be told a 500 km walk is long", () => {
    // A Tokyo → Osaka strike printed "On foot: 112 h 52 — too far to be
    // realistic" beside the answer that mattered, and spent a billed request
    // to produce it.
    const far = nextGroundCommitment(kyotoTrip(), NOW)!;
    expect(modesWorthAsking(far)).toEqual(["DRIVE", "TRANSIT"]);
  });

  it("still asks about walking across a city", () => {
    const nodes: ItineraryNode[] = [
      {
        id: "hotel-0-0",
        type: "hotel_check_in",
        hotelName: "Hotel Trastevere",
        scheduledTime: h(-14),
        status: "on_track",
        dependsOn: [],
        coordinates: { lat: 41.8892, lng: 12.4696 },
      },
      {
        id: "activity-1-0",
        type: "activity",
        name: "Colosseum guided tour",
        durationMinutes: 120,
        scheduledTime: h(4),
        status: "on_track",
        dependsOn: [],
        coordinates: { lat: 41.8902, lng: 12.4922 },
      },
    ];
    expect(modesWorthAsking(nextGroundCommitment(nodes, NOW)!)).toContain("WALK");
  });
});

describe("groundHeadline", () => {
  it("states what happened instead of repeating the question", () => {
    // Photographed at accessibility text size on 2026-09-18: "Getting around:
    // My taxi to the airport is cancelled, what do I do" filled six bold
    // lines and pushed the answer entirely below the fold.
    expect(groundHeadline("My taxi to the airport is cancelled, what do I do"))
      .toBe("Your ride to the airport is gone");
    expect(groundHeadline("my transfer was cancelled")).toBe("Your ride is gone");
  });

  it("produces a headline that still passes its own gates", () => {
    // Every check downstream reads this same string, so the words that
    // classify the mission have to survive the rewrite.
    for (const text of ["My taxi to the airport is cancelled", "my transfer was cancelled"]) {
      const headline = groundHeadline(text);
      expect(isGroundMission(headline)).toBe(true);
      expect(namesAirport(headline)).toBe(namesAirport(text));
    }
  });
});

describe("namesAirport", () => {
  it("recognises the word in the languages the app ships", () => {
    expect(namesAirport("My taxi to the airport is cancelled")).toBe(true);
    expect(namesAirport("mon taxi pour l'aéroport est annulé")).toBe(true);
    expect(namesAirport("Transit strike tomorrow")).toBe(false);
  });
});

describe("isGroundMission", () => {
  it("catches the two missions that had no answer at all", () => {
    expect(isGroundMission("My taxi to the airport is cancelled, what do I do")).toBe(true);
    expect(isGroundMission("Transit strike tomorrow")).toBe(true);
  });

  it("works in the languages the app ships", () => {
    expect(isGroundMission("mon taxi est annulé")).toBe(true);
    expect(isGroundMission("hay huelga de metro")).toBe(true);
  });

  it("never claims a mission where the FLIGHT is what broke", () => {
    // Otherwise a ground mission stands the flight rail down, and the
    // traveller is told how to reach an airport for a plane that is not going
    // anywhere.
    expect(isGroundMission("my flight is cancelled because of an ATC strike")).toBe(false);
    expect(isGroundMission("a strike has cancelled my flight")).toBe(false);
    expect(isGroundMission("mon vol est annulé à cause d'une grève")).toBe(false);
    // But a ride to the airport is still a ride, not a flight problem.
    expect(isGroundMission("My taxi to the airport is cancelled")).toBe(true);
  });

  it("leaves ordinary rescheduling missions alone", () => {
    // Narrow on purpose: every match spends a paid Routes lookup.
    expect(isGroundMission("My activity got cancelled")).toBe(false);
    expect(isGroundMission("I'm feeling unwell, lighten my day")).toBe(false);
    expect(isGroundMission("Heavy rain forecast tomorrow")).toBe(false);
    // Naming a mode without a failure is not an emergency.
    expect(isGroundMission("book me a train to Osaka")).toBe(false);
  });
});

describe("reading the provider's answer", () => {
  const options: GroundOption[] = [
    { mode: "drive", available: true, seconds: 4_320, distanceMeters: 62_000 },
    { mode: "transit", available: false, seconds: null, distanceMeters: null, reason: "not_priced" },
    { mode: "walk", available: false, seconds: 50_000, distanceMeters: 62_000, reason: "too_far_to_walk" },
  ];

  it("orders what is actually possible, quickest first", () => {
    expect(viableOptions(options).map((o) => o.mode)).toEqual(["drive"]);
  });

  it("works backwards from the deadline, never rounding in the traveller's favour", () => {
    const arriveBy = Date.parse("2026-09-18T17:05:00Z");
    // 4320s = 1h12m of driving, plus a 2h airport floor.
    const leave = latestDeparture(arriveBy, 4_320, 120);
    expect(new Date(leave).toISOString().slice(11, 16)).toBe("13:53");
    expect(leave).toBeLessThanOrEqual(arriveBy - 4_320_000 - 120 * 60_000);
  });

  it("reads durations the way a person says them", () => {
    expect(humanDuration(4_320)).toBe("1 h 12");
    expect(humanDuration(2_880)).toBe("48 min");
    expect(humanDuration(7_200)).toBe("2 h");
  });

  it("states a closed mode only when it has a real measurement for it", () => {
    const lines = describeGround(options, Date.parse("2026-09-18T17:05:00Z"), 120);
    expect(lines[0]).toContain("Car or taxi: about 1 h 12");
    expect(lines[0]).toContain("set off by 13:53");
    expect(lines.some((l) => l.includes("too far"))).toBe(true);
  });

  it("NEVER tells a traveller there is no transit service", () => {
    // Verified live on 2026-09-18: Google Routes returns no transit route for
    // Tokyo Station → Shibuya — a train every two minutes — because its
    // transit licensing does not cover Japan. An empty answer is the absence
    // of an answer, and saying "no service on this route right now" would be
    // confidently wrong in every Japanese city the app supports.
    const lines = describeGround([
      { mode: "transit", available: false, seconds: null, distanceMeters: null, reason: "not_priced" },
    ]);
    expect(lines).toEqual([]);
  });

  it("stays silent about a mode that simply could not be priced", () => {
    // "We failed to reach the provider" is not something a traveller can act
    // on, and printing it as a bullet makes an outage look like a road closure.
    const lines = describeGround([
      { mode: "drive", available: false, seconds: null, distanceMeters: null },
    ]);
    expect(lines).toEqual([]);
  });

  it("describes the ground without a deadline when there is nothing to catch", () => {
    const lines = describeGround([
      { mode: "transit", available: true, seconds: 1_800, distanceMeters: 8_000 },
    ]);
    expect(lines).toEqual(["Public transport: best route we found takes about 30 min"]);
  });

  it("does not present a transit duration with the confidence of a drive", () => {
    // Verified 2026-09-18: central Rome → Fiumicino comes back at about 2 h 58
    // at every hour, because the provider does not route over the airport
    // express that does it in under an hour. The number is a real journey it
    // found, not proof that no faster one exists — and stated flatly it pushes
    // a traveller into a taxi they may not need.
    const lines = describeGround([
      { mode: "drive", available: true, seconds: 3_240, distanceMeters: 26_000 },
      { mode: "transit", available: true, seconds: 10_680, distanceMeters: 30_000 },
    ]);
    expect(lines[0]).toBe("Car or taxi: about 54 min");
    expect(lines[1]).toContain("best route we found");
  });
});
