# Atlas Flight Provider

Concrete `FlightProvider` implementation targeting the **Atlas Skill / ATRIP Sandbox API**.
Live HTTP implementation using native `fetch` — zero third-party dependencies.

## Configuration

Read from the environment when the provider is constructed:

| Variable            | Required | Default                         | Purpose                                                    |
| ------------------- | -------- | ------------------------------- | ---------------------------------------------------------- |
| `ATLAS_API_KEY`     | yes      | —                               | Sandbox secret, sent as the `x-atlas-client-secret` header |
| `ATLAS_CLIENT_ID`   | no       | header omitted                  | Sent as the `x-atlas-client-id` header when configured     |
| `ATLAS_SANDBOX_URL` | no       | `https://sandbox.atriptech.com` | Base URL (takes precedence over `ATLAS_BASE_URL`)          |
| `ATLAS_BASE_URL`    | no       | falls through to default        | Legacy alias for the base URL                              |
| `ATLAS_TIMEOUT_MS`  | no       | `15000`                         | Per-request timeout (invalid values fall back)             |

The constructor throws immediately if `ATLAS_API_KEY` is missing — a provider
without credentials must never silently degrade.

## Wire protocol (as implemented)

Every operation is a JSON-body `POST` to the resolved base URL
(`ATLAS_SANDBOX_URL` ?? `ATLAS_BASE_URL` ?? `https://sandbox.atriptech.com`):

| Interface method           | Endpoint                                              | Purpose                                                         |
| -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| `searchAlternativeFlights` | `POST /search.do`                                     | Route-based search (`fromCity`/`toCity`/`fromDate`, USD)        |
| `calculateFareDifference`  | `POST /verify.do`                                     | Re-prices a candidate (`routingIdentifier`), issues `sessionId` |
| `bookFlight`               | `POST /verify.do` → `POST /order.do` → `POST /pay.do` | Session → order (`orderNo`) → best-effort payment               |

There is no upstream fare-difference endpoint — `verify.do` re-prices the
candidate and the delta is computed client-side (see below).

Request headers on every call:

- `x-atlas-client-secret: {ATLAS_API_KEY}` — **NOT** `Authorization: Bearer`
- `x-atlas-client-id: {ATLAS_CLIENT_ID}` — only when the variable is configured
- `Accept: */*` and `Accept-Encoding: gzip` — **mandatory**; a missing gzip
  header is rejected with business status `102`
- `Content-Type: application/json`

Requests use `AbortSignal.timeout(ATLAS_TIMEOUT_MS)`.

### Envelope contract

Responses are JSON envelopes `{ status, msg, ...payload }`:

- `status === 0` is the ONLY success signal. Code never branches on `msg`.
- Payload keys sit alongside `status`/`msg` (a nested `data` object is also
  honored).

Business statuses observed:

| Status | Meaning                         | Retryable |
| ------ | ------------------------------- | --------- |
| `0`    | Success                         | —         |
| `102`  | `Accept-Encoding: gzip` missing | no        |
| `109`  | Search limit reached            | no        |
| `110`  | Temporarily unavailable         | yes       |
| `112`  | Temporarily unavailable         | yes       |
| `900`  | Credentials rejected            | no        |
| `9999` | Temporarily unavailable         | yes       |
| other  | Generic rejection               | no        |

`search.do` is rate-limited to 10 QPS upstream; status `109` signals the
limit has been hit.

`search.do` requests carry a `requestId` (uuid) kept purely as a correlation
id — it is unconsumed upstream.

### Liveness correlation ids

The response envelope's `requestId` / `uuid` strings are captured additively
by `post()` and surfaced as `AlternativeFlightsResult.atlasSearchRequestId`
(search.do) and `FareDifference.atlasRequestId` (each verify.do). The
FlightAgent aggregates them into `FlightRebookingAssessment.atlasCorrelation`,
which the hackathon API quotes (truncated to 12 chars) in the additive
`flight/atlas_liveness` Activity-Stream row — proof the sandbox was actually
reached. Degraded/simulated rails carry no ids and never emit the row.

### Sandbox billing note

Atlas sandbox billing is quota-based; fare search credits are not deducted
per request — live usage with 100% credits is expected. (Mirrored verbatim
in the `/api/hackathon/health` snapshot as `atlasBillingNote`.)

### Carrier display names

Segments carry only the IATA `carrier` code, but the FlightOption contract
promises the airline NAME. The provider resolves codes through a curated
static map (`ATLAS_AIRLINE_NAMES`, e.g. `VY` → "Vueling"); an upstream
`carrierName` / `airlineName` string wins when present, and unknown codes
fall through to the raw code.

### Pricing arithmetic

Atlas has no fare-difference endpoint, so all arithmetic is client-side:

- Routing total: `(adultPrice + adultTax) * adults + transactionFee`
  (`transactionFee` honors `transactionFeeMode`: PER_PAX / PER_SEGMENT /
  PER_TICKET / PER_BOOKING; absent mode = flat fee), rounded to cents.
- `basis: "fare_difference"` — only when `routeContext.originalFare` is a
  finite, non-negative amount in the SAME currency as the verified re-price;
  the delta `verifiedTotal − originalFare` is reported as a `charge` or
  `refund` with the original fare and passenger count alongside.
- `basis: "full_fare"` — unknown or cross-currency original fare: the full
  verified total is quoted as a charge. Never a silent 0, never a
  cross-currency subtraction.

## Error handling contract

Methods **never** leak raw `fetch` / `JSON.parse` exceptions. Every failure is
thrown as `AtlasApiError` (exported from `AtlasFlightProvider.ts`) with:

| Field       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `kind`      | `"http"` · `"network"` · `"timeout"` · `"parse"` · `"invalid_response"`       |
| `status`    | HTTP status for `kind === "http"`, otherwise `null`                           |
| `code`      | Upstream error code from the sandbox body when available, otherwise `null`    |
| `retryable` | Safe-to-retry hint: timeouts, network failures, and HTTP 408/425/429/5xx only |
| `message`   | Upstream message when the body provides one, otherwise a precise local one    |

Missing or malformed DTO fields raise `kind: "invalid_response"` with the
offending field named — never `undefined` pass-through.

The orchestrator should treat `retryable: true` as eligible for backoff retry
and surface every other `AtlasApiError` to the user as a failed resolution
attempt rather than crashing the pipeline.

`bookFlight` remains gated behind an approved `ResolutionPlan`
(see `src/agents/finance/TrustLayer.ts`) — financial actions are never
executed from free-form model output.
