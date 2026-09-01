/**
 * Canonical example of a valid TrustLayer ResolutionPlan — the "Flight XY123
 * delayed by 4h" scenario from the hackathon brief. `satisfies` guarantees
 * the literal is a structurally correct `ResolutionPlan` while keeping its
 * exact inferred shape for tests and demos.
 */

import type { ResolutionPlan } from "./TrustLayer";

export const XY123_EXAMPLE_PLAN = {
  incident: "Flight XY123 delayed by 4h",
  impacted_nodes: ["Hotel Check-in", "Surf Lesson"],
  proposed_resolution: {
    new_flight: { id: "XY999", cost: 150 },
    rescheduled_activities: [{ name: "Surf Lesson", new_time: "Tomorrow 10 AM", penalty: 20 }],
  },
  financial_delta: {
    total_refund: 100,
    total_new_charges: 170,
    net_payable: 70,
  },
  requires_human_approval: true,
} satisfies ResolutionPlan;
