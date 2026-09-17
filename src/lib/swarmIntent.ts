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
 *   5. strike             → first transfer/train node, else first flight
 *                           (reactive); when NO transit node exists, proactive
 *                           user_report on the first upcoming activity/hotel
 *   6. unwell/lighten     → proactive on the first activity (user_report);
 *                           400 no_actionable_nodes when the trip has none
 */

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
/** Weather vocabulary ⇒ proactive mission (mirrors hackathonApi's set). */
const WEATHER_INTENT_PATTERN =
  /\b(rain|rainy|storm|stormy|thunder|weather|forecast|snow|wind|heat|heatwave|hurricane|typhoon)\b/i;
/** Hotel trouble keywords — hotel-specific vocabulary ONLY: generic
 *  "cancelled/cancellation" must NOT land here (it belongs to the activity
 *  branch below), so a "my activity got cancelled" intent never misfires
 *  onto the hotel node. */
const HOTEL_INTENT_PATTERN =
  /\b(overbook\w*|no-show|no show|hotel|room|reservation|check-in|check in)\b/i;
/** Activity cancellation keywords. */
const ACTIVITY_INTENT_PATTERN = /\b(cancel\w*|activity|tour|lesson|excursion|class|booking)\b/i;
/** Transport strike keywords. */
const STRIKE_INTENT_PATTERN = /\bstrike\w*\b/i;
/** Traveler wellbeing / lighten-the-day keywords. */
const UNWELL_INTENT_PATTERN = /\b(unwell|lighten\w*|sick|exhausted|tired)\b/i;
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

function delayMinutesFromIntent(intent: string): number {
  const match = DELAY_HOURS_PATTERN.exec(intent);
  if (!match) return DEFAULT_DELAY_MINUTES;
  const hours = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_DELAY_MINUTES;
  return Math.min(Math.round(hours * 60), MAX_DELAY_MINUTES);
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
    const weather = WEATHER_INTENT_PATTERN.test(text);
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
      category = /\b(overbook\w*)\b/i.test(text) ? "hotel_overbooked" : "hotel";
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
        delayMinutes: delayMinutesFromIntent(text),
        description,
        origin: "reactive",
        kind: category,
      },
    };
  }

  // ── 1. Weather → proactive on the first OUTDOOR activity ─────────────────
  if (WEATHER_INTENT_PATTERN.test(text)) {
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
          description: `Weather alert in ${meta.city || "the destination"}: ${shortIntent}`,
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
    const delayMinutes = delayMinutesFromIntent(text);
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
        // When the intent named no flight, the swarm PICKED one — say which,
        // and say it first so the note survives truncation. Silently
        // targeting a flight the traveler did not name is exactly the kind of
        // guess the Trust Layer exists to prevent.
        description: truncate(targetNote ? `${targetNote} ${base}` : base),
        origin: "reactive",
        kind: missed ? "missed_flight" : "delay",
      },
    };
  }

  // ── 3. Hotel trouble → first hotel_check_in node ─────────────────────────
  if (HOTEL_INTENT_PATTERN.test(text)) {
    const hotels = entriesOf(nodeRefs, "hotel");
    if (hotels.length > 0) {
      const words = text
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      const target =
        hotels.find((h) => words.some((word) => h.ref.label.toLowerCase().includes(word))) ??
        hotels[0];
      const isOverbooked = /\b(overbook\w*)\b/i.test(text);
      return {
        kind: "mission",
        mission: {
          nodeId: target.id,
          delayMinutes: delayMinutesFromIntent(text),
          description: `Hotel issue at ${target.ref.label}: ${shortIntent}`,
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

  // ── 4. Activity cancelled → name match, else first activity ─────────────
  if (ACTIVITY_INTENT_PATTERN.test(text)) {
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
          delayMinutes: delayMinutesFromIntent(text),
          description: `Activity "${target.ref.label}" needs a new slot: ${shortIntent}`,
          origin: "reactive",
          kind: "activity_cancelled",
        },
      };
    }
  }

  // ── 5. Strike → first transfer/train node, else first flight ────────────
  if (STRIKE_INTENT_PATTERN.test(text)) {
    const transfers = entriesOf(nodeRefs, "transfer");
    const transitTarget = transfers[0] ?? flights[0];
    if (transitTarget) {
      return {
        kind: "mission",
        mission: {
          nodeId: transitTarget.id,
          delayMinutes: delayMinutesFromIntent(text),
          description: `Strike affecting ${transitTarget.ref.label}: ${shortIntent}`,
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
        description: `Strike in ${meta.city || meta.title}: re-planning around ${fallbackTarget.ref.label}: ${shortIntent}`,
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
  if (UNWELL_INTENT_PATTERN.test(text)) {
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
    return {
      kind: "mission",
      mission: {
        nodeId: activities[0].id,
        delayMinutes: 0,
        description: `Lighten the day in ${meta.city || meta.title}: ${shortIntent}`,
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

  // ── 7. Custom fallback (Greedy Catch-All) ────────────────────────────────
  // Interpret as a general/custom issue applying to the trip. We target the
  // first upcoming node (or the first node overall if none are in the future).
  const allNodes = Object.entries(nodeRefs)
    .map(([id, ref]) => ({ id, ref }))
    .sort((a, b) => a.ref.time - b.ref.time);

  if (allNodes.length > 0) {
    const now = Date.now();
    const target = allNodes.find((n) => n.ref.time >= now) ?? allNodes[0];
    return {
      kind: "mission",
      mission: {
        nodeId: target.id,
        delayMinutes: delayMinutesFromIntent(text),
        description: `Custom request for ${meta.city || meta.title}: ${shortIntent}`,
        origin: "reactive",
        kind: "custom",
      },
    };
  }

  return {
    kind: "error",
    status: 400,
    code: "invalid_intent",
    message:
      "Could not determine a mission target from the intent (mention a flight, hotel, activity, weather or strike).",
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
