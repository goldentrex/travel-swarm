/**
 * Isolated demo Worker for the Nexus Swarm hackathon showcase.
 *
 * Its OWN Worker (like the supabase-proxy), deliberately not a route on the
 * site's Worker: demo traffic must never be able to affect production, and a
 * bad web deploy must never take the demo down (and vice versa).
 *
 * Only `/api/hackathon/*` is exposed, behind a bearer-token gate. Delegation
 * goes to the shared handleHackathonRequest module — the same code path the
 * production server mounts — so the demo never drifts from the real API.
 */

import { handleHackathonRequest } from "../../../src/lib/hackathonApi";

/** Tiny structured-error helper: every code path returns JSON, never HTML. */
function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(
    request: Request,
    env: { SWARM_DEMO_TOKEN?: string },
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    // 1. Only the hackathon prefix is exposed; everything else is a 404 JSON.
    if (!new URL(request.url).pathname.startsWith("/api/hackathon/")) {
      return jsonError(404, "not_found", "Only /api/hackathon/* is served by this Worker.");
    }

    // 2. Fail-closed: without the secret configured, the demo refuses to run.
    if (!env.SWARM_DEMO_TOKEN) {
      return jsonError(503, "not_configured", "This demo Worker has not been configured yet.");
    }

    // 3. Exact bearer-token match required (no timing-sensitive parsing, but
    //    strict equality keeps the gate trivially auditable).
    if (request.headers.get("Authorization") !== `Bearer ${env.SWARM_DEMO_TOKEN}`) {
      return jsonError(401, "unauthorized", "A valid Authorization header is required.");
    }

    // 4. Delegate to the shared hackathon API; wrap in try/catch so nothing
    //    ever throws outward — errors become a structured 500 JSON. The
    //    execution context enables the async REAL-trip mission path
    //    (state "processing" + ctx.waitUntil pipeline continuation).
    try {
      const res = await handleHackathonRequest(request, ctx);
      // 5. Copy the response and force no-store (live demo state, never cached).
      const out = new Response(res.body, res);
      out.headers.set("Cache-Control", "no-store");
      return out;
    } catch (err) {
      console.error("[swarm-demo] delegation failed", err);
      return jsonError(500, "internal_error", "Unexpected error in the demo Worker.");
    }
  },
};
