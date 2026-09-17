/**
 * Nexus Swarm session store — `swarm_sessions` persistence layer (SPEC §4.6).
 *
 * The hackathon API used to keep resolution plans in a module-level Map only,
 * which does not survive multi-instance Cloudflare Workers and cannot be read
 * by the proactive flow (the `swarm-monitor` Edge Function writes preemptive
 * sessions that THIS Worker must serve via swarm-status / alerts / approve).
 *
 * Tiers (in order of preference):
 *   1. Supabase `swarm_sessions` table via the service-role admin client
 *      (`src/integrations/supabase/client.server.ts` convention:
 *      SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from process.env / wrangler).
 *   2. In-memory Map fallback (single-process only) — used when credentials
 *      are absent (dev) or the REST call fails at runtime. Sessions served
 *      purely from memory are marked `degraded` by the API layer (SPEC §4.1
 *      degradation rules: a degraded session is not bookable → 409).
 *
 * Every function here is total: it NEVER throws — failures surface as
 * `null` / `false` so `handleHackathonRequest` can keep its JSON-only,
 * never-throw contract.
 *
 * One-shot approval claims are enforced by an
 * atomic conditional state transition
 * (`proposal_ready|awaiting_approval → approved`, guarded by `expires_at`);
 * a replayed or concurrent approve finds no matching row and gets `null`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ResolutionPlan } from "@/agents";

// ------------------------------------------------------------------ types

export type SwarmSessionState =
  | "processing"
  | "gathering_preferences"
  | "proposal_ready"
  | "awaiting_approval"
  | "approved"
  | "settled"
  | "expired";

export const SWARM_SESSION_STATES: readonly SwarmSessionState[] = [
  "processing",
  "gathering_preferences",
  "proposal_ready",
  "awaiting_approval",
  "approved",
  "settled",
  "expired",
];

/** One row of the Swarm Activity Stream (SPEC §4.2 `swarm_trace` entry). */
export interface SwarmTraceEntry {
  agent: string;
  step: string;
  detail: string;
  /** ISO-8601 timestamp of the agent step. */
  at: string;
}

export interface SwarmSessionRecord {
  /** Resolution id (`res_…`). */
  id: string;
  trip_id: string | null;
  user_id: string | null;
  state: SwarmSessionState;
  plan: ResolutionPlan | null;
  trace: SwarmTraceEntry[];
  degraded: boolean;
  /** Why the session is degraded (e.g. "session_store_memory" when the
   *  Supabase mirror write failed and only the memory tier holds it, or
   *  "provider_offline"). Absent when not degraded / cause unknown. */
  degraded_reason?: string;
  /** NEW (two-phase) — raw provider candidates persisted between the assess
   *  and resolve phases. jsonb passthrough; absent for legacy/proactive rows. */
  candidates?: unknown;
  /** NEW (two-phase) — array of ResolutionPlans from the resolve phase. */
  plans?: unknown;
  /** ISO-8601. */
  created_at: string;
  /** ISO-8601. */
  expires_at: string;
}

