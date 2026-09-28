/**
 * Nexus Swarm — deterministic mission-intent parsing against HYDRATED real
 * trips (the real-trip twin of hackathonApi's frozen `parseMissionIntent`).
 *
 * Pure module: NO supabase/network imports — the caller hands in an already
 * hydrated trip (graph + nodeRefs + meta) and receives either mission options
 * for `runSwarmResolution` or a structured error descriptor the API layer
 * maps to a JSON error response.
 *
 * Categories (checked in order):
 *   1. weather            → proactive on the first OUTDOOR activity node
 *   2. missed_flight/delay→ flight token regex vs real flight numbers, city
 *                           word vs destination/meta.city, else nearest
 *                           upcoming (or last) flight
 *   3. hotel              → first hotel_check_in node
 *   4. activity_cancelled → activity matched by name, else first activity
 *   5. strike             → a GROUND transit node (reactive), never a flight;
 *                           when the trip has none, proactive user_report on
 *                           the first upcoming activity
 *   6. unwell/lighten     → proactive on the first activity (user_report);
 *                           400 no_actionable_nodes when the trip has none
 */

import { findConnections, isConnectionMission, pickConnection } from "@/core/sanity/connections";
import { groundHeadline, isGroundMission } from "@/core/ground";
import type { HydratedTrip, SwarmNodeRef } from "./swarmTripContext";

// ------------------------------------------------------------------ types

export type TripMissionCategory =
  | "missed_flight"
  | "delay"
  | "weather"
  | "hotel"
  /** The property itself failed the traveler (walked/cancelled/no-show at
   *  check-in) — there is no existing booking left to "keep", so this reads
   *  as a materially different situation from `"hotel"` (an arrival-time
   *  shift that still HAS a room waiting) everywhere the category reaches:
   *  trade-off question copy, trace wording, presentation. */
  | "hotel_overbooked"
  | "activity_cancelled"
  | "strike"
  | "unwell"
  | "custom";

export interface TripMissionEvidence {
  kind: "weather" | "event" | "user_report";
  source: string;
  confidence: number;
  detail: string;
}

/** Mission options accepted by the swarm pipeline (SPEC §3.2 shaped). */
export interface TripMissionOptions {
  nodeId: string;
  delayMinutes: number;
  description: string;
  origin: "reactive" | "proactive";
  weatherHint?: "clear" | "rain" | "storm" | "extreme_heat";
  evidence?: TripMissionEvidence;
  /** Parsed category (trace/UI metadata, not part of the DisruptionEvent). */
  kind: TripMissionCategory;
  /**
   * When the intent named no flight and the swarm PICKED one: which, and
   * why. Disclosed on the Activity Stream as its own row rather than
   * prefixed to the headline — photographed on 2026-09-18, "Nearest upcoming
   * flight SQ366 chosen as the disruption target." opened the plan's title
   * and, at accessibility text size, filled the whole first screen.
   */
  targetNote?: string;
}

export type TripMissionParse =
  | { kind: "mission"; mission: TripMissionOptions }
  | { kind: "error"; status: number; code: string; message: string };

// --------------------------------------------------------------- constants

/** Default reactive delay (the showcase 4h reroute). */
const DEFAULT_DELAY_MINUTES = 240;
const MAX_DELAY_MINUTES = 24 * 7 * 60;

/** Airline-code flight numbers, e.g. TP437 / AF12. */
/**
 * A flight designator the traveler may type. The space is optional because
 * carriers publish it both ways and this trip content uses BOTH forms —
 * "VY6215" but also "AF 007", "SQ 635", "KL 1272", "AZ 609". Matching only the
 * unspaced form meant the swarm could not name (or target) the majority of
 * real legs. Compared after `normalizeFlightNo`, so the two forms are one.
 */
const FLIGHT_TOKEN_PATTERN = /\b[A-Za-z]{2}\s?\d{1,4}\b/g;

/** "AF 007" and "AF007" are the same flight — compare and display one form. */
function normalizeFlightNo(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}
/** Delay magnitude in hours, e.g. "4h", "2.5 hours". */
const DELAY_HOURS_PATTERN = /\b(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|h)\b/i;
/**
 * THE APP SHIPS FIVE LANGUAGES; THIS PARSER UNDERSTOOD ONE.
 *
 * Only the flight branch was ever translated (see FLIGHT_INTENT_PATTERN_INTL).
 * Measured against the deployed Worker on 2026-09-18, six of nine French,
 * Spanish and German sentences were refused outright — including four the
 * swarm handles perfectly well:
 *
 *   "mon hôtel est surbooké"                    → refused
 *   "mon activité a été annulée"                → refused
 *   "je ne me sens pas bien, allège ma journée" → refused
 *   "il va pleuvoir demain, adapte mes plans"   → refused
 *
 * Before the scope gate they fell through to the greedy catch-all instead,
 * which is not better: that is the path that answered "my suitcase didn't
 * arrive" with three flight rebookings. Either way the engine only really
 * worked for travellers who happened to type English.
 *
 * NOTE ON THE MISSING \b: JavaScript word boundaries are ASCII-only, so
 * `\bhôtel\b` never matches — "ô" is not a word character and the trailing
 * boundary fails on the very word this exists to catch. The stems below are
 * therefore written without a closing boundary where an accent can fall, the
 * same compromise FLIGHT_INTENT_PATTERN_INTL already documents.
 */

