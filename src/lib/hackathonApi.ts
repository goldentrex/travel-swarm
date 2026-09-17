/**
 * Hackathon backend endpoints — pure logic module, mounted by src/server.ts
 * which intercepts `/api/hackathon/*` BEFORE delegating to TanStack SSR
 * (TanStack Start 1.168 has no file-based API routes, and server.ts's outer
 * catch converts uncaught errors into HTML pages — so every code path here
 * MUST resolve to a JSON Response and never throw outward).
 *
 * Endpoints (contract shared with the iOS client — do not drift):
 *
 *   POST /api/hackathon/approve-resolution
 *     body: { resolutionId: string, approved: true, planIndex?: number }
 *     `planIndex` (default 0) selects one of the two-phase session's
 *     `plans`; sessions without `plans` (legacy/alert path) fall back to
 *     `plan` and ignore the index.
 *     200 : { approved: true, booking: BookingConfirmation, plan,
 *             updated_content?, settlement: { trip_updated, changes,
 *             booking_recorded, conflict_skipped?, note? } }
 *     410 session_expired  — the SESSION itself expired/was cancelled
 *                            (distinct from quotes_expired: the plan TTL).
 *     503 session_store_unavailable — the session lookup errored.
 *     Booking is BEST-EFFORT: a missing/failing flight provider degrades to a
 *     locally RECORDED booking (status "recorded", source "swarm_settlement")
 *     — approve never returns 502/503 anymore (except store failures above).
 *
 *   POST /api/hackathon/mission                      (SPEC §4.2)
 *     body: { intent: string, tripId: string, nodeId?: string }
 *     200 : { resolution_id: string, plan: ResolutionPlan, swarm_trace: SwarmTraceEntry[] }
 *       OR  { resolution_id: string, state: "processing" } — the async path
 *           (an execution context is provided): the Worker answers
 *           immediately and finishes the pipeline in ctx.waitUntil; the
 *           client polls swarm-status/{resolution_id} until state
 *           proposal_ready (SPEC §4.3).
 *     tripId is REQUIRED — missing/non-uuid ⇒ 400 trip_required, a uuid that
 *     fails hydration ⇒ 404 trip_not_hydratable, a trip-LOAD STORE failure
 *     (any query/thrown error, e.g. a rotated service key) ⇒
 *     503 session_store_unavailable (retryable — never 404).
 *
 *   POST /api/hackathon/mission/assess        (two-phase flow, phase 1)
 *     body: { intent: string, tripId: string, nodeId?: string, language?: string }
 *     200 : { status: "gathering_preferences", resolution_id: string,
 *             tradeoffs: TradeoffQuestion[] }  (0–2 questions × exactly 2
 *             options — zero is a VALID outcome: the discrimination filter
 *             may drop every question, and iOS auto-resolves that case)
 *     FAST gathering pass: specialist assess methods only (no plan assembly);
 *     raw candidates persist on the session (`candidates` jsonb); Gemini
 *     trade-off questions with a deterministic fallback (no GEMINI_API_KEY ⇒
 *     fully deterministic).
 *
 *   POST /api/hackathon/mission/resolve       (two-phase flow, phase 2)
 *     body: { resolution_id: string,
 *             answers: [{ question_id: string, option_id: string }],
 *             language?: string }
 *     200 : { resolution_id, status: "proposal_ready", plans: ResolutionPlan[] }
 *       OR  { resolution_id, status: "processing" } — the REAL-trip async
 *           rail (ctx.waitUntil, client polls swarm-status). Up to 3 distinct
 *           badge-stamped plans (cheapest / fastest / balanced); answers are
 *           translated into constraints via the liaison agent.
 *
 *   POST /api/hackathon/mission/cancel        (WS3)
 *     body: { resolutionId: string }          (camelCase, like approve)
 *     200 : { cancelled: true }
 *       OR  { cancelled: false, noop: true, state? } — already terminal
 *           (approved/settled/expired) or unknown; safe to retry.
 *     400 : invalid_body (missing resolutionId)
 *     503 : session_store_unavailable
 *     Atomically transitions ACTIVE sessions (processing /
 *     gathering_preferences / proposal_ready / awaiting_approval) →
 *     expired; a late async-rail completion notices the expired state and
 *     discards its results instead of resurrecting the session.
 *
 *   Real-trip rail: every mission addresses a REAL, hydratable trip — a
 *   missing or non-uuid tripId ⇒ 400 trip_required, a uuid whose content
 *   fails hydration (missing row / unusable content) ⇒ 404
 *   trip_not_hydratable, and a trip-load STORE failure ⇒ 503
 *   session_store_unavailable (retryable; iOS already maps this code).
 *
 *   GET  /api/hackathon/swarm-status/{resolution_id} (SPEC §4.3)
 *     200 : { resolution_id, state, trace, plan?, plans? }
 *     Two-phase sessions additionally carry `plans` (the full resolve array)
 *     in the plan-visible states; `plan` stays plans[0] for backward compat.
 *
 *   GET  /api/hackathon/alerts?tripId={id}&since={epoch_ms}  (SPEC §4.5)
 *     tripId is REQUIRED (missing/empty ⇒ 400 invalid_body).
 *     200 : { alerts: [{ notification_id, resolution_id, created_at, incident,
 *             degraded, origin?, plan }], server_time }
 *     Alerts are scoped to the trip, exclude expired sessions
 *     (expires_at > now), and carry `degraded` (+ `origin` when the plan
 *     declares one) so iOS can route proactive placeholder alerts to the
 *     adaptive mission flow instead of the booking sheet.
 *
 * Session persistence (SPEC §4.6): plans live in the `swarm_sessions`
 * Supabase table via src/lib/swarmSessionStore.ts — the module-level Map the
 * old implementation relied on cannot survive multi-instance Cloudflare
 * Workers, and the proactive flow (swarm-monitor Edge Function writes a
 * preemptive session, this Worker serves/approves it) crosses processes. The
 * store keeps an in-memory tier as fast path and mirrors to Supabase; when
 * Supabase credentials are absent (dev) sessions run memory-only and are
 * marked degraded (not bookable, see degradation policy below). Approve is
 * one-shot: an atomic conditional state transition guarantees exactly-once
 * booking; a booking failure also consumes the session (client re-simulates).
 *
 * Degradation policy: if the AtlasFlightProvider cannot be constructed
 * (missing ATLAS_API_KEY) or its calls fail at runtime, missions return a
 * graph-only plan with the provider fallback flight `XY999` and incident
 * suffix "(simulated — flight provider unavailable)".
 * approve-resolution NEVER fails on the provider: a missing/failing Atlas
 * client degrades into a locally recorded booking (status "recorded",
 * source "swarm_settlement") instead of the old 502/503 responses. Sessions
 * served purely from the in-memory tier (no Supabase credentials in dev) are
 * additionally marked degraded ⇒ 409 on approve.
 */

import {
  ActivityAgent,
  DayReorganizer,
  FlightAgent,
  GEMINI_CALLS_PER_MISSION,
  GEMINI_QUOTA_RETRIES,
  GeminiLiaisonAgent,
  HotelAgent,
  OrchestratorAgent,
  PolicyAgent,
  TRANSFER_REQUOTE_CHARGE,
  buildPreferenceTradeoffs,
  deriveConstraintsFromAnswers,
  formatNewTime,
  selectPlanCandidates,
} from "@/agents";
import type {
  ActivityRescheduleProposal,
  DisruptionAssessment,
  DisruptionEvent,
  FinancialDelta,
  FlightAgentConfig,
  FlightRebookingAssessment,
  GeminiDegradeReason,
  HotelAdjustment,
  OperationalSettlement,
  RebookingCandidate,
  ResolutionConstraints,
  ResolutionPlan,
  ResolutionPresentation,
  TradeoffAnswer,
  TradeoffQuestion,
  TransferRequote,
} from "@/agents";
import { validateResolutionPlan } from "@/agents";
import type { DisruptionResult, ItineraryGraph, ItineraryNode } from "@/core/dag";
import { describeTripConsequence, evaluateTripConsequence } from "@/core/dag";
import {
  AtlasFlightProvider,
  RapidApiHotelProvider,
  ViatorActivityProvider,
  rapidApiHotelConfigured,
  viatorEdgeConfigured,
  OpenWeatherProvider,
  openWeatherConfigured,
  PredictHQProvider,
  predictHQConfigured,
} from "@/providers";
import { AtlasApiError, resolvedAtlasHost } from "@/providers/atlas/AtlasFlightProvider";
import type { BookingConfirmation } from "@/providers/interfaces/types";
import { parseMissionIntentForTrip, type TripMissionCategory } from "./swarmIntent";
import {
  probeActivityReachable,
  probeAtlasReachable,
  probeHotelReachable,
} from "./swarmReachability";
import { applySettlementToContent, loadSwarmTrip, settlePlanOnTrip } from "./swarmTripContext";
import type { SettlementEffects, SettlementFollowUp } from "./swarmTripContext";
import { AIRPORTS, arrivalBuffer, classifyItem } from "@/core/sanity";
import { checkTripAccess, resolveSwarmActor, USER_TOKEN_HEADER } from "./swarmAuth";
import { buildBookingPreview, type PreviewLineRequest } from "./swarmBookingPreview";
import { hotelQuotaNote } from "@/providers/rapidapi/hotelQuota";
import { GeminiCallBudget, geminiUsageLogger } from "@/agents/geminiUsage";
import type { HydratedTrip, SwarmTripLoadResult } from "./swarmTripContext";
import {
  cancelSwarmSession,
  claimSwarmSessionForBooking,
  claimSwarmSessionForResolve,
  type SwarmSessionRecord,
  getSwarmSession,
  getSwarmSessionIgnoringExpiry,
  listSwarmAlerts,
  saveSwarmSettlementReceipt,
  settlementOperation,
  probeSwarmStoreHealth,
  saveSwarmSession,
  saveSwarmSessionIfState,
  swarmStoreIsPersistent,
  updateSwarmSession,
} from "./swarmSessionStore";
import type { SwarmTraceEntry } from "./swarmSessionStore";

const HACKATHON_API_PREFIX = "/api/hackathon/";

/** Provider-outage fallback used by the degraded rail (see header). */
const PROVIDER_FALLBACK_FLIGHT_ID = "XY999";
const PROVIDER_FALLBACK_FLIGHT_COST = 150;
/** Deterministic penalty per rescheduled activity on the degraded rail. */
const DEGRADED_ACTIVITY_PENALTY = 20;

/**
 * Fallback fare-rule payload (Phase B wiring fix).
 *
 * The PolicyAgent interprets the Atlas `rule` blob embedded in search.do /
 * verify.do responses — but the Atlas sandbox hydration path exposes no
 * fare-rule payload today. This clearly-labelled fallback rule keeps the
 * PolicyAgent in every run (Atlas-shaped schema: changesRules with a 25 EUR
 * change fee window, conditional refunds, one 23 kg checked bag). Missions
 * pass through any Atlas-provided fareRule when one becomes available
 * (`options.fareRule ?? fallbackFareRule(...)` below).
 */
function fallbackFareRule(tripCurrency?: string): Record<string, unknown> {
  // The default MUST be denominated in the trip's own currency: hardcoding EUR
  // put a EUR change fee next to a USD ticket in one ledger, which is exactly
  // the mixed-currency panel travelers cannot act on.
  const cur = (tripCurrency ?? "").trim().toUpperCase();
  const currency = /^[A-Z]{3}$/.test(cur) ? cur : "EUR";
  return {
    changesRules: {
      changesStatus: "T",
      ruleDetailList: [{ fee: 25, currency, beforeTime: 24 }],
    },
    refundRules: {
      refundStatus: "H",
      ruleDetailList: [{ fee: 40, currency }],
    },
    hasBaggage: true,
    baggageElements: [{ pieceNum: 1, weight: 23, text: "1 checked bag up to 23 kg" }],
    currency,
  };
}

/**
 * Names WHERE a change fee came from, so the Activity Stream never presents a
 * house default as the airline's own policy. Appended to every `fare_rules*`
 * trace row on every rail.
 */
function ruleSourceSuffix(verdict: { ruleSource?: "provider_published" | "supplied" }): string {
  return verdict.ruleSource === "provider_published"
    ? " (carrier's published rule for this fare)"
    : " (default rule — carrier policy not published for this fare)";
}

/** Reason prefix emitted by ItineraryGraph for spatial transfer conflicts. */
const SPATIAL_MISMATCH_REASON_PREFIX = "Spatial mismatch";

/**
 * FlightAgent config for the LIVE Atlas rail (real `verify.do` pricing takes
 * several seconds — the stock 4 s fare deadline would exclude every real
 * candidate and silently kill the showcase). The deadline sits just above
 * ATLAS_TIMEOUT_MS (15 s). W1 wider pool: a 6-date flexible window priced
 * at up to 5 candidates feeds the per-candidate carousel; the window closes
 * early once 5 usable replacements surface, and a 12 s WALL-CLOCK budget
 * truncates it before any further date so the assess answer stays fast.
 */
const SWARM_FLIGHT_AGENT_CONFIG: FlightAgentConfig = {
  fareDeadlineMs: 20_000,
  maxPricedCandidates: 5,
  searchWindowDays: 6,
  earlyStopUsableCount: 5,
  overallDeadlineMs: 12_000,
};

/** Session lifetime — mirrors the swarm_sessions.expires_at default. */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Async-rail incremental trace persistence cadence: the mirror flushes once
 * every N entries (not per entry) to stay inside the Worker subrequest
 * budget — the final guarded upsert carries the complete trace either way.
 * Task 25 (#6): raised 5 → 8 for subrequest margin — a worst-case resolve
 * sits near the 50-subrequest cap (≈47–48), and halving the flush count
 * buys headroom without hurting progressive surfacing (Activity Stream
 * polls ~1.5 s; the final upsert carries the full trace regardless).
 */
const TRACE_FLUSH_EVERY = 8;

/**
 * Shared CHUNKED mirror-write rail for BOTH async rails (legacy POST
 * /mission and two-phase /mission/resolve). Subrequest budget (Free plan
 * caps a single Worker invocation at 50): a wide pipeline pushes 20-50
 * trace entries, and one Supabase mirror write PER ENTRY alone could
 * exhaust the budget before the final guarded upsert — exactly the live
 * "Too many subrequests" failure that stranded sessions in `processing`.
 * Flush the mirror in chunks instead: the Activity Stream polls ~1.5 s, so
 * entries still surface progressively, and the FINAL upsert carries the
 * complete trace regardless — nothing is ever lost, only batched.
 * Exported for unit tests only.
 */
export function createChunkedTraceMirror(
  resolutionId: string,
  initialTrace: SwarmTraceEntry[],
): {
  /** Append one entry; flushes the mirror once every TRACE_FLUSH_EVERY. */
  persistTraceEntry: (entry: SwarmTraceEntry) => void;
  /** Await before the final upsert to drain in-flight mirror writes. */
  drain: () => Promise<unknown>;
} {
  let liveTrace: SwarmTraceEntry[] = [...initialTrace];
  let saveChain: Promise<unknown> = Promise.resolve();
  let unsavedEntries = 0;
  const persistTraceEntry = (entry: SwarmTraceEntry): void => {
    liveTrace = [...liveTrace, entry];
    unsavedEntries += 1;
    if (unsavedEntries < TRACE_FLUSH_EVERY) return;
    unsavedEntries = 0;
    const snapshot = liveTrace;
    saveChain = saveChain
      .then(() => updateSwarmSession(resolutionId, { trace: snapshot }))
      .catch((error) => console.warn("[hackathon-api] incremental trace save failed:", error));
  };
  return { persistTraceEntry, drain: () => saveChain };
}

/**
 * Grace added on top of the latest quote TTL when a resolve finalizes
 * (WS1): the session horizon must never expire BEFORE the plan quotes it
 * carries, otherwise the approve TTL gate would reject a session the
 * client still shows as live.
 */
const PLAN_TTL_GRACE_MS = 5 * 60 * 1000; // 5 minutes

/** Session horizon at resolve-final upsert: max(now + TTL, latest plan
 *  quote expiry + grace). */
function resolveSessionExpiresAt(plans: readonly ResolutionPlan[]): string {
  let horizonMs = Date.now() + SESSION_TTL_MS;
  for (const plan of plans) {
    if (typeof plan.expires_at === "number" && Number.isFinite(plan.expires_at)) {
      horizonMs = Math.max(horizonMs, plan.expires_at + PLAN_TTL_GRACE_MS);
    }
  }
  return new Date(horizonMs).toISOString();
}

/**
 * WS1 guard for async rails: true when the session is already in the
 * `expired` state (TTL elapsed or user-cancelled via /mission/cancel).
 * Final upserts must then be skipped so a late pipeline completion cannot
 * resurrect a cancelled session. Store errors ⇒ false (keep today's
 * behaviour: the upsert still runs).
 */
async function swarmSessionIsExpired(id: string): Promise<boolean> {
  const lookup = await getSwarmSessionIgnoringExpiry(id);
  return lookup !== null && "record" in lookup && lookup.record.state === "expired";
}

// ------------------------------------------------------------------ helpers

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: code, message });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await request.text());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (e) {
    console.error("tryCreateProvider failed:", e);
    return null;
  }
}

/** Construct the provider lazily per request; null when env config is missing. */
function tryCreateProvider(): AtlasFlightProvider | null {
  try {
    return new AtlasFlightProvider();
  } catch (e) {
    console.error("tryCreateProvider failed:", e);
    return null;
  }
}

/**
 * GET /api/hackathon/health — configuration + reachability probe. Booleans and
 * numbers only (plus two documented, non-secret provenance strings) — secret
 * values are NEVER echoed. `time` is the server epoch-ms for clock drift
 * checks.
 *
 * CONFIGURED vs REACHABLE. The `*Configured` flags answer only "are the env
 * vars present?" — `activityConfigured` was literally
 * `Boolean(SUPABASE_URL && SUPABASE_KEY)`, so health stayed green through a
 * deleted Edge Function, a rotated key or an upstream outage. Each provider
 * now also reports what a LIVE probe found (see ./swarmReachability):
 *   • `<x>Reachable`  — the host answered within the timeout (any HTTP status)
 *   • `<x>Authorized` — that answer was not 401/403
 * Both keys are OMITTED when the provider is not configured, because "never
 * probed" and "probed and failed" are different facts and a `false` would
 * conflate them. The probes run CONCURRENTLY, are hard-bounded by a per-probe
 * timeout, are cached briefly, and never touch a billable endpoint.
 *
 * `storePersistent` reports env PRESENCE only; `storeHealthy` runs a live
 * `limit(1)` probe (probeSwarmStoreHealth) and catches stale / rotated service
 * keys — the standing early-warning for trip-load 503s.
 */
