/**
 * ItineraryGraph — the Level-4 core.
 *
 * The itinerary is treated as a *dependency graph* (DAG), not a flat list.
 * Nodes are timed itinerary events; edges declare "depends on" relationships
 * (e.g. the airport transfer depends on the inbound flight landing). When a
 * disruption hits any node, {@link ItineraryGraph.handleDisruption} walks the
 * downstream subgraph in topological order and propagates the delay according
 * to node-type-specific rules:
 *
 * - `hotel_check_in`  → automatically re-timed to the new upstream arrival
 *                        (action `updated`).
 * - `activity`        → if scheduled inside OR touching the impacted window
 *                        (upstream completion + buffer), marked
 *                        `requires_rescheduling`.
 * - `transfer`        → if pickup slack drops below the minimum buffer,
 *                        marked `conflict`.
 * - `flight`          → connecting flight below minimum connection time is a
 *                        `conflict` (missed connection).
 *
 * Propagation never stops at a `conflict`: a conflicted node forwards
 * `max(own end time, delayed upstream ready time)` to its dependents, so
 * nodes downstream of a missed connection are still evaluated against the
 * real (late) ready time instead of being fooled into "unaffected".
 *
 * Structural invariants are enforced at insertion time: `dependsOn` entries
 * must reference already-added nodes, self-dependencies are rejected,
 * duplicates are deduplicated, and neither {@link ItineraryGraph.addNode}
 * nor {@link ItineraryGraph.addDependency} can introduce a cycle.
 *
 * {@link ItineraryGraph.handleDisruption} is atomic: the full propagation is
 * computed on staged copies first and committed only after the entire walk
 * succeeds — a thrown error never leaves a half-applied disruption behind.
 *
 * Zero third-party dependencies — pure TypeScript.
 */

import type {
  AffectedNodeReport,
  DisruptionPropagationOptions,
  DisruptionResult,
  Duration,
  ItineraryNode,
} from "./types";

const MINUTE_MS = 60_000;

const DEFAULT_ACTIVITY_BUFFER_MINUTES = 120;
const DEFAULT_MIN_CONNECTION_MINUTES = 45;
const DEFAULT_TRANSFER_BUFFER_MINUTES = 15;

/** When is a node "done", i.e. when does it free up its dependents? */
function endTimeMs(node: ItineraryNode): number {
  switch (node.type) {
    case "flight":
      return node.arrivalTime;
    case "transfer":
    case "activity":
      return node.scheduledTime + node.durationMinutes * MINUTE_MS;
    case "hotel_check_in":
      return node.scheduledTime;
  }
}

/** Copy of a node with its own dependsOn array (staging helper for atomicity). */
function cloneNode(node: ItineraryNode): ItineraryNode {
  return { ...node, dependsOn: [...node.dependsOn] };
}

function toDelayMinutes(delayDuration: number | Duration): number {
  const minutes = typeof delayDuration === "number" ? delayDuration : delayDuration.minutes;
  if (!Number.isFinite(minutes)) {
    throw new Error(`ItineraryGraph: invalid delay duration ${minutes}`);
  }
  if (minutes < 0) {
    throw new Error(`ItineraryGraph: negative delay duration ${minutes} is not allowed`);
  }
  return minutes;
}

export class ItineraryGraph {
  private readonly nodes = new Map<string, ItineraryNode>();
  /** Adjacency list: upstream id → set of downstream ids. */
  private readonly children = new Map<string, Set<string>>();

