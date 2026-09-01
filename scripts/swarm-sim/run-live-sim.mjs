/**
 * Live swarm simulation harness.
 *
 * Runs the REAL rail — the deployed Worker, real Atlas / Booking.com / Viator /
 * OpenWeather / PredictHQ, real trips in Supabase — across a matrix of trips ×
 * mission scenarios, and grades every plan it gets back.
 *
 * Grading has two tiers, because a plan can be perfectly schema-valid and still
 * be useless to a traveler:
 *
 *   TIER 1 — feasibility. Hard violations, no indulgence: a replacement that
 *     departs before the flight you missed, money that does not add up, two
 *     currencies in one panel, an activity moved to 03:00, a plan that hides
 *     the fact that nothing was found.
 *
 *   TIER 2 — practicality. Recorded as SIGNALS for judgement (proportionality
 *     of a move, day-load after a move, whether the swarm actually reached its
 *     providers). These are not auto-failed: they are what gets read.
 *
 * Usage:
 *   node scripts/swarm-sim/run-live-sim.mjs                # every trip × scenario
 *   node scripts/swarm-sim/run-live-sim.mjs --limit 3      # first 3 trips
 *   node scripts/swarm-sim/run-live-sim.mjs --scenarios missed_flight,weather
 *   node scripts/swarm-sim/run-live-sim.mjs --out /tmp/sim
 *
 * Requires .env.local: SWARM_DEMO_TOKEN, SUPABASE_SERVICE_ROLE_KEY.
 * Serial by design — the Workers Free plan caps one invocation at 50
 * subrequests, and a live mission already spends most of that budget.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API = `${process.env.SWARM_API_ORIGIN ?? "http://127.0.0.1:8787"}/api/hackathon`;
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const TEST_USER = process.env.SIM_TEST_USER ?? ""; // a user id in YOUR Supabase project

// --------------------------------------------------------------------- env

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
const TOKEN = ENV.SWARM_DEMO_TOKEN;
const SERVICE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = process.env.SIM_TEST_EMAIL ?? "";
/** The traveler's own Supabase token — the Worker's per-user gate needs it. */
let USER_TOKEN = null;
if (!TOKEN || !SERVICE_KEY) {
  console.error("Missing SWARM_DEMO_TOKEN or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

// --------------------------------------------------------------- scenarios

/** The six shipped mission tiles plus one free-text mission. */
const SCENARIOS = [
  { key: "missed_flight", intent: "I missed my flight, reroute me" },
  { key: "weather", intent: "Heavy rain forecast tomorrow, adapt my outdoor plans" },
  { key: "hotel_overbooked", intent: "My hotel is overbooked" },
  { key: "activity_cancelled", intent: "My activity got cancelled" },
  { key: "transit_strike", intent: "Transit strike tomorrow" },
  { key: "unwell", intent: "I'm feeling unwell, lighten my day" },
  { key: "free_text", intent: "My taxi to the airport is cancelled, what do I do" },
];

// ------------------------------------------------------------------ plumbing

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const LIMIT = Number(argOf("limit", "0")) || 0;
const ONLY = argOf("scenarios", "").split(",").filter(Boolean);
const OUT_DIR = argOf("out", join(ROOT, "scripts", "swarm-sim", "runs"));
/** `--settle` also approves each plan (then restores the trip). Off by default:
 *  it writes to real trips, so it must be an explicit choice. */
const SETTLE = args.includes("--settle");
const PREVIEW = args.includes("--preview");
const QUOTE_CCY = argOf("currency", "EUR").toUpperCase();

let httpCalls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mint a session for the test account WITHOUT its password: the admin API
 * issues a magic-link token, which `verify` exchanges for an access token.
 * Only the service-role key is used, so no credential is handled here.
 */
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
  // `hashed_token` is the stored form and `verify` rejects it; the one-time
  // code the email would have carried is what exchanges for a session.
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

async function api(path, init = {}) {
  httpCalls += 1;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(USER_TOKEN ? { "X-Swarm-User-Token": `Bearer ${USER_TOKEN}` } : {}),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 400) } };
  }
}

async function supabase(path) {
  httpCalls += 1;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  return res.json();
}

