/**
 * GeminiLiaisonAgent — the user-preference liaison of the two-phase
 * assess/resolve Nexus Swarm flow.
 *
 * Phase 1 (assess) produces RAW provider candidates; before phase 2 (resolve)
 * builds concrete ResolutionPlans, this agent asks the traveler 1–2 targeted
 * trade-off questions (cheapest vs. fastest flight, keep vs. rebook hotel)
 * and translates the answers into machine-readable {@link ResolutionConstraints}.
 *
 * Design rules (mirroring the rest of the agent layer):
 *  - Gemini REST over plain `fetch` (Worker/nodejs_compat module — NOT Deno),
 *    JSON-mode + `responseSchema` constrained output, tight ~10s deadline.
 *  - Every method is TOTAL: a missing API key, network failure, 429/503, or
 *    unrepairable model output never throws — it degrades to `null`
 *    (questions ⇒ caller falls back to {@link buildDeterministicTradeoffs})
 *    or to deterministic constraints (translation ⇒ heuristic option-id map).
 *  - Hand-rolled validators, no zod. Failures log via console.error only.
 *  - Multi-language: user-facing strings are produced in the caller-provided
 *    BCP-47 language (en/de/es/fr/zh), both by the model prompt and by the
 *    deterministic fallback dictionary (English for unknown codes).
 */

// --------------------------------------------------------------------- types

import {
  configuredGeminiModel,
  emitGeminiUsage,
  readGeminiUsage,
  type GeminiUsageEvent,
  type GeminiUsageObserver,
  type GeminiCallBudget,
} from "../geminiUsage";
import {
  GEMINI_MODEL_CASCADE,
  modelLadder,
  noteModelExhausted,
  noteModelHealthy,
} from "@/agents/geminiCascade";
import {
  GEMINI_CALLS_PER_MISSION,
  type GeminiCallResult,
  type GeminiDegradeReason,
} from "../geminiDegrade";

/** One selectable answer option of a trade-off question (frozen contract). */
export interface TradeoffOption {
  id: string;
  label: string;
  detail?: string;
}

/** One trade-off question presented during `gathering_preferences`
 *  (frozen contract — always EXACTLY 2 options). */
export interface TradeoffQuestion {
  id: string;
  question: string;
  detail?: string;
  options: TradeoffOption[];
}

/** The user's selection for one question (question id → chosen option id). */
export interface TradeoffAnswer {
  question_id: string;
  option_id: string;
}

/** Machine-readable traveler preferences feeding phase 2 plan selection. */
export interface ResolutionConstraints {
  max_price?: number;
  prefer_direct?: boolean;
  keep_hotel?: boolean;
  prefer_earliest?: boolean;
  /** NEW (W1, additive) — traveler picked the nonstop side of the
   *  stops trade-off question. Filtered/pinned like `prefer_direct`. */
  prefer_nonstop?: boolean;
  /** NEW (W1, additive) — traveler wants to travel on the disruption day
   *  itself (true) or explicitly accepted a later day (false). */
  prefer_same_day?: boolean;
  /** NEW (W1, additive) — display name of the at-risk activity the
   *  traveler chose to keep (feeds day-reorganization priorities). */
  activity_priority?: string;
  notes?: string;
  /** NEW: Minimum delay from now for a missed flight (in hours). */
  min_departure_delay_hours?: number;
}

/** Input context for {@link GeminiLiaisonAgent.generateTradeoffQuestions}. */
export interface TradeoffQuestionContext {
  /** Plain-text incident summary, e.g. "Flight XY123 delayed by 4h". */
  incident?: string;
  /** Raw provider candidates persisted on the session between phases. */
  candidates: unknown;
  /** Set when the disruption touches the hotel leg (adds the hotel question). */
  hotel_impacted?: boolean;
  /** Set when the hotel ITSELF failed the traveler (overbooked / no-show at
   *  check-in) rather than merely needing a look because something else
   *  shifted — there is no existing booking left to "keep", so the hotel
   *  question must offer rebooking options instead of a keep/rebook choice. */
  hotel_overbooked?: boolean;
  /** BCP-47 language for user-facing strings ('en', 'de', 'es', 'fr', 'zh'). */
  language?: string;
}

export interface GeminiLiaisonConfig {
  /** Opt-in local routing for an empty answer set or exact known preference ids. */
  constraintRouting?: "model" | "deterministic_known";
  /** Gemini API key; defaults to `process.env.GEMINI_API_KEY`. */
  apiKey?: string;
  /** Per-call deadline in ms (default 20s) — shared by the attempt AND its
   *  fallback-model retry, so it must leave room for both. */
  timeoutMs?: number;
  /** Model id (default gemini-3.7-flash). */
  model?: string;
  /**
   * Ordered fallbacks are shared, not per-agent: see `geminiCascade.ts`. Set
   * `model` to lead the ladder with a specific one.
   */
  /** Injectable fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** One sanitized measurement per actual HTTP attempt, including failures. */
  onUsage?: GeminiUsageObserver;
  /** Shared across liaison and day replanning for one resolve invocation. */
  sharedBudget?: GeminiCallBudget;
  /**
   * Task 21 (additive): retries on a quota classify (`quota_429` — 429/503).
   * Default 0 (single-shot — the assess rail). The async resolve rail wires
   * exactly ONE retry; the backoff rides inside the existing deadline.
   */
  maxRetries?: number;
  /** Task 21 (additive): backoff before the retry in ms (default 1500);
   *  injectable so tests can shorten it. */
  retryDelayMs?: number;
  /** Task 21 (additive): per-instance Gemini call budget
   *  (default {@link GEMINI_CALLS_PER_MISSION}) — same counter pattern as
   *  ActivityAgent's viatorConsultsUsed. Exhaustion ⇒ skip + `quota_429`. */
  callBudget?: number;
}

// Measured live on 2026-08-31 (wrangler tail): gemini-3.7-flash answered 503
// "this model is currently experiencing high demand" or simply hung past the
// deadline on EVERY swarm call, so the whole rail silently ran on its
// deterministic fallback. 3.6-flash answers promptly under the same load.
const DEFAULT_MODEL = GEMINI_MODEL_CASCADE[0];
/** Covers the primary attempt AND the fallback-model retry (was 10s, which the
 *  503-then-retry sequence blew through, degrading with reason "timeout"). */
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 1_500;

// --------------------------------------------------------- localization (UI)

type SupportedLanguage = "en" | "de" | "es" | "fr" | "zh";

interface LocalizedTradeoffStrings {
  flightQuestion: string;
  flightDetail: string;
  cheapest: string;
  cheapestDetail: string;
  fastest: string;
  fastestDetail: string;
  activityQuestion: string;
  activityDetail: string;
  slowDown: string;
  slowDownDetail: string;
  stayActive: string;
  stayActiveDetail: string;
  hotelQuestion: string;
  hotelDetail: string;
  keep: string;
  keepDetail: string;
  rebook: string;
  rebookDetail: string;
  /** Overbooked variant — no existing booking survives, so there is no
   *  "keep" option; both choices are flavors of rebooking. */
  hotelOverbookedQuestion: string;
  hotelOverbookedDetail: string;
  rebookNearby: string;
  rebookNearbyDetail: string;
  rebookBestValue: string;
  rebookBestValueDetail: string;
}

