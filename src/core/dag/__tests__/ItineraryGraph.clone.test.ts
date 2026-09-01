/**
 * Clone-independence tests for ItineraryGraph.clone() (Task 19 foundations).
 *
 * clone() is the orchestrator's re-drive seam: it must hand back a
 * deep-enough snapshot that either side can be mutated — including a full
 * disruption-style propagation — without ever leaking into the other side.
 * Covers: value fidelity, node-object isolation, dependsOn array isolation,
 * edge-set isolation, and atomic propagation on the clone leaving the
 * original untouched (both directions).
 */

import { describe, expect, it } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import type { ActivityNode, FlightNode, HotelCheckInNode, TransferNode } from "@/core/dag";

const MINUTE_MS = 60_000;
// Fixed epoch anchor (2026-08-22 09:00 UTC) — deterministic test times.
const BASE = Date.UTC(2026, 7, 22, 9, 0, 0);

const FLIGHT_ID = "flight-xy123";
const TRANSFER_ID = "transfer-airport";
const HOTEL_ID = "hotel-checkin";
const ACTIVITY_ID = "activity-museum";

/**
 * A four-node chain tight enough that a 45-min flight delay cascades through
 * EVERY node type: flight → transfer (conflict) → hotel (updated) →
 * activity (requires_rescheduling).
 * - flight XY123 CDG → LIS, 09:00 → 11:30
 * - transfer pickup 12:15 (45 min slack), 30 min ride
 * - hotel check-in 12:30
 * - activity 14:00, 60 min
 */
function buildGraph(): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: FLIGHT_ID,
    type: "flight",
    flightNumber: "XY123",
    origin: "CDG",
    destination: "LIS",
    departureTime: BASE,
    arrivalTime: BASE + 150 * MINUTE_MS,
    scheduledTime: BASE,
    status: "on_track",
    dependsOn: [],
    arrivalLocationId: "LIS",
  });
  graph.addNode({
    id: TRANSFER_ID,
    type: "transfer",
    durationMinutes: 30,
    scheduledTime: BASE + 195 * MINUTE_MS, // 12:15
    status: "on_track",
    dependsOn: [FLIGHT_ID],
    pickupLocationId: "LIS",
  });
  graph.addNode({
    id: HOTEL_ID,
    type: "hotel_check_in",
    hotelName: "Atlantica Surf House",
    scheduledTime: BASE + 210 * MINUTE_MS, // 12:30
    status: "on_track",
    dependsOn: [TRANSFER_ID],
  });
  graph.addNode({
    id: ACTIVITY_ID,
    type: "activity",
    name: "Ocean Museum Visit",
    durationMinutes: 60,
    scheduledTime: BASE + 300 * MINUTE_MS, // 14:00
    status: "on_track",
    dependsOn: [HOTEL_ID],
  });
  return graph;
}

/** Full serialized snapshot of every node — the "unchanged" oracle. */
function snapshot(graph: ItineraryGraph): string {
  return JSON.stringify(graph.getNodes());
}

