/**
 * Did the swarm propose a flight a traveller would actually accept?
 *
 * The battery can prove a plan is feasible and self-consistent and still not
 * answer the only question the traveller cares about: is THIS the flight I
 * should be on? Answering it needs a second opinion from outside our own
 * stack — the real market, not the provider that produced the candidate.
 *
 * The comparator is the app's OWN `live-prices` function, which queries
 * Travelpayouts/Aviasales (`prices_for_dates`) for the cheapest cached real
 * fare on a route and date, with the airline and flight number that carries
 * it. Same source the timeline already uses to replace the AI's guesses, so
 * this measures the swarm against the number the traveller would see anyway.
 *
 * TWO VERDICTS, DELIBERATELY SEPARATE — conflating them is how a partner's
 * dataset gap gets logged as an engine bug:
 *
 *   DECISION  — given the candidates Atlas returned, did the swarm pick and
 *               explain well? A failure here is OURS.
 *   INVENTORY — does what Atlas returns resemble the real market at all? A
 *               gap here is the sandbox's (`docs/SPEC.md`: a partial test
 *               dataset, not a GDS), to be measured and reported, not fixed
 *               in our code.
 *
 * A missing comparator quote is never a failure of either: Travelpayouts
 * caches by route popularity, so a thin route simply has no number, and
 * `no_market_data` says exactly that instead of inventing a benchmark.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv() {
  const env = {};
  for (const file of [".env.local", ".env"]) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
const ENV = loadEnv();
const SUPABASE_URL = ENV.SUPABASE_URL ?? ENV.VITE_SUPABASE_URL ?? "https://swlhcemlqaqnrmyguflx.supabase.co";
const ANON = ENV.SUPABASE_PUBLISHABLE_KEY ?? ENV.VITE_SUPABASE_PUBLISHABLE_KEY;

/** Cheapest real fare for a route+date, or null when the comparator has none. */
export async function marketQuote({ origin, destination, departDate, pax = 1, currency = "EUR" }) {
  if (!ANON) return { error: "no_supabase_key" };
  if (!origin || !destination || !departDate) return { error: "incomplete_query" };
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/live-prices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON,
        Authorization: `Bearer ${ANON}`,
      },
      body: JSON.stringify({
        flights: [{ key: "q", origin, destination, departDate, pax }],
        hotels: [],
        currency,
      }),
    });
    if (!res.ok) return { error: `http_${res.status}` };
    const body = await res.json();
    const quote = body?.flights?.q ?? null;
    if (!quote || typeof quote.priceEur !== "number") return { quote: null };
    return { quote };
  } catch (error) {
    return { error: String(error).slice(0, 120) };
  }
}

/** ISO-8601 → YYYY-MM-DD, tolerant of the wire's several shapes. */
export function dateOf(iso) {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  return m ? m[1] : null;
}

/** Rough EUR conversion — the comparator answers in the currency we ask for,
 *  so this only ever bridges a plan quoted in something else. Rates are the
 *  app's own (src/lib/i18n/translations.ts) rather than a fresh guess. */
const EUR_PER = { EUR: 1, USD: 0.92, SGD: 0.69, GBP: 1.17, JPY: 0.0062, VND: 0.000037, AUD: 0.6 };
export function toEur(amount, currency) {
  const rate = EUR_PER[(currency ?? "EUR").toUpperCase()];
  return typeof amount === "number" && rate ? amount * rate : null;
}

/**
 * Compare ONE proposed replacement against the market.
 *
 * `plan` is a TrustLayer ResolutionPlan as the Worker returns it.
 */
export async function checkPlanAgainstMarket(plan, { currency = "EUR" } = {}) {
  const flight = plan?.proposed_resolution?.new_flight;
  if (!flight) return { verdict: "no_flight_proposed" };

  const origin = flight.origin;
  const destination = flight.destination;
  const departDate = dateOf(flight.departure);
  const { quote, error } = await marketQuote({ origin, destination, departDate, currency });
  if (error) return { verdict: "comparator_error", detail: error, origin, destination, departDate };
  if (!quote) {
    return {
      verdict: "no_market_data",
      detail: `${origin}→${destination} on ${departDate} is not in the comparator's cache`,
      origin,
      destination,
      departDate,
    };
  }

  // What the plan says this flight costs. `cost` is the ticket price; the
  // ledger's net payable is a DIFFERENT number (it nets off the old fare) and
  // must never be compared against a market ticket price.
  const planEur = toEur(flight.cost, flight.currency ?? plan.currency);
  const sameCarrier =
    typeof flight.flight_number === "string" &&
    typeof quote.flightNumber === "string" &&
    flight.flight_number.replace(/\s/g, "").toUpperCase() ===
      quote.flightNumber.replace(/\s/g, "").toUpperCase();

  const deltaPct =
    planEur !== null && quote.priceEur > 0
      ? Math.round(((planEur - quote.priceEur) / quote.priceEur) * 100)
      : null;

  let verdict;
  if (sameCarrier) verdict = "market_match";
  else if (deltaPct === null) verdict = "unpriced";
  else if (deltaPct <= 10) verdict = "market_competitive";
  else if (deltaPct <= 40) verdict = "market_worse";
  else verdict = "market_much_worse";

  return {
    verdict,
    origin,
    destination,
    departDate,
    plan: {
      flightNumber: flight.flight_number ?? null,
      airline: flight.airline ?? null,
      cost: flight.cost ?? null,
      currency: flight.currency ?? plan.currency ?? null,
      costEur: planEur,
      stops: flight.stops ?? null,
      durationMinutes: flight.durationMinutes ?? null,
      fareBasis: flight.fare_basis ?? null,
    },
    market: {
      flightNumber: quote.flightNumber ?? null,
      airline: quote.airline ?? null,
      priceEur: quote.priceEur,
    },
    sameCarrier,
    deltaPct,
  };
}