export interface NewSwarmSession {
  id: string;
  trip_id?: string | null;
  user_id?: string | null;
  state?: SwarmSessionState;
  plan?: ResolutionPlan | null;
  trace?: SwarmTraceEntry[];
  degraded?: boolean;
  /** Optional degraded cause carried alongside `degraded` (memory tier +
   *  diagnostics; not a persisted column). */
  degraded_reason?: string;
  /** NEW (two-phase) — raw provider candidates (jsonb passthrough). */
  candidates?: unknown;
  /** NEW (two-phase) — array of ResolutionPlans (jsonb passthrough). */
  plans?: unknown;
  /** Defaults to now + 30 min (mirrors the table default). */
  expires_at?: string;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes — table default horizon

// ------------------------------------------------------------ client access

/**
 * Lazily resolve the service-role client. The shared `supabaseAdmin` is a
 * lazy Proxy that THROWS on first property access when SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY are missing — merely RETURNING the reference
 * never throws, so the guard must probe a property access inside the try
 * block. Returns null ⇒ memory tier.
 * The generated `Database` type predates the swarm_sessions migration, so the
 * client is used untyped and every row is validated by hand below.
 */
function tryGetAdminClient(): SupabaseClient | null {
  try {
    // Probe the lazy proxy: property access is where it throws when the env
    // credentials are absent (without this, the degraded/memory-only gate is
    // defeated because returning the proxy itself never fails).
    void (supabaseAdmin as unknown as { from: unknown }).from;
    return supabaseAdmin as unknown as SupabaseClient;
  } catch {
    return null;
  }
}

/** True when the Supabase tier is configured (env present). */
export function swarmStoreIsPersistent(): boolean {
  return tryGetAdminClient() !== null;
}

/**
 * LIVE store health probe for the diagnostic health endpoint: executes a
 * cheap `limit(1)` read against `swarm_sessions` and reports whether it
 * lands. Unlike {@link swarmStoreIsPersistent} (env PRESENCE only) this
 * catches stale/rotated service keys, PostgREST outages etc. No caching —
 * the endpoint is bearer-gated, hit rarely, and a silent recurrence is
 * exactly what this probe exists to surface. Total: never throws.
 */
export async function probeSwarmStoreHealth(): Promise<boolean> {
  try {
    const client = tryGetAdminClient();
    if (!client) return false;
    const { error } = await client.from("swarm_sessions").select("id").limit(1);
    return !error;
  } catch (error) {
    console.warn("[swarm-store] probeSwarmStoreHealth failed:", error);
    return false;
  }
}

// ------------------------------------------------------ in-memory fallback

interface MemoryEntry {
  record: SwarmSessionRecord;
}

const memorySessions = new Map<string, MemoryEntry>();
const MEMORY_MAX_ENTRIES = 500;

function memoryPruneExpired(nowIso: string): void {
  for (const [id, entry] of memorySessions) {
    if (entry.record.expires_at <= nowIso) memorySessions.delete(id);
  }
}

function memoryPut(record: SwarmSessionRecord): void {
  if (memorySessions.size >= MEMORY_MAX_ENTRIES) {
    memoryPruneExpired(record.created_at);
    if (memorySessions.size >= MEMORY_MAX_ENTRIES) {
      const oldest = memorySessions.keys().next().value;
      if (oldest !== undefined) memorySessions.delete(oldest);
    }
  }
  memorySessions.set(record.id, { record });
}

/** Clone so callers can never mutate the stored record. */
function cloneRecord(record: SwarmSessionRecord): SwarmSessionRecord {
  const clone: SwarmSessionRecord = {
    ...record,
    trace: record.trace.map((entry) => ({ ...entry })),
    plan: record.plan ? (JSON.parse(JSON.stringify(record.plan)) as ResolutionPlan) : null,
  };
  // Deep-clone the two-phase jsonb passthrough fields when present.
  if (record.candidates !== undefined) {
    clone.candidates = JSON.parse(JSON.stringify(record.candidates));
  }
  if (record.plans !== undefined) clone.plans = JSON.parse(JSON.stringify(record.plans));
  return clone;
}

// ------------------------------------------------------------ row validation

function isSwarmSessionState(value: unknown): value is SwarmSessionState {
  return typeof value === "string" && (SWARM_SESSION_STATES as readonly string[]).includes(value);
}

function isTraceEntry(value: unknown): value is SwarmTraceEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.agent === "string" &&
    typeof v.step === "string" &&
    typeof v.detail === "string" &&
    typeof v.at === "string"
  );
}

/**
 * Hand-validation for the two-phase jsonb passthrough columns: accept any
 * JSON-serializable value (Postgres jsonb never yields functions/symbols),
 * reject null/undefined which mean "column absent".
 */
function isJsonbValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const t = typeof value;
  return t === "object" || t === "string" || t === "number" || t === "boolean";
}

/** Map + validate an untyped PostgREST row; null when the shape is wrong. */
function rowToRecord(row: unknown): SwarmSessionRecord | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || !isSwarmSessionState(r.state)) return null;
  const createdAt = typeof r.created_at === "string" ? r.created_at : new Date().toISOString();
  const expiresAt =
    typeof r.expires_at === "string"
      ? r.expires_at
      : new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const record: SwarmSessionRecord = {
    id: r.id,
    trip_id: typeof r.trip_id === "string" ? r.trip_id : null,
    user_id: typeof r.user_id === "string" ? r.user_id : null,
    state: r.state,
    plan: (typeof r.plan === "object" && r.plan !== null ? r.plan : null) as ResolutionPlan | null,
    trace: Array.isArray(r.trace) ? r.trace.filter(isTraceEntry) : [],
    degraded: r.degraded === true,
    ...(typeof r.degraded_reason === "string" && r.degraded_reason.length > 0
      ? { degraded_reason: r.degraded_reason }
      : {}),
    created_at: createdAt,
    expires_at: expiresAt,
  };
  // Two-phase passthrough columns — kept only when they hold a real jsonb
  // value; legacy/proactive rows simply omit them.
  if (isJsonbValue(r.candidates)) record.candidates = r.candidates;
  if (isJsonbValue(r.plans)) record.plans = r.plans;
  return record;
}