/** Canned fallback copy for the five supported app locales. */
const TRADEOFF_STRINGS: Record<SupportedLanguage, LocalizedTradeoffStrings> = {
  en: {
    flightQuestion: "How should we pick your replacement flight?",
    flightDetail: "The swarm found rebooking options. Tell us what matters most.",
    cheapest: "Cheapest option",
    cheapestDetail: "Minimize the fare difference",
    fastest: "Fastest option",
    fastestDetail: "Depart as soon as possible",
    activityQuestion: "How should we reshape your activities?",
    activityDetail: "No flights are affected — tell us how you'd like to spend the time.",
    slowDown: "Slow it down",
    slowDownDetail: "Fewer bookings, more breathing room",
    stayActive: "Keep the day full",
    stayActiveDetail: "Fill the gap with a new experience",
    hotelQuestion: "What should we do about your hotel?",
    hotelDetail: "Your arrival time is shifting.",
    keep: "Keep my booking",
    keepDetail: "Hold the current room",
    rebook: "Rebook for me",
    rebookDetail: "Find a comparable room",
    hotelOverbookedQuestion: "Your hotel can't take you — what next?",
    hotelOverbookedDetail: "They're unable to honor the booking. Let's find you somewhere else.",
    rebookNearby: "Closest match",
    rebookNearbyDetail: "Same area, comparable room",
    rebookBestValue: "Best value nearby",
    rebookBestValueDetail: "Widen the search for a better rate",
  },
  de: {
    flightQuestion: "Wie sollen wir Ihren Ersatzflug auswählen?",
    flightDetail: "Der Swarm hat Umbuchungsoptionen gefunden. Was ist Ihnen am wichtigsten?",
    cheapest: "Günstigste Option",
    cheapestDetail: "Preisdifferenz minimieren",
    fastest: "Schnellste Option",
    fastestDetail: "So früh wie möglich abfliegen",
    activityQuestion: "Wie sollen wir Ihre Aktivitäten anpassen?",
    activityDetail: "Keine Flüge betroffen — sagen Sie uns, wie Sie die Zeit verbringen möchten.",
    slowDown: "Ruhiger angehen",
    slowDownDetail: "Weniger Buchungen, mehr Freiraum",
    stayActive: "Den Tag ausfüllen",
    stayActiveDetail: "Die Lücke mit einem neuen Erlebnis füllen",
    hotelQuestion: "Was sollen wir mit Ihrem Hotel tun?",
    hotelDetail: "Ihre Ankunftszeit verschiebt sich.",
    keep: "Buchung behalten",
    keepDetail: "Aktuelles Zimmer halten",
    rebook: "Für mich umbuchen",
    rebookDetail: "Vergleichbares Zimmer finden",
    hotelOverbookedQuestion: "Ihr Hotel kann Sie nicht aufnehmen — wie geht es weiter?",
    hotelOverbookedDetail:
      "Die Buchung kann dort nicht eingehalten werden. Wir suchen eine Alternative.",
    rebookNearby: "Nächstgelegene Option",
    rebookNearbyDetail: "Gleiche Gegend, vergleichbares Zimmer",
    rebookBestValue: "Bestes Angebot in der Nähe",
    rebookBestValueDetail: "Suche nach einem besseren Preis erweitern",
  },
  es: {
    flightQuestion: "¿Cómo elegimos tu vuelo alternativo?",
    flightDetail: "El enjambre encontró opciones de re-reserva. ¿Qué te importa más?",
    cheapest: "La opción más barata",
    cheapestDetail: "Minimizar la diferencia de tarifa",
    fastest: "La opción más rápida",
    fastestDetail: "Salir lo antes posible",
    activityQuestion: "¿Cómo adaptamos tus actividades?",
    activityDetail: "Ningún vuelo está afectado: cuéntanos cómo quieres aprovechar el tiempo.",
    slowDown: "Bajar el ritmo",
    slowDownDetail: "Menos reservas, más tranquilidad",
    stayActive: "Mantener el día completo",
    stayActiveDetail: "Llenar el hueco con una experiencia nueva",
    hotelQuestion: "¿Qué hacemos con tu hotel?",
    hotelDetail: "Tu hora de llegada está cambiando.",
    keep: "Mantener mi reserva",
    keepDetail: "Conservar la habitación actual",
    rebook: "Re-reservar por mí",
    rebookDetail: "Buscar una habitación comparable",
    hotelOverbookedQuestion: "Tu hotel no puede alojarte — ¿qué hacemos?",
    hotelOverbookedDetail: "No pueden respetar la reserva. Busquemos otra opción.",
    rebookNearby: "La opción más cercana",
    rebookNearbyDetail: "Misma zona, habitación comparable",
    rebookBestValue: "Mejor precio cerca",
    rebookBestValueDetail: "Ampliar la búsqueda para una mejor tarifa",
  },
  fr: {
    flightQuestion: "Comment choisir votre vol de remplacement ?",
    flightDetail: "L'essaim a trouvé des options de re-réservation. Qu'est-ce qui compte le plus ?",
    cheapest: "L'option la moins chère",
    cheapestDetail: "Minimiser la différence tarifaire",
    fastest: "L'option la plus rapide",
    fastestDetail: "Partir le plus tôt possible",
    activityQuestion: "Comment adapter vos activités ?",
    activityDetail: "Aucun vol n'est touché — dites-nous comment vous souhaitez occuper le temps.",
    slowDown: "Ralentir le rythme",
    slowDownDetail: "Moins de réservations, plus de liberté",
    stayActive: "Garder la journée remplie",
    stayActiveDetail: "Combler le temps libre avec une nouvelle expérience",
    hotelQuestion: "Que faisons-nous pour votre hôtel ?",
    hotelDetail: "Votre heure d'arrivée est décalée.",
    keep: "Garder ma réservation",
    keepDetail: "Conserver la chambre actuelle",
    rebook: "Re-réserver pour moi",
    rebookDetail: "Trouver une chambre comparable",
    hotelOverbookedQuestion: "Votre hôtel ne peut pas vous accueillir — que faisons-nous ?",
    hotelOverbookedDetail: "Ils ne peuvent pas honorer la réservation. Cherchons une autre option.",
    rebookNearby: "L'option la plus proche",
    rebookNearbyDetail: "Même quartier, chambre comparable",
    rebookBestValue: "Meilleur tarif à proximité",
    rebookBestValueDetail: "Élargir la recherche pour un meilleur prix",
  },
  zh: {
    flightQuestion: "我们该如何为您选择替代航班？",
    flightDetail: "智能集群已找到改签方案。什么对您最重要？",
    cheapest: "最便宜的选项",
    cheapestDetail: "尽量降低票价差额",
    fastest: "最快的选项",
    fastestDetail: "尽早出发",
    activityQuestion: "我们该如何调整您的活动安排？",
    activityDetail: "航班未受影响——告诉我们您想如何安排这段时间。",
    slowDown: "放慢节奏",
    slowDownDetail: "减少预订，留出更多空闲",
    stayActive: "保持行程充实",
    stayActiveDetail: "用全新体验填补空档",
    hotelQuestion: "您的酒店该如何处理？",
    hotelDetail: "您的到达时间正在变化。",
    keep: "保留我的预订",
    keepDetail: "保留当前房间",
    rebook: "帮我重新预订",
    rebookDetail: "寻找同等条件的房间",
    hotelOverbookedQuestion: "酒店无法接待您——接下来怎么办？",
    hotelOverbookedDetail: "酒店无法兑现此预订，我们来为您寻找其他选择。",
    rebookNearby: "最近的同类选择",
    rebookNearbyDetail: "同一区域，条件相近的房间",
    rebookBestValue: "附近性价比最高",
    rebookBestValueDetail: "扩大搜索范围以获得更优价格",
  },
};

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["en", "de", "es", "fr", "zh"];

/** Normalize a BCP-47 tag ('de-DE', 'zh_CN', 'FR') to a supported base
 *  language; unknown/absent tags fall back to English. */
export function normalizeLanguage(language?: string): SupportedLanguage {
  if (typeof language !== "string") return "en";
  const base = language.trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base)
    ? (base as SupportedLanguage)
    : "en";
}

// ------------------------------------------- deterministic fallback questions

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (isRecord(v)) {
      const nested = firstFiniteNumber(...Object.values(v));
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** Cheap shape probe: does this candidate look like a priced flight option? */
function isFlightLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (firstFiniteNumber(value.price, value.cost, value.fare, value.fareDifference) !== null) {
    return true;
  }
  // RebookingCandidate: { option: FlightOption, fareDifference }
  return isRecord(value.option) && firstFiniteNumber(value.option) !== null;
}

/** Cheap shape probe: does this candidate look like a hotel/room option? */
function isHotelLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.hotel_name === "string" ||
    typeof value.ratePerNight === "number" ||
    typeof value.per_night === "number" ||
    typeof value.rate_per_night === "number" ||
    value.action === "rebook" ||
    value.action === "late_check_in"
  );
}

/** Cheap shape probe: does this candidate look like an activity proposal?
 *  (ActivityAgent output: activityNodeId / reschedule|swap|drop action.) */
function isActivityLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.activityNodeId === "string" ||
    value.action === "reschedule" ||
    value.action === "swap" ||
    value.action === "drop" ||
    typeof value.replacementName === "string" ||
    typeof value.viatorProductCode === "string"
  );
}

/** Real venue/swap names carried by activity-shaped candidates (clarity
 *  pass): swap replacements first, then top-level name fields. Swap names
 *  keep precedence; the additive `activityName` (now carried by move/drop
 *  proposals too) names them before giving up, so the frozen copy stays
 *  untouched only when nothing nameable was found. */
