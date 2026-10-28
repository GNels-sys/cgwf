import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { DeckDetail, RegisterResponse } from "@cgwf/shared";
import { cards } from "../db/schema.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-deckedit-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const ID = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SOL_RING = ID(1);
const ATRAXA = ID(10);
const FOREST = ID(11);
const WHTZ = "whtz-the-bibliophile";

/** The deck editor's save (owner request 2026-10-28): PUT /api/decks/:id/cards accepts only exactly 100 cards. */
describe("saving an edited deck list", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let alex: RegisterResponse;
  let deckId = "";
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const put = (cards: unknown, token = alex.token) => ctx.app.inject({ method: "PUT", url: `/api/decks/${deckId}/cards`, headers: auth(token), payload: { cards } });

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, idleSweep: false });
    await ctx.ingestor.run({ file: fixture });
    alex = (await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Alex", avatar: "fox", color: "jade" }, remoteAddress: "10.8.0.1" })).json() as RegisterResponse;
    const res = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth(alex.token), payload: { name: "Atraxa", cards: [{ cardId: ATRAXA, quantity: 1, board: "commander" }, { cardId: FOREST, quantity: 99, board: "main" }] } });
    deckId = (res.json() as { deck: DeckDetail }).deck.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("refuses 101 cards with the owner's message and leaves the deck as it was", async () => {
    const res = await put([{ cardId: ATRAXA, quantity: 1, board: "commander" }, { cardId: FOREST, quantity: 99, board: "main" }, { cardId: SOL_RING, quantity: 1, board: "main" }]);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Your deck currently has 101 cards. Please remove 1 card prior to saving." });
    const deck = (await ctx.app.inject({ method: "GET", url: `/api/decks/${deckId}`, headers: auth(alex.token) })).json() as { deck: DeckDetail };
    expect(deck.deck.cardCount).toBe(100);
    expect(deck.deck.cards.some((c) => c.cardId === SOL_RING)).toBe(false);
  });

  it("refuses too few too", async () => {
    const res = await put([{ cardId: ATRAXA, quantity: 1, board: "commander" }, { cardId: FOREST, quantity: 97, board: "main" }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Your deck currently has 98 cards. Please add 2 cards prior to saving.");
  });

  it("saves a swap that keeps 100, with maybeboard cards outside the count", async () => {
    const res = await put([
      { cardId: ATRAXA, quantity: 1, board: "commander" },
      { cardId: SOL_RING, quantity: 1, board: "main" },
      { cardId: FOREST, quantity: 98, board: "main" },
      { cardId: SOL_RING, quantity: 1, board: "maybeboard" },
    ]);
    expect(res.statusCode).toBe(200);
    const deck = (res.json() as { deck: DeckDetail }).deck;
    expect(deck.cardCount).toBe(100);
    expect(deck.cards.filter((c) => c.cardId === SOL_RING).map((c) => c.board).sort()).toEqual(["main", "maybeboard"]);
  });

  it("is still the owner's deck only", async () => {
    const blair = (await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Blair", avatar: "fox", color: "jade" }, remoteAddress: "10.8.0.2" })).json() as RegisterResponse;
    expect((await put([{ cardId: ATRAXA, quantity: 1, board: "commander" }, { cardId: FOREST, quantity: 99, board: "main" }], blair.token)).statusCode).toBe(404);
  });

  describe("under a commander with no maximum deck size (Whtz, the Bibliophile)", () => {
    let whtzDeck = "";
    const putWhtz = (list: unknown) => ctx.app.inject({ method: "PUT", url: `/api/decks/${whtzDeck}/cards`, headers: auth(alex.token), payload: { cards: list } });
    const whtz = (forests: number) => [{ cardId: WHTZ, quantity: 1, board: "commander" }, { cardId: FOREST, quantity: forests, board: "main" }];

    beforeAll(async () => {
      // Whtz is newer than the fixture file: a copy of Atraxa's row with Whtz's name and Oracle text.
      const atraxa = ctx.handle.db.select().from(cards).where(eq(cards.id, ATRAXA)).get()!;
      ctx.handle.db.insert(cards).values({ ...atraxa, id: WHTZ, oracleId: "whtz-oracle", name: "Whtz, the Bibliophile", oracleText: "Rulebreaker — A deck with this commander has no maximum deck size.\n{3}, {T}: You draw a card and gain 1 life." }).run();
      const res = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth(alex.token), payload: { name: "Whtz", cards: whtz(99) } });
      whtzDeck = (res.json() as { deck: DeckDetail }).deck.id;
    });

    it("saves 150 cards with no size warning, so an engine table accepts it", async () => {
      const res = await putWhtz(whtz(149));
      expect(res.statusCode).toBe(200);
      const deck = (res.json() as { deck: DeckDetail }).deck;
      expect(deck.cardCount).toBe(150);
      expect(deck.sizeRule).toEqual({ min: 100, max: null, grantedBy: "Whtz, the Bibliophile" });
      expect(deck.warnings.map((w) => w.code)).not.toContain("size");
    });

    it("still needs at least 100", async () => {
      const res = await putWhtz(whtz(98));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Your deck currently has 99 cards. Please add 1 card prior to saving.");
    });

    it("goes back to exactly 100 when Whtz is no longer the commander", async () => {
      const res = await putWhtz([{ cardId: ATRAXA, quantity: 1, board: "commander" }, { cardId: WHTZ, quantity: 1, board: "main" }, { cardId: FOREST, quantity: 148, board: "main" }]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Your deck currently has 150 cards. Please remove 50 cards prior to saving.");
    });

    it("an imported 99-card Whtz list warns that it needs at least 100", async () => {
      const res = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth(alex.token), payload: { name: "Short Whtz", cards: whtz(98) } });
      const deck = (res.json() as { deck: DeckDetail }).deck;
      expect(deck.warnings.find((w) => w.code === "size")?.message).toBe("99 cards including commander(s); a deck with Whtz, the Bibliophile needs at least 100 (no maximum).");
    });
  });
});
