/**
 * Spatial-constraint propagation tests for ItineraryGraph (spec §2).
 *
 * Covers the spatial layer of `handleDisruption`:
 * - A TransferNode whose pickupLocationId differs from its upstream
 *   FlightNode's (possibly re-routed) arrivalLocationId is an immediate
 *   `conflict`, regardless of chronological slack.
 * - When locations match, the original chronological slack rules apply.
 * - Delay-0 with `newArrivalLocationId` is NOT a no-op (spatial-only update).
 * - Delay-0 without `newArrivalLocationId` IS a no-op.
 * - Committed graph state after a spatial propagation.
 */

import { describe, expect, it } from "vitest";
import { ItineraryGraph } from "@/core/dag";
import type { FlightNode, TransferNode } from "@/core/dag";

const MINUTE_MS = 60_000;
// Fixed epoch anchor (2026-08-22 09:00 UTC) — deterministic test times.
const BASE = Date.UTC(2026, 7, 22, 9, 0, 0);

const FLIGHT_ID = "flight-xy123";
const TRANSFER_ID = "transfer-airport";

/**
 * Mirror of the hackathon demo shape:
 * - flight XY123 CDG → LIS, 09:00 → 11:30, lands at "LIS"
 * - transfer pickup 12:15 (45 min slack), 30 min ride, picks up at "LIS"
 */
function buildGraph(options: { flightLocation?: string; pickupLocation?: string } = {}): {
  graph: ItineraryGraph;
  flight: () => FlightNode;
  transfer: () => TransferNode;
} {
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
    arrivalLocationId: options.flightLocation ?? "LIS",
  });
  graph.addNode({
    id: TRANSFER_ID,
    type: "transfer",
    durationMinutes: 30,
    scheduledTime: BASE + 195 * MINUTE_MS, // 12:15 — 45 min after landing
    status: "on_track",
    dependsOn: [FLIGHT_ID],
    pickupLocationId: options.pickupLocation ?? "LIS",
  });
  return {
    graph,
    flight: () => graph.getNode(FLIGHT_ID) as FlightNode,
    transfer: () => graph.getNode(TRANSFER_ID) as TransferNode,
  };
}