/** Read a trip's content_json + rev — the before/after of a settlement. */
async function readTrip(tripId) {
  const rows = await supabase(`trips?id=eq.${tripId}&select=content_json,content_rev,total_budget_eur`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Put a trip back exactly as it was.
 *
 * Settlement WRITES to the traveler's real trip, which is the whole point of
 * testing it — but a test must not leave their data rearranged. Every approved
 * mission is restored from the snapshot taken right before it.
 */
async function restoreTrip(tripId, snapshot) {
  httpCalls += 1;
  await fetch(`${SUPABASE_URL}/rest/v1/trips?id=eq.${tripId}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      content_json: snapshot.content_json,
      total_budget_eur: snapshot.total_budget_eur,
    }),
  });
}

// ------------------------------------------------------------------- checks

/**
 * Parse a timestamp, treating a naive one as UTC.
 *
 * Trip content stores departures like "2026-10-08T23:50" with no zone, and
 * `Date.parse` reads those as LOCAL time. On a UTC+8 machine that made every
 * comparison against a UTC provider timestamp 8 hours out — enough to report a
 * 48h rebooking as a 56h one and flag a perfectly bounded plan as a violation.
 */
const iso = (v) => {
  if (typeof v !== "string") return NaN;
  const naive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(v);
  return Date.parse(naive ? `${v}Z` : v);
};
const dayOf = (v) => (typeof v === "string" ? v.slice(0, 10) : null);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * TIER 1 — feasibility. Every entry returned here is a hard violation.
 */
function tier1(run) {
  const bad = [];
  const plans = run.plans ?? [];

  for (const [i, plan] of plans.entries()) {
    const at = `plan[${i}]`;
    const op = plan.operational ?? {};
    const fin = plan.financial_delta ?? {};
    const byCur = fin.by_currency ?? [];

    // 1. Money is presented in ONE currency (the panel a traveler must act on).
    if (byCur.length > 1) {
      bad.push({
        check: "single_currency",
        at,
        detail: `money split across ${byCur.length} currencies: ${byCur.map((c) => c.currency).join(" + ")}`,
      });
    }

    // 2. Per-currency arithmetic actually balances.
    for (const c of byCur) {
      const expected = round2((c.total_new_charges ?? 0) - (c.total_refund ?? 0));
      if (round2(c.net_payable ?? 0) !== expected) {
        bad.push({
          check: "ledger_arithmetic",
          at,
          detail: `${c.currency}: net ${c.net_payable} ≠ ${c.total_new_charges} − ${c.total_refund} = ${expected}`,
        });
      }
    }

    // 3a. A replacement must not be so late that it cancels the trip.
    //
    // THIS CHECK EXISTS BECAUSE ITS ABSENCE WAS THE WHOLE PROBLEM. The suite
    // below asserted only "departs after the disruption", which is exactly the
    // rule the code enforced — so it could never find a disagreement between
    // the code and reality, and reported 0 violations while the product
    // offered a traveller a rebooking FIVE DAYS after the flight they missed.
    //
    // A harness that restates the implementation is not a test of anything.
    // This one encodes what a PERSON would accept, independently.
    const REBOOKING_HORIZON_HOURS = 48;
    const nf = op.new_flight;
    const originalDepart = run.originalDepartureIso;
    if (nf?.depart && originalDepart) {
      const slipHours = (iso(nf.depart) - iso(originalDepart)) / 3_600_000;
      if (Number.isFinite(slipHours) && slipHours > REBOOKING_HORIZON_HOURS) {
        bad.push({
          check: "replacement_absurdly_late",
          at,
          detail:
            `replacement departs ${nf.depart}, ${slipHours.toFixed(1)}h ` +
            `(${(slipHours / 24).toFixed(1)} days) after the disrupted ${originalDepart} — ` +
            `that is not a rebooking, it writes off the trip in between`,
        });
      }
    }

    // 3b. A replacement must depart AFTER the flight it replaces.
    if (nf?.depart && originalDepart && iso(nf.depart) <= iso(originalDepart)) {
      bad.push({
        check: "replacement_after_disruption",
        at,
        detail: `replacement departs ${nf.depart}, at or before the disrupted ${originalDepart}`,
      });
    }

    // 4. No activity parked at an hour nobody travels at.
    for (const move of op.activity_moves ?? []) {
      const h = new Date(iso(move.newTime)).getUTCHours();
      if (Number.isFinite(h) && (h < 7 || h >= 23)) {
        bad.push({
          check: "absurd_hour",
          at,
          detail: `${move.nodeId} moved to ${move.newTime} (${h}:00 UTC)`,
        });
      }
    }

    // 5. Nothing found must SAY so, never present as a clean fix — and it must
    //    say WHICH of the four reasons applies, because they ask the traveller
    //    to do four different things. Matching one literal phrase was too
    //    brittle: the moment the copy became reason-specific this check started
    //    flagging the very honesty it was written to enforce.
    if (!nf && /flight/i.test(run.intent)) {
      const incident = String(plan.incident ?? "");
      const reason = plan.presentation?.no_flight_reason;
      const saysSomething =
        /no replacement|manual booking|not found|no flight|isn't covered|too late|could not price|couldn't price/i.test(
          incident,
        );
      if (!saysSomething) {
        bad.push({
          check: "silent_no_flight",
          at,
          detail: `no replacement flight, and the incident text does not say so: "${incident.slice(0, 90)}"`,
        });
      }
      // The structured reason is what the sheet renders — an incident string
      // alone leaves the UI with nothing to show.
      if (!reason?.summary) {
        bad.push({
          check: "no_flight_reason_missing",
          at,
          detail: "no replacement flight, and no structured reason for the traveler to act on",
        });
      }
      // The accusation guard: naming the partner requires the coverage verdict.
      if (/partner/i.test(incident) && reason?.kind !== "partner_coverage") {
        bad.push({
          check: "partner_blamed_without_proof",
          at,
          detail: `incident blames the partner but the verdict is "${reason?.kind ?? "none"}"`,
        });
      }
    }

    // 6. Settlement honesty. Only checked when the mission was actually
    //    approved (`--settle`); these are the money-touching invariants.
    if (run.settlement) {
      const rev = run.settleAfter?.rev, prevRev = run.settleBefore?.rev;
      // A settlement that claims it rewrote the trip must have moved the rev.
      if (run.settlement.trip_updated === true && rev !== undefined && rev === prevRev) {
        bad.push({
          check: "settlement_claimed_but_no_write",
          at,
          detail: `trip_updated:true but content_rev stayed at ${rev}`,
        });
      }
      // …and one that says it did not must not have moved it either.
      if (run.settlement.trip_updated === false && rev !== undefined && rev !== prevRev) {
        bad.push({
          check: "settlement_denied_but_wrote",
          at,
          detail: `trip_updated:false yet content_rev went ${prevRev} → ${rev}`,
        });
      }
      // A confirmation code with no carrier booking must say so.
      if (run.booking?.confirmationCode && run.settlement.booking_recorded !== true) {
        if (run.booking.source !== "swarm_settlement") {
          bad.push({
            check: "confirmation_without_booking",
            at,
            detail: "a code is shown but no provider booked, and it is not marked as a settlement record",
          });
        }
      }
    }
    // 7. Approving twice must never settle twice, and approval REQUIRES the flag.
    if (run.replayStatus !== undefined && run.replayStatus === 200) {
      bad.push({ check: "double_settlement", at, detail: "the same resolution settled twice" });
    }
    if (run.unflaggedStatus !== undefined && run.unflaggedStatus === 200) {
      bad.push({
        check: "approval_without_consent",
        at,
        detail: "settled without an explicit approved:true",
      });
    }

    // 8. Copy must never leak a placeholder.
    const blob = JSON.stringify(plan);
    if (/flight your flight|undefined|\[object Object\]|NaN/.test(blob)) {
      bad.push({ check: "copy_placeholder", at, detail: "placeholder text leaked into the plan" });
    }
  }
  return bad;
}

/**
 * TIER 2 — practicality signals. Not auto-failed: these are what gets judged.
 */
function tier2(run) {
  const signals = [];
  const trace = run.trace ?? [];
  const row = (agent, step) => trace.find((t) => t.agent === agent && t.step === step);

  const degraded = trace.filter((t) => String(t.step).includes("gemini_degraded"));
  signals.push({
    signal: "gemini",
    value: degraded.length === 0 ? "live" : "degraded",
    detail: degraded.map((d) => d.detail).join(" | ") || "no degrade rows",
  });

  const atlas = row("flight", "search");
  signals.push({
    signal: "atlas",
    value: atlas ? (/live Atlas/.test(atlas.detail) ? "live" : "other") : "not_called",
    detail: atlas?.detail ?? "no flight/search row",
  });

  const viator = trace.find((t) => String(t.step).includes("viator"));
  signals.push({
    signal: "viator",
    value: viator ? "live" : "not_called",
    detail: viator?.detail ?? "no viator row",
  });

  const hotelSkipped = trace.find((t) => t.agent === "hotel" && t.step === "skipped");
  signals.push({
    signal: "hotel",
    value: hotelSkipped ? "skipped" : "available",
    detail: hotelSkipped?.detail ?? "hotel rail not reported as skipped",
  });

  const policy = trace.find((t) => String(t.step).startsWith("fare_rules"));
  signals.push({
    signal: "policy_rule",
    value: policy ? (/carrier's published/.test(policy.detail) ? "carrier" : "default") : "none",
    detail: policy?.detail ?? "no policy row",
  });

  // Proportionality: did any activity cross a calendar day?
  for (const plan of run.plans ?? []) {
    for (const move of (plan.operational ?? {}).activity_moves ?? []) {
      const from = run.activityDays?.[move.nodeId];
      const to = dayOf(move.newTime);
      if (from && to && from !== to) {
        signals.push({
          signal: "activity_crosses_day",
          value: "yes",
          detail: `${move.nodeId} ${from} → ${to}`,
        });
      }
    }
  }
  return signals;
}

// --------------------------------------------------------------- one mission

async function runMission(trip, scenario) {
  const started = Date.now();
  const record = {
    tripId: trip.id,
    tripTitle: trip.title,
    scenario: scenario.key,
    intent: scenario.intent,
    originalDepartureIso: trip.firstFlightDepart ?? null,
    activityDays: trip.activityDays ?? {},
  };

  const assess = await api("/mission/assess", {
    method: "POST",
    body: JSON.stringify({ intent: scenario.intent, tripId: trip.id, language: "en" }),
  });
  record.assessStatus = assess.status;
  if (assess.status !== 200 || !assess.body.resolution_id) {
    record.outcome = "assess_failed";
    record.error = assess.body;
    record.ms = Date.now() - started;
    return record;
  }
  const rid = assess.body.resolution_id;
  record.resolutionId = rid;
  record.tradeoffs = assess.body.tradeoffs ?? [];

  // Answer every question with its SECOND option where one exists — the more
  // committal branch (rebook / need time), which exercises more of the rail.
  const answers = record.tradeoffs.map((q) => ({
    question_id: q.id,
    option_id: (q.options?.[1] ?? q.options?.[0])?.id,
  }));

  const resolve = await api("/mission/resolve", {
    method: "POST",
    body: JSON.stringify({ resolution_id: rid, answers, language: "en" }),
  });
  record.resolveStatus = resolve.status;
  if (resolve.status !== 200) {
    record.outcome = "resolve_failed";
    record.error = resolve.body;
    record.ms = Date.now() - started;
    return record;
  }

  // The deployed Worker answers async: poll swarm-status until it settles.
  let status = null;
  for (let i = 0; i < 48; i++) {
    await sleep(5000);
    const s = await api(`/swarm-status/${rid}`);
    status = s.body;
    const state = status?.state ?? status?.status;
    if (state === "proposal_ready" || state === "failed" || state === "awaiting_approval") break;
  }
  record.state = status?.state ?? status?.status ?? "unknown";
  record.trace = status?.trace ?? [];
  record.plans = status?.plans ?? (status?.plan ? [status.plan] : []);

  // SETTLEMENT — the path that actually moves money into the traveler's trip,
  // and the one the harness never exercised. Snapshot first, approve, check
  // what landed, then put the trip back exactly as it was.
  if (SETTLE && record.plans.length > 0) {
    const before = await readTrip(trip.id);
    if (before) {
      const approve = await api("/approve-resolution", {
        method: "POST",
        body: JSON.stringify({ resolutionId: rid, approved: true, planIndex: 0 }),
      });
      record.approveStatus = approve.status;
      record.settlement = approve.body?.settlement ?? null;
      record.booking = approve.body?.booking ?? null;

      // Approving twice must never settle twice.
      const replay = await api("/approve-resolution", {
        method: "POST",
        body: JSON.stringify({ resolutionId: rid, approved: true, planIndex: 0 }),
      });
      record.replayStatus = replay.status;

      // Approval without the explicit flag must be refused outright.
      const unflagged = await api("/approve-resolution", {
        method: "POST",
        body: JSON.stringify({ resolutionId: rid }),
      });
      record.unflaggedStatus = unflagged.status;

      const after = await readTrip(trip.id);
      record.settleBefore = { rev: before.content_rev, budget: before.total_budget_eur };
      record.settleAfter = after ? { rev: after.content_rev, budget: after.total_budget_eur } : null;
      await restoreTrip(trip.id, before);
    }
  }

  record.ms = Date.now() - started;
  record.outcome =
    record.plans.length > 0 ? "plans" : record.state === "processing" ? "timed_out" : "no_plans";
  record.tier1 = tier1(record);
  record.tier2 = tier2(record);
  return record;
}

// -------------------------------------------------------------------- main


// ─────────────────────────────────────────────────────── booking-preview pass
//
// The trust layer's whole promise is that a price shown as live IS live. This
// pass sends a real trip's own stays and activities to `booking-preview` and
// checks the ANSWER against that promise — not that a provider answered (a
// dead RapidAPI key is a fact about the key, not a bug), but that whatever
// came back describes itself truthfully.

/** Build preview requests from a real trip's content_json. */
function previewLinesFor(content) {
  const lines = [];
  // Trip content stores user-facing strings as localized objects ({en, fr});
  // the API takes the display string, exactly as the iOS checklist sends it.
  const text = (v) =>
    typeof v === "string" ? v : v && typeof v === "object" ? (v.en ?? v.fr ?? Object.values(v)[0]) : undefined;
  // Mirror the app's `TripDetailView.leadCity` + `SwarmPreviewLocation`: the
  // provider needs a bare, resolvable city. Verified live on 2026-09-01 —
  // "Amsterdam" returns listings, "Amsterdam, Netherlands" returns none — so a
  // harness that sends the raw destination measures something the app does not
  // do, and under-reports the product.
  const leadCity = (raw) => {
    if (!raw) return undefined;
    let lead = raw.split(",")[0];
    for (const sep of ["·", "|", "/", " - ", " – ", " & ", " + "]) lead = lead.split(sep)[0];
    return lead.trim() || raw.trim();
  };
  const cityFor = (dayPlace, destination) => {
    const lead = leadCity(destination);
    const place = (dayPlace ?? "").trim();
    if (!place) return lead;
    // A day place the trip itself names is a city; anything else is a district.
    return destination && destination.toLowerCase().includes(place.toLowerCase())
      ? leadCity(place)
      : lead;
  };
  const currency = content.currency ?? content.budget_currency ?? undefined;
  const days = content.itinerary ?? [];
  days.forEach((day, di) => {
    const city = cityFor(text(day.place ?? day.city ?? day.location), text(content.destination));
    (day.items ?? []).forEach((item, ii) => {
      const title = text(item.title ?? item.name);
      if (!title) return;
      const price = typeof item.cost === "number" ? item.cost : item.price?.amount;
      const common = {
        title,
        ...(city ? { city } : {}),
        ...(typeof price === "number" ? { estimate: price } : {}),
        ...(item.price?.currency || currency ? { currency: item.price?.currency ?? currency } : {}),
      };
      if (item.type === "hotel" || item.type === "stay") {
        lines.push({
          id: `stay-${di}-${ii}`,
          kind: "stay",
          ...common,
          ...(day.date ? { checkIn: day.date } : {}),
          nights: 1,
          guests: 2,
        });
      } else if (item.type === "activity") {
        lines.push({
          id: `activity-${di}-${ii}`,
          kind: "activity",
          ...common,
          ...(day.date ? { date: day.date } : {}),
        });
      }
    });
  });
  return lines;
}

/** Honesty invariants on the preview answer. Each violation is tier-1. */
function checkPreview(sent, body) {
  const v = [];
  const notes = [];
  const push = (code, detail) => v.push({ code, detail });
  const lines = body.lines ?? [];

  // Every line answered exactly once, ids preserved — the sheet matches rows
  // up by id, so a dropped or duplicated id silently mis-prices a row.
  const sentIds = sent.map((l) => l.id);
  const gotIds = lines.map((l) => l.id);
  for (const id of sentIds) {
    const n = gotIds.filter((g) => g === id).length;
    if (n !== 1) push("preview_line_not_answered_once", `${id} answered ${n}×`);
  }
  for (const id of gotIds) {
    if (!sentIds.includes(id)) push("preview_invented_line", id);
  }

  const byId = new Map(sent.map((l) => [l.id, l]));
  for (const line of lines) {
    const req = byId.get(line.id);
    if (line.priceSource === "live_provider") {
      // The badge the sheet renders as "live price from X" must be backed by
      // a real number, a real currency and a named provider.
      if (typeof line.price !== "number") push("live_without_price", line.id);
      if (!line.currency) push("live_without_currency", line.id);
      if (!line.provider) push("live_without_provider", line.id);
      if (typeof line.price === "number" && line.price <= 0) {
        push("live_price_not_positive", `${line.id} = ${line.price}`);
      }
      if (line.unavailableReason) {
        push("live_but_unavailable", `${line.id}: ${line.unavailableReason}`);
      }
      // NOT a violation: verified against the live API on 2026-09-01 —
      // Booking.com's search-by-coordinates ignores `filter_by_currency` and
      // always answers in the property's own currency. The sheet converts and
      // says so. Recorded as a note so the conversions stay visible.
      if (line.currency && line.currency.toUpperCase() !== QUOTE_CCY) {
        notes.push({ code: "quote_currency_ignored", detail: `${line.id}: ${line.currency} ≠ ${QUOTE_CCY}` });
      }
    } else if (line.priceSource === "trip_estimate") {
      // An estimate must be the trip's OWN figure — never a number the
      // endpoint made up while claiming it came from the trip.
      if (req && typeof req.estimate === "number" && line.price !== req.estimate) {
        push("estimate_not_the_trips_own", `${line.id}: ${line.price} ≠ ${req.estimate}`);
      }
      if (req && typeof req.estimate !== "number" && typeof line.price === "number") {
        push("estimate_from_nowhere", `${line.id} = ${line.price}`);
      }
    } else if (line.priceSource === "unknown") {
      if (typeof line.price === "number") push("unknown_but_priced", line.id);
    } else {
      push("preview_bad_price_source", `${line.id}: ${line.priceSource}`);
    }
  }

  // A provider cannot be both the source of a live price and reported as
  // never having come through — the sheet shows both lists side by side.
  const used = body.providersUsed ?? [];
  const degraded = body.providersDegraded ?? [];
  for (const provider of used) {
    if (degraded.includes(provider)) push("provider_used_and_degraded", provider);
  }
  // Any provider that actually priced a line must appear in providersUsed.
  for (const line of lines) {
    if (line.priceSource === "live_provider" && line.provider && !used.includes(line.provider)) {
      push("live_provider_missing_from_used", line.provider);
    }
  }
  return { violations: v, notes };
}

async function previewPass(trip) {
  const snapshot = await readTrip(trip.id);
  const content = snapshot?.content_json ?? {};
  const sent = previewLinesFor(content).slice(0, 20);
  if (sent.length === 0) return { tripId: trip.id, tripTitle: trip.title, skipped: "no_lines" };

  const started = Date.now();
  const { status, body } = await api("/booking-preview", {
    method: "POST",
    // The sheet's own currency — the traveler's display preference. Every
    // provider is asked to quote in it so one purchase reads as one total.
    body: JSON.stringify({ tripId: trip.id, lines: sent, quoteCurrency: QUOTE_CCY }),
  });
  if (process.env.PREVIEW_DEBUG) console.log("\n  SENT:", JSON.stringify(sent.slice(0, 3)));
  if (process.env.PREVIEW_DEBUG) console.log("  RAW:", JSON.stringify(body).slice(0, 600));
  if (status !== 200) {
    return {
      tripId: trip.id,
      tripTitle: trip.title,
      status,
      tier1: [{ code: "preview_http_error", detail: JSON.stringify(body).slice(0, 160) }],
    };
  }
  const lines = body.lines ?? [];
  const checked = checkPreview(sent, body);
  const live = lines.filter((l) => l.priceSource === "live_provider").length;
  return {
    tripId: trip.id,
    tripTitle: trip.title,
    status: 200,
    ms: Date.now() - started,
    sent: sent.length,
    live,
    estimate: lines.filter((l) => l.priceSource === "trip_estimate").length,
    unknown: lines.filter((l) => l.priceSource === "unknown").length,
    providersUsed: body.providersUsed ?? [],
    providersDegraded: body.providersDegraded ?? [],
    tier1: checked.violations,
    notes: checked.notes,
    // Every line the sheet cannot price at all, with the reason it will show.
    unpriced: lines
      .filter((l) => l.priceSource === "unknown")
      .map((l) => ({ id: l.id, reason: l.unavailableReason ?? null })),
  };
}

async function main() {
  console.log("Signing in as the test account (admin magic-link, no password)…");
  USER_TOKEN = await signInAsTestUser();
  console.log("  session acquired\n");

  console.log("Loading real trips for the test account…");
  const rows = await supabase(
    `trips?user_id=eq.${TEST_USER}&deleted_at=is.null&select=id,title,content_json&order=created_at.desc`,
  );
  let trips = (Array.isArray(rows) ? rows : []).map((r) => {
    const c = r.content_json ?? {};
    const legs = c.transit_groups ?? [];
    const firstFlight = legs.find((l) => (l.method ?? "").toLowerCase() === "flight");
    const activityDays = {};
    (c.itinerary ?? []).forEach((day, di) => {
      (day.items ?? []).forEach((item, ii) => {
        if (item.type === "activity") activityDays[`activity-${di}-${ii}`] = day.date ?? null;
      });
    });
    return {
      id: r.id,
      title: r.title,
      firstFlightDepart: firstFlight?.depart ?? null,
      hasFlight: Boolean(firstFlight),
      activityDays,
    };
  });
  if (LIMIT) trips = trips.slice(0, LIMIT);

  // `--preview` exercises the trust layer's own rail instead of the mission
  // rail: it prices each trip once and checks the answer tells the truth.
  if (PREVIEW) {
    console.log(`booking-preview pass over ${trips.length} trips\n`);
    const previews = [];
    for (const [i, trip] of trips.entries()) {
      process.stdout.write(
        `[${String(i + 1).padStart(2)}/${trips.length}] ${trip.title.slice(0, 40).padEnd(40)} `,
      );
      let record;
      try {
        record = await previewPass(trip);
      } catch (error) {
        record = { tripId: trip.id, tripTitle: trip.title, error: String(error).slice(0, 200) };
      }
      previews.push(record);
      const t1 = record.tier1?.length ?? 0;
      console.log(
        record.skipped
          ? `skipped (${record.skipped})`
          : record.error
            ? `threw: ${record.error}`
            : `${record.live}/${record.sent} live, ${record.estimate} est, ${record.unknown} unknown` +
              `${t1 ? `  ⚠ ${t1} tier-1` : ""}  (${Math.round((record.ms ?? 0) / 1000)}s)`,
      );
      if (t1) for (const v of record.tier1) console.log(`        ⚠ ${v.code}: ${v.detail}`);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    const path = join(OUT_DIR, `preview-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(path, JSON.stringify(previews, null, 2));
    const violations = previews.flatMap((r) => r.tier1 ?? []);
    console.log(`\nRaw results  → ${path}`);
    console.log(`HTTP calls   → ${httpCalls}`);
    console.log(`tier-1       → ${violations.length}`);
    return;
  }

  const scenarios = ONLY.length ? SCENARIOS.filter((s) => ONLY.includes(s.key)) : SCENARIOS;
  const total = trips.length * scenarios.length;
  console.log(`${trips.length} trips × ${scenarios.length} scenarios = ${total} live missions\n`);

  const results = [];
  let n = 0;
  for (const trip of trips) {
    for (const scenario of scenarios) {
      n += 1;
      process.stdout.write(
        `[${String(n).padStart(2)}/${total}] ${scenario.key.padEnd(18)} ${trip.title.slice(0, 34).padEnd(34)} `,
      );
      let record;
      try {
        record = await runMission(trip, scenario);
      } catch (error) {
        record = {
          tripId: trip.id,
          tripTitle: trip.title,
          scenario: scenario.key,
          outcome: "threw",
          error: String(error).slice(0, 200),
        };
      }
      results.push(record);
      const t1 = record.tier1?.length ?? 0;
      console.log(
        `${record.outcome}${t1 ? `  ⚠ ${t1} tier-1` : ""}  (${Math.round((record.ms ?? 0) / 1000)}s)`,
      );
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(OUT_DIR, `sim-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify({ results, httpCalls }, null, 2));
  console.log(`\nRaw results  → ${jsonPath}`);
  console.log(`HTTP calls   → ${httpCalls}`);

  const mdPath = join(OUT_DIR, `sim-${stamp}.md`);
  writeFileSync(mdPath, report(results, httpCalls));
  console.log(`Report       → ${mdPath}`);
}

function report(results, calls) {
  const lines = [];
  const withPlans = results.filter((r) => r.outcome === "plans");
  const t1All = results.flatMap((r) => (r.tier1 ?? []).map((v) => ({ ...v, run: r })));

  lines.push("# Live swarm simulation");
  lines.push("");
  lines.push(`- missions run: **${results.length}**  (HTTP calls: ${calls})`);
  lines.push(`- produced plans: **${withPlans.length}**`);
  lines.push(`- tier-1 violations: **${t1All.length}**`);
  lines.push("");

  const bySignal = (name) => {
    const counts = {};
    for (const r of results)
      for (const s of r.tier2 ?? [])
        if (s.signal === name) counts[s.value] = (counts[s.value] ?? 0) + 1;
    return Object.entries(counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
  };
  lines.push("## Rail liveness");
  lines.push("");
  for (const s of ["gemini", "atlas", "viator", "hotel", "policy_rule"]) {
    lines.push(`- **${s}** — ${bySignal(s) || "n/a"}`);
  }
  lines.push("");

  lines.push("## Tier-1 violations (feasibility)");
  lines.push("");
  if (t1All.length === 0) lines.push("None.");
  else {
    const grouped = {};
    for (const v of t1All) (grouped[v.check] ??= []).push(v);
    for (const [check, items] of Object.entries(grouped)) {
      lines.push(`### \`${check}\` — ${items.length}`);
      lines.push("");
      for (const it of items.slice(0, 8)) {
        lines.push(`- ${it.run.scenario} · ${it.run.tripTitle.slice(0, 40)} — ${it.detail}`);
      }
      lines.push("");
    }
  }

  lines.push("## Tier-2 signals worth reading");
  lines.push("");
  const crossings = results.flatMap((r) =>
    (r.tier2 ?? [])
      .filter((s) => s.signal === "activity_crosses_day")
      .map((s) => `- ${r.scenario} · ${r.tripTitle.slice(0, 40)} — ${s.detail}`),
  );
  lines.push(crossings.length ? "**Activities moved across a calendar day:**" : "No activity crossed a day.");
  lines.push(...crossings.slice(0, 15));
  lines.push("");

  lines.push("## Per-mission outcome");
  lines.push("");
  lines.push("| scenario | trip | outcome | tier-1 | s |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.scenario} | ${(r.tripTitle ?? "").slice(0, 32)} | ${r.outcome} | ${r.tier1?.length ?? 0} | ${Math.round((r.ms ?? 0) / 1000)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
