import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeckDetail, PlacementResponse, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-placement-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { cards, users } = await import("../db/schema.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const view = (name: string, synergy: number, numDecks: number) => ({ name, synergy, num_decks: numDecks, potential_decks: 1000 });
const page = (commander: string, lists: Array<{ tag: string; cardviews: unknown[] }>) => ({ container: { json_dict: { card: { name: commander }, cardlists: lists } } });
const ATRAXA_PAGE = page("Atraxa, Praetors' Voice", [
  { tag: "creatures", cardviews: [view("Tireless Tracker", 0.45, 600), view("Scute Swarm", 0.5, 700), view("Lotus Cobra", 0.02, 50)] },
  { tag: "enchantments", cardviews: [view("Rancor", 0.4, 500), view("Glorious Anthem", 0.3, 400)] },
  { tag: "manaartifacts", cardviews: [view("Sol Ring", -0.02, 950), view("Arcane Signet", 0.01, 800)] },
]);
const AKKI_PAGE = page("Akki Lavarunner // Tok-Tok, Volcano Born", [
  { tag: "instants", cardviews: [view("Lightning Bolt", 0.6, 800)] },
  { tag: "manaartifacts", cardviews: [view("Sol Ring", 0.05, 900), view("Arcane Signet", 0.02, 700)] },
]);
const edhrecCalls: string[] = [];
const edhrecFetch = async (url: string): Promise<Response> => {
  const p = url.replace("https://json.edhrec.com/pages/", "").replace(/\.json$/, "");
  edhrecCalls.push(p);
  if (p === "commanders/atraxa-praetors-voice") return new Response(JSON.stringify(ATRAXA_PAGE), { status: 200 });
  if (p.startsWith("commanders/akki-lavarunner")) return new Response(JSON.stringify(AKKI_PAGE), { status: 200 });
  return new Response("<Error>AccessDenied</Error>", { status: 403 });
};

describe("Card placement route (owner only)", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let owner = "";
  let player = "";
  let atraxa: DeckDetail;
  let akki: DeckDetail;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const idOf = (name: string) => ctx.handle.db.select().from(cards).where(eq(cards.name, name)).all().find((c) => (c.legalities as Record<string, string>).commander === "legal")!;
  const register = async (displayName: string, ip: string) =>
    ((await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName, avatar: "dragon", color: "gold" }, remoteAddress: ip })).json() as RegisterResponse);
  const createDeck = async (t: string, name: string, list: Array<[string, number, "commander" | "main"]>) => {
    const r = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: auth(t),
      payload: { name, cards: list.map(([n, quantity, board]) => ({ cardId: idOf(n).id, quantity, board })) },
    });
    expect(r.statusCode).toBe(201);
    return (r.json() as { deck: DeckDetail }).deck;
  };
  const place = async (body: unknown, t = owner) => {
    const r = await ctx.app.inject({ method: "POST", url: "/api/placement", headers: auth(t), payload: body as object });
    return { status: r.statusCode, body: r.json() as PlacementResponse & { error?: string } };
  };

  beforeAll(async () => {
    ctx = await buildApp({
      logger: false,
      edhrecFetch,
      edhrecCacheDir: path.join(tmp, "edhrec-cache"),
      edhrecGapMs: 0,
      spellbookFetch: async () => new Response(JSON.stringify({ results: { included: [], almostIncluded: [] } }), { status: 200 }),
    });
    await ctx.ingestor.run({ file: fixture });
    const o = await register("Owner", "10.7.0.1");
    owner = o.token;
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, o.user.id)).run();
    player = (await register("Sam", "10.7.0.2")).token;
    atraxa = await createDeck(owner, "Atraxa counters", [
      ["Atraxa, Praetors' Voice", 1, "commander"],
      ["Sol Ring", 1, "main"],
      ["Arcane Signet", 1, "main"],
      ["Lotus Cobra", 1, "main"],
      ["Lightning Greaves", 1, "main"],
      ["Forest", 30, "main"],
    ]);
    akki = await createDeck(owner, "Akki burn", [
      ["Akki Lavarunner // Tok-Tok, Volcano Born", 1, "commander"],
      ["Bonecrusher Giant // Stomp", 1, "main"],
      ["Lightning Greaves", 1, "main"],
      ["Arcane Signet", 1, "main"],
    ]);
    // Another player's deck never shows up in the owner's placement.
    await createDeck(player, "Sam's Atraxa", [["Atraxa, Praetors' Voice", 1, "commander"], ["Lightning Greaves", 1, "main"]]);
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is owner only", async () => {
    expect((await ctx.app.inject({ method: "POST", url: "/api/placement", payload: { text: "Sol Ring" } })).statusCode).toBe(401);
    expect((await place({ text: "Sol Ring" }, player)).status).toBe(403);
  });

  it("weighs every own deck and puts each card's best home first, with the reason it cannot go elsewhere", async () => {
    const { status, body } = await place({ text: "Tireless Tracker\nLightning Bolt\nSol Ring\n2 Rancor\nRancor\nNot A Real Card\nForest" });
    expect(status).toBe(200);
    expect(body.decks.map((d) => d.name).sort()).toEqual(["Akki burn", "Atraxa counters"]);
    expect(body.decks.every((d) => d.edhrec === "ok")).toBe(true);
    const byName = (n: string) => body.cards.find((c) => c.card?.name === n)!;

    // One entry per card: "2 Rancor" and "Rancor" collapse.
    expect(body.cards.filter((c) => c.card?.name === "Rancor")).toHaveLength(1);

    const tracker = byName("Tireless Tracker");
    expect(tracker.status).toBe("ok");
    expect(tracker.options.map((o) => o.deckName)).toEqual(["Atraxa counters"]);
    expect(tracker.options[0]).toMatchObject({ fit: "strong", synergy: 0.45 });
    expect(tracker.options[0]!.reason).toMatch(/synergy with Atraxa/);
    expect(tracker.options[0]!.cut.entryId).not.toBeNull();
    expect(tracker.skipped).toEqual([{ deckId: akki.id, deckName: "Akki burn", reason: expect.stringMatching(/^Outside Akki Lavarunner's colours/) }]);

    const bolt = byName("Lightning Bolt");
    expect(bolt.options.map((o) => o.deckName)).toEqual(["Akki burn"]);
    expect(bolt.skipped.map((s) => s.deckName)).toEqual(["Atraxa counters"]);

    // Already in one deck: only the other is offered.
    const sol = byName("Sol Ring");
    expect(sol.options.map((o) => o.deckName)).toEqual(["Akki burn"]);
    expect(sol.skipped).toEqual([{ deckId: atraxa.id, deckName: "Atraxa counters", reason: "Already in this deck." }]);

    // Two cards placed in the same deck get different cuts.
    const rancor = byName("Rancor");
    expect(rancor.options[0]!.deckName).toBe("Atraxa counters");
    expect(rancor.options[0]!.cut.entryId).not.toBe(tracker.options[0]!.cut.entryId);

    const missing = body.cards.find((c) => c.line === "Not A Real Card")!;
    expect(missing).toMatchObject({ status: "unresolved", card: null, options: [] });
    expect(byName("Forest")).toMatchObject({ status: "not_legal", options: [] });
  });

  it("adds the card with the shown swap through the Doctor's apply route, then sees it as placed", async () => {
    const before = (await place({ text: "Tireless Tracker" })).body.cards[0]!;
    const best = before.options[0]!;
    const applied = await ctx.app.inject({
      method: "POST",
      url: `/api/decks/${best.deckId}/doctor/apply`,
      headers: auth(owner),
      payload: { cutEntryId: best.cut.entryId, addOracleId: before.oracleId },
    });
    expect(applied.statusCode).toBe(200);
    const deck = ((await ctx.app.inject({ method: "GET", url: `/api/decks/${best.deckId}`, headers: auth(owner) })).json() as { deck: DeckDetail }).deck;
    expect(deck.cards.map((c) => c.card.name)).toContain("Tireless Tracker");
    expect(deck.cards.map((c) => c.card.name)).not.toContain(best.cut.name);
    const after = (await place({ text: "Tireless Tracker" })).body.cards[0]!;
    expect(after.options).toEqual([]);
    expect(after.skipped.find((s) => s.deckId === atraxa.id)?.reason).toBe("Already in this deck.");
  });

  it("weighs only the picked decks, and refuses decks that are not yours or an empty list", async () => {
    const only = (await place({ text: "Rancor", deckIds: [akki.id] })).body;
    expect(only.decks.map((d) => d.name)).toEqual(["Akki burn"]);
    expect(only.cards[0]!.options).toEqual([]);
    expect(only.cards[0]!.skipped.map((s) => s.deckName)).toEqual(["Akki burn"]);
    expect((await place({ text: "Rancor", deckIds: ["not-mine"] })).status).toBe(400);
    expect((await place({ text: "   " })).status).toBe(400);
    expect((await place({})).status).toBe(400);
  });
});
