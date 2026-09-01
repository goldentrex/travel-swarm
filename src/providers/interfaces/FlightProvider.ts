/**
 * Provider-agnostic flight operations contract.
 *
 * The agent layer (FlightAgent / OrchestratorAgent) depends ONLY on this
 * interface — never on a concrete implementation. Today the sole implementor
 * is `AtlasFlightProvider` (Atlas Skill / ATRIP Sandbox); Amadeus and Duffel
 * adapters can be dropped in later without touching any agent code.
 */

import type {
  AlternativeFlightsResult,
  BookingConfirmation,
  FareDifference,
  FlightRouteContext,
  IsoTimestamp,
} from "./types";

export interface FlightProvider {
  /** Human-readable provider name, e.g. "atlas-sandbox", "amadeus", "duffel". */
  readonly providerName: string;

  /**
   * Search for alternative flights that could replace `flightId`, anchored
   * around a desired new departure time (`newTime`, ISO-8601).
   *
   * Used during disruption recovery: the orchestrator asks "what else could
   * get the traveller to the same destination around this new time?".
   *
   * NEW (additive): `routeContext` carries the disrupted leg's
   * origin/destination/date for route-based upstream APIs (real Atlas /
   * Atrip `search.do`). Implementations that cannot search without it MUST
   * degrade gracefully (empty `options`) rather than throw when it is absent.
   */
  searchAlternativeFlights(
    flightId: string,
    newTime: IsoTimestamp,
    routeContext?: FlightRouteContext,
  ): Promise<AlternativeFlightsResult>;

  /**
   * Compute the fare delta between the traveller's current booking
   * (`oldFlightId`) and a candidate replacement (`newFlightId`).
   *
   * The returned `direction` makes the sign semantics explicit:
   * `refund` = money owed back to the traveller, `charge` = extra payable.
   *
   * NEW (additive): `routeContext` may supply the original booking fare
   * (`originalFare`) as the delta reference for providers that re-price the
   * candidate (Atlas `verify.do`) instead of exposing a fare-difference
   * endpoint.
   */
  calculateFareDifference(
    oldFlightId: string,
    newFlightId: string,
    routeContext?: FlightRouteContext,
  ): Promise<FareDifference>;

  /**
   * Book a flight offer by id.
   *
   * TRUST-LAYER NOTE: implementations must only ever be invoked after a
   * `ResolutionPlan` carrying `requires_human_approval: true` has been
   * explicitly approved by the user. Financial actions are never executed
   * from free-form model output.
   */
  bookFlight(flightId: string): Promise<BookingConfirmation>;
}