  /**
   * Add a node.
   *
   * - Throws on duplicate ids.
   * - Every entry in `dependsOn` must reference an already-added node —
   *   dangling references are rejected outright (they previously allowed
   *   cycles to be smuggled in via later insertions).
   * - Duplicate dependencies are deduplicated; self-dependencies throw.
   * - A post-link cycle check runs as defense in depth; a violation rolls
   *   the insertion back before throwing.
   */
  addNode(node: ItineraryNode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`ItineraryGraph: node "${node.id}" already exists`);
    }
    const deps = [...new Set(node.dependsOn)];
    for (const dep of deps) {
      if (dep === node.id) {
        throw new Error(`ItineraryGraph: node "${node.id}" cannot depend on itself`);
      }
      if (!this.nodes.has(dep)) {
        throw new Error(
          `ItineraryGraph: node "${node.id}" depends on unknown node "${dep}" — add dependencies before their dependents`,
        );
      }
    }

    this.nodes.set(node.id, { ...node, dependsOn: deps });
    for (const dep of deps) {
      this.link(dep, node.id);
    }

    // Defense in depth: a freshly added node has no children yet, so with the
    // existence rule above cycles cannot form here — verify anyway and roll
    // back if a future change ever breaks that invariant.
    if (this.reachableFrom(node.id).has(node.id)) {
      this.nodes.delete(node.id);
      for (const dep of deps) this.children.get(dep)?.delete(node.id);
      throw new Error(`ItineraryGraph: adding node "${node.id}" would create a cycle`);
    }
  }

  /**
   * Declare a dependency edge: `downstreamId` depends on `upstreamId`.
   * Throws if either node is unknown, on self-dependencies, or if the edge
   * would create a cycle. A post-link reachability check with rollback runs
   * as defense in depth (same guarantee as {@link ItineraryGraph.addNode}).
   */
  addDependency(upstreamId: string, downstreamId: string): void {
    if (upstreamId === downstreamId) {
      throw new Error(
        `ItineraryGraph: self-dependency rejected — node "${downstreamId}" cannot depend on itself`,
      );
    }
    const upstream = this.requireNode(upstreamId);
    const downstream = this.requireNode(downstreamId);
    if (downstream.dependsOn.includes(upstreamId)) return; // idempotent
    if (this.reachableFrom(downstreamId).has(upstreamId)) {
      throw new Error(
        `ItineraryGraph: edge "${upstreamId}" → "${downstreamId}" would create a cycle`,
      );
    }
    downstream.dependsOn.push(upstreamId);
    this.link(upstream.id, downstream.id);

    // Defense in depth: the pre-link check above should already rule out any
    // cycle (including self-loops, rejected at the top) — verify after
    // linking anyway and roll the edge back if the invariant is ever broken.
    if (this.reachableFrom(downstreamId).has(downstreamId)) {
      downstream.dependsOn.pop();
      this.children.get(upstreamId)?.delete(downstreamId);
      throw new Error(
        `ItineraryGraph: edge "${upstreamId}" → "${downstreamId}" would create a cycle`,
      );
    }
  }

  getNode(nodeId: string): ItineraryNode | undefined {
    return this.nodes.get(nodeId);
  }

  getNodes(): ItineraryNode[] {
    return [...this.nodes.values()];
  }

  /**
   * All downstream dependents of `nodeId` (transitive), in topological order.
   * The source node itself is not included.
   */
  getDownstream(nodeId: string): ItineraryNode[] {
    this.requireNode(nodeId);
    return this.topologicalDownstream(nodeId).map((id) => this.requireNode(id));
  }

  /**
   * Apply a disruption to `nodeId` and propagate the delay to every
   * downstream dependent. Returns a structured report of everything that
   * changed.
   *
   * Atomicity: the full propagation is computed on staged copies first; the
   * graph is mutated only after the entire walk succeeds, so a thrown error
   * never leaves a half-applied disruption behind.
   *
   * Delay semantics: negative delays are rejected (throws). A zero delay is
   * a deliberate no-op: it returns an empty "no impact" result without
   * touching any node (chosen over throwing so polling-style callers can
   * pass a computed delay that happens to be zero).
   *
   * @param nodeId        the disrupted node (e.g. a delayed flight)
   * @param delayDuration delay in minutes, or a `{ minutes }` Duration
   * @param options       tunable propagation thresholds
   */
  handleDisruption(
    nodeId: string,
    delayDuration: number | Duration,
    options: DisruptionPropagationOptions = {},
  ): DisruptionResult {
    // Validation first: a rejected delay must never mutate the graph.
    const delayMinutes = toDelayMinutes(delayDuration);
    const source = this.requireNode(nodeId);

    if (delayMinutes === 0 && !options.newArrivalLocationId) {
      // Zero-minute delay with no spatial change cannot impact anything: report "no impact"
      // and leave every node untouched.
      return { sourceNodeId: nodeId, delayMinutes: 0, affected: [] };
    }

    const delayMs = delayMinutes * MINUTE_MS;

    const activityBufferMs =
      (options.activityBufferMinutes ?? DEFAULT_ACTIVITY_BUFFER_MINUTES) * MINUTE_MS;
    const minConnectionMs =
      (options.defaultMinConnectionMinutes ?? DEFAULT_MIN_CONNECTION_MINUTES) * MINUTE_MS;
    const transferBufferMs =
      (options.defaultTransferBufferMinutes ?? DEFAULT_TRANSFER_BUFFER_MINUTES) * MINUTE_MS;

    // Resolve the traversal order BEFORE any mutation.
    const order = this.topologicalDownstream(nodeId);

    // Staging area: work on clones so the propagation is all-or-nothing.
    const staged = new Map<string, ItineraryNode>();
    const stageOf = (id: string): ItineraryNode => {
      let clone = staged.get(id);
      if (!clone) {
        clone = cloneNode(this.requireNode(id));
        staged.set(id, clone);
      }
      return clone;
    };

    // 1) Shift the disruption source itself (staged).
    const stagedSource = stageOf(nodeId);
    stagedSource.scheduledTime += delayMs;
    if (stagedSource.type === "flight") {
      stagedSource.departureTime += delayMs;
      stagedSource.arrivalTime += delayMs;
      if (options.newArrivalLocationId) {
        stagedSource.arrivalLocationId = options.newArrivalLocationId;
      }
    }
    stagedSource.status = "delayed";

    // 2) Walk the downstream subgraph in topological order, tracking the
    //    new "ready at" time of every affected node.
    const newEndTime = new Map<string, number>([[nodeId, endTimeMs(stagedSource)]]);
    const affected: AffectedNodeReport[] = [];

    for (const candidateId of order) {
      const node = stageOf(candidateId);

      // Latest completion time among *affected* upstreams only — unaffected
      // parents still finish on their original schedule.
      let parentReady = Number.NEGATIVE_INFINITY;
      for (const depId of node.dependsOn) {
        const ready = newEndTime.get(depId);
        if (ready !== undefined && ready > parentReady) parentReady = ready;
      }
      if (parentReady === Number.NEGATIVE_INFINITY) continue; // no affected upstream

      const previousTime = node.scheduledTime;
      const slack = node.scheduledTime - parentReady;
      let report: AffectedNodeReport | null = null;

      switch (node.type) {
        case "flight": {
          const minConn =
            node.minConnectionMinutes !== undefined
              ? node.minConnectionMinutes * MINUTE_MS
              : minConnectionMs;
          if (slack < minConn) {
            report = {
              nodeId: node.id,
              nodeType: node.type,
              action: "conflict",
              previousScheduledTime: previousTime,
              reason:
                "Connection buffer below minimum: upstream arrives too close to departure (missed connection).",
            };
            node.status = "conflict";
          }
          break;
        }
        case "transfer": {
          // Spatial constraint: Check if upstream arrival location changed
          let spatialMismatch = false;
          let spatialReason = "";
          for (const depId of node.dependsOn) {
            const upNode = staged.get(depId) || this.requireNode(depId);
            if (
              upNode.type === "flight" &&
              upNode.arrivalLocationId &&
              node.pickupLocationId &&
              upNode.arrivalLocationId !== node.pickupLocationId
            ) {
              spatialMismatch = true;
              spatialReason = `Spatial mismatch: Upstream flight arrives at a different location (${upNode.arrivalLocationId} instead of ${node.pickupLocationId}).`;
              break;
            }
          }

          if (spatialMismatch) {
            report = {
              nodeId: node.id,
              nodeType: node.type,
              action: "conflict",
              previousScheduledTime: previousTime,
              reason: spatialReason,
            };
            node.status = "conflict";
          } else {
            const minBuffer =
              node.minBufferMinutes !== undefined
                ? node.minBufferMinutes * MINUTE_MS
                : transferBufferMs;
            if (slack < minBuffer) {
              report = {
                nodeId: node.id,
                nodeType: node.type,
                action: "conflict",
                previousScheduledTime: previousTime,
                reason:
                  "Pickup slack below minimum buffer after upstream delay; transfer must be re-booked.",
              };
              node.status = "conflict";
            }
          }
          break;
        }
        case "hotel_check_in": {
          if (slack < 0) {
            node.scheduledTime = parentReady;
            node.status = "updated";
            report = {
              nodeId: node.id,
              nodeType: node.type,
              action: "updated",
              previousScheduledTime: previousTime,
              newScheduledTime: parentReady,
              reason: "Check-in automatically deferred to match the delayed upstream arrival.",
            };
          }
          break;
        }
        case "activity": {
          // `<=`: an activity scheduled EXACTLY where the impacted window ends
          // (parentReady + buffer) is impacted too — a zero-slack slot has no
          // room to absorb the upstream delay.
          if (node.scheduledTime <= parentReady + activityBufferMs) {
            node.status = "requires_rescheduling";
            report = {
              nodeId: node.id,
              nodeType: node.type,
              action: "requires_rescheduling",
              previousScheduledTime: previousTime,
              reason:
                "Activity falls inside (or touches the edge of) the impacted time window after the upstream delay.",
            };
          }
          break;
        }
      }

      if (report) {
        affected.push(report);
        let propagatedEnd: number;
        switch (report.action) {
          case "updated":
            // The node was re-timed in place (staged); its end time already
            // reflects the deferred schedule.
            propagatedEnd = endTimeMs(node);
            break;
          case "requires_rescheduling":
            // Assume the rescheduled node slips by the lag it incurred, so
            // cascades keep propagating conservatively.
            propagatedEnd = endTimeMs(node) + Math.max(0, parentReady - previousTime);
            break;
          case "conflict":
            // A conflicted node (e.g. missed connection) keeps its own
            // schedule, but downstream must NOT see it as on time: forward
            // the later of its own end and the delayed upstream ready time
            // so the propagation chain continues past the conflict.
            propagatedEnd = Math.max(endTimeMs(node), parentReady);
            break;
        }
        newEndTime.set(node.id, propagatedEnd);
      }
      // Unaffected nodes keep their original end time; no propagation entry.
    }

    // 3) Commit: the whole walk succeeded, so apply every staged change now.
    for (const [id, clone] of staged) {
      this.nodes.set(id, clone);
    }

    return { sourceNodeId: nodeId, delayMinutes, affected };
  }

  /**
   * Deep-enough snapshot of the whole graph: every node is copied with ALL of
   * its mutable fields (scheduledTime, status, …) and its own `dependsOn`
   * array, and the child-edge adjacency is rebuilt from those copies.
   * Mutating the original after cloning (or the clone after forking) never
   * affects the other side.
   *
   * Pure and total — used by the orchestrator's re-drive to re-propagate a
   * disruption from the untouched baseline.
   */
  clone(): ItineraryGraph {
    const copy = new ItineraryGraph();
    for (const node of this.nodes.values()) {
      copy.addNode(cloneNode(node));
    }
    return copy;
  }

  /**
   * Replace this graph's ENTIRE contents with a snapshot taken via
   * {@link ItineraryGraph.clone}: every node (all mutable fields) and every
   * dependency edge is restored from the snapshot's copies — the receiver
   * ends structurally identical to the snapshot at capture time.
   *
   * Pure and total — used by the orchestrator's re-drive: after the nominal
   * propagation mutated the live graph, the graph is restored to the
   * untouched baseline and re-propagated ONCE with the replacement flight's
   * real-arrival delay (no double-shift).
   */
  restoreFrom(snapshot: ItineraryGraph): void {
    this.nodes.clear();
    this.children.clear();
    for (const node of snapshot.nodes.values()) {
      this.addNode(cloneNode(node));
    }
  }

  // ---------------------------------------------------------------- internals

  private link(upstreamId: string, downstreamId: string): void {
    let set = this.children.get(upstreamId);
    if (!set) {
      set = new Set();
      this.children.set(upstreamId, set);
    }
    set.add(downstreamId);
  }

  private requireNode(nodeId: string): ItineraryNode {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`ItineraryGraph: unknown node "${nodeId}"`);
    }
    return node;
  }

  /** Transitive downstream id set (excluding the start node). */
  private reachableFrom(nodeId: string): Set<string> {
    const seen = new Set<string>();
    const queue = [...(this.children.get(nodeId) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of this.children.get(current) ?? []) queue.push(next);
    }
    return seen;
  }

  /**
   * Downstream ids in topological order (Kahn's algorithm over the induced
   * subgraph), so parents are always processed before their dependents.
   */
  private topologicalDownstream(nodeId: string): string[] {
    const subgraph = this.reachableFrom(nodeId);
    const indegree = new Map<string, number>();
    for (const id of subgraph) {
      const node = this.requireNode(id);
      // Count UNIQUE in-subgraph dependencies — a duplicated dependsOn entry
      // must not inflate the indegree (children edges are deduplicated Sets).
      indegree.set(id, new Set(node.dependsOn.filter((dep) => subgraph.has(dep))).size);
    }

    const queue: string[] = [];
    for (const [id, degree] of indegree) {
      if (degree === 0) queue.push(id);
    }

    const ordered: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      ordered.push(current);
      for (const childId of this.children.get(current) ?? []) {
        if (!subgraph.has(childId)) continue;
        const remaining = (indegree.get(childId) ?? 0) - 1;
        indegree.set(childId, remaining);
        if (remaining === 0) queue.push(childId);
      }
    }

    if (ordered.length !== subgraph.size) {
      // Unreachable for a well-formed DAG (addDependency rejects cycles), but
      // never silently return a partial traversal.
      throw new Error(`ItineraryGraph: cycle detected downstream of "${nodeId}"`);
    }
    return ordered;
  }
}