/**
 * Server-side kill switch for the whole swarm feature.
 *
 * The app reads this off `/health` and hides every entry point when it is off,
 * so the feature can be withdrawn from people already carrying the build —
 * a `wrangler deploy` away, with no App Store round trip. Defaults to ON: an
 * unset var must not silently disable a shipped feature.
 */
function swarmFeatureEnabled(): boolean {
  const raw = (process.env.SWARM_ENABLED ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

async function buildHealthSnapshot(): Promise<Record<string, unknown>> {
  // One round trip for the whole snapshot: the four live probes run together
  // rather than in series, so health stays fast when an upstream is slow.
  const [storeHealthy, atlas, hotel, activity] = await Promise.all([
    probeSwarmStoreHealth(),
    probeAtlasReachable(),
    probeHotelReachable(),
    probeActivityReachable(),
  ]);

  const reachability: Record<string, boolean> = {};
  for (const [name, verdict] of [
    ["atlas", atlas],
    ["hotel", hotel],
    ["activity", activity],
  ] as const) {
    if (!verdict) continue; // not configured — never probed, so say nothing
    reachability[`${name}Reachable`] = verdict.reachable;
    if (verdict.authorized !== undefined) {
      reachability[`${name}Authorized`] = verdict.authorized;
    }
  }

  // A quota refusal seen by a REAL lookup. The gateway probe above cannot
  // detect one: verified live on 2026-09-01, the RapidAPI root answers 404
  // whatever the key's state, while a real endpoint on that same key answered
  // 429 "exceeded the MONTHLY quota" — so `hotelAuthorized` said true while
  // every hotel price in the app was falling back to an estimate.
  //
  // ONE-WAY signal, deliberately. It is recorded by the real lookups (probing a
  // real endpoint here would spend a request from the budget that is running
  // out), and Worker isolates do not share module state — so a health request
  // may land on an isolate that never saw the refusal. Present ⇒ the rail is
  // definitely out of quota. Absent ⇒ nothing is claimed either way, which is
  // why `hotelAuthorizedMeaning` spells out what the green signal covers.
  const quotaNote = hotelQuotaNote();
  if (quotaNote !== null) {
    reachability.hotelQuotaExceeded = true;
  }

  return {
    ...(quotaNote !== null ? { hotelQuotaNote: quotaNote } : {}),
    ...(reachability.hotelAuthorized === true && quotaNote === null
      ? {
          hotelAuthorizedMeaning:
            "Credentials accepted by the RapidAPI gateway. This does NOT prove remaining quota: the gateway root answers 404 regardless, so a monthly cap is only visible once a real lookup is refused (hotelQuotaExceeded).",
        }
      : {}),
    // Env-PRESENCE probe only: true means the provider could be constructed
    // (ATLAS_API_KEY set) — it does NOT prove upstream reachability. See
    // `atlasReachable` / `atlasAuthorized` below for that.
    atlasConfigured: tryCreateProvider() !== null,
    // Host of the resolved Atlas base URL the live rails would actually hit.
    atlasSandboxHost: resolvedAtlasHost(),
    // Additive (trust-layer quality pass): honest sandbox-billing note —
    // mirrored verbatim in src/providers/atlas/README.md.
    atlasBillingNote:
      "Atlas sandbox billing is quota-based; fare search credits are not deducted per request — live usage with 100% credits is expected.",
    // The app gates its entire swarm surface on this.
    swarmEnabled: swarmFeatureEnabled(),
    geminiConfigured:
      typeof process.env.GEMINI_API_KEY === "string" &&
      process.env.GEMINI_API_KEY.trim().length > 0,
    hotelConfigured: rapidApiHotelConfigured(),
    activityConfigured: viatorEdgeConfigured(),
    storePersistent: swarmStoreIsPersistent(),
    storeHealthy,
    // Live reachability, present only for configured providers (see above).
    ...reachability,
    time: Date.now(),
  };
}

function newResolutionId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `res_${random.slice(0, 16)}`;
}

/** Uuid shape of real trips-table ids (demo ids like "demo-lisbon" fail). */
const TRIP_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeTripUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && TRIP_UUID_PATTERN.test(value);
}

/**
 * Maps a non-ok {@link SwarmTripLoadResult} to the wire error response:
 * store failures (ANY flavour — rotated keys, network, PostgREST errors)
 * become RETRYABLE 503 session_store_unavailable (iOS friendlyError already
 * maps this exact code — zero client changes); a missing row or unusable
 * content keeps the existing 404 trip_not_hydratable. null for `ok`.
 */
function tripLoadErrorResponse(result: SwarmTripLoadResult): Response | null {
  if (result.kind === "ok") return null;
  if (result.kind === "store_unavailable") {
    return errorResponse(
      503,
      "session_store_unavailable",
      "The trip service is temporarily unavailable — please retry in a moment.",
    );
  }
  // not_found / unhydratable — deterministic failures, retrying won't help.
  return errorResponse(
    404,
    "trip_not_hydratable",
    "We couldn't load this trip's itinerary — open the trip again and retry.",
  );
}

/** Deterministic confirmation code for locally recorded swarm bookings. */
function settlementBookingCode(resolutionId: string): string {
  return `SWARM-${resolutionId.replace(/^res_/i, "").slice(0, 6).toUpperCase()}`;
}

/**
 * Local booking RECORD used when the provider is missing or fails (approve is
 * best-effort — see module header). Satisfies BookingConfirmation with the
 * additive `status: "recorded"` / `source: "swarm_settlement"` markers.
 */
function localBookingRecord(resolutionId: string, flightId: string): BookingConfirmation {
  return {
    confirmationCode: settlementBookingCode(resolutionId),
    flightId,
    status: "recorded",
    bookedAt: new Date().toISOString(),
    source: "swarm_settlement",
  };
}

/** Execution context handed down by the Worker entry (async mission path). */
export interface HackathonContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Human-readable label used in the degraded plan's `impacted_nodes`. */
function describeNode(node: ItineraryNode): string {
  switch (node.type) {
    case "flight":
      return `Flight ${node.flightNumber}`;
    case "transfer":
      return "Transfer";
    case "hotel_check_in":
      return `Hotel Check-in (${node.hotelName})`;
    case "activity":
      return node.name;
  }
}

// ---------------------------------------------------------------- endpoints

export function isHackathonApiRequest(request: Request): boolean {
  try {
    return new URL(request.url).pathname.startsWith(HACKATHON_API_PREFIX);
  } catch (e) {
    console.error("tryCreateProvider failed:", e);
    return false;
  }
}

/**
 * Per-user gate for anything that touches a real trip.
 *
 * Returns a Response to REFUSE, or null to let the caller proceed. The app
 * bearer above proves which app is calling; this proves WHO, and that they may
 * see (or change) this particular trip. A Supabase outage answers 503 rather
 * than waving the caller through — an authorization check that fails open is
 * not a check.
 */
async function refuseUnlessTripAllowed(
  request: Request,
  tripId: string,
  need: "read" | "write",
): Promise<Response | null> {
  if (process.env.SWARM_REAL_TRIPS !== "1") return null;

  const actor = await resolveSwarmActor(request);
  if (actor.kind === "anonymous") {
    return errorResponse(
      401,
      "user_token_required",
      `Send the traveler's Supabase access token in ${USER_TOKEN_HEADER}.`,
    );
  }
  if (actor.kind === "invalid") {
    return errorResponse(
      401,
      "invalid_user_token",
      "That session is no longer valid — sign in again.",
    );
  }
  if (actor.kind === "unavailable") {
    return errorResponse(
      503,
      "auth_unavailable",
      "Could not verify your session. Try again shortly.",
    );
  }

  if (!tripId) return errorResponse(404, "unknown_trip", "That trip could not be found.");
  const access = await checkTripAccess(tripId, actor.userId);
  if (access.kind === "unavailable") {
    return errorResponse(503, "auth_unavailable", "Could not verify your access to this trip.");
  }
  // A trip the caller may not see must not be distinguishable from one that
  // does not exist — otherwise the API confirms which uuids are real.
  if (access.kind === "not_found" || access.kind === "forbidden") {
    return errorResponse(404, "unknown_trip", "That trip could not be found.");
  }
  if (need === "write" && !access.canEdit) {
    return errorResponse(
      403,
      "read_only_trip",
      "This trip is shared with you for viewing — ask its owner for edit access.",
    );
  }
  return null;
}

/** GET-allowed endpoints (SPEC §4.3): everything else is POST-only. */
const SWARM_STATUS_PREFIX = "swarm-status/";

/**
 * Single entry point called from src/server.ts. Guarantees a JSON Response
 * for every path — internal failures become structured 500s, never throws.
 */
export async function handleHackathonRequest(
  request: Request,
  ctx?: HackathonContext,
): Promise<Response> {
  try {
    // Real-trip rail guard: with SWARM_REAL_TRIPS=1 this mount can settle
    // plans onto REAL trips by uuid, so every caller must present the shared
    // bearer token (the demo Worker already gates + forwards it; iOS sends
    // it on every request). Fail-closed: a missing SWARM_DEMO_TOKEN refuses
    // the whole surface. Prod web never sets the flag, so its behaviour
    // stays byte-identical to before this gate existed.
    if (process.env.SWARM_REAL_TRIPS === "1") {
      const expected = process.env.SWARM_DEMO_TOKEN;
      const provided = request.headers.get("Authorization") ?? "";
      if (!expected || provided !== `Bearer ${expected}`) {
        return errorResponse(
          401,
          "unauthorized",
          "A valid Authorization: Bearer token is required for the real-trip swarm rail.",
        );
      }
    }

    const pathname = new URL(request.url).pathname;
    const endpoint = pathname.slice(HACKATHON_API_PREFIX.length).replace(/\/+$/, "");
    const method = request.method;

    // Hiding the button is not the same as turning the feature off: an older
    // build, or anything holding the token, would still reach these rails.
    // `health` stays reachable so the app can learn it is off.
    if (!swarmFeatureEnabled() && endpoint !== "health") {
      return errorResponse(503, "swarm_disabled", "The travel swarm is temporarily unavailable.");
    }

    // GET surface: live activity-stream polling, background-alert feed, health.
    if (
      endpoint.startsWith(SWARM_STATUS_PREFIX) ||
      endpoint === "alerts" ||
      endpoint === "health"
    ) {
      if (method !== "GET") {
        return errorResponse(
          405,
          "method_not_allowed",
          "This hackathon endpoint accepts GET only.",
        );
      }
      if (endpoint === "alerts") return await handleAlerts(request);
      if (endpoint === "health") return jsonResponse(200, await buildHealthSnapshot());
      return await handleSwarmStatus(request, endpoint.slice(SWARM_STATUS_PREFIX.length));
    }

    if (method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Hackathon endpoints accept POST only.");
    }
    switch (endpoint) {
      case "approve-resolution":
        return await handleApproveResolution(request);
      case "mission":
        return await handleMission(request, ctx);
      case "mission/assess":
        return await handleMissionAssess(request);
      case "mission/resolve":
        return await handleMissionResolve(request, ctx);
      case "mission/cancel":
        return await handleMissionCancel(request);
      case "booking-preview":
        return await handleBookingPreview(request);
      default:
        return errorResponse(404, "unknown_endpoint", `Unknown hackathon endpoint "${endpoint}".`);
    }
  } catch (error) {
    // Last-resort guard: nothing may escape to server.ts's HTML error page.
    console.error("[hackathon-api] unexpected failure", error);
    return errorResponse(500, "internal_error", "Unexpected hackathon API failure.");
  }
}

/**
 * POST /api/hackathon/booking-preview — real provider data for the trust layer.
 *
 * The client sends the lines its own checklist derived; this answers with what
 * Booking.com and Viator actually say about them. Read-only: nothing is booked,
 * nothing is charged, and the trip is not written to.
 */
async function handleBookingPreview(request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) return errorResponse(400, "invalid_body", "Request body must be a JSON object.");

  const tripId = typeof body.tripId === "string" ? body.tripId.trim() : "";
  if (!looksLikeTripUuid(tripId)) {
    return errorResponse(400, "trip_required", "tripId must be the uuid of an existing trip.");
  }
  // Reading a trip's prices is reading the trip.
  const refusal = await refuseUnlessTripAllowed(request, tripId, "read");
  if (refusal) return refusal;

  const rawLines = Array.isArray(body.lines) ? body.lines : null;
  if (!rawLines) {
    return errorResponse(400, "invalid_lines", "lines must be an array of checklist entries.");
  }
  const lines: PreviewLineRequest[] = [];
  for (const entry of rawLines.slice(0, 40)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const kind = record.kind;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!id || title.length === 0) continue;
    if (kind !== "stay" && kind !== "activity" && kind !== "transport" && kind !== "dining") {
      continue;
    }
    lines.push({
      id,
      kind,
      title,
      ...(typeof record.city === "string" ? { city: record.city } : {}),
      ...(typeof record.checkIn === "string" ? { checkIn: record.checkIn } : {}),
      ...(typeof record.nights === "number" ? { nights: record.nights } : {}),
      ...(typeof record.guests === "number" ? { guests: record.guests } : {}),
      ...(typeof record.date === "string" ? { date: record.date } : {}),
      ...(typeof record.estimate === "number" ? { estimate: record.estimate } : {}),
      ...(typeof record.currency === "string" ? { currency: record.currency } : {}),
    });
  }

  // The currency the CONFIRM SCREEN is denominated in. Every provider is asked
  // to quote in it so one purchase reads as one total; without it a Tokyo stay
  // comes back in JPY beside a Viator product in USD and the traveler is shown
  // three totals for one decision. Ignored unless it is a plausible ISO-4217
  // code — a junk value would make every provider fall back inconsistently.
  const rawQuote = typeof body.quoteCurrency === "string" ? body.quoteCurrency.trim() : "";
  const quoteCurrency = /^[A-Za-z]{3}$/.test(rawQuote) ? rawQuote.toUpperCase() : undefined;

  const preview = await buildBookingPreview(lines, quoteCurrency);
  return jsonResponse(200, preview);
}

