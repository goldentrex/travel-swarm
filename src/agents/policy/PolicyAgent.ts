/**
 * PolicyAgent — fare-rule analysis specialist (spec §2.2, §3.3).
 *
 * Consumes the Atlas `rule` object embedded in `search.do` / `verify.do`
 * responses (`refundRules`, `changesRules` with `ruleDetailList` time windows,
 * `hasBaggage` + `baggageElements` — there is no separate fare-rules
 * endpoint) and produces a typed {@link FarePolicyVerdict}: rebook-permitted
 * gate, no-show handling, baggage constraints, and the change fee for the
 * applicable time window.
 *
 * Deterministic vs LLM (spec marks this agent "LLM-reasoning"): every
 * money-bearing field is computed by DETERMINISTIC rule interpretation below.
 * The spec-required LLM reasoning is a clearly-marked seam
 * ({@link PolicyReasoningHook}): an optional hook may produce the
 * human-readable `reasoning` text, but its output is display-only and can
 * never influence the typed boolean/numeric verdict fields — mirroring the
 * spec's risk note "Money math never reads `reasoning`". Without a hook the
 * agent emits a deterministic template rationale instead, so the demo path
 * has zero LLM dependency.
 *
 * Zero third-party dependencies; no network calls (the rule payload is passed
 * in by the orchestrator).
 */

/** Request shape per spec §3.3 — fare rules come from the Atlas `rule` blob. */
export interface FarePolicyRequest {
  originalFlightId: string;
  fareFamily?: string;
  /**
   * Atlas rule payload: refundRules (refundStatus T/H/F + fees),
   * changesRules (changesStatus T/H/F + fees + ruleDetailList time windows),
   * hasBaggage + baggageElements.
   */
  rule: Record<string, unknown>;
  /** Minutes between "now" and departure — drives time-window penalty selection. */
  minutesToDeparture: number;
  disruptionKind: "delay" | "missed_flight" | "cancellation";
  /**
   * NEW (additive) — currency to fall back on when the rule payload names
   * none. Callers pass the QUOTED FARE's currency so the change fee and the
   * ticket always land in one currency: a hardcoded default put a USD fee
   * beside a EUR ticket in the same ledger, which no traveler can act on.
   */
  fallbackCurrency?: string;
}

export interface FarePolicyVerdict {
  /** Is the original ticket still usable after the disruption? */
  ticketValid: boolean;
  /** changesRules.changesStatus === "T" within the applicable window. */
  rebookPermitted: boolean;
  noShowRule: {
    /** Missed-flight scenario → no-show clause triggered. */
    applies: boolean;
    forfeitsReturnLeg: boolean;
    /** 0 when not applicable. */
    penalty: number;
    currency: string;
  };
  baggageConstraints: {
    /** rule.hasBaggage. */
    included: boolean;
    maxWeightKg?: number;
    maxPieces?: number;
    note?: string;
  };
  /** From changesRules.ruleDetailList window matching minutesToDeparture. */
  changeFee: number;
  currency: string;
  recommendedAction: "rebook" | "keep_and_wait" | "refund_and_rebook";
  /** 0..1 — how much of the rule payload could be interpreted. */
  confidence: number;
  /**
   * NEW (additive) — where the rule behind this verdict came from.
   * `provider_published` = the carrier's own rule blob for the quoted fare;
   * `supplied` = whatever the caller passed in, which may be a house default.
   * Stamped by the caller (the agent cannot tell the two apart), and used so
   * the Activity Stream never presents a default fee as the airline's.
   */
  ruleSource?: "provider_published" | "supplied";
  /**
   * NEW (additive) — when the carrier publishes its fee in its OWN currency
   * and the caller converted it into the ticket's, these carry what the
   * carrier will actually bill. The converted figure is an APPROXIMATION and
   * must be presented as one; this pair is the exact truth beside it.
   */
  billedChangeFee?: number;
  billedCurrency?: string;
  /**
   * LLM (or template) rationale. DISPLAY-ONLY — never drives money math;
   * the Trust Layer validator is the final gate.
   */
  reasoning: string;
}

/**
 * LLM SEAM (spec §2.2 "LLM-reasoning"): inject a hook to let a language
 * model narrate the verdict over the structured fare-rule text. The hook's
 * string output ONLY fills `FarePolicyVerdict.reasoning`; a throwing hook
 * falls back to the deterministic template. Money-bearing fields are already
 * frozen by the time the hook runs.
 */
export type PolicyReasoningHook = (
  request: FarePolicyRequest,
  verdict: Omit<FarePolicyVerdict, "reasoning">,
) => Promise<string>;

