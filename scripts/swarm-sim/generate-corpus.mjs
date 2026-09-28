/**
 * Build the QA trip corpus the live swarm battery runs against.
 *
 * The battery used to run on whatever trips happened to be on the test
 * account. That measures the swarm against an arbitrary sample: a handful of
 * easy European city breaks prove nothing about a replacement that lands the
 * next day, and nothing at all about a route the provider does not cover.
 *
 * These six trips are chosen to HURT, each for a named reason (see CORPUS).
 * Together they cover the shapes that have actually produced defects: a
 * next-day arrival, a border-free Schengen hop, a post-midnight red-eye, a
 * multi-city chain, a non-EUR currency, and a route the Atlas sandbox is known
 * to have no data for — where "we found nothing, honestly" is the CORRECT
 * answer and the thing being tested.
 *
 * Every trip is titled `[QA-SIM] …` so the battery can find exactly these and
 * `--purge` can remove exactly these, and nothing of the traveller's own.
 *
 * Usage:
 *   node scripts/swarm-sim/generate-corpus.mjs            # generate + persist
 *   node scripts/swarm-sim/generate-corpus.mjs --dry-run  # print, persist nothing
 *   node scripts/swarm-sim/generate-corpus.mjs --purge    # delete the QA trips
 *   node scripts/swarm-sim/generate-corpus.mjs --only 1,5 # just those entries
 *
 * Requires .env.local: SUPABASE_SERVICE_ROLE_KEY.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUPABASE_URL = "https://swlhcemlqaqnrmyguflx.supabase.co";
const TEST_USER = "c4fb4880-37d6-4a10-ab5d-cdaab5b72df7";
const TEST_EMAIL = "victor.gaya@icloud.com";
/** Every trip this script creates carries it; nothing else is ever touched. */
export const QA_PREFIX = "[QA-SIM]";

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
const SERVICE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const PURGE = args.includes("--purge");
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const ONLY = (argOf("only") ?? "").split(",").filter(Boolean).map(Number);

// ------------------------------------------------------------------- corpus

/**
 * `why` is not decoration: it is what the run report cites when a trip
 * produces a defect, so a finding is always traceable to the shape that was
 * being probed rather than to "one of the trips".
 */
