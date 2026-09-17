/**
 * ViatorActivityProvider — concrete {@link ActivityProvider} for the
 * ActivityAgent.
 *
 * Per spec §2.2, Viator access rides the EXISTING `viator-activities` Supabase
 * Edge Function (which owns the `VIATOR_API_KEY` server-side), NOT a direct
 * Partner API integration from the Worker. This provider therefore calls
 * `${SUPABASE_URL}/functions/v1/viator-activities` with fetch. A direct
 * Partner API fallback (`VIATOR_API_KEY` in process.env) is kept for
 * environments without a reachable Supabase project — it performs a single
 * free-text search (no destination pre-resolution) and is documented as the
 * degraded mode.
 *
 * Graceful degradation (spec §4.1 policy): missing config or any upstream
 * failure resolves to `{ options: [], degraded: true }` instead of throwing,
 * so a weather-driven swap never sinks the whole recovery plan — the
 * ActivityAgent falls back to a pure reschedule in that case.
 *
 * Indoor/outdoor tagging is deterministic keyword classification applied to
 * every mapped option (see {@link tagActivitySetting}).
 */

import type { ActivityProvider } from "../interfaces/ActivityProvider";
import type {
  ActivityOption,
  ActivitySearchQuery,
  ActivitySearchResult,
  ActivitySetting,
} from "../interfaces/types";

const DEFAULT_VIATOR_BASE = "https://api.viator.com/partner";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_COUNT = 8;

export interface ViatorActivityProviderConfig {
  /** Supabase project URL hosting the `viator-activities` Edge Function. */
  supabaseUrl?: string;
  /** Auth bearer accepted by the Edge Function (anon/publishable or service key). */
  supabaseKey?: string;
  /** Direct Partner API key — only used by the degraded direct fallback. */
  viatorApiKey?: string;
  /** Direct Partner API base URL override (sandbox testing). */
  viatorBase?: string;
  timeoutMs?: number;
}

/**
 * Deterministic indoor/outdoor tagging. Checked against the lowercased
 * product title + Viator flag strings. Outdoor terms win ties because the
 * weather-protection path treats "unknown" conservatively (reschedule, not
 * swap) — a false "indoor" would be worse than a missed swap.
 */
const OUTDOOR_TERMS = [
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
  "zip-line",
  "raft",
  "trek",
  "safari",
  "garden",
  "park tour",
  "outdoor",
  "open-air",
  "open air",
  "climbing",
  "biking",
  "cycling",
  "horseback",
  "horse riding",
  "paragliding",
  "sunset",
  "sunrise",
  "walking tour",
];

const INDOOR_TERMS = [
  "museum",
  "gallery",
  "aquarium",
  "indoor",
  "cooking class",
  "workshop",
  "theatre",
  "theater",
  "concert",
  "opera",
  "exhibition",
  "escape room",
  "spa",
  "tasting",
  "winery",
  "brewery",
  "cooking",
  "art class",
  "pottery",
  "market tour",
  "food tour",
  "church",
  "cathedral",
  "palace",
  "monument",
];

export function tagActivitySetting(name: string, flags: string[] = []): ActivitySetting {
  const haystack = [name, ...flags].join(" ").toLowerCase();
  const indoor = INDOOR_TERMS.some((term) => haystack.includes(term));
  const outdoor = OUTDOOR_TERMS.some((term) => haystack.includes(term));
  if (outdoor) return "outdoor";
  if (indoor) return "indoor";
  return "unknown";
}

/**
 * Graceful-degradation probe for the primary Edge Function path: true when
 * the environment carries a Supabase URL + an auth key for the function.
 */