// ------------------------------------------------------------------- writes

/** Build the full record from an input payload (shared by both writes). */
function buildRecord(input: NewSwarmSession): SwarmSessionRecord {
  const record: SwarmSessionRecord = {
    id: input.id,
    trip_id: input.trip_id ?? null,
    user_id: input.user_id ?? null,
    state: input.state ?? "processing",
    plan: input.plan ?? null,
    trace: input.trace ?? [],
    degraded: input.degraded ?? false,
    ...(input.degraded_reason !== undefined ? { degraded_reason: input.degraded_reason } : {}),
    created_at: new Date().toISOString(),
    expires_at: input.expires_at ?? new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  if (input.candidates !== undefined) record.candidates = input.candidates;
  if (input.plans !== undefined) record.plans = input.plans;
  return record;
}

/**
 * The exact column set written to `swarm_sessions` by both the mirror upsert
 * and the state-guarded final UPDATE. The scalar columns id/trip_id/user_id/
 * state/trace/degraded/expires_at are ALWAYS written; `created_at` is
 * intentionally absent (the table stamps it on insert and it must never be
 * rewritten). The jsonb fields plan/candidates/plans are omitted when null or
 * absent so PostgREST leaves previously stored values untouched (partial
 * semantics — no null overwrite). On the matched path of
 * {@link saveSwarmSessionIfState} the memory tier alignment is therefore
 * best-effort for omitted jsonb fields (reads prefer the DB tier).
 */
function dbPayload(record: SwarmSessionRecord): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: record.id,
    trip_id: record.trip_id,
    user_id: record.user_id,
    state: record.state,
    trace: record.trace,
    degraded: record.degraded,
    expires_at: record.expires_at,
  };
  if (record.plan !== null) payload.plan = record.plan;
  if (record.candidates != null) payload.candidates = record.candidates;
  if (record.plans != null) payload.plans = record.plans;
  return payload;
}

/**
 * Mirror a record to the Supabase tier (upsert on id). true ⇒ mirrored;
 * false ⇒ the call errored and the record lives in the memory tier only.
 */
async function mirrorUpsert(client: SupabaseClient, record: SwarmSessionRecord): Promise<boolean> {
  const { error } = await client
    .from("swarm_sessions")
    .upsert(dbPayload(record), { onConflict: "id" });
  if (error) {
    console.warn(`[swarm-store] mirror upsert failed (${error.message}); memory tier only`);
    return false;
  }
  return true;
}

/**
 * Create or replace a session. Always lands in the memory tier (fast path);
 * mirrored best-effort to Supabase when configured. When the mirror upsert
 * FAILS the in-memory record is stamped `degraded` with the reason
 * `session_store_memory` — the session is then only visible to THIS process,
 * which the approve gate must treat as non-bookable. Returns false only when
 * even the memory write was impossible (never happens today — kept total).
 */
export async function saveSwarmSession(input: NewSwarmSession): Promise<boolean> {
  try {
    const record = buildRecord(input);
    memoryPut(record);

    const client = tryGetAdminClient();
    if (client && !(await mirrorUpsert(client, record))) {
      // The session now exists ONLY in this process's memory — stamp the
      // degradation on the stored record so every later read sees it.
      record.degraded = true;
      record.degraded_reason = "session_store_memory";
    }
    return true;
  } catch (error) {
    console.warn("[swarm-store] saveSwarmSession failed:", error);
    return false;
  }
}

