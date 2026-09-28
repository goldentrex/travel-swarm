/**
 * What a venue's own schedule says about a proposed slot.
 *
 * This is the layer that lets the swarm be CATEGORICAL. Until now "is this
 * possible?" was answered either by a clock rule that knows nothing about
 * places, or by a language model asked to judge — and measured across three
 * live batteries the model was right about stable facts (3/3) and wrong every
 * time it inferred a closure from an arrival time (0/3), always in the same
 * direction: declaring shut what was open.
 *
 * So nobody is asked to judge any more. Google's published weekly schedule
 * says when the doors are open, `place-hours` caches it globally for 30 days,
 * and the arithmetic below is ordinary comparison.
 *
 * THE PART THAT IS NOT OBVIOUS: being right about the hours is worthless if
 * they belong to the wrong place. Live on 2026-09-18, "Tokyo Metropolitan
 * Government Building Observation Deck" resolved to the NORTH deck
 * (09:30–17:30) fifteen metres from the South one (09:30–22:00). Both
 * schedules are correct; only one is the place the traveller meant. An
 * authoritative wrong answer is worse than no answer, so every verdict carries
 * whether the name really matched, and a caller that intends to CANCEL must
 * check it.
 */

/**
 * Places types a traveller can stand in while its shops are closed.
 *
 * Live on 2026-09-18, "Evening Stroll around Covent Garden Piazza" resolved to
 * Covent Garden at 0 m — correctly — and Google reported it shut until 11:00.
 * That is true of the MARKET; the piazza around it never closes, and the
 * engine cancelled a 21:30 stroll on it. The name check could not catch this:
 * "Covent Garden" sits inside the asked name exactly as "Rules" sits inside
 * "Rules Restaurant London", and one of those is a good match.
 *
 * The types tell them apart. Covent Garden carries `historical_landmark` and
 * `historical_place` alongside `shopping_mall`; Biku carries only restaurant
 * and bar types. A place that is ALSO a landmark or an open space is one you
 * can walk through.
 */
const PUBLIC_SPACE_TYPES: ReadonlySet<string> = new Set([
  "historical_landmark",
  "historical_place",
  "tourist_attraction",
  "monument",
  "park",
  "national_park",
  "state_park",
  "plaza",
  "town_square",
  "beach",
  "hiking_area",
  "natural_feature",
  "neighborhood",
  "sublocality",
  "route",
  "cultural_landmark",
]);

const QUALIFIERS =
  /\b(north|south|east|west|nord|sud|est|ouest|annex|annexe|no\.?\s*\d+|number\s*\d+|tower\s*\d+|terminal\s*\d+|building\s*\d+|branch|store|ten|kan)\b/gi;

/** One venue, and the instant we need an answer about. */
export interface VenueQuery {
  nodeId: string;
  name: string;
  lat: number;
  lng: number;
  /** ISO-8601 instant the item is proposed for. */
  atIso: string;
}

export interface VenueVerdict {
  nodeId: string;
  /** `null` when the venue could not be resolved — which is NOT "closed". */
  openAtSlot: boolean | null;
  /** Minutes from the proposed slot until the doors open, when shut. */
  opensInMinutes: number | null;
  /** Venue-local "HH:mm" it shuts, when open. */
  closingTime: string | null;
  /** The entity Google actually answered about. */
  matchedName: string | null;
  matchedDistanceM: number | null;
  /** Its Places types — what tells a shop from a square you can walk through. */
  matchedTypes: string[];
  /**
   * The matched place is somewhere a traveller can BE when its businesses are
   * shut: a landmark, a park, a square, a district. Its hours are real and may
   * be worth mentioning, but they can never cancel anything.
   */
  publicSpace: boolean;
  /**
   * Does the matched entity plausibly BE the place we asked about? False means
   * the schedule is real but may describe a neighbour — it may inform the
   * traveller, and may never cancel anything.
   */
  nameConfident: boolean;
}

function normalize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Did Google answer about the place we meant?
 *
 * Two things disqualify a match. A qualifier the asked name does not carry —
 * "North", "No. 1", "Terminal 2" — means the result is ONE OF SEVERAL and we
 * did not say which; that is the Tokyo deck exactly. And a result too far from
 * the item's own coordinate is a same-name venue elsewhere in town.
 *
 * Otherwise the two names must genuinely overlap: a shared significant word is
 * not enough ("Tokyo" matches half of Tokyo), so the shorter name has to be
 * largely contained in the longer one.
 */
export function isConfidentMatch(
  asked: string,
  matched: string | null,
  distanceM: number | null,
): boolean {
  if (!matched) return false;
  if (typeof distanceM === "number" && distanceM > 150) return false;

  const askedQualifiers = new Set((asked.match(QUALIFIERS) ?? []).map((q) => q.toLowerCase()));
  for (const qualifier of matched.match(QUALIFIERS) ?? []) {
    if (!askedQualifiers.has(qualifier.toLowerCase())) return false;
  }

  const a = new Set(normalize(asked));
  const b = new Set(normalize(matched));
  if (a.size === 0 || b.size === 0) return false;
  const shared = [...a].filter((w) => b.has(w)).length;
  const shorter = Math.min(a.size, b.size);
  return shared / shorter >= 0.6;
}