export function viatorEdgeConfigured(): boolean {
  const env = typeof process !== "undefined" ? process.env : undefined;
  return Boolean(
    env?.SUPABASE_URL && (env?.SUPABASE_SERVICE_ROLE_KEY || env?.SUPABASE_PUBLISHABLE_KEY),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Best-effort hero image from the raw Partner API `images` array
 * (images[].variants[].url) — undefined when nothing usable is present.
 */
function pickPartnerImage(images: unknown): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const first = images[0];
  const variants = isRecord(first) && Array.isArray(first.variants) ? first.variants : [];
  let picked: string | undefined;
  let pickedWidth = -1;
  for (const variant of variants) {
    if (!isRecord(variant) || typeof variant.url !== "string" || variant.url.length === 0) {
      continue;
    }
    const width = asFiniteNumber(variant.width) ?? 0;
    if (width > pickedWidth) {
      picked = variant.url;
      pickedWidth = width;
    }
  }
  return picked;
}

export class ViatorActivityProvider implements ActivityProvider {
  readonly providerName = "viator-edge";

  private readonly supabaseUrl: string | null;
  private readonly supabaseKey: string | null;
  private readonly viatorApiKey: string | null;
  private readonly viatorBase: string;
  private readonly timeoutMs: number;

  constructor(config: ViatorActivityProviderConfig = {}) {
    const env = typeof process !== "undefined" ? process.env : undefined;
    this.supabaseUrl = (config.supabaseUrl ?? env?.SUPABASE_URL ?? "").replace(/\/+$/, "") || null;
    this.supabaseKey =
      config.supabaseKey ?? env?.SUPABASE_SERVICE_ROLE_KEY ?? env?.SUPABASE_PUBLISHABLE_KEY ?? null;
    this.viatorApiKey = config.viatorApiKey ?? env?.VIATOR_API_KEY ?? null;
    this.viatorBase = (config.viatorBase ?? env?.VIATOR_API_BASE ?? DEFAULT_VIATOR_BASE).replace(
      /\/+$/,
      "",
    );
    const timeoutMs = config.timeoutMs ?? Number(env?.VIATOR_TIMEOUT_MS);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  async searchActivities(query: ActivitySearchQuery): Promise<ActivitySearchResult> {
    const empty: ActivitySearchResult = { query: query.query, options: [], degraded: true };
    if (query.query.trim().length === 0) {
      return { query: query.query, options: [], degraded: false };
    }

    // Primary path: the viator-activities Edge Function (spec §2.2).
    if (this.supabaseUrl && this.supabaseKey) {
      try {
        const body = await this.post(
          `${this.supabaseUrl}/functions/v1/viator-activities`,
          {
            query: query.query,
            ...(query.location ? { location: query.location } : {}),
            ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
            ...(query.dateTo ? { dateTo: query.dateTo } : {}),
            currency: query.currency ?? "USD",
            count: Math.min(MAX_COUNT, Math.max(1, Math.trunc(query.count ?? 4))),
          },
          {
            Authorization: `Bearer ${this.supabaseKey}`,
            apikey: this.supabaseKey,
            "Content-Type": "application/json",
          },
        );
        if (isRecord(body) && Array.isArray(body.products)) {
          const options = body.products
            .map((raw): ActivityOption | null => this.mapEdgeProduct(raw, query.currency ?? "USD"))
            .filter((option): option is ActivityOption => option !== null);
          return {
            query: query.query,
            options: this.applyPreference(options, query),
            degraded: false,
          };
        }
      } catch {
        // Fall through to the direct degraded path below.
      }
    }

    // Degraded direct path: single free-text search against the Partner API.
    if (this.viatorApiKey) {
      try {
        const body = await this.post(
          `${this.viatorBase}/search/freetext`,
          {
            searchTerm: query.location ? `${query.query} ${query.location}` : query.query,
            searchTypes: [
              {
                searchType: "PRODUCTS",
                pagination: {
                  start: 1,
                  count: Math.min(MAX_COUNT, Math.max(1, Math.trunc(query.count ?? 4))),
                },
              },
            ],
            currency: query.currency ?? "USD",
          },
          {
            "exp-api-key": this.viatorApiKey,
            Accept: "application/json;version=2.0",
            "Accept-Language": "en-US",
            "Content-Type": "application/json",
          },
        );
        const results =
          isRecord(body) && isRecord(body.products) && Array.isArray(body.products.results)
            ? body.products.results
            : null;
        if (!results) return empty;
        const options = results
          .map((raw): ActivityOption | null => this.mapPartnerProduct(raw, query.currency ?? "USD"))
          .filter((option): option is ActivityOption => option !== null);
        return {
          query: query.query,
          options: this.applyPreference(options, query),
          degraded: false,
        };
      } catch {
        return empty;
      }
    }

    return empty;
  }

  // ---------------------------------------------------------------- internals

  /** Map one normalized product from the Edge Function payload. */
  private mapEdgeProduct(raw: unknown, fallbackCurrency: string): ActivityOption | null {
    if (!isRecord(raw)) return null;
    const productCode = typeof raw.productCode === "string" ? raw.productCode : "";
    const title = typeof raw.title === "string" ? raw.title : "";
    if (!productCode || !title) return null;
    const flags = Array.isArray(raw.flags)
      ? raw.flags.filter((flag): flag is string => typeof flag === "string")
      : [];
    const option: ActivityOption = {
      id: productCode,
      name: title,
      url: typeof raw.url === "string" && raw.url.length > 0 ? raw.url : undefined,
      price: Math.max(0, asFiniteNumber(raw.priceFrom) ?? 0),
      currency:
        typeof raw.currency === "string" && raw.currency.length > 0
          ? raw.currency
          : fallbackCurrency,
      durationMinutes: asFiniteNumber(raw.durationMinutes) ?? undefined,
      setting: tagActivitySetting(title, flags),
      // Additive media (the viator-activities Edge Function already
      // normalizes `image` + `rating` onto each product).
      image: typeof raw.image === "string" && raw.image.length > 0 ? raw.image : undefined,
      rating: asFiniteNumber(raw.rating) ?? undefined,
    };
    return option;
  }

  /** Map one raw product from the Viator Partner API (degraded direct path). */
  private mapPartnerProduct(raw: unknown, fallbackCurrency: string): ActivityOption | null {
    if (!isRecord(raw)) return null;
    const productCode = typeof raw.productCode === "string" ? raw.productCode : "";
    const title = typeof raw.title === "string" ? raw.title : "";
    if (!productCode || !title) return null;
    const pricing = isRecord(raw.pricing) ? raw.pricing : null;
    const summary = pricing && isRecord(pricing.summary) ? pricing.summary : null;
    const reviews = isRecord(raw.reviews) ? raw.reviews : null;
    const flags = Array.isArray(raw.flags)
      ? raw.flags.filter((flag): flag is string => typeof flag === "string")
      : [];
    const duration = isRecord(raw.duration) ? raw.duration : null;
    return {
      id: productCode,
      name: title,
      url:
        typeof raw.productUrl === "string" && raw.productUrl.length > 0
          ? raw.productUrl
          : undefined,
      price: Math.max(0, asFiniteNumber(summary?.fromPrice) ?? 0),
      currency:
        pricing && typeof pricing.currency === "string" && pricing.currency.length > 0
          ? pricing.currency
          : fallbackCurrency,
      durationMinutes: asFiniteNumber(duration?.fixedDurationInMinutes) ?? undefined,
      setting: tagActivitySetting(title, flags),
      // Additive media, best-effort from the raw Partner API shape.
      image: pickPartnerImage(raw.images),
      rating: asFiniteNumber(reviews?.combinedAverageRating) ?? undefined,
    };
  }

  /** Keep only options matching the requested setting preference (if any). */
  private applyPreference(options: ActivityOption[], query: ActivitySearchQuery): ActivityOption[] {
    const preference = query.settingPreference ?? "any";
    if (preference === "any") return options;
    const filtered = options.filter((option) => option.setting === preference);
    // Never starve the agent: an unmatched preference still yields the full
    // list so the caller can decide (tagging is heuristic by nature).
    return filtered.length > 0 ? filtered : options;
  }

  /** fetch POST gateway with timeout; every failure throws (caught upstream). */
  private async post(
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    } as RequestInit);
    if (!response.ok) {
      throw new Error(`Viator upstream responded ${response.status}`);
    }
    return await response.json();
  }
}
