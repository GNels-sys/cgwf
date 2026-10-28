import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeckDetail, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-deckedit-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const ID = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SOL_RING = ID(1);
const ATRAXA = ID(10);
const FOREST = ID(11);

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
});
