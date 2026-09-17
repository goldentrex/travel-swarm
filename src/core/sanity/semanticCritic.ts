/**
 * The semantic critic — a language model reading a re-planned day the way a
 * person would, and saying what is absurd about it.
 *
 * WHY a model at all, when `invariants.ts` exists. The deterministic layer
 * knows what it was told: sleeping hours, meal windows, arrival buffers,
 * importance. It cannot know that Meiji Jingu closes at sunset, that sunset in
 * Tokyo in November is around 16:30, or that a shrine at 20:00 is therefore a
 * locked gate rather than a late evening. Encoding that would mean encoding
 * opening hours for every venue on earth; a model already carries a usable
 * approximation of it. That — real-world knowledge about PLACES and SEASONS —
 * is the only thing asked of it here.
 *
 * THE BOUNDARY, and it is absolute:
 *
 *   The critic never calculates money. Not a fee, not a refund, not a net
 *   payable. It returns criticisms about NODES; the deterministic engine then
 *   drops or re-times those nodes and recomputes every amount from its own
 *   rules. A criticism changes what is in the plan, never what the plan costs.
 *
 *   The critic never WAIVES a rule. {@link deterministicCriticisms} runs on
 *   every call and its findings are unioned with the model's, so a cheerful
 *   `is_sane: true` cannot clear a violation the pure rules already found.
 *   The model may only ever ADD.
 *
 *   The critic never invents a node. Criticisms naming a node the context did
 *   not contain are discarded — the standard defence against a model that
 *   answers about an itinerary it imagined.
 *
 * TOTAL by contract, exactly like the other Gemini callers: a missing key, a
 * timeout, a 429 or unparseable output degrades to the deterministic rail and
 * the pipeline continues. The critic can never stall or sink a mission.
 */

import { GeminiJsonClient, parseGeminiJson } from "@/agents/geminiJsonClient";
import { GEMINI_MODEL_CASCADE } from "@/agents/geminiCascade";
import {
  GEMINI_CALLS_PER_MISSION,
  type GeminiDegradeReason,
} from "@/agents/geminiDegrade";
import type { GeminiCallBudget, GeminiUsageObserver } from "@/agents/geminiUsage";
import { airportInfo } from "./airports";
import {
  arrivalBuffer,
  classifyItem,
  isNightActivity,
  isSensibleStart,
  minutesOfDay,
  reasonableStartWindow,
  unstayedNights,
  utcDayIndex,
  type ItemCategory,
} from "./invariants";

// ------------------------------------------------------------------ contract

/** The four absurdity classes the critic is allowed to report. Frozen. */
export type CriticIssueType =
  /** The venue is shut at the proposed hour (opening hours, sunset, season). */
  | "CLOSED_VENUE"
  /** Check-in lands before the traveller physically reaches the city. */
  | "HOTEL_PRECEDES_ARRIVAL"
  /** No room for immigration, baggage and the ride from the airport. */
  | "UNREALISTIC_TRANSIT"
  /** Scheduled when a human being is asleep. */
  | "CIRCADIAN_CONFLICT";

/** What the orchestrator should do about it. Frozen. */
export type CriticAction = "DROP" | "RETIME" | "SHIFT_DATE";

export interface Criticism {
  /** MUST be one of the node ids handed to the critic. */
  node_id: string;
  issue_type: CriticIssueType;
  /** One sentence, in the traveller's own terms. Shown to them on a drop. */
  explanation: string;
  suggested_action: CriticAction;
}

export interface CriticVerdict {
  is_sane: boolean;
  criticisms: Criticism[];
  /** Which rail produced it — `gemini` means the model ADDED to the rules. */
  source: "gemini" | "deterministic";
  /** Why the model was not used (absent when it was). */
  degradeReason?: GeminiDegradeReason;
}