export interface VenueHoursConfig {
  supabaseUrl: string;
  /** The Supabase anon/publishable key, for the `apikey` header. */
  anonKey: string;
  /** The TRAVELLER's own token: they are asking about their own trip. */
  userToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** `place-hours` caps a batch at 20 and SILENTLY drops the rest. */
const BATCH = 20;
const DEFAULT_TIMEOUT_MS = 7_000;

/**
 * Ask `place-hours` about a set of venues. TOTAL: any failure yields an empty
 * map, and an absent verdict means "unknown", which every caller must treat as
 * "change nothing".
 */
export class VenueHours {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: VenueHoursConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async lookup(queries: VenueQuery[]): Promise<Map<string, VenueVerdict>> {
    const out = new Map<string, VenueVerdict>();
    if (queries.length === 0) return out;
    // Chunked rather than truncated: the endpoint drops everything past its
    // twentieth entry without a word, and a silently unchecked venue is
    // exactly the kind of gap this layer exists to close.
    for (let i = 0; i < queries.length; i += BATCH) {
      await this.lookupBatch(queries.slice(i, i + BATCH), out);
    }
    return out;
  }

  private async lookupBatch(batch: VenueQuery[], out: Map<string, VenueVerdict>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/place-hours`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            apikey: this.config.anonKey,
            Authorization: `Bearer ${this.config.userToken}`,
          },
          body: JSON.stringify({
            places: batch.map((q) => ({
              key: q.nodeId,
              name: q.name,
              lat: q.lat,
              lng: q.lng,
              at: q.atIso,
              // We may cancel on this answer, so we need to know who answered.
              verify: true,
            })),
          }),
        },
      );
      if (!response.ok) {
        console.warn(`[venue-hours] place-hours answered ${response.status} — venues left unknown`);
        return;
      }
      const body = (await response.json()) as {
        hours?: Record<
          string,
          {
            open_now?: boolean | null;
            opens_in_minutes?: number | null;
            closing_time?: string | null;
            matched_name?: string | null;
            matched_distance_m?: number | null;
            matched_types?: string[] | null;
          }
        >;
      };
      for (const query of batch) {
        const hit = body.hours?.[query.nodeId];
        if (!hit || hit.open_now === undefined || hit.open_now === null) continue;
        const matchedTypes = Array.isArray(hit.matched_types) ? hit.matched_types : [];
        out.set(query.nodeId, {
          nodeId: query.nodeId,
          openAtSlot: hit.open_now,
          opensInMinutes: hit.opens_in_minutes ?? null,
          closingTime: hit.closing_time ?? null,
          matchedName: hit.matched_name ?? null,
          matchedDistanceM: hit.matched_distance_m ?? null,
          matchedTypes,
          publicSpace: matchedTypes.some((t) => PUBLIC_SPACE_TYPES.has(t)),
          nameConfident: isConfidentMatch(
            query.name,
            hit.matched_name ?? null,
            hit.matched_distance_m ?? null,
          ),
        });
      }
    } catch (error) {
      console.warn("[venue-hours] lookup failed — venues left unknown:", error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Turn a schedule verdict into what the engine should do — the whole decision,
 * in one place, made of comparisons only.
 *
 *  - open            → nothing to do.
 *  - shut, confident → a PROOF. Move to the opening if it falls on the same
 *    day, otherwise cancel: the doors really are locked.
 *  - shut, NOT confident → say so, change nothing. The hours are real but may
 *    belong to the deck next door.
 *  - unknown         → nothing to do. Silence is not a closure.
 */
export type VenueOutcome =
  | { action: "keep" }
  | { action: "move"; atMs: number; reason: string }
  | { action: "drop"; reason: string }
  | { action: "flag"; reason: string };

export function decideFromHours(
  verdict: VenueVerdict | undefined,
  venueName: string,
  slotMs: number,
): VenueOutcome {
  if (!verdict || verdict.openAtSlot === null) return { action: "keep" };
  if (verdict.openAtSlot === true) return { action: "keep" };

  const opensInMinutes = verdict.opensInMinutes;
  // A square, a landmark, a district: its shops close, it does not. Saying so
  // is useful; cancelling an evening walk through it is not.
  if (verdict.publicSpace) {
    return {
      action: "flag",
      reason:
        `${venueName}: the businesses there are closed at that hour, but the place itself ` +
        `stays open — worth knowing if you were going in rather than past.`,
    };
  }
  if (!verdict.nameConfident) {
    const who = verdict.matchedName ? `"${verdict.matchedName}"` : "a nearby venue";
    return {
      action: "flag",
      reason:
        `We checked ${who}, which is closed then — but that may not be the same place as ` +
        `${venueName}. Worth confirming before you go.`,
    };
  }

  if (typeof opensInMinutes === "number" && opensInMinutes > 0) {
    const openAtMs = slotMs + opensInMinutes * 60_000;
    const sameDay = new Date(openAtMs).toISOString().slice(0, 10) === new Date(slotMs).toISOString().slice(0, 10);
    if (sameDay) {
      return {
        action: "move",
        atMs: openAtMs,
        reason: `${venueName} does not open until then — moved to when the doors open.`,
      };
    }
  }
  return {
    action: "drop",
    reason: `${venueName} is closed at that time and does not reopen today.`,
  };
}