async function handleApproveResolution(request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) {
    return errorResponse(400, "invalid_body", "Request body must be a JSON object.");
  }
  const resolutionId = body.resolutionId;
  if (typeof resolutionId !== "string" || resolutionId.trim().length === 0) {
    return errorResponse(400, "invalid_resolution_id", "resolutionId must be a non-empty string.");
  }
  // Trust Layer: a financial action requires explicit human approval.
  if (body.approved !== true) {
    return errorResponse(
      400,
      "invalid_approval",
      "Trust Layer requires explicit human approval: send approved: true.",
    );
  }
  // Two-phase plan selection (default 0). Sessions without `plans`
  // (legacy/alert path) fall back to `plan` and ignore the index.
  const planIndexRaw = body.planIndex;
  let planIndex = 0;
  if (planIndexRaw !== undefined) {
    if (typeof planIndexRaw !== "number" || !Number.isInteger(planIndexRaw) || planIndexRaw < 0) {
      return errorResponse(400, "invalid_plan_index", "planIndex must be a non-negative integer.");
    }
    planIndex = planIndexRaw;
  }
  /** Select the plan to book: plans[planIndex] when present, else `plan`. */
  const selectPlan = (record: {
    plan: ResolutionPlan | null;
    plans?: unknown;
  }): ResolutionPlan | null | "out_of_range" => {
    if (Array.isArray(record.plans) && record.plans.length > 0) {
      if (planIndex >= record.plans.length) return "out_of_range";
      return record.plans[planIndex] as ResolutionPlan;
    }
    return record.plan;
  };

  // Bookability pre-check BEFORE the one-shot claim: plans without a
  // replacement flight id (e.g. the swarm-monitor's proactive placeholder
  // plan) can never reach bookFlight. Peeking first keeps the session
  // unconsumed so a later bookable re-plan / retry can still proceed. The
  // peek also rejects sessions that already left the claimable states, so
  // the memory-tier (degraded-store) fallback never claims blind.
  //
  // The peek reads IGNORING expiry (WS1 diagnostics): a null read can mean
  // "unknown", "expired" or "store failure" — the three cases get distinct
  // responses (404 unknown_resolution / 410 session_expired /
  // 503 session_store_unavailable) instead of one opaque 404.
  const pendingLookup = await getSwarmSessionIgnoringExpiry(resolutionId);
  if (pendingLookup && "error" in pendingLookup) {
    return errorResponse(
      503,
      "session_store_unavailable",
      "The swarm session store is temporarily unavailable — please retry in a moment.",
    );
  }
  const pending = pendingLookup && "record" in pendingLookup ? pendingLookup.record : null;
  // Approval is the WRITE: it rewrites content_json and moves the budget, so
  // it needs edit rights on the trip, not merely knowledge of a resolution id.
  if (pending) {
    const approveRefusal = await refuseUnlessTripAllowed(request, pending.trip_id ?? "", "write");
    if (approveRefusal) return approveRefusal;
  }
  if (pending) {
    const operation = settlementOperation(pending);
    if (operation) {
      if (operation.plan_index !== planIndex) {
        return errorResponse(
          409,
          "approval_input_conflict",
          "A different plan was already approved for this resolution.",
        );
      }
      if (operation.receipt) return jsonResponse(200, operation.receipt);
      if (pending.state === "approved") {
        return errorResponse(
          409,
          "settlement_pending",
          "Approval is recorded; the booking outcome is still being checked. Do not create another booking. Refresh this resolution's status.",
        );
      }
    }
    // Session-level expiry: the TTL elapsed or the user cancelled the
    // session (cancel transitions it to `expired`).
    if (pending.state === "expired" || pending.expires_at <= new Date().toISOString()) {
      return errorResponse(
        410,
        "session_expired",
        "Your swarm session expired — start a new mission to get fresh quotes.",
      );
    }
    if (pending.state !== "proposal_ready" && pending.state !== "awaiting_approval") {
      return errorResponse(
        404,
        "unknown_resolution",
        `Session "${resolutionId}" is in state "${pending.state}" and cannot be approved again.`,
      );
    }
    const pendingSelected = selectPlan(pending);
    if (pendingSelected === "out_of_range") {
      return errorResponse(
        400,
        "invalid_plan_index",
        `planIndex ${planIndex} is out of range for session "${resolutionId}".`,
      );
    }
    if (pending.degraded) {
      return errorResponse(
        409,
        "degraded_plan_not_bookable",
        "This plan was assembled without verified providers. Re-run the mission when providers are available.",
      );
    }
    if (!pendingSelected || !validateResolutionPlan(pendingSelected)) {
      return errorResponse(
        409,
        "plan_not_bookable",
        "This proposal is incomplete or inconsistent. Re-run the mission to get a valid plan.",
      );
    }
    // Trust Layer TTL gate (spec §3.5) — server-side enforcement: expired
    // quotes are never bookable, regardless of the client countdown state.
    // Presence-only gate: plans without expires_at approve as before.
    const planExpiresAt = pendingSelected?.expires_at;
    if (typeof planExpiresAt === "number" && planExpiresAt <= Date.now()) {
      return errorResponse(
        410,
        "quotes_expired",
        "The quotes in this plan have expired; re-run the mission to get fresh prices.",
      );
    }
    // NOTE: flight-less plans are bookable (hotel/activity/transfer
    // settlements never call the flight provider) — the old flight-only
    // 409 pre-check was removed; the degraded gate below stays.
  }

  // Store operation identity in the same atomic claim as approval. A lost
  // response can be recovered without starting a second provider operation.
  const approvalCandidates = {
    ...(pending?.candidates && typeof pending.candidates === "object" ? pending.candidates : {}),
    settlement_operation: {
      operation_id: resolutionId,
      plan_index: planIndex,
      started_at: new Date().toISOString(),
    },
  };
  const entry = await claimSwarmSessionForBooking(resolutionId, approvalCandidates);
  if (!entry || !entry.plan) {
    return errorResponse(
      404,
      "unknown_resolution",
      `No pending plan for "${resolutionId}" (unknown, expired, or already settled).`,
    );
  }
  // Degraded plans propose the provider fallback flight (XY999) — they must
  // never reach the real sandbox booking API.
  if (entry.degraded) {
    return errorResponse(
      409,
      "degraded_plan_not_bookable",
      "This plan was simulated without a live flight provider and cannot be booked; re-run the mission once the provider is configured.",
    );
  }
  const claimedSelected = selectPlan(entry);
  if (!claimedSelected || claimedSelected === "out_of_range") {
    return errorResponse(
      400,
      "invalid_plan_index",
      `planIndex ${planIndex} could not be resolved for session "${resolutionId}".`,
    );
  }
  const plan = claimedSelected;

  const bookingCode = settlementBookingCode(resolutionId);

  // ── Booking: only FLIGHT disruptions reach the booking rail. Plans with
  // an operational layer settle the trip; a non-flight disruption settles
  // the trip only and gets a locally recorded stub (the provider is never
  // asked to "book" an activity/hotel node id). Plans without an
  // operational layer keep the flight-booking contract.
  const flightDisruption = plan.operational
    ? plan.operational.disrupted?.kind === "flight" && plan.operational.new_flight != null
    : true;
  const flightId = plan.proposed_resolution?.new_flight?.id ?? "";
  let booking: BookingConfirmation;
  let bookingRecorded = false;
  if (!flightDisruption) {
    booking = localBookingRecord(
      resolutionId,
      flightId || plan.operational?.disrupted?.nodeId || "n/a",
    );
  } else {
    const provider = tryCreateProvider();
    // Indicative fallback ids are not Atlas routing identifiers. Approval
    // applies the complete recovery plan and records its settlement, but must
    // never send a fabricated identifier to verify.do/order.do.
    if (flightId.startsWith("SYNTHETIC-RECOVERY-")) {
      booking = localBookingRecord(resolutionId, flightId);
    } else if (provider) {
      try {
        booking = await provider.bookFlight(flightId);
        bookingRecorded = true;
      } catch (error) {
        if (error instanceof AtlasApiError) {
          // The raw upstream message stays server-side (logs only).
          console.warn(`[hackathon-api] booking failed (${error.kind}):`, error.message);
        } else {
          console.warn("[hackathon-api] booking failed:", error);
        }
        booking = localBookingRecord(resolutionId, flightId);
      }
    } else {
      booking = localBookingRecord(resolutionId, flightId);
    }
  }

  // ── Settle the plan onto the REAL trip (uuid trip + operational layer).
  //
  // AFTER the booking attempt, never before: the trip write is the record of
  // what happened, so it has to know what happened. Writing first stamped the
  // leg as booked and THEN asked the provider — a failed order left the trip
  // claiming a ticket that did not exist. Best-effort: a conflict or load
  // failure only skips the trip write.
  let updatedContent: Record<string, unknown> | undefined;
  let settlementChanges: string[] = [];
  let tripUpdated = false;
  let conflictSkipped = false;
  // Clarity pass: post-write content rev (additive) + honest skip reporting.
  let settledContentRev: number | undefined;
  let flightRewriteSkipped = false;
  let flightSkipReason: "already_settled" | "leg_not_found" | undefined;
  let settlementFollowUps: SettlementFollowUp[] = [];
  if (plan.operational && looksLikeTripUuid(entry.trip_id)) {
    const tripLoad = await loadSwarmTrip(entry.trip_id);
    // Proceed ONLY on a successful hydration: any other kind (store failure,
    // missing row, unusable content) best-effort-skips the trip write — the
    // sentinel must never feed undefined nodeRefs into the settlement path.
    if (tripLoad.kind === "ok") {
      const settled = await settlePlanOnTrip(entry.trip_id, tripLoad.trip.nodeRefs, plan, {
        ...plan.operational,
        bookingCode,
        ...(flightDisruption ? { booking_status: booking.status === "confirmed" ? "confirmed" : "recorded" } : {}),
      });
      if (settled && "updatedContent" in settled) {
        // "Updated" means something actually LANDED — not merely that the
        // settlement function handed back a content object. A mission that
        // found no replacement flight, moved no activity and touched no hotel
        // still reached here and reported `trip_updated: true` with an empty
        // `changes` list and an unmoved content_rev: the traveler was told
        // their trip had been rewritten when nothing had been written.
        tripUpdated = settled.changes.length > 0 || settled.flightRewriteLanded === true;
        updatedContent = settled.updatedContent;
        settlementChanges = settled.changes;
        settledContentRev = settled.contentRev;
        settlementFollowUps = settled.followUps ?? [];
        // Honest settlement: a flight plan whose leg already carried this
        // booking code (or whose leg can no longer be located) is NOT
        // rewritten again — never report it as applied. `trip_updated` only
        // drops to false when NOTHING at all landed; when other changes
        // (hotel/activity) settled in the same write, the trip really was
        // updated and the flight-specific note is appended alongside.
        if (
          plan.operational.new_flight != null &&
          plan.operational.disrupted?.kind === "flight" &&
          settled.flightRewriteLanded !== true
        ) {
          flightRewriteSkipped = true;
          flightSkipReason = settled.flightSkipReason;
          // `tripUpdated` is already derived from what landed, above.
        }
      } else if (settled && settled.conflict) {
        conflictSkipped = true;
      }
    }
  }

  const needsFollowUp =
    settlementFollowUps.length > 0 ||
    plan.proposed_resolution.hotel_adjustments?.some(adjustment => adjustment.requires_confirmation === true) === true ||
    conflictSkipped ||
    flightRewriteSkipped ||
    !tripUpdated ||
    (flightDisruption && (!bookingRecorded || booking.status !== "confirmed"));
  const responseBody = {
    approved: true,
    booking,
    plan,
    // Additive (two-phase): which plan of the session was booked.
    plan_index: planIndex,
    ...(updatedContent !== undefined ? { updated_content: updatedContent } : {}),
    settlement: {
      needs_follow_up: needsFollowUp,
      // Itemized: exactly what the traveller still has to do, and nothing
      // else. A generic "needs follow-up" flag left people re-validating
      // bookings the settlement had already made.
      ...(settlementFollowUps.length > 0 ? { follow_ups: settlementFollowUps } : {}),
      ...(flightDisruption && (!bookingRecorded || booking.status !== "confirmed")
        ? {
            note: "The itinerary result does not confirm ticket issuance. Check the provider outcome before making another reservation.",
          }
        : plan.proposed_resolution.hotel_adjustments?.some(adjustment => adjustment.requires_confirmation)
          ? { note: "Hotel terms remain unverified. Contact the property to confirm availability, late arrival and any fees." }
          : {}),
      trip_updated: tripUpdated,
      changes: settlementChanges,
      booking_recorded: bookingRecorded,
      // Additive (clarity pass): the post-write content revision so the
      // client's local trip copy can adopt the DB rev without a re-fetch.
      ...(settledContentRev !== undefined ? { content_rev: settledContentRev } : {}),
      ...(conflictSkipped
        ? {
            conflict_skipped: true as const,
            // Human-readable companion for iOS to surface when the trip
            // write was skipped because another device edited it first.
            note: "Your trip changed elsewhere — review the updated itinerary",
          }
        : {}),
      // Honest skip note: distinguishes WHY the flight rewrite did not
      // land. `trip_updated` is false only when nothing at all settled.
      ...(flightRewriteSkipped
        ? {
            note:
              flightSkipReason === "leg_not_found"
                ? "Flight leg could not be located in the itinerary — flight part not written"
                : "Flight already settled with this booking — no flight changes written",
          }
        : {}),
    },
  };
  // Do not persist a second full copy of content_json. Replayed receipts tell
  // clients to refresh the trip using the existing trip_updated flag.
  const { updated_content: _content, ...receipt } = responseBody;
  if (!(await saveSwarmSettlementReceipt(entry, receipt))) {
    return errorResponse(
      503,
      "settlement_receipt_pending",
      "Approval was submitted but its receipt could not be saved. Do not book again; refresh this resolution to check its outcome.",
    );
  }
  return jsonResponse(200, responseBody);
}

// --------------------------------------------------------------- simulation

/** Trace-builder helper for the Swarm Activity Stream (SPEC §4.2).
 * Optional `onEntry` fires after EACH append so callers can persist trace
 * rows incrementally (progressive activity streaming to the polling app). */
function makeTracePusher(trace: SwarmTraceEntry[], onEntry?: (entry: SwarmTraceEntry) => void) {
  return (agent: string, step: string, detail: string): void => {
    const entry: SwarmTraceEntry = { agent, step, detail, at: new Date().toISOString() };
    trace.push(entry);
    onEntry?.(entry);
  };
}

/** User-facing dispatch detail: prefers the hydrated node's human label. */
function disruptionDispatchDetail(options: SwarmRunOptions): string {
  const label = options.hydrated?.nodeRefs[options.nodeId]?.label ?? options.nodeId;
  return `${options.origin} disruption detected on ${label}`;
}

interface SwarmRunOptions {
  nodeId: string;
  delayMinutes: number;
  description: string;
  origin: "reactive" | "proactive";
  /** Owning trip (SPEC §3.2 DisruptionEvent.tripId) — always a real uuid. */
  tripId: string;
  /** Weather hint for proactive missions (drives outdoor→indoor swaps). */
  weatherHint?: "clear" | "rain" | "storm" | "extreme_heat";
  /** Explicit evidence (real-trip missions); falls back to the weather auto-evidence. */
  evidence?: {
    kind: "weather" | "event" | "user_report";
    source: string;
    confidence: number;
    detail: string;
  };
  /**
   * ISO-4217 code the CLIENT wants the money shown in — the traveller's
   * app-wide display preference, which is often neither the trip's currency
   * nor any provider's. Drives `financial_delta.display`; absent ⇒ the trip's.
   */
  displayCurrency?: string;
  /** Hydrated REAL trip; optional only while persisted options are rebuilt. */
  hydrated?: HydratedTrip | null;
  /** Atlas fare-rule blob when available — wires the PolicyAgent gate. */
  fareRule?: Record<string, unknown>;
  /** Parsed mission category from swarmIntent (e.g. distinguishes a hotel
   *  that OVERBOOKED the traveler — nothing left to "keep" — from a hotel
   *  whose arrival time merely shifted). Trace/UI metadata only, same as
   *  {@link TripMissionOptions.kind}; not part of the DisruptionEvent. */
  category?: TripMissionCategory;
}

interface SwarmRunResult {
  plan: ResolutionPlan;
  degraded: boolean;
  trace: SwarmTraceEntry[];
}

/**
 * Shared specialist/orchestrator construction behind runSwarmResolution,
 * runSwarmAssessment and runMultiResolution. Returns null when the Atlas
 * provider is missing. Flight missions still receive a FlightAgent whose
 * internal synthesizer is the final recovery rung. Emits the SAME skip/default
 * trace rows the inlined version did, in the same order.
 */
function buildSwarmOrchestrator(
  options: SwarmRunOptions,
  pushTrace: (agent: string, step: string, detail: string) => void,
  flags?: {
    /**
     * Task 21: wire the quota-aware retry (exactly ONE retry on 429/503)
     * into the DayReorganizer. Only the ASYNC resolve rail sets this — the
     * assess + sync rails keep the default single-shot behavior.
     */
    geminiRetry?: boolean;
    /**
     * Task 25 (#3): wire the Gemini DayReorganizer AT ALL. Only the async
     * RESOLVE rail (runMultiResolution) sets this — the assess rail must
     * perform ZERO new network I/O (no Gemini ≤3, no Viator day-reorg
     * consults) to honor "zero new I/O on assess" and the 20 s iOS timeout
     * budget. Absent/false ⇒ the orchestrator runs without a reorganizer
     * (the activity fan-out falls back to the chronological rail).
     */
    dayReorg?: boolean;
    usageResolutionId?: string;
    geminiBudget?: GeminiCallBudget;
  },
): {
  orchestrator: OrchestratorAgent;
  graph: ItineraryGraph;
  fareRule: Record<string, unknown>;
} | null {
  const provider = tryCreateProvider();
  if (!options.hydrated) return null;
  // Clarity pass: non-flight missions run LIVE without an Atlas provider.
  // Only a FLIGHT disruption needs a FlightAgent. When Atlas is absent the
  // agent still runs: its deterministic fallback guarantees a structured
  // recovery option while preserving indicative provenance.
  const disruptedNode = options.hydrated.graph.getNode(options.nodeId);
  if (disruptedNode === undefined) return null;
  if (!provider) {
    pushTrace("flight", "skipped", "flight agent not needed for this mission kind");
  }
  // Every mission runs on the HYDRATED trip graph. A NEW graph reference per
  // hydration keeps handleDisruption's in-place mutation from leaking across
  // requests (loadSwarmTrip hydrates fresh on every call).
  const graph = options.hydrated.graph;
  // Phase B wiring fix: the PolicyAgent ALWAYS runs. Missions pass through
  // any Atlas-provided fare-rule payload; a hydrate without a rule blob
  // falls back to the clearly-labelled fallbackFareRule() so the policy gate
  // is never skipped. With a real rule the verdict is rule-grounded; the
  // fallback keeps the rail deterministic (rebook permitted, 25 EUR change
  // fee).
  const fareRule = options.fareRule ?? fallbackFareRule(options.hydrated?.meta.currency);
  const policyAgent = new PolicyAgent();
  const hotelAgent = rapidApiHotelConfigured() ? new HotelAgent(new RapidApiHotelProvider()) : null;
  const activityAgent = viatorEdgeConfigured()
    ? new ActivityAgent(new ViatorActivityProvider())
    : null;
  // W2: the Gemini day reorganizer is only useful when the activity rail is
  // live (its decisions convert into proposals via the ActivityAgent). It
  // degrades TOTALLY on its own — a missing GEMINI_API_KEY simply selects
  // the deterministic greedy fallback for every day. Task 21: per-mission
  // call budget (GEMINI_CALLS_PER_MISSION) + the quota-aware retry are
  // wired here — the retry rides ONLY on the async resolve rail (flags).
  // Task 25 (#3): the reorganizer is wired ONLY on the async resolve rail
  // (flags.dayReorg) — assess must stay network-free.
  const dayReorganizer =
    activityAgent && flags?.dayReorg
      ? new DayReorganizer({
          callBudget: GEMINI_CALLS_PER_MISSION,
          sharedBudget: flags?.geminiBudget,
          ...(flags?.usageResolutionId
            ? { onUsage: geminiUsageLogger(flags.usageResolutionId, "activity") }
            : {}),
          ...(flags?.geminiRetry ? { maxRetries: GEMINI_QUOTA_RETRIES } : {}),
        })
      : null;
  if (!options.fareRule) {
    // Honest wording: this is a PLACEHOLDER, and it is replaced the moment the
    // provider publishes a rule for the fare actually being quoted (see the
    // re-assessment in OrchestratorAgent). It used to assert "change fee
    // 25 EUR" outright, which read as the airline's own policy.
    pushTrace(
      "policy",
      "fare_rule_default",
      "no fare rule supplied yet — using a labelled default until the provider publishes one",
    );
  }
  if (!hotelAgent) {
    pushTrace("hotel", "skipped", "hotel price protection unavailable — hotel changes not offered");
  }
  if (!activityAgent) {
    pushTrace("activity", "skipped", "activity rescheduling unavailable for this trip");
  }
  const weatherProvider = openWeatherConfigured() ? new OpenWeatherProvider() : null;
  const eventProvider = predictHQConfigured() ? new PredictHQProvider() : null;

  if (!weatherProvider) {
    pushTrace("orchestrator", "skipped", "live weather monitoring unavailable");
  }
  if (!eventProvider) {
    pushTrace("orchestrator", "skipped", "local event tracking unavailable");
  }

  const orchestrator = new OrchestratorAgent(
    graph,
    // Live-Atlas config (longer fare deadline — real verify.do pricing takes
    // several seconds; capped candidate fan-out). Null when no provider is
    // configured (non-flight missions run live without it).
    provider || disruptedNode.type === "flight"
      ? new FlightAgent(provider, SWARM_FLIGHT_AGENT_CONFIG)
      : null,
    policyAgent,
    hotelAgent,
    activityAgent,
    weatherProvider,
    eventProvider,
    dayReorganizer,
  );
  return { orchestrator, graph, fareRule };
}

