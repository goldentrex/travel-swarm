/** Gate 2: real routing implementation, explicit fixture/live evidence separation. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { GeminiLiaisonAgent, type TradeoffQuestion, type TradeoffAnswer, type ResolutionConstraints } from '../../../src/agents/liaison/GeminiLiaisonAgent';
import { resetModelCooldowns } from '../../../src/agents/geminiCascade';
import type { GeminiUsageEvent } from '../../../src/agents/geminiUsage';

const live = process.env.GATE2_LIVE === '1';
const repetitions = Number(process.env.GATE2_REPETITIONS ?? (live ? 3 : 100));
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 1000) throw Error('Invalid repetitions');
if (live && !process.env.GEMINI_API_KEY) throw Error('Live mode requires GEMINI_API_KEY; never paste it into reports.');
const model = process.env.GATE2_MODEL ?? 'gemini-3.7-flash';
// Standard text rates verified 2026-09-16. No grounding, explicit cache, or batch.
const prices: Record<string, { input: number; output: number; cached: number }> = {
  'gemini-3.7-flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50, cached: 0.03 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.50, cached: 0.025 },
};
const q = (id: string, question: string, options: [string, string][]): TradeoffQuestion => ({ id, question, options: options.map(([id, label]) => ({ id, label })) });
const stops = q('flight-stops', 'Nonstop, or save money with a stop?', [['nonstop', 'Fly nonstop'], ['cheaper_with_stop', 'Take the cheaper routing']]);
const day = q('flight-day', 'Travel today or on a later day?', [['same_day', 'Fly the same day'], ['cheaper_later', 'Save on a later day']]);
const airport = q('airport-status', 'Are you at the airport?', [['airport_now', 'At the airport now'], ['need_time', 'I need three hours']]);
const budget = q('budget-cap', 'How strict is your budget?', [['budget_cap', 'Keep it under €150'], ['allow_pricier', 'Allow pricier options']]);
const activity = q('activity-priority', 'Weather shock: which activity should we protect?', [['keep_museum', 'Keep Museum'], ['drop_museum', 'Drop Museum']]);
const hotel = q('hotel-tradeoff', 'Keep this hotel or rebook?', [['keep', 'Keep this hotel'], ['rebook', 'Rebook']]);
const custom = q('custom', 'Any special requirement?', [['custom_rule', 'Wheelchair-accessible transfers only']]);
const a = (question_id: string, option_id: string): TradeoffAnswer => ({ question_id, option_id });
type Scenario = { id: string; questions: TradeoffQuestion[]; answers: TradeoffAnswer[]; expected: ResolutionConstraints; bypass: boolean };
const scenarios: Scenario[] = [
  { id: 'missed-flight-nonstop-today', questions: [stops, day], answers: [a(stops.id, 'nonstop'), a(day.id, 'same_day')], expected: { prefer_nonstop: true, prefer_direct: true, prefer_same_day: true }, bypass: true },
  { id: 'missed-flight-cheaper-later', questions: [stops, day], answers: [a(stops.id, 'cheaper_with_stop'), a(day.id, 'cheaper_later')], expected: { prefer_nonstop: false, prefer_direct: false, prefer_same_day: false }, bypass: true },
  { id: 'weather-no-preferences', questions: [], answers: [], expected: {}, bypass: true },
  { id: 'missed-flight-airport-status', questions: [airport], answers: [a(airport.id, 'airport_now')], expected: { min_departure_delay_hours: 1 }, bypass: false },
  { id: 'missed-flight-budget', questions: [budget], answers: [a(budget.id, 'budget_cap')], expected: { max_price: 150 }, bypass: false },
  { id: 'weather-protect-activity', questions: [activity], answers: [a(activity.id, 'keep_museum')], expected: { activity_priority: 'museum' }, bypass: false },
  { id: 'hotel-rebook', questions: [hotel], answers: [a(hotel.id, 'rebook')], expected: { keep_hotel: false }, bypass: false },
  { id: 'custom-accessibility', questions: [custom], answers: [a(custom.id, 'custom_rule')], expected: { notes: 'Wheelchair-accessible transfers only' }, bypass: false },
];
const out = resolve(process.env.GATE2_OUT ?? `artifacts/gate2/${new Date().toISOString().replace(/[:.]/g, '-')}-${live ? 'live' : 'offline'}`);
mkdirSync(out, { recursive: true });
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async () => { throw Error('Unexpected global network request'); };
const samples: any[] = [];
const quantile = (xs: number[], p: number) => [...xs].sort((a,b) => a-b)[Math.max(0, Math.ceil(xs.length*p)-1)];
const mean = (xs: number[]) => xs.reduce((a,b) => a+b,0)/xs.length;
const hashes = Object.fromEntries([
  'src/agents/liaison/GeminiLiaisonAgent.ts', 'src/agents/geminiUsage.ts',
  'src/agents/geminiCascade.ts', 'scripts/swarm-sim/gate2/routing-benchmark.ts',
].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));

for (let repeat = 0; repeat < repetitions; repeat++) {
  for (const scenario of scenarios) {
    // Alternate paired ordering to reduce systematic order bias.
    const routes = repeat % 2 ? ['deterministic_known', 'model'] : ['model', 'deterministic_known'];
    for (const route of routes) {
      resetModelCooldowns();
      process.env.SWARM_CONSTRAINT_ROUTING = route;
      const events: GeminiUsageEvent[] = [];
      let calls = 0;
      let requestCharacters = 0;
      const fetchImpl: typeof fetch = async (url, init) => {
        calls++;
        requestCharacters += String(init?.body ?? '').length;
        if (live) {
          const parsed = new URL(String(url));
          if (parsed.protocol !== 'https:' || parsed.hostname !== 'generativelanguage.googleapis.com' || !parsed.pathname.endsWith(':generateContent')) throw Error('Unexpected provider endpoint');
          return nativeFetch(url, { ...init, redirect: 'error' });
        }
        // Independent fixture oracle, not an LLM. Never invent usageMetadata.
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(scenario.expected) }] } }] });
      };
      const agent = new GeminiLiaisonAgent({ apiKey: live ? process.env.GEMINI_API_KEY : 'fixture-only', model, fetchImpl, maxRetries: 0, onUsage: e => events.push(e) });
      const started = performance.now();
      const result = await agent.translateAnswersToConstraints(scenario.questions, scenario.answers);
      const elapsedMs = performance.now() - started;
      const tokens = calls === 0 ? { input: 0, output: 0, thinking: 0, cached: 0 } :
        live && events.length === calls && events.every(e => e.usage?.promptTokenCount !== undefined && e.usage?.candidatesTokenCount !== undefined) ? {
          input: events.reduce((n,e) => n + e.usage!.promptTokenCount!,0),
          output: events.reduce((n,e) => n + e.usage!.candidatesTokenCount!,0),
          thinking: events.reduce((n,e) => n + (e.usage!.thoughtsTokenCount ?? 0),0),
          cached: events.reduce((n,e) => n + (e.usage!.cachedContentTokenCount ?? 0),0),
        } : null;
      const rate = prices[model];
      const estimatedUsd = tokens && rate ? ((tokens.input - tokens.cached)*rate.input + tokens.cached*rate.cached + (tokens.output+tokens.thinking)*rate.output)/1e6 : null;
      const sample = { scenario: scenario.id, repeat, route, actualRoute: agent.lastConstraintRoute, calls, elapsedMs, requestCharacters, tokens, estimatedUsd, degrade: agent.lastDegradeReason ?? null, matchesExpected: isDeepStrictEqual(result, scenario.expected), constraints: result, events };
      samples.push(sample);
      writeFileSync(`${out}/samples.json`, JSON.stringify(samples, null, 2));
      const expectedCalls = route === 'deterministic_known' && scenario.bypass ? 0 : 1;
      if (calls !== expectedCalls || (!live && !sample.matchesExpected) || sample.degrade) throw Error(`Invalid benchmark sample: ${scenario.id}/${route}; see sanitized samples.json`);
      if (live && calls) await new Promise(r => setTimeout(r, 13000));
    }
  }
}
const rows = scenarios.map(s => {
  const summarize = (route: string) => {
    const set = samples.filter(x => x.scenario === s.id && x.route === route);
    return { calls: mean(set.map(x=>x.calls)), medianMs: quantile(set.map(x=>x.elapsedMs),0.5), p95Ms: quantile(set.map(x=>x.elapsedMs),0.95), input: set.every(x=>x.tokens) ? mean(set.map(x=>x.tokens.input)) : null, output: set.every(x=>x.tokens) ? mean(set.map(x=>x.tokens.output)) : null, thinking: set.every(x=>x.tokens) ? mean(set.map(x=>x.tokens.thinking)) : null, estimatedUsd: set.every(x=>x.estimatedUsd !== null) ? mean(set.map(x=>x.estimatedUsd)) : null, matchesExpected: set.filter(x=>x.matchesExpected).length, requestCharacters: mean(set.map(x=>x.requestCharacters)) };
  };
  const baseline = summarize('model'), routed = summarize('deterministic_known');
  return { scenario: s.id, baseline, routed, avoidedCalls: baseline.calls-routed.calls, liveMedianReductionMs: live ? baseline.medianMs-routed.medianMs : null, estimatedUsdSaved: baseline.estimatedUsd !== null && routed.estimatedUsd !== null ? baseline.estimatedUsd-routed.estimatedUsd : null };
});
const report = { timestamp: new Date().toISOString(), mode: live ? 'live' : 'offline-fixture', scope: 'Liaison answer-to-constraints only; not end-to-end disruption recovery', model, repetitions, commit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), dirty: !!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(), hashes, prices, priceSource: 'https://ai.google.dev/gemini-api/docs/pricing', priceChecked: '2026-09-16', priceExpiry: '2026-12-31', caveats: ['Baseline is existing schema-constrained model route with deterministic merge, not a fabricated unconstrained agent.', 'Fixture responses test routing and contracts, not model quality, provider tokens, or network latency.', 'Scenario mix is curated and equally weighted, not production traffic.', 'Live costs are paid-tier estimates, not invoices; omitted thinking/cache fields treated as zero; raw usage retained.', 'No supplier calls, bookings, payments, or application configuration changes.'], rows };
writeFileSync(`${out}/report.json`, JSON.stringify(report,null,2));
writeFileSync(`${out}/fixtures.json`, JSON.stringify(scenarios,null,2));
const fmt = (x: number|null) => x === null ? 'unmeasured' : x.toFixed(4);
const lines = ['# Gate 2 routing comparison', '', `Mode: ${report.mode}; ${repetitions} paired repetitions per scenario; model: ${model}.`, '', report.scope, '', '| Scenario | Calls model → routed | Input tokens model → routed | Output tokens model → routed | Local median ms model → routed | Live median ms saved | Estimated USD saved |', '|---|---:|---:|---:|---:|---:|---:|', ...rows.map(r => `| ${r.scenario} | ${r.baseline.calls} → ${r.routed.calls} | ${r.baseline.input ?? 'unknown'} → ${r.routed.input ?? 'unknown'} | ${r.baseline.output ?? 'unknown'} → ${r.routed.output ?? 'unknown'} | ${fmt(r.baseline.medianMs)} → ${fmt(r.routed.medianMs)} | ${fmt(r.liveMedianReductionMs)} | ${r.estimatedUsdSaved ?? 'unmeasured'} |`), '', ...report.caveats.map(x=>`- ${x}`), ''];
writeFileSync(`${out}/report.md`,lines.join('\n'));
console.log(JSON.stringify({ out, mode: report.mode, samples: samples.length, avoidedCalls: rows.reduce((n,r)=>n+r.avoidedCalls,0)*repetitions, matchesExpected: samples.filter(x=>x.matchesExpected).length }, null, 2));