/**
 * State-guarded variant of {@link saveSwarmSession} for the async rails'
 * FINAL upsert (cancel-vs-upsert race fix): the write lands ONLY when the
 * session's CURRENT state is one of `allowedStates`. A cancel arriving
 * between the caller's `swarmSessionIsExpired` early-return and this call
 * wins — the DB tier's conditional UPDATE matches no row and the terminal
 * row is never overwritten.
 *
 * The conditional UPDATE carries the FULL terminal payload — plan/plans/
 * trace/degraded/expires_at via {@link dbPayload}, not just the state —
 * which is what other isolates serving GET swarm-status / approve read back
 * (a state-only write left them seeing null plan/plans → empty iOS Trust
 * Layer). Absent jsonb fields are omitted so a guarded write never
 * null-overwrites previously stored plans/candidates.
 *
 * - DB tier: conditional UPDATE `.eq("id").in("state", allowed)` + select.
 *   Matched ⇒ the row transitioned atomically — align the memory tier.
 *   0 rows ⇒ probe the row: EXISTS (terminal/cancelled) ⇒ refuse;
 *   ABSENT ⇒ upsert semantics gated by the memory-tier allowed-state check
 *   (the session then lives only in memory — e.g. a failed mirror write).
 *   A failing conditional UPDATE / probe FAILS CLOSED (false): the row's
 *   true state is unknown, and writing memory could resurrect a cancelled
 *   session another instance already saw through the DB tier.
 * - Memory-only tier (no client): the same allowed-state check against the
 *   memory record; an absent entry still upserts (bootstrap semantics).
 */
export async function saveSwarmSessionIfState(
  input: NewSwarmSession,
  allowedStates: readonly SwarmSessionState[] = ["processing", "gathering_preferences"],
  requireLiveExisting = false,
): Promise<boolean> {
  try {
    const record = buildRecord(input);
    const client = tryGetAdminClient();
    if (client) {
      let matched = false;
      try {
        let query = client
          .from("swarm_sessions")
          .update(dbPayload(record))
          .eq("id", input.id)
          .in("state", [...allowedStates]);
        if (requireLiveExisting) query = query.gt("expires_at", new Date().toISOString());
        const { data, error } = await query.select("id");
        if (error) {
          console.warn(`[swarm-store] guarded save failed (${error.message}); refusing`);
          return false;
        }
        matched = Array.isArray(data) && data.length === 1;
      } catch (error) {
        console.warn("[swarm-store] guarded save threw; refusing:", error);
        return false;
      }

      if (matched) {
        memoryPut(record); // keep the fast path aligned with the DB tier
        return true;
      }

      if (requireLiveExisting) return false;

      // 0 rows: terminal/cancelled row OR no row at all — probe which.
      const { data: raw, error: readError } = await client
        .from("swarm_sessions")
        .select("state")
        .eq("id", input.id)
        .maybeSingle();
      if (readError) {
        console.warn(`[swarm-store] guarded save probe failed (${readError.message}); refusing`);
        return false;
      }
      if (raw) return false; // exists outside allowedStates — never overwrite

      // No DB row: the session lives only in this process's memory tier
      // (failed mirror write). Mirror the allowed-state check there.
      const memory = memorySessions.get(input.id);
      if (memory && !allowedStates.includes(memory.record.state)) return false;
      if (!(await mirrorUpsert(client, record))) {
        record.degraded = true;
        record.degraded_reason = "session_store_memory";
      }
      memoryPut(record);
      return true;
    }

    // Supabase absent (dev, memory-only): same allowed-state check in-process.
    const memory = memorySessions.get(input.id);
    if (requireLiveExisting && (!memory || memory.record.expires_at <= new Date().toISOString()))
      return false;
    if (memory && !allowedStates.includes(memory.record.state)) return false;
    memoryPut(buildRecord(input));
    return true;
  } catch (error) {
    console.warn("[swarm-store] saveSwarmSessionIfState failed:", error);
    return false;
  }
}

/**
 * Update mutable fields of an existing session (state / trace / degraded and
 * the two-phase jsonb passthroughs candidates / plans).
 * Best-effort on both tiers; returns false when no row was found anywhere.
 */