describe("ItineraryGraph spatial constraints", () => {
  describe("spatial mismatch detection", () => {
    it("flags the downstream transfer as conflict when the disruption re-routes the flight to another airport", () => {
      const { graph } = buildGraph();

      // 30 min delay leaves exactly the default 15-min pickup slack, so the
      // chronological rule alone would NOT conflict — only the spatial rule can.
      const result = graph.handleDisruption(FLIGHT_ID, 30, { newArrivalLocationId: "OPO" });

      expect(result.sourceNodeId).toBe(FLIGHT_ID);
      expect(result.delayMinutes).toBe(30);
      const transferReport = result.affected.find((report) => report.nodeId === TRANSFER_ID);
      expect(transferReport).toBeDefined();
      expect(transferReport?.nodeType).toBe("transfer");
      expect(transferReport?.action).toBe("conflict");
      expect(transferReport?.reason).toBe(
        "Spatial mismatch: Upstream flight arrives at a different location (OPO instead of LIS).",
      );
    });

    it("conflicts the transfer even when chronological slack is comfortable", () => {
      const { graph, transfer } = buildGraph();

      // Zero chronological impact at all — pure spatial change.
      const result = graph.handleDisruption(FLIGHT_ID, 0, { newArrivalLocationId: "OPO" });

      expect(result.affected).toHaveLength(1);
      expect(result.affected[0]).toMatchObject({
        nodeId: TRANSFER_ID,
        action: "conflict",
        reason:
          "Spatial mismatch: Upstream flight arrives at a different location (OPO instead of LIS).",
      });
      // The transfer keeps its schedule — a spatial conflict is a re-quote
      // situation, not a re-timing one.
      expect(transfer().scheduledTime).toBe(BASE + 195 * MINUTE_MS);
    });
  });

  describe("matching locations fall back to chronological slack rules", () => {
    it("conflicts the transfer when pickup slack drops below the minimum buffer", () => {
      const { graph } = buildGraph(); // both "LIS", no spatial change

      // 45 min delay → flight lands 12:15, pickup 12:15 → slack 0 < 15 min buffer.
      const result = graph.handleDisruption(FLIGHT_ID, 45);

      const transferReport = result.affected.find((report) => report.nodeId === TRANSFER_ID);
      expect(transferReport).toBeDefined();
      expect(transferReport?.action).toBe("conflict");
      expect(transferReport?.reason).toBe(
        "Pickup slack below minimum buffer after upstream delay; transfer must be re-booked.",
      );
      // The reason must NOT mention a spatial mismatch.
      expect(transferReport?.reason).not.toContain("Spatial mismatch");
    });

    it("leaves the transfer alone when slack stays at or above the buffer", () => {
      const { graph, transfer } = buildGraph(); // both "LIS", no spatial change

      // 30 min delay → landing 12:00, pickup 12:15 → slack 15 min = buffer. Not below.
      const result = graph.handleDisruption(FLIGHT_ID, 30);

      expect(result.affected).toEqual([]);
      expect(transfer().status).toBe("on_track");
    });
  });

  describe("delay-0 semantics", () => {
    it("delay 0 + newArrivalLocationId is NOT a no-op: spatial propagation runs", () => {
      const { graph, flight, transfer } = buildGraph();

      const result = graph.handleDisruption(FLIGHT_ID, 0, { newArrivalLocationId: "OPO" });

      expect(result.delayMinutes).toBe(0);
      expect(result.affected.length).toBeGreaterThan(0);
      // Source flight: location updated, times untouched.
      expect(flight().arrivalLocationId).toBe("OPO");
      expect(flight().departureTime).toBe(BASE);
      expect(flight().arrivalTime).toBe(BASE + 150 * MINUTE_MS);
      // Downstream transfer marked conflict.
      expect(transfer().status).toBe("conflict");
      expect(result.affected[0]).toMatchObject({
        nodeId: TRANSFER_ID,
        action: "conflict",
        reason: expect.stringContaining("(OPO instead of LIS)"),
      });
    });

    it("delay 0 without newArrivalLocationId is a no-op: empty result, graph untouched", () => {
      const { graph, flight, transfer } = buildGraph();

      const result = graph.handleDisruption(FLIGHT_ID, 0);

      expect(result).toEqual({ sourceNodeId: FLIGHT_ID, delayMinutes: 0, affected: [] });
      expect(flight().status).toBe("on_track");
      expect(flight().arrivalLocationId).toBe("LIS");
      expect(flight().departureTime).toBe(BASE);
      expect(flight().arrivalTime).toBe(BASE + 150 * MINUTE_MS);
      expect(transfer().status).toBe("on_track");
      expect(transfer().scheduledTime).toBe(BASE + 195 * MINUTE_MS);
    });
  });

  describe("committed state after spatial propagation", () => {
    it("commits the delayed, re-routed flight and the conflicted transfer atomically", () => {
      const { graph, flight, transfer } = buildGraph();

      graph.handleDisruption(FLIGHT_ID, 30, { newArrivalLocationId: "OPO" });

      // Source flight: delayed + re-routed.
      const committedFlight = flight();
      expect(committedFlight.status).toBe("delayed");
      expect(committedFlight.arrivalLocationId).toBe("OPO");
      expect(committedFlight.scheduledTime).toBe(BASE + 30 * MINUTE_MS);
      expect(committedFlight.departureTime).toBe(BASE + 30 * MINUTE_MS);
      expect(committedFlight.arrivalTime).toBe(BASE + 180 * MINUTE_MS);

      // Downstream transfer: conflicted but not re-timed.
      const committedTransfer = transfer();
      expect(committedTransfer.status).toBe("conflict");
      expect(committedTransfer.scheduledTime).toBe(BASE + 195 * MINUTE_MS);
      expect(committedTransfer.pickupLocationId).toBe("LIS");
    });
  });

  // Ledger-level transfer re-quote coverage (TRANSFER_REQUOTE_CHARGE = 45 →
  // total_new_charges + proposed_resolution.transfer_requote) lives in
  // src/agents/__tests__/orchestrator.ttl.test.ts — it exercises the
  // orchestrator seam rather than the pure DAG.
});
