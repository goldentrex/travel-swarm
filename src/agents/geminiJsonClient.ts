/**
 * ONE schema-constrained Gemini exchange — the transport every Gemini-backed
 * agent of the swarm shares.
 *
 * It used to be copied. `GeminiLiaisonAgent.callGemini` and
 * `DayReorganizer.callGemini` were the same ~200 lines twice over (the
 * day-reorg copy says so in its own header: "cloning the GeminiLiaisonAgent
 * callGemini pattern"), and every lesson the live matrix of 2026-09-01 taught
 * — per-attempt deadlines instead of one shared one, walking the ladder on
 * `http_error` and not just on 429, `MAX_TOKENS` classified as a budget
 * failure rather than a bad model — had to be applied in both places by hand.
 * A third caller (the semantic critic) made that arrangement indefensible.
 *
 * Contract, unchanged from the two copies it replaces:
 *  - TOTAL. Never throws. Every failure is classified through the frozen
 *    {@link GeminiDegradeReason} taxonomy and returned, so the caller decides
 *    what to serve instead.
 *  - Budget-gated per mission, deadline-bounded per ATTEMPT, and laddered
 *    across {@link GEMINI_MODEL_CASCADE} — the retry targets a DIFFERENT
 *    model, because `quota_429` means this one has no capacity.
 *  - Usage telemetry is provider-reported only; no prompt, response text, API
 *    key or traveler data is ever emitted.
 *
 * What stays with the CALLER: its own `lastDegradeReason` field, its log
 * prefix (passed as `label`) and what it serves when the model is unavailable.
 */

import {
  emitGeminiUsage,
  readGeminiUsage,
  type GeminiUsageEvent,
  type GeminiUsageObserver,
  type GeminiCallBudget,
} from "./geminiUsage";
import { modelLadder, noteModelExhausted, noteModelHealthy } from "@/agents/geminiCascade";
import { GEMINI_CALLS_PER_MISSION, type GeminiCallResult, type GeminiDegradeReason } from "./geminiDegrade";

export interface GeminiJsonClientConfig {
  /** Log prefix, e.g. "liaison" ⇒ `[liaison] …`. */
  label: string;
  /** Explicit key; falls back to `process.env.GEMINI_API_KEY`. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onUsage?: GeminiUsageObserver;
  /** Request-scoped allowance shared with the other agents of one mission. */
  sharedBudget?: GeminiCallBudget;
  maxRetries?: number;
  retryDelayMs?: number;
  callBudget?: number;
  /**
   * Called at the ONE classification site the caller cannot see for itself —
   * the per-mission budget gate, which skips the call before any HTTP
   * happens. The caller logs it and records its own degrade reason, exactly
   * as it did when the gate lived inside its own `callGemini`.
   */
  onDegrade?: (reason: GeminiDegradeReason, message: string) => void;
}

export interface GeminiJsonRequest {
  systemInstruction: string;
  userPrompt: string;
  /** Gemini `responseSchema` (uppercase type names). */
  responseSchema: unknown;
  temperature: number;
  maxOutputTokens: number;
}

export class GeminiJsonClient {
  private readonly label: string;
  readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onUsage: GeminiUsageObserver | undefined;
  private readonly sharedBudget: GeminiCallBudget | undefined;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly callBudget: number;
  private readonly onDegrade: GeminiJsonClientConfig["onDegrade"];

  private callsUsedCount = 0;