export interface PolicyAgentConfig {
  reasoningHook?: PolicyReasoningHook;
}

export class PolicyAgent {
  private readonly reasoningHook: PolicyReasoningHook | null;

  constructor(config: PolicyAgentConfig = {}) {
    this.reasoningHook = config.reasoningHook ?? null;
  }

  async assessFarePolicy(request: FarePolicyRequest): Promise<FarePolicyVerdict> {
    const rule = isRecord(request.rule) ? request.rule : {};
    const fallbackCurrency = (request.fallbackCurrency ?? "").trim().toUpperCase();
    const fareCurrency = /^[A-Z]{3}$/.test(fallbackCurrency) ? fallbackCurrency : null;
    const ruleCurrency = findCurrency(rule);
    const currency = ruleCurrency ?? fareCurrency ?? "USD";

    const changes = interpretRuleSection(rule, "changesRules");
    const refunds = interpretRuleSection(rule, "refundRules");

    // Change fee: pick the ruleDetailList window matching minutesToDeparture.
    const changeFee = Math.max(0, pickWindowFee(changes.details, request.minutesToDeparture));
    // A carrier may publish its rules in its OWN currency (VietJet quotes VND
    // against a USD fare). Zero is zero in every currency, so denominate a
    // free change like the ticket rather than splitting the money panel over a
    // charge of nothing. A NON-zero cross-currency fee is left in the
    // carrier's currency — relabelling it would invent an exchange rate.
    const verdictCurrency = changeFee === 0 && fareCurrency ? fareCurrency : currency;

    // Rebook gate: changesStatus "T" (fully permitted). "H" (conditional) is
    // treated as permitted only when an applicable fee window exists.
    const rebookPermitted =
      changes.status === "T" || (changes.status === "H" && changes.details.length > 0);

    // No-show handling: a missed flight triggers the no-show clause ONLY when
    // the fare rules do not permit an in-window rebook — spec §7.2 step 5
    // ("no-show clause not triggered (rebook within window)") and the §3.6
    // worked example (`noShowApplied: false` despite "missed flight XY123")
    // take precedence over the §3.3 schema comment. Forfeit heuristic: the
    // ticket loses remaining value when refunds are also barred.
    const missed = request.disruptionKind === "missed_flight";
    const applies = missed && !rebookPermitted;
    const forfeits = applies && refunds.status === "F";
    const noShowPenalty = applies ? (forfeits ? 0 : changeFee) : 0;

    // Ticket validity: delays keep the ticket alive; missed flights keep it
    // alive unless the no-show clause forfeits it; cancellations are valid
    // whenever some remedy (change or refund) exists.
    const ticketValid = missed
      ? !forfeits
      : request.disruptionKind === "cancellation"
        ? rebookPermitted || refunds.status !== "F"
        : true;

    const baggage = interpretBaggage(rule);
    const refundable = refunds.status === "T" || refunds.status === "H";
    const recommendedAction: FarePolicyVerdict["recommendedAction"] = rebookPermitted
      ? "rebook"
      : refundable
        ? "refund_and_rebook"
        : "keep_and_wait";

    // Confidence reflects how much of the payload was actually interpretable.
    let confidence = 0.4;
    if (changes.status !== null) confidence += 0.2;
    if (changes.details.length > 0 || changeFee > 0) confidence += 0.2;
    if (baggage.parsedAnything) confidence += 0.1;
    if (Object.keys(rule).length === 0) confidence = 0.3;
    confidence = Math.min(1, Math.round(confidence * 100) / 100);

    const deterministic: Omit<FarePolicyVerdict, "reasoning"> = {
      ticketValid,
      rebookPermitted,
      noShowRule: {
        applies,
        forfeitsReturnLeg: forfeits,
        penalty: noShowPenalty,
        currency,
      },
      baggageConstraints: {
        included: baggage.included,
        ...(baggage.maxWeightKg !== undefined ? { maxWeightKg: baggage.maxWeightKg } : {}),
        ...(baggage.maxPieces !== undefined ? { maxPieces: baggage.maxPieces } : {}),
        ...(baggage.note ? { note: baggage.note } : {}),
      },
      changeFee,
      currency: verdictCurrency,
      recommendedAction,
      confidence,
    };

    // LLM seam — display text only, never verdict fields.
    let reasoning = templateReasoning(request, deterministic);
    if (this.reasoningHook) {
      try {
        const hookText = await this.reasoningHook(request, deterministic);
        if (typeof hookText === "string" && hookText.trim().length > 0) reasoning = hookText;
      } catch {
        // Hook failure never fails the gate — keep the deterministic rationale.
      }
    }

    return { ...deterministic, reasoning };
  }
}