/** Shared DisruptionEvent assembly for every swarm rail (legacy + two-phase). */
function buildDisruptionEvent(
  options: SwarmRunOptions,
  fareRule?: Record<string, unknown>,
): DisruptionEvent {
  // Explicit evidence wins; otherwise proactive weather missions carry
  // the auto-evidence built from the intent description.
  const evidence =
    options.evidence ??
    (options.origin === "proactive" && options.weatherHint
      ? {
          kind: "weather" as const,
          source: "mission-intent",
          confidence: 0.6,
          detail: options.description,
        }
      : undefined);
  return {
    nodeId: options.nodeId,
    delay: options.delayMinutes,
    description: options.description,
    origin: options.origin,
    tripId: options.tripId,
    ...(fareRule ? { fareRule } : {}),
    // These two missions ASK for fewer activities, so the reorganizer is
    // allowed to drop one instead of being forced to keep everything.
    ...(options.category === "unwell" || options.category === "activity_cancelled"
      ? { allowsActivityDrops: true }
      : {}),
    ...(evidence ? { evidence } : {}),
    // Hydrated-trip context scopes the specialist provider searches.
    ...(options.hydrated
      ? {
          tripContext: {
            city: options.hydrated.meta.city,
            currency: options.hydrated.meta.currency,
            // The traveller's own display preference, when the client sent it.
            ...(options.displayCurrency ? { displayCurrency: options.displayCurrency } : {}),
          },
        }
      : {}),
  };
}

/**
 * fare_basis trace detail (additive step): HONEST wording for what the
 * priced candidate's amount measures — a true delta against a known
 * original fare, or the full verified re-price when the original is unknown.
 * Only called when the rebooking assessment is non-null.
 */
/**
 * The Activity Stream row explaining an empty flight search.
 *
 * The stream is where a sceptical traveller looks to see whether the swarm
 * actually did the work. "0 alternative flight options found" told them the
 * search ran and stopped there — it never said whether the partner had nothing,
 * or whether our own rules threw away everything the partner offered. Those
 * are opposite conclusions and only one of them means "go book it yourself".
 *
 * Returns null when a replacement WAS found; there is nothing to explain.
 */
/**
 * Build the traveller-facing explanation for an empty flight search.
 *
 * Mirrors {@link noReplacementDetail} (the Activity Stream row) but written for
 * someone deciding what to do next rather than auditing what the swarm did.
 * Returns undefined when a replacement was found.
 */
function noFlightReasonFor(
  assessment: FlightRebookingAssessment | null,
  route: string | undefined,
): NonNullable<ResolutionPresentation["no_flight_reason"]> | undefined {
  const reason = assessment?.noReplacementReason;
  if (!reason) return undefined;
  // "on JFK → FLR" reads as a place, not a route. Name the route directly.
  const where = route ? ` ${route}` : " this route";
  switch (reason) {
    case "route_not_covered":
      return {
        kind: "partner_coverage",
        summary:
          `Our flight partner doesn't cover${where} yet, so we can't rebook it ` +
          `for you. You'll need to arrange this flight change with the airline directly — ` +
          `everything else in this plan still applies.`,
        ...(route ? { route } : {}),
      };
    case "all_options_rejected":
      return {
        kind: "all_too_late",
        summary:
          `We found flights on${where}, but every one leaves too late to still count as a ` +
          `rebooking — taking one would mean replanning the rest of your trip around it.`,
        ...(route ? { route } : {}),
      };
    case "pricing_unavailable":
      return {
        kind: "pricing_unavailable",
        summary: `We found flights on${where} but couldn't price them just now. Worth trying again shortly.`,
        ...(route ? { route } : {}),
      };
    case "search_declined":
      return {
        kind: "none_on_date",
        summary:
          `We couldn't run the flight search for${where} — ` +
          `${assessment?.searchDeclinedReason ?? "the provider declined the request"}. ` +
          `This change needs to be booked manually.`,
        ...(route ? { route } : {}),
      };
    case "no_options_on_date":
      return {
        kind: "none_on_date",
        summary: `No flights came back for${where} on this date. This change needs to be booked manually.`,
        ...(route ? { route } : {}),
      };
  }
}

/** "SIN → FCO" for the disrupted leg, when the graph knows it. */
function routeLabelOf(graph: ItineraryGraph, nodeId: string): string | undefined {
  const node = graph.getNode(nodeId);
  if (!node || node.type !== "flight") return undefined;
  return node.origin && node.destination ? `${node.origin} → ${node.destination}` : undefined;
}

function noReplacementDetail(assessment: FlightRebookingAssessment): string | null {
  const reason = assessment.noReplacementReason;
  if (reason === undefined) return null;
  const dates = assessment.searchedDates?.length ?? 0;
  switch (reason) {
    case "route_not_covered":
      return (
        `partner has no inventory on this route — 0 options across ${dates} date(s); ` +
        `this destination isn't in Atlas's coverage yet, so the change must be booked ` +
        `with the airline directly`
      );
    case "no_options_on_date":
      return "0 options on the searched date — not enough to tell coverage from availability";
    case "all_options_rejected":
      return (
        `partner returned ${assessment.providerOptionCount ?? 0} option(s), but none ` +
        `qualified as a usable replacement; the recovery synthesizer should provide the structured fallback`
      );
    case "pricing_unavailable":
      return (
        `${assessment.providerOptionCount ?? 0} option(s) found, but none could be priced` +
        (assessment.pricingFailureDetail ? ` — ${assessment.pricingFailureDetail}` : "")
      );
    case "search_declined":
      return (
        `provider declined the search — ` +
        `${assessment.searchDeclinedReason ?? "no reason given"}; this says nothing about coverage`
      );
  }
}

function fareBasisDetail(assessment: FlightRebookingAssessment): string {
  const fare = assessment.bestCandidate?.fareDifference;
  if (fare?.basis === "synthetic_estimate") {
    return `indicative fallback estimate: +${fare.amount} ${fare.currency}; provider confirmation pending`;
  }
  if (fare?.basis === "fare_difference") {
    return `fare basis: original ${fare.originalFare} ${fare.currency} for ${fare.adults ?? 1} pax`;
  }
  return "original fare unknown — quoting full verified re-price as the charge";
}

function usesSyntheticRecovery(assessment: FlightRebookingAssessment | null): boolean {
  return assessment?.bestCandidate?.option.inventorySource === "synthetic_recovery";
}

function markSyntheticPlan(plan: ResolutionPlan): ResolutionPlan {
  const canary = "(simulated — flight provider unavailable)";
  const marked = plan.incident.includes(canary) ? plan : { ...plan, incident: `${plan.incident} ${canary}` };
  // An estimate nobody sold was compared against nothing: "cheapest" and
  // "earliest arrival" are claims about real inventory it never saw. Only the
  // descriptive tags (non-stop, same day) survive.
  const comparative = new Set(["cheapest", "fastest", "balanced"]);
  const kept = (marked.badges ?? (marked.badge ? [marked.badge] : [])).filter((b) => !comparative.has(b));
  const { badge: _badge, badges: _badges, ...rest } = marked;
  return {
    ...rest,
    ...(kept.length > 0 ? { badges: kept, badge: kept[0] } : {}),
  } as ResolutionPlan;
}

function flightSearchTraceDetail(assessment: FlightRebookingAssessment): string {
  return usesSyntheticRecovery(assessment)
    ? `${assessment.candidates.length} structured recovery option produced (indicative fallback)`
    : `${assessment.candidates.length} alternative flight options found (live Atlas sandbox)`;
}

/**
 * atlas_liveness trace detail (ADDITIVE step — new key, existing trace
 * agent/step keys untouched): quotes the Atlas sandbox correlation ids the
 * provider captured (search.do envelope id + each verify.do envelope id),
 * truncated to 12 chars each. Returns null when the assessment carries NO
 * correlation ids — degraded/simulated rails never emit this row.
 */
function atlasLivenessDetail(assessment: FlightRebookingAssessment): string | null {
  const correlation = assessment.atlasCorrelation;
  if (!correlation) return null;
  const truncate = (id: string): string => id.slice(0, 12);
  const parts: string[] = [];
  if (correlation.searchRequestId !== undefined) {
    parts.push(`search ${truncate(correlation.searchRequestId)}`);
  }
  if (correlation.verifyRequestIds.length > 0) {
    parts.push(`verify ${correlation.verifyRequestIds.map(truncate).join(",")}`);
  }
  if (parts.length === 0) return null;
  return `Atlas sandbox live — ${parts.join(" · ")}`;
}

/**
 * flex_date_search trace detail (ADDITIVE step — new key, existing trace
 * agent/step keys untouched): the flexible-date window searched ONE calendar
 * date per provider call, so the stream names how many dates were attempted
 * for the route. Returns null unless the assessment carries a multi-date
 * `searchedDates` record (legacy single-search rails never emit this row).
 */
function flexDateSearchDetail(
  assessment: FlightRebookingAssessment,
  origin?: string,
  destination?: string,
): string | null {
  const searchedDates = assessment.searchedDates;
  if (!searchedDates || searchedDates.length <= 1) return null;
  const route = origin && destination ? ` ${origin} → ${destination}` : "";
  return `searched ${searchedDates.length} date(s)${route} for replacements`;
}

/**
 * Ledger trace detail: one segment per by_currency bucket joined by ` · `,
 * e.g. `+175 −0 = 175 EUR net · +50 −0 = 50 USD net`. Plans without the
 * additive buckets (pre-extension shapes) fall back to the legacy triple
 * labelled with the plan currency.
 */
function ledgerBalancedDetail(delta: FinancialDelta, fallbackCurrency: string | undefined): string {
  const buckets =
    delta.by_currency && delta.by_currency.length > 0
      ? delta.by_currency
      : [
          {
            currency: fallbackCurrency ?? "",
            total_refund: delta.total_refund,
            total_new_charges: delta.total_new_charges,
            net_payable: delta.net_payable,
          },
        ];
  return buckets
    .map((bucket) =>
      // The fallback bucket may carry NO currency (pre-extension plan and
      // no plan.currency) — then the trailing currency token is skipped
      // instead of emitting an empty token with a double space.
      bucket.currency.length > 0
        ? `+${bucket.total_new_charges} −${bucket.total_refund} = ${bucket.net_payable} ${bucket.currency} net`
        : `+${bucket.total_new_charges} −${bucket.total_refund} = ${bucket.net_payable} net`,
    )
    .join(" · ");
}

/**
 * Run the full agentic pipeline on the hydrated real-trip graph (SPEC §2.2
 * flow: Policy → Flight → Hotel → Activity → Trust Layer). Degrades
 * gracefully when the Atlas provider is missing or fails mid-flight (see
 * module header); the Policy/Hotel/Activity specialists are constructed ONLY
 * behind their configured-guards and passed as null otherwise, so the
 * orchestrator falls back to its pre-swarm behaviour for whichever provider
 * is absent.
 * The emitted trace feeds the Swarm Activity Stream (SPEC §4.2/§4.3).
 */
async function runSwarmResolution(
  options: SwarmRunOptions,
  hooks?: { onTrace?: (entry: SwarmTraceEntry) => void },
): Promise<SwarmRunResult> {
  const trace: SwarmTraceEntry[] = [];
  const pushTrace = makeTracePusher(trace, hooks?.onTrace);

  const built = buildSwarmOrchestrator(options, pushTrace);
  if (built) {
    try {
      const { orchestrator, graph, fareRule } = built;
      // The itinerary as the traveller PLANNED it, captured before any
      // propagation touches it. `graph` is the very object the orchestrator
      // mutates, so asking it afterwards what a late arrival costs answers
      // "nothing" — the hotel has already been re-timed to match the arrival
      // being judged.
      const plannedItinerary = graph.clone();
      pushTrace("orchestrator", "dispatch", disruptionDispatchDetail(options));
      const {
        plan,
        disruption,
        rebookingAssessment,
        hotelAdjustments,
        activityProposals,
        policyVerdict,
      } = await orchestrator.resolveDisruption(buildDisruptionEvent(options, fareRule));
      // The disrupted node's route labels the additive flex_date_search trace.
      const sourceNode = graph.getNode(options.nodeId);
      if (validateResolutionPlan(plan)) {
        pushTrace(
          "orchestrator",
          "impact_surface",
          `${disruption.affected.length} downstream nodes affected`,
        );
        if (policyVerdict) {
          pushTrace(
            "policy",
            "fare_rules",
            policyVerdict.rebookPermitted
              ? `rebook permitted, change fee ${policyVerdict.changeFee} ${policyVerdict.currency}` +
                  ruleSourceSuffix(policyVerdict)
              : `rebook denied — ${policyVerdict.recommendedAction.replace(/_/g, " ")}`,
          );
        }
        if (rebookingAssessment) {
          pushTrace("flight", "search", flightSearchTraceDetail(rebookingAssessment));
          const whyEmpty = noReplacementDetail(rebookingAssessment);
          if (whyEmpty) pushTrace("flight", "coverage", whyEmpty);
          // Additive: the flexible-date window attempted one search per
          // calendar date — name the covered dates for the disrupted route.
          const flexSearch = flexDateSearchDetail(
            rebookingAssessment,
            sourceNode?.type === "flight" ? sourceNode.origin : undefined,
            sourceNode?.type === "flight" ? sourceNode.destination : undefined,
          );
          if (flexSearch !== null) {
            pushTrace("flight", "flex_date_search", flexSearch);
          }
          pushTrace("flight", "fare_basis", fareBasisDetail(rebookingAssessment));
          // Additive liveness proof: quotes the sandbox correlation ids the
          // provider captured (absent on degraded rails — never fabricated).
          const liveness = atlasLivenessDetail(rebookingAssessment);
          if (liveness !== null) {
            pushTrace("flight", "atlas_liveness", liveness);
          }
        }
        for (const adjustment of hotelAdjustments) {
          pushTrace(
            "hotel",
            adjustment.action === "none" ? "keep_as_is" : adjustment.action,
            `${adjustment.hotel_name} ${adjustment.action.replace(/_/g, " ")}, fee ${adjustment.fee}`,
          );
        }
        for (const proposal of activityProposals) {
          const node = graph.getNode(proposal.activityNodeId);
          const name = node && node.type === "activity" ? node.name : proposal.activityNodeId;
          const newTime = new Date(proposal.newTime);
          const slot = Number.isNaN(newTime.getTime())
            ? proposal.newTime
            : `${newTime.toISOString().slice(0, 10)} ${newTime.toISOString().slice(11, 16)}`;
          pushTrace(
            "activity",
            proposal.action,
            proposal.swap
              ? `${name} → ${proposal.swap.replacementName} (${proposal.action}), penalty ${proposal.penalty}`
              : proposal.action === "drop"
                ? `${name} cancelled out of the day, penalty ${proposal.penalty}`
                : `${name} → ${slot}, penalty ${proposal.penalty}`,
          );
        }
        // W2 additive trace rows: day reorganization + Viator slot checks.
        pushActivityReorgTraces(activityProposals, pushTrace);
        // B1.4 — surface the money agent in the Activity Stream: one finance
        // trace row proving the ledger balanced after Trust Layer validation
        // (per-currency segments — segregation, never conversion).
        pushTrace(
          "finance",
          "ledger_check",
          `ledger balanced: ${ledgerBalancedDetail(plan.financial_delta, plan.currency)}`,
        );
        // Real-trip missions attach the additive operational layer that
        // approve-resolution uses to settle the plan onto content_json.
        const operational = options.hydrated
          ? buildOperational(options, options.hydrated, {
              disruption,
              rebookingAssessment,
              hotelAdjustments,
              activityProposals,
            })
          : null;
        // Disclosure by construction: preview the settlement, then show every
        // hotel decision it will write.
        const disclosedPlan = mirrorOperationalHotels(plan, options.hydrated, operational);
        const preview = previewSettlement(options.hydrated, disclosedPlan, operational);
        // B3 — assemble the display-only presentation layer in ONE place from
        // the validated specialist outputs (omitted entirely on degraded plans).
        const presentation = buildPresentation({
          plan: disclosedPlan,
          preview,
          best: rebookingAssessment?.bestCandidate ?? null,
          hotelAdjustments,
          activityProposals,
          graph: plannedItinerary,
          disruptedId: options.nodeId,
          ...(() => {
            const r = noFlightReasonFor(
              rebookingAssessment ?? null,
              routeLabelOf(plannedItinerary, options.nodeId),
            );
            return r ? { noFlight: r } : {};
          })(),
        });
        const assembledPlan: ResolutionPlan = {
          ...disclosedPlan,
          ...(presentation ? { presentation } : {}),
          ...(operational ? { operational } : {}),
        };
        const synthetic = usesSyntheticRecovery(rebookingAssessment);
        if (synthetic) {
          pushTrace(
            "flight",
            "synthetic_fallback",
            `provider recovery ladder exhausted — ${rebookingAssessment?.fallbackReason ?? "no priced inventory"}`,
          );
        }
        return {
          plan: synthetic ? markSyntheticPlan(assembledPlan) : assembledPlan,
          // Synthetic recovery remains approvable: approval applies the graph
          // plan and records a pending settlement, while the visible
          // indicative provenance prevents it being mistaken for a ticket.
          degraded: false,
          trace,
        };
      }
      pushTrace("trust_layer", "validation_failed", "plan rejected by validator — degrading");
    } catch (error) {
      // Provider search/fare calls failed at runtime — degrade below rather
      // than failing the request.
      console.warn("[hackathon-api] provider pipeline failed, degrading:", error);
    }
  }
  pushTrace("orchestrator", "degraded", "flight provider unavailable — graph-only simulated plan");
  return {
    plan: buildDegradedPlan(options),
    degraded: true,
    trace,
  };
}

/**
 * Additive operational settlement layer built from the pipeline outcome and
 * the hydrated nodeRefs — consumed by settlePlanOnTrip on approve.
 * Exported for unit tests only: the endpoint harness cannot reach it without
 * a live flight provider (the test rail always degrades before this point).
 */