/** Weather vocabulary ⇒ proactive mission (mirrors hackathonApi's set). */
const WEATHER_INTENT_PATTERN =
  /\b(rain|rainy|storm|stormy|thunder|weather|forecast|snow|wind|heat|heatwave|hurricane|typhoon)\b/i;
const WEATHER_INTENT_INTL =
  /(pluie|pleuv|orage|neige|vent\b|canicule|temp[êe]te|m[ée]t[ée]o|lluvia|llov|tormenta|nieve|viento|calor|regn|regen|sturm|schnee|hitze|unwetter|下雨|暴雨|台风|风暴|天气)/i;
/** Hotel trouble keywords — hotel-specific vocabulary ONLY: generic
 *  "cancelled/cancellation" must NOT land here (it belongs to the activity
 *  branch below), so a "my activity got cancelled" intent never misfires
 *  onto the hotel node. */
const HOTEL_INTENT_PATTERN =
  /\b(overbook\w*|no-show|no show|hotel|room|reservation|check-in|check in)\b/i;
const HOTEL_INTENT_INTL =
  /(h[ôo]tel|chambre|r[ée]servation|logement|habitaci[óo]n|reserva|alojamiento|zimmer|unterkunft|buchung|酒店|旅馆|房间|预订)/i;
/**
 * The noun alone is not a problem. Something has to be WRONG with the room,
 * or the traveller has to be asking for it to change.
 *
 * Verified against the deployed Worker on 2026-09-18: "what's the wifi
 * password at my hotel" matched on the bare word "hotel", was classified as a
 * hotel disruption, and came back with "your booking is untouched; confirm a
 * late arrival with them if you want certainty." The traveller asked for a
 * password.
 */
const HOTEL_TROUBLE_PATTERN =
  /\b(overbook\w*|no-show|no show|walked|cancel\w*|annul\w*|chang\w*|mov\w*|switch|rebook|reschedul\w*|postpone|earlier|later|late|delay\w*|miss\w*|problem|issue|wrong|dirty|unsafe|refus\w*|denied|lost|double[- ]?booked|not (available|ready)|won'?t|can'?t)\b/i;
const HOTEL_TROUBLE_INTL =
  /(surbook|surr[ée]serv|annul|d[ée]cal|chang|probl[èe]me|sale|refus|perdu|complet|sobrevend|cancel|cambi|problema|sucia|rechaz|completo|[üu]berbucht|storn|[äa]nder|problem|schmutzig|abgelehnt|超订|取消|问题|换)/i;
/** Activity cancellation keywords. */
const ACTIVITY_INTENT_PATTERN = /\b(cancel\w*|activity|tour|lesson|excursion|class|booking)\b/i;
const ACTIVITY_INTENT_INTL =
  /(activit[ée]|visite|excursion|cours\b|atelier|annul[ée]|actividad|visita|excursi[óo]n|clase|cancelad|aktivit[äa]t|besichtigung|ausflug|kurs\b|abgesagt|活动|游览|课程|取消)/i;
/** Transport strike keywords. */
const STRIKE_INTENT_PATTERN = /\bstrike\w*\b/i;
const STRIKE_INTENT_INTL = /(gr[èe]ve|huelga|streik|罢工)/i;
/** "The room is GONE" in every shipped language — the orchestrator reads it too. */
const OVERBOOKED_LIKE = /(overbook\w*|surbook|surr[ée]serv|sobrevend|[üu]berbucht|超订)/i;
/** Traveler wellbeing / lighten-the-day keywords. */
const UNWELL_INTENT_PATTERN = /\b(unwell|lighten\w*|sick|exhausted|tired)\b/i;
const UNWELL_INTENT_INTL =
  /(malade|fatigu[ée]|[ée]puis[ée]|all[èe]g|pas bien|souffrant|enferm|cansad|agotad|aligerar|mal\b|krank|m[üu]de|ersch[öo]pft|entlasten|不舒服|生病|累|疲)/i;
/** Explicit "custom request" phrasing — the ONLY free-text trigger for the
 *  generic custom fallback (vague chatter must return a 400 instead). */
const CUSTOM_REQUEST_PATTERN = /\bcustom request\b/i;
/** Imperative action verbs that count as an explicit change request when
 *  paired with a plausible trip target (hotel/activity/transfer vocabulary). */
const IMPERATIVE_ACTION_PATTERN =
  /\b(change|cancel|reschedule|move|add|remove|swap|skip|postpone|delay)\b/i;
/** Plausible targets for an imperative request — hotel + activity + transfer
 *  vocabulary (flight intents are already handled by branch 2). */
const IMPERATIVE_TARGET_PATTERN =
  /\b(hotel|room|reservation|check-in|check in|activity|tour|lesson|excursion|class|booking|transfer|train|bus|taxi|ride|pickup|pick-up)\b/i;
/** Reactive flight keywords without an explicit flight number. */
const FLIGHT_INTENT_PATTERN =
  /\b(flight|missed|miss|reroute|rebook|re-route|delayed|delay)\b/i;
/**
 * The same vocabulary in the languages the app ships (fr/es/de/zh-Hans).
 *
 * The scenario tiles send canonical English, which is why this went unnoticed:
 * a traveller typing "j'ai loupé mon vol" fell through the flight branch
 * entirely and landed on the generic custom rail — no flight target, no
 * missed-flight trade-off questions, on the one mission where being asked
 * "how soon can you be at the airport?" changes every plan that follows.
 */
const FLIGHT_INTENT_PATTERN_INTL =
  /(\bvol\b|\bavion\b|\bvuelo\b|\bflug\b|\bflieger\b|rat[ée]|loup[ée]|perd[íi]|verpass|retard|retras|versp[äa]t|航班|飞机|错过|误机|改签)/i;
