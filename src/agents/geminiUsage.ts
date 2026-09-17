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
  constructor(limit: number) {
    this.limit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  }
  get callsUsed(): number {
    return this.used;
  }
  tryReserve(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
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
export function configuredGeminiModel(task: "liaison" | "dayReorg", fallback: string): string {
  const key = task === "liaison" ? "SWARM_GEMINI_LIAISON_MODEL" : "SWARM_GEMINI_DAY_REORG_MODEL";
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
