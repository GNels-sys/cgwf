import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { DeckDetail, LibraryDeckDetail, LibraryListResponse, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-library-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { users } = await import("../db/schema.js");
const { MTGJSON_DECK_LIST_URL, MTGJSON_USER_AGENT } = await import("./precons.js");
const { SPELLBOOK_URL } = await import("../analysis/spellbook.js");
const { THORACLE_VARIANT } = await import("../analysis/fixtures.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

// Fixture printing ids (see scryfall/fixtures/cards.sample.json).
const SOL_RING = "a1b2c3d4-0000-4000-8000-000000000001";
const ATRAXA_NAME = "Atraxa, Praetors' Voice";

const DECK_LIST = {
  data: [
    { code: "TST", fileName: "TestPrecon_TST", name: "Test Precon", releaseDate: "2024-01-01", type: "Commander Deck" },
    { code: "TST", fileName: "Broken_TST", name: "Broken Precon", releaseDate: "2024-02-01", type: "Commander Deck" },
    { code: "TST", fileName: "Theme_TST", name: "Some Theme Deck", releaseDate: "2024-03-01", type: "Theme Deck" },
  ],
};
const DECK_FILES: Record<string, unknown> = {
  TestPrecon_TST: {
    data: {
      code: "TST",
      name: "Test Precon",
      releaseDate: "2024-01-01",
      commander: [{ name: ATRAXA_NAME, count: 1, identifiers: { scryfallId: "not-in-our-db" } }],
      mainBoard: [
        { name: "Sol Ring", count: 1, identifiers: { scryfallId: SOL_RING } },
        { name: "Arcane Signet", count: 1 },
        { name: "Lightning Bolt", count: 1 },
        { name: "Forest", count: 5 },
      ],
      sideBoard: [],
    },
  },
  Broken_TST: {
    data: { code: "TST", name: "Broken Precon", commander: [{ name: "No Such Card" }], mainBoard: [{ name: "Another Fake" }, { name: "Forest", count: 1 }] },
  },
};

describe("deck library (owner only)", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken = "";
  let otherToken = "";
  const mtgjsonCalls: string[] = [];
  const spellbookCalls: number[] = [];

  const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (url === SPELLBOOK_URL) {
      spellbookCalls.push(1);
      return new Response(JSON.stringify({ results: { identity: "WUBRG", included: [THORACLE_VARIANT], almostIncluded: [] } }), { status: 200 });
    }
    mtgjsonCalls.push(url);
    expect(headers.get("user-agent")).toBe(MTGJSON_USER_AGENT);
    if (url === MTGJSON_DECK_LIST_URL) return new Response(JSON.stringify(DECK_LIST), { status: 200 });
    const m = url.match(/\/decks\/([^/]+)\.json$/);
    const file = m ? DECK_FILES[decodeURIComponent(m[1]!)] : undefined;
    if (!file) return new Response("missing", { status: 404 });
    return new Response(JSON.stringify(file), { status: 200 });
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, spellbookFetch: fakeFetch, mtgjsonFetch: fakeFetch });
    await ctx.ingestor.run({ file: fixture });
    const reg = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Owner", avatar: "dragon", color: "gold" } });
    const owner = reg.json() as RegisterResponse;
    ownerToken = owner.token;
    // Grant the owner flag directly (the claim-code flow is covered by auth.test.ts).
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, owner.user.id)).run();
    const reg2 = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Guest", avatar: "owl", color: "jade" }, remoteAddress: "10.2.2.2" });
    otherToken = (reg2.json() as RegisterResponse).token;
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const asOwner = () => ({ authorization: `Bearer ${ownerToken}` });
  const asOther = () => ({ authorization: `Bearer ${otherToken}` });

  it("refuses non-owners and anonymous callers", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/library" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/library", headers: asOther() })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: "/api/library/import-precons", headers: asOther() })).statusCode).toBe(403);
  });

  it("imports Commander precons from MTGJSON in the background, idempotently", async () => {
    const start = await ctx.app.inject({ method: "POST", url: "/api/library/import-precons", headers: asOwner(), payload: {} });
    expect(start.statusCode).toBe(202);
    await ctx.precons.run(); // no-op while running; wait for the background run instead
    for (let i = 0; i < 200 && ctx.precons.state.running; i++) await new Promise((r) => setTimeout(r, 25));
    const state = ctx.precons.state;
    expect(state.phase).toBe("done");
    expect(state.total).toBe(2); // theme deck filtered out
    expect(state.imported).toBe(1);
    expect(state.errors.length).toBe(1);
    expect(state.errors[0]).toContain("Broken Precon");
    expect(mtgjsonCalls.filter((u) => u === MTGJSON_DECK_LIST_URL)).toHaveLength(1);

    const list = (await ctx.app.inject({ method: "GET", url: "/api/library", headers: asOwner() })).json() as LibraryListResponse;
    expect(list.decks).toHaveLength(1);
    expect(list.decks[0]).toMatchObject({ name: "Test Precon", source: "precon", bracket: 2, setCode: "TST", commanders: [ATRAXA_NAME], cardCount: 9 });
    expect(list.importState.phase).toBe("done");

    // Second run: everything already there is skipped, no deck files re-fetched.
    const before = mtgjsonCalls.length;
    await ctx.precons.run();
    expect(ctx.precons.state.skipped).toBe(1);
    expect(ctx.precons.state.imported).toBe(0);
    expect(mtgjsonCalls.length).toBe(before + 2); // list + the broken deck retried
    expect((await ctx.app.inject({ method: "GET", url: "/api/library", headers: asOwner() })).json().decks).toHaveLength(1);
  });

  it("stores the analysis and lets the owner edit bracket, tags, primer and eligibility", async () => {
    const list = (await ctx.app.inject({ method: "GET", url: "/api/library", headers: asOwner() })).json() as LibraryListResponse;
    const id = list.decks[0]!.id;
    const detail = (await ctx.app.inject({ method: "GET", url: `/api/library/${id}`, headers: asOwner() })).json() as { deck: LibraryDeckDetail };
    expect(detail.deck.analysis?.fastMana).toEqual(["Sol Ring"]);
    expect(detail.deck.analysis?.combos[0]?.twoCard).toBe(true);
    expect(detail.deck.floor).toBe(4);
    expect(detail.deck.cards.find((c) => c.name === "Forest")?.quantity).toBe(5);
    expect(detail.deck.primer).toBe("");

    const skeleton = (await ctx.app.inject({ method: "GET", url: `/api/library/${id}/primer-skeleton`, headers: asOwner() })).json() as { primer: string };
    expect(skeleton.primer).toContain("# Test Precon");
    expect(skeleton.primer).toContain("## Win conditions");

    const bad = await ctx.app.inject({ method: "PATCH", url: `/api/library/${id}`, headers: asOwner(), payload: { bracket: 9 } });
    expect(bad.statusCode).toBe(400);
    const patched = await ctx.app.inject({ method: "PATCH", url: `/api/library/${id}`, headers: asOwner(), payload: { bracket: 3, tags: ["tokens", "combo"], primer: skeleton.primer, agentEligible: true } });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { deck: LibraryDeckDetail }).deck).toMatchObject({ bracket: 3, tags: ["tokens", "combo"], agentEligible: true, hasPrimer: true });

    const filtered = (await ctx.app.inject({ method: "GET", url: "/api/library?bracket=3&tag=combo&agent=1", headers: asOwner() })).json() as LibraryListResponse;
    expect(filtered.decks).toHaveLength(1);
    const none = (await ctx.app.inject({ method: "GET", url: "/api/library?bracket=2", headers: asOwner() })).json() as LibraryListResponse;
    expect(none.decks).toHaveLength(0);
    const byName = (await ctx.app.inject({ method: "GET", url: "/api/library?q=atraxa", headers: asOwner() })).json() as LibraryListResponse;
    expect(byName.decks).toHaveLength(1);

    const re = await ctx.app.inject({ method: "POST", url: `/api/library/${id}/analyze`, headers: asOwner() });
    expect(re.statusCode).toBe(200);
    expect((re.json() as { deck: LibraryDeckDetail }).deck).toMatchObject({ bracket: 3, agentEligible: true }); // owner edits survive a re-analysis
  });

  it("adds one of the owner's own decks to the library once, then deletes it", async () => {
    const parsed = await ctx.app.inject({ method: "POST", url: "/api/decks/parse", headers: asOwner(), payload: { text: "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n2 Forest\n" } });
    const lines = (parsed.json() as { lines: Array<{ card: { id: string } | null; line: { quantity: number; board: string } }> }).lines;
    const created = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: asOwner(), payload: { name: "My Atraxa", cards: lines.filter((l) => l.card).map((l) => ({ cardId: l.card!.id, quantity: l.line.quantity, board: l.line.board })) } });
    const deck = (created.json() as { deck: DeckDetail }).deck;

    expect((await ctx.app.inject({ method: "POST", url: `/api/library/from-deck/${deck.id}`, headers: asOther() })).statusCode).toBe(403);
    const added = await ctx.app.inject({ method: "POST", url: `/api/library/from-deck/${deck.id}`, headers: asOwner(), payload: {} });
    expect(added.statusCode).toBe(201);
    const lib = (added.json() as { deck: LibraryDeckDetail }).deck;
    expect(lib).toMatchObject({ name: "My Atraxa", source: "user", commanders: [ATRAXA_NAME], cardCount: 4 });
    expect(lib.bracket).toBe(lib.suggested);
    expect((await ctx.app.inject({ method: "POST", url: `/api/library/from-deck/${deck.id}`, headers: asOwner(), payload: {} })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "POST", url: `/api/library/from-deck/nope`, headers: asOwner(), payload: {} })).statusCode).toBe(404);

    expect((await ctx.app.inject({ method: "GET", url: "/api/library?source=user", headers: asOwner() })).json().decks).toHaveLength(1);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/library/${lib.id}`, headers: asOwner() })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/api/library/${lib.id}`, headers: asOwner() })).statusCode).toBe(404);
  });
});