export function buildOperational(
  options: SwarmRunOptions,
  hydrated: HydratedTrip,
  outcome: {
    disruption: DisruptionResult;
    rebookingAssessment: FlightRebookingAssessment | null;
    hotelAdjustments: HotelAdjustment[];
    activityProposals: ActivityRescheduleProposal[];
  },
): OperationalSettlement | null {
  const disruptedRef = hydrated.nodeRefs[options.nodeId];
  let disruptedKind: string;
  let disruptedLabel: string;
  if (disruptedRef) {
    disruptedKind = disruptedRef.kind;
    disruptedLabel = disruptedRef.label;
  } else {
    // No nodeRef for the target (e.g. a graph node that never mapped to a
    // content_json entry). Fall back to the SOURCE graph node's type so
    // hotel/activity/transfer-targeted plans still produce an operational
    // payload instead of silently settling nothing. The flight shape below
    // is untouched: `new_flight` is only stamped for flight disruptions.
    const sourceNode = hydrated.graph.getNode(options.nodeId);
    if (!sourceNode) return null;
    switch (sourceNode.type) {
      case "flight":
        disruptedKind = "flight";
        disruptedLabel = `Flight ${sourceNode.flightNumber} ${sourceNode.origin} → ${sourceNode.destination}`;
        break;
      case "hotel_check_in":
        disruptedKind = "hotel";
        disruptedLabel = sourceNode.hotelName;
        break;
      case "activity":
        disruptedKind = "activity";
        disruptedLabel = sourceNode.name;
        break;
      case "transfer":
        disruptedKind = "transfer";
        disruptedLabel = "Transfer";
        break;
      default:
        return null;
    }
  }

  const operational: OperationalSettlement = {
    disrupted: { nodeId: options.nodeId, kind: disruptedKind, label: disruptedLabel },
  };

  // Replacement flight → the disrupted transit leg is rewritten on approve.
  const best = outcome.rebookingAssessment?.bestCandidate ?? null;
  if (best && disruptedKind === "flight") {
    operational.new_flight = {
      reference: best.option.flightNumber,
      depart: best.option.departureTime,
      arrive: best.option.arrivalTime,
      carrier: best.option.airline,
    };
  }

  // Activity moves / swaps (+ W2 drops).
  if (outcome.activityProposals.length > 0) {
    operational.activity_moves = outcome.activityProposals.map((proposal) => ({
      nodeId: proposal.activityNodeId,
      newTime: proposal.newTime,
      // W2 drop marker (additive): settlement splices the item out of the
      // itinerary WITHOUT re-appending it on approve. `newTime` keeps the
      // original slot (frozen required string field — drops carry no slot
      // semantics, the `drop` flag drives the settlement branch).
      ...(proposal.action === "drop"
        ? { drop: true, cancellationNote: activityCancellationNote(proposal) }
        : {}),
      ...(proposal.swap
        ? {
            replacementName: proposal.swap.replacementName,
            ...(proposal.swap.viatorProductCode
              ? { viatorProductCode: proposal.swap.viatorProductCode }
              : {}),
          }
        : {}),
    }));
  }

  // Hotel actions: impacted check-in nodes (re-timed by the graph propagation),
  // joined with the HotelAgent's adjustment verdict when available.
  const hotelActions: NonNullable<OperationalSettlement["hotel_actions"]> = [];
  // The graph propagates the NOMINAL delay, so every carousel plan inherited
  // the same check-in (23:40 for a flight landing 20:10 and one landing
  // 20:40). A late check-in belongs to the flight actually chosen: the room is
  // reached when the traveller is really in town, never earlier than booked.
  const chosenArrivalMs = best ? Date.parse(best.option.arrivalTime) : Number.NaN;
  const readyInCityMs = Number.isFinite(chosenArrivalMs)
    ? chosenArrivalMs +
      arrivalBuffer(best?.option.origin, best?.option.destination).readyInCityMinutes * 60_000
    : Number.NaN;
  for (const report of outcome.disruption.affected) {
    if (report.nodeType !== "hotel_check_in") continue;
    const ref = hydrated.nodeRefs[report.nodeId];
    if (!ref) continue;
    const adjustment = outcome.hotelAdjustments.find((a) => a.hotel_name === ref.label);
    if (adjustment?.action === "none" && report.action !== "updated") continue;
    const newCheckInMs = Number.isFinite(readyInCityMs)
      ? Math.max(report.previousScheduledTime, readyInCityMs)
      : report.newScheduledTime;
    if (newCheckInMs !== undefined && newCheckInMs <= report.previousScheduledTime && Number.isFinite(readyInCityMs)) {
      // The chosen flight still gets the traveller there before check-in:
      // nothing to change at the hotel for THIS plan.
      continue;
    }
    hotelActions.push({
      nodeId: report.nodeId,
      action: adjustment?.action ?? "late_check_in",
      note: report.reason,
      ...(newCheckInMs !== undefined ? { newCheckIn: new Date(newCheckInMs).toISOString() } : {}),
    });
  }
  // Hotel-source disruptions ("hotel overbooked"): handleDisruption re-times
  // the SOURCE node in place and reports only downstream nodes, so the
  // disrupted check-in never enters `disruption.affected` — settle it
  // explicitly so an approved plan rewrites the right content_json entry.
  if (disruptedKind === "hotel" && !hotelActions.some((a) => a.nodeId === options.nodeId)) {
    const sourceNode = hydrated.graph.getNode(options.nodeId);
    const adjustment = outcome.hotelAdjustments.find((a) => a.hotel_name === disruptedLabel);
    if (sourceNode && sourceNode.type === "hotel_check_in") {
      hotelActions.push({
        nodeId: options.nodeId,
        action: adjustment?.action ?? "late_check_in",
        note: "Disrupted hotel check-in resolved at the source.",
        newCheckIn: new Date(sourceNode.scheduledTime).toISOString(),
      });
    }
  }
  if (hotelActions.length > 0) operational.hotel_actions = hotelActions;

  return operational;
}

/**
 * W2 — the honest cancellation-policy quote stamped on drop markers
 * (Viator standard 24h heuristic, mirrored from the ActivityAgent's
 * penalty math: penalty 0 ⇒ outside the 24h window). The affiliate tier is
 * quote-only — the actual cancellation happens on the traveler's own Viator
 * booking page, so the note is a policy quote, never transactional wording.
 */
function activityCancellationNote(proposal: ActivityRescheduleProposal): string {
  return proposal.penalty === 0
    ? "free cancellation until 24h before start"
    : `cancellation inside 24h of start — ${proposal.penalty} ${proposal.currency} fee applies`;
}

/**
 * W2 additive trace rows (same push-when-grounded convention as
 * `atlas_liveness`): one `day_reorganization` row naming the rail that
 * produced the resequencing (Gemini vs. deterministic fallback), and one
 * `viator_slot_check` row counting slots grounded against live Viator
 * availability. Shared by the legacy and multi-plan resolution rails.
 */
function pushActivityReorgTraces(
  activityProposals: ActivityRescheduleProposal[],
  pushTrace: (agent: string, step: string, detail: string) => void,
): void {
  const reorganized = activityProposals.filter((proposal) => proposal.reorgSource !== undefined);
  if (reorganized.length > 0) {
    const source = reorganized[0]?.reorgSource;
    pushTrace(
      "activity",
      "day_reorganization",
      `${reorganized.length} activity(ies) resequenced as one day (${
        source === "gemini" ? "Gemini reorganizer" : "deterministic fallback"
      })`,
    );
  }
  // Task 21 (additive): name WHY the Gemini reorg rail degraded instead of
  // the old silent console.error — grep session traces for
  // `gemini_degraded` to find every degraded call with its taxonomy reason.
  const degraded = reorganized.find((proposal) => proposal.reorgDegradeReason !== undefined);
  if (degraded?.reorgDegradeReason !== undefined) {
    pushTrace(
      "activity",
      "gemini_degraded",
      `day reorganizer fell back to deterministic rail (reason: ${degraded.reorgDegradeReason}` +
        `${degraded.reorgDegradeDetail ? `: ${degraded.reorgDegradeDetail}` : ""})`,
    );
  }
  const liveChecks = activityProposals.filter((proposal) => proposal.viatorConsult?.live === true);
  if (liveChecks.length > 0) {
    pushTrace(
      "activity",
      "viator_slot_check",
      `${liveChecks.length} slot(s) checked against live Viator availability`,
    );
  }
}

/** Graph-only plan with the provider fallback flight (no live provider involved).
 * Runs on the hydrated real-trip graph so `impacted_nodes` stays truthful. */
function buildDegradedPlan(options: SwarmRunOptions): ResolutionPlan {
  const graph = options.hydrated!.graph;
  const nodeId = options.nodeId;
  const delayMinutes = options.delayMinutes;
  const incident = options.description;
  const source = graph.getNode(nodeId);
  // A MISSING disrupted node (e.g. stale persisted mission options after a
  // concurrent trip edit) cannot propagate anything — degrade with an empty
  // impact surface instead of throwing, so the rail still answers with a
  // degraded plan (⇒ 409 degraded_plan_not_bookable on approve).
  const disruption = source
    ? graph.handleDisruption(nodeId, delayMinutes)
    : { sourceNodeId: nodeId, delayMinutes, affected: [] as DisruptionResult["affected"] };
  const flightIsSource = source?.type === "flight";
  const flightDestinationId =
    source && source.type === "flight" ? source.arrivalLocationId : undefined;

  const impactedNodes = disruption.affected.flatMap(({ nodeId: affectedId }) => {
    const node = graph.getNode(affectedId);
    return node ? [describeNode(node)] : [];
  });
  // Charges and rescheduled_activities must stay arithmetically consistent:
  // one penalty per activity that actually moved (node times are already
  // updated by handleDisruption's atomic commit).
  const rescheduledActivities = disruption.affected
    .filter(({ action }) => action === "requires_rescheduling")
    .flatMap((report) => {
      const node = graph.getNode(report.nodeId);
      if (!node) return [];
      // B1.5 — reuse the orchestrator's human slot formatter (no raw ISO in
      // `new_time`) and emit the machine-readable `new_time_iso` alongside.
      const newIso = new Date(node.scheduledTime).toISOString();
      const originalIso = new Date(report.previousScheduledTime).toISOString();
      return [
        {
          name: describeNode(node),
          new_time: formatNewTime(originalIso, newIso),
          penalty: DEGRADED_ACTIVITY_PENALTY,
          new_time_iso: newIso,
        },
      ];
    });
  // Live-rail parity (spec §2.4): a spatial-mismatch transfer conflict adds
  // the deterministic ride re-quote to the degraded charges too and surfaces
  // it as `transfer_requote` (one re-quote per plan — first spatial transfer
  // conflict), keeping net_payable === total_new_charges - total_refund.
  const spatialTransferReport =
    disruption.affected.find(
      (report) =>
        report.nodeType === "transfer" &&
        report.action === "conflict" &&
        report.reason.startsWith(SPATIAL_MISMATCH_REASON_PREFIX),
    ) ?? null;
  let transferRequote: TransferRequote | undefined;
  if (spatialTransferReport) {
    const transferNode = graph.getNode(spatialTransferReport.nodeId);
    const pickupLocationId =
      transferNode && transferNode.type === "transfer" ? transferNode.pickupLocationId : undefined;
    transferRequote = {
      amount: TRANSFER_REQUOTE_CHARGE,
      from: flightDestinationId ?? "the diverted airport",
      to: pickupLocationId ?? flightDestinationId ?? "the original pickup",
      reason: spatialTransferReport.reason,
    };
  }
  const totalNewCharges =
    (flightIsSource ? PROVIDER_FALLBACK_FLIGHT_COST : 0) +
    rescheduledActivities.length * DEGRADED_ACTIVITY_PENALTY +
    (transferRequote ? TRANSFER_REQUOTE_CHARGE : 0);

  return {
    // The canary string stays flight-only: a non-flight degraded plan never
    // pretends a simulated flight provider was involved.
    incident: flightIsSource ? `${incident} (simulated — flight provider unavailable)` : incident,
    impacted_nodes: impactedNodes,
    proposed_resolution: {
      ...(flightIsSource
        ? { new_flight: { id: PROVIDER_FALLBACK_FLIGHT_ID, cost: PROVIDER_FALLBACK_FLIGHT_COST } }
        : {}),
      rescheduled_activities: rescheduledActivities,
      ...(transferRequote ? { transfer_requote: transferRequote } : {}),
    },
    financial_delta: {
      total_refund: 0,
      total_new_charges: totalNewCharges,
      net_payable: totalNewCharges,
      // Additive single-currency bucket keeps the degraded rail's ledger
      // trace shape identical to the live rail.
      by_currency: [
        {
          currency: options.hydrated?.meta.currency ?? "EUR",
          total_refund: 0,
          total_new_charges: totalNewCharges,
          net_payable: totalNewCharges,
        },
      ],
    },
    requires_human_approval: true,
    // Additive (Phase B): currency label for the degraded amounts — the
    // hydrated trip's currency, EUR default.
    currency: options.hydrated?.meta.currency ?? "EUR",
  };
}

// --------------------------------------------------------------- presentation

/**
 * Map-pin coordinates, read from the canonical airport reference
 * (`src/core/sanity/airports.ts`). The private 12-entry table this replaced
 * held none of the Asia-Pacific airports the flight partner covers best, so
 * the change map drew one pin — or none — on most real rebookings.
 */
const IATA_COORDS: Record<string, { lat: number; lng: number; city: string }> = AIRPORTS;

/** Display symbol for the common currencies; fallback "CODE ". */
function currencySymbol(currency: string | undefined): string {
  switch (currency) {
    case "EUR":
      return "€";
    case "USD":
      return "$";
    case "GBP":
      return "£";
    case "JPY":
      return "¥";
    default:
      return currency ? `${currency} ` : "";
  }
}

/** Signed money string, e.g. "+€150.00" / "−€20.00". */
function formatSignedAmount(amount: number, currency: string | undefined): string {
  const sign = amount < 0 ? "−" : "+";
  return `${sign}${currencySymbol(currency)}${Math.abs(amount).toFixed(2)}`;
}

/**
 * B3 — assemble the additive, display-only `presentation` block in ONE place
 * from the validated specialist outputs. Never feeds the ledger math; every
 * field is optional and tolerant. Returns undefined when nothing presentable
 * came out of the pipeline (the plan simply omits the block then).
 */
interface SettlementPreview {
  changes: string[];
  followUps: SettlementFollowUp[];
  effects: SettlementEffects;
}

/**
 * Run the settlement transformer — the exact function approval will run —
 * against the trip as it stands, and keep what it WOULD do. Pure: nothing is
 * written. Undefined when the trip content or the operational layer is absent.
 */
function previewSettlement(
  hydrated: HydratedTrip | null | undefined,
  plan: ResolutionPlan,
  operational: OperationalSettlement | null,
): SettlementPreview | undefined {
  if (!hydrated?.content || !operational) return undefined;
  try {
    const result = applySettlementToContent(hydrated.content, hydrated.nodeRefs, plan, operational);
    return { changes: result.changes, followUps: result.followUps, effects: result.effects };
  } catch (error) {
    console.warn("[hackathon-api] settlement preview failed:", error);
    return undefined;
  }
}

/**
 * Make every hotel decision the settlement will write visible on the plan.
 *
 * `buildOperational` derives a late check-in from the graph even when no
 * HotelAgent ran (provider unconfigured, disabled or rate-limited), but the
 * approval sheet only reads `proposed_resolution.hotel_adjustments` — so the
 * check-in moved on approval without ever having been shown. Mirrored rows
 * carry no fee (none was quoted) and state the new check-in as a fact.
 */
function mirrorOperationalHotels(
  plan: ResolutionPlan,
  hydrated: HydratedTrip | null | undefined,
  operational: OperationalSettlement | null,
): ResolutionPlan {
  const actions = operational?.hotel_actions ?? [];
  if (!hydrated || actions.length === 0) return plan;
  const existing = plan.proposed_resolution.hotel_adjustments ?? [];
  const mirrored: HotelAdjustment[] = [];
  for (const action of actions) {
    const name = hydrated.nodeRefs[action.nodeId]?.label;
    if (!name || existing.some((entry) => entry.hotel_name === name)) continue;
    if (mirrored.some((entry) => entry.hotel_name === name)) continue;
    if (action.action !== "late_check_in" && action.action !== "rebook") continue;
    const checkInMs = action.newCheckIn ? Date.parse(action.newCheckIn) : Number.NaN;
    mirrored.push({
      hotel_name: name,
      action: action.action,
      fee: 0,
      note:
        action.action === "late_check_in" && Number.isFinite(checkInMs)
          ? `Check-in moves to ${new Date(checkInMs).toISOString().slice(11, 16)} to match your new arrival.`
          : action.note,
    });
  }
  if (mirrored.length === 0) return plan;
  return {
    ...plan,
    proposed_resolution: {
      ...plan.proposed_resolution,
      hotel_adjustments: [...existing, ...mirrored],
    },
  };
}

