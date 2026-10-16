import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeckDetail, DeckSummary, RegisterResponse, ResolveResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-decks-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const MOXFIELD_STYLE = `1 Atraxa, Praetors' Voice (CM2) 1

1 Arcane Signet (C20) 234
1 Sol Ring (CMM) 410
1 Fire // Ice
1 Sol Rign
1 Lightning Bolt (STA) 42
1 Delver of Secrets
1 Bonecrusher Giant // Stomp (ELD) 115
1 Akki Lavarunner
1 Totally Made Up Card
3 Forest

SIDEBOARD:
1 Lightning Bolt
`;

describe("identity + decks", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token = "";
  let otherToken = "";

  beforeAll(async () => {
    ctx = await buildApp({ logger: false });
    await ctx.ingestor.run({ file: fixture });
    const reg = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Alex", avatar: "dragon", color: "gold" } });
    expect(reg.statusCode).toBe(200);
    token = (reg.json() as RegisterResponse).token;
    const reg2 = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Jordan", avatar: "owl", color: "jade" }, remoteAddress: "10.1.1.2" });
    otherToken = (reg2.json() as RegisterResponse).token;
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const auth = (t = token) => ({ authorization: `Bearer ${t}` });

  it("rejects bad registrations and unauthenticated access", async () => {
    const bad = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "", avatar: "dragon", color: "gold" } });
    expect(bad.statusCode).toBe(400);
    const anon = await ctx.app.inject({ method: "GET", url: "/api/me" });
    expect(anon.statusCode).toBe(401);
    const me = await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth() });
    expect(me.json()).toMatchObject({ user: { displayName: "Alex", avatar: "dragon" } });
  });

  it("updates the profile", async () => {
    const res = await ctx.app.inject({ method: "PATCH", url: "/api/me", headers: auth(), payload: { displayName: "Alex P", color: "ruby" } });
    expect(res.json()).toMatchObject({ user: { displayName: "Alex P", color: "ruby" } });
  });

  let parsed: ResolveResponse;

  it("resolves a Moxfield-style list: exact printings, names, fuzzy, unknown, heuristic commander", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/decks/parse", headers: auth(), payload: { text: MOXFIELD_STYLE } });
    expect(res.statusCode).toBe(200);
    parsed = res.json() as ResolveResponse;
    const by = (name: string) => parsed.lines.find((l) => l.line.name === name)!;

    expect(by("Atraxa, Praetors' Voice")).toMatchObject({ status: "resolved", commander: true });
    expect(by("Atraxa, Praetors' Voice").card?.set).toBe("cm2");
    expect(by("Arcane Signet")).toMatchObject({ status: "resolved", commander: false });
    // (CMM) 410 is not in the fixture: falls back to another printing with a note.
    expect(by("Sol Ring")).toMatchObject({ status: "resolved" });
    expect(by("Sol Ring").note).toContain("not found");
    expect(by("Fire // Ice").status).toBe("resolved");
    expect(by("Sol Rign")).toMatchObject({ status: "ambiguous" });
    expect(by("Sol Rign").candidates[0]?.name).toBe("Sol Ring");
    expect(by("Totally Made Up Card")).toMatchObject({ status: "unresolved", card: null });
    expect(by("Delver of Secrets").card?.layout).toBe("transform");
    expect(by("Forest").line.quantity).toBe(3);
    expect(parsed.lines.filter((l) => l.line.board === "sideboard")).toHaveLength(1);
    expect(parsed.suggestedName).toBe("Atraxa, Praetors' Voice");
    expect(parsed.counts).toEqual({ resolved: 10, ambiguous: 1, unresolved: 1 });
  });

  let deckId = "";

  it("saves a deck, lists it, and reports warnings", async () => {
    const cards = parsed.lines
      .filter((l) => l.card)
      .map((l) => ({ cardId: l.card!.id, quantity: l.line.quantity, board: l.commander ? "commander" : l.line.board }));
    const res = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth(), payload: { name: "Atraxa test", cards, sourceText: MOXFIELD_STYLE } });
    expect(res.statusCode).toBe(201);
    const deck = (res.json() as { deck: DeckDetail }).deck;
    deckId = deck.id;
    expect(deck.commanders[0]?.name).toBe("Atraxa, Praetors' Voice");
    expect(deck.cardCount).toBe(12); // 1 commander + 8 main singles + 3 Forest (sideboard excluded)
    const codes = deck.warnings.map((w) => w.code);
    expect(codes).toContain("size");
    expect(codes).toContain("color_identity"); // Lightning Bolt / Akki are red
    expect(codes).toContain("singleton"); // "Sol Ring" + "Sol Rign" both resolve to Sol Ring; 3 Forests are exempt

    const list = await ctx.app.inject({ method: "GET", url: "/api/decks", headers: auth() });
    const decks = (list.json() as { decks: DeckSummary[] }).decks;
    expect(decks).toHaveLength(1);
    expect(decks[0]?.commanders[0]?.name).toBe("Atraxa, Praetors' Voice");
  });

  it("keeps decks private to their owner", async () => {
    const other = await ctx.app.inject({ method: "GET", url: `/api/decks/${deckId}`, headers: auth(otherToken) });
    expect(other.statusCode).toBe(404);
    const otherList = await ctx.app.inject({ method: "GET", url: "/api/decks", headers: auth(otherToken) });
    expect((otherList.json() as { decks: DeckSummary[] }).decks).toHaveLength(0);
  });

  it("renames, replaces cards and deletes", async () => {
    const ren = await ctx.app.inject({ method: "PATCH", url: `/api/decks/${deckId}`, headers: auth(), payload: { name: "Renamed" } });
    expect((ren.json() as { deck: DeckDetail }).deck.name).toBe("Renamed");
    const rep = await ctx.app.inject({
      method: "PUT",
      url: `/api/decks/${deckId}/cards`,
      headers: auth(),
      payload: { cards: [{ cardId: "a1b2c3d4-0000-4000-8000-000000000001", quantity: 2, board: "main" }] },
    });
    const deck = (rep.json() as { deck: DeckDetail }).deck;
    expect(deck.cards).toHaveLength(1);
    expect(deck.warnings.map((w) => w.code)).toContain("singleton");
    const bad = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth(), payload: { name: "x", cards: [{ cardId: "nope", quantity: 1 }] } });
    expect(bad.statusCode).toBe(400);
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/decks/${deckId}`, headers: auth() });
    expect(del.statusCode).toBe(200);
    const gone = await ctx.app.inject({ method: "GET", url: `/api/decks/${deckId}`, headers: auth() });
    expect(gone.statusCode).toBe(404);
  });

  it("explains Moxfield links and rejects junk", async () => {
    const mox = await ctx.app.inject({ method: "GET", url: "/api/decks/import-url?url=https://www.moxfield.com/decks/abc123", headers: auth() });
    expect(mox.statusCode).toBe(400);
    expect((mox.json() as { error: string }).error).toContain("Moxfield");
    const junk = await ctx.app.inject({ method: "GET", url: "/api/decks/import-url?url=not-a-url", headers: auth() });
    expect(junk.statusCode).toBe(400);
  });
});