const CORPUS = [
  {
    id: 1,
    why: "Next-day arrival: SIN→NRT in November. Narita is 75 min from town and the arrival is international, so a replacement that slips a day costs a booked night and a full day of plans.",
    prompt:
      "A 6-day trip to Tokyo departing Singapore on 5 November 2026 and returning 11 November. " +
      "Fly Singapore to Tokyo Narita. Stay in Shinjuku. Day 1 arrives in the evening. " +
      "Pack the days: Meiji Jingu shrine, teamLab, Senso-ji temple, a sushi dinner reservation, " +
      "Shinjuku Gyoen garden, and an airport transfer booked from Narita to the hotel.",
    preferences: { budgetTier: "standard", cabinClass: "Economy" },
  },
  {
    id: 2,
    why: "Atlas-covered long haul with immigration: SIN→LHR answers on the sandbox, so this measures DECISION quality rather than coverage.",
    prompt:
      "A 5-day trip to London departing Singapore on 12 November 2026, returning 17 November. " +
      "Stay in Covent Garden. Include a British Museum visit, a West End show with a fixed start time, " +
      "a Tower of London timed ticket, and a booked car transfer from Heathrow.",
    preferences: { budgetTier: "standard", cabinClass: "Economy" },
  },
  {
    id: 3,
    why: "Schengen hop: CDG→FCO crosses no border, so the realistic arrival buffer is shorter. Tests that the engine does NOT pad an internal flight like an international one.",
    prompt:
      "A 4-day trip to Rome departing Paris on 20 November 2026, returning 24 November. " +
      "Stay near Campo de' Fiori. Include the Vatican Museums with a timed entry, " +
      "Galleria Borghese (which requires a reserved slot), a lunch booking, and an airport transfer from Fiumicino.",
    preferences: { budgetTier: "standard", cabinClass: "Economy" },
  },
  {
    id: 4,
    why: "Red-eye: a post-midnight departure materializes its own day and there is no hotel that night. Tests the overnight layer against a disruption.",
    prompt:
      "A 4-day trip to Bali departing Singapore just after midnight on 2 December 2026, returning 6 December. " +
      "Stay in Seminyak. Include a sunrise volcano hike that starts very early, a temple visit, " +
      "a beach club afternoon and a booked airport pickup at Denpasar.",
    preferences: { budgetTier: "standard", cabinClass: "Economy" },
  },
  {
    id: 5,
    why: "KNOWN Atlas gap: SIN→FCO returns zero routings on every date. The correct answer here is an honest 'route not covered', naming the partner only with proof. A confident wrong flight would be the real failure.",
    prompt:
      "A 5-day trip to Rome departing Singapore on 9 December 2026, returning 14 December. " +
      "Fly Singapore to Rome Fiumicino. Stay in Trastevere. Include the Colosseum with a timed ticket, " +
      "a Vatican tour, a trattoria dinner booking and an airport transfer.",
    preferences: { budgetTier: "standard", cabinClass: "Economy" },
  },
  {
    id: 6,
    why: "Multi-city in JPY: Tokyo→Osaka→Kyoto chains internal transfers, so one late arrival cascades through several cities and a non-EUR ledger.",
    prompt:
      "A 7-day trip through Japan departing Singapore on 15 January 2027. " +
      "Three nights Tokyo, two nights Osaka, two nights Kyoto, moving by shinkansen between them. " +
      "Include a Tsukiji breakfast, Osaka Castle, Fushimi Inari at Kyoto, a kaiseki dinner reservation, " +
      "and booked transfers between each city.",
    preferences: { budgetTier: "standard", cabinClass: "Economy" },
  },
  {
    id: 7,
    why: "Through-ticket connection: one leg, two hops. A change of planes that lives INSIDE a transit leg (segments), not between two legs — the shape every one-stop ticket has, and the one the connection check could not see. Two stops (out and back) so the question 'my connection at Doha' has to pick the right one.",
    prompt:
      "A 5-day trip to Rome departing Singapore on 3 December 2026, returning 8 December. " +
      "Fly Singapore to Rome Fiumicino on Qatar Airways with a connection in Doha in BOTH directions — " +
      "not a non-stop flight; give the two flight segments of each journey with their own flight numbers and times. " +
      "Stay in Monti. Include the Colosseum with a timed ticket, a Vatican Museums slot, " +
      "a trattoria dinner booking and a booked airport transfer from Fiumicino.",
    preferences: { budgetTier: "standard", cabinClass: "Economy" },
  },
];

// ----------------------------------------------------------------- plumbing

async function supabase(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Mint a session for the test account WITHOUT its password (same rail as the
 *  battery): the admin API issues a magic-link OTP, `verify` exchanges it. */
async function signInAsTestUser() {
  const admin = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", email: TEST_EMAIL }),
  });
  if (!admin.ok) throw new Error(`generate_link failed: ${admin.status} ${await admin.text()}`);
  const link = await admin.json();
  const otp = link?.email_otp ?? link?.properties?.email_otp;
  if (!otp) throw new Error("generate_link returned no email_otp");
  const verify = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token: otp, email: TEST_EMAIL }),
  });
  if (!verify.ok) throw new Error(`verify failed: ${verify.status} ${await verify.text()}`);
  const session = await verify.json();
  if (!session?.access_token) throw new Error("verify returned no access_token");
  return session.access_token;
}

const pickText = (value, lang = "en") =>
  typeof value === "string" ? value : (value?.[lang] ?? value?.en ?? Object.values(value ?? {})[0] ?? "");

/**
 * One generation. `generate-trip` owns the most capable Gemini tier and is
 * slow by design (up to ~140 s), so the deadline here is generous and a
 * timeout is reported rather than retried — a silent retry would spend a
 * second request out of that tier's 20-per-day allowance.
 */
