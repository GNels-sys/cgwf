import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeckDetail, DoctorResponse, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-doctor-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { cards } = await import("../db/schema.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const view = (name: string, synergy: number, numDecks: number) => ({ name, synergy, num_decks: numDecks, potential_decks: 1000 });
const ATRAXA_PAGE = {
  container: {
    json_dict: {
      card: { name: "Atraxa, Praetors' Voice" },
      cardlists: [
        { tag: "creatures", cardviews: [view("Tireless Tracker", 0.45, 600), view("Scute Swarm", 0.5, 700), view("Lotus Cobra", 0.02, 50)] },
        { tag: "enchantments", cardviews: [view("Rancor", 0.4, 500), view("Glorious Anthem", 0.3, 400)] },
        { tag: "instants", cardviews: [view("Lightning Bolt", 0.9, 900)] },
        { tag: "manaartifacts", cardviews: [view("Sol Ring", -0.02, 950), view("Arcane Signet", 0.01, 800)] },
      ],
    },
  },
};
const edhrecCalls: string[] = [];
const edhrecFetch = async (url: string): Promise<Response> => {
  const p = url.replace("https://json.edhrec.com/pages/", "").replace(/\.json$/, "");
  edhrecCalls.push(p);
  if (p === "commanders/atraxa-praetors-voice") return new Response(JSON.stringify(ATRAXA_PAGE), { status: 200 });
  return new Response("<Error>AccessDenied</Error>", { status: 403 });
};

describe("Deck Doctor routes", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token = "";
  let otherToken = "";
  let deck: DeckDetail;
  const auth = (t = token) => ({ authorization: `Bearer ${t}` });
  const idOf = (name: string) => ctx.handle.db.select().from(cards).where(eq(cards.name, name)).all().find((c) => (c.legalities as Record<string, string>).commander === "legal")!;

  beforeAll(async () => {
    ctx = await buildApp({
      logger: false,
      edhrecFetch,
      edhrecCacheDir: path.join(tmp, "edhrec-cache"),
      edhrecGapMs: 0,
      spellbookFetch: async () => new Response(JSON.stringify({ results: { included: [], almostIncluded: [] } }), { status: 200 }),
    });
    await ctx.ingestor.run({ file: fixture });
    token = ((await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Alex", avatar: "dragon", color: "gold" } })).json() as RegisterResponse).token;
    otherToken = ((await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Sam", avatar: "owl", color: "jade" }, remoteAddress: "10.6.6.6" })).json() as RegisterResponse).token;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: auth(),
      payload: {
        name: "Atraxa doctor",
        cards: [
          { cardId: idOf("Atraxa, Praetors' Voice").id, quantity: 1, board: "commander" },
          { cardId: idOf("Sol Ring").id, quantity: 1, board: "main" },
          { cardId: idOf("Arcane Signet").id, quantity: 1, board: "main" },
          { cardId: idOf("Lotus Cobra").id, quantity: 1, board: "main" },
          { cardId: idOf("Lightning Greaves").id, quantity: 1, board: "main" },
          { cardId: idOf("Forest").id, quantity: 30, board: "main" },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    deck = (created.json() as { deck: DeckDetail }).deck;
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const doctorOf = async (url = `/api/decks/${deck.id}/doctor`, t = token) => {
    const r = await ctx.app.inject({ method: "GET", url, headers: auth(t) });
    return { status: r.statusCode, body: r.json() as DoctorResponse };
  };

  it("suggests cards from EDHREC's list for the commander, inside its colours, never already in the deck", async () => {
    const { status, body } = await doctorOf();
    expect(status).toBe(200);
    expect(body.edhrec).toMatchObject({ status: "ok", slug: "atraxa-praetors-voice", url: "https://edhrec.com/commanders/atraxa-praetors-voice" });
    expect(body.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    const adds = body.swaps.map((s) => s.add.name);
    expect(adds.length).toBeGreaterThan(0);
    expect(adds.every((a) => ["Tireless Tracker", "Scute Swarm", "Rancor", "Glorious Anthem"].includes(a))).toBe(true);
    expect(adds).not.toContain("Lightning Bolt");
    const cuts = body.swaps.map((s) => s.cut.name);
    expect(cuts).not.toContain("Atraxa, Praetors' Voice");
    expect(cuts).not.toContain("Forest");
    expect(body.canApply).toBe(true);
    expect(body.swaps[0]!.reason).toMatch(/synergy with Atraxa, in \d+% of Atraxa decks/);
    // Cached: the second view asks EDHREC nothing.
    const before = edhrecCalls.length;
    await doctorOf();
    expect(edhrecCalls.length).toBe(before);
  });

  it("remembers 'keep' and 'not interested' per player and deck", async () => {
    const first = (await doctorOf()).body;
    const top = first.swaps[0]!;
    const pref = (kind: "keep" | "dismiss", oracleId: string, name: string, method = "POST") =>
      ctx.app.inject({ method: method as "POST", url: "/api/doctor/prefs", headers: auth(), payload: { deckRef: deck.id, oracleId, name, kind } });
    expect((await pref("dismiss", top.add.oracleId!, top.add.name)).statusCode).toBe(200);
    expect((await pref("keep", top.cut.oracleId!, top.cut.name)).statusCode).toBe(200);
    const after = (await doctorOf()).body;
    expect(after.swaps.map((s) => s.add.name)).not.toContain(top.add.name);
    expect(after.swaps.map((s) => s.cut.name)).not.toContain(top.cut.name);
    expect(after.dismissed).toEqual([{ oracleId: top.add.oracleId, name: top.add.name }]);
    expect(after.keep).toEqual([{ oracleId: top.cut.oracleId, name: top.cut.name }]);
    // Someone else's deck: refused; their own view of the doctor has no choices of ours.
    expect((await ctx.app.inject({ method: "POST", url: "/api/doctor/prefs", headers: auth(otherToken), payload: { deckRef: deck.id, oracleId: "x", name: "x", kind: "keep" } })).statusCode).toBe(404);
    expect((await pref("dismiss", top.add.oracleId!, top.add.name, "DELETE")).statusCode).toBe(200);
    expect((await doctorOf()).body.dismissed).toEqual([]);
  });

  it("applies a swap to the owner's own deck only, with the same filters", async () => {
    const body = (await doctorOf()).body;
    const s = body.swaps[0]!;
    expect((await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/doctor/apply`, headers: auth(otherToken), payload: { cutEntryId: s.cut.entryId, addOracleId: s.add.oracleId } })).statusCode).toBe(404);
    const ok = await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/doctor/apply`, headers: auth(), payload: { cutEntryId: s.cut.entryId, addOracleId: s.add.oracleId } });
    expect(ok.statusCode).toBe(200);
    const now = ((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}`, headers: auth() })).json() as { deck: DeckDetail }).deck;
    expect(now.cards.map((c) => c.card.name)).toContain(s.add.name);
    expect(now.cards.map((c) => c.card.name)).not.toContain(s.cut.name);
    expect(now.updatedAt > deck.updatedAt).toBe(true);
    const commanderLine = now.cards.find((c) => c.board === "commander")!;
    const forest = now.cards.find((c) => c.card.name === "Forest")!;
    const apply = (cutEntryId: number, addOracleId: string) => ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/doctor/apply`, headers: auth(), payload: { cutEntryId, addOracleId } });
    expect((await apply(forest.entryId!, s.add.oracleId!)).statusCode).toBe(409); // already in the deck
    expect((await apply(forest.entryId!, idOf("Lightning Bolt").oracleId!)).statusCode).toBe(400); // outside the identity
    expect((await apply(commanderLine.entryId!, idOf("Rancor").oracleId!)).statusCode).toBe(400); // never the commander
    // Cutting one Forest from the 30-copy line keeps the other 29.
    expect((await apply(forest.entryId!, idOf("Glorious Anthem").oracleId!)).statusCode).toBe(200);
    const later = ((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}`, headers: auth() })).json() as { deck: DeckDetail }).deck;
    expect(later.cards.find((c) => c.card.name === "Forest")!.quantity).toBe(29);
  });

  it("library decks are read-only for everyone; strangers cannot read an own deck's doctor", async () => {
    const lib = await ctx.library.create(
      { name: "Atraxa library", source: "user", sourceKey: "test:atraxa", entries: [{ cardId: idOf("Atraxa, Praetors' Voice").id, quantity: 1, board: "commander" }, { cardId: idOf("Sol Ring").id, quantity: 1, board: "main" }, { cardId: idOf("Forest").id, quantity: 20, board: "main" }] },
      { combos: "skip" },
    );
    const r = await doctorOf(`/api/library-decks/${lib.id}/doctor`, otherToken);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ canApply: false, deckRef: `library:${lib.id}` });
    expect((await doctorOf(`/api/decks/${deck.id}/doctor`, otherToken)).status).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/doctor` })).statusCode).toBe(401);
  });

  it("says so plainly when EDHREC has no page for the commander", async () => {
    const lone = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: auth(),
      payload: { name: "No page", cards: [{ cardId: idOf("Tireless Tracker").id, quantity: 1, board: "commander" }, { cardId: idOf("Forest").id, quantity: 10, board: "main" }] },
    });
    const id = (lone.json() as { deck: DeckDetail }).deck.id;
    const { status, body } = await doctorOf(`/api/decks/${id}/doctor`);
    expect(status).toBe(200);
    expect(body.edhrec).toMatchObject({ status: "missing", message: "No EDHREC data for Tireless Tracker." });
    expect(body.swaps).toEqual([]);
  });
});
