/**
 * WS1 — swarmSessionStore unit tests against the REAL store implementation.
 *
 * Only the Supabase admin client (`client.server`) is replaced by a fake
 * chainable query builder backed by an in-memory row map, so the actual
 * tiering logic (DB first, memory fallback, degraded stamping, conditional
 * UPDATE one-shot discipline) is exercised end-to-end.
 *
 * Covers:
 *  - item 1: saveSwarmSession stamps degraded + "session_store_memory" on
 *    upsert failure (and the memory tier still serves the session).
 *  - item 2: getSwarmSession consults the memory tier after a
 *    successful-but-empty DB read.
 *  - item 3: getSwarmSessionIgnoringExpiry sees expired rows (both tiers).
 *  - item 4: cancelSwarmSession atomic conditional transition, idempotency,
 *    terminal-state noop, unknown id, store error → { error }, memory-only
 *    tier behaviour.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------- fake supabase client

type Row = Record<string, unknown>;

vi.mock("@/integrations/supabase/client.server", () => {
  const rows = new Map<string, Row>();
  let upsertError: { message: string } | null = null;
  let updateError: { message: string } | null = null;
  let selectError: { message: string } | null = null;
  let clientAvailable = true;

  interface Filter {
    col: string;
    op: "eq" | "gt" | "in";
    value: unknown;
  }

  function matches(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      const v = row[f.col];
      if (f.op === "eq") return v === f.value;
      if (f.op === "gt") return typeof v === "string" && v > (f.value as string);
      return Array.isArray(f.value) && (f.value as unknown[]).includes(v);
    });
  }

  function makeBuilder(): unknown {
    const filters: Filter[] = [];
    let pendingUpdate: Row | null = null;
    let selectCalled = false;

    const builder: Record<string, unknown> = {
      select(_cols?: string) {
        selectCalled = true;
        return builder;
      },
      eq(col: string, value: unknown) {
        filters.push({ col, op: "eq", value });
        return builder;
      },
      gt(col: string, value: unknown) {
        filters.push({ col, op: "gt", value });
        return builder;
      },
      in(col: string, value: unknown) {
        filters.push({ col, op: "in", value });
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      update(values: Row) {
        pendingUpdate = values;
        return builder;
      },
      upsert(values: Row) {
        if (upsertError) return Promise.resolve({ data: null, error: upsertError });
        rows.set(values.id as string, { ...values });
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle() {
        if (selectError) return Promise.resolve({ data: null, error: selectError });
        const matched = [...rows.values()].filter((row) => matches(row, filters));
        if (matched.length === 0) return Promise.resolve({ data: null, error: null });
        if (matched.length === 1) return Promise.resolve({ data: matched[0], error: null });
        return Promise.resolve({
          data: null,
          error: { message: "multiple rows matched for maybeSingle" },
        });
      },
      // Awaitable finalization — mirrors PostgREST builder semantics where
      // `await client.from(t).update(...).eq(...)` (with/without .select)
      // executes the statement.
      then(
        resolve: (value: { data: Row[] | null; error: { message: string } | null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) {
        const outcome = (() => {
          if (pendingUpdate) {
            if (updateError) return { data: null, error: updateError };
            const matched = [...rows.values()].filter((row) => matches(row, filters));
            for (const row of matched) Object.assign(row, pendingUpdate);
            return { data: selectCalled ? matched : null, error: null };
          }
          if (selectError) return { data: null, error: selectError };
          return {
            data: [...rows.values()].filter((row) => matches(row, filters)),
            error: null,
          };
        })();
        return Promise.resolve(outcome).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    get from() {
      if (!clientAvailable) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY missing");
      return () => makeBuilder();
    },
  };

  return {
    supabaseAdmin: admin,
    __db: rows,
    __setUpsertError(error: { message: string } | null): void {
      upsertError = error;
    },
    __setUpdateError(error: { message: string } | null): void {
      updateError = error;
    },
    __setSelectError(error: { message: string } | null): void {
      selectError = error;
    },
    __setClientAvailable(value: boolean): void {
      clientAvailable = value;
    },
    __clear(): void {
      rows.clear();
      upsertError = null;
      updateError = null;
      selectError = null;
      clientAvailable = true;
    },
  };
});

import * as serverModule from "@/integrations/supabase/client.server";
import type { ResolutionPlan } from "@/agents";
import {
  cancelSwarmSession,
  claimSwarmSessionForResolve,
  claimSwarmSessionForBooking,
  saveSwarmSettlementReceipt,
  settlementOperation,
  getSwarmSession,
  getSwarmSessionIgnoringExpiry,
  markSwarmSessionSettled,
  probeSwarmStoreHealth,
  saveSwarmSession,
  saveSwarmSessionIfState,
  swarmStoreIsPersistent,
} from "@/lib/swarmSessionStore";

const dbHooks = serverModule as unknown as {
  __db: Map<string, Row>;
  __setUpsertError(error: { message: string } | null): void;
  __setUpdateError(error: { message: string } | null): void;
  __setSelectError(error: { message: string } | null): void;
  __setClientAvailable(value: boolean): void;
  __clear(): void;
};

const FUTURE = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();
const PAST = () => new Date(Date.now() - 60 * 1000).toISOString();

// The store module keeps its memory tier for the whole file — use unique ids.
let seq = 0;
const nextId = () => `res_store_${++seq}`;

beforeEach(() => {
  dbHooks.__clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ---------------------------------------------------- item 1: degraded save

describe("saveSwarmSession (WS1 item 1)", () => {
  it("a clean save lands in the DB tier and reads back undegraded", async () => {
    const id = nextId();
    const ok = await saveSwarmSession({ id, state: "proposal_ready", expires_at: FUTURE() });
    expect(ok).toBe(true);
    expect(dbHooks.__db.get(id)?.state).toBe("proposal_ready");

    const record = await getSwarmSession(id);
    expect(record).not.toBeNull();
    expect(record?.degraded).toBe(false);
    expect(record?.degraded_reason).toBeUndefined();
  });

  it("upsert failure stamps degraded + session_store_memory; memory tier still serves it", async () => {
    const id = nextId();
    dbHooks.__setUpsertError({ message: "simulated supabase outage" });

    const ok = await saveSwarmSession({ id, state: "proposal_ready", expires_at: FUTURE() });
    expect(ok).toBe(true);
    // Nothing reached the DB tier.
    expect(dbHooks.__db.has(id)).toBe(false);

    const record = await getSwarmSession(id);
    expect(record).not.toBeNull();
    expect(record?.degraded).toBe(true);
    expect(record?.degraded_reason).toBe("session_store_memory");
  });

  it("carries an explicit degraded_reason from the input through to the record", async () => {
    const id = nextId();
    // Memory tier only — degraded_reason is a diagnostics field, not a
    // persisted column, so read it back through the memory tier.
    dbHooks.__setClientAvailable(false);
    await saveSwarmSession({
      id,
      state: "awaiting_approval",
      degraded: true,
      degraded_reason: "provider_offline",
      expires_at: FUTURE(),
    });
    const record = await getSwarmSession(id);
    expect(record?.degraded).toBe(true);
    expect(record?.degraded_reason).toBe("provider_offline");
  });
});

// ------------------------- item 2: empty DB read consults the memory tier

describe("getSwarmSession memory fallback (WS1 item 2)", () => {
  it("a successful-but-empty DB read falls back to the memory tier", async () => {
    const id = nextId();
    // Mirror write fails ⇒ memory-only session.
    dbHooks.__setUpsertError({ message: "mirror down" });
    await saveSwarmSession({ id, state: "gathering_preferences", expires_at: FUTURE() });
    dbHooks.__setUpsertError(null);

    // DB read now succeeds with zero rows — the memory tier must answer.
    expect(dbHooks.__db.has(id)).toBe(false);
    const record = await getSwarmSession(id);
    expect(record?.id).toBe(id);
    expect(record?.state).toBe("gathering_preferences");
  });

  it("a DB read ERROR also falls back to the memory tier", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "proposal_ready", expires_at: FUTURE() });
    dbHooks.__setSelectError({ message: "simulated read failure" });

    const record = await getSwarmSession(id);
    expect(record?.id).toBe(id);
    dbHooks.__setSelectError(null);
  });

  it("unknown ids stay null (neither tier has them)", async () => {
    expect(await getSwarmSession("res_store_ghost")).toBeNull();
  });
});

// ---------------------------------------- item 3: ignoring-expiry lookup

describe("getSwarmSessionIgnoringExpiry (WS1 item 3)", () => {
  it("expired DB row: getSwarmSession → null, ignoring-expiry → the record", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "proposal_ready", expires_at: PAST() });
    expect(dbHooks.__db.get(id)?.expires_at).toBeDefined();

    expect(await getSwarmSession(id)).toBeNull();
    const lookup = await getSwarmSessionIgnoringExpiry(id);
    expect(lookup).not.toBeNull();
    expect(lookup && "record" in lookup ? lookup.record.state : "missing").toBe("proposal_ready");
  });

  it("sees expired memory-only sessions too", async () => {
    const id = nextId();
    dbHooks.__setUpsertError({ message: "mirror down" });
    dbHooks.__setClientAvailable(false); // force the memory tier for reads too
    await saveSwarmSession({ id, state: "awaiting_approval", expires_at: PAST() });

    // The ignoring-expiry lookup sees it BEFORE the normal read evicts it.
    const lookup = await getSwarmSessionIgnoringExpiry(id);
    expect(lookup && "record" in lookup ? lookup.record.id : "missing").toBe(id);

    // A normal read treats it as gone (and evicts the memory entry).
    expect(await getSwarmSession(id)).toBeNull();
  });

  it("returns null for genuinely unknown ids", async () => {
    expect(await getSwarmSessionIgnoringExpiry("res_store_nowhere")).toBeNull();
  });
});

// ---------------------------------------------- item 4: cancelSwarmSession

describe("cancelSwarmSession (WS1 item 4)", () => {
  it("cancels an active session on the DB tier and aligns the memory tier", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "proposal_ready", expires_at: FUTURE() });

    const result = await cancelSwarmSession(id);
    expect(result).toEqual({ cancelled: true, state: "expired" });
    expect(dbHooks.__db.get(id)?.state).toBe("expired");
    // Memory tier aligned — ignoring-expiry read reports expired.
    const lookup = await getSwarmSessionIgnoringExpiry(id);
    expect(lookup && "record" in lookup ? lookup.record.state : "missing").toBe("expired");
  });

  it("is idempotent: a second cancel is a noop reporting state expired", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "processing", expires_at: FUTURE() });
    expect((await cancelSwarmSession(id)).cancelled).toBe(true);

    const again = await cancelSwarmSession(id);
    expect(again).toEqual({ cancelled: false, state: "expired" });
    expect(dbHooks.__db.get(id)?.state).toBe("expired");
  });

  it("cancelling a settled session is a noop reporting its state", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "proposal_ready", expires_at: FUTURE() });
    await markSwarmSessionSettled(id);

    const result = await cancelSwarmSession(id);
    expect(result).toEqual({ cancelled: false, state: "settled" });
    expect(dbHooks.__db.get(id)?.state).toBe("settled");
  });

  it("cancelling an unknown id returns { cancelled: false } without a state", async () => {
    expect(await cancelSwarmSession("res_store_unknown")).toEqual({ cancelled: false });
  });

  it("a failed conditional UPDATE surfaces { error } and leaves the row untouched", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "proposal_ready", expires_at: FUTURE() });
    dbHooks.__setUpdateError({ message: "simulated update outage" });

    const result = await cancelSwarmSession(id);
    expect(result.cancelled).toBe(false);
    expect(result.error).toBe("simulated update outage");
    expect(dbHooks.__db.get(id)?.state).toBe("proposal_ready");
  });

  it("memory-only tier (no Supabase): same conditional transition in-process", async () => {
    const id = nextId();
    dbHooks.__setClientAvailable(false);
    expect(swarmStoreIsPersistent()).toBe(false);
    await saveSwarmSession({ id, state: "gathering_preferences", expires_at: FUTURE() });

    const result = await cancelSwarmSession(id);
    expect(result).toEqual({ cancelled: true, state: "expired" });

    const again = await cancelSwarmSession(id);
    expect(again).toEqual({ cancelled: false, state: "expired" });
    expect(await getSwarmSessionIgnoringExpiry(id)).toMatchObject({
      record: { state: "expired" },
    });
  });

  it("does not cancel from an already-approved session (one-shot booking wins)", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "awaiting_approval", expires_at: FUTURE() });
    dbHooks.__db.set(id, { ...(dbHooks.__db.get(id) as Row), state: "approved" });

    const result = await cancelSwarmSession(id);
    expect(result.cancelled).toBe(false);
    expect(dbHooks.__db.get(id)?.state).toBe("approved");
  });

  it("cancels a memory-only degraded session when the DB client IS configured (no DB row)", async () => {
    // Mirror write fails ⇒ the session lives ONLY in the memory tier
    // (degraded_reason "session_store_memory") while the admin client stays
    // configured — the 0-row DB UPDATE must fall through to the memory tier.
    const id = nextId();
    dbHooks.__setUpsertError({ message: "mirror down" });
    await saveSwarmSession({ id, state: "processing", expires_at: FUTURE() });
    dbHooks.__setUpsertError(null);
    expect(dbHooks.__db.has(id)).toBe(false);

    const result = await cancelSwarmSession(id);
    expect(result).toEqual({ cancelled: true, state: "expired" });

    // The memory-tier record transitioned; no DB row materialized.
    const lookup = await getSwarmSessionIgnoringExpiry(id);
    expect(lookup && "record" in lookup ? lookup.record.state : "missing").toBe("expired");
    expect(dbHooks.__db.has(id)).toBe(false);

    // Idempotent second cancel — terminal/noop semantics preserved.
    expect(await cancelSwarmSession(id)).toEqual({ cancelled: false, state: "expired" });
  });
});

// ----------------- cancel-vs-final-upsert race: saveSwarmSessionIfState

describe("saveSwarmSessionIfState (state-guarded final upsert)", () => {
  it("overwrites a session still in an allowed state (DB tier)", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "processing", expires_at: FUTURE() });

    const ok = await saveSwarmSessionIfState({
      id,
      state: "proposal_ready",
      expires_at: FUTURE(),
    });
    expect(ok).toBe(true);
    expect(dbHooks.__db.get(id)?.state).toBe("proposal_ready");
    expect((await getSwarmSession(id))?.state).toBe("proposal_ready");
  });

  it("persists the full terminal payload on the matched DB path", async () => {
    const id = nextId();
    // Seed a processing session (empty trace, no plan/plans).
    await saveSwarmSession({ id, state: "processing", expires_at: FUTURE() });

    const plan = {
      incident: "flight_cancelled",
      impacted_nodes: ["Outbound Flight"],
      proposed_resolution: { rescheduled_activities: [] },
      financial_delta: { net_payable: 120 },
      requires_human_approval: true,
    } as unknown as ResolutionPlan;
    const plans = [
      { ...plan, badge: "cheapest" },
      { ...plan, badge: "fastest" },
    ];
    const trace = [
      {
        agent: "assess",
        step: "classify",
        detail: "flight cancelled",
        at: "2026-08-25T09:00:00.000Z",
      },
      {
        agent: "resolve",
        step: "quote",
        detail: "2 rebooking options",
        at: "2026-08-25T09:00:05.000Z",
      },
    ];
    const newExpiresAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();

    const ok = await saveSwarmSessionIfState({
      id,
      state: "proposal_ready",
      plan,
      plans,
      trace,
      degraded: false,
      expires_at: newExpiresAt,
    });
    expect(ok).toBe(true);

    // The RAW DB row must carry every terminal field — not just state.
    const row = dbHooks.__db.get(id);
    expect(row?.state).toBe("proposal_ready");
    expect(row?.plan).toEqual(plan);
    expect(row?.plans).toEqual(plans);
    expect(row?.trace).toEqual(trace);
    expect(row?.degraded).toBe(false);
    expect(row?.expires_at).toBe(newExpiresAt);

    // …and another isolate reading through the store sees the same payload.
    const record = await getSwarmSession(id);
    expect(record?.state).toBe("proposal_ready");
    expect(record?.plan).toEqual(plan);
    expect(record?.plans).toEqual(plans);
    expect(record?.trace).toEqual(trace);
    expect(record?.degraded).toBe(false);
    expect(record?.expires_at).toBe(newExpiresAt);
  });

  it("a guarded write omitting plans leaves previously stored plans untouched", async () => {
    const id = nextId();
    const seededPlans = [
      { id: "plan_a", net: 90 },
      { id: "plan_b", net: 110 },
    ];
    await saveSwarmSession({
      id,
      state: "processing",
      plans: seededPlans,
      expires_at: FUTURE(),
    });
    expect(dbHooks.__db.get(id)?.plans).toEqual(seededPlans);

    // Guarded final upsert WITHOUT plans — must not null-overwrite them.
    const ok = await saveSwarmSessionIfState({
      id,
      state: "proposal_ready",
      expires_at: FUTURE(),
    });
    expect(ok).toBe(true);
    expect(dbHooks.__db.get(id)?.state).toBe("proposal_ready");
    expect(dbHooks.__db.get(id)?.plans).toEqual(seededPlans);
    expect((await getSwarmSession(id))?.plans).toEqual(seededPlans);
  });

  it("REFUSES to resurrect a cancelled session — cancel wins the race", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "processing", expires_at: FUTURE() });
    // A cancel lands between the pipeline's expiry check and the final upsert.
    expect((await cancelSwarmSession(id)).cancelled).toBe(true);

    const ok = await saveSwarmSessionIfState({
      id,
      state: "proposal_ready",
      expires_at: FUTURE(),
    });
    expect(ok).toBe(false);
    expect(dbHooks.__db.get(id)?.state).toBe("expired");
    const lookup = await getSwarmSessionIgnoringExpiry(id);
    expect(lookup && "record" in lookup ? lookup.record.state : "missing").toBe("expired");
  });

  it("refuses when a memory-only session (no DB row) was cancelled", async () => {
    const id = nextId();
    dbHooks.__setUpsertError({ message: "mirror down" });
    await saveSwarmSession({ id, state: "processing", expires_at: FUTURE() });
    dbHooks.__setUpsertError(null);
    expect(dbHooks.__db.has(id)).toBe(false);
    expect((await cancelSwarmSession(id)).cancelled).toBe(true);

    const ok = await saveSwarmSessionIfState({
      id,
      state: "proposal_ready",
      expires_at: FUTURE(),
    });
    expect(ok).toBe(false);
    const lookup = await getSwarmSessionIgnoringExpiry(id);
    expect(lookup && "record" in lookup ? lookup.record.state : "missing").toBe("expired");
  });

  it("keeps upsert semantics when no row exists anywhere (session bootstrap)", async () => {
    const id = nextId();
    const ok = await saveSwarmSessionIfState({
      id,
      state: "proposal_ready",
      expires_at: FUTURE(),
    });
    expect(ok).toBe(true);
    expect(dbHooks.__db.get(id)?.state).toBe("proposal_ready");
  });

  it("memory-only tier (no client): mirrors the allowed-state check", async () => {
    const id = nextId();
    dbHooks.__setClientAvailable(false);
    expect(swarmStoreIsPersistent()).toBe(false);
    await saveSwarmSession({ id, state: "gathering_preferences", expires_at: FUTURE() });
    expect((await cancelSwarmSession(id)).cancelled).toBe(true);

    const ok = await saveSwarmSessionIfState({
      id,
      state: "proposal_ready",
      expires_at: FUTURE(),
    });
    expect(ok).toBe(false);
    const lookup = await getSwarmSessionIgnoringExpiry(id);
    expect(lookup && "record" in lookup ? lookup.record.state : "missing").toBe("expired");
  });

  it("fails closed when the conditional UPDATE errors (no resurrection)", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "processing", expires_at: FUTURE() });
    dbHooks.__setUpdateError({ message: "simulated update outage" });

    const ok = await saveSwarmSessionIfState({
      id,
      state: "proposal_ready",
      expires_at: FUTURE(),
    });
    expect(ok).toBe(false);
    expect(dbHooks.__db.get(id)?.state).toBe("processing");
    const lookup = await getSwarmSessionIgnoringExpiry(id);
    expect(lookup && "record" in lookup ? lookup.record.state : "missing").toBe("processing");
  });
});

// ----------------------------------------------- probeSwarmStoreHealth

describe("probeSwarmStoreHealth (live store probe behind health.storeHealthy)", () => {
  it("a clean store probes true", async () => {
    expect(await probeSwarmStoreHealth()).toBe(true);
  });

  it("a failing select (e.g. rotated service key) probes false", async () => {
    dbHooks.__setSelectError({ message: "Invalid API key" });
    expect(await probeSwarmStoreHealth()).toBe(false);
  });

  it("a missing admin client (no env) probes false", async () => {
    dbHooks.__setClientAvailable(false);
    expect(await probeSwarmStoreHealth()).toBe(false);
  });
});

describe("atomic resolve startup", () => {
  it.each([true, false])("only one concurrent claimant wins (database=%s)", async (database) => {
    dbHooks.__setClientAvailable(database);
    const id = nextId();
    await saveSwarmSession({ id, state: "gathering_preferences", expires_at: FUTURE() });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimSwarmSessionForResolve(id)),
    );
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect((await getSwarmSession(id))?.state).toBe("processing");
  });
  it("does not claim stale memory when the database fails", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "gathering_preferences", expires_at: FUTURE() });
    dbHooks.__setUpdateError({ message: "offline" });
    expect(await claimSwarmSessionForResolve(id)).toEqual({
      claimed: false,
      error: "session_store_unavailable",
    });
    expect(dbHooks.__db.get(id)?.state).toBe("gathering_preferences");
  });
  it.each(["expired", "approved", "settled", "proposal_ready"] as const)(
    "does not restart %s",
    async (state) => {
      const id = nextId();
      await saveSwarmSession({ id, state, expires_at: FUTURE() });
      expect(await claimSwarmSessionForResolve(id)).toEqual({ claimed: false });
    },
  );
  it("does not start a timed-out preference session", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "gathering_preferences", expires_at: PAST() });
    expect(await claimSwarmSessionForResolve(id)).toEqual({ claimed: false });
  });
});

describe("strict resolve finalization", () => {
  it.each([true, false])("does not recreate a missing session (database=%s)", async (database) => {
    dbHooks.__setClientAvailable(database);
    expect(
      await saveSwarmSessionIfState(
        { id: nextId(), state: "proposal_ready" },
        ["processing"],
        true,
      ),
    ).toBe(false);
  });
  it.each([true, false])(
    "does not extend an already expired operation (database=%s)",
    async (database) => {
      dbHooks.__setClientAvailable(database);
      const id = nextId();
      await saveSwarmSession({ id, state: "processing", expires_at: PAST() });
      expect(
        await saveSwarmSessionIfState(
          { id, state: "proposal_ready", expires_at: FUTURE() },
          ["processing"],
          true,
        ),
      ).toBe(false);
    },
  );
});

describe("recoverable settlement receipts", () => {
  it.each([true, false])(
    "atomically records identity then receipt (database=%s)",
    async (database) => {
      dbHooks.__setClientAvailable(database);
      const id = nextId();
      await saveSwarmSession({ id, state: "proposal_ready", expires_at: FUTURE() });
      const entry = await claimSwarmSessionForBooking(id, {
        settlement_operation: {
          operation_id: id,
          plan_index: 1,
          started_at: new Date().toISOString(),
        },
      });
      expect(entry).not.toBeNull();
      expect(settlementOperation(entry!)?.plan_index).toBe(1);
      const receipt = { approved: true, booking: { confirmationCode: "TEST-ORDER" } };
      expect(await saveSwarmSettlementReceipt(entry!, receipt)).toBe(true);
      const stored = await getSwarmSession(id);
      expect(stored?.state).toBe("settled");
      expect(settlementOperation(stored!)?.receipt).toEqual(receipt);
      expect(await claimSwarmSessionForBooking(id)).toBeNull();
      expect(await saveSwarmSettlementReceipt(entry!, { approved: false })).toBe(false);
    },
  );
  it("leaves the operation approved when durable receipt storage fails", async () => {
    const id = nextId();
    await saveSwarmSession({ id, state: "proposal_ready", expires_at: FUTURE() });
    const entry = await claimSwarmSessionForBooking(id, {
      settlement_operation: {
        operation_id: id,
        plan_index: 0,
        started_at: new Date().toISOString(),
      },
    });
    dbHooks.__setUpdateError({ message: "offline" });
    expect(await saveSwarmSettlementReceipt(entry!, { approved: true })).toBe(false);
    expect(dbHooks.__db.get(id)?.state).toBe("approved");
    expect(await claimSwarmSessionForBooking(id)).toBeNull();
  });
});
