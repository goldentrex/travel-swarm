/**
 * DayReorganizer — smart day-level reorganization of a disrupted day
 * (Workstream 2, plan §2.1).
 *
 * When a late arrival (rebooked flight) pushes ≥2 activities of ONE day into
 * conflict, re-sequencing them one-by-one (the legacy per-item ActivityAgent
 * rail) stacks everything at "next day same time". This agent reorganizes the
 * WHOLE day at once: it knows the new arrival instant, the traveler's stated
 * priorities (`constraints.activity_priority` / `notes`) and emits one
 * decision per activity — `retime` (with the new slot) or `drop`.
 *
 * Rails (TOTAL degradation by contract — this module NEVER throws upward):
 *  1. Gemini (schema-constrained JSON, ≤10s deadline, low thinking, small
 *     output) — cloning the GeminiLiaisonAgent `callGemini` pattern.
 *  2. Deterministic greedy fallback (the guaranteed rail — production
 *     GEMINI_API_KEY presence is unverified): priority-ordered resequence
 *     honoring day bounds (08:00–22:00 UTC wall clock, the same convention
 *     the trip timeline reads/writes) with the 120-minute buffer convention
 *     between activities.
 *
 * HARD rule: EVERY schedule — model-authored or deterministic — passes
 * {@link validateReorgDecisions} before it leaves this module. Invalid model
 * output degrades to the deterministic rail; an unvalidated schedule is
 * never persisted.
 *
 * Dropping an activity is a LAST RESORT: only the lowest-priority activity
 * is dropped, and only when the validator's feasibility math proves the day
 * cannot hold everything after the delayed arrival.
 */

import type { IsoTimestamp } from "@/providers/interfaces/types";
import {
  configuredGeminiModel,
  type GeminiUsageObserver,
  type GeminiCallBudget,
} from "../geminiUsage";
import { GEMINI_MODEL_CASCADE } from "@/agents/geminiCascade";
import {
  GEMINI_CALLS_PER_MISSION,
  type GeminiCallResult,
  type GeminiDegradeReason,
} from "../geminiDegrade";
import { GeminiJsonClient, parseGeminiJson } from "@/agents/geminiJsonClient";

// ------------------------------------------------------------------ contract

/** One activity of the affected day (hydrated graph node feed). */
export interface DayActivityInput {
  nodeId: string;
  name: string;
  /** ISO timestamp of the activity's CURRENT (post-propagation) slot. */
  time: IsoTimestamp;
  durationMinutes: number;
  /** Coordinates when hydration carried them (travel-plausibility check). */
  coords?: { lat: number; lng: number };
}

/** Input for one day-level reorganization. */
export interface DayReorgRequest {
  /** UTC date ("YYYY-MM-DD") of the day being reorganized. */
  date: string;
  activities: DayActivityInput[];
  /** New flight arrival (ISO). No activity may start before it + the
   *  transit margin. Absent for non-flight disruptions (no floor). */
  newArrivalTime?: IsoTimestamp;
  /** Display name of the activity the traveler chose to protect
   *  (`constraints.activity_priority`). */
  priorityName?: string;
  /** Free-text traveler notes (`constraints.notes`). */
  notes?: string;
  /**
   * The mission ASKED for fewer activities ("lighten my day", "my activity was
   * cancelled"), so a drop is the point rather than a shortcut.
   *
   * Off by default, and deliberately so: the strict rule below exists to stop a
   * model deleting an activity to make its own scheduling easier. But on those
   * missions it rejected the model's correct answer and returned a
   * deterministic schedule that kept everything — the opposite of the request.
   * Even here the traveler's protected activity is never droppable.
   */
  allowDiscretionaryDrops?: boolean;
}

/** Per-node decision. `newTime` is present IFF action === "retime". */
export interface DayReorgDecision {
  nodeId: string;
  action: "retime" | "drop";
  newTime?: IsoTimestamp;
  reason: string;
}

export interface DayReorganizationOutcome {
  decisions: DayReorgDecision[];
  /** Which rail produced the outcome (trace + honesty feed). */
  source: "gemini" | "deterministic";
  /**
   * Task 21 (additive): WHY the Gemini rail was not served — the shared
   * {@link GeminiDegradeReason} classify. Absent when Gemini produced the
   * schedule (or no Gemini call was due). Feeds the `activity/gemini_degraded`
   * trace row through the proposal rail.
   */
  degradeReason?: GeminiDegradeReason;
  /** WHICH rule the model's answer broke, when `degradeReason` is the coarse
   *  `invalid_output`. Without it a live run reports 8 identical, undiagnosable
   *  degradations and there is nothing to fix. */
  degradeDetail?: string;
}

