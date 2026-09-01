/**
 * Live reachability probes for `/api/hackathon/health`.
 *
 * The health snapshot used to answer only "are the env vars present?" —
 * `activityConfigured` was literally `Boolean(SUPABASE_URL && SUPABASE_KEY)`.
 * That says nothing about whether the upstream actually answers, so a health
 * check stayed green through a deleted Edge Function, a rotated key, a DNS
 * change or an upstream outage. This module adds the missing half.
 *
 * Two crisp booleans per provider, never one blurred one:
 *   • `reachable`  — the host answered over HTTPS within the timeout (ANY HTTP
 *                    status counts). Proves DNS + TLS + routing.
 *   • `authorized` — that answer was not 401/403. Proves the credentials are
 *                    accepted. Only meaningful when `reachable`.
 *
 * Both are OMITTED when the provider is not configured: "we never probed" and
 * "we probed and it failed" are different facts, and a `false` would conflate
 * them.
 *
 * Cost discipline: every probe is a GET against an endpoint that does no
 * billable work — never a fare search, never a product search. A health
 * endpoint is polled, so results are cached briefly (see CACHE_TTL_MS) to keep
 * it from becoming a DoS amplifier pointed at our own upstreams, and every
 * probe is hard-bounded by PROBE_TIMEOUT_MS so the endpoint stays fast even
 * when an upstream is black-holing traffic.
 */

/** Hard ceiling per probe. Health must answer fast even when upstreams hang. */
const PROBE_TIMEOUT_MS = 2_500;

/** Probe results are reused for this long — health endpoints get polled. */
const CACHE_TTL_MS = 30_000;

export interface ReachabilityVerdict {
  /** The host answered within the timeout (any HTTP status). */
  reachable: boolean;
  /** The answer was not an auth rejection. Undefined when unreachable. */
  authorized?: boolean;
}

interface CacheEntry {
  at: number;
  verdict: ReachabilityVerdict;
}

const cache = new Map<string, CacheEntry>();

/** Test seam — drops memoised verdicts so probes re-run. */
export function __resetReachabilityCache(): void {
  cache.clear();
}

function env(): NodeJS.ProcessEnv | undefined {
  return typeof process !== "undefined" ? process.env : undefined;
}

interface ProbeSpec {
  key: string;
  url: string;
  headers: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  /**
   * Whether this endpoint actually REJECTS bad credentials. Only set it when
   * that has been verified against the live endpoint: the `viator-activities`
   * Edge Function answers 200 to a valid key, a wrong key and no key alike, so
   * deriving `authorized` from its status would report "credentials fine" for
   * a rotated key — the precise false reassurance this module exists to kill.
   */
  discriminatesAuth: boolean;
  /**
   * Whether a 404 means "this thing is gone". True for a specific endpoint
   * (a deleted Edge Function), false for a host root, where 404 merely means
   * the root is not a route but the host is plainly answering.
   */
  notFoundMeansMissing: boolean;
}

/**
 * One HTTP probe. Resolves to a verdict and NEVER throws or rejects — a health
 * endpoint must not 500 because an upstream is down; that is the very
 * condition it exists to report.
 */
async function probe(spec: ProbeSpec): Promise<ReachabilityVerdict> {
  const now = Date.now();
  const hit = cache.get(spec.key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.verdict;

  let verdict: ReachabilityVerdict;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(spec.url, {
      method: spec.method ?? "GET",
      headers: spec.headers,
      ...(spec.body === undefined ? {} : { body: spec.body }),
      signal: controller.signal,
    });
    if (spec.notFoundMeansMissing && response.status === 404) {
      // The host answered, but the thing we depend on is not there — a
      // deleted Edge Function is exactly the outage worth catching, and
      // calling it "reachable" would hide it.
      console.warn(`[swarm-health] ${spec.key} is not deployed (404).`);
      verdict = { reachable: false };
    } else {
      verdict = {
        // Any other status proves the host answered — 400/405 included, which
        // an endpoint legitimately returns for a probe-shaped request.
        reachable: true,
        ...(spec.discriminatesAuth
          ? { authorized: response.status !== 401 && response.status !== 403 }
          : {}),
      };
    }
  } catch (error) {
    // Abort (timeout), DNS failure, TLS failure, connection refused.
    console.warn(`[swarm-health] ${spec.key} probe failed:`, error);
    verdict = { reachable: false };
  } finally {
    clearTimeout(timer);
  }

  cache.set(spec.key, { at: now, verdict });
  return verdict;
}

/**
 * Atlas: GET the sandbox base URL. Every real Atlas endpoint is a POST that
 * does billable work, so the probe deliberately targets the host root — it
 * proves the sandbox answers without spending a fare-search credit. Atlas
 * authenticates per-request with custom headers rather than on the root, so
 * `authorized` here reflects only that the root was not gated.
 */
export async function probeAtlasReachable(): Promise<ReachabilityVerdict | null> {
  const e = env();
  if (!e?.ATLAS_API_KEY) return null;
  const base = e.ATLAS_SANDBOX_URL ?? e.ATLAS_BASE_URL ?? "https://sandbox.atriptech.com";
  return probe({
    key: "atlas",
    url: base.replace(/\/+$/, "") + "/",
    headers: { Accept: "*/*" },
    // Atlas authenticates per-request on its POST endpoints, not on the root,
    // so the root's status says nothing about our credentials.
    discriminatesAuth: false,
    notFoundMeansMissing: false,
  });
}

/**
 * RapidAPI hotels: GET the configured host root WITH the key headers. RapidAPI
 * answers 401/403 for a bad or revoked key before the upstream API is touched,
 * so this proves the subscription is live without consuming a search call.
 */
export async function probeHotelReachable(): Promise<ReachabilityVerdict | null> {
  const e = env();
  if (!e?.RAPIDAPI_KEY || !e?.RAPIDAPI_HOST) return null;
  return probe({
    key: "hotel",
    url: `https://${e.RAPIDAPI_HOST}/`,
    headers: {
      "x-rapidapi-key": e.RAPIDAPI_KEY,
      "x-rapidapi-host": e.RAPIDAPI_HOST,
      Accept: "application/json",
    },
    // RapidAPI's gateway rejects a bad or unsubscribed key with 401/403
    // before the upstream API is reached.
    discriminatesAuth: true,
    notFoundMeansMissing: false,
  });
}

/**
 * Viator: POST the `viator-activities` Supabase Edge Function with a body that
 * carries no searchable query. Verified against the live function: it
 * short-circuits on the missing query and answers in ~150 ms WITHOUT calling
 * the Viator Partner API, so the probe costs nothing upstream.
 *
 * POST, not GET, because that is the method the handler implements — and a
 * deleted function answers 404, which is the outage this probe exists to
 * catch.
 *
 * No `authorized` signal: the function answers 200 to a valid key, a wrong key
 * and no key alike (it does not verify the JWT), so any claim about
 * credentials here would be invented.
 */
export async function probeActivityReachable(): Promise<ReachabilityVerdict | null> {
  const e = env();
  const key = e?.SUPABASE_SERVICE_ROLE_KEY || e?.SUPABASE_PUBLISHABLE_KEY;
  if (!e?.SUPABASE_URL || !key) return null;
  return probe({
    key: "activity",
    url: `${e.SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/viator-activities`,
    method: "POST",
    body: JSON.stringify({ query: "", count: 1 }),
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    discriminatesAuth: false,
    notFoundMeansMissing: true,
  });
}
