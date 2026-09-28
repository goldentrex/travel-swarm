/**
 * The swarm's EDGES, against the live Worker — everything the 7-scenario
 * battery does not touch.
 *
 * The battery answers "do the seven missions still produce sane plans". This
 * answers the other half: what happens to a sentence the engine should refuse,
 * a traveller who does not write in English, and the two flight problems that
 * are not a delay. Every one of these was broken on 2026-09-18 — "my suitcase
 * didn'''t arrive" came back as three flight rebookings at 2,306,617 IDR, and
 * six of nine French, Spanish and German sentences were refused outright.
 *
 *   node scripts/swarm-sim/verify-boundaries.mjs
 *
 * Reads .env.local for SUPABASE_SERVICE_ROLE_KEY and SWARM_DEMO_TOKEN, signs
 * in as the QA account, and spends one assess call per case. No settlement,
 * no writes.
 */
import { readFileSync } from "node:fs";
const U = "https://swlhcemlqaqnrmyguflx.supabase.co";
const W = "https://swarm.globeplanner.app/api/hackathon";
const env = {};
for (const f of [".env.local", ".env"]) { try { for (const l of readFileSync(f, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} }
const SK = env.SUPABASE_SERVICE_ROLE_KEY, ANON = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY, DEMO = env.SWARM_DEMO_TOKEN;
const EMAIL = "victor.gaya@icloud.com";
const g = await (await fetch(`${U}/auth/v1/admin/generate_link`, { method: "POST", headers: { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: "magiclink", email: EMAIL }) })).json();
const v = await (await fetch(`${U}/auth/v1/verify`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ type: "magiclink", token: g.properties?.email_otp ?? g.email_otp, email: EMAIL }) })).json();
const T = v.access_token;
// Shape, not position: the corpus now carries a one-stop ticket (#7, via
// Doha), and an unordered `trips[3]` was whichever row came back fourth.
// The edge cases run on a trip with NO change of planes — that is what
// "honestly reported absent" tests — and the connection itself is checked
// on the trip that has one.
const rows = await (await fetch(`${U}/rest/v1/trips?select=id,title,content_json&title=like.%5BQA-SIM%5D*&order=created_at.asc`, { headers: { apikey: ANON, Authorization: `Bearer ${T}` } })).json();
const hasStop = (t) => (t.content_json?.transit_groups ?? []).some((l) => (l.method ?? "").toLowerCase() === "flight" && Array.isArray(l.segments) && l.segments.length >= 2);
const trips = rows.filter((t) => !hasStop(t));
const stopTrip = rows.find(hasStop) ?? null;
const api = (p, i = {}) => fetch(`${W}${p}`, { ...i, headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEMO}`, "X-Swarm-User-Token": T, ...(i.headers ?? {}) } });

/** Each case: the sentence, and what must come back. */
const CASES = [
  // The scope boundary — accepting these is how a lost suitcase became €135.
  ["REFUSED", "help", "out_of_scope"],
  ["REFUSED", "what's the wifi password at my hotel", "out_of_scope"],
  ["REFUSED", "my suitcase didn't arrive", "out_of_scope"],
  ["REFUSED", "I want to add a day in Ubud", "out_of_scope"],
  ["REFUSED", "tell me a joke", "out_of_scope"],
  ["REFUSED", "j'ai perdu mon passeport", "out_of_scope"],
  // The five shipped languages, on branches that only spoke English.
  ["ACCEPTED", "mon hôtel est surbooké", null],
  ["ACCEPTED", "mi hotel está sobrevendido", null],
  ["ACCEPTED", "mein Hotel ist überbucht", null],
  ["ACCEPTED", "mon activité a été annulée", null],
  ["ACCEPTED", "je ne me sens pas bien, allège ma journée", null],
  ["ACCEPTED", "il va pleuvoir demain, adapte mes plans", null],
  ["ACCEPTED", "il y a une grève des transports demain", null],
  ["ACCEPTED", "mon taxi pour l'aéroport est annulé", null],
  ["ACCEPTED", "j'ai raté mon vol", null],
  // A stated new departure is a fact; an earlier one is out of reach.
  ["ACCEPTED", "the airline rescheduled my flight to 18:40", null],
  // Trip-dependent by nature: this corpus books TR288 at 00:35, so 6am is
  // genuinely LATER and "moved later" is the right answer. The EARLIER path is
  // pinned by a unit test, which controls the booked time.
  ["ACCEPTED", "the airline moved my flight to 6am, that's impossible", null],
  // A connection is honestly reported absent on a trip that has none…
  ["REFUSED", "my connection is too tight, I'll never make the second flight", "no_connection_found"],
  // A flight genuinely cancelled must still reach the flight rail.
  ["ACCEPTED", "my flight is cancelled because of an ATC strike", null],
];

/** …and judged on the trip that has one — in three languages, naming the
 *  stop, so the sentence has to find the change INSIDE the ticket. */
const CONNECTION_CASES = [
  ["ACCEPTED", "my connection in Doha is too tight, I'll never make the second flight", null],
  ["ACCEPTED", "ma correspondance à Doha est trop courte", null],
  ["ACCEPTED", "mi conexión en Doha es demasiado corta", null],
];

const trip = trips[Math.min(3, trips.length - 1)];
console.log(`trip: ${trip.title}\n`);
let pass = 0, fail = 0;
async function runCase(tripId, [expect, intent, code]) {
  const r = await api("/mission/assess", { method: "POST", body: JSON.stringify({ intent, tripId, language: "en" }) });
  const b = await r.json();
  const got = r.status === 200 ? "ACCEPTED" : "REFUSED";
  const codeOk = expect === "ACCEPTED" || !code || b.error === code;
  const ok = got === expect && codeOk;
  ok ? pass++ : fail++;
  const label = intent.length > 50 ? intent.slice(0, 47) + "..." : intent;
  console.log(`${ok ? "  ok " : "FAIL"}  ${label.padEnd(52)} ${got.padEnd(9)} ${b.error ?? ""}`);
}
for (const c of CASES) await runCase(trip.id, c);
if (stopTrip) {
  console.log(`\ntrip with a stop: ${stopTrip.title}\n`);
  for (const c of CONNECTION_CASES) await runCase(stopTrip.id, c);
} else {
  console.log("\n(no QA-SIM trip with a stop — generate corpus #7 to cover the connection itself)");
}
console.log(`\n${pass} as intended, ${fail} not.`);
process.exit(fail ? 1 : 0);