function activityCandidateNames(list: unknown[]): string[] {
  const names: string[] = [];
  for (const candidate of list) {
    if (!isRecord(candidate) || !isActivityLike(candidate)) continue;
    const swap = isRecord(candidate.swap) ? candidate.swap : null;
    const name =
      swap && typeof swap.replacementName === "string" && swap.replacementName.trim().length > 0
        ? swap.replacementName
        : typeof candidate.replacementName === "string" &&
            candidate.replacementName.trim().length > 0
          ? candidate.replacementName
          : typeof candidate.activityName === "string" && candidate.activityName.trim().length > 0
            ? candidate.activityName
            : typeof candidate.name === "string" && candidate.name.trim().length > 0
              ? candidate.name
              : null;
    if (name !== null && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Flatten raw session candidates into a plain array (tolerant of container
 *  shapes the assess phase may persist). */
function candidateArray(candidates: unknown): unknown[] {
  if (Array.isArray(candidates)) return candidates;
  if (isRecord(candidates)) {
    for (const key of [
      "candidates",
      "flights",
      "flight_candidates",
      "hotels",
      "hotel_candidates",
      "options",
    ]) {
      const v = candidates[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/**
 * Deterministic, LOCALIZED trade-off questions built straight from the raw
 * candidates — used when Gemini is unavailable (missing key, 429/503,
 * timeout, unrepairable output) and by unit tests. Always returns 1–2
 * questions with exactly 2 options each.
 *
 * Question selection follows the candidate mix: the flight trade-off is only
 * asked when flight candidates exist (strike/unwell missions without flights
 * would otherwise ask a meaningless flight question); when no flight
 * candidates exist but hotel/activity candidates do, an activity-preference
 * question is emitted instead. Candidates matching no probe keep the legacy
 * flight question so the function never degrades to zero questions.
 */
export function buildDeterministicTradeoffs(
  candidates: unknown,
  language?: string,
  opts?: {
    /** The hotel ITSELF failed the traveler (overbooked/no-show) — see
     *  {@link TradeoffQuestionContext.hotel_overbooked}. Swaps the hotel
     *  question for a variant with no "keep my booking" option, since there
     *  is no surviving booking to keep. */
    hotelOverbooked?: boolean;
  },
): TradeoffQuestion[] {
  const t = TRADEOFF_STRINGS[normalizeLanguage(language)];
  const list = candidateArray(candidates);
  const hasFlight = list.some(isFlightLike);
  const hasHotel = list.some(isHotelLike);
  const hasActivity = list.some(isActivityLike);

  const questions: TradeoffQuestion[] = [];
  if (hasFlight || (!hasHotel && !hasActivity)) {
    questions.push({
      id: "flight-tradeoff",
      question: t.flightQuestion,
      detail: t.flightDetail,
      options: [
        { id: "cheapest", label: t.cheapest, detail: t.cheapestDetail },
        { id: "fastest", label: t.fastest, detail: t.fastestDetail },
      ],
    });
  } else {
    // Clarity pass: interpolate the REAL venue/swap names into the detail
    // strings when the candidates carry them (locale-safe: proper-noun
    // append only — the frozen question/labels/option ids never change).
    const names = activityCandidateNames(list);
    const namesSuffix = names.length > 0 ? ` (${names.join(", ")})` : "";
    questions.push({
      id: "activity-tradeoff",
      question: t.activityQuestion,
      detail: `${t.activityDetail}${namesSuffix}`,
      options: [
        { id: "slow_down", label: t.slowDown, detail: t.slowDownDetail },
        {
          id: "stay_active",
          label: t.stayActive,
          detail: `${t.stayActiveDetail}${namesSuffix}`,
        },
      ],
    });
  }
  if (hasHotel) {
    questions.push(
      opts?.hotelOverbooked
        ? {
            id: "hotel-tradeoff",
            question: t.hotelOverbookedQuestion,
            detail: t.hotelOverbookedDetail,
            options: [
              { id: "nearby", label: t.rebookNearby, detail: t.rebookNearbyDetail },
              { id: "best_value", label: t.rebookBestValue, detail: t.rebookBestValueDetail },
            ],
          }
        : {
            id: "hotel-tradeoff",
            question: t.hotelQuestion,
            detail: t.hotelDetail,
            options: [
              { id: "keep", label: t.keep, detail: t.keepDetail },
              { id: "rebook", label: t.rebook, detail: t.rebookDetail },
            ],
          },
    );
  }
  return questions;
}

// ------------------------------------------------ preference-level questions
// W1 primary rail: deterministic PREFERENCE questions composed server-side
// from the candidate feed's real facts (airline/stops/duration/"from $X" for
// flights, venue names for activities). Structurally kills the model-authored
// truncated-price class: every detail string is assembled here, length-capped,
// and never contains a concrete flight listing.

/** Server-composed option detail ceiling (iOS renders these verbatim). */
const PREFERENCE_LABEL_MAX = 48;
const PREFERENCE_DETAIL_MAX = 96;

interface LocalizedPreferenceStrings {
  stopsQuestion: string;
  stopsDetail: string;
  nonstopLabel: string;
  withStopLabel: string;
  dayQuestion: string;
  dayDetail: string;
  sameDayLabel: string;
  laterLabel: string;
  budgetQuestion: string;
  budgetDetail: string;
  budgetCapLabel: string;
  budgetCapDetail: string;
  allowPricierLabel: string;
  allowPricierDetail: string;
  activityPriorityQuestion: string;
  activityPriorityDetail: string;
  keepActivityLabel: string;
  keepActivityDetail: string;
  dropActivityLabel: string;
  dropActivityDetail: string;
  /** "from $X" construction per locale. */
  fromTemplate: string;
  /** A candidate that's actually CHEAPER than the fare already paid nets a
   *  refund (negative `net`) — this renders that honestly instead of a
   *  nonsensical negative price ("from $-43.09"). */
  refundTemplate: string;
  nonstopWord: string;
  stopOne: string;
  stopMany: string;
  departsOnTemplate: string;
  missedFlightAirportQuestion: string;
  missedFlightAirportDetail: string;
  airportNowLabel: string;
  airportNowDetail: string;
  needTimeLabel: string;
  needTimeDetail: string;
}

const PREFERENCE_STRINGS: Record<SupportedLanguage, LocalizedPreferenceStrings> = {
  en: {
    stopsQuestion: "Nonstop, or save money with a stop?",
    stopsDetail: "We found both — the nonstop routing costs more.",
    nonstopLabel: "Fly nonstop",
    withStopLabel: "Take the cheaper routing",
    dayQuestion: "Travel the same day, or save on a later day?",
    dayDetail: "Some replacements depart on a later day for less.",
    sameDayLabel: "Fly the same day",
    laterLabel: "Save on a later day",
    budgetQuestion: "How strict should we be on price?",
    budgetDetail: "A cap keeps every plan inside your budget.",
    budgetCapLabel: "Keep it under {price}",
    budgetCapDetail: "Only plans within this cap",
    allowPricierLabel: "Allow pricier options",
    allowPricierDetail: "Show every replacement, even the pricier ones",
    activityPriorityQuestion: "Two activities are at risk — which one do we protect?",
    activityPriorityDetail: "{x} and {y} may not both survive the reshuffle.",
    keepActivityLabel: "Keep {x}",
    keepActivityDetail: "We fight for this booking first",
    dropActivityLabel: "Drop {x}",
    dropActivityDetail: "Frees up the day — we keep {y} instead",
    fromTemplate: "from {price}",
    refundTemplate: "refunds {price}",
    nonstopWord: "nonstop",
    stopOne: "1 stop",
    stopMany: "{n} stops",
    departsOnTemplate: "departs {date}",
    missedFlightAirportQuestion: "How soon can you be at the airport?",
    missedFlightAirportDetail: "We won't propose any flights departing before this buffer.",
    airportNowLabel: "I'm already here",
    airportNowDetail: "We'll search flights departing at least 1 hour from now",
    needTimeLabel: "I need time (3h+)",
    needTimeDetail: "We'll search flights departing at least 3 hours from now",
  },
  de: {
    stopsQuestion: "Direkt fliegen oder mit Zwischenstopp sparen?",
    stopsDetail: "Beides verfügbar — die Direktverbindung kostet mehr.",
    nonstopLabel: "Direktflug",
    withStopLabel: "Günstigere Verbindung mit Stopp",
    dayQuestion: "Am selben Tag fliegen oder später sparen?",
    dayDetail: "Manche Ersatzflüge starten günstiger an einem späteren Tag.",
    sameDayLabel: "Am selben Tag fliegen",
    laterLabel: "An einem späteren Tag sparen",
    budgetQuestion: "Wie streng sollen wir beim Preis sein?",
    budgetDetail: "Ein Limit hält jeden Plan im Budget.",
    budgetCapLabel: "Unter {price} bleiben",
    budgetCapDetail: "Nur Pläne innerhalb dieses Limits",
    allowPricierLabel: "Auch teurere Optionen zeigen",
    allowPricierDetail: "Alle Ersatzflüge zeigen, auch die teureren",
    activityPriorityQuestion: "Zwei Aktivitäten sind gefährdet — welche schützen wir?",
    activityPriorityDetail: "{x} und {y} überleben die Umplanung vielleicht nicht beide.",
    keepActivityLabel: "{x} behalten",
    keepActivityDetail: "Diese Buchung retten wir zuerst",
    dropActivityLabel: "{x} streichen",
    dropActivityDetail: "Macht den Tag frei — wir behalten stattdessen {y}",
    fromTemplate: "ab {price}",
    refundTemplate: "erstattet {price}",
    nonstopWord: "direkt",
    stopOne: "1 Zwischenstopp",
    stopMany: "{n} Zwischenstopps",
    departsOnTemplate: "Abflug am {date}",
    missedFlightAirportQuestion: "Wie schnell können Sie am Flughafen sein?",
    missedFlightAirportDetail: "Wir werden keine Flüge vorschlagen, die vor dieser Zeit abfliegen.",
    airportNowLabel: "Ich bin schon hier",
    airportNowDetail: "Wir suchen nach Flügen, die in mindestens 1 Stunde abfliegen",
    needTimeLabel: "Ich brauche Zeit (3h+)",
    needTimeDetail: "Wir suchen nach Flügen, die in mindestens 3 Stunden abfliegen",
  },
  es: {
    stopsQuestion: "¿Sin escalas o ahorrar con una escala?",
    stopsDetail: "Hay ambas opciones: la ruta directa cuesta más.",
    nonstopLabel: "Vuelo directo",
    withStopLabel: "Ruta más barata con escala",
    dayQuestion: "¿Volar el mismo día o ahorrar saliendo después?",
    dayDetail: "Algunos vuelos alternativos salen más baratos en un día posterior.",
    sameDayLabel: "Volar el mismo día",
    laterLabel: "Ahorrar en un día posterior",
    budgetQuestion: "¿Cuán estrictos debemos ser con el precio?",
    budgetDetail: "Un tope mantiene cada plan dentro de tu presupuesto.",
    budgetCapLabel: "Mantenerlo bajo {price}",
    budgetCapDetail: "Solo planes dentro de este tope",
    allowPricierLabel: "Permitir opciones más caras",
    allowPricierDetail: "Mostrar todos los reemplazos, incluso los más caros",
    activityPriorityQuestion: "Dos actividades están en riesgo: ¿cuál protegemos?",
    activityPriorityDetail: "{x} y {y} quizá no sobrevivan ambas al reajuste.",
    keepActivityLabel: "Mantener {x}",
    keepActivityDetail: "Defendemos esta reserva primero",
    dropActivityLabel: "Cancelar {x}",
    dropActivityDetail: "Libera el día: mantenemos {y} en su lugar",
    fromTemplate: "desde {price}",
    refundTemplate: "reembolsa {price}",
    nonstopWord: "directo",
    stopOne: "1 escala",
    stopMany: "{n} escalas",
    departsOnTemplate: "sale el {date}",
    missedFlightAirportQuestion: "¿En cuánto tiempo puede estar en el aeropuerto?",
    missedFlightAirportDetail: "No propondremos vuelos que salgan antes de este tiempo.",
    airportNowLabel: "Ya estoy aquí",
    airportNowDetail: "Buscaremos vuelos que salgan en al menos 1 hora",
    needTimeLabel: "Necesito tiempo (3h+)",
    needTimeDetail: "Buscaremos vuelos que salgan en al menos 3 horas",
  },
  fr: {
    stopsQuestion: "Sans escale, ou économiser avec une correspondance ?",
    stopsDetail: "Les deux existent — le vol direct coûte plus cher.",
    nonstopLabel: "Vol direct",
    withStopLabel: "Itinéraire moins cher avec escale",
    dayQuestion: "Voyager le jour même ou payer moins un autre jour ?",
    dayDetail: "Certains vols de remplacement partent moins cher un jour plus tard.",
    sameDayLabel: "Partir le jour même",
    laterLabel: "Payer moins un jour plus tard",
    budgetQuestion: "Quel budget devons-nous respecter ?",
    budgetDetail: "Un plafond garde chaque plan dans votre budget.",
    budgetCapLabel: "Rester sous {price}",
    budgetCapDetail: "Uniquement des plans sous ce plafond",
    allowPricierLabel: "Autoriser des options plus chères",
    allowPricierDetail: "Afficher tous les remplacements, même les plus chers",
    activityPriorityQuestion: "Deux activités sont menacées — laquelle protégeons-nous ?",
    activityPriorityDetail: "{x} et {y} ne survivront peut-être pas toutes les deux.",
    keepActivityLabel: "Garder {x}",
    keepActivityDetail: "Nous défendons cette réservation d'abord",
    dropActivityLabel: "Abandonner {x}",
    dropActivityDetail: "Libère la journée — nous gardons {y} à la place",
    fromTemplate: "dès {price}",
    refundTemplate: "rembourse {price}",
    nonstopWord: "direct",
    stopOne: "1 escale",
    stopMany: "{n} escales",
    departsOnTemplate: "départ le {date}",
    missedFlightAirportQuestion: "Dans combien de temps pouvez-vous être à l'aéroport ?",
    missedFlightAirportDetail: "Nous ne proposerons aucun vol partant avant ce délai.",
    airportNowLabel: "Je suis sur place",
    airportNowDetail: "Nous chercherons des vols partant dans au moins 1 heure",
    needTimeLabel: "J'ai besoin de temps (3h+)",
    needTimeDetail: "Nous chercherons des vols partant dans au moins 3 heures",
  },
  zh: {
    stopsQuestion: "直飞，还是中转更省钱？",
    stopsDetail: "两种方案都有——直飞价格更高。",
    nonstopLabel: "直飞",
    withStopLabel: "更便宜的中转方案",
    dayQuestion: "当天出发，还是晚几天更省钱？",
    dayDetail: "部分替代航班在之后的日期出发更便宜。",
    sameDayLabel: "当天出发",
    laterLabel: "晚几天更便宜",
    budgetQuestion: "预算要卡得多紧？",
    budgetDetail: "设定上限，让每个方案都在预算内。",
    budgetCapLabel: "控制在{price}以内",
    budgetCapDetail: "只看不超过此上限的方案",
    allowPricierLabel: "允许更贵的选项",
    allowPricierDetail: "展示所有替代方案，包括更贵的",
    activityPriorityQuestion: "两项活动都有风险——我们优先保住哪个？",
    activityPriorityDetail: "{x}和{y}可能无法同时保留。",
    keepActivityLabel: "保留{x}",
    keepActivityDetail: "优先保住这项预订",
    dropActivityLabel: "放弃{x}",
    dropActivityDetail: "腾出时间——改保{y}",
    fromTemplate: "{price}起",
    refundTemplate: "退款{price}",
    nonstopWord: "直飞",
    stopOne: "1次中转",
    stopMany: "{n}次中转",
    departsOnTemplate: "{date}出发",
    missedFlightAirportQuestion: "您多快能到机场？",
    missedFlightAirportDetail: "我们将不会推荐在此之前起飞的航班。",
    airportNowLabel: "我已在机场",
    airportNowDetail: "我们将寻找至少1小时后起飞的航班",
    needTimeLabel: "我需要时间(3小时+)",
    needTimeDetail: "我们将寻找至少3小时后起飞的航班",
  },
};

/** `{key}` placeholder substitution for the localized templates above. */
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Word-boundary-aware length cap (server-side composition, W1f). */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > Math.floor(max / 2) ? cut.slice(0, lastSpace) : cut;
  return `${trimmed}…`;
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Currency-anchored price label ("€40", "USD 120") — the €/$/£/USD/EUR/GBP
 *  anchor is what lets deriveConstraintsFromAnswers extract max_price. */
function priceLabel(currency: string, amount: number): string {
  const code = currency.toUpperCase();
  const glyph = code === "EUR" ? "€" : code === "USD" ? "$" : code === "GBP" ? "£" : null;
  return glyph !== null ? `${glyph}${formatAmount(amount)}` : `${code} ${formatAmount(amount)}`;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Venue/activity name → stable lowercase option-id fragment. */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

/** Normalized flight facts lifted out of flight-shaped candidates. */
interface FlightFact {
  airline: string | null;
  /** Explicit stop count; null = provider never described the routing. */
  stops: number | null;
  durationMinutes: number | null;
  departureMs: number | null;
  /** Signed net fare impact (charge positive, refund negative). */
  net: number | null;
  currency: string;
}

function extractFlightFacts(list: unknown[]): FlightFact[] {
  const facts: FlightFact[] = [];
  for (const candidate of list) {
    if (!isRecord(candidate) || !isFlightLike(candidate)) continue;
    const option = isRecord(candidate.option) ? candidate.option : null;
    const fare = isRecord(candidate.fareDifference) ? candidate.fareDifference : null;
    const amount = fare !== null ? firstFiniteNumber(fare.amount) : null;
    const refund = fare !== null && fare.direction === "refund";
    facts.push({
      airline:
        option !== null && typeof option.airline === "string" && option.airline.trim().length > 0
          ? option.airline.trim()
          : null,
      stops:
        option !== null && typeof option.stops === "number" && Number.isFinite(option.stops)
          ? option.stops
          : option !== null &&
              typeof option.layovers === "number" &&
              Number.isFinite(option.layovers)
            ? option.layovers
            : null,
      durationMinutes: (() => {
        if (
          option !== null &&
          typeof option.durationMinutes === "number" &&
          Number.isFinite(option.durationMinutes)
        ) {
          return option.durationMinutes;
        }
        const dep =
          option !== null && typeof option.departureTime === "string"
            ? Date.parse(option.departureTime)
            : NaN;
        const arr =
          option !== null && typeof option.arrivalTime === "string"
            ? Date.parse(option.arrivalTime)
            : NaN;
        return Number.isFinite(dep) && Number.isFinite(arr) && arr > dep
          ? Math.round((arr - dep) / 60_000)
          : null;
      })(),
      departureMs: (() => {
        const dep =
          option !== null && typeof option.departureTime === "string"
            ? Date.parse(option.departureTime)
            : NaN;
        return Number.isFinite(dep) ? dep : null;
      })(),
      net: amount !== null ? (refund ? -amount : amount) : null,
      currency:
        fare !== null && typeof fare.currency === "string" && fare.currency.trim().length > 0
          ? fare.currency.trim()
          : option !== null &&
              typeof option.currency === "string" &&
              option.currency.trim().length > 0
            ? option.currency.trim()
            : "EUR",
    });
  }
  return facts;
}

/** Smallest net charge among priced facts (null when none is priced). */
function minNetOf(facts: FlightFact[]): number | null {
  let min: number | null = null;
  for (const fact of facts) {
    if (fact.net === null) continue;
    if (min === null || fact.net < min) min = fact.net;
  }
  return min;
}

/** The priced fact carrying the smallest net charge (first wins ties). */
function cheapestFactOf(facts: FlightFact[]): FlightFact | null {
  let best: FlightFact | null = null;
  for (const fact of facts) {
    if (fact.net === null) continue;
    if (best === null || best.net === null || fact.net < best.net) best = fact;
  }
  return best;
}

function fromPhrase(fact: FlightFact, p: LocalizedPreferenceStrings): string {
  if (fact.net === null) return "";
  // A candidate cheaper than the fare already paid nets a REFUND (negative
  // `net`) — say so, rather than feeding the raw signed number into "from
  // {price}" and printing a nonsensical negative price ("from $-43.09").
  if (fact.net < 0) {
    return fillTemplate(p.refundTemplate, { price: priceLabel(fact.currency, -fact.net) });
  }
  return fillTemplate(p.fromTemplate, { price: priceLabel(fact.currency, fact.net) });
}

function factDetail(parts: Array<string | null | undefined>): string {
  return capText(parts.filter((part) => !!part).join(" · "), PREFERENCE_DETAIL_MAX);
}

/** (a) Nonstop vs cheaper-with-a-stop — emitted only when BOTH routings
 *  exist and the stop routing is actually cheaper (otherwise no trade-off). */
function buildStopsQuestion(
  facts: FlightFact[],
  p: LocalizedPreferenceStrings,
): { question: TradeoffQuestion; gap: number } | null {
  const directs = facts.filter((fact) => fact.stops === null || fact.stops <= 0);
  const withStops = facts.filter((fact) => fact.stops !== null && fact.stops >= 1);
  if (directs.length === 0 || withStops.length === 0) return null;
  const minDirect = minNetOf(directs);
  const minStop = minNetOf(withStops);
  if (minDirect === null || minStop === null || minStop >= minDirect) return null;
  const direct = cheapestFactOf(directs)!;
  const stop = cheapestFactOf(withStops)!;
  const stopCount = stop.stops ?? 1;
  const stopsPhrase =
    stopCount === 1 ? p.stopOne : fillTemplate(p.stopMany, { n: String(stopCount) });
  return {
    gap: minDirect - minStop,
    question: {
      id: "flight-stops",
      question: p.stopsQuestion,
      detail: p.stopsDetail,
      options: [
        {
          id: "nonstop",
          label: capText(p.nonstopLabel, PREFERENCE_LABEL_MAX),
          detail: factDetail([
            direct.airline,
            direct.durationMinutes !== null ? formatDuration(direct.durationMinutes) : null,
            p.nonstopWord,
            fromPhrase(direct, p),
          ]),
        },
        {
          id: "cheaper_with_stop",
          label: capText(p.withStopLabel, PREFERENCE_LABEL_MAX),
          detail: factDetail([stop.airline, stopsPhrase, fromPhrase(stop, p)]),
        },
      ],
    },
  };
}

function utcDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}

/** (b) Same-day vs cheaper-later-day — emitted only when cross-UTC-date
 *  candidates exist AND a later-day candidate undercuts every same-day one. */
function buildCrossDateQuestion(
  facts: FlightFact[],
  p: LocalizedPreferenceStrings,
): { question: TradeoffQuestion; gap: number } | null {
  const dated = facts.filter((fact) => fact.departureMs !== null);
  if (dated.length < 2) return null;
  const anchorMs = Math.min(...dated.map((fact) => fact.departureMs as number));
  const anchorDay = utcDayKey(anchorMs);
  const sameDay = dated.filter((fact) => utcDayKey(fact.departureMs as number) === anchorDay);
  const later = dated.filter((fact) => utcDayKey(fact.departureMs as number) !== anchorDay);
  if (sameDay.length === 0 || later.length === 0) return null;
  const minSame = minNetOf(sameDay);
  const minLater = minNetOf(later);
  if (minSame === null || minLater === null || minLater >= minSame) return null;
  const same = cheapestFactOf(sameDay)!;
  const laterCheapest = cheapestFactOf(later)!;
  const laterDate = new Date(laterCheapest.departureMs as number).toISOString().slice(0, 10);
  return {
    gap: minSame - minLater,
    question: {
      id: "flight-day",
      question: p.dayQuestion,
      detail: p.dayDetail,
      options: [
        {
          id: "same_day",
          label: capText(p.sameDayLabel, PREFERENCE_LABEL_MAX),
          detail: factDetail([same.airline, fromPhrase(same, p)]),
        },
        {
          id: "cheaper_later",
          label: capText(p.laterLabel, PREFERENCE_LABEL_MAX),
          detail: factDetail([
            laterCheapest.airline,
            fromPhrase(laterCheapest, p),
            fillTemplate(p.departsOnTemplate, { date: laterDate }),
          ]),
        },
      ],
    },
  };
}

/** (c) Budget trade-off — the cap option's LABEL carries a currency-anchored
 *  price so deriveConstraintsFromAnswers' regex yields max_price. Only emitted
 *  when ≥2 priced flight candidates disagree on cost and the cheapest charge
 *  is positive (a non-positive cap would filter everything out). */
function buildBudgetQuestion(
  facts: FlightFact[],
  p: LocalizedPreferenceStrings,
): TradeoffQuestion | null {
  const priced = facts.filter((fact) => fact.net !== null);
  if (priced.length < 2) return null;
  if (new Set(priced.map((fact) => fact.net)).size < 2) return null;
  const cheapest = cheapestFactOf(priced)!;
  if (cheapest.net === null || cheapest.net <= 0) return null;
  const price = priceLabel(cheapest.currency, cheapest.net);
  return {
    id: "budget-cap",
    question: p.budgetQuestion,
    detail: p.budgetDetail,
    options: [
      {
        id: "budget_cap",
        label: capText(fillTemplate(p.budgetCapLabel, { price }), PREFERENCE_LABEL_MAX),
        detail: p.budgetCapDetail,
      },
      {
        id: "allow_pricier",
        label: capText(p.allowPricierLabel, PREFERENCE_LABEL_MAX),
        detail: p.allowPricierDetail,
      },
    ],
  };
}

/** (d) Activity-priority keep-X-or-drop-Y — only when ≥2 NAMEABLE at-risk
 *  activities exist in the candidate feed (venue/swap names, not raw ids). */
function buildActivityPriorityQuestion(
  names: string[],
  p: LocalizedPreferenceStrings,
): TradeoffQuestion | null {
  if (names.length < 2) return null;
  const keep = names[0] as string;
  const other = names[1] as string;
  const keepSlug = slugifyName(keep);
  if (keepSlug.length === 0) return null;
  return {
    id: "activity-priority",
    question: p.activityPriorityQuestion,
    detail: capText(
      fillTemplate(p.activityPriorityDetail, { x: keep, y: other }),
      PREFERENCE_DETAIL_MAX,
    ),
    options: [
      {
        id: `keep_${keepSlug}`,
        label: capText(fillTemplate(p.keepActivityLabel, { x: keep }), PREFERENCE_LABEL_MAX),
        detail: p.keepActivityDetail,
      },
      {
        id: `drop_${keepSlug}`,
        label: capText(fillTemplate(p.dropActivityLabel, { x: keep }), PREFERENCE_LABEL_MAX),
        detail: capText(fillTemplate(p.dropActivityDetail, { y: other }), PREFERENCE_DETAIL_MAX),
      },
    ],
  };
}

/**
 * W1 PRIMARY rail for the assess phase: deterministic, LOCALIZED preference
 * questions composed server-side from the raw candidates' real facts. Always
 * ≤2 questions × exactly 2 options (frozen contract); emits a question ONLY
 * when discriminating facts exist, so an empty result (iOS tolerates zero
 * questions and auto-resolves) is a feature, not a failure.
 *
 * Selection rule (documented): priority order
 *   1. flight-preference — (a) nonstop-vs-stop OR (b) same-day-vs-later-day,
 *      whichever discriminates MORE (larger fare saving on the cheaper side;
 *      ties go to the stops question),
 *   2. activity-priority — when ≥2 nameable activities are at risk,
 *   3. hotel keep/rebook — when hotel-shaped candidates exist,
 *   4. budget cap — the currency-anchored max_price question.
 * The first two priority slots are served.
 */
export function buildPreferenceTradeoffs(
  candidates: unknown,
  language?: string,
  opts?: {
    /** Mirrors {@link buildDeterministicTradeoffs}' hotelOverbooked flag. */
    hotelOverbooked?: boolean;
    /** The flight was MISSED by the traveler, not just delayed by the airline. */
    missedFlight?: boolean;
  },
): TradeoffQuestion[] {
  const lang = normalizeLanguage(language);
  const p = PREFERENCE_STRINGS[lang];
  const t = TRADEOFF_STRINGS[lang];
  const list = candidateArray(candidates);
  const facts = extractFlightFacts(list);
  const names = activityCandidateNames(list);
  const hasHotel = list.some(isHotelLike);

  const pool: TradeoffQuestion[] = [];

  if (opts?.missedFlight) {
    pool.push({
      id: "airport-arrival",
      question: p.missedFlightAirportQuestion,
      detail: p.missedFlightAirportDetail,
      options: [
        { id: "airport_now", label: p.airportNowLabel, detail: p.airportNowDetail },
        { id: "need_time", label: p.needTimeLabel, detail: p.needTimeDetail },
      ],
    });
  }

  // Slot 1 — flight preference (a or b, whichever discriminates more).
  const stops = buildStopsQuestion(facts, p);
  const crossDate = buildCrossDateQuestion(facts, p);
  if (stops !== null && crossDate !== null) {
    pool.push(stops.gap >= crossDate.gap ? stops.question : crossDate.question);
  } else if (stops !== null) {
    pool.push(stops.question);
  } else if (crossDate !== null) {
    pool.push(crossDate.question);
  }

  // Slot 2 — activity priority.
  const activity = buildActivityPriorityQuestion(names, p);
  if (activity !== null) pool.push(activity);

  // Slot 3 — hotel keep/rebook (frozen legacy copy, incl. overbooked variant).
  if (hasHotel) {
    pool.push(
      opts?.hotelOverbooked
        ? {
            id: "hotel-tradeoff",
            question: t.hotelOverbookedQuestion,
            detail: t.hotelOverbookedDetail,
            options: [
              { id: "nearby", label: t.rebookNearby, detail: t.rebookNearbyDetail },
              { id: "best_value", label: t.rebookBestValue, detail: t.rebookBestValueDetail },
            ],
          }
        : {
            id: "hotel-tradeoff",
            question: t.hotelQuestion,
            detail: t.hotelDetail,
            options: [
              { id: "keep", label: t.keep, detail: t.keepDetail },
              { id: "rebook", label: t.rebook, detail: t.rebookDetail },
            ],
          },
    );
  }

  // Slot 4 — budget cap (currency-anchored price in the option label).
  const budget = buildBudgetQuestion(facts, p);
  if (budget !== null) pool.push(budget);

  return pool.slice(0, 2); // frozen contract: at most 2 questions
}

// ------------------------------------------------- robust JSON extract/repair
// Local Worker-safe copies of the generate-trip pipeline (same behavior,
// extended to top-level ARRAY payloads — the questions schema is an array).

/** Strip markdown fences / surrounding prose and slice to the outermost JSON value. */
function extractJsonPayload(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1] !== undefined) s = fence[1].trim();
  const objStart = s.indexOf("{");
  const arrStart = s.indexOf("[");
  let start = -1;
  let close = "}";
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    start = arrStart;
    close = "]";
  } else if (objStart !== -1) {
    start = objStart;
    close = "}";
  }
  if (start === -1) return s;
  const end = s.lastIndexOf(close);
  if (end > start) return s.slice(start, end + 1);
  return s.slice(start); // truncated — no closer yet
}

/**
 * Single-pass string-aware repair (fence/trailing-comma/truncation recovery).
 * Same algorithm as supabase/functions/generate-trip/index.ts — handles both
 * object and array roots.
 */
function repairJson(input: string): string {
  let out = "";
  const stack: string[] = [];
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inStr) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      out = out.replace(/,\s*$/, ""); // trailing comma before a closer
      out += ch;
      continue;
    }
    out += ch;
  }
  // Truncation recovery — only touch the tail when the payload actually ended
  // mid-structure; a complete document must never be mangled.
  if (inStr || escaped || stack.length > 0) {
    if (escaped) out = out.slice(0, -1);
    if (inStr) out += '"';
    out = out.replace(/,\s*$/, "");
    out = out.replace(/"(?:[^"\\]|\\.)*"\s*:\s*$/, ""); // key with no value
    if (stack[stack.length - 1] === "{") {
      out = out.replace(/,\s*"(?:[^"\\]|\\.)*"\s*$/, "");
      out = out.replace(/(\{)\s*"(?:[^"\\]|\\.)*"\s*$/, "$1");
    }
    out = out.replace(/,\s*$/, "");
    while (stack.length) {
      out += stack.pop() === "{" ? "}" : "]";
    }
  }
  return out;
}