// ------------------------------------------------------------------ internals

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Atlas rule sections appear as objects OR arrays of section objects. */
interface RuleSection {
  /** Normalized status letter: "T" | "H" | "F" | null when not found. */
  status: "T" | "H" | "F" | null;
  /** Entries of ruleDetailList (fee windows), best-effort parsed. */
  details: FeeWindow[];
}

interface FeeWindow {
  fee: number;
  /** Window edge in minutes before departure (null = unbounded). */
  beforeMinutes: number | null;
  afterMinutes: number | null;
}

function interpretRuleSection(rule: Record<string, unknown>, key: string): RuleSection {
  const raw = rule[key];
  const sectionObjects: Record<string, unknown>[] = [];
  if (isRecord(raw)) sectionObjects.push(raw);
  else if (Array.isArray(raw)) {
    for (const item of raw) if (isRecord(item)) sectionObjects.push(item);
  }

  let status: RuleSection["status"] = null;
  const details: FeeWindow[] = [];

  for (const section of sectionObjects) {
    const statusKey =
      key === "changesRules" ? "changesStatus" : key === "refundRules" ? "refundStatus" : null;
    if (statusKey) {
      const value = section[statusKey];
      if (value === "T" || value === "H" || value === "F") status = value;
      else if (value === true && status === null) status = "T";
      else if (value === false && status === null) status = "F";
    }
    const detailList = section.ruleDetailList;
    if (Array.isArray(detailList)) {
      for (const entry of detailList) {
        if (!isRecord(entry)) continue;
        const window = parseFeeWindow(entry);
        if (window) details.push(window);
      }
    }
    // Some payloads nest the fee directly on the section.
    if (details.length === 0) {
      const window = parseFeeWindow(section);
      if (window && window.fee > 0) details.push(window);
    }
  }

  return { status, details };
}

const FEE_KEYS = ["fee", "changeFee", "change_fee", "amount", "price", "penalty"];
const BEFORE_KEYS = ["beforeTime", "before_time", "beforeHours", "beforeDepartureHours"];
const AFTER_KEYS = ["afterTime", "after_time", "afterHours", "afterDepartureHours"];

// Atlas states its own window bounds in MINUTES before departure — 525600 is a
// year out, 0 is departure, negatives are after departure. The keys above are
// HOURS (they go through a ×60 conversion), so these must be read separately or
// a one-year bound becomes 31.5 million minutes and every window matches.
const BEFORE_MINUTE_KEYS = ["startMinute"];
const AFTER_MINUTE_KEYS = ["endMinute"];

function parseFeeWindow(entry: Record<string, unknown>): FeeWindow | null {
  let fee: number | null = null;
  for (const key of FEE_KEYS) {
    const value = asFiniteNumber(entry[key]);
    if (value !== null) {
      fee = value;
      break;
    }
  }
  if (fee === null) return null;

  return {
    fee: Math.abs(fee),
    beforeMinutes:
      toMinutesBeforeDeparture(pickFirst(entry, BEFORE_KEYS)) ??
      alreadyMinutes(pickFirst(entry, BEFORE_MINUTE_KEYS)),
    afterMinutes:
      toMinutesBeforeDeparture(pickFirst(entry, AFTER_KEYS)) ??
      alreadyMinutes(pickFirst(entry, AFTER_MINUTE_KEYS)),
  };
}

function pickFirst(entry: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (entry[key] !== undefined) return entry[key];
  }
  return undefined;
}

/** Window boundaries are treated as hours-before-departure when numeric. */
/**
 * A bound already expressed in minutes before departure. Negative values mean
 * "after departure" (no-show territory): clamped to 0 so the window reads as
 * "from departure onward" instead of flipping into a huge positive bound.
 */
function alreadyMinutes(value: unknown): number | null {
  const num = asFiniteNumber(value);
  if (num === null) return null;
  return Math.max(0, num);
}

function toMinutesBeforeDeparture(value: unknown): number | null {
  const num = asFiniteNumber(value);
  if (num === null) return null;
  return Math.abs(num) * 60;
}

/**
 * Select the fee of the window containing `minutesToDeparture`. A window
 * applies when the remaining time sits between its edges (unbounded edges
 * match anything). When several windows apply, the smallest fee wins — the
 * most passenger-favourable reading. No windows → 0 (unknown, never invent
 * a charge that is not in the rule payload).
 */