export async function updateSwarmSession(
  id: string,
  patch: {
    state?: SwarmSessionState;
    trace?: SwarmTraceEntry[];
    degraded?: boolean;
    /** NEW (two-phase) — raw provider candidates (jsonb passthrough). */
    candidates?: unknown;
    /** NEW (two-phase) — array of ResolutionPlans (jsonb passthrough). */
    plans?: unknown;
  },
): Promise<boolean> {
  try {
    let found = false;
    const memory = memorySessions.get(id);
    if (memory) {
      found = true;
      if (patch.state) memory.record.state = patch.state;
      if (patch.trace) memory.record.trace = patch.trace.map((entry) => ({ ...entry }));
      if (patch.degraded !== undefined) memory.record.degraded = patch.degraded;
      if (patch.candidates !== undefined) memory.record.candidates = patch.candidates;
      if (patch.plans !== undefined) memory.record.plans = patch.plans;
    }

    const client = tryGetAdminClient();
    if (client) {
      // Build the DB patch explicitly so undefined fields never reach PostgREST.
      const dbPatch: Record<string, unknown> = {};
      if (patch.state !== undefined) dbPatch.state = patch.state;
      if (patch.trace !== undefined) dbPatch.trace = patch.trace;
      if (patch.degraded !== undefined) dbPatch.degraded = patch.degraded;
      if (patch.candidates !== undefined) dbPatch.candidates = patch.candidates;
      if (patch.plans !== undefined) dbPatch.plans = patch.plans;
      const { error } = await client.from("swarm_sessions").update(dbPatch).eq("id", id);
      if (error) {
        console.warn(`[swarm-store] mirror update failed (${error.message})`);
      } else {
        found = true;
      }
    }
    return found;
  } catch (error) {
    console.warn("[swarm-store] updateSwarmSession failed:", error);
    return false;
  }
}

// -------------------------------------------------------------------- reads

/**
 * Lookup outcome that CAN signal a store error (unlike the total read
 * wrappers below): `{ record }` = found; `{ error }` = the Supabase read
 * failed (callers may map this to 503 session_store_unavailable); null =
 * definitely unknown/expired.
 */
export type SwarmSessionLookup = { record: SwarmSessionRecord } | { error: string };

/**
 * Shared read implementation behind the exported wrappers. Supabase is the
 * source of truth when reachable (background-written sessions only exist
 * there); a successful-but-EMPTY DB read still consults the memory tier
 * (another tier of the same deployment may have written it after a failed
 * mirror upsert); DB errors/throws fall back to memory as well. With
 * `ignoreExpiry` the `expires_at > now` filter is dropped so callers can
 * tell "expired" apart from "unknown" (approve diagnostics).
 */
async function lookupSwarmSession(
  id: string,
  options: { ignoreExpiry?: boolean },
): Promise<SwarmSessionLookup | null> {
  try {
    const nowIso = new Date().toISOString();
    const ignoreExpiry = options.ignoreExpiry === true;
    const client = tryGetAdminClient();
    if (client) {
      try {
        let query = client.from("swarm_sessions").select("*").eq("id", id);
        if (!ignoreExpiry) query = query.gt("expires_at", nowIso);
        const { data, error } = await query.maybeSingle();
        if (!error) {
          const record = data ? rowToRecord(data) : null;
          if (record) return { record };
          // Successful-but-empty DB read: consult the memory tier before
          // declaring the session gone (mirror write may have failed).
        } else {
          console.warn(`[swarm-store] read failed (${error.message}); trying memory tier`);
        }
      } catch (error) {
        console.warn("[swarm-store] read threw; trying memory tier:", error);
      }
    }
    const memory = memorySessions.get(id);
    if (!memory) return null;
    if (!ignoreExpiry && memory.record.expires_at <= nowIso) {
      memorySessions.delete(id);
      return null;
    }
    return { record: cloneRecord(memory.record) };
  } catch (error) {
    console.warn("[swarm-store] lookupSwarmSession failed:", error);
    return { error: "session_store_error" };
  }
}

/**
 * Fetch a session by resolution id. Supabase is the source of truth when
 * reachable (background-written sessions only exist there); falls back to
 * the memory tier on error, on an empty DB read, or when unconfigured.
 * null ⇒ unknown/expired.
 */
export async function getSwarmSession(id: string): Promise<SwarmSessionRecord | null> {
  const lookup = await lookupSwarmSession(id, { ignoreExpiry: false });
  return lookup && "record" in lookup ? lookup.record : null;
}

/**
 * Error-signalling read WITHOUT the expiry filter — used by the approve
 * diagnostics to distinguish "session expired" (410) from "unknown" (404)
 * and from a store failure (503). Total: never throws.
 */
export async function getSwarmSessionIgnoringExpiry(
  id: string,
): Promise<SwarmSessionLookup | null> {
  return lookupSwarmSession(id, { ignoreExpiry: true });
}

/** Atomically start resolve. A configured database must never fall back to a
 * stale memory claim on failure. The resolution id is the operation identity. */
