/**
 * The layer that decides what is possible, pinned against the venues that
 * produced the measurements behind it.
 *
 * Every case here is a real lookup from 2026-09-18, not an invention: the
 * names, the matched entities and the distances are what Google returned.
 */

import { describe, it, expect, vi } from "vitest";
import { VenueHours, decideFromHours, isConfidentMatch } from "@/core/sanity/venueHours";

describe("did Google answer about the place we meant?", () => {
  it("refuses a match that adds a qualifier we never asked for", () => {
    // THE case. "Observation Deck" names two decks fifteen metres apart:
    // North closes at 17:30, South runs to 22:00. Google answered about North
    // and was right about North — but the traveller had not said which, so
    // cancelling their 21:00 visit would have been wrong.
    expect(
      isConfidentMatch(
        "Tokyo Metropolitan Government Building Observation Deck",
        "North Observation Deck, Tokyo Metropolitan Government Building No. 1",
        15,
      ),
    ).toBe(false);
  });

  it("accepts the same qualifier when we asked for it", () => {
    expect(
      isConfidentMatch(
        "Tokyo Metropolitan Government Building South Observatory",
        "South Observatory, Tokyo Metropolitan Government Building",
        15,
      ),
    ).toBe(true);
  });

  it("accepts a real match that is merely worded differently", () => {
    // Both live results: the itinerary's wording is never the signboard's.
    expect(isConfidentMatch("Rules Restaurant London", "Rules", 143)).toBe(true);
  });

  it("refuses a same-name venue across town", () => {
    expect(isConfidentMatch("Rules Restaurant London", "Rules", 900)).toBe(false);
  });

  it("refuses a match that shares only a common word", () => {
    // "Tokyo" matches half of Tokyo.
    expect(isConfidentMatch("Tokyo Skytree", "Tokyo Central Post Office", 80)).toBe(false);
  });

  it("treats an unresolved venue as unmatched, never as closed", () => {
    expect(isConfidentMatch("Biku Seminyak", null, null)).toBe(false);
  });
});

describe("what the engine does with a schedule", () => {
  const verdict = (over: Partial<Parameters<typeof decideFromHours>[0] & object> = {}) =>
    ({
      nodeId: "a",
      openAtSlot: false,
      opensInMinutes: null,
      closingTime: null,
      matchedName: "Rules",
      matchedDistanceM: 143,
      matchedTypes: ["restaurant", "bar"],
      publicSpace: false,
      nameConfident: true,
      ...over,
    }) as NonNullable<Parameters<typeof decideFromHours>[0]>;

  const at = (hhmm: string) => Date.parse(`2026-11-13T${hhmm}:00.000Z`);

  it("does nothing when the doors are open", () => {
    expect(decideFromHours(verdict({ openAtSlot: true }), "Rules", at("13:00"))).toEqual({
      action: "keep",
    });
  });

  it("does nothing when the venue is unknown — silence is not a closure", () => {
    // Biku Seminyak did not resolve. It is open until 23:00 in reality, and an
    // engine that read "unresolved" as "closed" would have cancelled dinner.
    expect(decideFromHours(undefined, "Biku Seminyak", at("21:15"))).toEqual({ action: "keep" });
    expect(decideFromHours(verdict({ openAtSlot: null }), "Biku", at("21:15"))).toEqual({
      action: "keep",
    });
  });

  it("moves a booking to the hour the doors actually open", () => {
    // Rules at 08:00: shut, opens at 12:00 — four hours later, same day.
    const outcome = decideFromHours(verdict({ opensInMinutes: 240 }), "Rules", at("08:00"));
    expect(outcome.action).toBe("move");
    if (outcome.action === "move") {
      expect(new Date(outcome.atMs).toISOString()).toBe("2026-11-13T12:00:00.000Z");
      expect(outcome.reason).toContain("does not open until then");
    }
  });

  it("cancels only when the doors do not open again that day", () => {
    const outcome = decideFromHours(verdict({ opensInMinutes: 15 * 60 }), "Rules", at("20:00"));
    expect(outcome.action).toBe("drop");
    if (outcome.action === "drop") expect(outcome.reason).toContain("does not reopen today");
  });

  it("never cancels on a schedule that may belong to the place next door", () => {
    // The North deck again: real hours, wrong entity. The traveller keeps the
    // booking and is told what we checked.
    const outcome = decideFromHours(
      verdict({
        nameConfident: false,
        matchedName: "North Observation Deck, Tokyo Metropolitan Government Building No. 1",
        opensInMinutes: 12 * 60,
      }),
      "Tokyo Metropolitan Government Building Observation Deck",
      at("21:00"),
    );
    expect(outcome.action).toBe("flag");
    if (outcome.action === "flag") {
      expect(outcome.reason).toContain("North Observation Deck");
      expect(outcome.reason).toContain("may not be the same place");
    }
  });
});