/** One thing on the re-planned day the critic is asked to judge. */
export interface CriticItem {
  node_id: string;
  name: string;
  /** Proposed start, ISO-8601 (wall clock carried in UTC fields). */
  proposed_start: string;
  /**
   * The slot the traveller had BOOKED. Without it a proposal that has already
   * been clamped forward to the new arrival looks perfectly reasonable — the
   * fact that it now sits on a different calendar day is invisible.
   */
  original_start?: string;
  category: ItemCategory;
  /** Where it happens, when the trip says so. */
  city?: string;
}

/** Everything the critic is allowed to reason about. Nothing else is sent. */
export interface CriticContext {
  incident: string;
  arrival: {
    origin?: string;
    airport?: string;
    /** When the replacement lands. */
    iso: string;
    /** Landing + deplane + border + baggage + the ride into town. */
    ready_in_city_iso: string;
    /** Landing + deplane + border + baggage — standing in arrivals. */
    ready_for_pickup_iso: string;
    /** True when this arrival is on a LATER calendar day than the original. */
    is_next_day: boolean;
    original_arrival_iso?: string;
  };
  hotel?: {
    node_id: string;
    name: string;
    booked_check_in: string;
    proposed_check_in: string;
  };
  items: CriticItem[];
}

// ------------------------------------------------------ the deterministic rail

/**
 * Venue classes that shut at or near dusk, whatever the season says. A shrine,
 * a garden or a castle keep "sunset hours": the gate closes, the grounds empty
 * and the ticket office is long shut. This is a FLOOR, deliberately coarse —
 * the model is what knows that Meiji Jingu specifically closes around 16:30 in
 * November. The floor exists so the offline rail is not blind to the whole
 * issue class.
 */
const SUNSET_CLOSING_PATTERN =
  /\b(shrine|jingu|jinja|temple|tera|wat |pagoda|garden|gardens|park|zoo|botanic\w*|castle|palace|fort|ruins|cemetery|necropolis|viewpoint|lookout|summit|trail|hike|hiking|safari|vineyard|orchard|archaeolog\w*|acropolis|forum|colosseum)\b/i;

/** Past this hour a sunset-closing venue is assumed shut. */
const SUNSET_CLOSE_MINUTES = 17 * 60;

function parse(iso: string | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}

function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Everything the pure rules can prove without knowing a single venue.
 *
 * Runs on EVERY review, model or not: it is the floor the model may add to and
 * can never lower. Ordered so the most structural finding (a check-in before
 * the traveller lands) reads first.
 */
