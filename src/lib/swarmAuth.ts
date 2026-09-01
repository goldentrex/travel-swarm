/**
 * Per-USER authorization for the real-trip swarm rail.
 *
 * The shared `SWARM_DEMO_TOKEN` bearer authenticates the APP, not the person
 * holding it: it ships inside the iOS binary, and every install sends the same
 * string. Behind it, `loadSwarmTrip` reads and `settlePlanOnTrip` writes any
 * trip through the RLS-bypassing service-role client. So until this module
 * existed, anyone who extracted that literal could read and rewrite any trip
 * whose uuid they knew.
 *
 * This module re-imposes, in the Worker, the same access rule the database
 * enforces for everyone else — read against the LIVE schema, where sharing sits
 * in `trip_invitations` (migration 20260701000000 folded `trip_shares` into it,
 * and no `trip_shares` table exists in the deployed database):
 *
 *     read   ⇢ trips.user_id = me  OR  an ACCEPTED invitation addressed to me
 *     write  ⇢ that invitation is a FAMILY one, or grants access_level 'EDIT'
 *
 * The caller's identity comes from their own Supabase JWT, which the app sends
 * in `X-Swarm-User-Token` alongside the app bearer. The token is verified by
 * asking Supabase who it belongs to — never by trusting a client-supplied id.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Header carrying the END USER's Supabase access token (not the app bearer). */
export const USER_TOKEN_HEADER = "X-Swarm-User-Token";

export type SwarmActor =
  | { kind: "user"; userId: string }
  /** No token at all — the caller is anonymous. */
  | { kind: "anonymous" }
  /** A token was presented but Supabase does not recognise it. */
  | { kind: "invalid" }
  /** Supabase could not be reached; the caller may well be legitimate. */
  | { kind: "unavailable" };

export type TripAccess =
  | { kind: "granted"; canEdit: boolean }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

function bearerFrom(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/^Bearer\s+/i, "").trim() || null;
}

/**
 * Resolve who is calling. NEVER throws: a transport failure resolves to
 * `unavailable` so the API can answer 503 instead of silently treating an
 * outage as an authorization pass.
 */
export async function resolveSwarmActor(request: Request): Promise<SwarmActor> {
  const token = bearerFrom(request.headers.get(USER_TOKEN_HEADER));
  if (!token) return { kind: "anonymous" };

  const url = process.env.SUPABASE_URL;
  const anonKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey) return { kind: "unavailable" };

  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) return { kind: "invalid" };
    if (!response.ok) return { kind: "unavailable" };
    const body = (await response.json()) as { id?: unknown };
    return typeof body?.id === "string" && body.id.length > 0
      ? { kind: "user", userId: body.id }
      : { kind: "invalid" };
  } catch (error) {
    console.warn("[swarm-auth] could not verify the user token:", error);
    return { kind: "unavailable" };
  }
}

/**
 * Does `userId` may read (and possibly write) `tripId`? Mirrors the database's
 * own policy rather than re-deciding it: ownership first, then an explicit
 * share row, whose `access_level` decides write.
 */
export async function checkTripAccess(tripId: string, userId: string): Promise<TripAccess> {
  try {
    const sb = supabaseAdmin as unknown as { from: (table: string) => any };

    const { data: trip, error: tripError } = await sb
      .from("trips")
      .select("user_id")
      .eq("id", tripId)
      .is("deleted_at", null)
      .maybeSingle();
    if (tripError) {
      console.warn("[swarm-auth] trip lookup failed:", tripError);
      return { kind: "unavailable" };
    }
    if (!trip) return { kind: "not_found" };
    if (trip.user_id === userId) return { kind: "granted", canEdit: true };

    // Sharing lives in `trip_invitations`, NOT `trip_shares`: migration
    // 20260701000000 folded the latter into the former and the live database
    // has no `trip_shares` table at all (querying it fails with PGRST205,
    // which this check would report as an outage). Semantics from that
    // migration's constraints: `kind='FAMILY'` carries a null access_level and
    // means a full collaborator; `kind='SHARE'` must name VIEW or EDIT.
    const { data: share, error: shareError } = await sb
      .from("trip_invitations")
      .select("kind,access_level")
      .eq("trip_id", tripId)
      .eq("to_user_id", userId)
      .eq("status", "ACCEPTED")
      .maybeSingle();
    if (shareError) {
      console.warn("[swarm-auth] share lookup failed:", shareError);
      return { kind: "unavailable" };
    }
    if (!share) return { kind: "forbidden" };
    const level = String(share.access_level ?? "").toUpperCase();
    return {
      kind: "granted",
      canEdit: String(share.kind ?? "").toUpperCase() === "FAMILY" || level === "EDIT",
    };
  } catch (error) {
    console.warn("[swarm-auth] access check threw:", error);
    return { kind: "unavailable" };
  }
}