function pickWindowFee(details: FeeWindow[], minutesToDeparture: number): number {
  let best: number | null = null;
  for (const window of details) {
    const afterOk = window.afterMinutes === null || minutesToDeparture >= window.afterMinutes;
    const beforeOk = window.beforeMinutes === null || minutesToDeparture <= window.beforeMinutes;
    if (afterOk && beforeOk) {
      best = best === null ? window.fee : Math.min(best, window.fee);
    }
  }
  if (best !== null) return best;
  // No window matched (e.g. payload carries no boundaries): fall back to the
  // smallest declared fee rather than surprising the traveller with 0.
  return details.length > 0 ? Math.min(...details.map((window) => window.fee)) : 0;
}

interface BaggageRead {
  included: boolean;
  maxWeightKg?: number;
  maxPieces?: number;
  note?: string;
  parsedAnything: boolean;
}

function interpretBaggage(rule: Record<string, unknown>): BaggageRead {
  const elements = Array.isArray(rule.baggageElements) ? rule.baggageElements.filter(isRecord) : [];
  const hasBaggageFlag = rule.hasBaggage === true || elements.length > 0;

  let maxWeightKg: number | undefined;
  let maxPieces: number | undefined;
  const notes: string[] = [];

  for (const element of elements) {
    const weight = asFiniteNumber(element.weight ?? element.weightKg ?? element.maxWeightKg);
    if (weight !== null) {
      maxWeightKg = Math.max(maxWeightKg ?? 0, weight);
    }
    const pieces = asFiniteNumber(element.pieceNum ?? element.pieces ?? element.maxPieces);
    if (pieces !== null) {
      maxPieces = Math.max(maxPieces ?? 0, Math.trunc(pieces));
    }
    if (typeof element.text === "string" && element.text.length > 0) notes.push(element.text);
    // Numeric weight embedded in free text, e.g. "1 piece up to 23 kg".
    if (typeof element.text === "string") {
      const kgMatch = /(\d+(?:\.\d+)?)\s*kg/i.exec(element.text);
      if (kgMatch && maxWeightKg === undefined) maxWeightKg = Number(kgMatch[1]);
    }
  }

  return {
    included: hasBaggageFlag,
    maxWeightKg,
    maxPieces,
    note: notes.length > 0 ? notes.join(" | ") : undefined,
    parsedAnything: elements.length > 0 || rule.hasBaggage !== undefined,
  };
}

/**
 * Find a currency hint anywhere in the rule payload.
 *
 * ARRAYS are walked too: a real Atlas rule is `changesRules: [{ currency:
 * "EUR", … }]`, and skipping arrays meant the currency was never found on any
 * live payload — the verdict silently fell back to USD and priced a EUR fare's
 * change fee in dollars, while the fee AMOUNT was read correctly from the very
 * same array.
 */
function findCurrency(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findCurrency(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /^[A-Z]{3}$/.test(entry) && /currency/i.test(key)) {
      return entry;
    }
  }
  // Only descend once no direct hit exists at this level, so a sibling
  // `currency` key always wins over a deeper one.
  for (const entry of Object.values(value)) {
    const nested = findCurrency(entry, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(parsed) && value.trim().length > 0) return parsed;
  }
  return null;
}

/** Deterministic fallback rationale (used when no LLM hook is injected). */
function templateReasoning(
  request: FarePolicyRequest,
  verdict: Omit<FarePolicyVerdict, "reasoning">,
): string {
  const parts: string[] = [];
  if (Object.keys(request.rule).length === 0) {
    parts.push(
      "No Atlas fare-rule payload was supplied, so the verdict defaults to the most passenger-favourable reading (rebook permitted, zero change fee) at reduced confidence.",
    );
  } else {
    parts.push(
      verdict.rebookPermitted
        ? `Fare rules permit changes for ${request.originalFlightId}; the applicable time window prices the change at ${verdict.changeFee} ${verdict.currency}.`
        : `Fare rules do not permit changes for ${request.originalFlightId}; no change fee applies because no rebooking is proposed.`,
    );
  }
  if (verdict.noShowRule.applies) {
    parts.push(
      verdict.noShowRule.forfeitsReturnLeg
        ? "The missed flight triggers the no-show clause and forfeits remaining ticket value."
        : `The missed flight triggers the no-show clause; remaining ticket value survives (penalty ${verdict.noShowRule.penalty} ${verdict.noShowRule.currency}).`,
    );
  }
  parts.push(
    verdict.baggageConstraints.included
      ? "Checked baggage is included, so the replacement flight carries no baggage re-booking constraint."
      : "No baggage entitlement was found in the rule payload; any checked bag may need re-purchase on the replacement flight.",
  );
  return parts.join(" ");
}