function buildPresentation(input: {
  plan: ResolutionPlan;
  best: RebookingCandidate | null;
  hotelAdjustments: HotelAdjustment[];
  activityProposals: ActivityRescheduleProposal[];
  /** The traveller's own itinerary — what a late arrival is measured against. */
  graph?: ItineraryGraph;
  /** The disrupted leg's node id — the anchor for "what is still ahead". */
  disruptedId?: string;
  /** Why no replacement flight was offered, when none was. */
  noFlight?: NonNullable<ResolutionPresentation["no_flight_reason"]>;
  /** Dry-run of the settlement itself — what approving will really do. */
  preview?: SettlementPreview;
}): ResolutionPresentation | undefined {
  const { plan, best, hotelAdjustments, activityProposals, graph, disruptedId, noFlight, preview } = input;
  const currency = plan.currency;
  // Flight-less plans (hotel/activity/transfer missions) carry NO new_flight
  // — the presentation must tolerate that (map points simply stay empty).
  const newFlight = plan.proposed_resolution.new_flight ?? null;
  const presentation: ResolutionPresentation = {};

  // Why there is no replacement flight — surfaced where the traveller decides.
  if (noFlight) {
    presentation.no_flight_reason = noFlight;
  }

  // What this plan costs the REST of the trip.
  //
  // Everything else here describes what the traveller GETS. This is the only
  // block that says what they lose, and for a late rebooking it is usually the
  // number that decides the answer: a flight two days out is cheap precisely
  // because two days of the holiday go with it. The swarm used to re-time the
  // arrival day and say nothing whatsoever about the days behind it.
  if (graph && newFlight?.arrival) {
    const arrivalMs = Date.parse(newFlight.arrival);
    // `plan.operational` is assembled AFTER this block, so reading the
    // disrupted node from it always found undefined — which left the walk
    // unanchored and reported "Infinity days late". The mission's own node id
    // is the disrupted leg, and it is available here.
    const disruptedNodeId = disruptedId;
    const disruptedNode = disruptedNodeId ? graph.getNode(disruptedNodeId) : undefined;
    const fromMs =
      disruptedNode && disruptedNode.type === "flight"
        ? disruptedNode.scheduledTime
        : Number.NEGATIVE_INFINITY;
    if (Number.isFinite(arrivalMs)) {
      const consequence = evaluateTripConsequence(graph, arrivalMs, fromMs, disruptedNodeId);

      // An activity the plan MOVES is not an activity the traveller loses.
      //
      // The evaluator asks a purely temporal question — "is this over before
      // you land?" — and on the arrival day the answer is yes for slots the
      // DayReorganizer then pushes into the evening and saves. Counting those
      // as losses would overstate the damage, which is the same dishonesty as
      // hiding it, pointed the other way.
      const rescheduledNames = new Set(
        (plan.proposed_resolution.rescheduled_activities ?? [])
          .filter((activity) => activity.action !== "drop")
          .map((activity) => activity.name.trim().toLowerCase()),
      );
      // The settlement dry-run is the authority on what survives: an item it
      // re-times is not lost, and an item it cancels IS, whatever the purely
      // temporal evaluator concluded.
      for (const title of preview?.effects.moved ?? []) rescheduledNames.add(title.trim().toLowerCase());
      const cancelledNames = new Set(
        (preview?.effects.cancelled ?? []).map((item) => item.title.trim().toLowerCase()),
      );
      const survivedByReschedule = (label: string) =>
        rescheduledNames.has(label.trim().toLowerCase()) && !cancelledNames.has(label.trim().toLowerCase());
      const trulyLost = consequence.lost.filter((item) => !survivedByReschedule(item.label));
      for (const node of graph.getNodes()) {
        if (node.type !== "activity" || !cancelledNames.has(node.name.trim().toLowerCase())) continue;
        if (trulyLost.some((item) => item.nodeId === node.id)) continue;
        trulyLost.push({ nodeId: node.id, type: node.type, label: node.name, scheduledTime: node.scheduledTime });
      }
      const isMeal = (label: string) => classifyItem({ title: label }) === "meal";
      const transfersLost = Math.max(
        trulyLost.filter((item) => item.type === "transfer").length,
        preview?.effects.transfersRetimed ?? 0,
      );
      const adjusted = {
        ...consequence,
        lost: trulyLost,
        activitiesLost: trulyLost.filter((item) => item.type === "activity" && !isMeal(item.label)).length,
        mealsLost: trulyLost.filter((item) => item.type === "activity" && isMeal(item.label)).length,
        transfersLost,
        nightsLost: trulyLost.filter((item) => item.type === "hotel_check_in").length,
      };

      const summary = describeTripConsequence(adjusted);
      if (summary) {
        presentation.trip_impact = {
          summary,
          nights_lost: adjusted.nightsLost,
          activities_lost: adjusted.activitiesLost,
          days_lost: adjusted.daysLost,
          lost_node_ids: adjusted.lost.map((item) => item.nodeId),
          transfers_lost: adjusted.transfersLost,
          meals_lost: adjusted.mealsLost,
        };
      }
    }
  }

  // Hotel block: prefer the adjustment that carries a provider alternative;
  // otherwise fall back to the first non-"none" action.
  const adjustment =
    hotelAdjustments.find((a) => a.alternative !== undefined) ??
    hotelAdjustments.find((a) => a.action !== "none");
  if (adjustment) {
    const alt = adjustment.alternative;
    presentation.hotel = {
      name: alt?.name ?? adjustment.hotel_name,
      action: adjustment.action,
      ...(alt?.ratePerNight !== undefined ? { rate_per_night: alt.ratePerNight } : {}),
      ...((alt?.currency ?? currency) ? { currency: alt?.currency ?? currency } : {}),
      ...(alt?.freeCancellationUntil ? { free_cancellation_until: alt.freeCancellationUntil } : {}),
      ...(alt?.lat !== undefined ? { lat: alt.lat } : {}),
      ...(alt?.lng !== undefined ? { lng: alt.lng } : {}),
      ...(alt?.images && alt.images.length > 0 ? { images: alt.images } : {}),
    };
  }

  // Activity swap block: first proposal carrying a Viator swap with media.
  const swapProposal = activityProposals.find((p) => p.swap !== undefined);
  if (swapProposal?.swap) {
    const swap = swapProposal.swap;
    presentation.activity_swap = {
      name: swap.replacementName,
      ...(swap.image !== undefined ? { image: swap.image } : {}),
      ...(swap.price !== undefined ? { price_from: swap.price } : {}),
      ...((swap.currency ?? currency) ? { currency: swap.currency ?? currency } : {}),
      ...(swap.rating !== undefined ? { rating: swap.rating } : {}),
    };
  }

  if (preview && (preview.changes.length > 0 || preview.followUps.length > 0)) {
    presentation.settlement_preview = {
      changes: preview.changes,
      follow_ups: preview.followUps.map((entry) => ({ kind: entry.kind, message: entry.message })),
    };
  }

  // Map points: canonical airport table for the flight legs + hotel coordinates.
  const points: NonNullable<ResolutionPresentation["map_points"]> = [];
  if (newFlight && newFlight.origin && IATA_COORDS[newFlight.origin]) {
    const coords = IATA_COORDS[newFlight.origin];
    points.push({ label: coords.city, lat: coords.lat, lng: coords.lng, kind: "airport_origin" });
  }
  if (newFlight && newFlight.destination && IATA_COORDS[newFlight.destination]) {
    const coords = IATA_COORDS[newFlight.destination];
    points.push({ label: coords.city, lat: coords.lat, lng: coords.lng, kind: "airport_new" });
  }
  const alt = adjustment?.alternative;
  if (alt?.lat !== undefined && alt.lng !== undefined) {
    points.push({
      label: adjustment?.hotel_name ?? "Hotel",
      lat: alt.lat,
      lng: alt.lng,
      kind: "hotel",
    });
  }
  if (points.length > 0) presentation.map_points = points;

  // Ledger summary: self-explanatory lines rebuilt from the SAME validated
  // delta components (display only — the ledger math itself is untouched).
  // Direction-first phrasing ("You pay now" / "You get back"), each line
  // labelled in its TRUE currency: the fare's own currency for the flight
  // line, the policy verdict's currency for the change fee.
  const lines: string[] = [];
  const fare = best?.fareDifference;
  const fareCharge = fare ? (fare.direction === "refund" ? -fare.amount : fare.amount) : 0;
  const fareCurrency = fare?.currency ?? currency;
  if (fare && fareCharge > 0) {
    lines.push(`You pay now — new ticket: ${formatSignedAmount(fareCharge, fareCurrency)}`);
    // Honest basis note: without a true fare-delta basis the amount is the
    // FULL re-priced ticket, not a delta against the original booking.
    //
    // It must NOT claim the original was "already paid": `full_fare` covers
    // the very common case of a leg the traveler has not booked at all (only
    // the planner's estimate), where nothing was paid and nothing is
    // refundable. Stating what the amount IS holds in both cases.
    if (fare.basis !== "fare_difference") {
      lines.push("This is the full ticket price, not a difference — no fare on file to refund");
    }
    // A price we could not confirm must never read like one we did. This is
    // the figure the provider PUBLISHED in its search results, kept because
    // the confirmation call was rate-limited — dropping the flight over that
    // is what told travellers no flight existed while fifteen were listed.
    if (fare.basis === "search_reference") {
      lines.push(
        "Listed price — we could not confirm it with the airline just now, so it may change",
      );
    }
  }
  const policyVerdict = plan.proposed_resolution.policy_verdict;
  const changeFee = policyVerdict?.changeFee;
  if (best && typeof changeFee === "number" && changeFee > 0) {
    lines.push(
      `You pay now — change fee: ${formatSignedAmount(changeFee, policyVerdict?.currency ?? currency)}`,
    );
    // The figure above is a conversion so the panel reads in ONE currency;
    // say plainly what the carrier will put on the card.
    if (policyVerdict?.billedCurrency && typeof policyVerdict.billedChangeFee === "number") {
      lines.push(
        `Approximate — the carrier bills ${formatSignedAmount(
          policyVerdict.billedChangeFee,
          policyVerdict.billedCurrency,
        ).replace(/^\+/, "")}`,
      );
    }
  }
  for (const hotel of hotelAdjustments) {
    if (hotel.fee > 0) {
      lines.push(
        `You pay now — hotel change (${hotel.hotel_name}): ${formatSignedAmount(hotel.fee, currency)}`,
      );
    }
  }
  for (const proposal of activityProposals) {
    if (proposal.penalty > 0) {
      lines.push(
        `You pay now — activity change: ${formatSignedAmount(proposal.penalty, currency)}`,
      );
    }
    if (proposal.swap && proposal.swap.priceDelta > 0) {
      lines.push(
        `You pay now — activity swap (${proposal.swap.replacementName}): ${formatSignedAmount(proposal.swap.priceDelta, currency)}`,
      );
    }
  }
  const requote = plan.proposed_resolution.transfer_requote;
  if (requote && requote.amount > 0) {
    lines.push(`You pay now — transfer re-quote: ${formatSignedAmount(requote.amount, currency)}`);
  }
  const netAmountLine = (value: number, curr: string | undefined) =>
    `${currencySymbol(curr)}${Math.abs(value).toFixed(2)}`;
  if (fare && fareCharge < 0) {
    // Unsigned, like the total-refund line below: every "+" in this ledger
    // means money leaving the traveler's account, so "+€12.00" under "You get
    // back" read as a charge.
    lines.push(`You get back — refund: ${netAmountLine(fareCharge, fareCurrency)}`);
  }
  const netBuckets = plan.financial_delta.by_currency ?? [];
  if (netBuckets.length > 0) {
    // Currencies stay SEGREGATED (never converted into one total), but they
    // belong on ONE line: emitting a separate "Total due now: …" per bucket
    // printed the same label twice ("Total due now: €25.00" above "Total due
    // now: $454.55"), which reads as two competing totals rather than one
    // bill payable in two currencies.
    const payable = netBuckets.filter((bucket) => bucket.net_payable > 0);
    const refunded = netBuckets.filter((bucket) => bucket.net_payable < 0);
    if (payable.length > 0) {
      lines.push(
        `Total due now: ${payable
          .map((bucket) => netAmountLine(bucket.net_payable, bucket.currency))
          .join(" + ")}`,
      );
    }
    if (refunded.length > 0) {
      lines.push(
        `You get back — total refund: ${refunded
          .map((bucket) => netAmountLine(bucket.net_payable, bucket.currency))
          .join(" + ")}`,
      );
    }
  } else if (plan.financial_delta.net_payable !== 0) {
    const net = plan.financial_delta.net_payable;
    lines.push(
      net > 0
        ? `Total due now: ${netAmountLine(net, currency)}`
        : `You get back — total refund: ${netAmountLine(net, currency)}`,
    );
  }
  presentation.ledger_summary = lines;

  return Object.keys(presentation).length > 0 ? presentation : undefined;
}

// ------------------------------------------------------------------ mission

/**
 * POST /api/hackathon/mission (SPEC §4.2) — user-initiated reroute driven by
 * free-text intent (Copilot action buttons).
 *
 * The intent is parsed against the trip's OWN graph (parseMissionIntentForTrip)
 * — the mission MUST address a real, hydratable trip (uuid tripId). With an
 * execution context (`ctx`) the Worker answers immediately with
 * `{ resolution_id, state: "processing" }` and finishes the pipeline in
 * `ctx.waitUntil` (the client polls swarm-status, §4.3).
 */
async function handleMission(request: Request, ctx?: HackathonContext): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) {
    return errorResponse(400, "invalid_body", "Request body must be a JSON object.");
  }
  const intent = body.intent;
  if (typeof intent !== "string" || intent.trim().length === 0) {
    return errorResponse(400, "invalid_intent", "intent must be a non-empty string.");
  }
  const explicitRaw = body.nodeId;
  const tripId = typeof body.tripId === "string" ? body.tripId.trim() : "";

  // A mission MUST address a real, hydratable trip.
  if (tripId.length === 0) {
    return errorResponse(
      400,
      "trip_required",
      "tripId is required — send the uuid of the trip to run the mission on.",
    );
  }
  if (!looksLikeTripUuid(tripId)) {
    return errorResponse(400, "trip_required", "tripId must be the uuid of an existing trip.");
  }
  const missionRefusal = await refuseUnlessTripAllowed(request, tripId, "write");
  if (missionRefusal) return missionRefusal;
  const tripLoad = await loadSwarmTrip(tripId);
  if (tripLoad.kind !== "ok") return tripLoadErrorResponse(tripLoad)!;
  const hydrated = tripLoad.trip;
  const explicitNodeId = typeof explicitRaw === "string" ? explicitRaw.trim() : undefined;
  const parsed = parseMissionIntentForTrip(intent.trim(), hydrated, explicitNodeId);
  if (parsed.kind === "error") {
    return errorResponse(parsed.status, parsed.code, parsed.message);
  }
  const { kind: _missionCategory, ...missionBase } = parsed.mission;
  const mission: SwarmRunOptions = { ...missionBase, tripId, hydrated };
  return await runMission(mission, tripId, ctx);
}

/**
 * B2 — why a session is degraded. A memory-only session store (no Supabase
 * credentials) takes precedence — it alone makes ANY session non-bookable;
 * with a persistent store the cause is the offline flight provider.
 */
function deriveDegradedReason(
  providerDegraded: boolean,
): "provider_offline" | "session_store_memory" | undefined {
  if (!swarmStoreIsPersistent()) return "session_store_memory";
  if (providerDegraded) return "provider_offline";
  return undefined;
}

/**
 * Run one mission and persist its session. With `ctx` (async real-trip path)
 * the response returns immediately with state "processing"; the pipeline then
 * finishes inside `ctx.waitUntil` and persists the final proposal_ready
 * session via the store's upsert. Without `ctx` everything is synchronous.
 */
async function runMission(
  mission: SwarmRunOptions,
  tripId: string,
  ctx?: HackathonContext,
): Promise<Response> {
  const resolutionId = newResolutionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  if (ctx) {
    const initialTrace: SwarmTraceEntry[] = [
      {
        agent: "orchestrator",
        step: "mission_received",
        detail: mission.description,
        at: new Date().toISOString(),
      },
    ];
    await saveSwarmSession({
      id: resolutionId,
      trip_id: tripId,
      state: "processing",
      plan: null,
      trace: initialTrace,
      degraded: !swarmStoreIsPersistent(),
      expires_at: expiresAt,
    });
    // Progressive activity streaming: upsert each trace row the moment an
    // agent emits it, so the app's 1.5 s poll watches the Activity Stream
    // grow instead of staring at the lone mission_received row for the
    // whole pipeline. Saves run through a serialized chain — entries land
    // in order and the final proposal_ready save keeps its own semantics
    // (full upsert, now carrying the merged incl. mission_received trace).
    // Review fix: the legacy rail uses the SAME chunked mirror writer as
    // the multi-resolve rail (one mirror write per TRACE_FLUSH_EVERY
    // entries, not one per entry) so the W2 trace rows
    // (pushActivityReorgTraces) cannot blow the Worker subrequest budget.
    const mirror = createChunkedTraceMirror(resolutionId, initialTrace);
    ctx.waitUntil(
      (async () => {
        const { plan, degraded, trace } = await runSwarmResolution(mission, {
          onTrace: mirror.persistTraceEntry,
        });
        // Drain any in-flight incremental saves before the final upsert.
        await mirror.drain();
        // WS1 guard: never resurrect a cancelled/expired session.
        if (await swarmSessionIsExpired(resolutionId)) {
          console.warn(
            `[hackathon-api] mission ${resolutionId} finished after cancel/expiry — results discarded`,
          );
          return;
        }
        // State-guarded final upsert: a cancel landing between the expiry
        // check above and this write wins (the conditional UPDATE matches
        // no row and the terminal state is never overwritten).
        const saved = await saveSwarmSessionIfState({
          id: resolutionId,
          trip_id: tripId,
          state: "proposal_ready",
          plan,
          trace: [...initialTrace, ...trace],
          degraded: degraded || !swarmStoreIsPersistent(),
          expires_at: expiresAt,
        });
        if (!saved) {
          console.warn(
            `[hackathon-api] mission ${resolutionId} final upsert refused — session state moved on (cancel won the race)`,
          );
        }
      })().catch(async (error) => {
        console.error("[hackathon-api] async mission failed:", error);
        await updateSwarmSession(resolutionId, { state: "expired" });
      }),
    );
    // B2 — even the immediate "processing" ack surfaces the store-tier flag
    // (the provider verdict arrives with the proposal_ready session).
    const ackDegraded = !swarmStoreIsPersistent();
    return jsonResponse(200, {
      resolution_id: resolutionId,
      state: "processing",
      degraded: ackDegraded,
      ...(ackDegraded ? { degraded_reason: "session_store_memory" as const } : {}),
    });
  }

  const { plan, degraded, trace } = await runSwarmResolution(mission);
  const sessionDegraded = degraded || !swarmStoreIsPersistent();
  const degradedReason = deriveDegradedReason(degraded);
  await saveSwarmSession({
    id: resolutionId,
    trip_id: tripId,
    state: "proposal_ready",
    plan,
    trace,
    degraded: sessionDegraded,
    expires_at: expiresAt,
  });
  return jsonResponse(200, {
    resolution_id: resolutionId,
    plan,
    swarm_trace: trace,
    // B2 — degraded visibility on the mission body (additive).
    degraded: sessionDegraded,
    ...(degradedReason ? { degraded_reason: degradedReason } : {}),
  });
}

// ------------------------------------------------------------- two-phase flow

/**
 * jsonb shape persisted on swarm_sessions.candidates between the assess and
 * resolve phases. `options` is the SwarmRunOptions WITHOUT the `hydrated`
 * graph (not JSON-serializable — resolve re-hydrates via loadSwarmTrip).
 */
interface PersistedTwoPhaseCandidates {
  incident: string;
  impacted_nodes: string[];
  rebookingAssessment?: FlightRebookingAssessment | null;
  hotelAdjustments?: HotelAdjustment[];
  activityProposals?: ActivityRescheduleProposal[];
  mission: {
    nodeId: string;
    delayMinutes: number;
    description: string;
    origin: "reactive" | "proactive";
  };
  options: Omit<SwarmRunOptions, "hydrated">;
  tripId: string;
  language?: string;
  /** The trade-off questions served at assess time (replayed at resolve). */
  tradeoffs?: TradeoffQuestion[];
}

/**
 * The traveller's display-currency preference, off the request body.
 *
 * Ignored unless it looks like an ISO-4217 code: a junk value would silently
 * denominate the confirm screen in nonsense, and falling back to the trip's
 * currency is always safe.
 */
function parseDisplayCurrency(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z]{3}$/.test(raw) ? raw.toUpperCase() : undefined;
}