export interface DayReorganizerConfig {
  /** Gemini API key; defaults to `process.env.GEMINI_API_KEY`. */
  apiKey?: string;
  /** Per-call deadline in ms (default 10s). */
  timeoutMs?: number;
  /** Model id (default gemini-3.7-flash). */
  model?: string;
  /** Injectable fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** One sanitized measurement per actual HTTP attempt, including failures. */
  onUsage?: GeminiUsageObserver;
  /** Shared across liaison and day replanning for one resolve invocation. */
  sharedBudget?: GeminiCallBudget;
  /**
   * Task 21 (additive): retries on a `quota_429` classify (429/503).
   * Default 0 (single-shot). The async resolve rail wires exactly ONE retry;
   * the backoff rides inside the existing deadline.
   */
  maxRetries?: number;
  /** Task 21 (additive): backoff before the retry in ms (default 1500);
   *  injectable so tests can shorten it. */
  retryDelayMs?: number;
  /** Task 21 (additive): per-instance Gemini call budget
   *  (default {@link GEMINI_CALLS_PER_MISSION}) — same counter pattern as
   *  ActivityAgent's viatorConsultsUsed. Exhaustion ⇒ skip + `quota_429`. */
  callBudget?: number;
  /** Ordered fallbacks are shared — see `geminiCascade.ts`. */
}

// ---------------------------------------------------------------- conventions
// Wall-clock conventions are UTC because the trip timeline reads and writes
// UTC wall clock everywhere (see swarmTripContext `hhmmOf`/`isoDateOf`).

/** Activities live between 08:00 and 22:00 local (UTC wall clock here). */
export const DAY_BOUNDS_START_HOUR = 8;
export const DAY_BOUNDS_END_HOUR = 22;
/** Deterministic spacing convention between consecutive activities. */
export const BUFFER_MINUTES = 120;
/** Time granted between landing and the first activity (bags + transfer). */
export const ARRIVAL_TRANSIT_MARGIN_MINUTES = 60;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// Measured live on 2026-08-31 (wrangler tail): gemini-3.7-flash answered 503
// "this model is currently experiencing high demand" or simply hung past the
// deadline on EVERY swarm call, so the whole rail silently ran on its
// deterministic fallback. 3.6-flash answers promptly under the same load.
const DEFAULT_MODEL = GEMINI_MODEL_CASCADE[0];
/** Covers the primary attempt AND the fallback-model retry (was 10s, which the
 *  503-then-retry sequence blew through, degrading with reason "timeout"). */
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 1_500;

/** Gemini response schema: a decisions array with a tight per-entry shape. */
const REORG_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    decisions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          nodeId: { type: "STRING" },
          action: { type: "STRING", enum: ["retime", "drop"] },
          newTime: { type: "STRING" },
          reason: { type: "STRING" },
        },
        required: ["nodeId", "action", "reason"],
        propertyOrdering: ["nodeId", "action", "newTime", "reason"],
      },
    },
  },
  required: ["decisions"],
  propertyOrdering: ["decisions"],
};

