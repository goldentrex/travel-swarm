/**
 * The connection check, pinned where it is cheapest to read.
 *
 * Before it existed, "my connection is too tight, I'll never make the second
 * flight" produced "Delayed flight SQ634" with a four-hour delay nobody had
 * mentioned and three activities cancelled — the identical plan the engine
 * gave for "the airline moved my flight to 6am". Two different problems, one
 * wrong answer.
 */

import { describe, expect, it } from "vitest";
import type { ItineraryNode } from "../../dag/types";
import {
  DEFAULT_CONNECTION_MINUTES,
  describeConnection,
  findConnections,
  isConnectionMission,
  judgeConnection,
  pickConnection,
} from "../connections";

const T = (iso: string) => Date.parse(iso);

function leg(
  id: string,
  flightNumber: string,
  origin: string,
  destination: string,
  depart: string,
  arrive: string,
  minConnectionMinutes?: number,
): ItineraryNode {
  return {
    id,
    type: "flight",
    flightNumber,
    origin,
    destination,
    departureTime: T(depart),
    arrivalTime: T(arrive),
    scheduledTime: T(depart),
    status: "on_track",
    dependsOn: [],
    ...(minConnectionMinutes !== undefined ? { minConnectionMinutes } : {}),
  };
}

/** SIN → CDG, change at CDG for CDG → LIS. Both legs cross a border. */
const tightAtCdg = [
  leg("f0", "SQ334", "SIN", "CDG", "2026-12-01T01:00:00Z", "2026-12-01T09:00:00Z"),
  leg("f1", "AF1024", "CDG", "LIS", "2026-12-01T09:50:00Z", "2026-12-01T11:40:00Z"),
];

describe("findConnections", () => {
  it("finds a change of plane at the same airport", () => {
    const [connection] = findConnections(tightAtCdg);
    expect(connection.atAirport).toBe("CDG");
    expect(connection.fromLabel).toBe("SQ334 SIN → CDG");
    expect(connection.toLabel).toBe("AF1024 CDG → LIS");
    expect(connection.gapMinutes).toBe(50);
  });

  it("is not fooled by two journeys from the same city", () => {
    // The traveller went into town: a hotel between the legs means they left
    // the airport, so this is not a connection. Read from the graph rather
    // than from an invented time window.
    const withStay: ItineraryNode[] = [
      tightAtCdg[0],
      {
        id: "hotel-0-0",
        type: "hotel_check_in",
        hotelName: "Hôtel Paris",
        scheduledTime: T("2026-12-01T15:00:00Z"),
        status: "on_track",
        dependsOn: [],
      },
      leg("f1", "AF1024", "CDG", "LIS", "2026-12-03T09:50:00Z", "2026-12-03T11:40:00Z"),
    ];
    expect(findConnections(withStay)).toHaveLength(0);
  });

  it("ignores legs that do not meet at the same airport", () => {
    const apart = [
      leg("f0", "SQ334", "SIN", "CDG", "2026-12-01T01:00:00Z", "2026-12-01T09:00:00Z"),
      leg("f1", "AF1024", "ORY", "LIS", "2026-12-01T12:00:00Z", "2026-12-01T14:00:00Z"),
    ];
    expect(findConnections(apart)).toHaveLength(0);
  });

  it("raises the floor when the change crosses a border", () => {
    // Singapore → Paris clears immigration at CDG, and `arrivalBuffer`
    // already publishes what that costs. The flat 45 would have called a
    // 50-minute gap comfortable.
    const [connection] = findConnections(tightAtCdg);
    expect(connection.crossesBorder).toBe(true);
    expect(connection.requiredMinutes).toBeGreaterThan(DEFAULT_CONNECTION_MINUTES);
  });

  it("honours a minimum the itinerary states for itself", () => {
    const stated = [
      tightAtCdg[0],
      leg("f1", "AF1024", "CDG", "LIS", "2026-12-01T09:50:00Z", "2026-12-01T11:40:00Z", 120),
    ];
    expect(findConnections(stated)[0].requiredMinutes).toBe(120);
  });
});

