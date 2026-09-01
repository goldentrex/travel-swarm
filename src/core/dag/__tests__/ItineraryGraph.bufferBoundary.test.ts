/**
 * Task 25 (#7) — pin the DAG activity-rule `<=` boundary.
 *
 * ItineraryGraph.handleDisruption flags a downstream activity when
 * `node.scheduledTime <= parentReady + activityBufferMs` (default buffer
 * 120 min). An activity scheduled EXACTLY at the window edge
 * (parentReady + 120 min) has zero slack and MUST be flagged
 * `requires_rescheduling`; one minute later it is untouched.
 */

import { describe, expect, it } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import type { ActivityNode } from "@/core/dag";

const MINUTE_MS = 60_000;
// Fixed epoch anchor (2026-08-22 09:00 UTC) — deterministic test times.
const BASE = Date.UTC(2026, 7, 22, 9, 0, 0);
const FLIGHT_ID = "flight-xy123";
const ACTIVITY_ID = "activity-edge";

/** Flight XY123 CDG → LIS 09:00 → 11:30 + one direct activity child. */
function buildGraph(activityOffsetMinutes: number): ItineraryGraph {
  const graph = new ItineraryGraph();
  graph.addNode({
    id: FLIGHT_ID,
    type: "flight",
    flightNumber: "XY123",
    origin: "CDG",
    destination: "LIS",
    departureTime: BASE,
    arrivalTime: BASE + 150 * MINUTE_MS, // 11:30
    scheduledTime: BASE,
    status: "on_track",
    dependsOn: [],
    arrivalLocationId: "LIS",
  });
  graph.addNode({
    id: ACTIVITY_ID,
    type: "activity",
    name: "Boundary Activity",
    durationMinutes: 60,
    scheduledTime: BASE + activityOffsetMinutes * MINUTE_MS,
    status: "on_track",
    dependsOn: [FLIGHT_ID],
  });
  return graph;
}

// A 60-minute delay pushes the flight arrival to 12:30 — with the default
// 120-min activity buffer the impacted window ends at 14:30 (BASE+330 min).
const DELAY_MINUTES = 60;
const EXACT_EDGE_OFFSET_MINUTES = 150 + DELAY_MINUTES + 120; // 330 → 14:30

describe("ItineraryGraph activity rule — exact `<=` boundary (Task 25 #7)", () => {
  it("flags an activity scheduled EXACTLY at parentReady + activityBufferMs", () => {
    const graph = buildGraph(EXACT_EDGE_OFFSET_MINUTES);
    const result = graph.handleDisruption(FLIGHT_ID, DELAY_MINUTES);

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0]).toMatchObject({
      nodeId: ACTIVITY_ID,
      nodeType: "activity",
      action: "requires_rescheduling",
    });
    const node = graph.getNode(ACTIVITY_ID) as ActivityNode;
    expect(node.status).toBe("requires_rescheduling");
  });

  it("leaves an activity scheduled at buffer + 1 minute untouched", () => {
    const graph = buildGraph(EXACT_EDGE_OFFSET_MINUTES + 1); // 14:31
    const result = graph.handleDisruption(FLIGHT_ID, DELAY_MINUTES);

    expect(result.affected.filter((report) => report.nodeId === ACTIVITY_ID)).toEqual([]);
    const node = graph.getNode(ACTIVITY_ID) as ActivityNode;
    expect(node.status).toBe("on_track");
    expect(node.scheduledTime).toBe(BASE + (EXACT_EDGE_OFFSET_MINUTES + 1) * MINUTE_MS);
  });
});