describe("a square is not a shop", () => {
  /**
   * Live on 2026-09-18. "Evening Stroll around Covent Garden Piazza" resolved
   * to Covent Garden at 0 m — correctly — and Google reported it shut until
   * 11:00. True of the market; the piazza around it never closes, and a 21:30
   * stroll was cancelled on it.
   *
   * The name check could not catch this: "Covent Garden" sits inside the asked
   * name exactly as "Rules" sits inside "Rules Restaurant London". The TYPES
   * are what tell them apart — these are the real lists Google returned.
   */
  const coventGarden = {
    nodeId: "a",
    openAtSlot: false as const,
    opensInMinutes: 13 * 60 + 30,
    closingTime: null,
    matchedName: "Covent Garden",
    matchedDistanceM: 0,
    matchedTypes: [
      "shopping_mall",
      "historical_landmark",
      "market",
      "historical_place",
      "point_of_interest",
      "establishment",
    ],
    publicSpace: true,
    nameConfident: true,
  };

  it("never cancels a walk through a landmark because its shops shut", () => {
    const outcome = decideFromHours(
      coventGarden,
      "Evening Stroll around Covent Garden Piazza",
      Date.parse("2026-11-14T21:30:00.000Z"),
    );
    expect(outcome.action).toBe("flag");
    if (outcome.action === "flag") {
      expect(outcome.reason).toContain("the place itself");
    }
  });

  it("still cancels a restaurant, which really does lock its door", () => {
    // Biku's own type list, from the same live lookup: no landmark anywhere.
    const outcome = decideFromHours(
      {
        ...coventGarden,
        matchedName: "Biku",
        matchedTypes: ["restaurant", "western_restaurant", "tea_house", "bar", "cafe"],
        publicSpace: false,
        opensInMinutes: 11 * 60,
      },
      "Biku Seminyak",
      Date.parse("2026-12-03T23:40:00.000Z"),
    );
    expect(outcome.action).toBe("drop");
  });
});