export function deterministicCriticisms(context: CriticContext): Criticism[] {
  const out: Criticism[] = [];
  const readyInCityMs = parse(context.arrival.ready_in_city_iso);
  const readyForPickupMs = parse(context.arrival.ready_for_pickup_iso);
  const arrivalMs = parse(context.arrival.iso);

  // 1. A room cannot be entered before the traveller is in the city.
  //
  //    The test is against what they BOOKED, not against the anchor the
  //    engine has already corrected to — the correction is the remedy, and
  //    measuring the remedy against itself can only ever say "fine". What
  //    matters to the traveller is whether the reservation they are holding
  //    still matches the flight they are now on.
  if (context.hotel) {
    const bookedMs = parse(context.hotel.booked_check_in);
    const remedyMs = Math.max(parse(context.hotel.proposed_check_in) || bookedMs, readyInCityMs);
    if (Number.isFinite(bookedMs) && Number.isFinite(readyInCityMs) && bookedMs < readyInCityMs) {
      // A NIGHT later is a date shift; a few hours later is a late check-in,
      // which every reception in the world already handles.
      const nightsLost = unstayedNights(bookedMs, remedyMs);
      const city = airportInfo(context.arrival.airport)?.city ?? "the city";
      out.push({
        node_id: context.hotel.node_id,
        issue_type: "HOTEL_PRECEDES_ARRIVAL",
        explanation:
          nightsLost > 0
            ? `You now reach ${city} on ${dayKey(remedyMs)}, so the ${dayKey(bookedMs)} check-in at ${context.hotel.name} cannot happen — that night goes unused.`
            : `You reach ${context.hotel.name} at about ${hhmm(readyInCityMs)}, after the ${hhmm(bookedMs)} check-in on the booking.`,
        suggested_action: nightsLost > 0 ? "SHIFT_DATE" : "RETIME",
      });
    }
  }

  for (const item of context.items) {
    const startMs = parse(item.proposed_start);
    if (!Number.isFinite(startMs)) continue;

    // 2. Nothing before the traveller is physically there. A pickup waits for
    //    arrivals; anything downtown waits for the ride in as well.
    const floorMs = item.category === "ground_transfer" ? readyForPickupMs : readyInCityMs;
    if (Number.isFinite(floorMs) && startMs < floorMs) {
      out.push({
        node_id: item.node_id,
        issue_type: "UNREALISTIC_TRANSIT",
        explanation:
          item.category === "ground_transfer"
            ? `The flight lands at ${hhmm(arrivalMs)}; you clear immigration and baggage at about ${hhmm(floorMs)}, so a ${hhmm(startMs)} pickup would be waiting for you.`
            : `You are not in town until about ${hhmm(floorMs)} — ${item.name} at ${hhmm(startMs)} cannot happen.`,
        suggested_action: item.category === "ground_transfer" ? "RETIME" : "DROP",
      });
      continue;
    }

    // 2b. An item that ended up on a DIFFERENT calendar day than the one it
    //     was booked for. Tomorrow already has its own plan, and quietly
    //     stacking into it is how a day of eight items became a day of eleven
    //     — the same rule `placeDisplacedItem` enforces on the cascade path,
    //     which the proposal path used to be able to slip past once the
    //     arrival clamp had pushed a slot over midnight.
    const originalMs = parse(item.original_start);
    if (
      Number.isFinite(originalMs) &&
      utcDayIndex(startMs) !== utcDayIndex(originalMs) &&
      item.category !== "lodging" &&
      item.category !== "primary_transit"
    ) {
      out.push({
        node_id: item.node_id,
        issue_type: "UNREALISTIC_TRANSIT",
        explanation: `${item.name} was booked for ${dayKey(originalMs)} and could now only happen on ${dayKey(startMs)}, which already has its own plan.`,
        suggested_action: "DROP",
      });
      continue;
    }

    // 3. Human hours. Lodging, transit and transfers are exempt by rule — a
    //    late check-in and a 01:00 pickup are real, bookable services.
    const verdict = isSensibleStart(item.category, item.name, startMs);
    if (!verdict.ok) {
      out.push({
        node_id: item.node_id,
        issue_type:
          verdict.reason === "sleeping_hours" ? "CIRCADIAN_CONFLICT" : "CLOSED_VENUE",
        explanation:
          verdict.reason === "sleeping_hours"
            ? `${item.name} at ${hhmm(startMs)} falls in the middle of the night.`
            : `${item.name} at ${hhmm(startMs)} is outside the hours it makes sense in.`,
        suggested_action: "DROP",
      });
      continue;
    }

    // 4. The coarse dusk floor (see SUNSET_CLOSING_PATTERN).
    if (
      SUNSET_CLOSING_PATTERN.test(item.name) &&
      !isNightActivity(item.name) &&
      minutesOfDay(startMs) >= SUNSET_CLOSE_MINUTES
    ) {
      out.push({
        node_id: item.node_id,
        issue_type: "CLOSED_VENUE",
        explanation: `${item.name} is an outdoor/grounds visit that closes around dusk — ${hhmm(startMs)} is after the gates shut.`,
        suggested_action: "DROP",
      });
    }
  }
  return out;
}

// -------------------------------------------------------------- the LLM rail

/**
 * The critic's system instruction.
 *
 * Written against the three ways a critic like this goes wrong in production:
 * it invents nodes, it re-plans instead of criticising, and it volunteers
 * opinions about money. Each has an explicit prohibition, and the sanitizer
 * below enforces all three regardless of what the model does.
 */