describe("judgeConnection", () => {
  it("calls a 50-minute international change short, and says by how much", () => {
    const [connection] = findConnections(tightAtCdg);
    const verdict = judgeConnection(connection);
    expect(verdict.kind).toBe("below_minimum");
    if (verdict.kind !== "below_minimum") return;
    expect(verdict.shortByMinutes).toBe(connection.requiredMinutes - 50);
  });

  it("clears a comfortable domestic change", () => {
    const domestic = [
      leg("f0", "AF6202", "NCE", "CDG", "2026-12-01T07:00:00Z", "2026-12-01T08:30:00Z"),
      leg("f1", "AF1024", "CDG", "ORY", "2026-12-01T11:00:00Z", "2026-12-01T11:40:00Z"),
    ];
    const [connection] = findConnections(domestic);
    const verdict = judgeConnection(connection);
    expect(verdict.kind).toBe("clears_minimum");
    if (verdict.kind !== "clears_minimum") return;
    expect(verdict.spareMinutes).toBe(150 - DEFAULT_CONNECTION_MINUTES);
  });
});

describe("describeConnection", () => {
  it("states the real times, the gap and the shortfall", () => {
    const [connection] = findConnections(tightAtCdg);
    const lines = describeConnection(connection, judgeConnection(connection));
    expect(lines[0]).toContain("lands 09:00");
    expect(lines[0]).toContain("leaves 09:50");
    expect(lines[0]).toContain("50 min");
    expect(lines[1]).toMatch(/short of/);
    expect(lines[1]).toMatch(/immigration/);
  });

  it("never lets 'clears the minimum' read as 'you will make it'", () => {
    // We hold no airport minimum connection times. A traveller who reads a
    // pass here as a promise has been misled by us, so the caveat is on every
    // verdict in both directions.
    const domestic = [
      leg("f0", "AF6202", "NCE", "CDG", "2026-12-01T07:00:00Z", "2026-12-01T08:30:00Z"),
      leg("f1", "AF1024", "CDG", "ORY", "2026-12-01T11:00:00Z", "2026-12-01T11:40:00Z"),
    ];
    const [connection] = findConnections(domestic);
    for (const verdict of [judgeConnection(connection)]) {
      const lines = describeConnection(connection, verdict);
      expect(lines.some((l) => l.includes("don't hold the official minimum"))).toBe(true);
    }
  });
});

