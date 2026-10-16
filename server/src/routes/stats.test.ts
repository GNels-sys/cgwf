import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeckDetail, DeckStatsResponse, LibraryDeckDetail, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-stats-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { users } = await import("../db/schema.js");
const { StatsCache } = await import("./stats.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

describe("deck stats routes", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token = "";
  let otherToken = "";
  let deck: DeckDetail;

  // Spellbook is never asked by the stats routes; fail loudly if it is.
  const noFetch = async (): Promise<Response> => {
    throw new Error("stats must not call the network");
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, spellbookFetch: noFetch, mtgjsonFetch: noFetch });
    await ctx.ingestor.run({ file: fixture });
    const reg = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Alex", avatar: "dragon", color: "gold" } });
    const me = reg.json() as RegisterResponse;
    token = me.token;
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, me.user.id)).run();
    const reg2 = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Sam", avatar: "owl", color: "jade" }, remoteAddress: "10.3.3.3" });
    otherToken = (reg2.json() as RegisterResponse).token;

    const parsed = await ctx.app.inject({
      method: "POST",
      url: "/api/decks/parse",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n1 Lightning Bolt\n1 Lotus Cobra\n3 Forest\n" },
    });
    const lines = (parsed.json() as { lines: Array<{ card: { id: string } | null; line: { quantity: number; board: string } }> }).lines;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Atraxa stats", cards: lines.filter((l) => l.card).map((l) => ({ cardId: l.card!.id, quantity: l.line.quantity, board: l.line.board })) },
    });
    expect(created.statusCode).toBe(201);
    deck = (created.json() as { deck: DeckDetail }).deck;
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const auth = () => ({ authorization: `Bearer ${token}` });

  it("requires sign-in and ownership", async () => {
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/stats` })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/stats`, headers: { authorization: `Bearer ${otherToken}` } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/nope/stats`, headers: auth() })).statusCode).toBe(404);
  });

  it("computes stats from the real card rows, then serves the cache for the same version", async () => {
    const first = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/stats`, headers: auth() });
    expect(first.statusCode).toBe(200);
    const body = first.json() as DeckStatsResponse;
    expect(body.cached).toBe(false);
    const s = body.stats;
    // Atraxa {G}{W}{U}{B} 4, Sol Ring {1}, Arcane Signet {2}, Lightning Bolt {R}, Lotus Cobra {1}{G}, 3 Forest.
    expect(s.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    expect(s.manaValue).toMatchObject({ cardCount: 8, landCount: 3, nonlandCount: 5, nonlandTotal: 10, averageNonland: 2, averageAll: 1.25 });
    expect(s.curve.find((b) => b.value === 0)).toEqual({ value: 0, nonland: 0, lands: 3 });
    expect(s.curve.find((b) => b.value === 4)!.nonland).toBe(1);
    expect(s.pips.colored).toEqual({ W: 1, U: 1, B: 1, R: 1, G: 2, C: 0 });
    expect(s.pips.generic).toBe(4);
    expect(s.production.identity).toEqual(["W", "U", "B", "G"]);
    expect(s.production.byKind).toEqual({ land: 3, rock: 2, dork: 1, other: 0 }); // Lotus Cobra (landfall "add one mana of any color") counts as a dork
    expect(s.production.anyColorSources).toBe(2); // Arcane Signet, Lotus Cobra
    expect(s.production.rows.find((r) => r.color === "G")).toMatchObject({ pips: 2, sources: 5 }); // 3 Forest + Signet + Cobra
    expect(s.production.rows.find((r) => r.color === "R")).toMatchObject({ pips: 1, sources: 0 }); // outside Atraxa's identity
    expect(s.breakdowns.types).toMatchObject({ creature: 2, instant: 1, artifact: 2, land: 3 });
    expect(s.breakdowns.lands).toEqual({ total: 3, basic: 3, nonbasic: 0 });
    expect(s.breakdowns.creatures).toEqual({ count: 2, averagePower: 3, averageToughness: 2.5, nonNumeric: 0 }); // Atraxa 4/4, Lotus Cobra 2/1
    expect(s.functional.find((f) => f.key === "ramp")!.cards.map((c) => c.name).sort()).toEqual(["Arcane Signet", "Lotus Cobra", "Sol Ring"]);
    expect(s.functional.find((f) => f.key === "removal")!.cards).toEqual([{ name: "Lightning Bolt", quantity: 1 }]);

    const second = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/stats`, headers: auth() });
    expect((second.json() as DeckStatsResponse).cached).toBe(true);
    expect((second.json() as DeckStatsResponse).stats).toEqual(s);
  });

  it("recomputes after the list changes", async () => {
    await new Promise((r) => setTimeout(r, 5)); // make sure updatedAt moves
    const replaced = await ctx.app.inject({
      method: "PUT",
      url: `/api/decks/${deck.id}/cards`,
      headers: auth(),
      payload: { cards: deck.cards.filter((c) => c.card.name !== "Lightning Bolt").map((c) => ({ cardId: c.cardId, quantity: c.quantity, board: c.board })) },
    });
    expect(replaced.statusCode).toBe(200);
    const res = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/stats`, headers: auth() });
    const body = res.json() as DeckStatsResponse;
    expect(body.cached).toBe(false);
    expect(body.stats.manaValue.cardCount).toBe(7);
    expect(body.stats.functional.find((f) => f.key === "removal")!.count).toBe(0);
  });

  it("serves library decks to the owner only", async () => {
    const added = await ctx.app.inject({ method: "POST", url: `/api/library/from-deck/${deck.id}`, headers: auth(), payload: {} }).catch(() => null);
    // Spellbook is stubbed to throw; the library import still succeeds with combos unavailable.
    expect(added?.statusCode).toBe(201);
    const lib = (added!.json() as { deck: LibraryDeckDetail }).deck;
    expect((await ctx.app.inject({ method: "GET", url: `/api/library/${lib.id}/stats`, headers: { authorization: `Bearer ${otherToken}` } })).statusCode).toBe(403);
    const res = await ctx.app.inject({ method: "GET", url: `/api/library/${lib.id}/stats`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DeckStatsResponse;
    expect(body.cached).toBe(false);
    expect(body.stats.manaValue.cardCount).toBe(7);
    expect(body.stats.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    expect(((await ctx.app.inject({ method: "GET", url: `/api/library/${lib.id}/stats`, headers: auth() })).json() as DeckStatsResponse).cached).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: `/api/library/nope/stats`, headers: auth() })).statusCode).toBe(404);
  });
});

describe("StatsCache", () => {
  it("evicts the least recently viewed entry past its limit", () => {
    const c = new StatsCache(2);
    const s = { computedAt: "x" } as never;
    c.set("a", "1", s);
    c.set("b", "1", s);
    expect(c.get("a", "1")).toBe(s); // a is now the most recent
    c.set("c", "1", s); // evicts b
    expect(c.get("b", "1")).toBeNull();
    expect(c.get("a", "1")).toBe(s);
    expect(c.get("a", "2")).toBeNull(); // a different version misses
    expect(c.size).toBe(2);
  });
});