describe("the lookup itself", () => {
  const query = (nodeId: string, name: string) => ({
    nodeId,
    name,
    lat: 51.5121,
    lng: -0.1235,
    atIso: "2026-11-13T08:00:00.000Z",
  });

  function respondWith(hours: Record<string, unknown>, calls: unknown[][] = []) {
    return vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      calls.push([JSON.parse(init.body ?? "{}")]);
      return new Response(JSON.stringify({ hours }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("asks for verification, because it may cancel on the answer", async () => {
    const calls: unknown[][] = [];
    const hours = new VenueHours({
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon",
      userToken: "user",
      fetchImpl: respondWith({}, calls),
    });
    await hours.lookup([query("a", "Rules Restaurant London")]);
    const sent = (calls[0][0] as { places: Array<{ verify?: boolean; at?: string }> }).places[0];
    expect(sent.verify).toBe(true);
    expect(sent.at).toBe("2026-11-13T08:00:00.000Z");
  });

  it("chunks past the endpoint's cap instead of losing venues silently", async () => {
    // `place-hours` slices at 20 and says nothing about the rest; an
    // unchecked venue is the gap this layer exists to close.
    const calls: unknown[][] = [];
    const hours = new VenueHours({
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon",
      userToken: "user",
      fetchImpl: respondWith({}, calls),
    });
    await hours.lookup(Array.from({ length: 23 }, (_, i) => query(`n${i}`, `Venue ${i}`)));
    expect(calls).toHaveLength(2);
    expect((calls[0][0] as { places: unknown[] }).places).toHaveLength(20);
    expect((calls[1][0] as { places: unknown[] }).places).toHaveLength(3);
  });

  it("leaves every venue unknown when the lookup fails", async () => {
    const hours = new VenueHours({
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon",
      userToken: "user",
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect((await hours.lookup([query("a", "Rules")])).size).toBe(0);
  });

  it("carries the matched entity through, so a caller can judge it", async () => {
    const hours = new VenueHours({
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon",
      userToken: "user",
      fetchImpl: respondWith({
        a: {
          open_now: false,
          opens_in_minutes: 240,
          matched_name: "Rules",
          matched_distance_m: 143,
          matched_types: ["restaurant", "bar"],
        },
      }),
    });
    const verdict = (await hours.lookup([query("a", "Rules Restaurant London")])).get("a");
    expect(verdict?.openAtSlot).toBe(false);
    expect(verdict?.matchedName).toBe("Rules");
    expect(verdict?.nameConfident).toBe(true);
  });
});

// ─────────── the whole chain, from a graph node to a moved booking

describe("the engine acts on the venue's own schedule", () => {
  it("moves a breakfast the restaurant does not serve, and cancels nothing it cannot prove", async () => {
    const { OrchestratorAgent } = await import("@/agents/orchestrator/OrchestratorAgent");
    const { ItineraryGraph } = await import("@/core/dag");
    const { VenueHours: Provider } = await import("@/core/sanity/venueHours");
    const DAY = "2026-11-13";

    const graph = new ItineraryGraph();
    graph.addNode({
      id: "flight-0",
      type: "flight",
      flightNumber: "BA001",
      origin: "SIN",
      destination: "LHR",
      departureTime: Date.parse(`${DAY}T01:00:00Z`),
      arrivalTime: Date.parse(`${DAY}T06:00:00Z`),
      scheduledTime: Date.parse(`${DAY}T01:00:00Z`),
      status: "on_track",
      dependsOn: [],
      arrivalLocationId: "LHR",
    });
    // Rules, at a slot it does not serve — with its real coordinate.
    graph.addNode({
      id: "activity-rules",
      type: "activity",
      name: "Rules Restaurant London",
      durationMinutes: 90,
      scheduledTime: Date.parse(`${DAY}T08:00:00Z`),
      status: "on_track",
      dependsOn: ["flight-0"],
      coordinates: { lat: 51.5121, lng: -0.1235 },
    });

    // The live answer of 2026-09-18: shut at 08:00, doors at 12:00.
    const provider = new Provider({
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon",
      userToken: "traveller",
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            hours: {
              "activity-rules": {
                open_now: false,
                opens_in_minutes: 240,
                matched_name: "Rules",
                matched_distance_m: 143,
              },
            },
          }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch,
    });

    const activityAgent = {
      proposeRescheduling: async (
        requests: Array<{ activityNodeId: string; activityName: string }>,
      ) =>
        requests.map((request) => ({
          activityNodeId: request.activityNodeId,
          activityName: request.activityName,
          action: "reschedule" as const,
          newTime: `${DAY}T08:00:00.000Z`,
          penalty: 0,
          currency: "GBP",
        })),
    };

    const orchestrator = new OrchestratorAgent(
      graph,
      null,
      null,
      null,
      activityAgent as never,
      null,
      null,
      null,
      null,
      provider,
    );
    const { plans, trace } = await orchestrator.resolveDisruptionMulti({
      nodeId: "flight-0",
      delay: 5 * 60,
      description: "Flight BA001 delayed",
    });

    const rules = plans[0].proposed_resolution.rescheduled_activities.find((a) =>
      a.name.includes("Rules"),
    );
    // Moved, not cancelled — and moved to where BOTH constraints are satisfied.
    // The doors open at 12:00; the traveller only reaches London at 13:20
    // (11:00 landing + immigration, bags and the ride in). The later of the two
    // wins, which is the whole point of letting facts stack instead of
    // fighting: the published schedule rescued the booking from an 08:00 slot
    // the restaurant does not serve, and the arrival buffer then placed it.
    expect(rules?.action).toBe("reschedule");
    expect(rules?.new_time_iso).toBe(`${DAY}T13:20:00.000Z`);
    expect(trace.some((t) => t.startsWith("hours:"))).toBe(true);
  });
});