// ------------------------------------------------------------------- helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "HH:MM" (UTC) of an epoch-ms instant. */
function hhmmOf(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** Parse the day's [boundsStart, boundsEnd) epoch-ms window; null on a bad date. */
export function dayBoundsMs(date: string): { start: number; end: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = Date.parse(`${date}T${String(DAY_BOUNDS_START_HOUR).padStart(2, "0")}:00:00Z`);
  const end = Date.parse(`${date}T${String(DAY_BOUNDS_END_HOUR).padStart(2, "0")}:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/** Great-circle distance in km (travel-plausibility feed). */
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Travel-plausibility transit estimate between two coordinated points:
 * 36 km/h ground speed + a 10-minute head/tail allowance. Returns 0 when
 * either point lacks coordinates (unknown geography ⇒ never reject on it).
 */
export function transitMinutesBetween(a: DayActivityInput, b: DayActivityInput): number {
  if (!a.coords || !b.coords) return 0;
  const km = haversineKm(a.coords, b.coords);
  return Math.ceil((km / 36) * 60) + 10;
}

/**
 * Deterministic priority ordering: the traveler-protected activity first
 * (case-insensitive substring match on `priorityName`), then chronological,
 * nodeId as the final tiebreak.
 */
export function priorityOrder(
  activities: DayActivityInput[],
  priorityName?: string,
): DayActivityInput[] {
  const wanted = (priorityName ?? "").trim().toLowerCase();
  const rank = (activity: DayActivityInput): number =>
    wanted.length > 0 && activity.name.toLowerCase().includes(wanted) ? 0 : 1;
  return [...activities].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Date.parse(a.time) - Date.parse(b.time) ||
      a.nodeId.localeCompare(b.nodeId),
  );
}

// ------------------------------------------------- deterministic greedy rail

/**
 * Greedy priority-ordered resequence: pack the day from
 * `max(day-bounds start, arrival + transit margin)` in priority order,
 * spacing activities with the {@link BUFFER_MINUTES} convention. When the
 * day cannot hold everything, the LOWEST-priority activities are dropped one
 * by one until the rest fits — dropping is proven infeasibility, never a
 * style choice. TOTAL: always returns one decision per input activity.
 */
export function resequenceDeterministically(request: DayReorgRequest): DayReorgDecision[] {
  const bounds = dayBoundsMs(request.date);
  const ordered = priorityOrder(request.activities, request.priorityName);
  if (ordered.length === 0 || !bounds) {
    // Unreadable day bounds: keep everything honest by dropping nothing and
    // leaving every activity where it is (the validator would reject any
    // invented slot outside a known window anyway).
    return ordered.map((activity) => ({
      nodeId: activity.nodeId,
      action: "retime",
      newTime: activity.time,
      reason: "Day bounds unreadable — keeping the booked slot.",
    }));
  }

  let arrivalFloorMs = bounds.start;
  const arrivalMs = request.newArrivalTime ? Date.parse(request.newArrivalTime) : NaN;
  if (Number.isFinite(arrivalMs)) {
    arrivalFloorMs = Math.max(
      arrivalFloorMs,
      arrivalMs + ARRIVAL_TRANSIT_MARGIN_MINUTES * MINUTE_MS,
    );
  }

  const fits = (
    kept: DayActivityInput[],
  ): Array<{ activity: DayActivityInput; startMs: number }> | null => {
    let cursor = arrivalFloorMs;
    const placements: Array<{ activity: DayActivityInput; startMs: number }> = [];
    for (const activity of kept) {
      const durationMs = Math.max(15, activity.durationMinutes || 90) * MINUTE_MS;
      if (cursor + durationMs > bounds.end) return null;
      placements.push({ activity, startMs: cursor });
      cursor += durationMs + BUFFER_MINUTES * MINUTE_MS;
    }
    return placements;
  };

  // Drop the lowest-priority entries (tail of the ordered list) one at a
  // time until the day is feasible.
  let kept = ordered;
  let placements = fits(kept);
  while (placements === null && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1);
    placements = fits(kept);
  }
  const dropped = ordered.slice(kept.length);

  const windowHours = (bounds.end - arrivalFloorMs) / HOUR_MS;
  const decisions: DayReorgDecision[] = [];
  if (placements) {
    for (const { activity, startMs } of placements) {
      const unchanged = Math.abs(startMs - Date.parse(activity.time)) < MINUTE_MS;
      decisions.push({
        nodeId: activity.nodeId,
        action: "retime",
        newTime: new Date(startMs).toISOString(),
        reason: unchanged
          ? "Still fits after the delay — keeping the booked slot."
          : `Resequenced to ${hhmmOf(startMs)} to clear the late arrival${
              request.priorityName &&
              activity.name.toLowerCase().includes(request.priorityName.trim().toLowerCase())
                ? " (you asked us to protect this one)"
                : ""
            }.`,
      });
    }
  }
  for (const activity of dropped) {
    decisions.push({
      nodeId: activity.nodeId,
      action: "drop",
      reason:
        `The day holds only ${windowHours.toFixed(1)}h after the new arrival — ` +
        `${activity.name} is the lowest-priority item and was cancelled to keep the rest feasible.`,
    });
  }
  // Emit in the ORIGINAL input order for stable downstream presentation.
  const byId = new Map(decisions.map((decision) => [decision.nodeId, decision]));
  return request.activities
    .map((activity) => byId.get(activity.nodeId))
    .filter((decision): decision is DayReorgDecision => decision !== undefined);
}

/**
 * Reinstate activities the model dropped without cause, using the
 * deterministic rail's decision for each, and re-validate the whole schedule.
 *
 * Returns the repaired decisions only when they pass {@link validateReorgDecisions}
 * unchanged — the validator is the authority either way, so a repair can never
 * smuggle through a schedule the normal path would have refused.
 */
function repairUnjustifiedDrops(
  value: unknown,
  request: DayReorgRequest,
): DayReorgDecision[] | null {
  if (!Array.isArray(value)) return null;
  const rail = new Map(
    resequenceDeterministically(request).map((decision) => [decision.nodeId, decision]),
  );
  const durationOf = new Map(request.activities.map((a) => [a.nodeId, a.durationMinutes]));

  // The model's own retimes, kept exactly as it wrote them.
  const kept = value.filter((entry) => isRecord(entry) && entry.action === "retime") as Array<
    Record<string, unknown>
  >;
  const lastEndMs = kept.reduce((latest, entry) => {
    const start = Date.parse(String(entry.newTime));
    const mins = durationOf.get(String(entry.nodeId)) ?? 0;
    return Number.isFinite(start) ? Math.max(latest, start + mins * MINUTE_MS) : latest;
  }, Number.NEGATIVE_INFINITY);

  /** Build the candidate schedule, placing each unjustified drop at `placeAt`. */
  const attempt = (placeAt: (nodeId: string, fallback: DayReorgDecision) => string): unknown[] => {
    const out: unknown[] = [];
    for (const entry of value) {
      if (!isRecord(entry) || entry.action !== "drop" || typeof entry.nodeId !== "string") {
        out.push(entry);
        continue;
      }
      const fallback = rail.get(entry.nodeId);
      // The rail drops it too ⇒ the drop was justified after all; leave it be.
      if (!fallback || fallback.action === "drop" || fallback.newTime === undefined) {
        out.push(entry);
        continue;
      }
      out.push({ ...fallback, newTime: placeAt(entry.nodeId, fallback) });
    }
    return out;
  };

  // Two placements, tried in order. Both go through the SAME validator, so a
  // repair can never smuggle in a schedule the normal path would refuse.
  //  1. the rail's own slot — right whenever the model kept rail-like times;
  //  2. after the model's last activity — right when the model reshaped the
  //     day and the rail's slot now collides with something it moved.
  const candidates: Array<() => unknown[]> = [
    () => attempt((_nodeId, fallback) => String(fallback.newTime)),
    () =>
      attempt((nodeId, fallback) => {
        if (!Number.isFinite(lastEndMs)) return String(fallback.newTime);
        const mins = durationOf.get(nodeId) ?? 0;
        const start = lastEndMs + BUFFER_MINUTES * MINUTE_MS;
        const bounds = dayBoundsMs(request.date);
        if (bounds && start + mins * MINUTE_MS > bounds.end) return String(fallback.newTime);
        return new Date(start).toISOString();
      }),
  ];

  for (const candidate of candidates) {
    const validated = validateReorgDecisions(candidate(), request);
    if (validated !== null) return validated;
  }
  return null;
}

// -------------------------------------------------------------- hard validator

/**
 * HARD validator over ANY day-reorganization output (model-authored or
 * otherwise). Returns the typed decisions when EVERY rule holds, else null:
 *
 *  - exact coverage: one decision per input activity, no duplicates;
 *  - `retime` ⇒ parseable `newTime` inside the day bounds;
 *  - arrival-aware start floor: nothing starts before arrival + margin;
 *  - no overlaps (each activity ends before the next starts);
 *  - travel plausibility: coordinated neighbors get a real transit estimate;
 *  - drop honesty: a drop is only accepted when the RETIMED set alone is
 *    feasible within the window (a model dropping to hide a bad schedule is
 *    rejected just like a bad schedule).
 *
 * null ⇒ caller serves the deterministic fallback. Never throws.
 */
export function validateReorgDecisions(
  value: unknown,
  request: DayReorgRequest,
  /** Told WHICH rule the payload broke. A bare null said only "no", which left
   *  no way to tell a model that mis-schedules from one that answers garbage —
   *  and no way to know which rule to state more clearly in the prompt. */
  onReject?: (reason: string) => void,
): DayReorgDecision[] | null {
  const reject = (reason: string): null => {
    onReject?.(reason);
    return null;
  };
  try {
    if (!Array.isArray(value)) return reject("payload is not an array");
    const bounds = dayBoundsMs(request.date);
    if (!bounds) return reject("the day has no usable bounds");

    const known = new Map(request.activities.map((activity) => [activity.nodeId, activity]));
    let arrivalFloorMs = bounds.start;
    const arrivalMs = request.newArrivalTime ? Date.parse(request.newArrivalTime) : NaN;
    if (Number.isFinite(arrivalMs)) {
      arrivalFloorMs = Math.max(
        arrivalFloorMs,
        arrivalMs + ARRIVAL_TRANSIT_MARGIN_MINUTES * MINUTE_MS,
      );
    }

    const decisions: DayReorgDecision[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
      if (!isRecord(raw)) return reject("a decision entry is not an object");
      const nodeId = raw.nodeId;
      const action = raw.action;
      if (typeof nodeId !== "string" || !known.has(nodeId) || seen.has(nodeId))
        return reject(`unknown or duplicated nodeId ${String(nodeId)}`);
      seen.add(nodeId);
      if (action !== "retime" && action !== "drop")
        return reject(`unknown action ${String(action)}`);
      const reason = typeof raw.reason === "string" && raw.reason.length > 0 ? raw.reason : null;
      if (action === "drop") {
        decisions.push({
          nodeId,
          action: "drop",
          reason: reason ?? "Dropped: the day cannot hold every activity after the delay.",
        });
        continue;
      }
      const newTime = raw.newTime;
      if (typeof newTime !== "string") return reject("retime without a newTime");
      const startMs = Date.parse(newTime);
      if (!Number.isFinite(startMs)) return reject(`unparseable newTime ${String(newTime)}`);
      const activity = known.get(nodeId)!;
      const durationMs = Math.max(15, activity.durationMinutes || 90) * MINUTE_MS;
      // Day bounds + arrival-aware start floor.
      if (startMs < arrivalFloorMs) {
        return reject(
          `${nodeId} starts ${new Date(startMs).toISOString()}, before earliest_start ${new Date(arrivalFloorMs).toISOString()}`,
        );
      }
      if (startMs + durationMs > bounds.end) {
        return reject(`${nodeId} would end after latest_end ${new Date(bounds.end).toISOString()}`);
      }
      decisions.push({
        nodeId,
        action: "retime",
        newTime: new Date(startMs).toISOString(),
        reason: reason ?? "Resequenced around the delayed arrival.",
      });
    }
    // Exact coverage: every input activity decided exactly once.
    if (seen.size !== known.size) return reject(`decided ${seen.size} of ${known.size} activities`);

    // No overlaps + travel plausibility, in chronological order.
    const retimed = decisions
      .filter(
        (decision): decision is DayReorgDecision & { newTime: string } =>
          decision.action === "retime",
      )
      .sort((a, b) => Date.parse(a.newTime) - Date.parse(b.newTime));
    for (let i = 1; i < retimed.length; i += 1) {
      const prev = retimed[i - 1];
      const curr = retimed[i];
      const prevActivity = known.get(prev.nodeId)!;
      const prevEnd =
        Date.parse(prev.newTime) + Math.max(15, prevActivity.durationMinutes || 90) * MINUTE_MS;
      if (Date.parse(curr.newTime) < prevEnd) {
        return reject(`${curr.nodeId} overlaps ${prev.nodeId}`);
      }
      const transit = transitMinutesBetween(prevActivity, known.get(curr.nodeId)!);
      if (Date.parse(curr.newTime) < prevEnd + transit * MINUTE_MS) {
        return reject(`${curr.nodeId} leaves under ${transit}min to travel from ${prev.nodeId}`);
      }
    }

    // Drop honesty (Task 25 #10): the model may ONLY drop exactly what the
    // deterministic rail drops — a drop is acceptable when the day is
    // PROVABLY infeasible with every activity kept, and the model may not
    // choose WHICH activity dies (the deterministic priority order decides
    // that; dropping a high-priority activity while the rail drops the
    // lowest-priority tail is a dishonest schedule). The deterministic
    // feasibility math is the proof: the sorted dropped-nodeId lists must be
    // IDENTICAL, otherwise the whole payload is rejected (falls to the
    // deterministic resequence).
    if (decisions.some((decision) => decision.action === "drop")) {
      // The traveler's protected activity is never droppable, in any mode.
      const protectedName = request.priorityName?.trim().toLowerCase();
      if (protectedName) {
        const droppedProtected = decisions.some(
          (decision) =>
            decision.action === "drop" &&
            known.get(decision.nodeId)?.name.trim().toLowerCase() === protectedName,
        );
        if (droppedProtected) {
          return reject(`dropped "${request.priorityName}", which the traveler asked to keep`);
        }
      }
      // On a "lighten my day" mission the drop IS the answer, so the schedule
      // stands on its own merits (bounds, coverage, overlaps — all checked
      // above). Everywhere else a drop must be one the day genuinely forces.
      if (request.allowDiscretionaryDrops === true) return decisions;

      const fullFeasibility = resequenceDeterministically(request);
      const railDrops = fullFeasibility
        .filter((decision) => decision.action === "drop")
        .map((decision) => decision.nodeId)
        .sort();
      const modelDrops = decisions
        .filter((decision) => decision.action === "drop")
        .map((decision) => decision.nodeId)
        .sort();
      if (modelDrops.join("|") !== railDrops.join("|")) {
        return reject(
          `dropped [${modelDrops.join(",")}] but the day only forces [${railDrops.join(",")}]`,
        );
      }
    }
    return decisions;
  } catch (error) {
    return reject(`validator threw: ${String(error).slice(0, 80)}`);
  }
}

// ------------------------------------------------------------------ the agent

export class DayReorganizer {
  /** The shared schema-constrained transport (see geminiJsonClient.ts). */
  private readonly client: GeminiJsonClient;

  /** Task 21 — classify of the most recent degrade (undefined = none yet). */
  private degradeReason: GeminiDegradeReason | undefined;
  private degradeDetail: string | undefined;

  constructor(config: DayReorganizerConfig = {}) {
    this.client = new GeminiJsonClient({
      label: "day-reorg",
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      model: config.model ?? configuredGeminiModel("dayReorg", DEFAULT_MODEL),
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.onUsage ? { onUsage: config.onUsage } : {}),
      ...(config.sharedBudget ? { sharedBudget: config.sharedBudget } : {}),
      maxRetries: Math.max(0, Math.floor(config.maxRetries ?? 0)),
      retryDelayMs: config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      callBudget: config.callBudget ?? GEMINI_CALLS_PER_MISSION,
      // Task 25 (#11) — budget priority semantics: the SHARED pipeline walk
      // has priority over the per-plan rederive walks (the orchestrator
      // consumes this instance's budget in pipeline order first); which day
      // degrades under concurrent reorgs is intentionally not guaranteed.
      onDegrade: (reason, message) => this.degrade(reason, message),
    });
  }

  /** Task 21 (additive): Gemini calls consumed so far this mission
   *  (test/audit feed, mirrors ActivityAgent.viatorConsultsUsed). */
  get geminiCallsUsed(): number {
    return this.client.callsUsed;
  }

  /** Is an API key configured at all? (`!this.apiKey` at the old call site.) */
  private get apiKey(): string | undefined {
    return this.client.apiKey;
  }

  /** Task 21 (additive): WHY the agent last degraded — undefined when it
   *  never degraded this mission (test/audit feed). */
  get lastDegradeReason(): GeminiDegradeReason | undefined {
    return this.degradeReason;
  }

  /**
   * Reorganize one disrupted day. TOTAL by contract: ANY failure (missing
   * key, timeout, HTTP error, invalid model output, bad input) degrades to
   * the deterministic greedy rail — never throws upward, never returns an
   * unvalidated schedule. Task 21: every Gemini degrade is classified via
   * the shared taxonomy and surfaced on the outcome (`degradeReason`).
   */
  async reorganizeDay(request: DayReorgRequest): Promise<DayReorganizationOutcome> {
    let fallback: DayReorgDecision[] | null = null;
    const deterministic = (degradeReason?: GeminiDegradeReason): DayReorganizationOutcome => {
      if (fallback === null) fallback = resequenceDeterministically(request);
      return {
        decisions: fallback,
        source: "deterministic",
        ...(degradeReason !== undefined ? { degradeReason } : {}),
        ...(this.degradeDetail !== undefined ? { degradeDetail: this.degradeDetail } : {}),
      };
    };
    try {
      if (!Array.isArray(request.activities) || request.activities.length === 0) {
        return { decisions: [], source: "deterministic" };
      }
      if (!this.apiKey) {
        this.degrade("missing_key", "GEMINI_API_KEY missing — deterministic resequence");
        return deterministic("missing_key");
      }
      const result = await this.callGemini(request);
      if (!result.ok) return deterministic(result.reason);
      const parsed = parseGeminiJson(result.text);
      const decisionsPayload = isRecord(parsed) ? parsed.decisions : parsed;
      let rejection = "unspecified";
      let validated = validateReorgDecisions(decisionsPayload, request, (reason) => {
        rejection = reason;
      });
      // One failure mode is worth REPAIRING rather than discarding: a schedule
      // whose only fault is dropping an activity the day did not force out.
      // Everything else about it — the reordering, the reasons, the timing —
      // may be perfectly good work, and throwing it away costs the traveler
      // the model's judgement over one bad decision. Observed live 2026-09-01
      // on one mission in 55, after the drop ruling removed the rest.
      //
      // The repair reinstates those activities with the DETERMINISTIC rail's
      // own decision for them, then re-runs the SAME validator. Nothing is
      // waived: a repair that does not pass every rule is discarded exactly as
      // before, so this can only ever turn a rejection into a valid schedule.
      if (validated === null && rejection.startsWith("dropped [")) {
        validated = repairUnjustifiedDrops(decisionsPayload, request);
        if (validated !== null) {
          console.warn(
            `[day-reorg] repaired an unjustified drop (${rejection}) — model schedule kept`,
          );
        }
      }
      if (validated === null) {
        this.degrade(
          "invalid_output",
          `model schedule failed validation (${rejection}) — deterministic resequence`,
          rejection,
        );
        return deterministic("invalid_output");
      }
      return { decisions: validated, source: "gemini" };
    } catch (error) {
      this.degradeReason = "exception";
      console.error(
        "[day-reorg] unexpected failure — deterministic resequence (degrade: exception):",
        error,
      );
      return deterministic("exception");
    }
  }

  // ---------------------------------------------------------------- internals

  private buildSystemInstruction(request: DayReorgRequest): string {
    const protectedEcho =
      request.priorityName !== undefined && request.priorityName.trim().length > 0
        ? ` The traveler asked to protect "${request.priorityName.trim()}" — the reason of its ` +
          "decision MUST mention that it is being kept/protected as they asked."
        : "";
    return (
      "You are the itinerary reorganizer of GlobePlanner's Nexus Swarm disruption-recovery system. " +
      "A traveler's day was disrupted by a late arrival. Rebuild that ONE day: for each activity " +
      "decide exactly 'retime' (give newTime) or 'drop'. HARD RULES: every activity gets exactly " +
      (request.allowDiscretionaryDrops === true
        ? "This traveler asked for a LIGHTER day: dropping an activity is an acceptable " +
          "answer here, and you should drop the least important one when the day is " +
          "genuinely too full — but never the one they asked to protect. "
        : "Do NOT decide for yourself whether an activity has to go: `drop_ruling` in the " +
          "payload already states the verdict, computed exactly. Follow it literally. ") +
      "HARD RULES: every activity gets exactly " +
      "one decision; retimed activities never overlap; nothing may start before " +
      "`earliest_start` and every activity must END (start + its own durationMinutes) by " +
      "`latest_end` — both are given to you as exact timestamps, so use them literally " +
      "rather than recomputing them; " +
      `leave about ${BUFFER_MINUTES} minutes between activities when possible; honor the traveler's ` +
      "stated priority activity. Reasons are one short sentence each." +
      protectedEcho
    );
  }

  private buildUserPrompt(request: DayReorgRequest): string {
    // Hand over the bounds ALREADY COMPUTED as absolute timestamps.
    //
    // The prompt used to state the rule ("nothing may start before the new
    // arrival plus 60 minutes") and leave the model to do the arithmetic on an
    // ISO timestamp. Date maths is exactly what a language model is worst at,
    // and the validator rejects the whole schedule when one slot lands a minute
    // early — which is why a third of live missions fell back to the
    // deterministic resequence. Stating the answer instead of the formula
    // removes the failure class rather than hoping the model gets it right.
    const bounds = dayBoundsMs(request.date);
    // Deterministic, no network: the same resequence the validator will judge
    // the answer against, so the model is told the verdict up front.
    const forcedDrops =
      request.allowDiscretionaryDrops === true
        ? []
        : resequenceDeterministically(request)
            .filter((decision) => decision.action === "drop")
            .map((decision) => decision.nodeId)
            .sort();
    const dropRuling =
      forcedDrops.length === 0
        ? "This day FITS with every activity kept. Do NOT drop anything: return a 'retime' decision for every activity."
        : `This day cannot fit everything. Drop EXACTLY these and nothing else: ${forcedDrops.join(", ")}. Every other activity gets a 'retime'.`;
    const arrivalMs = request.newArrivalTime ? Date.parse(request.newArrivalTime) : NaN;
    const earliestStartMs = Number.isFinite(arrivalMs)
      ? Math.max(bounds?.start ?? arrivalMs, arrivalMs + ARRIVAL_TRANSIT_MARGIN_MINUTES * MINUTE_MS)
      : (bounds?.start ?? null);

    return JSON.stringify({
      date: request.date,
      day_bounds: `${String(DAY_BOUNDS_START_HOUR).padStart(2, "0")}:00–${String(DAY_BOUNDS_END_HOUR).padStart(2, "0")}:00 UTC`,
      new_arrival_time: request.newArrivalTime ?? null,
      /** No activity may START before this instant. Already includes the
       *  post-landing transit margin — do not add anything to it. */
      earliest_start: earliestStartMs !== null ? new Date(earliestStartMs).toISOString() : null,
      /** Every activity must END by this instant (start + its duration). */
      latest_end: bounds ? new Date(bounds.end).toISOString() : null,
      /** `newTime` must be a full ISO-8601 UTC timestamp, e.g. "2026-09-10T14:30:00.000Z". */
      newTime_format: "ISO-8601 UTC",
      priority_activity: request.priorityName ?? null,
      notes: request.notes ?? null,
      /**
       * The feasibility PROOF, already done — not a rule for the model to
       * apply. The prompt used to say "never drop unless the day is
       * mathematically infeasible with all of them", which asks a language
       * model to run the same interval-packing search the deterministic rail
       * runs, and then have its answer match that rail exactly. It did not:
       * on the live matrix of 2026-09-01, five of fourteen missions were
       * rejected with "dropped [X] but the day only forces []" — the model
       * trimmed a day that fit perfectly well.
       *
       * Same fix as `earliest_start`/`latest_end` above: state the answer, not
       * the formula. Omitted on a "lighten my day" mission, where choosing
       * what to drop IS the question being asked.
       */
      ...(request.allowDiscretionaryDrops === true ? {} : { drop_ruling: dropRuling }),
      activities: request.activities.map((activity) => ({
        nodeId: activity.nodeId,
        name: activity.name,
        time: activity.time,
        durationMinutes: activity.durationMinutes,
        ...(activity.coords ? { coords: activity.coords } : {}),
      })),
    });
  }

  /** Record a degrade (classification site) and keep console.error honest. */
  private degrade(reason: GeminiDegradeReason, message: string, detail?: string): void {
    this.degradeReason = reason;
    this.degradeDetail = detail;
    console.error(`[day-reorg] ${message} (degrade: ${reason})`);
  }

  /**
   * One schema-constrained Gemini conversation through the shared transport
   * ({@link GeminiJsonClient}): budget gate → laddered attempts, each with its
   * own deadline → classification through the frozen
   * {@link GeminiDegradeReason} taxonomy. Never throws.
   */
  private async callGemini(request: DayReorgRequest): Promise<GeminiCallResult> {
    const result = await this.client.requestJson({
      systemInstruction: this.buildSystemInstruction(request),
      userPrompt: this.buildUserPrompt(request),
      responseSchema: REORG_RESPONSE_SCHEMA,
      temperature: 0.2,
      maxOutputTokens: 2400,
    });
    if (!result.ok) this.degradeReason = result.reason;
    return result;
  }
}
