/**
 * How the traveller covers ground when the way they planned to has gone.
 *
 * THE GAP THIS FILLS: the swarm could re-plan flights, hotels and activities,
 * and nothing else. Every mission was modelled as "a node is late", propagated
 * downstream. That is right for a missed flight and wrong for the two most
 * ordinary emergencies a traveller actually has — the metro is on strike, the
 * taxi never came — because in both cases nothing is late. A *connection* has
 * disappeared, and the question is how else to make it.
 *
 * Measured live on 2026-09-18, the engine answered "Transit strike tomorrow"
 * with no changes at all on one trip, and on another by delaying a
 * Singapore→Rome flight four hours. It answered "My taxi to the airport is
 * cancelled" by moving a duty-free stop to the following afternoon. None of
 * those is an answer; two of them are inventions.
 *
 * WHAT IS REAL HERE: every duration comes from Google Routes through the
 * `ground-options` function — driving priced against the traffic at the actual
 * departure instant, transit against the actual timetable. Nothing is
 * estimated. A mode we could not price is reported as unknown and never as a
 * number, because a made-up travel time is precisely how somebody misses a
 * flight.
 */

/** One way of covering the ground, as the provider answered. */
export interface GroundOption {
  mode: "drive" | "transit" | "walk";
  available: boolean;
  /** Door-to-door seconds. `null` whenever it could not be priced. */
  seconds: number | null;
  distanceMeters: number | null;
  /** Why a mode is out, when the provider said. Never a substitute duration. */
  reason?: string;
}

export interface GroundPoint {
  lat: number;
  lng: number;
}

export interface GroundLinkConfig {
  supabaseUrl: string;
  /** The Supabase anon/publishable key, for the `apikey` header. */
  anonKey: string;
  /** The TRAVELLER's own token: they are asking about their own trip. */
  userToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Ask `ground-options` how the traveller can cover a stretch of ground.
 *
 * TOTAL: any failure yields an empty list, and an empty list means "we do not
 * know", which every caller must treat as "say nothing and change nothing".
 */
export class GroundLink {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: GroundLinkConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async options(
    from: GroundPoint,
    to: GroundPoint,
    departAtMs?: number,
    /** Restrict the modes priced — each one is a billed request. */
    modes?: string[],
  ): Promise<GroundOption[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.config.supabaseUrl.replace(/\/+$/, "")}/functions/v1/ground-options`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            apikey: this.config.anonKey,
            Authorization: `Bearer ${this.config.userToken}`,
          },
          body: JSON.stringify({
            from,
            to,
            ...(departAtMs !== undefined && Number.isFinite(departAtMs)
              ? { departAt: new Date(departAtMs).toISOString() }
              : {}),
            ...(modes && modes.length > 0 ? { modes } : {}),
          }),
        },
      );
      if (!response.ok) {
        console.warn(`[ground-link] ground-options answered ${response.status} — modes unknown`);
        return [];
      }
      const body = (await response.json()) as {
        options?: Array<{
          mode?: string;
          available?: boolean;
          seconds?: number | null;
          distance_meters?: number | null;
          reason?: string;
        }>;
      };
      const out: GroundOption[] = [];
      for (const entry of body.options ?? []) {
        if (entry.mode !== "drive" && entry.mode !== "transit" && entry.mode !== "walk") continue;
        out.push({
          mode: entry.mode,
          available: entry.available === true,
          seconds: typeof entry.seconds === "number" ? entry.seconds : null,
          distanceMeters:
            typeof entry.distance_meters === "number" ? entry.distance_meters : null,
          ...(entry.reason ? { reason: entry.reason } : {}),
        });
      }
      return out;
    } catch (error) {
      console.warn("[ground-link] lookup failed — modes unknown:", error);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

// ----------------------------------------------------- deterministic readings

/** Modes a traveller can actually take, quickest first. */
export function viableOptions(options: GroundOption[]): GroundOption[] {
  return options
    .filter((o) => o.available && typeof o.seconds === "number")
    .sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0));
}

/**
 * The last moment you can set off and still be there in time.
 *
 * Pure arithmetic over a provider duration and the buffer the caller states.
 * It deliberately does NOT round in the traveller's favour: the value is
 * floored to the minute, so a plan can only ever be early.
 */
export function latestDeparture(
  arriveByMs: number,
  travelSeconds: number,
  bufferMinutes: number,
): number {
  return Math.floor(
    (arriveByMs - travelSeconds * 1000 - bufferMinutes * 60_000) / 60_000,
  ) * 60_000;
}

/** "1 h 12" / "48 min" — the way a duration is read aloud. */
export function humanDuration(seconds: number): string {
  const total = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${String(minutes).padStart(2, "0")}`;
}

const MODE_LABEL: Record<GroundOption["mode"], string> = {
  drive: "Car or taxi",
  transit: "Public transport",
  walk: "On foot",
};

/**
 * Say what the ground looks like — and, when there is something to catch, the
 * time to set off for each way of getting there.
 *
 * Every line is derived: a provider duration, the traveller's own scheduled
 * commitment, and the buffer the caller states. When nothing could be priced
 * the list is empty and the caller says nothing, which is the honest outcome.
 */
export function describeGround(
  options: GroundOption[],
  arriveByMs?: number,
  bufferMinutes = 0,
): string[] {
  const lines: string[] = [];
  for (const option of options) {
    const label = MODE_LABEL[option.mode];
    if (option.available && typeof option.seconds === "number") {
      const when =
        arriveByMs !== undefined && Number.isFinite(arriveByMs)
          ? ` — set off by ${new Date(
              latestDeparture(arriveByMs, option.seconds, bufferMinutes),
            )
              .toISOString()
              .slice(11, 16)}`
          : "";
      // Driving and transit do not deserve the same confidence, and saying so
      // is accuracy rather than hedging. Road routing is uniform; transit
      // depends on each agency publishing a feed, and the coverage genuinely
      // varies. Verified on 2026-09-18: central Rome → Fiumicino comes back at
      // about 2 h 58 at every hour of the day, because the provider does not
      // appear to route over the airport express that does it in under an
      // hour. The number is a real journey it found — it is not proof that no
      // faster one exists, and "public transport: about 2 h 58" reads as if it
      // were, which pushes a traveller into a taxi they may not need.
      lines.push(
        option.mode === "transit"
          ? `${label}: best route we found takes about ${humanDuration(option.seconds)}${when}`
          : `${label}: about ${humanDuration(option.seconds)}${when}`,
      );
      continue;
    }
    // An unavailable mode is worth a line only when the provider gave us a
    // real MEASUREMENT to state. A walk we priced at twenty hours is a fact
    // the traveller can act on. A mode that simply came back empty is not:
    // verified on 2026-09-18, Routes returns no transit for Tokyo Station →
    // Shibuya, a corridor with a train every two minutes, because its transit
    // licensing does not cover Japan. Printing "no service right now" there
    // would be a confident lie, and printing "we could not price it" is noise
    // the traveller cannot use. So it goes unsaid, and the trace keeps it.
    if (option.reason === "too_far_to_walk" && typeof option.seconds === "number") {
      lines.push(`${label}: ${humanDuration(option.seconds)} — too far to be realistic`);
    }
  }
  return lines;
}
