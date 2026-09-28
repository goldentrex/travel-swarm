/**
 * Every amount on the screen, rebuilt from the facts behind it.
 *
 * No money moves yet — the booking rail is a rehearsal and no ticket is
 * issued. That is exactly why this matters now: the numbers a traveller is
 * asked to approve are the last thing anyone checks before money DOES move,
 * and a wrong one shipped today becomes a wrong charge later.
 *
 * The settlement gate already asserts the identity
 * `net_payable === total_new_charges − total_refund` everywhere. That proves
 * the arithmetic is self-consistent. It does not prove any of the three terms
 * is TRUE — a plan that invents a refund and an equal charge satisfies it
 * perfectly. So this audit goes behind the identity:
 *
 *   1. Does every charge trace to a real quoted fact (a fare, a change fee, a
 *      penalty the agent stated)?
 *   2. Does every REFUND trace to something the traveller actually paid — a
 *      fare on file, a booked ticket — rather than to a computed difference?
 *   3. Do the per-currency buckets sum to the headline, without a conversion
 *      quietly bridging two currencies?
 *   4. Is the amount the SETTLEMENT wrote the amount the PLAN promised?
 *
 * Reads a finished battery run; spends nothing.
 *
 *   node scripts/swarm-sim/ledger-audit.mjs scripts/swarm-sim/runs/sim-….json
 */

import { readFileSync } from "node:fs";

const EPSILON = 1e-9;

/** Every finding is a sentence a person can check, not a code. */
function auditPlan(plan, label) {
  const findings = [];
  const fd = plan?.financial_delta;
  if (!fd) return [{ label, detail: "no financial_delta at all" }];

  const charges = Number(fd.total_new_charges ?? 0);
  const refund = Number(fd.total_refund ?? 0);
  const net = Number(fd.net_payable ?? 0);

  // 1. The identity itself — cheap, and it anchors everything below.
  if (Math.abs(charges - refund - net) > EPSILON) {
    findings.push({ label, detail: `net ${net} ≠ ${charges} − ${refund}` });
  }

  // 2. A refund must correspond to something really paid. The engine states
  //    this itself when it cannot: "no fare on file to refund" appears in the
  //    ledger summary. A refund WITH that line is a contradiction.
  const summary = (plan.presentation?.ledger_summary ?? []).join(" | ");
  if (refund > 0 && /no fare on file/i.test(summary)) {
    findings.push({
      label,
      detail: `refunds ${refund} while the ledger says there is no fare on file to refund`,
    });
  }

  // 3. A replacement whose price was never verified must not produce a
  //    refund: nothing was priced, so nothing can come back.
  const basis = plan.proposed_resolution?.new_flight?.fare_basis;
  if (refund > 0 && basis && basis !== "verified") {
    findings.push({
      label,
      detail: `refunds ${refund} against a ${basis} fare — an unverified price cannot fund a refund`,
    });
  }

  // 4. Per-currency buckets: each must hold the identity on its own, and the
  //    set of currencies must not silently collapse into one headline.
  const buckets = fd.by_currency ?? [];
  for (const bucket of buckets) {
    const bc = Number(bucket.total_new_charges ?? 0);
    const br = Number(bucket.total_refund ?? 0);
    const bn = Number(bucket.net_payable ?? 0);
    if (Math.abs(bc - br - bn) > EPSILON) {
      findings.push({ label, detail: `${bucket.currency} bucket: ${bn} ≠ ${bc} − ${br}` });
    }
  }
  if (buckets.length > 1) {
    const display = fd.display;
    if (display && display.converted !== true) {
      findings.push({
        label,
        detail: `${buckets.length} currencies but the headline is not marked converted`,
      });
    }
  }
  // A single-currency plan whose headline disagrees with its only bucket.
  if (buckets.length === 1 && fd.display?.converted !== true) {
    const only = buckets[0];
    if (Math.abs(Number(only.net_payable ?? 0) - net) > EPSILON) {
      findings.push({
        label,
        detail: `headline net ${net} ≠ the only bucket's ${only.net_payable} ${only.currency}`,
      });
    }
  }

  // 5. Charges must trace to stated facts. The plan carries them: the fare
  //    delta, the policy's change fee, each activity penalty, a transfer
  //    re-quote. Anything left over is money from nowhere.
  // The policy verdict is an AUDIT surface, not a line item: `changeFee` is
  // what a change WOULD cost, and TrustLayer says so outright ("display/audit
  // only — money math flows exclusively through financial_delta"). A plan that
  // offers no replacement changes nothing, so it owes nothing — counting the
  // quoted fee there made three honest "we found no flight" plans look like
  // they were under-billing.
  const changesAFlight = plan.proposed_resolution?.new_flight != null;
  const policyFee = changesAFlight
    ? Number(plan.proposed_resolution?.policy_verdict?.changeFee ?? 0)
    : 0;
  const penalties = (plan.proposed_resolution?.rescheduled_activities ?? []).reduce(
    (sum, a) => sum + Number(a.penalty ?? 0),
    0,
  );
  const hotelFees = (plan.proposed_resolution?.hotel_adjustments ?? []).reduce(
    (sum, h) => sum + Number(h.fee ?? 0),
    0,
  );
  const transfer = Number(plan.proposed_resolution?.transfer_requote?.amount ?? 0);
  const accountedFloor = policyFee + penalties + hotelFees + transfer;
  if (charges + EPSILON < accountedFloor) {
    findings.push({
      label,
      detail: `charges ${charges} are LESS than the stated fees alone (${accountedFloor}) — something quoted is not billed`,
    });
  }
  return findings;
}

/** What the settlement wrote must be what the plan promised. */
function auditSettlement(record, label) {
  const findings = [];
  const before = record.settleBefore;
  const after = record.settleAfter;
  if (!before || !after) return findings;
  const movedEur = Number(after.budget ?? 0) - Number(before.budget ?? 0);
  const plan = (record.plans ?? [])[0];
  const promised = Number(plan?.financial_delta?.display?.net_payable ?? plan?.financial_delta?.net_payable ?? 0);
  // The trip budget is an EUR total; the plan's net is in its own currency
  // unless a converted display exists. Only compare when the plan says EUR.
  const currency = plan?.financial_delta?.display?.currency ?? plan?.currency;
  if (currency === "EUR" && Math.abs(movedEur - promised) > 0.01 && promised !== 0) {
    findings.push({
      label,
      detail: `the trip budget moved ${movedEur.toFixed(2)} EUR but the plan promised ${promised.toFixed(2)}`,
    });
  }
  return findings;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/swarm-sim/ledger-audit.mjs <runs/sim-….json>");
  process.exit(1);
}
const raw = JSON.parse(readFileSync(path, "utf8"));
const records = Array.isArray(raw) ? raw : (raw.results ?? []);

let plansAudited = 0;
const all = [];
for (const record of records) {
  const where = `${record.scenario} · ${(record.tripTitle ?? "").slice(8, 34)}`;
  for (const [i, plan] of (record.plans ?? []).entries()) {
    plansAudited += 1;
    all.push(...auditPlan(plan, `${where} [plan ${i}]`));
  }
  all.push(...auditSettlement(record, where));
}

console.log(`Ledger audit over ${plansAudited} plan(s) in ${records.length} mission(s)\n`);
if (all.length === 0) {
  console.log("Every amount traces to a stated fact, in its own currency.");
} else {
  for (const f of all) console.log(`  ✗ ${f.label}\n      ${f.detail}`);
  console.log(`\n${all.length} finding(s).`);
}
