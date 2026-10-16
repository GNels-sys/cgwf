import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { CardAvailabilityResponse, CardResponse, DeckDetail, RegisterResponse, SearchResponse, ShoppingReport, SinglesAvailabilityResponse, StoresResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-singles-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { cards } = await import("../db/schema.js");
const { listing } = await import("../singles/fixtures.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

describe("local stores bridge routes", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token = "";
  let deck: DeckDetail;
  let solOracle = "";
  let boltOracle = "";
  const calls: Array<{ url: string; ids: string[] }> = [];
  let mode: "ok" | "down" | "unauthorized" = "ok";

  const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const ids = init.body ? (JSON.parse(String(init.body)) as { oracleIds: string[] }).oracleIds : [];
    calls.push({ url, ids });
    if (mode === "down") return new Response("boom", { status: 503 });
    if (mode === "unauthorized") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    if (url.endsWith("/api/v1/stores")) {
      return Response.json({ dataAsOf: "2026-10-16T15:30:00.000Z", source: "vegas-mtg", stores: [{ id: "power9", name: "Power 9 Games", website: "https://www.power9games.com", platform: "crystalcommerce", city: "Las Vegas", state: "NV", address: null, lastRefresh: "2026-10-16T15:30:00.000Z", listingCount: 7086 }] });
    }
    const out: SinglesAvailabilityResponse["cards"] = {};
    for (const id of ids) {
      const listings =
        id === solOracle
          ? [listing({ price: 1.99 }), listing({ storeId: "stomping-grounds", storeName: "Stomping Grounds", storeWebsite: "https://singles.stompinggroundstcg.com", price: 1.5, urlKind: "product", url: "https://singles.stompinggroundstcg.com/products/sol-ring?variant=1" })]
          : id === boltOracle
            ? [listing({ price: 0.8, finish: "foil" })]
            : [];
      out[id] = { oracleId: id, name: listings.length ? (id === solOracle ? "Sol Ring" : "Lightning Bolt") : "", listings };
    }
    return Response.json({ dataAsOf: "2026-10-16T15:30:00.000Z", source: "vegas-mtg", requested: ids.length, cards: out });
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, singlesFetch: fakeFetch, singlesOptions: { baseUrl: "https://singles.test", token: "tok", breakerCooldownMs: 50 } });
    await ctx.ingestor.run({ file: fixture });
    solOracle = ctx.handle.db.select().from(cards).where(eq(cards.name, "Sol Ring")).get()!.oracleId!;
    boltOracle = ctx.handle.db.select().from(cards).where(eq(cards.name, "Lightning Bolt")).get()!.oracleId!;
    const reg = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Alex", avatar: "dragon", color: "gold" } });
    token = (reg.json() as RegisterResponse).token;
    const parsed = await ctx.app.inject({
      method: "POST",
      url: "/api/decks/parse",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n1 Lightning Bolt\n3 Forest\n\nSideboard\n1 Fire // Ice\n" },
    });
    const lines = (parsed.json() as { lines: Array<{ card: { id: string } | null; line: { quantity: number; board: string } }> }).lines;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Shopping test", cards: lines.filter((l) => l.card).map((l) => ({ cardId: l.card!.id, quantity: l.line.quantity, board: l.line.board })) },
    });
    expect(created.statusCode).toBe(201);
    deck = (created.json() as { deck: DeckDetail }).deck;
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it("card responses carry Scryfall purchase links after ingest", async () => {
    const search = await ctx.app.inject({ method: "GET", url: "/api/cards/search?q=sol+ring" });
    const hit = (search.json() as SearchResponse).results.find((r) => r.set === "cmr")!;
    expect(hit.purchaseUris?.tcgplayer).toContain("tcgplayer.com");
    const card = await ctx.app.inject({ method: "GET", url: `/api/cards/${hit.id}` });
    expect((card.json() as CardResponse).card.purchaseUris).toEqual({
      tcgplayer: expect.stringContaining("https://www.tcgplayer.com/"),
      cardmarket: expect.stringContaining("https://www.cardmarket.com/"),
      cardhoarder: expect.stringContaining("https://www.cardhoarder.com/"),
    });
    const bolt = ctx.handle.db.select().from(cards).where(eq(cards.name, "Lightning Bolt")).get()!;
    const boltRes = await ctx.app.inject({ method: "GET", url: `/api/cards/${bolt.id}` });
    expect((boltRes.json() as CardResponse).card.purchaseUris).toBeNull();
  });

  it("every bridge route needs a signed-in user", async () => {
    const sol = deck.cards.find((c) => c.card.name === "Sol Ring")!.card.id;
    for (const url of [`/api/cards/${sol}/availability`, `/api/decks/${deck.id}/shopping`, "/api/stores", "/api/library/x/shopping"]) {
      expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    expect((await ctx.app.inject({ method: "GET", url: "/api/library/x/shopping", headers: auth() })).statusCode).toBe(403); // owner only
  });

  it("GET /api/cards/:id/availability groups the Singles answer by store, cheapest first", async () => {
    const sol = deck.cards.find((c) => c.card.name === "Sol Ring")!.card.id;
    const res = await ctx.app.inject({ method: "GET", url: `/api/cards/${sol}/availability`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CardAvailabilityResponse;
    expect(body.status).toBe("ok");
    expect(body.source).toBe("local stores");
    expect(body.dataAsOf).toBe("2026-10-16T15:30:00.000Z");
    expect(body.cached).toBe(false);
    expect(body.card).toEqual({ id: sol, oracleId: solOracle, name: "Sol Ring" });
    expect(body.stores.map((s) => [s.store.name, s.cheapest])).toEqual([
      ["Stomping Grounds", 1.5],
      ["Power 9 Games", 1.99],
    ]);
    expect(body.stores[0]?.listings[0]?.url).toContain("stompinggroundstcg.com/products/");
    expect(body.purchaseLinks?.tcgplayer).toContain("tcgplayer.com");
    expect(calls.at(-1)?.ids).toEqual([solOracle]);

    const again = await ctx.app.inject({ method: "GET", url: `/api/cards/${sol}/availability`, headers: auth() });
    expect((again.json() as CardAvailabilityResponse).cached).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: "/api/cards/nope/availability", headers: auth() })).statusCode).toBe(404);
  });

  it("GET /api/decks/:id/shopping aggregates the deck (main + commander only) and is owner-scoped", async () => {
    const before = calls.length;
    const res = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/shopping`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const r = res.json() as ShoppingReport;
    expect(r.status).toBe("ok");
    expect(r.deck).toEqual({ id: deck.id, name: "Shopping test", cardCount: 7 }); // Atraxa + Sol Ring + Signet + Bolt + 3 Forest; the sideboard Fire // Ice is left out
    expect(r.cards.map((c) => c.name)).not.toContain("Fire // Ice");
    expect(r.summary).toMatchObject({ cardsTotal: 5, cardsAvailable: 2, cardsMissing: 3, cheapestAnywhereTotal: 2.3 });
    expect(r.summary.missingNames.sort()).toEqual(["Arcane Signet", "Atraxa, Praetors' Voice", "Forest"]);
    expect(r.cards.find((c) => c.name === "Sol Ring")?.cheapest).toMatchObject({ storeId: "stomping-grounds", price: 1.5 });
    expect(r.cards.find((c) => c.name === "Lightning Bolt")?.cheapest).toMatchObject({ storeId: "power9", price: 0.8, finish: "foil" });
    expect(r.cards.find((c) => c.name === "Sol Ring")?.purchaseLinks?.tcgplayer).toContain("tcgplayer.com");
    expect(r.stores.map((s) => [s.store.id, s.cardsCovered, s.total])).toEqual([
      ["power9", 2, 2.79],
      ["stomping-grounds", 1, 1.5],
    ]);
    expect(r.bestStore?.store.id).toBe("power9");
    expect(r.bestStore?.missing.sort()).toEqual(["Arcane Signet", "Atraxa, Praetors' Voice", "Forest"]);
    // One request for the whole deck, with every oracle id, sorted and de-duplicated.
    expect(calls.length - before).toBe(1);
    expect(calls.at(-1)?.ids).toEqual([...new Set(r.cards.map((c) => c.oracleId!))].sort());

    const other = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Sam", avatar: "owl", color: "jade" }, remoteAddress: "10.3.3.4" });
    const res2 = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/shopping`, headers: { authorization: `Bearer ${(other.json() as RegisterResponse).token}` } });
    expect(res2.statusCode).toBe(404);
  });

  it("GET /api/stores passes the store list through, cached", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/stores", headers: auth() });
    const body = res.json() as StoresResponse;
    expect(body.status).toBe("ok");
    expect(body.stores[0]?.name).toBe("Power 9 Games");
    expect(body.source).toBe("local stores");
    const again = await ctx.app.inject({ method: "GET", url: "/api/stores", headers: auth() });
    expect((again.json() as StoresResponse).cached).toBe(true);
  });

  it("answers 'unavailable' quickly when the Singles site is down, keeps serving, and recovers", async () => {
    mode = "down";
    ctx.singles.clearCache();
    const bolt = deck.cards.find((c) => c.card.name === "Lightning Bolt")!.card.id;
    for (let i = 0; i < 3; i++) {
      const res = await ctx.app.inject({ method: "GET", url: `/api/cards/${bolt}/availability`, headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json() as CardAvailabilityResponse;
      expect(body.status).toBe("unavailable");
      expect(body.stores).toEqual([]);
      expect(body.card.name).toBe("Lightning Bolt");
    }
    expect(ctx.singles.status().breaker.state).toBe("open");
    const before = calls.length;
    const started = Date.now();
    const res = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/shopping`, headers: auth() });
    const r = res.json() as ShoppingReport;
    expect(r.status).toBe("unavailable");
    expect(r.reason).toContain("circuit open");
    expect(r.summary.cardsAvailable).toBe(0);
    expect(r.cards.find((c) => c.name === "Sol Ring")?.purchaseLinks?.tcgplayer).toContain("tcgplayer.com"); // fallback links still there
    expect(calls.length).toBe(before); // breaker open: no request made
    expect(Date.now() - started).toBeLessThan(500);

    await new Promise((r) => setTimeout(r, 60)); // cooldown (50 ms in this test)
    mode = "ok";
    const back = await ctx.app.inject({ method: "GET", url: `/api/cards/${bolt}/availability`, headers: auth() });
    expect((back.json() as CardAvailabilityResponse).status).toBe("ok");
    expect(ctx.singles.status().breaker.state).toBe("closed");
  });

  it("a rejected token shows up as unavailable with a reason that names the secret", async () => {
    mode = "unauthorized";
    ctx.singles.clearCache();
    const res = await ctx.app.inject({ method: "GET", url: "/api/stores", headers: auth() });
    const body = res.json() as StoresResponse;
    expect(body.status).toBe("unavailable");
    expect(body.reason).toContain("SINGLES_API_TOKEN");
    mode = "ok";
  });

  it("reports 'unconfigured' when the bridge has no URL or token", async () => {
    const bare = await buildApp({ logger: false, dbFile: path.join(tmp, "bare.db"), singlesOptions: { baseUrl: "", token: "" } });
    try {
      const reg = await bare.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Kit", avatar: "owl", color: "jade" } });
      const res = await bare.app.inject({ method: "GET", url: "/api/stores", headers: { authorization: `Bearer ${(reg.json() as RegisterResponse).token}` } });
      expect((res.json() as StoresResponse).status).toBe("unconfigured");
    } finally {
      await bare.app.close();
    }
  });
});
