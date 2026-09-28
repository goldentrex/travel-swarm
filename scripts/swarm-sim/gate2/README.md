# Gate 2 — routing evidence

Run from the `ai-globeplanner` directory:

```bash
node node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/swarm-sim/gate2/routing-benchmark.ts
```

Default: offline, 100 paired repetitions of eight synthetic preference scenarios. Uses the real `GeminiLiaisonAgent` and the real `SWARM_CONSTRAINT_ROUTING` environment switch. A fixture transport returns independently specified expected constraints; no provider usage is fabricated. Both arms use the same model setting, schema, questions, and answers. Order alternates by repetition. The runner blocks unexpected global network requests. No application source or saved routing configuration changes.

Live mode requires an existing Gemini key in the invoking process or an explicitly selected environment file. Never put the key in the command line, repository, or report. Example after replacing the file path:

```bash
GATE2_LIVE=1 GATE2_REPETITIONS=3 GATE2_MODEL=gemini-3.7-flash \
node --env-file=/absolute/path/to/private.env \
node_modules/vite-node/vite-node.mjs --config vitest.config.ts \
scripts/swarm-sim/gate2/routing-benchmark.ts
```

This makes 39 model generation calls: 24 baseline and 15 routed, with no retries and 13-second spacing after each call. Run duration is at least 8.5 minutes plus inference latency. Quota, HTTP, malformed output, and other degraded calls stop the run rather than presenting fallback as successful model inference. Partial sanitized samples survive. The default three repeats are a pilot, not a statistically strong latency claim; raise repetitions only after checking model quota. No warmup is excluded, and latency includes cold calls. The runner allows only Google's generation endpoint in live mode and does not import supplier or settlement APIs.

Each run stores:

- `fixtures.json`: eight synthetic inputs and independent expected constraints.
- `samples.json`: every result, route, call count, elapsed time, sanitized usage, and correctness flag.
- `report.json`: aggregated means for tokens/cost, median/p95 timings, repetitions, commit, dirty-tree flag, source hashes, price assumptions.
- `report.md`: comparison table, with unknown measurements explicitly marked.

## Interpretation

The comparison baseline is the existing **always-model preference translation**, still bounded by schema validation and deterministic merge. It is not an unconstrained general agent. This is a component benchmark, not a full missed-flight/weather recovery benchmark. It does not measure supplier fan-out, end-to-end DAG correctness, booking outcomes, or settlement.

All eight cases are equally weighted deliberately. Three are bypass-eligible; five demonstrate retained model calls. Actual traffic weighting is unknown. The default missed-flight builder may include airport timing and budget choices, so a missed flight does not automatically qualify for bypass. Fixture correctness is contract parity, not measured LLM accuracy. Live correctness flags must be reviewed; do not approve a latency/cost claim if required preferences are lost.

Offline `requestCharacters` is payload size, **not token count**. Offline network latency, model tokens, thinking tokens, and dollar savings are unknown. Zero requests on the deterministic branch establishes zero model tokens for that component only. Local fixture timing must not be advertised as live latency reduction.

## Cost calculation

For each live sample, using provider metadata:

`USD = ((promptTokens - cachedTokens) × inputRate + cachedTokens × cacheRate + (candidateTokens + thinkingTokens) × outputRate) / 1,000,000`

Rates are standard text paid-tier rates checked on 2026-09-16 at https://ai.google.dev/gemini-api/docs/pricing :

| Model | Input / 1M | Output including thinking / 1M | Cached input / 1M |
|---|---:|---:|---:|
| gemini-3.7-flash | $0.75 | $3.75 | $0.075 |
| gemini-3.5-flash-lite | $0.30 | $2.50 | $0.03 |
| gemini-3.1-flash-lite | $0.25 | $1.50 | $0.025 |

The 3.7 Flash prices above expire December 31, 2026. Reverify pricing before later runs. No grounding or explicit cache is requested. Missing input/output metadata stays unknown; omitted thinking/cache fields are treated as zero and raw metadata remains available for audit. Free-tier billing may be zero; estimates are paid-tier equivalents, not invoices. A different model without a verified price yields unknown cost.

## Illustrative sensitivity only — not benchmark results

Assume an avoided call uses 1,000 input tokens and 100 total output-plus-thinking tokens. At the current 3.7 Flash rates, it costs $0.001125. Avoiding 300 such calls saves $0.3375; avoiding 1,000 saves $1.125. If each avoided call takes 1,000 ms, eligible cases save roughly that serial model delay; neither token counts nor the 1,000 ms assumption was measured here. Real savings must use the live report.