/**
 * The subset of the above that names AIR TRAVEL specifically. The pattern above
 * is deliberately broad so that "I'm delayed" targets the right flight ON a trip
 * that has flights — but on a trip with NO flights those same generic verbs
 * appear in hotel, strike, illness and free-text missions ("my train is
 * delayed", "I'll miss check-in"). Answering those with
 * "this trip has no flights to reroute" is confidently wrong, so only an
 * explicit air-travel word (or a real flight number) short-circuits to 404.
 */
/** English OR any shipped language, per branch. */
const weatherIntentLike = (t: string) => WEATHER_INTENT_PATTERN.test(t) || WEATHER_INTENT_INTL.test(t);
const hotelIntentLike = (t: string) => HOTEL_INTENT_PATTERN.test(t) || HOTEL_INTENT_INTL.test(t);
const hotelTroubleLike = (t: string) => HOTEL_TROUBLE_PATTERN.test(t) || HOTEL_TROUBLE_INTL.test(t);
const activityIntentLike = (t: string) =>
  ACTIVITY_INTENT_PATTERN.test(t) || ACTIVITY_INTENT_INTL.test(t);
const strikeIntentLike = (t: string) => STRIKE_INTENT_PATTERN.test(t) || STRIKE_INTENT_INTL.test(t);
const unwellIntentLike = (t: string) => UNWELL_INTENT_PATTERN.test(t) || UNWELL_INTENT_INTL.test(t);

/** English OR any shipped language. */
function flightIntentLike(text: string): boolean {
  return FLIGHT_INTENT_PATTERN.test(text) || FLIGHT_INTENT_PATTERN_INTL.test(text);
}

const EXPLICIT_FLIGHT_PATTERN = /\b(flight|flights|plane|airline|airport|reroute|re-route|rebook)\b/i;
/** Prose words that must NEVER count as a destination/city match in 2b. */
const GENERIC_FLIGHT_WORDS = new Set([
  "flight",
  "flights",
  "delayed",
  "delay",
  "miss",
  "missed",
  "missing",
  "reroute",
  "rebook",
  "badly",
  "very",
  "please",
  "need",
  "needed",
  "today",
  "tomorrow",
  "morning",
  "evening",
  "airport",
  "boarding",
]);

/**
 * Outdoor detection on the activity NAME — the same term list the
 * ActivityAgent uses for weather swaps (kept local: this module is pure and
 * must not import agent internals).
 */
const OUTDOOR_NAME_TERMS = [
  "surf",
  "beach",
  "hik",
  "kayak",
  "snorkel",
  "div",
  "sail",
  "boat",
  "cruise",
  "zipline",
  "raft",
  "trek",
  "safari",
  "outdoor",
  "climbing",
  "biking",
  "cycling",
  "horseback",
  "horse riding",
  "paragliding",
  "golf",
  "fishing",
];

// ----------------------------------------------------------------- helpers