export const CRITIC_SYSTEM_INSTRUCTION =
  "You are the common-sense reviewer of GlobePlanner's Nexus Swarm disruption-recovery system. " +
  "A traveller's flight was disrupted and the engine has re-planned their day. Your ONE job is to " +
  "spot what is physically or practically ABSURD about the result, using real-world knowledge the " +
  "engine does not have: typical opening hours of the named places, what closes at sunset, what " +
  "time it gets dark in that city in that month, how long it really takes to get from that airport " +
  "into that city, and what a human being can actually do after a long flight.\n" +
  "All timestamps are ISO-8601 and are LOCAL wall-clock time at the destination. " +
  "Report at most 8 problems, most serious first.\n" +
  "HARD RULES:\n" +
  "1. Only ever name a node_id that appears in the payload. Never invent one.\n" +
  "2. Never mention, estimate or reason about money — no prices, fees, refunds or compensation. " +
  "Another system owns every amount and yours would be wrong.\n" +
  "3. Do not re-plan. Do not propose times, alternatives or a new schedule. State the problem and " +
  "pick ONE action: DROP (cannot sensibly happen at all), RETIME (same day, later, still sensible) " +
  "or SHIFT_DATE (belongs on a later date — hotel check-in only).\n" +
  "4. An item is NOT a problem merely because it is tight, ambitious or tiring. Report it only if " +
  "a reasonable traveller would call it impossible or pointless — a locked gate, a bed they cannot " +
  "reach, a night with no sleep.\n" +
  "5. Hotel check-in, airport transfers and flights are never 'too late': hotels take late arrivals " +
  "and drivers work at night. Only flag those if they happen BEFORE the traveller can be there.\n" +
  "6. explanation is ONE short sentence addressed to the traveller, stating the real-world fact " +
  "behind the problem (e.g. 'Meiji Jingu closes at sunset, about 16:30 in November').\n" +
  "If nothing is absurd, return is_sane true and an empty criticisms array.";

/** Gemini `responseSchema` — the structured-output contract of §3.1. */
export const CRITIC_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_sane: { type: "BOOLEAN" },
    criticisms: {
      type: "ARRAY",
      maxItems: 8,
      items: {
        type: "OBJECT",
        properties: {
          node_id: { type: "STRING" },
          issue_type: {
            type: "STRING",
            enum: ["CLOSED_VENUE", "HOTEL_PRECEDES_ARRIVAL", "UNREALISTIC_TRANSIT", "CIRCADIAN_CONFLICT"],
          },
          explanation: { type: "STRING" },
          suggested_action: { type: "STRING", enum: ["DROP", "RETIME", "SHIFT_DATE"] },
        },
        required: ["node_id", "issue_type", "explanation", "suggested_action"],
      },
    },
  },
  required: ["is_sane", "criticisms"],
} as const;

const ISSUE_TYPES: ReadonlySet<string> = new Set([
  "CLOSED_VENUE",
  "HOTEL_PRECEDES_ARRIVAL",
  "UNREALISTIC_TRANSIT",
  "CIRCADIAN_CONFLICT",
]);
const ACTIONS: ReadonlySet<string> = new Set(["DROP", "RETIME", "SHIFT_DATE"]);
const EXPLANATION_MAX = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep only criticisms that are about THIS plan and shaped as promised.
 *
 * `knownNodeIds` is the whole defence against a model answering about an
 * itinerary it imagined: a criticism of a node we never sent is not a finding,
 * it is noise, and acting on it would drop something real.
 */
