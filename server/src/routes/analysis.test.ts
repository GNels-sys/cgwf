import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeckAnalysisResponse, DeckDetail, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-analysis-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { SPELLBOOK_URL } = await import("../analysis/spellbook.js");
const { THORACLE_VARIANT } = await import("../analysis/fixtures.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

describe("deck analysis route", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token = "";
  let deck: DeckDetail;
  const calls: Array<{ url: string; body: unknown; ua: string | undefined }> = [];
  let spellbookStatus = 200;

  const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    calls.push({ url, body: JSON.parse(String(init.body)), ua: headers.get("user-agent") ?? undefined });
    if (spellbookStatus !== 200) return new Response("nope", { status: spellbookStatus });
    return new Response(JSON.stringify({ results: { identity: "WUBRG", included: [THORACLE_VARIANT], almostIncluded: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, spellbookFetch: fakeFetch });
    await ctx.ingestor.run({ file: fixture });
    const reg = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Alex", avatar: "dragon", color: "gold" } });
    token = (reg.json() as RegisterResponse).token;
    const parsed = await ctx.app.inject({
      method: "POST",
      url: "/api/decks/parse",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n1 Lightning Bolt\n3 Forest\n" },
    });
    const lines = (parsed.json() as { lines: Array<{ card: { id: string } | null; line: { quantity: number; board: string } }> }).lines;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Atraxa test", cards: lines.filter((l) => l.card).map((l) => ({ cardId: l.card!.id, quantity: l.line.quantity, board: l.line.board })) },
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
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/analysis` })).statusCode).toBe(401);
    const other = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Sam", avatar: "owl", color: "jade" }, remoteAddress: "10.3.3.3" });
    const res = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/analysis`, headers: { authorization: `Bearer ${(other.json() as RegisterResponse).token}` } });
    expect(res.statusCode).toBe(404);
  });

  it("analyses the deck, asks Spellbook once with a named User-Agent, then serves the cache", async () => {
    const first = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/analysis`, headers: auth() });
    expect(first.statusCode).toBe(200);
    const body = first.json() as DeckAnalysisResponse;
    expect(body.combosCached).toBe(false);
    expect(body.analysis.combosStatus).toBe("ok");
    expect(body.analysis.combos[0]).toMatchObject({ twoCard: true, early: true });
    expect(body.analysis.floor).toBe(4);
    expect(body.analysis.fastMana).toEqual(["Sol Ring"]);
    expect(body.analysis.stats.cards).toBe(7);
    expect(body.analysis.stats.landCount).toBe(3);
    expect(body.analysis.summary).toContain("Atraxa, Praetors' Voice");
    expect(body.analysis.judgmentNote).toContain("3 vs 4");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SPELLBOOK_URL);
    expect(calls[0]!.ua).toContain("CGwF");
    expect(calls[0]!.body).toMatchObject({ commanders: [{ card: "Atraxa, Praetors' Voice", quantity: 1 }] });
    expect((calls[0]!.body as { main: Array<{ card: string; quantity: number }> }).main).toContainEqual({ card: "Forest", quantity: 3 });

    const second = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/analysis`, headers: auth() });
    expect((second.json() as DeckAnalysisResponse).combosCached).toBe(true);
    expect(calls).toHaveLength(1);

    const refreshed = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/analysis?refresh=1`, headers: auth() });
    expect((refreshed.json() as DeckAnalysisResponse).combosCached).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("keeps the analysis when Spellbook fails, falling back to the stale cache", async () => {
    spellbookStatus = 503;
    const res = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/analysis?refresh=1`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DeckAnalysisResponse;
    expect(body.combosCached).toBe(true);
    expect(body.analysis.combosStatus).toBe("ok");
    spellbookStatus = 200;
  });

  it("re-analyses after the list changes (new list, new Spellbook call)", async () => {
    const before = calls.length;
    const replaced = await ctx.app.inject({
      method: "PUT",
      url: `/api/decks/${deck.id}/cards`,
      headers: auth(),
      payload: { cards: deck.cards.filter((c) => c.card.name !== "Sol Ring").map((c) => ({ cardId: c.cardId, quantity: c.quantity, board: c.board })) },
    });
    expect(replaced.statusCode).toBe(200);
    const res = await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/analysis`, headers: auth() });
    const body = res.json() as DeckAnalysisResponse;
    expect(body.analysis.fastMana).toEqual([]);
    expect(calls.length).toBe(before + 1);
  });
});