export async function claimSwarmSessionForResolve(
  id: string,
  candidates?: unknown,
): Promise<{ claimed: boolean; error?: string }> {
  try {
    const now = new Date().toISOString();
    const client = tryGetAdminClient();
    if (client) {
      const { data, error } = await client
        .from("swarm_sessions")
        .update({ state: "processing", ...(candidates !== undefined ? { candidates } : {}) })
        .eq("id", id)
        .eq("state", "gathering_preferences")
        .gt("expires_at", now)
        .select("id");
      if (error) return { claimed: false, error: "session_store_unavailable" };
      const claimed = Array.isArray(data) && data.length === 1;
      // Invalidate even on a lost claim: another instance may have won.
      memorySessions.delete(id);
      return { claimed };
    }
    const record = memorySessions.get(id)?.record;
    if (!record || record.state !== "gathering_preferences" || record.expires_at <= now) {
      return { claimed: false };
    }
    record.state = "processing";
    if (candidates !== undefined) record.candidates = candidates;
    return { claimed: true };
  } catch {
    return { claimed: false, error: "session_store_unavailable" };
  }
}

export interface SwarmSettlementOperation {
  operation_id: string;
  plan_index: number;
  started_at: string;
  receipt?: Record<string, unknown>;
}

export function settlementOperation(record: SwarmSessionRecord): SwarmSettlementOperation | null {
  const candidates = record.candidates;
  if (!candidates || typeof candidates !== "object") return null;
  const value = (candidates as Record<string, unknown>).settlement_operation;
  if (!value || typeof value !== "object") return null;
  const operation = value as SwarmSettlementOperation;
  return typeof operation.operation_id === "string" && Number.isInteger(operation.plan_index)
    ? operation
    : null;
}

/** Persist the receipt and terminal state together, before acknowledging success.
 * Never fall back to a stale memory record when the database is configured. */
export async function saveSwarmSettlementReceipt(
  entry: SwarmSessionRecord,
  receipt: Record<string, unknown>,
): Promise<boolean> {
  try {
    const operation = settlementOperation(entry);
    if (!operation) return false;
    const candidates = {
      ...(entry.candidates as Record<string, unknown>),
      settlement_operation: { ...operation, receipt },
    };
    const client = tryGetAdminClient();
    if (client) {
      const { data, error } = await client
        .from("swarm_sessions")
        .update({ state: "settled", candidates })
        .eq("id", entry.id)
        .eq("state", "approved")
        .select("id");
      if (error || !Array.isArray(data) || data.length !== 1) return false;
      memorySessions.delete(entry.id);
      return true;
    }
    const memory = memorySessions.get(entry.id)?.record;
    if (!memory || memory.state !== "approved") return false;
    memory.candidates = candidates;
    memory.state = "settled";
    return true;
  } catch {
    return false;
  }
}

/**
 * One-shot approval claim. Atomically transitions
 * `proposal_ready`/`awaiting_approval` → `approved` on a non-expired row.
 *
 * - Supabase configured & reachable ⇒ the conditional UPDATE is the gate; an
 *   empty result (replay, concurrent claim, expired, unknown) returns null
 *   WITHOUT consulting memory, so a double book across tiers is impossible.
 * - Supabase configured but the claim call ERRORS/throws ⇒ FAIL-CLOSED null:
 *   the memory tier may hold a stale copy of a session another instance
 *   already claimed, so claiming on it risks a double book. The caller
 *   surfaces "unknown resolution" and the client retries.
 * - Supabase absent (dev, memory-only) ⇒ the memory tier applies the same
 *   conditional transition in-process.
 */
export async function claimSwarmSessionForBooking(
  id: string,
  candidates?: unknown,
): Promise<SwarmSessionRecord | null> {
  try {
    const nowIso = new Date().toISOString();
    const claimableStates: SwarmSessionState[] = ["proposal_ready", "awaiting_approval"];

    const client = tryGetAdminClient();
    if (client) {
      try {
        const { data, error } = await client
          .from("swarm_sessions")
          .update({ state: "approved", ...(candidates !== undefined ? { candidates } : {}) })
          .eq("id", id)
          .in("state", claimableStates)
          .gt("expires_at", nowIso)
          .select("*");
        if (!error) {
          const row = Array.isArray(data) && data.length === 1 ? data[0] : null;
          if (row) {
            memorySessions.delete(id); // keep the fast path consistent
            return rowToRecord(row);
          }
          return null; // replay / expired / unknown — one-shot semantics
        }
        console.warn(`[swarm-store] claim failed (${error.message}); fail-closed`);
      } catch (error) {
        console.warn("[swarm-store] claim threw; fail-closed:", error);
      }
      // Fail-closed: an errored claim never falls through to the memory tier.
      return null;
    }

    const memory = memorySessions.get(id);
    if (!memory) return null;
    const record = memory.record;
    if (record.expires_at <= nowIso || !claimableStates.includes(record.state)) return null;
    record.state = "approved";
    if (candidates !== undefined) record.candidates = candidates;
    return cloneRecord(record);
  } catch (error) {
    console.warn("[swarm-store] claimSwarmSessionForBooking failed:", error);
    return null;
  }
}