/** Shared intent parsing for the two-phase rails — real-trip only. */
async function parseMissionForTwoPhase(
  intent: string,
  explicitRaw: unknown,
  tripId: string,
  displayCurrency?: string,
): Promise<{ mission: SwarmRunOptions } | { response: Response }> {
  if (tripId.length === 0) {
    return {
      response: errorResponse(
        400,
        "trip_required",
        "tripId is required — send the uuid of the trip to run the mission on.",
      ),
    };
  }
  if (!looksLikeTripUuid(tripId)) {
    return {
      response: errorResponse(400, "trip_required", "tripId must be the uuid of an existing trip."),
    };
  }
  const tripLoad = await loadSwarmTrip(tripId);
  if (tripLoad.kind !== "ok") return { response: tripLoadErrorResponse(tripLoad)! };
  const hydrated = tripLoad.trip;
  const explicitNodeId = typeof explicitRaw === "string" ? explicitRaw.trim() : undefined;
  const parsed = parseMissionIntentForTrip(intent, hydrated, explicitNodeId);
  if (parsed.kind === "error") {
    return { response: errorResponse(parsed.status, parsed.code, parsed.message) };
  }
  // `kind` used to be destructured out and discarded here — the parser had
  // already told us this is specifically a "hotel_overbooked" vs. a plain
  // "hotel" disruption, and that distinction was thrown away one call before
  // it could reach the trade-off question copy, which is the ONLY place it
  // would have mattered.
  const { kind: category, ...missionBase } = parsed.mission;
  return {
    mission: {
      ...missionBase,
      tripId,
      hydrated,
      category,
      ...(displayCurrency ? { displayCurrency } : {}),
    },
  };
}

interface SwarmAssessResult {
  /** null when the pipeline degraded (missing/failing provider). */
  assessment: DisruptionAssessment | null;
  degraded: boolean;
  trace: SwarmTraceEntry[];
}

/**
 * FAST gathering pass (phase 1): runs the identical specialist pipeline as
 * runSwarmResolution — impact propagation → policy gate → flight assessment
 * → parallel hotel/activity fan-out — but returns the RAW candidates without
 * any TrustLayer plan assembly (OrchestratorAgent.assessDisruption).
 */
async function runSwarmAssessment(
  options: SwarmRunOptions,
  hooks?: { onTrace?: (entry: SwarmTraceEntry) => void },
): Promise<SwarmAssessResult> {
  const trace: SwarmTraceEntry[] = [];
  const pushTrace = makeTracePusher(trace, hooks?.onTrace);
  const built = buildSwarmOrchestrator(options, pushTrace);
  if (built) {
    try {
      pushTrace("orchestrator", "dispatch", disruptionDispatchDetail(options));
      const assessment = await built.orchestrator.assessDisruption(
        buildDisruptionEvent(options, built.fareRule),
      );
      pushTrace(
        "orchestrator",
        "impact_surface",
        `${assessment.disruption.affected.length} downstream nodes affected`,
      );
      if (assessment.policyVerdict) {
        pushTrace(
          "policy",
          "fare_rules",
          assessment.policyVerdict.rebookPermitted
            ? `rebook permitted, change fee ${assessment.policyVerdict.changeFee} ${assessment.policyVerdict.currency}` +
                ruleSourceSuffix(assessment.policyVerdict)
            : `rebook denied — ${assessment.policyVerdict.recommendedAction.replace(/_/g, " ")}`,
        );
      }
      if (assessment.rebookingAssessment) {
        pushTrace("flight", "search", flightSearchTraceDetail(assessment.rebookingAssessment));
        const whyEmpty = noReplacementDetail(assessment.rebookingAssessment);
        if (whyEmpty) pushTrace("flight", "coverage", whyEmpty);
        // Additive: the flexible-date window attempted one search per
        // calendar date — name the covered dates for the disrupted route.
        const sourceNode = built.graph.getNode(options.nodeId);
        const flexSearch = flexDateSearchDetail(
          assessment.rebookingAssessment,
          sourceNode?.type === "flight" ? sourceNode.origin : undefined,
          sourceNode?.type === "flight" ? sourceNode.destination : undefined,
        );
        if (flexSearch !== null) {
          pushTrace("flight", "flex_date_search", flexSearch);
        }
        pushTrace("flight", "fare_basis", fareBasisDetail(assessment.rebookingAssessment));
        // Additive liveness proof (same contract as the /mission rail).
        const liveness = atlasLivenessDetail(assessment.rebookingAssessment);
        if (liveness !== null) {
          pushTrace("flight", "atlas_liveness", liveness);
        }
      }
      pushTrace(
        "liaison",
        "gathering_preferences",
        "candidates gathered — awaiting traveler trade-off answers",
      );
      const synthetic = usesSyntheticRecovery(assessment.rebookingAssessment);
      if (synthetic) {
        pushTrace(
          "flight",
          "synthetic_fallback",
          `provider recovery ladder exhausted — ${assessment.rebookingAssessment?.fallbackReason ?? "no priced inventory"}`,
        );
      }
      return { assessment, degraded: false, trace };
    } catch (error) {
      console.warn("[hackathon-api] assess pipeline failed, degrading:", error);
    }
  }
  pushTrace("orchestrator", "degraded", "flight search unavailable — offering schedule-only plan");
  return { assessment: null, degraded: true, trace };
}

interface MultiRunResult {
  /** ALWAYS at least one plan (degraded fallback when the pipeline fails). */
  plans: ResolutionPlan[];
  degraded: boolean;
  trace: SwarmTraceEntry[];
}

/**
 * Phase 2 pipeline: ONE shared run of the specialist swarm feeding
 * OrchestratorAgent.resolveDisruptionMulti (cheapest / fastest / balanced
 * profiles + constraint filtering), then per-plan presentation/operational
 * enrichment. Degrades to the graph-only single-plan fallback when the
 * provider is missing or fails (the user always gets something).
 */
async function runMultiResolution(
  options: SwarmRunOptions,
  constraints: ResolutionConstraints | undefined,
  hooks?: {
    onTrace?: (entry: SwarmTraceEntry) => void;
    usageResolutionId?: string;
    geminiBudget?: GeminiCallBudget;
    /**
     * Task 21: wire the quota-aware Gemini retry (exactly ONE retry on
     * 429/503) into this run's DayReorganizer. Only the ASYNC resolve rail
     * sets this — the sync rail keeps the bounded single-shot call.
     */
    geminiRetry?: boolean;
  },
): Promise<MultiRunResult> {
  const trace: SwarmTraceEntry[] = [];
  const pushTrace = makeTracePusher(trace, hooks?.onTrace);
  const built = buildSwarmOrchestrator(options, pushTrace, {
    // Task 25 (#3): the DayReorganizer rides ONLY on this resolve rail —
    // assess (and the legacy sync rail) never wire it.
    dayReorg: true,
    usageResolutionId: hooks?.usageResolutionId,
    geminiBudget: hooks?.geminiBudget,
    ...(hooks?.geminiRetry ? { geminiRetry: true } : {}),
  });
  if (built) {
    try {
      const { orchestrator, graph } = built;
      // The itinerary as PLANNED, before this run's propagation re-times it.
      // Same reasoning as the sync rail: `graph` is the object the orchestrator
      // mutates, so measuring a late arrival against it afterwards reports no
      // loss at all — the trip has already been moved to accommodate it.
      const plannedItinerary = graph.clone();
      // Phase 2 re-runs the SAME disruption through the pipeline a second
      // time — deliberately: the traveler's trade-off answers just became
      // available, and any flight quote from phase 1 (assess) may have gone
      // stale while they were answering, so a fresh Atlas search is real
      // work, not a repeat. But `dispatch` / `impact_surface` / `fare_rules`
      // read identically to phase 1's rows in the Activity Stream, which
      // made the stream look like it was replaying itself. Distinct wording
      // here says what's actually happening: confirming, not discovering.
      pushTrace(
        "orchestrator",
        "requote",
        `confirming fresh quotes for ${disruptionDispatchDetail(options)}`,
      );
      const outcome = await orchestrator.resolveDisruptionMulti(
        buildDisruptionEvent(options, built.fareRule),
        constraints,
      );
      pushTrace(
        "orchestrator",
        "impact_recheck",
        `${outcome.disruption.affected.length} downstream nodes affected (rechecked)`,
      );
      if (outcome.policyVerdict) {
        pushTrace(
          "policy",
          "fare_rules_recheck",
          outcome.policyVerdict.rebookPermitted
            ? `rebook still permitted, change fee ${outcome.policyVerdict.changeFee} ${outcome.policyVerdict.currency}` +
                ruleSourceSuffix(outcome.policyVerdict)
            : `rebook denied — ${outcome.policyVerdict.recommendedAction.replace(/_/g, " ")}`,
        );
      }
      for (const note of outcome.trace) {
        pushTrace("liaison", "constraints", note);
      }
      // W2 additive trace rows: day reorganization + Viator slot checks.
      // Task 25 (#4): scan the UNION of every per-plan rederive walk — a
      // degrade that surfaced in a LATER walk (not plan-0's set) must reach
      // the trace too. Rows are additive/dedupe-safe.
      const allReorgProposals = outcome.planActivityProposals.flat();
      pushActivityReorgTraces(
        allReorgProposals.length > 0 ? allReorgProposals : outcome.activityProposals,
        pushTrace,
      );

      // Per-plan enrichment: match each plan's new_flight back to the
      // rebooking candidate it selected (drives the presentation ledger
      // lines and the per-plan operational settlement layer). Task 20:
      // each plan carries ITS OWN activity-proposal set (per-arrival
      // rederive) instead of the shared plan-0 set.
      const enrichedPlans = outcome.plans.map((plan, index) => {
        const flightId = plan.proposed_resolution.new_flight?.id;
        const chosen = flightId
          ? (outcome.rebookingAssessment?.candidates.find((c) => c.option.id === flightId) ?? null)
          : null;
        const planProposals = outcome.planActivityProposals[index] ?? outcome.activityProposals;
        pushTrace(
          "finance",
          "ledger_check",
          `plan${plan.badge ? ` (${plan.badge})` : ""}: ledger balanced: ${ledgerBalancedDetail(plan.financial_delta, plan.currency)}`,
        );
        const operational = options.hydrated
          ? buildOperational(options, options.hydrated, {
              disruption: outcome.disruption,
              rebookingAssessment: outcome.rebookingAssessment
                ? { ...outcome.rebookingAssessment, bestCandidate: chosen }
                : null,
              hotelAdjustments: outcome.hotelAdjustments,
              activityProposals: planProposals,
            })
          : null;
        const disclosedPlan = mirrorOperationalHotels(plan, options.hydrated, operational);
        const preview = previewSettlement(options.hydrated, disclosedPlan, operational);
        const presentation = buildPresentation({
          plan: disclosedPlan,
          preview,
          best: chosen,
          hotelAdjustments: outcome.hotelAdjustments,
          activityProposals: planProposals,
          graph: plannedItinerary,
          disruptedId: options.nodeId,
          ...(() => {
            const r = noFlightReasonFor(
              outcome.rebookingAssessment ?? null,
              routeLabelOf(plannedItinerary, options.nodeId),
            );
            return r ? { noFlight: r } : {};
          })(),
        });
        return {
          ...disclosedPlan,
          ...(presentation ? { presentation } : {}),
          ...(operational ? { operational } : {}),
        };
      });
      // HARD rule: an enriched plan is only persisted when it still passes
      // the TrustLayer validator (no unvalidated schedules ever leave here).
      const synthetic = usesSyntheticRecovery(outcome.rebookingAssessment);
      const validPlans = enrichedPlans
        .filter((plan) => validateResolutionPlan(plan))
        .map((plan) => (synthetic ? markSyntheticPlan(plan) : plan));
      if (validPlans.length > 0) {
        const badges = validPlans.map((plan) => plan.badge ?? "fallback");
        pushTrace(
          "orchestrator",
          "multi_plan",
          `${validPlans.length} distinct plan(s) assembled: ${badges.join(", ")}`,
        );
        if (synthetic) {
          pushTrace(
            "flight",
            "synthetic_fallback",
            `provider recovery ladder exhausted — ${outcome.rebookingAssessment?.fallbackReason ?? "no priced inventory"}`,
          );
        }
        return { plans: validPlans, degraded: false, trace };
      }
      pushTrace("trust_layer", "validation_failed", "no valid plans — degrading");
    } catch (error) {
      console.warn("[hackathon-api] multi-plan pipeline failed, degrading:", error);
    }
  }
  pushTrace("orchestrator", "degraded", "flight provider unavailable — graph-only simulated plan");
  return { plans: [buildDegradedPlan(options)], degraded: true, trace };
}

/** W1: the preference questions that can be simulated on the flight rail.
 *  Hotel/activity questions are never simulated — the flight carousel is
 *  blind to them, so they pass through unchanged. */
const SIMULATABLE_QUESTION_IDS: ReadonlySet<string> = new Set([
  "flight-stops",
  "flight-day",
  "budget-cap",
]);

/**
 * W1 discrimination filter (pure): a preference question is only worth the
 * traveler's tap when its two answers would actually change the plan
 * carousel. Each simulatable question is simulated branch by branch —
 * answer → {@link deriveConstraintsFromAnswers} → the SAME pure selection
 * rail the resolve phase runs ({@link selectPlanCandidates}) — and a
 * question whose branches yield the IDENTICAL ordered plan-candidate
 * sequence is dropped. Ordered sequences (not mere id sets) so an answer
 * that only re-orders the carousel via preference pinning still counts as
 * discriminating. Zero candidates ⇒ every simulatable question drops (the
 * frozen contract tolerates 0 questions — the flow auto-resolves).
 */
export function dropNonDiscriminating(
  questions: TradeoffQuestion[],
  flightCandidates: RebookingCandidate[],
  anchorDepartureMs?: number,
): TradeoffQuestion[] {
  const kept: TradeoffQuestion[] = [];
  for (const question of questions) {
    if (!SIMULATABLE_QUESTION_IDS.has(question.id)) {
      kept.push(question);
      continue;
    }
    const sequences = question.options.map((option) => {
      const constraints = deriveConstraintsFromAnswers(
        [question],
        [{ question_id: question.id, option_id: option.id }],
      );
      const { ordered } = selectPlanCandidates(flightCandidates, constraints, anchorDepartureMs);
      return ordered.map((candidate) => candidate.option.id).join("|");
    });
    if (new Set(sequences).size > 1) {
      kept.push(question);
    }
  }
  return kept;
}

/**
 * POST /api/hackathon/mission/assess — two-phase flow, phase 1.
 * FAST gathering pass: parses the intent (same rails as /mission), runs the
 * specialist assess pipeline ONCE, persists the raw candidates on a
 * `gathering_preferences` session and answers synchronously with 0–2
 * PREFERENCE-LEVEL trade-off questions (deterministic server-composed
 * builder, W1 — the whole flow works with no GEMINI_API_KEY; zero questions
 * is valid — the discrimination filter may drop every one and iOS
 * auto-resolves).
 */