function truncate(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * The delay the traveller actually STATED, or `null` when they stated none.
 *
 * Kept separate from the defaulting below because the difference between
 * "they said four hours" and "we assumed four hours" is the difference
 * between a fact and an invention, and only one of them may move a schedule.
 */
function statedDelayMinutes(intent: string): number | null {
  const match = DELAY_HOURS_PATTERN.exec(intent);
  if (!match) return null;
  const hours = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.min(Math.round(hours * 60), MAX_DELAY_MINUTES);
}

/**
 * How late is this, in minutes?
 *
 * ONLY ASK THIS ABOUT A TRANSPORT DELAY. Every mission used to run through
 * here, so any wording without an explicit duration silently became a
 * four-hour delay — and that number was then propagated through the graph as
 * if the traveller had reported it.
 *
 * Measured live on 2026-09-18, that one default produced most of the
 * nonsense in the battery. "My hotel is overbooked" shifted check-in four
 * hours and reshuffled the whole day to "match your new arrival", when
 * nothing about the traveller's arrival had changed. "Transit strike
 * tomorrow" put a Singapore→Rome flight four hours late and then announced
 * "you are not in town until 14:20" — a local strike cannot delay a
 * long-haul flight, and the engine said it anyway.
 *
 * Four hours is a reasonable stand-in for "I missed my flight, I need the
 * next departure". It is a fabrication everywhere else, so everywhere else
 * now gets the stated duration or zero.
 */
function flightDelayMinutes(intent: string): number {
  return statedDelayMinutes(intent) ?? DEFAULT_DELAY_MINUTES;
}

/** Nothing is late unless the traveller said something is late. */
function nonTransportDelayMinutes(intent: string): number {
  return statedDelayMinutes(intent) ?? 0;
}

/** Deterministic weather hint from the intent text (drives activity swaps). */
function weatherHintFromIntent(intent: string): TripMissionOptions["weatherHint"] {
  if (/\b(storm|stormy|thunder|hurricane|typhoon)\b/i.test(intent)) return "storm";
  if (/\b(rain|rainy|snow|shower|precip)\b/i.test(intent)) return "rain";
  if (/\b(heat|heatwave)\b/i.test(intent)) return "extreme_heat";
  return undefined;
}

interface RefEntry {
  id: string;
  ref: SwarmNodeRef;
}

function entriesOf(nodeRefs: Record<string, SwarmNodeRef>, kind: SwarmNodeRef["kind"]): RefEntry[] {
  return Object.entries(nodeRefs)
    .filter(([, ref]) => ref.kind === kind)
    .map(([id, ref]) => ({ id, ref }))
    .sort((a, b) => a.ref.time - b.ref.time);
}

function looksOutdoor(label: string): boolean {
  const haystack = label.toLowerCase();
  return OUTDOOR_NAME_TERMS.some((term) => haystack.includes(term));
}

/** Extract the flight number embedded in a flight node label ("Flight TP437 …"). */
function flightNumberOf(entry: RefEntry): string | null {
  const match = /\b([A-Za-z]{2}\s?\d{1,4})\b/.exec(entry.ref.label);
  return match ? normalizeFlightNo(match[1]) : null;
}

// ------------------------------------------------------------------ parser

/**
 * Parse a free-text mission intent against a hydrated REAL trip.
 * `explicitNodeId` (Copilot tapped a specific node) wins over keyword
 * resolution when it exists in the trip's nodeRefs.
 */
/**
 * A new departure time the traveller STATED — "moved to 6am", "now leaves at
 * 18:40", "décalé à 21h30".
 *
 * The airline told them a time. Using it is reading a fact; falling back to
 * the four-hour default here is inventing one. Verified on the deployed
 * Worker on 2026-09-18, "the airline moved my flight to 6am, that's
 * impossible" produced "Delayed flight SQ634" with a four-hour delay nobody
 * mentioned, and cancelled three activities off the back of it.
 *
 * Returns minutes past midnight, or null when no time was stated.
 */
const STATED_TIME_PATTERN =
  /\b(?:to|at|for|à|a|auf|um|para)\s*(\d{1,2})\s*(?::|h|\.)?\s*(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?/i;

function statedDepartureMinutes(intent: string): number | null {
  const match = STATED_TIME_PATTERN.exec(intent);
  if (!match) return null;
  let hour = Number.parseInt(match[1], 10);
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
  if (!Number.isFinite(hour) || !Number.isFinite(minutes)) return null;
  if (minutes > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23) return null;
  // Without am/pm a bare hour is ambiguous; only a 24-hour-looking value or an
  // explicit meridiem is trustworthy enough to move a flight on.
  if (!meridiem && !match[2] && hour < 13) return null;
  return hour * 60 + minutes;
}

/** The traveller is reporting a SCHEDULE CHANGE, not a delay they suffered. */
const SCHEDULE_CHANGE_PATTERN =
  /\b(moved|rescheduled|changed|shifted|brought forward|now (leaves|departs)|d[ée]cal|avanc|chang|adelant|cambiad|verlegt|vorverlegt|ge[äa]ndert)\b/i;

/**
 * A mission's `description` becomes the approval sheet's HEADING.
 *
 * Every branch below used to append the traveller's own sentence to it.
 * Photographed at accessibility text size on 2026-09-18, that filled six bold
 * lines and pushed the plan itself entirely below the fold. The headings are
 * therefore short and derived — but they stay machine-readable, because
 * several checks downstream sniff this very string: the orchestrator reads
 * `/overbook/i` to know a room is gone, `classifyDisruptionKind` reads it for
 * a cancellation, and the ground rail's own gate reads it for trouble and
 * failure words. Anything that classifies has to survive into the heading.
 */

export function parseMissionIntentForTrip(
  intent: string,
  hydrated: HydratedTrip,
  explicitNodeId?: string,
): TripMissionParse {
  const text = intent.trim();
  const { nodeRefs, meta } = hydrated;
  const shortIntent = truncate(text);

  // ── Explicit node: validate, then classify the SAME way the keyword ──────
  // branches below do — an explicit node means "don't re-pick a target",
  // never "skip classification". This used to hardcode `kind: "delay"` for
  // everything non-weather, which silently broke every category-gated
  // behaviour for the scenario tiles (they ALL pass an explicit nodeId):
  // `allowsActivityDrops`, `hotelOverbooked`, and (via the orchestrator's own
  // text-sniffed classifier) a cancelled activity's OWN resolution. Live
  // symptom: "Activity cancelled — Lau Pa Sat" produced a plan that only
  // mentioned a downstream sibling and said nothing about Lau Pa Sat itself.
  if (explicitNodeId) {
    const ref = nodeRefs[explicitNodeId];
    if (!ref) {
      return {
        kind: "error",
        status: 404,
        code: "unknown_flight",
        message: `Node "${explicitNodeId}" is not part of the trip "${meta.title}".`,
      };
    }
    const weather = weatherIntentLike(text);
    const weatherHint = weatherHintFromIntent(text);
    if (weather) {
      return {
        kind: "mission",
        mission: {
          nodeId: explicitNodeId,
          delayMinutes: 0,
          description: personalize(ref.kind, shortIntent, hydrated, ref),
          origin: "proactive",
          ...(weatherHint ? { weatherHint } : {}),
          kind: "weather",
        },
      };
    }
    // Same per-kind keyword checks as branches 2/3/4 below, applied to the
    // EXPLICIT target instead of a name-matched one.
    let category: TripMissionCategory = "delay";
    let description = personalize(ref.kind, shortIntent, hydrated, ref);
    if (ref.kind === "flight") {
      const missed =
        /\bmiss(ed|ing)?\b/i.test(text) ||
        /(rat[ée]|loup[ée])/i.test(text) || // fr: raté / loupé
        /(perd[íi]|perdido)/i.test(text) || // es: perdí / perdido
        /verpass/i.test(text) || // de: verpasst / verpasste
        /(错过|误机|没赶上)/.test(text); // zh-Hans
      category = missed ? "missed_flight" : "delay";
    } else if (ref.kind === "hotel") {
      category = OVERBOOKED_LIKE.test(text) ? "hotel_overbooked" : "hotel";
    } else if (ref.kind === "activity") {
      const cancelled = /\bcancel\w*\b/i.test(text);
      category = cancelled ? "activity_cancelled" : "delay";
      // `classifyDisruptionKind` downstream (OrchestratorAgent) reads THIS
      // description text to detect a cancellation — the generic
      // "Change requested" wording never mentioned it, so route it through
      // that check too instead of only the category field.
      if (cancelled) description = `Activity cancelled — ${ref.label}`;
    }
    return {
      kind: "mission",
      mission: {
        nodeId: explicitNodeId,
        delayMinutes: nonTransportDelayMinutes(text),
        description,
        origin: "reactive",
        kind: category,
      },
    };
  }

  // ── 1. Weather → proactive on the first OUTDOOR activity ─────────────────
  if (weatherIntentLike(text)) {
    const activities = entriesOf(nodeRefs, "activity");
    let target = activities.find((a) => looksOutdoor(a.ref.label)) ?? activities[0];
    // Trips without activity nodes (e.g. transit-only): protect the first
    // UPCOMING flight, else the first hotel check-in. If the trip has no
    // usable target at all, fall through to the remaining branches (which
    // keep the 400 for genuinely unclassifiable text).
    if (!target) {
      const now = Date.now();
      target =
        entriesOf(nodeRefs, "flight").find((f) => f.ref.time >= now) ??
        entriesOf(nodeRefs, "hotel")[0];
    }
    if (target) {
      const weatherHint = weatherHintFromIntent(text);
      return {
        kind: "mission",
        mission: {
          nodeId: target.id,
          delayMinutes: 0,
          description: `Weather alert — ${meta.city || "the destination"}`,
          origin: "proactive",
          ...(weatherHint ? { weatherHint } : {}),
          evidence: {
            kind: "weather",
            source: "mission-intent",
            confidence: 0.6,
            detail: shortIntent,
          },
          kind: "weather",
        },
      };
    }
  }

  // ── 1b. A connection, judged before anything is called "delayed" ─────────
  //
  // This has to precede branch 2: "my connection is too tight, I'll never make
  // the SECOND FLIGHT" is full of flight vocabulary, so the generic rail
  // claimed it, picked the nearest upcoming leg, declared it four hours late
  // on no evidence and cancelled three activities. Nothing was late. The
  // question was whether a gap the traveller had already booked is survivable,
  // and the graph could answer it all along.
  //
  // The SECOND leg is the target: that is the flight at risk, and the one a
  // replacement search should be offering later departures for. Delay stays 0
  // — a tight connection is not a delay, and inventing one here is what
  // produced the wrong plan in the first place.
  if (isConnectionMission(text)) {
    const nowMs = Date.now();
    const connections = findConnections(hydrated.graph.getNodes());
    // The airport they named wins ("my connection at Doha" on a trip that
    // changes there out AND back), then the next change still ahead of them.
    const at = pickConnection(connections, { text, nowMs });
    if (at) {
      return {
        kind: "mission",
        mission: {
          nodeId: at.toId,
          delayMinutes: 0,
          description: `Connection at ${at.atAirport} — ${at.toLabel}`,
          origin: "reactive",
          kind: "delay",
        },
      };
    }
    // The trip has no change of plane at all. Saying so beats answering about
    // whichever flight happened to be next.
    return {
      kind: "error",
      status: 400,
      code: "no_connection_found",
      message:
        "We can't find a change of planes on this trip — no flight lists a stop, and every " +
        "flight either leaves from somewhere else or has a stay between it and the one before. " +
        "Tell us which flight you're worried about and we'll look at that.",
    };
  }

  // ── 2. Missed flight / delay ──────────────────────────────────────────────
  const flights = entriesOf(nodeRefs, "flight");
  const tokens = text.match(FLIGHT_TOKEN_PATTERN) ?? [];
  let flightTarget: RefEntry | undefined;
  let targetNote: string | undefined;

  const isFlightIntent = flightIntentLike(text) || tokens.length > 0;

  if (isFlightIntent && flights.length > 0) {
    // 2a. Exact flight number mentioned in the intent.
    for (const token of tokens) {
      flightTarget = flights.find((f) => flightNumberOf(f) === normalizeFlightNo(token));
      if (flightTarget) break;
    }
    // 2b. A city/destination word from the intent matches a flight's label.
    if (!flightTarget) {
      const haystack = text.toLowerCase();
      const cityHit =
        meta.city && meta.city.length > 1 && haystack.includes(meta.city.toLowerCase());
      flightTarget = cityHit
        ? (flights.find((f) => {
            // Guard the empty-string includes trap: a label without a "→"
            // destination half must never match every haystack.
            const dest = f.ref.label.toLowerCase().split("→")[1]?.trim();
            return !!dest && haystack.includes(dest);
          }) ?? flights[0])
        : flights.find((f) => {
            const label = f.ref.label.toLowerCase();
            return haystack
              .split(/\s+/)
              .some(
                (word) =>
                  word.length > 2 &&
                  !GENERIC_FLIGHT_WORDS.has(word.toLowerCase()) &&
                  label.includes(word.toLowerCase()),
              );
          });
    }
    // 2c. Generic flight wording (or unknown token) → nearest UPCOMING flight,
    //     else the LAST flight; the description notes which one was chosen.
    if (!flightTarget && isFlightIntent) {
      const now = Date.now();
      flightTarget = flights.find((f) => f.ref.time >= now) ?? flights[flights.length - 1];
      if (flightTarget) {
        // The label already starts with "Flight …", so falling back to it must
        // not produce "…upcoming flight Flight AF 007 JFK → CDG chosen…".
        const targetName =
          flightNumberOf(flightTarget) ??
          flightTarget.ref.label.replace(/^\s*flight\s+/i, "");
        targetNote = `Nearest ${
          flightTarget.ref.time >= now ? "upcoming" : "last"
        } flight ${targetName} chosen as the disruption target.`;
      }
    }
  } else if (flights.length === 0 && (EXPLICIT_FLIGHT_PATTERN.test(text) || tokens.length > 0)) {
    // Two conditions, and BOTH matter. The trip must have no flights at all,
    // AND the mission must actually name air travel.
    //
    // This branch is reached whenever the block above did not run — including
    // when the trip HAS flights but the wording is not a flight intent. Testing
    // the vocabulary alone therefore 404'd "my taxi to the airport is
    // cancelled" on a trip with two flights, because "airport" is air-travel
    // vocabulary: the traveler asked about a taxi and was told their trip has
    // no flights. Anything else falls through to the hotel / strike / unwell /
    // custom branches below, which is where these problems actually live.
    return {
      kind: "error",
      status: 404,
      code: "unknown_flight",
      message: `This trip has no flights to reroute ("${meta.title}").`,
    };
  }

  if (flightTarget) {
    // The airline gave them a new time — read it rather than defaulting.
    const statedMinutes = statedDepartureMinutes(text);
    const scheduleChange = SCHEDULE_CHANGE_PATTERN.test(text);
    if (scheduleChange && statedMinutes !== null) {
      const bookedMs = flightTarget.ref.time;
      const bookedMinutes = new Date(bookedMs).getUTCHours() * 60 + new Date(bookedMs).getUTCMinutes();
      const shift = statedMinutes - bookedMinutes;
      if (shift <= 0) {
        // A flight moved EARLIER is not something this engine can re-plan.
        // `ItineraryGraph.handleDisruption` refuses a negative delay outright
        // — the whole propagation model is "things move later", and what an
        // earlier departure breaks is everything BEFORE it, which is a
        // different algorithm rather than a missing branch. Saying so beats
        // inventing a four-hour delay and cancelling three activities, which
        // is what the default did here.
        return {
          kind: "error",
          status: 400,
          code: "earlier_departure_unsupported",
          message:
            "Your airline moved this flight EARLIER, and re-planning around that isn't something " +
            "we can do yet — everything before the flight would have to move, not after it. " +
            "Check in with the airline, and tell us if you need the day around it re-planned.",
        };
      }
      return {
        kind: "mission",
        mission: {
          nodeId: flightTarget.id,
          delayMinutes: shift,
          description: `Flight moved later — ${flightNumberOf(flightTarget) ?? "your flight"}`,
          origin: "reactive",
          kind: "delay",
        },
      };
    }
    const delayMinutes = flightDelayMinutes(text);
    // Unnamed leg ⇒ say "Missed flight", not "Missed flight your flight".
    const flightNo = flightNumberOf(flightTarget);
    // Localized, because the app is. The tiles send canonical English, but a
    // traveller typing in their own language ("j'ai loupé mon vol") was
    // classified as a mere DELAY — which quietly cost them the missed-flight
    // trade-off questions, since those are gated on this exact flag.
    // Covers the five languages the app ships (en/fr/es/de/zh-Hans).
    // NOTE on the missing \b: JavaScript word boundaries are ASCII-only, so
    // `\bloupé\b` never matches — é is not a "word character", which makes the
    // trailing boundary fail on the very words this exists to catch. Matching
    // the stem without a closing boundary is what actually works here.
    const missed =
      /\bmiss(ed|ing)?\b/i.test(text) ||
      /(rat[ée]|loup[ée])/i.test(text) ||        // fr: raté / loupé
      /(perd[íi]|perdido)/i.test(text) ||        // es: perdí / perdido
      /verpass/i.test(text) ||                   // de: verpasst / verpasste
      /(错过|误机|没赶上)/.test(text);              // zh-Hans
    const base = `${missed ? "Missed" : "Delayed"} flight${flightNo ? ` ${flightNo}` : ""}`;
    return {
      kind: "mission",
      mission: {
        nodeId: flightTarget.id,
        delayMinutes,
        // When the intent named no flight, the swarm PICKED one — say which.
        // Silently targeting a flight the traveler did not name is exactly
        // the kind of guess the Trust Layer exists to prevent. It travels as
        // its own field: the headline stays the incident, the Activity Stream
        // carries the choice, and neither can push the other off the screen.
        description: truncate(base),
        origin: "reactive",
        kind: missed ? "missed_flight" : "delay",
        ...(targetNote ? { targetNote } : {}),
      },
    };
  }

  // ── 3. Hotel trouble → first hotel_check_in node ─────────────────────────
  if (hotelIntentLike(text) && hotelTroubleLike(text)) {
    const hotels = entriesOf(nodeRefs, "hotel");
    if (hotels.length > 0) {
      const words = text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const target =
        hotels.find((h) => words.some((word) => h.ref.label.toLowerCase().includes(word))) ??
        hotels[0];
      const isOverbooked = OVERBOOKED_LIKE.test(text);
      return {
        kind: "mission",
        mission: {
          nodeId: target.id,
          delayMinutes: nonTransportDelayMinutes(text),
          description: isOverbooked
            ? `Hotel overbooked — ${target.ref.label}`
            : `Hotel issue — ${target.ref.label}`,
          origin: "reactive",
          evidence: isOverbooked
            ? { kind: "event", source: "user_report", confidence: 1, detail: "overbooked" }
            : undefined,
          // Was `isOverbooked ? "hotel" : "hotel"` — both branches produced
          // the same literal, so the overbooked signal never actually
          // reached anything past this point. This is the one place that
          // detects it (the "overbook*" keyword against the raw intent
          // text), so it has to be the one that tags it correctly.
          kind: isOverbooked ? "hotel_overbooked" : "hotel",
        },
      };
    }
  }

  // ── 3b. A broken ground connection ───────────────────────────────────────
  //
  // Its own branch, ahead of the activity and custom rails, for two reasons.
  // It stops "my taxi is cancelled" being read as a cancelled ACTIVITY (it
  // matched on the word "cancelled" and rescheduled a duty-free stop). And it
  // targets the ground leg itself when the trip has one, which is what lets
  // the ground rail answer about the journey that actually broke rather than
  // about the next thing on the calendar.
  //
  // The traveller's own words are kept in the description: everything
  // downstream — the ground rail's own gate, the airport check — reads them.
  // Strikes keep their own branch below: it already targets the ground leg and
  // carries the category and evidence the rest of the pipeline reads. This one
  // exists for the ground failures that had NO branch at all — a taxi that
  // never came, a cancelled transfer, a no-show pickup.
  if (isGroundMission(text) && !strikeIntentLike(text)) {
    const transfers = entriesOf(nodeRefs, "transfer");
    const nowMs = Date.now();
    const all = Object.entries(nodeRefs)
      .map(([id, ref]) => ({ id, ref }))
      .sort((a, b) => a.ref.time - b.ref.time);
    const target =
      transfers.find((t) => t.ref.time >= nowMs) ??
      transfers[0] ??
      all.find((n) => n.ref.time >= nowMs) ??
      all[0];
    if (target) {
      return {
        kind: "mission",
        mission: {
          nodeId: target.id,
          // Nothing is late. A ride that never came is not a delay, and
          // shifting the schedule by a made-up amount is how this used to
          // move three activities for a cancelled taxi.
          delayMinutes: nonTransportDelayMinutes(text),
          // Derived, not echoed: this string is the approval sheet's heading,
          // and the traveller's own sentence filled six bold lines at
          // accessibility text size, pushing the answer off the screen.
          description: groundHeadline(text),
          origin: "reactive",
          kind: "custom",
        },
      };
    }
  }

  // ── 4. Activity cancelled → name match, else first activity ─────────────
  //
  // A BROKEN CONNECTION IS NOT A CANCELLED ACTIVITY. "My taxi to the airport
  // is cancelled" matches this branch on the word "cancelled", and live on
  // 2026-09-18 it picked the activity whose name shared a word — "Kansai
  // Airport Departure & Duty-Free" — and moved the traveller's duty-free
  // shopping to the following afternoon. They had asked how to reach the
  // airport. The ground rail answers that question with real durations; this
  // branch must not answer it with a rescheduled souvenir stop.
  if (activityIntentLike(text)) {
    const activities = entriesOf(nodeRefs, "activity");
    if (activities.length > 0) {
      const words = text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const target =
        activities.find((a) => words.some((word) => a.ref.label.toLowerCase().includes(word))) ??
        activities[0];
      return {
        kind: "mission",
        mission: {
          nodeId: target.id,
          delayMinutes: nonTransportDelayMinutes(text),
          description: `Activity cancelled — ${target.ref.label}`,
          origin: "reactive",
          kind: "activity_cancelled",
        },
      };
    }
  }

  // ── 5. Strike → a GROUND transit leg, never a flight ────────────────────
  //
  // This used to fall back to `flights[0]` when the trip had no transfer
  // node, and that fallback was a fabrication with visible consequences.
  // Live on 2026-09-18, "Transit strike tomorrow" on the Rome trip landed on
  // Flight SQ 366 SIN → FCO, put it four hours late, and told the traveller
  // "You are not in town until about 14:20" — three activities moved because
  // of a causal link that does not exist. A metro/bus/rail strike at the
  // destination does not delay a long-haul flight; what it threatens is the
  // traveller's ability to MOVE AROUND, which is what the branches below
  // address.
  if (strikeIntentLike(text)) {
    const transfers = entriesOf(nodeRefs, "transfer");
    const transitTarget = transfers[0];
    if (transitTarget) {
      return {
        kind: "mission",
        mission: {
          nodeId: transitTarget.id,
          delayMinutes: nonTransportDelayMinutes(text),
          description: `Transit strike — ${transitTarget.ref.label}`,
          origin: "reactive",
          kind: "strike",
        },
      };
    }
    // No transit node to disrupt: re-plan AROUND the strike instead — target
    // an ACTIVITY as a proactive user_report with zero delay. Activities
    // only: the orchestrator synthesizes rescheduling requests exclusively
    // for type === "activity" nodes, so a hotel target would yield zero
    // proposals. No activities ⇒ the same 400 no_actionable_nodes result
    // the unwell branch uses.
    const now = Date.now();
    const activities = entriesOf(nodeRefs, "activity");
    const fallbackTarget = activities.find((a) => a.ref.time >= now) ?? activities[0];
    if (!fallbackTarget) {
      return {
        kind: "error",
        status: 400,
        code: "no_actionable_nodes",
        message: `This trip has no activities to re-plan around the strike ("${meta.title}").`,
      };
    }
    return {
      kind: "mission",
      mission: {
        nodeId: fallbackTarget.id,
        delayMinutes: 0,
        description: `Transit strike — ${meta.city || meta.title}`,
        origin: "proactive",
        evidence: {
          kind: "user_report",
          source: "mission-intent",
          confidence: 0.8,
          detail: "transit_strike",
        },
        kind: "strike",
      },
    };
  }

  // ── 6. Unwell / lighten the day → proactive on the first activity ───────
  if (unwellIntentLike(text)) {
    const activities = entriesOf(nodeRefs, "activity");
    if (activities.length === 0) {
      // Nothing to lighten: a trip without activity nodes has no actionable
      // target for a wellbeing mission (mapped to 400 by the API layer).
      return {
        kind: "error",
        status: 400,
        code: "no_actionable_nodes",
        message: `This trip has no activities to lighten ("${meta.title}").`,
      };
    }
    // The day they are LIVING, not day one. Targeting `activities[0]` lightened
    // the first day of the trip however far into it the traveller was — and
    // the day being lightened is the day the target sits on.
    const nowMs = Date.now();
    const target =
      activities.find((a) => a.ref.time >= nowMs) ?? activities[activities.length - 1];
    return {
      kind: "mission",
      mission: {
        nodeId: target.id,
        delayMinutes: 0,
        description: `Lighten the day — ${meta.city || meta.title}`,
        origin: "proactive",
        evidence: {
          kind: "user_report",
          source: "mission-intent",
          confidence: 0.8,
          detail: shortIntent,
        },
        kind: "unwell",
      },
    };
  }

  // ── 7. A custom request — but only when it really is one ─────────────────
  //
  // THIS BRANCH USED TO ACCEPT EVERYTHING. The gate below was written,
  // documented in SPEC-QA §3, described at length in the UI-test fixtures —
  // and never wired up: `CUSTOM_REQUEST_PATTERN` and the two IMPERATIVE
  // patterns sat unused while the branch took the first upcoming node for any
  // text at all. Measured against the deployed Worker on 2026-09-18, every
  // one of these was accepted and answered:
  //
  //   "help"                              → a mission
  //   "what's the wifi password at my hotel"
  //                                       → classified as a HOTEL ISSUE, and
  //                                         answered "your booking is
  //                                         untouched; confirm a late arrival"
  //   "my suitcase didn't arrive"         → the first upcoming node was a
  //                                         FLIGHT, so the flight rail ran and
  //                                         proposed three rebookings at
  //                                         2,306,617 IDR (~€135), cancelling
  //                                         four activities
  //
  // A traveller with a lost suitcase being shown a €135 ticket is the worst
  // failure this system can produce, and it needed no disruption at all —
  // only a sentence the parser did not understand.
  //
  // So the swarm now knows its own edges. A request qualifies when it names
  // one ("custom request"), or asks for an ACTION on something the engine can
  // actually act on. Everything else is refused, out loud, with what we do
  // handle — because answering a question we did not understand, confidently
  // and expensively, is worse than admitting we cannot.
  const isCustomRequest =
    CUSTOM_REQUEST_PATTERN.test(text) ||
    (IMPERATIVE_ACTION_PATTERN.test(text) && IMPERATIVE_TARGET_PATTERN.test(text));

  if (isCustomRequest) {
    // A flight is never a custom target: branch 2 owns flight problems, so
    // anything reaching here is not one — and putting a flight node on this
    // rail is exactly what turned a lost suitcase into a rebooking.
    const now = Date.now();
    const actionable = Object.entries(nodeRefs)
      .map(([id, ref]) => ({ id, ref }))
      .filter(({ ref }) => ref.kind !== "flight")
      .sort((a, b) => a.ref.time - b.ref.time);
    const target = actionable.find((n) => n.ref.time >= now) ?? actionable[0];
    if (target) {
      return {
        kind: "mission",
        mission: {
          nodeId: target.id,
          delayMinutes: nonTransportDelayMinutes(text),
          description: `Custom request — ${meta.city || meta.title}`,
          origin: "reactive",
          kind: "custom",
        },
      };
    }
  }

  return {
    kind: "error",
    status: 400,
    code: "out_of_scope",
    message:
      "We couldn't match that to something the swarm can re-plan. It handles missed or delayed " +
      "flights, hotel trouble, cancelled activities, weather, transport strikes, a broken ride to " +
      "the airport, and lightening a day you can't face — tell us which of those it is, or name " +
      "the booking you want changed.",
  };
}

/**
 * Headline for an explicit-node mission. This becomes the plan's `incident`,
 * which the approval sheet sets as its heading — so it states WHAT HAPPENED in
 * a few words and nothing else. It used to append the destination AND echo the
 * traveler's own typed sentence back at them, which ran to five wrapped lines
 * of bold text above a card that already showed the flight, the route and the
 * impacted nodes.
 */
function personalize(
  kind: SwarmNodeRef["kind"],
  shortIntent: string,
  hydrated: HydratedTrip,
  ref: SwarmNodeRef,
): string {
  switch (kind) {
    case "flight":
      return `Reroute requested — ${ref.label}`;
    case "hotel":
      return `Hotel issue — ${ref.label}`;
    case "activity":
      return `Change requested — ${ref.label}`;
    default:
      return `Disruption — ${ref.label}`;
  }
}
