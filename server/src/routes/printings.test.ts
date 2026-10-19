import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { isRegularPrinting, treatmentRank, type DeckDetail, type LibraryDeckDetail, type PrintingsResponse, type RegisterResponse, type ResolveResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-printings-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { cards, users } = await import("../db/schema.js");
const { rowTraits } = await import("../scryfall/map.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

type CardRow = typeof cards.$inferSelect;

describe("default printings and the printing picker", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token = "";
  let otherToken = "";
  let solRing: CardRow;
  let signet: CardRow;
  const noFetch = async (): Promise<Response> => {
    throw new Error("no network in tests");
  };

  /** Insert another printing of `base` with the given look; isRegular is computed as the ingest does. */
  const printing = (base: CardRow, id: string, look: Partial<CardRow>): CardRow => {
    const row: CardRow = {
      ...base,
      id,
      set: "tst",
      setName: "Test Set",
      setType: "expansion",
      collectorNumber: "1",
      releasedAt: "2030-01-01",
      frame: "2015",
      frameEffects: [],
      borderColor: "black",
      fullArt: false,
      textless: false,
      isPromo: false,
      promoTypes: [],
      finishes: ["nonfoil", "foil"],
      oversized: false,
      inBooster: false,
      ...look,
    };
    row.isRegular = isRegularPrinting(rowTraits(row));
    row.treatmentCount = treatmentRank(rowTraits(row));
    ctx.handle.db.insert(cards).values(row).run();
    return row;
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, spellbookFetch: noFetch, mtgjsonFetch: noFetch });
    await ctx.ingestor.run({ file: fixture });
    const reg = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Alex", avatar: "dragon", color: "gold" } });
    const me = reg.json() as RegisterResponse;
    token = me.token;
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, me.user.id)).run();
    const reg2 = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Sam", avatar: "owl", color: "jade" }, remoteAddress: "10.4.4.4" });
    otherToken = (reg2.json() as RegisterResponse).token;

    const all = ctx.handle.db.select().from(cards).all();
    solRing = all.find((c) => c.name === "Sol Ring")!;
    signet = all.find((c) => c.name === "Arcane Signet")!;

    // Sol Ring as Scryfall lists a recent card: one plain printing and many special ones, most of them newer.
    printing(solRing, "sol-regular-old", { set: "old", releasedAt: "2010-01-01", collectorNumber: "270", inBooster: true });
    printing(solRing, "sol-regular-new", { set: "frc", setType: "commander", releasedAt: "2030-01-01", collectorNumber: "20" });
    printing(solRing, "sol-variant-same-day", { set: "frc", setType: "commander", releasedAt: "2030-01-01", collectorNumber: "120" });
    printing(solRing, "sol-borderless", { releasedAt: "2031-01-01", borderColor: "borderless", frameEffects: ["inverted"], promoTypes: ["boosterfun"], collectorNumber: "301" });
    printing(solRing, "sol-showcase", { releasedAt: "2031-01-01", frameEffects: ["showcase"], promoTypes: ["boosterfun"], collectorNumber: "302" });
    printing(solRing, "sol-extended", { releasedAt: "2031-01-01", frameEffects: ["extendedart"], collectorNumber: "303" });
    printing(solRing, "sol-surge", { releasedAt: "2031-01-01", promoTypes: ["surgefoil"], finishes: ["foil"], collectorNumber: "304" });
    // A precon card Scryfall tags "surgefoil" that also exists in non-foil: the plain card, still regular.
    printing(solRing, "sol-precon-surge-nonfoil", { releasedAt: "2029-01-01", promoTypes: ["surgefoil"], finishes: ["nonfoil", "foil"], collectorNumber: "13" });
    printing(solRing, "sol-secret-lair", { set: "sld", setType: "box", releasedAt: "2032-01-01", collectorNumber: "999" });
    printing(solRing, "sol-the-list", { set: "plst", setType: "masters", releasedAt: "2032-01-01", collectorNumber: "C21-263", inBooster: true });
    printing(solRing, "sol-promo", { set: "psol", setType: "promo", isPromo: true, promoTypes: ["prerelease"], releasedAt: "2032-01-01" });
    printing(solRing, "sol-retro", { releasedAt: "2031-01-01", frame: "1997", collectorNumber: "305" });
    // A card with no regular printing at all (a foil-only precon face commander) falls back to its least
    // special printing: foil-only beats a newer borderless showcase.
    const only = { oracleId: "only-specials", name: "Only Specials", normalizedName: "only specials" };
    printing(signet, "only-foil-face", { ...only, finishes: ["foil"], releasedAt: "2033-01-01" });
    printing(signet, "only-showcase", { ...only, frameEffects: ["showcase", "inverted"], releasedAt: "2034-01-01" });
    printing(signet, "only-promo", { ...only, isPromo: true, releasedAt: "2035-01-01" });
    ctx.index.build();
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const auth = (t = token) => ({ authorization: `Bearer ${t}` });

  it("resolves a bare name to the newest REGULAR printing, lowest collector number on the same day", async () => {
    expect(ctx.index.exact("sol ring")?.id).toBe("sol-regular-new");
    expect(ctx.index.search("sol ring")[0]?.id).toBe("sol-regular-new");
    const parsed = await ctx.app.inject({ method: "POST", url: "/api/decks/parse", headers: auth(), payload: { text: "1 Sol Ring\n1 Only Specials" } });
    const lines = (parsed.json() as ResolveResponse).lines;
    expect(lines[0]!.card?.id).toBe("sol-regular-new");
    expect(lines[1]!.card?.id).toBe("only-foil-face");
  });

  it("an exact set + number still wins, and a named set prefers its regular printing", async () => {
    const parsed = await ctx.app.inject({ method: "POST", url: "/api/decks/parse", headers: auth(), payload: { text: "1 Sol Ring (TST) 302\n1 Sol Ring (FRC)" } });
    const lines = (parsed.json() as ResolveResponse).lines;
    expect(lines[0]!.card?.id).toBe("sol-showcase");
    expect(lines[1]!.card?.id).toBe("sol-regular-new");
  });

  it("lists every paper printing newest first with set details, treatment labels and the default", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/cards/oracle/${solRing.oracleId}/printings` });
    const body = res.json() as PrintingsResponse;
    expect(body.defaultId).toBe("sol-regular-new");
    const dates = body.printings.map((p) => p.releasedAt);
    expect(dates).toEqual([...dates].sort().reverse());
    const byId = new Map(body.printings.map((p) => [p.id, p]));
    expect(byId.get("sol-regular-new")).toMatchObject({ isRegular: true, treatments: [], setName: "Test Set", releasedAt: "2030-01-01", set: "frc", collectorNumber: "20" });
    expect(byId.get("sol-borderless")!.treatments).toEqual(["Borderless", "Inverted frame", "Booster Fun"]);
    expect(byId.get("sol-showcase")!.treatments).toEqual(["Showcase", "Booster Fun"]);
    expect(byId.get("sol-extended")!.treatments).toEqual(["Extended art"]);
    expect(byId.get("sol-surge")!.treatments).toEqual(["Surge foil", "Foil only"]);
    expect(byId.get("sol-secret-lair")!.treatments).toEqual(["Secret Lair"]);
    expect(byId.get("sol-the-list")!.treatments).toEqual(["The List"]);
    expect(byId.get("sol-promo")!.treatments).toEqual(["Promo"]);
    expect(byId.get("sol-retro")!.treatments).toEqual(["Retro frame"]);
    expect(byId.get("sol-precon-surge-nonfoil")).toMatchObject({ isRegular: true, treatments: [] });
  });

  async function makeDeck(): Promise<DeckDetail> {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: auth(),
      payload: { name: "Printings", cards: [{ cardId: "sol-regular-new", quantity: 1, board: "main" }, { cardId: signet.id, quantity: 1, board: "main" }] },
    });
    expect(created.statusCode).toBe(201);
    return (created.json() as { deck: DeckDetail }).deck;
  }

  it("changes one line of my own deck to another printing of the same card and bumps the version", async () => {
    const deck = await makeDeck();
    const line = deck.cards.find((c) => c.cardId === "sol-regular-new")!;
    expect(typeof line.entryId).toBe("number");
    await new Promise((r) => setTimeout(r, 5));
    const res = await ctx.app.inject({ method: "PATCH", url: `/api/decks/${deck.id}/cards/${line.entryId}`, headers: auth(), payload: { cardId: "sol-borderless" } });
    expect(res.statusCode).toBe(200);
    const after = (res.json() as { deck: DeckDetail }).deck;
    expect(after.cards.find((c) => c.entryId === line.entryId)!.cardId).toBe("sol-borderless");
    expect(after.cards.find((c) => c.card.name === "Arcane Signet")!.cardId).toBe(signet.id);
    expect(after.updatedAt > deck.updatedAt).toBe(true);
  });

  it("refuses another card, someone else's deck, unknown lines and missing printings", async () => {
    const deck = await makeDeck();
    const line = deck.cards.find((c) => c.cardId === "sol-regular-new")!;
    const url = `/api/decks/${deck.id}/cards/${line.entryId}`;
    const patch = (u: string, cardId: unknown, t = token) => ctx.app.inject({ method: "PATCH", url: u, headers: auth(t), payload: { cardId } });
    const other = await patch(url, signet.id);
    expect(other.statusCode).toBe(400);
    expect((other.json() as { error: string }).error).toMatch(/different card/);
    expect((await patch(url, "no-such-printing")).statusCode).toBe(400);
    expect((await patch(url, undefined)).statusCode).toBe(400);
    expect((await patch(url, "sol-showcase", otherToken)).statusCode).toBe(404);
    expect((await patch(`/api/decks/${deck.id}/cards/999999`, "sol-showcase")).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "PATCH", url, payload: { cardId: "sol-showcase" } })).statusCode).toBe(401);
    const still = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}`, headers: auth() });
    expect((still.json() as { deck: DeckDetail }).deck.cards.find((c) => c.entryId === line.entryId)!.cardId).toBe("sol-regular-new");
  });

  it("library decks: the owner changes a printing, nobody else can", async () => {
    const deck = await makeDeck();
    const added = await ctx.app.inject({ method: "POST", url: `/api/library/from-deck/${deck.id}`, headers: auth(), payload: {} });
    expect(added.statusCode).toBeLessThan(300);
    const lib = (added.json() as { deck: LibraryDeckDetail }).deck;
    const line = lib.cards.find((c) => c.cardId === "sol-regular-new")!;
    expect(line).toMatchObject({ oracleId: solRing.oracleId, set: "frc", collectorNumber: "20", faceCount: 1 });
    const url = `/api/library/${lib.id}/cards/${line.entryId}`;
    expect((await ctx.app.inject({ method: "PATCH", url, headers: auth(otherToken), payload: { cardId: "sol-showcase" } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "PATCH", url, headers: auth(), payload: { cardId: signet.id } })).statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: "PATCH", url, headers: auth(), payload: { cardId: "sol-showcase" } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { deck: LibraryDeckDetail }).deck.cards.find((c) => c.entryId === line.entryId)!.cardId).toBe("sol-showcase");
  });
});