/** Parse model output: fast path first, repair pipeline on failure. */
function parseLiaisonJson(raw: string): unknown {
  const extracted = extractJsonPayload(raw);
  try {
    return JSON.parse(extracted);
  } catch {
    try {
      return JSON.parse(repairJson(extracted));
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------- hand-rolled sanitizer

/** Flight-number detector (W1 prompt hardening): IATA-style carrier code +
 *  2–4 digits ("TR892", "XY 456"). Preference questions talk about routing
 *  PREFERENCES — a concrete flight listing in model output means the model
 *  ignored the prompt, so the whole payload falls back to deterministic. */
const FLIGHT_NUMBER_PATTERN = /\b[A-Z]{2}\s?\d{2,4}\b/;

/** Enforce the frozen TradeoffQuestion contract: 1–2 questions, exactly 2
 *  options each. Non-conforming entries are dropped; null when nothing valid
 *  remains. W1: ANY option label/detail carrying a flight-number pattern
 *  poisons the whole payload ⇒ null (deterministic fallback). */
function sanitizeTradeoffQuestions(value: unknown): TradeoffQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions: TradeoffQuestion[] = [];
  const seenIds = new Set<string>(); // duplicate ids collapse onto the first one
  for (const item of value) {
    if (questions.length >= 2) break; // frozen contract: at most 2 questions
    if (!isRecord(item)) continue;
    if (typeof item.id !== "string" || item.id.trim().length === 0) continue;
    if (seenIds.has(item.id)) continue; // duplicate question id — keep the first
    if (typeof item.question !== "string" || item.question.trim().length === 0) continue;
    if (!Array.isArray(item.options)) continue;
    const options: TradeoffOption[] = [];
    for (const opt of item.options) {
      if (options.length >= 2) break; // frozen contract: exactly 2 options
      if (!isRecord(opt)) continue;
      if (typeof opt.id !== "string" || opt.id.trim().length === 0) continue;
      if (typeof opt.label !== "string" || opt.label.trim().length === 0) continue;
      // W1: concrete flight listings are forbidden at the preference level.
      if (FLIGHT_NUMBER_PATTERN.test(opt.label)) {
        console.error(
          `[liaison] option label carries a flight number ("${opt.label}") — deterministic fallback (degrade: invalid_output)`,
        );
        return null;
      }
      const option: TradeoffOption = { id: opt.id, label: opt.label };
      if (typeof opt.detail === "string") {
        if (FLIGHT_NUMBER_PATTERN.test(opt.detail)) {
          console.error(
            `[liaison] option detail carries a flight number ("${opt.detail.slice(0, 60)}") — deterministic fallback (degrade: invalid_output)`,
          );
          return null;
        }
        option.detail = opt.detail;
      }
      options.push(option);
    }
    if (options.length !== 2) continue;
    const question: TradeoffQuestion = { id: item.id, question: item.question, options };
    if (typeof item.detail === "string") question.detail = item.detail;
    seenIds.add(item.id);
    questions.push(question);
  }
  return questions.length > 0 ? questions : null;
}

/** Keep only well-typed fields of the frozen ResolutionConstraints contract. */
function sanitizeConstraints(value: unknown): ResolutionConstraints | null {
  if (!isRecord(value)) return null;
  const constraints: ResolutionConstraints = {};
  if (typeof value.max_price === "number" && Number.isFinite(value.max_price)) {
    constraints.max_price = value.max_price;
  }
  if (typeof value.prefer_direct === "boolean") constraints.prefer_direct = value.prefer_direct;
  if (typeof value.keep_hotel === "boolean") constraints.keep_hotel = value.keep_hotel;
  if (typeof value.prefer_earliest === "boolean")
    constraints.prefer_earliest = value.prefer_earliest;
  // W1 additive fields (same well-typed pass-through discipline).
  if (typeof value.prefer_nonstop === "boolean") constraints.prefer_nonstop = value.prefer_nonstop;
  if (typeof value.prefer_same_day === "boolean")
    constraints.prefer_same_day = value.prefer_same_day;
  if (typeof value.activity_priority === "string" && value.activity_priority.trim().length > 0)
    constraints.activity_priority = value.activity_priority.trim();
  if (typeof value.notes === "string") constraints.notes = value.notes;
  if (typeof value.min_departure_delay_hours === "number") {
    constraints.min_departure_delay_hours = value.min_departure_delay_hours;
  }
  // An OBJECT with nothing recognizable in it is a valid answer, not garbage:
  // plenty of missions carry no answers to translate, and the model correctly
  // replies `{}`. Only a non-object is unusable. Collapsing the two made a
  // healthy model look degraded on a third of live missions, and buried the
  // real failures in the noise.
  return constraints;
}

// --------------------------------------------- deterministic answer derivation

/**
 * Deterministic constraints from raw option ids — the never-fail fallback
 * when Gemini is unavailable during translation. Heuristics on well-known
 * option ids ('cheapest', 'fastest', 'direct', 'keep', 'rebook', 'yes',
 * 'tomorrow', …); unknown ids land in `notes`.
 *
 * W1 preference-builder ids are matched FIRST and exactly:
 * `keep_<slug>`/`drop_<slug>` → activity_priority (the KEPT activity's
 * slug-decoded name), `nonstop`/`cheaper_with_stop` → prefer_nonstop,
 * `same_day`/`cheaper_later` → prefer_same_day.
 */
export function deriveConstraintsFromAnswers(
  questions: TradeoffQuestion[],
  answers: TradeoffAnswer[],
): ResolutionConstraints {
  const constraints: ResolutionConstraints = {};
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const noteParts: string[] = [];

  for (const answer of answers) {
    if (!isRecord(answer)) continue;
    const questionId = typeof answer.question_id === "string" ? answer.question_id : null;
    const optionId =
      typeof answer.option_id === "string" ? answer.option_id.trim().toLowerCase() : null;
    if (!questionId || !optionId) continue;

    // Resolve the selected option's label (best-effort) for human-readable notes.
    const question = questionById.get(questionId);
    const selected = question?.options.find((o) => o.id.toLowerCase() === optionId);

    // ── W1 preference-builder ids (checked BEFORE the legacy heuristics so a
    //    "keep_<venue>" activity answer never trips the keep_hotel branch and
    //    a "cheaper_*" routing answer never hits the price-extraction path) ──
    if (optionId.startsWith("keep_") || optionId.startsWith("drop_")) {
      // activity-priority keep-X-or-drop-Y: activity_priority = the KEPT
      // activity's name (slug-decoded: lowercased, "_" → " "). Choosing
      // drop_X keeps the question's other (keep_) option; without one the
      // choice still lands in notes.
      const keptName = (slug: string) => slug.replace(/_/g, " ");
      if (optionId.startsWith("keep_")) {
        constraints.activity_priority = keptName(optionId.slice("keep_".length));
      } else {
        const droppedSlug = optionId.slice("drop_".length);
        const other = question?.options.find(
          (o) =>
            o.id.toLowerCase() !== optionId &&
            o.id.toLowerCase().startsWith("keep_") &&
            o.id.toLowerCase().slice("keep_".length) !== droppedSlug,
        );
        if (other) {
          constraints.activity_priority = keptName(other.id.toLowerCase().slice("keep_".length));
        } else {
          // keep_X/drop_X pair: the activity the traveler WANTS kept only
          // exists in the option's detail text — record the choice as a
          // note instead of guessing the wrong priority.
          noteParts.push(selected?.label ?? optionId);
        }
      }
      continue;
    }
    if (optionId === "nonstop") {
      // stops trade-off: nonstop side — pinned/filtered like prefer_direct.
      constraints.prefer_nonstop = true;
      constraints.prefer_direct = true;
      continue;
    }
    if (optionId === "cheaper_with_stop" || optionId === "with_stop") {
      constraints.prefer_nonstop = false;
      constraints.prefer_direct = false;
      continue;
    }
    if (optionId === "same_day") {
      constraints.prefer_same_day = true;
      continue;
    }
    if (optionId === "cheaper_later" || optionId === "later_day") {
      constraints.prefer_same_day = false;
      continue;
    }

    if (optionId.includes("cheap") || optionId.includes("lowest") || optionId.includes("budget")) {
      // Cheapest: cap price at the selected option's quoted price when one is
      // embedded in its label/detail; otherwise record the preference as text.
      // CURRENCY CONTEXT REQUIRED: a bare number (e.g. an option label like
      // "Option 2") is NOT a price — only amounts anchored on a currency
      // symbol/code set max_price; everything else falls through to `notes`.
      const priceText = `${selected?.label ?? ""} ${selected?.detail ?? ""}`;
      const price = priceText.match(/(?:€|\$|£|USD|EUR|GBP)\s*(\d+(?:[.,]\d+)?)/i);
      if (price && price[1] !== undefined) {
        const parsed = Number.parseFloat(price[1].replace(",", "."));
        if (Number.isFinite(parsed) && parsed > 0) {
          constraints.max_price =
            constraints.max_price === undefined ? parsed : Math.min(constraints.max_price, parsed);
        } else {
          noteParts.push(selected?.label ?? optionId);
        }
      } else {
        noteParts.push(selected?.label ?? optionId);
      }
      continue;
    }
    if (
      optionId.includes("fast") ||
      optionId.includes("earliest") ||
      optionId.includes("early") ||
      optionId === "tomorrow" ||
      optionId === "today" ||
      optionId === "asap"
    ) {
      constraints.prefer_earliest = true;
      continue;
    }
    if (optionId.includes("direct") || optionId.includes("nonstop")) {
      constraints.prefer_direct = true;
      continue;
    }
    if (optionId === "yes" || optionId.includes("keep")) {
      constraints.keep_hotel = true;
      continue;
    }
    if (optionId === "no" || optionId.includes("rebook") || optionId.includes("move")) {
      constraints.keep_hotel = false;
      continue;
    }
    if (optionId === "airport_now" || optionId.includes("now") || optionId.includes("here")) {
      constraints.min_departure_delay_hours = 1;
      continue;
    }
    if (optionId === "need_time" || optionId.includes("time") || optionId.includes("3h")) {
      constraints.min_departure_delay_hours = 3;
      continue;
    }
    noteParts.push(selected?.label ?? optionId);
  }

  if (noteParts.length > 0) constraints.notes = noteParts.join("; ");
  return constraints;
}

// --------------------------------------------------------------- Gemini calls

/** responseSchema for generateTradeoffQuestions (array of 1–2 questions,
 *  each with exactly 2 options). */
const QUESTIONS_RESPONSE_SCHEMA = {
  type: "ARRAY",
  minItems: 1,
  maxItems: 2,
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      question: { type: "STRING" },
      detail: { type: "STRING" },
      options: {
        type: "ARRAY",
        minItems: 2,
        maxItems: 2,
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            label: { type: "STRING" },
            detail: { type: "STRING" },
          },
          required: ["id", "label"],
        },
      },
    },
    required: ["id", "question", "options"],
  },
};