export function sanitizeCriticisms(value: unknown, knownNodeIds: ReadonlySet<string>): Criticism[] | null {
  const payload = isRecord(value) ? value.criticisms : value;
  if (!Array.isArray(payload)) return null;
  const out: Criticism[] = [];
  const seen = new Set<string>();
  for (const entry of payload) {
    if (!isRecord(entry)) continue;
    const nodeId = typeof entry.node_id === "string" ? entry.node_id.trim() : "";
    const issueType = typeof entry.issue_type === "string" ? entry.issue_type.trim().toUpperCase() : "";
    const action = typeof entry.suggested_action === "string" ? entry.suggested_action.trim().toUpperCase() : "";
    const explanation = typeof entry.explanation === "string" ? entry.explanation.trim() : "";
    if (!knownNodeIds.has(nodeId)) continue;
    if (!ISSUE_TYPES.has(issueType) || !ACTIONS.has(action)) continue;
    if (explanation.length === 0) continue;
    const key = `${nodeId}|${issueType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      node_id: nodeId,
      issue_type: issueType as CriticIssueType,
      explanation: explanation.slice(0, EXPLANATION_MAX),
      suggested_action: action as CriticAction,
    });
  }
  return out;
}

/**
 * Union of the pure rules and the model, rules first.
 *
 * A node the deterministic layer already ruled on keeps THAT ruling: the rules
 * are proofs, the model's answer is an opinion, and where they disagree about
 * the same node the proof wins. Everything the model found about other nodes is
 * added.
 */
export function mergeCriticisms(deterministic: Criticism[], model: Criticism[]): Criticism[] {
  const ruled = new Set(deterministic.map((c) => c.node_id));
  return [...deterministic, ...model.filter((c) => !ruled.has(c.node_id))];
}

export interface SemanticCriticConfig {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onUsage?: GeminiUsageObserver;
  sharedBudget?: GeminiCallBudget;
  maxRetries?: number;
  retryDelayMs?: number;
  callBudget?: number;
  /**
   * Hard off switch. The critic is also disabled when no API key is present,
   * which is what makes every offline test and every CI run deterministic
   * without needing to mock anything.
   */
  enabled?: boolean;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL = GEMINI_MODEL_CASCADE[0];

export class SemanticCritic {
  private readonly client: GeminiJsonClient;
  private readonly enabled: boolean;
  private degradeReason: GeminiDegradeReason | undefined;

  constructor(config: SemanticCriticConfig = {}) {
    this.enabled = config.enabled ?? true;
    this.client = new GeminiJsonClient({
      label: "critic",
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      model: config.model ?? DEFAULT_MODEL,
      // Tighter than the liaison's 10s: the critic sits on the resolve path,
      // between the traveller's answer and the plans they are shown, and a
      // slow opinion is worth less than a fast deterministic one.
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.onUsage ? { onUsage: config.onUsage } : {}),
      ...(config.sharedBudget ? { sharedBudget: config.sharedBudget } : {}),
      maxRetries: Math.max(0, Math.floor(config.maxRetries ?? 0)),
      ...(config.retryDelayMs !== undefined ? { retryDelayMs: config.retryDelayMs } : {}),
      callBudget: config.callBudget ?? GEMINI_CALLS_PER_MISSION,
      onDegrade: (reason, message) => {
        this.degradeReason = reason;
        console.error(`[critic] ${message} (degrade: ${reason})`);
      },
    });
  }

  /** Why the last review degraded to the rules alone (undefined = it did not). */
  get lastDegradeReason(): GeminiDegradeReason | undefined {
    return this.degradeReason;
  }

  get geminiCallsUsed(): number {
    return this.client.callsUsed;
  }

  /**
   * Review ONE re-planned arrival day. TOTAL: never throws, always returns a
   * verdict, and the deterministic findings are in it whatever the model did.
   */
  async review(context: CriticContext): Promise<CriticVerdict> {
    this.degradeReason = undefined;
    const rules = deterministicCriticisms(context);
    const settle = (criticisms: Criticism[], source: CriticVerdict["source"]): CriticVerdict => ({
      is_sane: criticisms.length === 0,
      criticisms,
      source,
      ...(this.degradeReason !== undefined ? { degradeReason: this.degradeReason } : {}),
    });

    try {
      if (!this.enabled) return settle(rules, "deterministic");
      if (!this.client.apiKey) {
        this.degradeReason = "missing_key";
        return settle(rules, "deterministic");
      }
      // Nothing to have an opinion about — do not spend a call on an empty day.
      if (context.items.length === 0 && !context.hotel) return settle(rules, "deterministic");

      const result = await this.client.requestJson({
        systemInstruction: CRITIC_SYSTEM_INSTRUCTION,
        userPrompt: buildCriticPrompt(context),
        responseSchema: CRITIC_RESPONSE_SCHEMA,
        temperature: 0.1,
        maxOutputTokens: 1600,
      });
      if (!result.ok) {
        this.degradeReason = result.reason;
        return settle(rules, "deterministic");
      }
      const known = new Set<string>(context.items.map((item) => item.node_id));
      if (context.hotel) known.add(context.hotel.node_id);
      const model = sanitizeCriticisms(parseGeminiJson(result.text), known);
      if (model === null) {
        this.degradeReason = "invalid_output";
        console.error("[critic] verdict payload invalid — rules only (degrade: invalid_output)");
        return settle(rules, "deterministic");
      }
      return settle(mergeCriticisms(rules, model), "gemini");
    } catch (error) {
      this.degradeReason = "exception";
      console.error("[critic] review failed — rules only (degrade: exception):", error);
      return settle(rules, "deterministic");
    }
  }
}

/**
 * The user payload. Facts only, already computed — the buffers are handed over
 * as absolute timestamps rather than as arithmetic for the model to do, the
 * same lesson the day reorganizer learned the hard way on the live matrix of
 * 2026-09-01. No prices anywhere: the critic is not shown money, so it cannot
 * be tempted to reason about it.
 */
export function buildCriticPrompt(context: CriticContext): string {
  const destination = airportInfo(context.arrival.airport);
  return JSON.stringify({
    incident: context.incident,
    arrival: {
      from: context.arrival.origin ?? null,
      airport: context.arrival.airport ?? null,
      airport_city: destination?.city ?? null,
      lands_at: context.arrival.iso,
      /** Standing in arrivals: landing + deplaning + immigration + baggage. */
      ready_at_airport: context.arrival.ready_for_pickup_iso,
      /** In the city centre — do not add anything to this, it is the answer. */
      ready_in_city: context.arrival.ready_in_city_iso,
      arrives_a_day_later_than_booked: context.arrival.is_next_day,
      originally_landed_at: context.arrival.original_arrival_iso ?? null,
    },
    hotel: context.hotel
      ? {
          node_id: context.hotel.node_id,
          name: context.hotel.name,
          originally_checked_in: context.hotel.booked_check_in,
          now_checking_in: context.hotel.proposed_check_in,
        }
      : null,
    scheduled_items: context.items.map((item) => ({
      node_id: item.node_id,
      name: item.name,
      city: item.city ?? destination?.city ?? null,
      starts_at: item.proposed_start,
      originally_started_at: item.original_start ?? null,
      kind: item.category,
    })),
  });
}

// ------------------------------------------------------------- applying it

/** One node's fate, as the orchestrator will enact it. */
export type CriticRuling =
  | { action: "drop"; reason: string; issue: CriticIssueType }
  | { action: "retime"; atMs: number; reason: string; issue: CriticIssueType }
  | { action: "shift_date"; toMs: number; reason: string; issue: CriticIssueType };

/**
 * Turn criticisms into rulings the deterministic engine can enact.
 *
 * The critic says WHAT is wrong; this decides what happens, and it is here —
 * not in the model — that the codebase's own invariants bind:
 *
 *  - RETIME means later the SAME day, at the first hour that is sensible for
 *    what the item is. If no such hour exists the ruling becomes a drop,
 *    because silently stacking an item onto tomorrow hands the traveller a day
 *    that already has its own plan (the rule `placeDisplacedItem` enforces on
 *    the cascade path).
 *  - SHIFT_DATE is honoured for LODGING only. A bed on a later date is a real
 *    thing; a museum ticket on a later date is a new booking, not a re-time.
 *  - A drop keeps the item's own penalty and terms untouched upstream — the
 *    ledger is recomputed by the deterministic engine from the surviving set.
 */
export function rulingsFor(
  verdict: CriticVerdict,
  context: CriticContext,
): Map<string, CriticRuling> {
  const rulings = new Map<string, CriticRuling>();
  const byId = new Map(context.items.map((item) => [item.node_id, item]));
  const readyInCityMs = parse(context.arrival.ready_in_city_iso);
  const readyForPickupMs = parse(context.arrival.ready_for_pickup_iso);

  for (const criticism of verdict.criticisms) {
    const reason = criticism.explanation;
    // The hotel: the one node a date shift is legitimate for.
    if (context.hotel && criticism.node_id === context.hotel.node_id) {
      const proposedMs = parse(context.hotel.proposed_check_in);
      const target = Math.max(
        Number.isFinite(proposedMs) ? proposedMs : readyInCityMs,
        readyInCityMs,
      );
      if (Number.isFinite(target)) {
        rulings.set(criticism.node_id, {
          action: criticism.suggested_action === "SHIFT_DATE" ? "shift_date" : "retime",
          ...(criticism.suggested_action === "SHIFT_DATE" ? { toMs: target } : { atMs: target }),
          reason,
          issue: criticism.issue_type,
        } as CriticRuling);
      }
      continue;
    }

    const item = byId.get(criticism.node_id);
    if (!item) continue;
    const startMs = parse(item.proposed_start);
    if (!Number.isFinite(startMs)) continue;
    const bookedMs = parse(item.original_start);

    if (criticism.suggested_action === "DROP") {
      rulings.set(item.node_id, { action: "drop", reason, issue: criticism.issue_type });
      continue;
    }

    // RETIME / SHIFT_DATE on a non-lodging node both mean the same thing here:
    // find the first sensible slot later today, or drop honestly.
    const floorMs = item.category === "ground_transfer" ? readyForPickupMs : readyInCityMs;
    const candidateMs = Number.isFinite(floorMs) ? Math.max(startMs, floorMs) : startMs;
    const slotMs = nextSensibleSlot(
      item,
      candidateMs,
      Number.isFinite(bookedMs) ? bookedMs : startMs,
    );
    if (slotMs === null) {
      rulings.set(item.node_id, { action: "drop", reason, issue: criticism.issue_type });
    } else {
      rulings.set(item.node_id, { action: "retime", atMs: slotMs, reason, issue: criticism.issue_type });
    }
  }
  return rulings;
}

/**
 * The first instant at or after `fromMs` that is a sensible start for this
 * item, on the SAME calendar day. `null` when the day has no such instant
 * left, which is the honest answer far more often than it looks: a shrine
 * criticised at 20:00 has no later slot that day, and tomorrow is not ours to
 * fill.
 */
function nextSensibleSlot(item: CriticItem, fromMs: number, originalMs: number): number | null {
  if (item.category === "ground_transfer" || item.category === "lodging") return fromMs;
  const window = reasonableStartWindow(item.category, item.name, minutesOfDay(originalMs));
  if (!window) return fromMs;
  const minutes = minutesOfDay(fromMs);
  if (minutes > window.latest) return null;
  const atMs = minutes < window.earliest ? fromMs + (window.earliest - minutes) * 60_000 : fromMs;
  if (dayKey(atMs) !== dayKey(fromMs)) return null;
  if (Number.isFinite(originalMs) && utcDayIndex(atMs) !== utcDayIndex(originalMs)) return null;
  return isSensibleStart(item.category, item.name, atMs, minutesOfDay(originalMs)).ok ? atMs : null;
}

/** Classify a plain itinerary/graph node for the critic context. */
export function criticCategoryOf(type: string | null | undefined, title: string): ItemCategory {
  return classifyItem({ type, title });
}

/** The realistic post-landing buffers for a route, as the critic states them. */
export function arrivalWindows(
  origin: string | undefined,
  destination: string | undefined,
  arrivalMs: number,
): { readyForPickupMs: number; readyInCityMs: number } {
  const buffer = arrivalBuffer(origin, destination);
  return {
    readyForPickupMs: arrivalMs + buffer.readyForPickupMinutes * 60_000,
    readyInCityMs: arrivalMs + buffer.readyInCityMinutes * 60_000,
  };
}
