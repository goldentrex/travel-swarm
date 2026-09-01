/**
 * The per-user gate on the real-trip swarm rail — exercised for REAL.
 *
 * Every other hackathon suite stubs `@/lib/swarmAuth` so it can test the swarm
 * rails as an owner. This one does not: it drives `handleHackathonRequest`
 * through the genuine gate, because the whole point of the gate is what it
 * REFUSES.
 *
 * What it protects: the shared `SWARM_DEMO_TOKEN` bearer ships inside the iOS
 * binary, so it identifies the app, not the person. Behind it the rail reads
 * and writes any trip through an RLS-bypassing service-role client. Without
 * this gate, extracting that literal plus knowing a trip uuid was enough to
 * read and rewrite someone else's trip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Controllable stand-in for the service-role client the gate queries. Chainable
 * exactly as far as `checkTripAccess` chains: from → select → eq(→eq) → is →
 * maybeSingle.
 */
const db = {
  tripOwner: null as string | null,
  share: null as { user: string; level: "VIEW" | "EDIT" | null; kind?: string } | null,
};

vi.mock("@/integrations/supabase/client.server", () => {
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      select: () => chain,
      is: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => {
        if (table === "trips") {
          return { data: db.tripOwner ? { user_id: db.tripOwner } : null, error: null };
        }
        const wanted = filters.to_user_id;
        return {
          data:
            db.share && db.share.user === wanted
              ? { access_level: db.share.level, kind: db.share.kind ?? "SHARE" }
              : null,
          error: null,
        };
      },
    };
    return chain;
  };
  return { supabaseAdmin: { from: builder } };
});

vi.mock("@/lib/swarmSessionStore", async () => {
  const { makeSwarmSessionStoreMock } = await import("./helpers/realTripFixture");
  return makeSwarmSessionStoreMock({ persistent: true });
});

vi.mock("@/lib/swarmTripContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarmTripContext")>();
  const { makeSwarmTripContextMock } = await import("./helpers/realTripFixture");
  return makeSwarmTripContextMock(actual);
});

import { handleHackathonRequest } from "@/lib/hackathonApi";
import { USER_TOKEN_HEADER } from "@/lib/swarmAuth";
import {
  BEARER_TOKEN,
  REAL_TRIP_UUID,
  enableRealRailEnv,
  realTripContent,
  type FakeSwarmTripContextHooks,
} from "./helpers/realTripFixture";
import * as tripContextModule from "@/lib/swarmTripContext";

const tripCtx = tripContextModule as unknown as FakeSwarmTripContextHooks;

const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

