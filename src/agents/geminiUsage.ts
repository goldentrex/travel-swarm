/** Provider-reported usage only. Missing metadata is unknown, never zero cost.
 * No prompt, response text, API key or traveler data belongs in these events.
 * https://ai.google.dev/api/generate-content#UsageMetadata
 */
export interface GeminiUsageEvent {
  model: string;
  durationMs: number;
  maxOutputTokens: number;
  outcome:
    | "text_received"
    | "quota_429"
    | "http_error"
    | "timeout"
    | "exception"
    | "invalid_output";
  usage: Partial<
    Record<
      | "promptTokenCount"
      | "candidatesTokenCount"
      | "thoughtsTokenCount"
      | "cachedContentTokenCount"
      | "totalTokenCount",
      number
    >
  > | null;
}

export type GeminiUsageObserver = (event: GeminiUsageEvent) => void;

/** Request-scoped shared allowance. Reserve synchronously before awaiting so
 * parallel day replanning and retries cannot overspend the same final slot.
 */
export class GeminiCallBudget {
  private used = 0;
  readonly limit: number;
  /**
   * The wall-clock instant after which no model call may START.
   *
   * On Cloudflare Workers the async resolve rail runs inside
   * `ctx.waitUntil`, which "can extend execution for up to 30 seconds after
   * the response is sent"; promises still pending are then CANCELLED, with
   * no exception and no log. Measured on 2026-09-18: three missions in five
   * batteries had their last trace row 18–26 s after the ack and never
   * reached the final save — the session sat in `processing` until the
   * client gave up 240 s later. Every model stage has a deterministic rail
   * behind it, so a call that cannot finish before the cut-off is not
   * attempted: the rail answers, and the plan lands.
   */
  readonly deadlineMs: number | undefined;
  /** Why the last reservation was refused, for the trace to say so. */
  lastRefusal: "calls" | "deadline" | null = null;
  /** How many calls the deadline alone turned away. */
  deadlineRefusals = 0;
  /**
   * Calls no ordinary caller may touch, held for the one consumer that has
   * nothing to fall back on.
   *
   * Measured on a live battery of 18 missions: the liaison runs at assess and
   * the day reorganizer during resolve, so by the time the semantic critic is
   * asked the shared allowance is gone — it degraded on `quota_429` in 4 of 17
   * missions and contributed ZERO findings, while the reorganizer reached the
   * model 8 times. The critic is the only piece that can know a place is a
   * nightlife district; being served last made it the first starved.
   */
  private readonly reserved: number;

  constructor(limit: number, reserved = 0, deadlineMs?: number) {
    this.limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    this.reserved = Number.isFinite(reserved)
      ? Math.min(this.limit, Math.max(0, Math.floor(reserved)))
      : 0;
    this.deadlineMs = Number.isFinite(deadlineMs) ? deadlineMs : undefined;
  }
  /** Milliseconds left before the cut-off; Infinity without a deadline. */
  get msLeft(): number {
    return this.deadlineMs === undefined ? Number.POSITIVE_INFINITY : this.deadlineMs - Date.now();
  }
  get callsUsed(): number {
    return this.used;
  }
  /** Calls still available to an ordinary caller (the reserve excluded). */
  get openCalls(): number {
    return Math.max(0, this.limit - this.reserved - this.used);
  }
  /**
   * `privileged` callers may spend into the reserve; everyone else stops at
   * the line that protects it.
   */
  tryReserve(privileged = false, headroomMs = 0): boolean {
    // A call that would still be running at the cut-off is refused BEFORE it
    // spends a slot: the caller's per-attempt deadline is the headroom.
    if (this.deadlineMs !== undefined && Date.now() + Math.max(0, headroomMs) > this.deadlineMs) {
      this.lastRefusal = "deadline";
      this.deadlineRefusals += 1;
      return false;
    }
    const ceiling = privileged ? this.limit : this.limit - this.reserved;
    if (this.used >= ceiling) {
      this.lastRefusal = "calls";
      return false;
    }
    this.used += 1;
    this.lastRefusal = null;
    return true;
  }
}

export function readGeminiUsage(value: unknown): GeminiUsageEvent["usage"] {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const usage: NonNullable<GeminiUsageEvent["usage"]> = {};
  for (const field of [
    "promptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
    "cachedContentTokenCount",
    "totalTokenCount",
  ] as const) {
    const count = raw[field];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
      usage[field] = count;
  }
  return Object.keys(usage).length ? usage : null;
}

/** An observer must never turn a successful model call into a retry. */
export function emitGeminiUsage(
  observer: GeminiUsageObserver | undefined,
  event: GeminiUsageEvent,
): void {
  try {
    observer?.(event);
  } catch {
    /* Telemetry is best effort. */
  }
}

/** Task-specific routing can be rehearsed without changing the default ladder.
 * Keep explicit constructor overrides authoritative for tests and callers.
 */
export function configuredGeminiModel(
  task: "liaison" | "dayReorg" | "critic",
  fallback: string,
): string {
  const key =
    task === "liaison"
      ? "SWARM_GEMINI_LIAISON_MODEL"
      : task === "critic"
        ? "SWARM_GEMINI_CRITIC_MODEL"
        : "SWARM_GEMINI_DAY_REORG_MODEL";
  const configured = typeof process !== "undefined" ? process.env[key]?.trim() : undefined;
  return configured || fallback;
}

export function geminiUsageLogger(
  resolutionId: string,
  agent: "liaison" | "activity",
): GeminiUsageObserver {
  return (event) =>
    console.info(JSON.stringify({ event: "swarm_model_usage", resolutionId, agent, ...event }));
}