/**
 * User-initiated cancel (WS3): atomically transitions an ACTIVE session
 * (`processing` / `gathering_preferences` / `proposal_ready` /
 * `awaiting_approval`) → `expired`, mirroring claimSwarmSessionForBooking's
 * conditional-UPDATE discipline on both tiers. Idempotent: a session that
 * already reached a terminal state (`approved` / `settled` / `expired`) or
 * is unknown returns `{ cancelled: false }` (plus its state when found).
 * `{ error }` surfaces a store failure so the API can answer 503.
 */
export async function cancelSwarmSession(
  id: string,
): Promise<{ cancelled: boolean; state?: string; error?: string }> {
  try {
    const cancellableStates: SwarmSessionState[] = [
      "processing",
      "gathering_preferences",
      "proposal_ready",
      "awaiting_approval",
    ];

    const client = tryGetAdminClient();
    if (client) {
      try {
        const { data, error } = await client
          .from("swarm_sessions")
          .update({ state: "expired" })
          .eq("id", id)
          .in("state", cancellableStates)
          .select("state");
        if (!error) {
          const rows = Array.isArray(data) ? data : [];
          if (rows.length === 1) {
            const memory = memorySessions.get(id);
            if (memory) memory.record.state = "expired"; // keep tiers aligned
            return { cancelled: true, state: "expired" };
          }
          // No matching DB row. Find out WHY: probe whether the row exists
          // at all (a 0-row UPDATE is ambiguous — terminal row vs. no row).
          const { data: raw, error: readError } = await client
            .from("swarm_sessions")
            .select("state")
            .eq("id", id)
            .maybeSingle();
          if (!readError && !raw) {
            // No DB row at all: this session lives ONLY in the memory tier
            // (its mirror upsert failed at save time ⇒ degraded_reason
            // "session_store_memory"). Apply the same conditional transition
            // there so memory-only degraded sessions stay cancellable.
            const memoryOnly = memorySessions.get(id);
            if (memoryOnly && cancellableStates.includes(memoryOnly.record.state)) {
              memoryOnly.record.state = "expired";
              return { cancelled: true, state: "expired" };
            }
            if (memoryOnly) {
              return { cancelled: false, state: memoryOnly.record.state };
            }
            return { cancelled: false };
          }
          // Row exists but didn't match the cancellable filter: already
          // terminal or cancelled — report the state best-effort (memory
          // first, then the DB row).
          const memory = memorySessions.get(id);
          if (memory) return { cancelled: false, state: memory.record.state };
          if (!readError && raw) {
            const row = raw as { state?: unknown };
            if (isSwarmSessionState(row.state)) {
              return { cancelled: false, state: row.state };
            }
          }
          return { cancelled: false };
        }
        console.warn(`[swarm-store] cancel failed (${error.message})`);
        return { cancelled: false, error: error.message };
      } catch (error) {
        console.warn("[swarm-store] cancel threw:", error);
        return { cancelled: false, error: "session_store_error" };
      }
    }

    // Supabase absent (dev, memory-only): same conditional transition.
    const memory = memorySessions.get(id);
    if (!memory) return { cancelled: false };
    if (!cancellableStates.includes(memory.record.state)) {
      return { cancelled: false, state: memory.record.state };
    }
    memory.record.state = "expired";
    return { cancelled: true, state: "expired" };
  } catch (error) {
    console.warn("[swarm-store] cancelSwarmSession failed:", error);
    return { cancelled: false, error: "session_store_error" };
  }
}