describe("ItineraryGraph.clone — independence", () => {
  it("reproduces every node with identical values, statuses and edges", () => {
    const original = buildGraph();
    const clone = original.clone();

    expect(clone.getNodes().map((n) => n.id)).toEqual([
      FLIGHT_ID,
      TRANSFER_ID,
      HOTEL_ID,
      ACTIVITY_ID,
    ]);
    expect(snapshot(clone)).toBe(snapshot(original));
    // Downstream topology survives the rebuild too.
    expect(clone.getDownstream(FLIGHT_ID).map((n) => n.id)).toEqual([
      TRANSFER_ID,
      HOTEL_ID,
      ACTIVITY_ID,
    ]);
    expect(clone.getNode(TRANSFER_ID)?.dependsOn).toEqual([FLIGHT_ID]);
  });

  it("hands out isolated node objects: mutating clone fields never touches the original", () => {
    const original = buildGraph();
    const clone = original.clone();

    // Direct field mutation through the clone's live node handles.
    (clone.getNode(ACTIVITY_ID) as ActivityNode).status = "conflict";
    (clone.getNode(HOTEL_ID) as HotelCheckInNode).scheduledTime += 90 * MINUTE_MS;
    (clone.getNode(TRANSFER_ID) as TransferNode).durationMinutes = 99;

    const untouched = original.getNodes();
    expect(untouched.every((node) => node.status === "on_track")).toBe(true);
    expect(original.getNode(HOTEL_ID)?.scheduledTime).toBe(BASE + 210 * MINUTE_MS);
    const originalTransfer = original.getNode(TRANSFER_ID) as TransferNode;
    expect(originalTransfer.durationMinutes).toBe(30);
  });

  it("copies dependsOn arrays by value — the clone and original share no array references", () => {
    const original = buildGraph();
    const clone = original.clone();

    for (const id of [FLIGHT_ID, TRANSFER_ID, HOTEL_ID, ACTIVITY_ID]) {
      const a = original.getNode(id)!.dependsOn;
      const b = clone.getNode(id)!.dependsOn;
      expect(b).toEqual(a);
      expect(b).not.toBe(a); // distinct array instances
    }

    // Pushing into a clone's dependsOn (via the public seam) can never leak
    // into the original's copy.
    clone.addNode({
      id: "extra-luggage-drop",
      type: "transfer",
      durationMinutes: 10,
      scheduledTime: BASE + 400 * MINUTE_MS,
      status: "on_track",
      dependsOn: [FLIGHT_ID],
    });
    expect(clone.getNode("extra-luggage-drop")).toBeDefined();
    expect(original.getNode("extra-luggage-drop")).toBeUndefined();
    // The original's flight still fans out to exactly its initial chain.
    expect(original.getDownstream(FLIGHT_ID).map((n) => n.id)).toEqual([
      TRANSFER_ID,
      HOTEL_ID,
      ACTIVITY_ID,
    ]);
  });

  it("a disruption propagated on the clone leaves the original completely unchanged", () => {
    const original = buildGraph();
    const before = snapshot(original);
    const clone = original.clone();

    // Full cascade on the CLONE: 45 min flight delay ⇒ transfer conflict,
    // hotel deferred, activity requires rescheduling.
    const result = clone.handleDisruption(FLIGHT_ID, 45);
    expect(result.affected.map((r) => r.nodeId)).toEqual([TRANSFER_ID, HOTEL_ID, ACTIVITY_ID]);

    const cloneFlight = clone.getNode(FLIGHT_ID) as FlightNode;
    expect(cloneFlight.status).toBe("delayed");
    expect(cloneFlight.arrivalTime).toBe(BASE + 195 * MINUTE_MS);
    expect(clone.getNode(TRANSFER_ID)?.status).toBe("conflict");
    expect(clone.getNode(HOTEL_ID)?.status).toBe("updated");
    expect(clone.getNode(HOTEL_ID)?.scheduledTime).toBe(BASE + 225 * MINUTE_MS); // 12:45
    expect(clone.getNode(ACTIVITY_ID)?.status).toBe("requires_rescheduling");

    // The original is still the untouched baseline.
    expect(snapshot(original)).toBe(before);
    const originalNodes = original.getNodes();
    expect(originalNodes.every((node) => node.status === "on_track")).toBe(true);
    expect((original.getNode(FLIGHT_ID) as FlightNode).arrivalTime).toBe(BASE + 150 * MINUTE_MS);
    expect(original.getNode(HOTEL_ID)?.scheduledTime).toBe(BASE + 210 * MINUTE_MS);
  });

  it("works symmetrically: mutating the original never leaks into an earlier clone", () => {
    const original = buildGraph();
    const clone = original.clone();
    const cloneBefore = snapshot(clone);

    original.handleDisruption(FLIGHT_ID, 45);
    expect(original.getNode(TRANSFER_ID)?.status).toBe("conflict");

    expect(snapshot(clone)).toBe(cloneBefore);
    expect(clone.getNodes().every((node) => node.status === "on_track")).toBe(true);
    // And the clone can still re-propagate the same disruption from its
    // pristine baseline — the orchestrator re-drive use case.
    const redrive = clone.handleDisruption(FLIGHT_ID, 45);
    expect(redrive.affected).toHaveLength(3);
  });
});
