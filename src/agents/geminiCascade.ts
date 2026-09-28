/**
 * Which Gemini model to ask, and what to ask next when that one is out.
 *
 * Shared by every Gemini-backed agent so the ladder can never drift between
 * them. Two things drive the order, both measured on the project's real quota
 * dashboard (2026-09-01):
 *
 *   model                  RPM    RPD     observed
 *   gemini-3.7-flash        5      20     4/5,  12/20   capable, tiny daily cap
 *                                                 (NOT ours — generation owns the flash pool)
 *   gemini-3.5-flash-lite  15     500     2/500         barely touched
 *   gemini-3.1-flash-lite  15     500     70/500        plenty of headroom
 *   gemini-3.6-flash        5      20     5/5,  32/20   EXHAUSTED
 *   gemini-3.5-flash        5      20     6/5,  30/20   EXHAUSTED
 *
 * The `-flash` tiers allow **20 requests per day**. A swarm mission spends two
 * Gemini calls, so a single tier covers roughly ten missions before every
 * later one degrades to the deterministic rail. The `-lite` tiers allow 500 —
 * 25× the headroom — which is what makes the intelligence layer actually
 * available rather than nominally present. So the ladder leads with the most
 * capable model and falls to lite tiers that keep working.
 *
 * Exhausted models are REMEMBERED. Re-probing a model that just answered 429
 * spends a call, and the latency, to learn what we already knew; a cooling
 * model is skipped until its window is likely to have rolled over.
 */

/**
 * Ordered by capability; every entry after the first is a working fallback.
 *
 * ALL LITE, DELIBERATELY. This used to open on `gemini-3.7-flash`, a tier with
 * twenty requests A DAY, which is also the tier trip generation depends on.
 * On 2026-09-19 a run of 56 swarm missions emptied that pool and the app could
 * not generate a trip for the rest of the day: the cheapest rail in the
 * product had starved the most expensive one.
 *
 * The swarm does not need a flagship. Its three model tasks — translating
 * trade-off answers, resequencing a day, reviewing a plan for nonsense — all
 * have a deterministic rail behind them, and every one of them degrades
 * safely. So it lives entirely on the lite tiers, whose allowance is 500 a
 * day EACH, and leaves the flash pool to the one call a traveller waits on.
 */
export const GEMINI_MODEL_CASCADE = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
] as const;

/** First cooldown after a 429. An RPM ceiling clears well inside this. */
const COOLDOWN_BASE_MS = 5 * 60_000;
/** Ceiling. A daily (RPD) ceiling only clears at midnight Pacific, but probing
 *  once an hour costs one call and keeps the model usable the moment it frees. */
const COOLDOWN_MAX_MS = 60 * 60_000;

interface Cooling {
  until: number;
  /** Consecutive exhaustions — each one doubles the wait, up to the ceiling. */
  strikes: number;
}

/** Module state: in a Worker isolate this survives between requests, which is
 *  exactly the point — the knowledge is worth more than one mission. */
const cooling = new Map<string, Cooling>();

/** Record that `model` answered 429/503 (out of capacity or quota). */
export function noteModelExhausted(model: string, now: number = Date.now()): void {
  const previous = cooling.get(model);
  const strikes = Math.min((previous?.strikes ?? 0) + 1, 4);
  const wait = Math.min(COOLDOWN_BASE_MS * 2 ** (strikes - 1), COOLDOWN_MAX_MS);
  cooling.set(model, { until: now + wait, strikes });
}

/** Record that `model` answered normally — it is healthy again. */
export function noteModelHealthy(model: string): void {
  cooling.delete(model);
}

function isCooling(model: string, now: number): boolean {
  const entry = cooling.get(model);
  if (!entry) return false;
  if (entry.until <= now) {
    // The window rolled over: let it be tried again, but keep the strike count
    // so a still-exhausted model backs off faster the next time.
    cooling.set(model, { ...entry, until: 0 });
    return false;
  }
  return true;
}

/**
 * The models to try, in order, for one exchange.
 *
 * `preferred` (a caller's explicit `model` config) always leads, so an override
 * is honoured. Models known to be cooling are moved to the BACK rather than
 * dropped — if every model is cooling we still try, because a stale cooldown
 * must never turn into "no LLM at all".
 */
export function modelLadder(preferred?: string, now: number = Date.now()): string[] {
  const ordered: string[] = [];
  if (preferred && preferred.trim().length > 0) ordered.push(preferred.trim());
  for (const model of GEMINI_MODEL_CASCADE) {
    if (!ordered.includes(model)) ordered.push(model);
  }
  const ready = ordered.filter((m) => !isCooling(m, now));
  const resting = ordered.filter((m) => isCooling(m, now));
  return [...ready, ...resting];
}

/** Test seam: forget every recorded cooldown. */
export function resetModelCooldowns(): void {
  cooling.clear();
}