describe("isConnectionMission", () => {
  it("recognises the question in the languages the app ships", () => {
    for (const text of [
      "my connection is too tight, I'll never make the second flight",
      "ma correspondance est trop juste",
      "mi conexión es muy justa",
      "mein Anschluss ist zu knapp",
      "I only have 40 minutes for the layover",
    ]) {
      expect(isConnectionMission(text)).toBe(true);
    }
  });

  it("leaves an ordinary missed flight alone", () => {
    expect(isConnectionMission("I missed my flight, reroute me")).toBe(false);
    expect(isConnectionMission("my hotel is overbooked")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A change of planes INSIDE one leg — the shape every one-stop ticket has.
// ───────────────────────────────────────────────────────────────────────────

function oneStop(
  id: string,
  flightNumber: string,
  origin: string,
  destination: string,
  hops: Array<[string, string, string, string, string]>,
  minConnectionMinutes?: number,
): ItineraryNode {
  const first = hops[0];
  const last = hops[hops.length - 1];
  return {
    id,
    type: "flight",
    flightNumber,
    origin,
    destination,
    departureTime: T(first[3]),
    arrivalTime: T(last[4]),
    scheduledTime: T(first[3]),
    status: "on_track",
    dependsOn: [],
    ...(minConnectionMinutes !== undefined ? { minConnectionMinutes } : {}),
    segments: hops.map(([reference, from, to, depart, arrive]) => ({
      reference,
      from,
      to,
      departureTime: T(depart),
      arrivalTime: T(arrive),
    })),
  };
}

/** The QA corpus trip #7 as generate-trip actually stored it: SIN → FCO via
 *  DOH out and back, one leg each way, two hops per leg. */
const viaDohaOut = oneStop("flight-0", "QR943", "SIN", "FCO", [
  ["QR943", "SIN", "DOH", "2026-12-03T20:30:00Z", "2026-12-03T23:30:00Z"],
  ["QR115", "DOH", "FCO", "2026-12-04T02:00:00Z", "2026-12-04T07:15:00Z"],
]);
const viaDohaBack = oneStop("flight-1", "QR132", "FCO", "SIN", [
  ["QR132", "FCO", "DOH", "2026-12-07T21:45:00Z", "2026-12-08T05:15:00Z"],
  ["QR946", "DOH", "SIN", "2026-12-08T08:15:00Z", "2026-12-08T18:30:00Z"],
]);

describe("findConnections — inside one ticket", () => {
  it("sees the change of planes a one-stop leg carries in its hops", () => {
    // Before this, a traveller on the most ordinary ticket there is was told
    // "we can't find a change of planes on this trip".
    const [connection] = findConnections([viaDohaOut]);
    expect(connection).toBeDefined();
    expect(connection.fromId).toBe("flight-0");
    expect(connection.toId).toBe("flight-0");
    expect(connection.hop).toBe(0);
    expect(connection.journey).toBe("SIN → FCO");
    expect(connection.atAirport).toBe("DOH");
    expect(connection.atAirportName).toBe("Doha");
    // Each hop is named by ITS OWN flight number, not the leg's headline one.
    expect(connection.fromLabel).toBe("QR943 SIN → DOH");
    expect(connection.toLabel).toBe("QR115 DOH → FCO");
    // 23:30 → 02:00 on the clock at Doha: 2 h 30.
    expect(connection.gapMinutes).toBe(150);
  });

  it("raises the floor for a hop that crosses a border, from the same table", () => {
    const [connection] = findConnections([viaDohaOut]);
    expect(connection.crossesBorder).toBe(true);
    // deplane 20 + border 45 — arrivalBuffer's own numbers, nothing new.
    expect(connection.requiredMinutes).toBe(65);
    expect(judgeConnection(connection)).toEqual({ kind: "clears_minimum", spareMinutes: 85 });
  });

  it("returns every change in the order the traveller meets them", () => {
    // A real trip has its stay between the two legs; without it the
    // structural rule would (rightly, by its own terms) pair the outbound
    // arrival at FCO with the return departure from FCO three days later.
    const stay: ItineraryNode = {
      id: "hotel-0-0",
      type: "hotel_check_in",
      hotelName: "Hotel Monti",
      scheduledTime: T("2026-12-04T15:00:00Z"),
      status: "on_track",
      dependsOn: [],
    };
    const found = findConnections([viaDohaBack, stay, viaDohaOut]);
    expect(found.map((c) => `${c.toId}#${c.hop}`)).toEqual(["flight-0#0", "flight-1#0"]);
  });

  it("reports both changes of a two-stop journey on the same node", () => {
    const twoStops = oneStop("flight-0", "TK55", "SIN", "LIS", [
      ["TK55", "SIN", "IST", "2026-12-03T20:30:00Z", "2026-12-04T03:00:00Z"],
      ["TK1863", "IST", "CDG", "2026-12-04T05:00:00Z", "2026-12-04T08:30:00Z"],
      ["AF1024", "CDG", "LIS", "2026-12-04T10:30:00Z", "2026-12-04T12:20:00Z"],
    ]);
    const found = findConnections([twoStops]);
    expect(found).toHaveLength(2);
    expect(found.map((c) => c.atAirport)).toEqual(["IST", "CDG"]);
    expect(found.every((c) => c.toId === "flight-0")).toBe(true);
    expect(found.map((c) => c.hop)).toEqual([0, 1]);
  });

  it("calls a 50-minute change short by the real amount", () => {
    const tight = oneStop("flight-0", "QR943", "SIN", "FCO", [
      ["QR943", "SIN", "DOH", "2026-12-03T20:30:00Z", "2026-12-03T23:30:00Z"],
      ["QR115", "DOH", "FCO", "2026-12-04T00:20:00Z", "2026-12-04T05:35:00Z"],
    ]);
    const [connection] = findConnections([tight]);
    expect(connection.gapMinutes).toBe(50);
    expect(judgeConnection(connection)).toEqual({ kind: "below_minimum", shortByMinutes: 15 });
  });

  it("ignores hops that do not chain — the facts are read, never assumed", () => {
    const broken = oneStop("flight-0", "QR943", "SIN", "FCO", [
      ["QR943", "SIN", "DOH", "2026-12-03T20:30:00Z", "2026-12-03T23:30:00Z"],
      ["EK97", "DXB", "FCO", "2026-12-04T02:00:00Z", "2026-12-04T07:15:00Z"],
    ]);
    expect(findConnections([broken])).toHaveLength(0);
  });

  it("does not double-count: a one-stop leg followed by a separate leg", () => {
    // Out via Doha on one ticket, then a separate FCO → LIS flight two days
    // later with a hotel in between: ONE connection (at DOH), not two.
    const onward = leg("flight-2", "TP841", "FCO", "LIS", "2026-12-06T10:00:00Z", "2026-12-06T12:10:00Z");
    const stay: ItineraryNode = {
      id: "hotel-0-0",
      type: "hotel_check_in",
      hotelName: "Hotel Monti",
      scheduledTime: T("2026-12-04T15:00:00Z"),
      status: "on_track",
      dependsOn: [],
    };
    const found = findConnections([viaDohaOut, stay, onward]);
    expect(found.map((c) => c.atAirport)).toEqual(["DOH"]);
  });
});

describe("pickConnection", () => {
  const both = findConnections([viaDohaOut, viaDohaBack]);
  const beforeTrip = T("2026-11-01T00:00:00Z");
  const betweenLegs = T("2026-12-05T12:00:00Z");

  it("takes the airport the traveller named, by code or by name", () => {
    // Change at Doha out, Istanbul back — "my connection in Istanbul" is
    // not a question about whichever comes first.
    const viaIstBack = oneStop("flight-1", "TK1862", "FCO", "SIN", [
      ["TK1862", "FCO", "IST", "2026-12-07T21:45:00Z", "2026-12-08T02:15:00Z"],
      ["TK54", "IST", "SIN", "2026-12-08T03:20:00Z", "2026-12-08T18:30:00Z"],
    ]);
    const mixed = findConnections([viaDohaOut, viaIstBack]);
    expect(pickConnection(mixed, { text: "my connection in Istanbul is too tight", nowMs: beforeTrip })?.atAirport).toBe("IST");
    expect(pickConnection(mixed, { text: "my IST connection is too tight", nowMs: beforeTrip })?.atAirport).toBe("IST");
    expect(pickConnection(mixed, { text: "ma correspondance à Doha est trop courte", nowMs: beforeTrip })?.atAirport).toBe("DOH");
    // Accents never decide it.
    expect(pickConnection(mixed, { text: "mi conexión en Estambul…", nowMs: beforeTrip })?.atAirport).toBe("DOH");
  });

  it("with the same airport out and back, takes the change still ahead", () => {
    expect(pickConnection(both, { text: "my connection at Doha", nowMs: beforeTrip })?.toId).toBe("flight-0");
    expect(pickConnection(both, { text: "my connection at Doha", nowMs: betweenLegs })?.toId).toBe("flight-1");
  });

  it("then the leg the mission targets, then the next change ahead, then the first", () => {
    expect(pickConnection(both, { nodeId: "flight-1", nowMs: beforeTrip })?.toId).toBe("flight-1");
    expect(pickConnection(both, { nowMs: beforeTrip })?.toId).toBe("flight-0");
    expect(pickConnection(both, { nowMs: betweenLegs })?.toId).toBe("flight-1");
    expect(pickConnection(both, { nowMs: T("2027-01-01T00:00:00Z") })?.toId).toBe("flight-0");
    expect(pickConnection([], { nowMs: beforeTrip })).toBeUndefined();
  });

  it("never lets a three-letter code match inside a word", () => {
    // "doha" is not "dohányi"; "ist" is not "distance".
    expect(pickConnection(both, { text: "the distance is fine, my connection is too tight", nowMs: betweenLegs })?.toId).toBe("flight-1");
  });
});

describe("describeConnection — inside one ticket", () => {
  it("names the journey, hedges the border check, and says whose problem a miss is", () => {
    const [connection] = findConnections([viaDohaOut]);
    const lines = describeConnection(connection, judgeConnection(connection));
    expect(lines[0]).toBe(
      "QR943 SIN → DOH lands 23:30; QR115 DOH → FCO leaves 02:00 — 2 h 30 at Doha (DOH), on your SIN → FCO journey.",
    );
    // Airside at a hub the traveller may clear nothing at all: the floor is
    // kept, the sentence does not claim immigration will happen.
    expect(lines[1]).toContain("clears the 1 h 05 this itinerary allows");
    expect(lines[1]).toContain("passport and security checks allowed for");
    expect(lines[1]).toContain("1 h 25 to spare");
    expect(lines[1]).not.toMatch(/immigration/);
    expect(lines[2]).toMatch(/one ticket/);
    expect(lines[2]).toMatch(/airline's to fix/);
    expect(lines[lines.length - 1]).toMatch(/don't hold the official minimum/);
  });

  it("keeps the immigration wording for two separate legs, where it is certain", () => {
    const [connection] = findConnections(tightAtCdg);
    const lines = describeConnection(connection, judgeConnection(connection));
    expect(lines[0]).not.toMatch(/journey/);
    expect(lines[1]).toMatch(/includes clearing immigration/);
    expect(lines.join(" ")).not.toMatch(/one ticket/);
  });
});