/**
 * Is this plan dominated by another on the SAME carousel — more expensive AND
 * later AND more stops? A dominated option should never have been offered,
 * whatever the market says: it is worse on every axis the traveller reads.
 */
export function dominatedPlans(plans) {
  const rows = (plans ?? [])
    .map((plan, index) => {
      const f = plan?.proposed_resolution?.new_flight;
      if (!f) return null;
      return {
        index,
        badge: plan.badge ?? null,
        eur: toEur(f.cost, f.currency ?? plan.currency),
        arrival: Date.parse(f.arrival ?? "") || null,
        stops: typeof f.stops === "number" ? f.stops : 0,
        label: f.flight_number ?? f.id,
      };
    })
    .filter((r) => r && r.eur !== null && r.arrival !== null);

  const out = [];
  for (const a of rows) {
    for (const b of rows) {
      if (a.index === b.index) continue;
      const worseOnAll =
        b.eur < a.eur && b.arrival < a.arrival && b.stops <= a.stops &&
        !(b.eur === a.eur && b.arrival === a.arrival && b.stops === a.stops);
      if (worseOnAll) {
        out.push({ plan: a.label, dominatedBy: b.label, badge: a.badge });
        break;
      }
    }
  }
  return out;
}

/** One line a human can read, for the run log. */
export function describe(check) {
  switch (check.verdict) {
    case "market_match":
      return `MARKET MATCH — the swarm picked ${check.plan.flightNumber}, the same flight the comparator names cheapest (€${check.market.priceEur})`;
    case "market_competitive":
      return `COMPETITIVE — ${check.plan.flightNumber} at €${Math.round(check.plan.costEur)} vs market cheapest ${check.market.flightNumber} €${check.market.priceEur} (${check.deltaPct >= 0 ? "+" : ""}${check.deltaPct}%)`;
    case "market_worse":
      return `WORSE — ${check.plan.flightNumber} at €${Math.round(check.plan.costEur)} is ${check.deltaPct}% over the market's ${check.market.flightNumber} (€${check.market.priceEur})`;
    case "market_much_worse":
      return `MUCH WORSE — ${check.plan.flightNumber} at €${Math.round(check.plan.costEur)} is ${check.deltaPct}% over the market's ${check.market.flightNumber} (€${check.market.priceEur})`;
    case "no_market_data":
      return `NO MARKET DATA — ${check.detail}`;
    case "comparator_error":
      return `COMPARATOR ERROR — ${check.detail}`;
    case "no_flight_proposed":
      return "NO FLIGHT — the plan offers no replacement (check the stated reason)";
    default:
      return `UNPRICED — ${check.plan?.flightNumber ?? "?"} carries no comparable fare`;
  }
}

// ------------------------------------------------------------------ CLI use

// `node market-check.mjs <sim-run.json>` re-grades a finished battery run
// against the market, without spending another swarm mission.
if (process.argv[1] && process.argv[1].endsWith("market-check.mjs")) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/swarm-sim/market-check.mjs <runs/sim-….json>");
    process.exit(1);
  }
  const runs = JSON.parse(readFileSync(path, "utf8"));
  const records = Array.isArray(runs) ? runs : (runs.results ?? []);
  const summary = { market_match: 0, market_competitive: 0, market_worse: 0, market_much_worse: 0, no_market_data: 0, other: 0 };
  console.log(`Market cross-check over ${records.length} mission(s)\n`);
  for (const record of records) {
    const plans = record.plans ?? (record.plan ? [record.plan] : []);
    if (!plans.length) continue;
    const check = await checkPlanAgainstMarket(plans[0]);
    summary[check.verdict in summary ? check.verdict : "other"] += 1;
    console.log(`${(record.scenario ?? "?").padEnd(18)} ${(record.tripTitle ?? "").slice(0, 34).padEnd(34)} ${describe(check)}`);
    const dominated = dominatedPlans(plans);
    for (const d of dominated) {
      console.log(`${"".padEnd(53)}  ↳ DOMINATED: ${d.plan} is worse than ${d.dominatedBy} on price, time AND stops`);
    }
  }
  console.log("\n" + JSON.stringify(summary));
}