  constructor(config: GeminiJsonClientConfig) {
    this.label = config.label;
    this.apiKey =
      config.apiKey !== undefined && config.apiKey.length > 0
        ? config.apiKey
        : typeof process !== "undefined" && typeof process.env?.GEMINI_API_KEY === "string"
          ? process.env.GEMINI_API_KEY
          : undefined;
    this.model = config.model ?? "";
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.onUsage = config.onUsage;
    this.sharedBudget = config.sharedBudget;
    this.maxRetries = Math.max(0, Math.floor(config.maxRetries ?? 0));
    this.retryDelayMs = config.retryDelayMs ?? 1_500;
    this.callBudget = config.callBudget ?? GEMINI_CALLS_PER_MISSION;
    this.onDegrade = config.onDegrade;
    // Workers' `fetch` is brand-checked against its receiver: storing the bare
    // function and later calling it as `this.fetchImpl(...)` invokes it with
    // `this` = the client, which Cloudflare's runtime rejects as "Illegal
    // invocation" — silently, since the catch below degrades it.
    // `.bind(globalThis)` pins the receiver Workers expects.
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Gemini calls consumed so far this mission (test/audit feed). */
  get callsUsed(): number {
    return this.callsUsedCount;
  }

  /**
   * Budget gate → primary attempt → at most `maxRetries` retries on a failure
   * that is about the MODEL rather than about us (`quota_429` / `http_error`),
   * each against the NEXT rung of the ladder with a deadline of its own.
   */
  async requestJson(request: GeminiJsonRequest): Promise<GeminiCallResult> {
    // Per-mission budget gate: exhaustion skips the call and classifies as the
    // closest taxonomy value — `quota_429` (the union stays frozen at 6).
    if (this.callsUsedCount >= this.callBudget) {
      this.onDegrade?.(
        "quota_429",
        `Gemini call skipped — per-mission budget exhausted (${this.callBudget} calls)`,
      );
      return { ok: false, reason: "quota_429" };
    }

    let budgetExhausted = false;
    const attempt = async (model: string): Promise<GeminiCallResult> => {
      // Recheck AFTER any retry backoff: another concurrent day can consume
      // the last slot while this call is waiting. Reserve before the next await.
      if (
        this.callsUsedCount >= this.callBudget ||
        (this.sharedBudget && !this.sharedBudget.tryReserve())
      ) {
        budgetExhausted = true;
        return { ok: false, reason: "quota_429" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.callsUsedCount += 1;
        return await this.callOnce(request, controller.signal, model);
      } finally {
        clearTimeout(timer);
      }
    };

    // Walk the ladder: the most capable model first, then tiers still within
    // quota. It moves down on any failure about the MODEL — a capacity answer
    // (429/503) or a plain HTTP failure. It used to move only on 429/503, on
    // the reasoning that anything else "is this request's own problem and a
    // different model would repeat it"; the live matrix of 2026-09-01
    // disproved that (8 of 9 degradations were `http_error`, none of which
    // ever asked a second model). A genuinely malformed request fails on every
    // rung and still lands on the caller's deterministic rail, so being wrong
    // here costs one extra call.
    const ladder = modelLadder(this.model);
    let result = await attempt(ladder[0]);
    if (result.ok) noteModelHealthy(ladder[0]);

    let rung = 0;
    while (
      !result.ok &&
      !budgetExhausted &&
      (result.reason === "quota_429" || result.reason === "http_error") &&
      rung < this.maxRetries &&
      rung + 1 < ladder.length &&
      this.callsUsedCount < this.callBudget
    ) {
      // Only a QUOTA refusal earns a cooldown — a one-off 500 must not
      // sideline a healthy model for minutes afterwards.
      if (result.reason === "quota_429") noteModelExhausted(ladder[rung]);
      rung += 1;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      console.warn(
        `[${this.label}] ${ladder[rung - 1]} failed (${result.reason}) — trying ${ladder[rung]}`,
      );
      result = await attempt(ladder[rung]);
      if (result.ok) noteModelHealthy(ladder[rung]);
    }
    if (!result.ok && !budgetExhausted && result.reason === "quota_429") {
      noteModelExhausted(ladder[rung]);
    }
    return result;
  }

  /** ONE fetch attempt with the full degrade taxonomy classification. */
  private async callOnce(
    request: GeminiJsonRequest,
    signal: AbortSignal,
    model: string,
  ): Promise<GeminiCallResult> {
    const startedAt = Date.now();
    let usage: GeminiUsageEvent["usage"] = null;
    let outcome: GeminiUsageEvent["outcome"] = "exception";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: request.responseSchema,
            temperature: request.temperature,
            maxOutputTokens: request.maxOutputTokens,
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      });
      if (!response.ok) {
        // The body carries the ACTUAL rejection reason (bad schema field,
        // quota, model id) — status + statusText alone made every failure mode
        // here indistinguishable in the logs.
        const bodyText = await response.text().catch(() => "");
        const reason: GeminiDegradeReason =
          response.status === 429 || response.status === 503 ? "quota_429" : "http_error";
        console.error(
          `[${this.label}] Gemini HTTP ${response.status} (${response.statusText}): ${bodyText.slice(0, 500)} (degrade: ${reason})`,
        );
        outcome = reason;
        return { ok: false, reason };
      }
      const data = (await response.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: unknown }> };
          /** "STOP" | "MAX_TOKENS" | … — distinguishes a truncation from a bad model. */
          finishReason?: string;
        }>;
        error?: { message?: unknown };
        usageMetadata?: unknown;
      };
      usage = readGeminiUsage(data?.usageMetadata);
      if (data?.error) {
        console.error(
          `[${this.label}] Gemini error payload: ${String(data.error.message ?? "unknown")} (degrade: http_error)`,
        );
        outcome = "http_error";
        return { ok: false, reason: "http_error" };
      }
      const finishReason = data?.candidates?.[0]?.finishReason;
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        // `MAX_TOKENS` is a BUDGET failure, not a bad model: a reasoning model
        // spends `maxOutputTokens` on its thinking tokens first, so a tight
        // ceiling returns an empty or truncated part. It used to be logged as
        // a generic invalid_output, which hid the cause across 14 of 49 live
        // missions.
        console.error(
          finishReason === "MAX_TOKENS"
            ? `[${this.label}] Gemini hit maxOutputTokens before emitting JSON — raise the budget (degrade: invalid_output)`
            : `[${this.label}] Gemini response carried no text part (finishReason=${String(
                finishReason ?? "none",
              )}) (degrade: invalid_output)`,
        );
        outcome = "invalid_output";
        return { ok: false, reason: "invalid_output" };
      }
      outcome = "text_received";
      return { ok: true, text };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      const reason: GeminiDegradeReason = aborted ? "timeout" : "exception";
      console.error(
        `[${this.label}] Gemini call failed${aborted ? " (timeout)" : ""} (degrade: ${reason}):`,
        error,
      );
      outcome = reason;
      return { ok: false, reason };
    } finally {
      emitGeminiUsage(this.onUsage, {
        model,
        durationMs: Math.max(0, Date.now() - startedAt),
        maxOutputTokens: request.maxOutputTokens,
        outcome,
        usage,
      });
    }
  }
}

/**
 * Tolerant JSON extraction shared by every caller: strips code fences, then
 * parses; falls back to the outermost balanced braces when the model wrapped
 * the payload in prose. `null` on junk.
 */
export function parseGeminiJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
