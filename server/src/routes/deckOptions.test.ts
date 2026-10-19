import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { DeckOptionsResponse, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-deckopts-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { users } = await import("../db/schema.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const ID = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SOL_RING = ID(1);
const ATRAXA = ID(10);
const FOREST = ID(11);

describe("deck choice for engine tables: own decks OR the deck library, by bracket", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let alex = "";
  let owner = "";
  let libB2 = "";
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const register = async (name: string, ip: string) =>
    ((await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip })).json() as RegisterResponse);
  const legal = [{ cardId: ATRAXA, quantity: 1, board: "commander" as const }, { cardId: FOREST, quantity: 99, board: "main" as const }];

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, spellbookFetch: async () => new Response("down", { status: 503 }) });
    await ctx.ingestor.run({ file: fixture });
    alex = (await register("Alex", "10.1.0.1")).token;
    const o = await register("Owner", "10.1.0.2");
    owner = o.token;
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, o.user.id)).run();
    // library: two decks at bracket 2 (names out of order on purpose) and one at bracket 4
    libB2 = (await ctx.library.create({ name: "Zombie Horde", source: "precon", sourceKey: "test:z", bracket: 2, entries: legal }, { combos: "skip" })).id;
    await ctx.library.create({ name: "angel army", source: "precon", sourceKey: "test:a", bracket: 2, entries: legal }, { combos: "skip" });
    await ctx.library.create({ name: "Mana Rocks", source: "user", sourceKey: "test:m", bracket: 4, entries: [...legal, { cardId: SOL_RING, quantity: 1, board: "main" as const }] }, { combos: "skip" });
    // Alex's own decks
    for (const name of ["Forests", "Beta Forests"]) {
      const res = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth(alex), payload: { name, cards: legal } });
      expect(res.statusCode).toBe(201);
    }
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it("refuses to create a casual table; an engine table is the only kind", async () => {
    const casual = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(alex), payload: {} });
    expect(casual.statusCode).toBe(400);
    expect((casual.json() as { error: string }).error).toMatch(/Casual tables are retired/);
    const noBody = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(alex) });
    expect(noBody.statusCode).toBe(400);
    const engine = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(alex), payload: { engine: true } });
    expect([201, 503]).toContain(engine.statusCode); // 503 only because this test server has no engine
  });

  it("lets a non-owner read library decks (list and card list) but not edit them", async () => {
    const list = await ctx.app.inject({ method: "GET", url: "/api/library-decks", headers: auth(alex) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { decks: Array<{ name: string }> }).decks.map((d) => d.name)).toEqual(["angel army", "Mana Rocks", "Zombie Horde"]);
    const one = await ctx.app.inject({ method: "GET", url: `/api/library-decks/${libB2}`, headers: auth(alex) });
    expect(one.statusCode).toBe(200);
    const deck = (one.json() as { deck: { id: string; commanders: string[]; bracket: number; cards: Array<{ name: string; quantity: number; board: string }> } }).deck;
    expect(deck.id).toBe(`library:${libB2}`);
    expect(deck.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    expect(deck.cards.find((c) => c.board === "main")!.quantity).toBe(99);
    expect((await ctx.app.inject({ method: "GET", url: "/api/library-decks", headers: {} })).statusCode).toBe(401);
    // editing, the owner's library pages and primers stay owner-only
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/library/${libB2}`, headers: auth(alex), payload: { name: "Mine now" } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/library/${libB2}`, headers: auth(alex) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/api/library/${libB2}`, headers: auth(alex) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "PATCH", url: `/api/library/${libB2}`, headers: auth(owner), payload: { name: "Zombie Horde" } })).statusCode).toBe(200);
  });

  it("lists own decks and library decks alphabetically, filtered by bracket, own decks by their suggested bracket", async () => {
    const any = (await ctx.app.inject({ method: "GET", url: "/api/rooms/deck-options", headers: auth(alex) })).json() as DeckOptionsResponse;
    expect(any.mine.map((d) => d.name)).toEqual(["Beta Forests", "Forests"]);
    expect(any.library.map((d) => d.name)).toEqual(["angel army", "Mana Rocks", "Zombie Horde"]);
    expect(any.library.every((d) => d.id.startsWith("library:"))).toBe(true);
    const own = any.mine[0]!.bracket;
    expect(own).not.toBeNull(); // the analysis engine's suggestion, computed on demand
    const b2 = (await ctx.app.inject({ method: "GET", url: "/api/rooms/deck-options?bracket=2", headers: auth(alex) })).json() as DeckOptionsResponse;
    expect(b2.library.map((d) => d.name)).toEqual(["angel army", "Zombie Horde"]);
    expect(b2.mine.map((d) => d.name)).toEqual(own === 2 ? ["Beta Forests", "Forests"] : []);
    const b4 = (await ctx.app.inject({ method: "GET", url: "/api/rooms/deck-options?bracket=4", headers: auth(alex) })).json() as DeckOptionsResponse;
    expect(b4.library.map((d) => d.name)).toEqual(["Mana Rocks"]);
    const b5 = (await ctx.app.inject({ method: "GET", url: "/api/rooms/deck-options?bracket=5", headers: auth(alex) })).json() as DeckOptionsResponse;
    expect(b5).toEqual({ mine: own === 5 ? b5.mine : [], library: [] });
    // the owner sees only THEIR decks under "Your decks", never Alex's
    const ownerView = (await ctx.app.inject({ method: "GET", url: "/api/rooms/deck-options", headers: auth(owner) })).json() as DeckOptionsResponse;
    expect(ownerView.mine).toEqual([]);
  });

  it("seats a player with a library deck and shows it as a library deck", async () => {
    ctx.roomsManager.casualRooms = true; // a lobby without an engine: seating works the same on both kinds
    const created = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(alex), payload: {} });
    ctx.roomsManager.casualRooms = false;
    const code = (created.json() as { room: { code: string } }).room.code;
    const room = ctx.roomsManager.get(code)!;
    const alexId = room.info(null).members[0]!.userId;
    room.takeSeat(alexId, 0, `library:${libB2}`);
    const me = room.info(alexId).members.find((m) => m.userId === alexId)!;
    expect(me.deckName).toBe("Zombie Horde (library)");
    expect(me.commanders).toEqual(["Atraxa, Praetors' Voice"]);
    expect(() => room.takeSeat(alexId, 0, "library:no-such-deck")).toThrow(/deck not found/);
  });
});