async function handleMissionAssess(request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) {
    return errorResponse(400, "invalid_body", "Request body must be a JSON object.");
  }
  const intent = body.intent;
  if (typeof intent !== "string" || intent.trim().length === 0) {
    return errorResponse(400, "invalid_intent", "intent must be a non-empty string.");
  }
  const language =
    typeof body.language === "string" && body.language.trim().length > 0
      ? body.language.trim()
      : undefined;
  const tripId = typeof body.tripId === "string" ? body.tripId.trim() : "";
  // A mission MUST address a real trip.
  if (tripId.length === 0) {
    return errorResponse(
      400,
      "trip_required",
      "tripId is required — send the uuid of the trip to run the mission on.",
    );
  }

  const refusal = await refuseUnlessTripAllowed(request, tripId, "read");
  if (refusal) return refusal;

  const parsed = await parseMissionForTwoPhase(
    intent.trim(),
    body.nodeId,
    tripId,
    parseDisplayCurrency(body.displayCurrency),
  );
  if ("response" in parsed) return parsed.response;
  const mission = parsed.mission;

  const { assessment, degraded, trace } = await runSwarmAssessment(mission);

  // Feed the liaison: flight candidates + hotel adjustments flattened into
  // ONE array so the deterministic fallback can detect the hotel question.
  const candidateFeed = [
    ...(assessment?.rebookingAssessment?.candidates ?? []),
    ...(assessment?.hotelAdjustments ?? []),
    // Clarity pass: activity proposals feed the activity trade-off question.
    ...(assessment?.activityProposals ?? []),
  ];
  // The hotel FAILED the traveler (overbooked/no-show) vs. the hotel merely
  // needing a look because something else shifted are different situations —
  // "keep my booking" is not an option in the first one. `mission.category`
  // is how swarmIntent's overbook* keyword match reaches this decision.
  const hotelOverbooked = mission.category === "hotel_overbooked";
  // W1: the deterministic PREFERENCE builder is the primary question rail —
  // server-composed, ≤2 questions × 2 options, built straight from the
  // candidate feed (the Gemini question generator remains in the liaison
  // agent but is NOT called here). The discrimination filter then drops any
  // flight question whose two answers would leave the plan carousel
  // unchanged; the anchor is the disrupted flight's TRUE pre-disruption
  // departure, threaded through the assessment by the orchestrator pipeline
  // (captured BEFORE impact propagation mutates the graph node — re-reading
  // the graph here would return original + delay, which silently
  // misclassifies questions whenever the simulated delay crosses UTC
  // midnight; the resolve phase pins against the same pre-mutation capture).
  const flightCandidates = assessment?.rebookingAssessment?.candidates ?? [];
  const originalDepartureMs = assessment?.originalDepartureMs;
  const missedFlight = mission.category === "missed_flight";
  const built = buildPreferenceTradeoffs(candidateFeed, language, {
    hotelOverbooked,
    missedFlight,
  });
  const tradeoffs = dropNonDiscriminating(built, flightCandidates, originalDepartureMs);
  if (tradeoffs.length < built.length) {
    trace.push({
      agent: "liaison",
      step: "preference_filter",
      detail: `${built.length - tradeoffs.length} non-discriminating question(s) dropped — both answers would have led to the same plans`,
      at: new Date().toISOString(),
    });
  }

  const { hydrated: _notSerializable, ...persistableOptions } = mission;
  const candidates: PersistedTwoPhaseCandidates = {
    incident: mission.description,
    impacted_nodes: assessment?.impactedNodes ?? [],
    rebookingAssessment: assessment?.rebookingAssessment ?? null,
    hotelAdjustments: assessment?.hotelAdjustments ?? [],
    activityProposals: assessment?.activityProposals ?? [],
    mission: {
      nodeId: mission.nodeId,
      delayMinutes: mission.delayMinutes,
      description: mission.description,
      origin: mission.origin,
    },
    options: persistableOptions,
    tripId,
    ...(language ? { language } : {}),
    tradeoffs,
  };

  const resolutionId = newResolutionId();
  await saveSwarmSession({
    id: resolutionId,
    trip_id: tripId,
    state: "gathering_preferences",
    plan: null,
    trace,
    degraded: degraded || !swarmStoreIsPersistent(),
    candidates,
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  return jsonResponse(200, {
    status: "gathering_preferences",
    resolution_id: resolutionId,
    tradeoffs,
  });
}

/**
 * POST /api/hackathon/mission/resolve — two-phase flow, phase 2.
 * Loads the gathering_preferences session, translates the trade-off answers
 * into constraints (liaison agent, deterministic fallback) and runs the
 * multi-plan pipeline with FRESH quote TTLs. With a context: immediate
 * `processing` ack + ctx.waitUntil continuation with incremental trace
 * persistence; without one: synchronous `proposal_ready` with the plans
 * inline. On any pipeline error a degraded single-plan fallback persists,
 * so the user always gets something.
 */
async function handleMissionResolve(request: Request, ctx?: HackathonContext): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) {
    return errorResponse(400, "invalid_body", "Request body must be a JSON object.");
  }
  const resolutionId = body.resolution_id;
  if (typeof resolutionId !== "string" || resolutionId.trim().length === 0) {
    return errorResponse(400, "invalid_resolution_id", "resolution_id must be a non-empty string.");
  }
  const answersRaw = body.answers;
  if (!Array.isArray(answersRaw)) {
    return errorResponse(
      400,
      "invalid_answers",
      "answers must be an array of { question_id, option_id }.",
    );
  }
  const answers: TradeoffAnswer[] = [];
  for (const item of answersRaw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.question_id === "string" && typeof record.option_id === "string") {
      answers.push({ question_id: record.question_id, option_id: record.option_id });
    }
  }
  const language =
    typeof body.language === "string" && body.language.trim().length > 0
      ? body.language.trim()
      : undefined;

  // Canonical input makes retries order-independent without conflating different choices.
  const requestKey = JSON.stringify({
    language: language ?? null,
    answers: [...answers].sort(
      (a, b) =>
        a.question_id.localeCompare(b.question_id) || a.option_id.localeCompare(b.option_id),
    ),
  });
  const repeatResponse = (record: SwarmSessionRecord): Response => {
    const metadata = record.candidates as { resolve_request_key?: string } | null;
    if (metadata?.resolve_request_key !== requestKey) {
      return errorResponse(
        409,
        "resolution_input_conflict",
        "This resolution has different submitted choices. Start a new assessment to change them.",
      );
    }
    if (record.state === "processing") {
      return jsonResponse(200, { resolution_id: resolutionId, status: "processing" });
    }
    if (record.state === "proposal_ready" || record.state === "awaiting_approval") {
      return jsonResponse(200, {
        resolution_id: resolutionId,
        status: "proposal_ready",
        plans: record.plans ?? (record.plan ? [record.plan] : []),
        swarm_trace: record.trace,
        degraded: record.degraded,
        ...(language ? { language } : {}),
      });
    }
    return errorResponse(
      409,
      "resolution_not_active",
      "This resolution is no longer active. Refresh its status.",
    );
  };

  const session = await getSwarmSession(resolutionId);
  if (!session) {
    return errorResponse(
      404,
      "invalid_resolution_id",
      `No swarm session for "${resolutionId}" (unknown or expired).`,
    );
  }
  // A resolution id is not an authorization: re-check the trip it names.
  const resolveRefusal = await refuseUnlessTripAllowed(request, session.trip_id ?? "", "read");
  if (resolveRefusal) return resolveRefusal;

  if (session.state !== "gathering_preferences") return repeatResponse(session);

  const stored = (
    typeof session.candidates === "object" && session.candidates !== null ? session.candidates : {}
  ) as Partial<PersistedTwoPhaseCandidates>;
  const questions = Array.isArray(stored.tradeoffs) ? stored.tradeoffs : [];

  // Task 21: the additive `liaison/gemini_degraded` trace row naming WHY the
  // constraint translation fell back to the deterministic derivation (the
  // old rail logged silently to console.error).
  const liaisonDegradeRow = (reason: GeminiDegradeReason): SwarmTraceEntry => ({
    agent: "liaison",
    step: "gemini_degraded",
    detail: `constraint translation fell back to deterministic derivation (reason: ${reason})`,
    at: new Date().toISOString(),
  });

  const localRoutingRow = (): SwarmTraceEntry => ({
    agent: "liaison",
    step: "deterministic_constraints",
    detail: "Known preferences translated locally; zero liaison model requests.",
    at: new Date().toISOString(),
  });

  // Rebuild the mission options; ALWAYS re-hydrate the real trip.
  if (
    !stored.options ||
    typeof stored.options !== "object" ||
    typeof stored.options.nodeId !== "string"
  ) {
    return errorResponse(
      400,
      "invalid_resolution_id",
      `Session "${resolutionId}" has no stored mission options — re-run /mission/assess.`,
    );
  }
  let options: SwarmRunOptions = { ...stored.options };
  const resolveTripId = options.tripId ?? session.trip_id;
  if (!resolveTripId || !looksLikeTripUuid(resolveTripId)) {
    return errorResponse(400, "trip_required", "tripId must be the uuid of an existing trip.");
  }
  const tripLoad = await loadSwarmTrip(resolveTripId);
  if (tripLoad.kind !== "ok") return tripLoadErrorResponse(tripLoad)!;
  options = { ...options, tripId: resolveTripId, hydrated: tripLoad.trip };
  const sessionTripId = resolveTripId;

  const resolveCandidates = { ...stored, resolve_request_key: requestKey };
  const claim = await claimSwarmSessionForResolve(resolutionId, resolveCandidates);
  if (claim.error) {
    return errorResponse(
      503,
      "session_store_unavailable",
      "Could not start resolution. Retry shortly.",
    );
  }
  if (!claim.claimed) {
    const current = await getSwarmSession(resolutionId);
    return current
      ? repeatResponse(current)
      : errorResponse(409, "resolution_not_active", "Resolution expired. Start a new assessment.");
  }

  const stillProcessing = async () => (await getSwarmSession(resolutionId))?.state === "processing";
  const geminiBudget = new GeminiCallBudget(GEMINI_CALLS_PER_MISSION);

  // ── Async rail: ack + ctx.waitUntil continuation ─────────────────────────
  if (ctx) {
    const initialTrace: SwarmTraceEntry[] = [
      ...session.trace,
      {
        agent: "orchestrator",
        step: "resolve_received",
        detail: `building plans from ${answers.length} trade-off answer(s)`,
        at: new Date().toISOString(),
      },
    ];
    await updateSwarmSession(resolutionId, { trace: initialTrace });
    // Shared chunked mirror writer (see createChunkedTraceMirror) — one
    // mirror write per TRACE_FLUSH_EVERY entries, never one per entry.
    const mirror = createChunkedTraceMirror(resolutionId, initialTrace);
    ctx.waitUntil(
      (async () => {
        // Yield one macrotask so the ack response leaves BEFORE the
        // continuation touches anything — the async IIFE would otherwise
        // start its first statement synchronously at `waitUntil` time (and
        // a mere microtask yield still flushes before the caller sees the
        // response). One tick is free; the pipeline loses nothing.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!(await stillProcessing())) return;
        // Task 21 (ack latency): the constraint translate rides INSIDE the
        // waitUntil continuation — the ack returns before any Gemini call
        // (constraints are only consumed by runMultiResolution below).
        // Quota-aware retry wired on this rail only: exactly ONE retry on
        // 429/503 inside the existing deadline (bounded extra subrequest).
        const liaison = new GeminiLiaisonAgent({
          maxRetries: GEMINI_QUOTA_RETRIES,
          onUsage: geminiUsageLogger(resolutionId, "liaison"),
          sharedBudget: geminiBudget,
        });
        const constraints = await liaison.translateAnswersToConstraints(questions, answers);
        if (!(await stillProcessing())) return;
        const liaisonTrace: SwarmTraceEntry[] = [];
        if (liaison.lastConstraintRoute === "deterministic") {
          const row = localRoutingRow();
          liaisonTrace.push(row);
          mirror.persistTraceEntry(row);
        }
        if (liaison.lastDegradeReason !== undefined) {
          const row = liaisonDegradeRow(liaison.lastDegradeReason);
          liaisonTrace.push(row);
          mirror.persistTraceEntry(row); // rides the chunked mirror
        }
        const { plans, degraded, trace } = await runMultiResolution(options, constraints, {
          onTrace: mirror.persistTraceEntry,
          usageResolutionId: resolutionId,
          geminiBudget,
          geminiRetry: true, // Task 21: async resolve rail wires the retry
        });
        await mirror.drain();
        // WS1 guard: the traveler may have cancelled (or the TTL lapsed)
        // while the pipeline ran — an `expired` session must never be
        // resurrected by the final upsert; discard the results instead.
        if (await swarmSessionIsExpired(resolutionId)) {
          console.warn(
            `[hackathon-api] resolve ${resolutionId} finished after cancel/expiry — results discarded`,
          );
          return;
        }
        // State-guarded final upsert: a cancel landing between the expiry
        // check above and this write wins (the conditional UPDATE matches
        // no row and the terminal state is never overwritten).
        const saved = await saveSwarmSessionIfState(
          {
            id: resolutionId,
            trip_id: sessionTripId,
            state: "proposal_ready",
            candidates: resolveCandidates,
            plan: plans[0] ?? null,
            plans,
            trace: [...initialTrace, ...liaisonTrace, ...trace],
            degraded: degraded || !swarmStoreIsPersistent(),
            // Restart the session horizon at resolve time; quote TTLs restart
            // inside the orchestrator assembly as well. The horizon is the
            // max of the standard TTL and the latest plan quote + 5 min grace
            // (WS1), so the session never dies before its quotes do.
            expires_at: resolveSessionExpiresAt(plans),
          },
          ["processing"],
          true,
        );
        if (!saved) {
          console.warn(
            `[hackathon-api] resolve ${resolutionId} final upsert refused — session state moved on (cancel won the race)`,
          );
        }
      })().catch(async (error) => {
        console.error("[hackathon-api] async resolve failed:", error);
        await cancelSwarmSession(resolutionId);
      }),
    );
    return jsonResponse(200, { resolution_id: resolutionId, status: "processing" });
  }

  // ── Sync rail: run inline and return the plans ───────────────────────────
  // Task 21: translate stays inline here (the sync rail is bounded by its
  // deadline by design). It used to run SINGLE-SHOT with 0 retries, which also
  // meant the model ladder could never advance: one HTTP failure from the
  // leading model dropped constraint translation to the deterministic rail
  // without ever asking a lighter model. That was 6 of the 9 degradations on
  // the live matrix of 2026-09-01.
  //
  // ONE rung, not two: enough to reach the next model, still bounded for a
  // rail the caller is waiting on. Each attempt carries its own deadline.
  try {
    const liaison = new GeminiLiaisonAgent({
      maxRetries: 1,
      onUsage: geminiUsageLogger(resolutionId, "liaison"),
      sharedBudget: geminiBudget,
    });
    const constraints = await liaison.translateAnswersToConstraints(questions, answers);
    if (!(await stillProcessing())) {
      return errorResponse(409, "resolution_not_active", "Resolution was cancelled or expired.");
    }
    const liaisonTrace: SwarmTraceEntry[] =
      liaison.lastDegradeReason !== undefined
        ? [liaisonDegradeRow(liaison.lastDegradeReason)]
        : liaison.lastConstraintRoute === "deterministic"
          ? [localRoutingRow()]
          : [];
    const { plans, degraded, trace } = await runMultiResolution(options, constraints, {
      usageResolutionId: resolutionId,
      geminiBudget,
    });
    const sessionDegraded = degraded || !swarmStoreIsPersistent();
    const degradedReason = deriveDegradedReason(degraded);
    const saved = await saveSwarmSessionIfState(
      {
        id: resolutionId,
        trip_id: sessionTripId,
        state: "proposal_ready",
        candidates: resolveCandidates,
        plan: plans[0] ?? null,
        plans,
        trace: [...session.trace, ...liaisonTrace, ...trace],
        degraded: sessionDegraded,
        // Same horizon rule as the async rail (WS1): the session must never
        // expire before the plan quotes it carries.
        expires_at: resolveSessionExpiresAt(plans),
      },
      ["processing"],
      true,
    );
    if (!saved) {
      return errorResponse(
        409,
        "resolution_not_active",
        "Resolution was cancelled or could not be saved. Refresh its status.",
      );
    }
    return jsonResponse(200, {
      resolution_id: resolutionId,
      status: "proposal_ready",
      plans,
      swarm_trace: [...liaisonTrace, ...trace],
      degraded: sessionDegraded,
      ...(degradedReason ? { degraded_reason: degradedReason } : {}),
      ...(language ? { language } : {}),
    });
  } catch (error) {
    await cancelSwarmSession(resolutionId);
    throw error;
  }
}

// -------------------------------------------------------------- mission/cancel

/**
 * POST /api/hackathon/mission/cancel (WS3) — user-initiated abort of an
 * ACTIVE swarm session (`processing` / `gathering_preferences` /
 * `proposal_ready` / `awaiting_approval` → `expired`). Idempotent: a
 * session that already reached a terminal state (or an unknown id) answers
 * 200 `{ cancelled: false, noop: true, state? }`. A store failure answers
 * 503 session_store_unavailable. Accepts camelCase `resolutionId` like
 * approve-resolution. Behind the same bearer gate as the whole surface.
 */
async function handleMissionCancel(request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body) {
    return errorResponse(400, "invalid_body", "Request body must be a JSON object.");
  }
  const resolutionId = body.resolutionId;
  if (typeof resolutionId !== "string" || resolutionId.trim().length === 0) {
    return errorResponse(400, "invalid_body", "resolutionId must be a non-empty string.");
  }
  const lookup = await getSwarmSessionIgnoringExpiry(resolutionId.trim());
  if (lookup && "error" in lookup) {
    return errorResponse(503, "session_store_unavailable", "Could not load the swarm session.");
  }
  if (lookup && "record" in lookup) {
    const refusal = await refuseUnlessTripAllowed(request, lookup.record.trip_id ?? "", "write");
    if (refusal) return refusal;
  }
  const result = await cancelSwarmSession(resolutionId.trim());
  if (result.error) {
    return errorResponse(
      503,
      "session_store_unavailable",
      "The swarm session store is temporarily unavailable — please retry in a moment.",
    );
  }
  if (result.cancelled) {
    return jsonResponse(200, { cancelled: true });
  }
  return jsonResponse(200, {
    cancelled: false,
    noop: true,
    ...(result.state !== undefined ? { state: result.state } : {}),
  });
}

// -------------------------------------------------------------- swarm-status

/** States that carry a ready plan (SPEC §4.3: plan present once proposal_ready or later). */
const PLAN_VISIBLE_STATES = new Set<string>([
  "proposal_ready",
  "awaiting_approval",
  "approved",
  "settled",
]);

/**
 * GET /api/hackathon/swarm-status/{resolution_id} (SPEC §4.3) — polled by the
 * client (~1.5 s while processing) to render the Swarm Activity Stream.
 */
async function handleSwarmStatus(request: Request, resolutionId: string): Promise<Response> {
  if (!resolutionId) {
    return errorResponse(404, "unknown_resolution", "No resolution id provided.");
  }
  const lookup = await getSwarmSessionIgnoringExpiry(resolutionId);
  if (lookup && "error" in lookup)
    return errorResponse(503, "session_store_unavailable", "Could not read resolution status.");
  const session = lookup && "record" in lookup ? lookup.record : null;
  if (!session) {
    return errorResponse(
      404,
      "unknown_resolution",
      `No swarm session for "${resolutionId}" (unknown or expired).`,
    );
  }
  // A session id and the app's shared bearer do not authorize access to a
  // traveler's proposals, supplier references or itinerary trace.
  const refusal = await refuseUnlessTripAllowed(request, session.trip_id ?? "", "read");
  if (refusal) return refusal;
  // B2 — degraded visibility on the status body (additive). Sessions store a
  // single merged flag; the reason is derived: with a persistent store a
  // degraded session can only be provider-side, otherwise the memory-only
  // store tier is the (at least co-)cause.
  const degradedReason = session.degraded
    ? swarmStoreIsPersistent()
      ? ("provider_offline" as const)
      : ("session_store_memory" as const)
    : undefined;
  const operation = settlementOperation(session);
  const body: Record<string, unknown> = {
    ...(operation?.receipt ? { receipt: operation.receipt } : {}),
    ...(operation && !operation.receipt ? { settlement_pending: true } : {}),
    resolution_id: session.id,
    state:
      session.expires_at <= new Date().toISOString() &&
      !["approved", "settled"].includes(session.state)
        ? "expired"
        : session.state,
    trace: session.trace,
    degraded: session.degraded,
    ...(degradedReason ? { degraded_reason: degradedReason } : {}),
  };
  if (session.plan && PLAN_VISIBLE_STATES.has(session.state)) {
    body.plan = session.plan;
  }
  // Two-phase sessions carry the full resolve array alongside `plan`
  // (which stays plans[0] for backward compatibility).
  if (
    PLAN_VISIBLE_STATES.has(session.state) &&
    Array.isArray(session.plans) &&
    session.plans.length > 0
  ) {
    body.plans = session.plans;
  }
  return jsonResponse(200, body);
}

// -------------------------------------------------------------------- alerts

/**
 * GET /api/hackathon/alerts?tripId={id}&since={epoch_ms} (SPEC §4.5) —
 * fallback rail for background alerts: swarm_sessions rows with state
 * 'awaiting_approval' written by the swarm-monitor Edge Function, scoped to
 * `tripId` (REQUIRED), newer than `since`, and not yet expired.
 */
async function handleAlerts(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const tripId = searchParams.get("tripId");
  if (tripId === null || tripId.trim().length === 0) {
    return errorResponse(
      400,
      "invalid_body",
      "tripId query parameter is required (alerts are scoped per trip).",
    );
  }
  const sinceParam = searchParams.get("since");
  let since = 0;
  if (sinceParam !== null && sinceParam !== "") {
    const parsed = Number(sinceParam);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return errorResponse(400, "invalid_since", "since must be a non-negative epoch-ms number.");
    }
    since = parsed;
  }
  const alerts = await listSwarmAlerts(tripId.trim(), since);
  return jsonResponse(200, { alerts, server_time: Date.now() });
}
