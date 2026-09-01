/**
 * Reachability probes for /api/hackathon/health.
 *
 * The contract that matters: a probe answers a QUESTION ABOUT THE UPSTREAM,
 * never about our env vars, and it can never take the health endpoint down
 * with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetReachabilityCache,
  probeActivityReachable,
  probeAtlasReachable,
  probeHotelReachable,
} from "@/lib/swarmReachability";

const ENV_KEYS = [
  "ATLAS_API_KEY",
  "ATLAS_SANDBOX_URL",
  "ATLAS_BASE_URL",
  "RAPIDAPI_KEY",
  "RAPIDAPI_HOST",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  __resetReachabilityCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl as never);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("reachability probes — not configured", () => {
  it("returns null rather than a false verdict when env is missing", async () => {
    // "Never probed" and "probed and failed" are different facts. A `false`
    // here would tell an operator the upstream is DOWN when we never asked.
    const fetchSpy = mockFetch(() => new Response("", { status: 200 }));
    expect(await probeAtlasReachable()).toBeNull();
    expect(await probeHotelReachable()).toBeNull();
    expect(await probeActivityReachable()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a configured-but-keyless hotel provider as not configured", async () => {
    process.env.RAPIDAPI_KEY = "k";
    // RAPIDAPI_HOST still absent — the provider cannot be built.
    expect(await probeHotelReachable()).toBeNull();
  });
});

describe("reachability probes — live verdicts", () => {
  it("reports reachable when the upstream answers 200", async () => {
    process.env.ATLAS_API_KEY = "k";
    mockFetch(() => new Response("{}", { status: 200 }));
    // No `authorized`: Atlas authenticates on its POST endpoints, not on the
    // root this probe touches.
    expect(await probeAtlasReachable()).toEqual({ reachable: true });
  });

  it("counts a non-404 answer as reachable", async () => {
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    mockFetch(() => new Response("{}", { status: 200 }));
    // No `authorized`: verified against the live function, it answers 200 to a
    // valid key, a wrong key and no key alike, so any claim about credentials
    // would be invented.
    expect(await probeActivityReachable()).toEqual({ reachable: true });
  });

  it("treats a 404 on the Edge Function as NOT reachable", async () => {
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(() => new Response("", { status: 404 }));
    // A deleted function is the outage this probe exists to catch; calling it
    // "reachable, the host answered" would hide exactly that.
    expect(await probeActivityReachable()).toEqual({ reachable: false });
  });

  it("does not claim a 404 host root is missing", async () => {
    // A host root legitimately 404s while the API beside it is perfectly fine.
    process.env.RAPIDAPI_KEY = "k";
    process.env.RAPIDAPI_HOST = "hotels.example.com";
    mockFetch(() => new Response("", { status: 404 }));
    expect(await probeHotelReachable()).toEqual({ reachable: true, authorized: true });
  });

  it("separates a live host from rejected credentials", async () => {
    process.env.RAPIDAPI_KEY = "stale";
    process.env.RAPIDAPI_HOST = "hotels.example.com";
    mockFetch(() => new Response("", { status: 401 }));
    // Reachable but NOT authorized — precisely the rotated-key case that a
    // single "configured" boolean could never surface.
    expect(await probeHotelReachable()).toEqual({ reachable: true, authorized: false });
  });

  it("reports unreachable when the request throws, and never propagates", async () => {
    process.env.ATLAS_API_KEY = "k";
    mockFetch(() => Promise.reject(new Error("ENOTFOUND")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A health endpoint must not 500 because an upstream is down — that is
    // the very condition it exists to report.
    await expect(probeAtlasReachable()).resolves.toEqual({ reachable: false });
  });

  it("reports unreachable when the upstream exceeds the probe timeout", async () => {
    process.env.ATLAS_API_KEY = "k";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          // Honour the AbortSignal the probe attaches, the way fetch does.
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(probeAtlasReachable()).resolves.toEqual({ reachable: false });
  }, 10_000);
});

describe("reachability probes — cost discipline", () => {
  it("probes the activity function with a query-less POST that cannot bill us", async () => {
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "anon";
    const fetchSpy = mockFetch(() => new Response("", { status: 200 }));
    await probeActivityReachable();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/viator-activities");
    // POST is the method the handler implements, and an EMPTY query makes it
    // short-circuit before it ever calls the Viator Partner API.
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body)).query).toBe("");
    expect((init.headers as Record<string, string>).apikey).toBe("anon");
  });

  it("memoises a verdict so a polled health endpoint cannot hammer upstreams", async () => {
    process.env.ATLAS_API_KEY = "k";
    const fetchSpy = mockFetch(() => new Response("", { status: 200 }));
    await probeAtlasReachable();
    await probeAtlasReachable();
    await probeAtlasReachable();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("probes the resolved Atlas base URL, not a hardcoded host", async () => {
    process.env.ATLAS_API_KEY = "k";
    process.env.ATLAS_SANDBOX_URL = "https://atlas.test/api/";
    const fetchSpy = mockFetch(() => new Response("", { status: 200 }));
    await probeAtlasReachable();
    expect(fetchSpy.mock.calls[0][0]).toBe("https://atlas.test/api/");
  });
});