async function generateTrip(userToken, entry) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-trip`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: entry.prompt, preferences: entry.preferences, lang: "en" }),
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    const body = JSON.parse(text);
    const trip = body?.trip ?? body;
    if (!trip?.title || !trip?.itinerary) {
      return { error: `no trip in response: ${text.slice(0, 300)}` };
    }
    return { trip };
  } catch (error) {
    return { error: error?.name === "AbortError" ? "timeout after 180s" : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** What the battery needs to know about a trip before it disrupts it. */
function shapeOf(trip) {
  const legs = trip.transit_groups ?? [];
  const flights = legs.filter((l) => (l.method ?? "").toLowerCase() === "flight");
  const days = trip.itinerary ?? [];
  const items = days.flatMap((d) => d.items ?? []);
  return {
    days: days.length,
    flights: flights.length,
    firstFlight: flights[0]
      ? `${flights[0].origin?.code ?? "?"}→${flights[0].destination?.code ?? "?"} ${flights[0].depart ?? ""}`
      : null,
    stays: items.filter((i) => i.type === "stay").length,
    activities: items.filter((i) => i.type === "activity").length,
    dining: items.filter((i) => i.type === "dining").length,
    transfers: legs.length - flights.length,
    currency: trip.local_currency_code ?? null,
  };
}

// --------------------------------------------------------------------- main

async function purge() {
  const rows = await supabase(
    `trips?user_id=eq.${TEST_USER}&title=like.${encodeURIComponent(`${QA_PREFIX}%`)}&select=id,title`,
  );
  if (!rows?.length) {
    console.log("Nothing to purge — no QA-SIM trips on the account.");
    return;
  }
  console.log(`Deleting ${rows.length} QA-SIM trip(s):`);
  for (const row of rows) console.log(`  - ${row.title}`);
  await supabase(
    `trips?user_id=eq.${TEST_USER}&title=like.${encodeURIComponent(`${QA_PREFIX}%`)}`,
    { method: "DELETE" },
  );
  console.log("Done. The traveller's own trips were never in scope of this query.");
}

async function main() {
  if (PURGE) return purge();

  const entries = ONLY.length ? CORPUS.filter((e) => ONLY.includes(e.id)) : CORPUS;
  console.log(`Corpus: ${entries.length} trip(s) to generate.\n`);

  console.log("Signing in as the test account (admin magic-link, no password)…");
  const userToken = await signInAsTestUser();
  console.log("  session acquired\n");

  const made = [];
  for (const entry of entries) {
    const label = `#${entry.id}`;
    process.stdout.write(`[${label}] generating… `);
    const started = Date.now();
    const { trip, error } = await generateTrip(userToken, entry);
    const secs = Math.round((Date.now() - started) / 1000);
    if (error) {
      console.log(`FAILED after ${secs}s — ${error}`);
      made.push({ id: entry.id, why: entry.why, error });
      continue;
    }
    const title = `${QA_PREFIX} ${pickText(trip.title)}`;
    const shape = shapeOf(trip);
    console.log(
      `${secs}s · ${shape.days}d · ${shape.flights} flight(s) · ${shape.activities} activities · ${shape.currency ?? "?"}`,
    );
    console.log(`        ${shape.firstFlight ?? "no flight leg"}`);

    if (DRY_RUN) {
      made.push({ id: entry.id, why: entry.why, title, shape, persisted: false });
      continue;
    }
    // The stored title carries the QA prefix so the battery selects exactly
    // these and the purge removes exactly these.
    const stored = { ...trip, title: { ...(typeof trip.title === "object" ? trip.title : {}), en: title } };
    const inserted = await supabase("trips?select=id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: TEST_USER,
        title,
        destination: pickText(trip.destination),
        content_json: stored,
        total_budget_eur: trip.totalBudgetEur ?? 0,
      }),
    });
    const tripId = inserted?.[0]?.id;
    console.log(`        stored as ${tripId}`);
    made.push({ id: entry.id, why: entry.why, title, tripId, shape, persisted: true });
  }

  const outDir = join(ROOT, "scripts", "swarm-sim", "runs");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `corpus-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), trips: made }, null, 2));
  console.log(`\nCorpus manifest → ${outPath}`);

  const ok = made.filter((m) => !m.error).length;
  console.log(`${ok}/${made.length} generated${DRY_RUN ? " (dry run — nothing stored)" : ""}.`);
  if (ok < made.length) {
    console.log("Failures are reported, never retried: a second call spends another");
    console.log("request out of the flagship tier's 20-per-day allowance.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