/** responseSchema for translateAnswersToConstraints. */
const CONSTRAINTS_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    max_price: { type: "NUMBER" },
    prefer_direct: { type: "BOOLEAN" },
    keep_hotel: { type: "BOOLEAN" },
    prefer_earliest: { type: "BOOLEAN" },
    // W1 additive fields (same names as ResolutionConstraints).
    prefer_nonstop: { type: "BOOLEAN" },
    prefer_same_day: { type: "BOOLEAN" },
    activity_priority: { type: "STRING" },
    notes: { type: "STRING" },
    min_departure_delay_hours: { type: "NUMBER" },
  },
};

export class GeminiLiaisonAgent {
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly constraintRouting: "model" | "deterministic_known";
  private constraintRoute: "model" | "deterministic" = "model";
  get lastConstraintRoute(): "model" | "deterministic" {
    return this.constraintRoute;
  }
  private readonly onUsage: GeminiUsageObserver | undefined;
  private readonly sharedBudget: GeminiCallBudget | undefined;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly callBudget: number;

  /** Task 21 — per-instance Gemini calls consumed this mission
   *  (same counter pattern as ActivityAgent.viatorConsultsUsed). */
  private geminiCallsUsedCount = 0;
  /** Task 21 — classify of the most recent degrade (undefined = none yet). */
  private degradeReason: GeminiDegradeReason | undefined;