/** Mission request; `userToken` null ⇒ the header is omitted entirely. */
function mission(userToken: string | null): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${BEARER_TOKEN}`,
  };
  if (userToken !== null) headers[USER_TOKEN_HEADER] = `Bearer ${userToken}`;
  return new Request("http://localhost/api/hackathon/mission/assess", {
    method: "POST",
    headers,
    body: JSON.stringify({
      intent: "I missed my flight, reroute me",
      tripId: REAL_TRIP_UUID,
      language: "en",
    }),
  });
}

/**
 * Stand in for Supabase: `/auth/v1/user` resolves a token to its owner, and
 * PostgREST answers the ownership + share lookups the gate makes.
 */
function stubSupabase(opts: {
  tokenOwner?: Record<string, string>;
  tripOwner?: string;
  share?: { user: string; level: "VIEW" | "EDIT" } | null;
  authDown?: boolean;
}) {
  const tokenOwner = opts.tokenOwner ?? { "owner-token": OWNER, "stranger-token": STRANGER };
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      if (opts.authDown) return new Response("upstream", { status: 500 });
      // The stub reads the token straight off the request it was handed.
      const token = (globalThis as { __lastUserToken?: string }).__lastUserToken ?? "";
      const uid = tokenOwner[token];
      return uid
        ? new Response(JSON.stringify({ id: uid }), { status: 200 })
        : new Response("no", { status: 401 });
    }
    return new Response("[]", { status: 200 });
  });
}

describe("real-trip swarm rail — per-user gate", () => {
  beforeEach(() => {
    enableRealRailEnv();
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "stub-anon";
    tripCtx.__setTripContent(REAL_TRIP_UUID, realTripContent());
    db.tripOwner = null;
    db.share = null;
  });

  /** Make `/auth/v1/user` resolve every presented token to `userId`. */
  function identifiesAs(userId: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes("/auth/v1/user")
          ? new Response(JSON.stringify({ id: userId }), { status: 200 })
          : new Response("[]", { status: 200 }),
      ),
    );
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses a caller who presents no user token at all", async () => {
    const response = await handleHackathonRequest(mission(null));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("user_token_required");
  });

  it("refuses a token Supabase does not recognise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes("/auth/v1/user")
          ? new Response("nope", { status: 401 })
          : new Response("[]", { status: 200 }),
      ),
    );
    const response = await handleHackathonRequest(mission("forged-token"));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_user_token");
  });

  it("answers 503 when the identity check cannot run — never a silent pass", async () => {
    vi.stubGlobal("fetch", stubSupabase({ authDown: true }));
    const response = await handleHackathonRequest(mission("owner-token"));
    // An authorization check that fails OPEN is not a check.
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("auth_unavailable");
  });

  it("hides someone else's trip behind the same 404 as a missing one", async () => {
    // A distinct 403 would confirm which uuids are real trips.
    identifiesAs(STRANGER);
    db.tripOwner = OWNER;
    db.share = null;
    const response = await handleHackathonRequest(mission("stranger-token"));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("unknown_trip");
  });

  it("lets the trip's owner straight through", async () => {
    identifiesAs(OWNER);
    db.tripOwner = OWNER;
    const response = await handleHackathonRequest(mission("owner-token"));
    // Past the gate: whatever the rail then answers, it is not an auth refusal.
    expect([401, 403, 503]).not.toContain(response.status);
  });

  it("a VIEW-only collaborator may look, but may not settle", async () => {
    identifiesAs(STRANGER);
    db.tripOwner = OWNER;
    db.share = { user: STRANGER, level: "VIEW" };

    // Reading the assessment is allowed…
    const read = await handleHackathonRequest(mission("stranger-token"));
    expect([401, 403, 404]).not.toContain(read.status);

    // …but approving rewrites content_json, so it needs EDIT.
    const approve = new Request("http://localhost/api/hackathon/mission", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BEARER_TOKEN}`,
        [USER_TOKEN_HEADER]: "Bearer stranger-token",
      },
      body: JSON.stringify({
        intent: "I missed my flight, reroute me",
        tripId: REAL_TRIP_UUID,
      }),
    });
    const write = await handleHackathonRequest(approve);
    expect(write.status).toBe(403);
    const body = (await write.json()) as { error?: string };
    expect(body.error).toBe("read_only_trip");
  });

  it("an EDIT collaborator may settle", async () => {
    identifiesAs(STRANGER);
    db.tripOwner = OWNER;
    db.share = { user: STRANGER, level: "EDIT" };
    const response = await handleHackathonRequest(mission("stranger-token"));
    expect([401, 403, 404]).not.toContain(response.status);
  });

  /**
   * A FAMILY invitation carries a NULL access_level by constraint — it is the
   * app's full-collaborator relationship, and every live row is one of these.
   * Reading null as "not EDIT" would lock real families out of their own trip.
   */
  it("a FAMILY member is a full collaborator despite a null access_level", async () => {
    identifiesAs(STRANGER);
    db.tripOwner = OWNER;
    db.share = { user: STRANGER, level: null, kind: "FAMILY" };
    const response = await handleHackathonRequest(mission("stranger-token"));
    expect([401, 403, 404]).not.toContain(response.status);
  });
});
