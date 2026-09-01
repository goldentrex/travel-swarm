/**
 * The model ladder, and its memory of which models are out of quota.
 *
 * Why this exists: the project's Gemini key allows **20 requests per day** on
 * the `-flash` tiers and **500** on the `-lite` tiers. A swarm mission spends
 * two Gemini calls, so a flash-only setup covers about ten missions a day and
 * every later one silently degrades to the deterministic rail — which is
 * exactly what was happening. The ladder leads with the capable model and falls
 * to tiers that still have room.
 *
 * The memory matters just as much: re-asking a model that answered 429 a minute
 * ago spends a call, and its latency, to rediscover what we already knew.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  GEMINI_MODEL_CASCADE,
  modelLadder,
  noteModelExhausted,
  noteModelHealthy,
  resetModelCooldowns,
} from "@/agents/geminiCascade";

describe("Gemini model ladder", () => {
  beforeEach(() => resetModelCooldowns());

  it("leads with the most capable model, then the high-quota tiers", () => {
    const ladder = modelLadder();
    expect(ladder[0]).toBe(GEMINI_MODEL_CASCADE[0]);
    // Every fallback is a lite tier — those are the ones with 500 RPD.
    expect(ladder.slice(1).every((m) => m.includes("lite"))).toBe(true);
  });

  it("honours an explicit model override at the front", () => {
    const ladder = modelLadder("gemini-custom");
    expect(ladder[0]).toBe("gemini-custom");
    // …without losing the fallbacks behind it.
    expect(ladder).toContain(GEMINI_MODEL_CASCADE[1]);
  });

  it("never lists a model twice when the override is already on the ladder", () => {
    const ladder = modelLadder(GEMINI_MODEL_CASCADE[1]);
    expect(new Set(ladder).size).toBe(ladder.length);
    expect(ladder[0]).toBe(GEMINI_MODEL_CASCADE[1]);
  });

  it("moves an exhausted model to the back instead of asking it first", () => {
    const first = GEMINI_MODEL_CASCADE[0];
    noteModelExhausted(first);
    const ladder = modelLadder();
    expect(ladder[0]).not.toBe(first);
    // Demoted, not deleted — see the all-exhausted case below.
    expect(ladder).toContain(first);
  });

  it("still returns every model when they are ALL cooling", () => {
    // A stale cooldown must never turn into "no LLM at all".
    for (const model of GEMINI_MODEL_CASCADE) noteModelExhausted(model);
    expect(modelLadder()).toHaveLength(GEMINI_MODEL_CASCADE.length);
  });

  it("backs off further each time the same model is exhausted again", () => {
    const model = GEMINI_MODEL_CASCADE[0];
    const t0 = 1_000_000;
    noteModelExhausted(model, t0);
    // First strike: still cooling 4 minutes later, ready after 6.
    expect(modelLadder(undefined, t0 + 4 * 60_000)[0]).not.toBe(model);
    expect(modelLadder(undefined, t0 + 6 * 60_000)[0]).toBe(model);

    // Exhausted again ⇒ a longer wait than the first one.
    noteModelExhausted(model, t0);
    expect(modelLadder(undefined, t0 + 6 * 60_000)[0]).not.toBe(model);
  });

  it("a healthy answer clears the model's cooldown immediately", () => {
    const model = GEMINI_MODEL_CASCADE[0];
    noteModelExhausted(model);
    expect(modelLadder()[0]).not.toBe(model);
    noteModelHealthy(model);
    expect(modelLadder()[0]).toBe(model);
  });
});