  constructor(config: GeminiLiaisonConfig = {}) {
    this.constraintRouting =
      config.constraintRouting ??
      (typeof process !== "undefined" &&
      process.env.SWARM_CONSTRAINT_ROUTING === "deterministic_known"
        ? "deterministic_known"
        : "model");
    this.apiKey =
      config.apiKey !== undefined && config.apiKey.length > 0
        ? config.apiKey
        : typeof process !== "undefined" && typeof process.env?.GEMINI_API_KEY === "string"
          ? process.env.GEMINI_API_KEY
          : undefined;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.model = config.model ?? configuredGeminiModel("liaison", DEFAULT_MODEL);
    this.onUsage = config.onUsage;
    this.sharedBudget = config.sharedBudget;
    this.maxRetries = Math.max(0, Math.floor(config.maxRetries ?? 0));
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.callBudget = config.callBudget ?? GEMINI_CALLS_PER_MISSION;
    // Workers' `fetch` is brand-checked against its receiver: storing the
    // bare function on `this.fetchImpl` and later calling it as
    // `this.fetchImpl(...)` invokes it with `this` = the agent instance, and
    // Cloudflare's runtime rejects that as "Illegal invocation" — silently,
    // since `callGemini` catches it and degrades to the deterministic
    // fallback. `.bind(globalThis)` pins the receiver Workers expects, the
    // same fix Cloudflare's own docs give for this exact error class.
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Task 21 (additive): WHY the agent last degraded — undefined when it
   *  never degraded this mission. Feeds the `liaison/gemini_degraded` trace. */
  get lastDegradeReason(): GeminiDegradeReason | undefined {
    return this.degradeReason;
  }

  /** Task 21 (additive): Gemini calls consumed so far this mission
   *  (test/audit feed, mirrors ActivityAgent.viatorConsultsUsed). */
  get geminiCallsUsed(): number {
    return this.geminiCallsUsedCount;
  }

  /** Record a degrade (classification site) and keep console.error honest. */
  private degrade(reason: GeminiDegradeReason, message: string): void {
    this.degradeReason = reason;
    console.error(`[liaison] ${message} (degrade: ${reason})`);
  }

  /**
   * Generate 1–2 localized trade-off questions from the raw candidates.
   * Returns `null` on ANY failure (missing key, timeout, HTTP error,
   * unrepairable output) — the caller then serves
   * {@link buildDeterministicTradeoffs} instead.
   *
   * W1 NOTE: the assess phase serves the deterministic
   * {@link buildPreferenceTradeoffs} rail — this Gemini generator is RETAINED
   * (hardened prompt, flight-number sanitizer) but is no longer the primary
   * question source.
   */
  async generateTradeoffQuestions(
    context: TradeoffQuestionContext,
  ): Promise<TradeoffQuestion[] | null> {
    if (!this.apiKey) {
      this.degrade(
        "missing_key",
        "GEMINI_API_KEY missing — trade-off questions fall back to deterministic",
      );
      return null;
    }
    const language = normalizeLanguage(context.language ?? "en");
    const systemInstruction =
      "You are the travel concierge of GlobePlanner's Nexus Swarm disruption-recovery system. " +
      "Given raw rebooking candidates for a disrupted itinerary, formulate at most two concise " +
      "PREFERENCE-LEVEL questions that let the traveler express what matters most before plans " +
      "are built (e.g. nonstop vs. cheaper routing, same day vs. later day, budget cap, which " +
      "activity to protect). STRICT RULES: NEVER list concrete flights — no flight numbers, no " +
      "airline+time+price enumerations, at most ONE currency-anchored amount (a price cap like " +
      "'under €X') anywhere per question. Keep every string short: option labels ≤ 48 characters, " +
      "details ≤ 96 characters, no prose, no schedules. Each question has exactly two options. " +
      "Never invent prices or facts not present in the candidates. " +
      `ALL user-facing strings (question, detail, option label and option detail) MUST be written in "${language}". ` +
      "If hotel_overbooked is true, the property itself failed the traveler (walked/no-show at " +
      "check-in) — there is NO existing booking left to keep, so the hotel question's two options " +
      "must both be rebooking flavors (e.g. closest match vs. best value nearby), never an option " +
      "that implies keeping the current room.";

    const userPrompt = JSON.stringify({
      incident: context.incident ?? null,
      hotel_impacted: context.hotel_impacted === true,
      hotel_overbooked: context.hotel_overbooked === true,
      candidates: context.candidates ?? null,
    });

    const result = await this.callGemini(
      systemInstruction,
      userPrompt,
      QUESTIONS_RESPONSE_SCHEMA,
      0.4,
      2400,
    );
    if (!result.ok) return null; // degrade already classified + logged
    const parsed = parseLiaisonJson(result.text);
    const questions = sanitizeTradeoffQuestions(parsed);
    if (!questions) {
      this.degrade(
        "invalid_output",
        "trade-off question payload invalid after repair — deterministic fallback",
      );
      return null;
    }
    return questions;
  }

  /**
   * Translate the traveler's option selections into machine-readable
   * {@link ResolutionConstraints}. TOTAL by contract: when Gemini is
   * unavailable or produces garbage, deterministic option-id heuristics
   * ({@link deriveConstraintsFromAnswers}) are returned instead. Never throws.
   */
  async translateAnswersToConstraints(
    questions: TradeoffQuestion[],
    answers: TradeoffAnswer[],
  ): Promise<ResolutionConstraints> {
    this.degradeReason = undefined;
    this.constraintRoute = "model";
    const deterministic = deriveConstraintsFromAnswers(questions, answers);
    const exactRules = new Set([
      "nonstop",
      "cheaper_with_stop",
      "with_stop",
      "same_day",
      "cheaper_later",
      "later_day",
    ]);
    const answeredQuestions = new Set(answers.map((answer) => answer.question_id));
    const knownAnswers =
      answeredQuestions.size === answers.length &&
      answers.every(
        (answer) =>
          exactRules.has(answer.option_id) &&
          questions.some(
            (question) =>
              question.id === answer.question_id &&
              question.options.some((option) => option.id === answer.option_id),
          ),
      );
    if (this.constraintRouting === "deterministic_known" && knownAnswers) {
      this.constraintRoute = "deterministic";
      return deterministic;
    }
    try {
      if (!this.apiKey) {
        this.degrade(
          "missing_key",
          "GEMINI_API_KEY missing — constraints derived deterministically",
        );
        return deterministic;
      }
      const systemInstruction =
        "You are the travel concierge of GlobePlanner's Nexus Swarm. Translate the traveler's " +
        "answers to trade-off questions into strict machine-readable resolution constraints. " +
        "Only emit fields supported by the schema; omit unknown preferences. If a price ceiling is " +
        "implied by a chosen option, express it as max_price in the candidate's currency amount.";
      const userPrompt = JSON.stringify({ questions, answers });
      const result = await this.callGemini(
        systemInstruction,
        userPrompt,
        CONSTRAINTS_RESPONSE_SCHEMA,
        0.2,
        1600,
      );
      if (!result.ok) return deterministic; // degrade classified + logged
      const parsed = parseLiaisonJson(result.text);
      const constraints = sanitizeConstraints(parsed);
      if (!constraints) {
        this.degrade(
          "invalid_output",
          "constraints payload invalid after repair — deterministic derivation",
        );
        return deterministic;
      }
      // Task 25 (#2): deterministic-FIRST merge — the model payload may
      // legitimately omit fields the traveler ANSWERED (the constraints
      // schema carries no required array), so only explicitly-present,
      // sanitized model fields override the deterministic derivation.
      return { ...deterministic, ...constraints };
    } catch (error) {
      this.degradeReason = "exception";
      console.error(
        "[liaison] translateAnswersToConstraints failed — deterministic derivation:",
        error,
      );
      return deterministic;
    }
  }

  /**
   * ONE Gemini exchange, budget-gated and deadline-bounded, classified via the
   * shared {@link GeminiDegradeReason} taxonomy (Task 21). Budget gate →
   * primary attempt → at most `maxRetries` retries on a `quota_429` classify
   * (429/503), backoff included. Never throws; failures are logged.
   *
   * Each attempt gets its OWN deadline. They used to share one: a saturated
   * primary that sat on the request for most of the window left the retry with
   * no time, so a live 503 degraded as `timeout` and the traveler silently got
   * the deterministic derivation. The retry also targets a DIFFERENT model —
   * `quota_429` means this model has no capacity, so re-asking it is asking
   * the same saturated pool.
   */
  private async callGemini(
    systemInstruction: string,
    userPrompt: string,
    responseSchema: unknown,
    temperature: number,
    maxOutputTokens: number,
  ): Promise<GeminiCallResult> {
    // Per-mission budget gate (same pattern as ActivityAgent's
    // viatorConsultsUsed): exhaustion skips the call and classifies as the
    // closest taxonomy value — `quota_429` (the union stays frozen at 6).
    if (this.geminiCallsUsedCount >= this.callBudget) {
      this.degrade(
        "quota_429",
        `Gemini call skipped — per-mission budget exhausted (${this.callBudget} calls)`,
      );
      return { ok: false, reason: "quota_429" };
    }

    /** One attempt against `model`, with a deadline of its own. */
    let budgetExhausted = false;
    const attempt = async (model: string): Promise<GeminiCallResult> => {
      // Recheck AFTER any retry backoff: another concurrent day can consume
      // the last slot while this call is waiting. Reserve before the next await.
      if (
        this.geminiCallsUsedCount >= this.callBudget ||
        (this.sharedBudget && !this.sharedBudget.tryReserve())
      ) {
        budgetExhausted = true;
        this.degradeReason = "quota_429";
        return { ok: false, reason: "quota_429" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.geminiCallsUsedCount += 1;
        return await this.callGeminiOnce(
          systemInstruction,
          userPrompt,
          responseSchema,
          temperature,
          maxOutputTokens,
          controller.signal,
          model,
        );
      } finally {
        clearTimeout(timer);
      }
    };

    // Walk the ladder: the most capable model first, then tiers that are still
    // within quota. The ladder moves down on any failure that is about the
    // MODEL rather than about us: a capacity answer (429/503), or a plain HTTP
    // failure. It used to move only on 429/503, on the reasoning that anything
    // else "is this request's own problem and a different model would repeat
    // it" — the live matrix of 2026-09-01 disproved that: 8 of 9 degradations
    // were `http_error` and none of them ever asked a second model. A request
    // that really is malformed fails on every rung and still lands on the
    // deterministic rail, so being wrong here costs one extra call.
    const ladder = modelLadder(this.model);
    let result = await attempt(ladder[0]);
    if (result.ok) noteModelHealthy(ladder[0]);

    let rung = 0;
    while (
      !result.ok &&
      !budgetExhausted &&
      (result.reason === "quota_429" || result.reason === "http_error") &&
      rung < this.maxRetries &&
      rung + 1 < ladder.length &&
      this.geminiCallsUsedCount < this.callBudget
    ) {
      // Only a QUOTA refusal earns a cooldown — a one-off 500 must not
      // sideline a healthy model for minutes afterwards.
      if (result.reason === "quota_429") noteModelExhausted(ladder[rung]);
      rung += 1;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      console.warn(
        `[liaison] ${ladder[rung - 1]} failed (${result.reason}) — trying ${ladder[rung]}`,
      );
      result = await attempt(ladder[rung]);
      if (result.ok) noteModelHealthy(ladder[rung]);
    }
    if (!result.ok) {
      if (!budgetExhausted && result.reason === "quota_429") noteModelExhausted(ladder[rung]);
      this.degradeReason = result.reason;
    }
    return result;
  }

  /** ONE fetch attempt with the full degrade taxonomy classification. */
  private async callGeminiOnce(
    systemInstruction: string,
    userPrompt: string,
    responseSchema: unknown,
    temperature: number,
    maxOutputTokens: number,
    signal: AbortSignal,
    /** Defaults to the primary; the overload retry passes the lighter tier. */
    model: string = this.model,
  ): Promise<GeminiCallResult> {
    const startedAt = Date.now();
    let usage: GeminiUsageEvent["usage"] = null;
    let outcome: GeminiUsageEvent["outcome"] = "exception";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema,
            temperature,
            maxOutputTokens,
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      });
      if (!response.ok) {
        // The body carries the ACTUAL rejection reason (bad schema field,
        // quota, model id) — status + statusText alone made every failure
        // mode here indistinguishable in the logs.
        const bodyText = await response.text().catch(() => "");
        const reason: GeminiDegradeReason =
          response.status === 429 || response.status === 503 ? "quota_429" : "http_error";
        console.error(
          `[liaison] Gemini HTTP ${response.status} (${response.statusText}): ${bodyText.slice(0, 500)} (degrade: ${reason})`,
        );
        outcome = reason;
        return { ok: false, reason };
      }
      const data = (await response.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: unknown }> };
          /** "STOP" | "MAX_TOKENS" | … — distinguishes a truncation from a bad model. */
          finishReason?: string;
        }>;
        error?: { message?: unknown };
        usageMetadata?: unknown;
      };
      usage = readGeminiUsage(data?.usageMetadata);
      if (data?.error) {
        console.error(
          `[liaison] Gemini error payload: ${String(data.error.message ?? "unknown")} (degrade: http_error)`,
        );
        outcome = "http_error";
        return { ok: false, reason: "http_error" };
      }
      const finishReason = data?.candidates?.[0]?.finishReason;
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        // `MAX_TOKENS` is a BUDGET failure, not a bad model: a reasoning model
        // spends `maxOutputTokens` on its thinking tokens first, so a tight
        // ceiling returns an empty or truncated part. It used to be logged as
        // a generic invalid_output, which hid the cause across 14 of 49 live
        // missions.
        console.error(
          finishReason === "MAX_TOKENS"
            ? `[liaison] Gemini hit maxOutputTokens before emitting JSON — raise the budget (degrade: invalid_output)`
            : `[liaison] Gemini response carried no text part (finishReason=${String(
                finishReason ?? "none",
              )}) (degrade: invalid_output)`,
        );
        outcome = "invalid_output";
        return { ok: false, reason: "invalid_output" };
      }
      outcome = "text_received";
      return { ok: true, text };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const reason: GeminiDegradeReason = aborted ? "timeout" : "exception";
      console.error(
        `[liaison] Gemini call failed${aborted ? " (timeout)" : ""} (degrade: ${reason}):`,
        error,
      );
      outcome = reason;
      return { ok: false, reason };
    } finally {
      emitGeminiUsage(this.onUsage, {
        model,
        durationMs: Math.max(0, Date.now() - startedAt),
        maxOutputTokens: maxOutputTokens,
        outcome,
        usage,
      });
    }
  }
}
