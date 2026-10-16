import { describe, expect, it } from "vitest";
import type { SinglesAvailabilityResponse } from "@cgwf/shared";
import { SinglesClient, type FetchLike } from "./client.js";
import { listing } from "./fixtures.js";

const SOL = "11111111-0000-4000-8000-000000000001";
const BOLT = "11111111-0000-4000-8000-000000000002";


/** A fake Singles site: answers every requested id, Sol Ring with two stores. */
function okFetch(calls: Array<{ url: string; init: RequestInit }>): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/v1/stores")) {
      return Response.json({ dataAsOf: "2026-10-16T15:30:00.000Z", source: "vegas-mtg", stores: [{ id: "power9", name: "Power 9 Games", website: "https://www.power9games.com", platform: "crystalcommerce", city: "Las Vegas", state: "NV", address: null, lastRefresh: "2026-10-16T15:30:00.000Z", listingCount: 7086 }] });
    }
    const ids = (JSON.parse(String(init.body)) as { oracleIds: string[] }).oracleIds;
    const cards: SinglesAvailabilityResponse["cards"] = {};
    for (const id of ids) {
      cards[id] = {
        oracleId: id,
        name: id === SOL ? "Sol Ring" : "",
        listings: id === SOL ? [listing(), listing({ storeId: "stomping-grounds", storeName: "Stomping Grounds", storeWebsite: "https://singles.stompinggroundstcg.com", price: 1.5, condition: "LP", urlKind: "product", url: "https://singles.stompinggroundstcg.com/products/sol-ring?variant=1" })] : [],
      };
    }
    return Response.json({ dataAsOf: "2026-10-16T15:30:00.000Z", source: "vegas-mtg", requested: ids.length, cards });
  };
}

function client(fetchImpl: FetchLike, over: Partial<ConstructorParameters<typeof SinglesClient>[0]> = {}, clock = { t: 1_000_000 }) {
  return new SinglesClient({ baseUrl: "https://singles.test/", token: "tok", fetch: fetchImpl, timeoutMs: 50, cacheTtlMs: 15 * 60_000, breakerFailures: 3, breakerCooldownMs: 60_000, now: () => clock.t, ...over });
}

describe("SinglesClient", () => {
  it("is unconfigured without a URL and token, and never calls fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = new SinglesClient({ baseUrl: "", token: "", fetch: okFetch(calls) });
    expect(c.configured).toBe(false);
    const r = await c.availability([SOL]);
    expect(r.status).toBe("unconfigured");
    expect(calls).toHaveLength(0);
  });

  it("sends the token and the ids, returns every requested id, and caches by id set", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = client(okFetch(calls));
    const first = await c.availability([SOL, BOLT, "junk-upper".toUpperCase()]);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.cached).toBe(false);
    expect(first.data.cards[SOL]?.listings).toHaveLength(2);
    expect(first.data.cards[BOLT]?.listings).toEqual([]);
    expect(first.data.cards["junk-upper"]).toBeDefined();
    expect(calls[0]?.url).toBe("https://singles.test/api/v1/availability");
    expect(new Headers(calls[0]?.init.headers).get("x-service-token")).toBe("tok");

    const again = await c.availability([BOLT, SOL, "JUNK-UPPER"]); // same set, different order and case
    expect(again.status === "ok" && again.cached).toBe(true);
    expect(calls).toHaveLength(1);
    const other = await c.availability([SOL]);
    expect(other.status === "ok" && other.cached).toBe(false);
    expect(calls).toHaveLength(2);
    expect(c.status().cacheEntries).toBe(2);
  });

  it("shares one request between concurrent callers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = client(okFetch(calls));
    const [a, b] = await Promise.all([c.availability([SOL]), c.availability([SOL])]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  it("chunks large id sets and merges the answers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = client(okFetch(calls), { batchSize: 2 });
    const ids = ["a", "b", "c", "d", "e"].map((x) => `${x}${SOL.slice(1)}`);
    const r = await c.availability(ids);
    expect(r.status).toBe("ok");
    expect(calls).toHaveLength(3);
    if (r.status === "ok") expect(Object.keys(r.data.cards)).toHaveLength(5);
  });

  it("treats a 401 as a failure that opens the breaker after three tries", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    });
    for (let i = 0; i < 3; i++) {
      const r = await c.availability([SOL]);
      expect(r.status).toBe("unavailable");
      if (r.status === "unavailable") expect(r.reason).toContain("token");
    }
    expect(calls).toBe(3);
    expect(c.status().breaker.state).toBe("open");
    const r = await c.availability([SOL]);
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.reason).toContain("circuit open");
    expect(calls).toBe(3); // no request while open
  });

  it("times out slow answers instead of waiting", async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const c = client(slow, { timeoutMs: 20 });
    const started = Date.now();
    const r = await c.availability([SOL]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.reason).toContain("timeout");
    expect(c.status().failures).toBe(1);
  });

  it("opens on repeated 500s, answers instantly while open, probes after the cooldown and recovers", async () => {
    const clock = { t: 1_000_000 };
    let fail = true;
    let calls = 0;
    const good = okFetch([]);
    const c = client(async (url, init) => {
      calls++;
      if (fail) return new Response("boom", { status: 500 });
      return good(url, init);
    }, {}, clock);
    for (let i = 0; i < 3; i++) expect((await c.availability([SOL])).status).toBe("unavailable");
    expect(c.status().breaker.state).toBe("open");
    expect(c.status().breaker.openUntil).toBe(new Date(1_060_000).toISOString());
    expect((await c.availability([SOL])).status).toBe("unavailable");
    expect(calls).toBe(3);

    clock.t += 61_000; // cooldown over -> half-open, one probe allowed
    fail = false;
    const r = await c.availability([SOL]);
    expect(r.status).toBe("ok");
    expect(calls).toBe(4);
    expect(c.status().breaker.state).toBe("closed");
    expect(c.status().breaker.failures).toBe(0);
  });

  it("serves a stale cached answer when the site fails after the TTL, marked stale", async () => {
    const clock = { t: 1_000_000 };
    let fail = false;
    const good = okFetch([]);
    const c = client(async (url, init) => (fail ? new Response("boom", { status: 503 }) : good(url, init)), {}, clock);
    expect((await c.availability([SOL])).status).toBe("ok");
    clock.t += 16 * 60_000; // past the 15-minute TTL
    fail = true;
    const r = await c.availability([SOL]);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.cached).toBe(true);
      expect(r.stale).toBe(true);
      expect(r.data.cards[SOL]?.listings).toHaveLength(2);
    }
    clock.t += 2 * 60 * 60_000; // far beyond the stale window -> honest unavailable
    expect((await c.availability([SOL])).status).toBe("unavailable");
  });

  it("fetches the store list and caches it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = client(okFetch(calls));
    const r = await c.stores();
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.data.stores[0]?.name).toBe("Power 9 Games");
    await c.stores();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("an empty id set never calls the site", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = client(okFetch(calls));
    const r = await c.availability([]);
    expect(r.status).toBe("ok");
    expect(calls).toHaveLength(0);
  });
});