/** Record the final settlement after a successful booking. Best-effort. */
export async function markSwarmSessionSettled(id: string): Promise<void> {
  try {
    const memory = memorySessions.get(id);
    if (memory) memory.record.state = "settled";
    const client = tryGetAdminClient();
    if (client) {
      const { error } = await client
        .from("swarm_sessions")
        .update({ state: "settled" })
        .eq("id", id);
      if (error) console.warn(`[swarm-store] settle update failed (${error.message})`);
    }
  } catch (error) {
    console.warn("[swarm-store] markSwarmSessionSettled failed:", error);
  }
}

// ------------------------------------------------------------------- alerts

export interface SwarmAlertRow {
  resolution_id: string;
  /** uuid of the `notifications` row when resolvable, else the resolution id. */
  notification_id: string;
  /** Epoch ms. */
  created_at: number;
  incident: string;
  /** Session degradation flag (SPEC §4.5): degraded alerts are placeholder
   *  proactive plans — iOS routes them to the adaptive mission flow, not the
   *  booking sheet. */
  degraded: boolean;
  /** Session origin when the plan declares one (`origin: "proactive"` on
   *  swarm-monitor placeholder plans); undefined otherwise. */
  origin?: string;
  plan: ResolutionPlan;
}

/**
 * Background-alert feed (SPEC §4.5): `swarm_sessions` rows written by
 * swarm-monitor with `state = 'awaiting_approval'`, scoped to `tripId`,
 * newer than `since` (epoch ms), NOT expired (`expires_at > now`), newest
 * first. The matching `notifications` uuid is resolved best-effort from the
 * notifications table (payload.resolution_id link).
 */
export async function listSwarmAlerts(
  tripId: string,
  sinceEpochMs: number,
): Promise<SwarmAlertRow[]> {
  try {
    const client = tryGetAdminClient();
    if (!client) return [];
    const sinceIso = new Date(Math.max(0, sinceEpochMs)).toISOString();
    const nowIso = new Date().toISOString();

    const { data, error } = await client
      .from("swarm_sessions")
      .select("*")
      .eq("trip_id", tripId)
      .eq("state", "awaiting_approval")
      .gt("created_at", sinceIso)
      // TTL gate: expired awaiting_approval rows stop being served.
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) {
      console.warn(`[swarm-store] alerts query failed (${error.message})`);
      return [];
    }
    const sessions = (Array.isArray(data) ? data : [])
      .map(rowToRecord)
      .filter((r): r is SwarmSessionRecord => r !== null && r.plan !== null);
    if (sessions.length === 0) return [];

    const notificationIds = await resolveNotificationIds(
      client,
      sessions.map((s) => s.id),
    );

    return sessions.map((session) => {
      const plan = session.plan as ResolutionPlan;
      // Best-effort origin: swarm-monitor placeholder plans carry
      // `origin: "proactive"` outside the frozen ResolutionPlan schema.
      const origin = (plan as unknown as { origin?: unknown }).origin;
      return {
        resolution_id: session.id,
        notification_id: notificationIds.get(session.id) ?? session.id,
        created_at: Date.parse(session.created_at) || Date.now(),
        incident: plan.incident,
        degraded: session.degraded,
        ...(typeof origin === "string" && origin.length > 0 ? { origin } : {}),
        plan,
      };
    });
  } catch (error) {
    console.warn("[swarm-store] listSwarmAlerts failed:", error);
    return [];
  }
}

/**
 * Best-effort lookup of the `notifications` row uuids behind each session
 * (swarm-monitor inserts `type = 'swarm_disruption_alert'` with
 * `payload.resolution_id`). Failures simply leave the map empty.
 */
async function resolveNotificationIds(
  client: SupabaseClient,
  resolutionIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { data, error } = await client
      .from("notifications")
      .select("id,payload")
      .eq("type", "swarm_disruption_alert")
      .limit(100);
    if (error || !Array.isArray(data)) return map;
    const wanted = new Set(resolutionIds);
    for (const row of data) {
      const r = row as { id?: unknown; payload?: unknown };
      const payload =
        typeof r.payload === "object" && r.payload !== null
          ? (r.payload as Record<string, unknown>)
          : null;
      const resId =
        payload && typeof payload.resolution_id === "string" ? payload.resolution_id : null;
      if (resId && wanted.has(resId) && typeof r.id === "string" && !map.has(resId)) {
        map.set(resId, r.id);
      }
    }
  } catch {
    // non-fatal — alerts fall back to resolution_id as the identifier
  }
  return map;
}
