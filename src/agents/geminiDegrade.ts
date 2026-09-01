/**
 * Gemini liveness taxonomy (Task 21) — the SHARED vocabulary for WHY a Gemini
 * call degraded, consumed by both Gemini callers of the swarm layer
 * (GeminiLiaisonAgent, DayReorganizer) and surfaced as additive
 * `liaison/gemini_degraded` / `activity/gemini_degraded` trace rows by
 * hackathonApi so operators can grep session traces for the exact reason
 * instead of the old silent `console.error`-only degradation.
 *
 * The union is FROZEN at these six values — a per-mission budget exhaustion
 * deliberately maps onto `quota_429` (the closest value) instead of expanding
 * it.
 */

/** Why a Gemini call did not produce usable output. */
export type GeminiDegradeReason =
  /** GEMINI_API_KEY absent/empty — the deterministic rail served instead. */
  | "missing_key"
  /** Free-tier quota 429 (or 503 overload) — includes per-mission budget
   *  exhaustion (closest taxonomy value; the union stays frozen). */
  | "quota_429"
  /** Any other non-OK HTTP status or an error payload in a 200 body. */
  | "http_error"
  /** The per-call deadline elapsed before the model answered. */
  | "timeout"
  /** The model answered but the payload failed parse/validation/repair. */
  | "invalid_output"
  /** Anything else thrown around the call (network reset, JSON encode…). */
  | "exception";

/** Result of ONE Gemini REST attempt — never throws, always classified. */
export type GeminiCallResult =
  | { ok: true; text: string }
  | { ok: false; reason: GeminiDegradeReason };

/**
 * Per-mission Gemini call BUDGET (same instance-counter pattern as
 * ActivityAgent's viatorConsultsUsed): only the first N Gemini calls of a
 * mission are executed; later calls skip straight to the deterministic rail
 * with degrade reason `quota_429`. Keeps the Workers Free-plan
 * 50-subrequests/invocation ceiling safe on multi-day disruptions.
 */
export const GEMINI_CALLS_PER_MISSION = 5;

/** Exactly ONE retry on 429/503 (quota_429), async resolve rail only. */
export const GEMINI_QUOTA_RETRIES = 2;

/** Backoff before the single retry; rides INSIDE the existing 10s deadline. */
export const GEMINI_RETRY_BACKOFF_MS = 1_500;
