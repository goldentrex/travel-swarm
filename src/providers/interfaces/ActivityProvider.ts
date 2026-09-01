/**
 * Provider-agnostic activity / experience operations contract.
 *
 * The agent layer (ActivityAgent) depends ONLY on this interface — never on
 * a concrete implementation. Today the sole implementor is
 * `ViatorActivityProvider`, which routes through the existing
 * `viator-activities` Supabase Edge Function (spec §2.2) and applies
 * deterministic indoor/outdoor tagging on the way in.
 */

import type { ActivitySearchQuery, ActivitySearchResult } from "./types";

export interface ActivityProvider {
  /** Human-readable provider name, e.g. "viator-edge". */
  readonly providerName: string;

  /**
   * Search bookable activities matching `query`, optionally scoped to a
   * destination and filtered by indoor/outdoor preference. Implementations
   * degrade gracefully (empty result with `degraded: true`) instead of
   * throwing when upstream is unreachable, so a weather swap never takes the
   * whole recovery plan down.
   */
  searchActivities(query: ActivitySearchQuery): Promise<ActivitySearchResult>;
}
