import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { DeckPerformance, DeckStatsListResponse, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-deckstats-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { decks, gameResults, gameResultSeats } = await import("../db/schema.js");

describe("deck stats: counted games only, personal decks private, library decks shared", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let alex: RegisterResponse;
  let blair: RegisterResponse;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const now = "2026-10-19T00:00:00.000Z";

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, idleSweep: false });
    const reg = async (name: string, ip: string) => (await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip })).json() as RegisterResponse;
    alex = await reg("Alex", "10.2.0.1");
    blair = await reg("Blair", "10.2.0.2");
    ctx.handle.db.insert(decks).values({ id: "alex-deck", userId: alex.user.id, name: "Alex Elves", format: "commander", createdAt: now, updatedAt: now } as never).run();
    const add = (id: string, opts: { counted: boolean; test: boolean; endReason: string; tb: number }, seats: Array<{ seat: number; userId: string; ref: string; owner: string | null; name: string; won: boolean; place: number; isBot?: boolean }>) => {
      ctx.handle.db.insert(gameResults).values({ id, roomCode: id.slice(0, 6), startedAt: now, endedAt: now, tableBracket: opts.tb, playerCount: seats.length, test: opts.test, counted: opts.counted, endReason: opts.endReason, detail: null, turns: 5 }).run();
      for (const s of seats) ctx.handle.db.insert(gameResultSeats).values({ gameId: id, seat: s.seat, userId: s.userId, isBot: Boolean(s.isBot), deckRef: s.ref, deckOwnerId: s.owner, deckName: s.name, commanders: ["Cmdr"], deckBracket: 3, place: s.place, won: s.won, conceded: false }).run();
    };
    const seats = (alexWins: boolean) => [
      { seat: 0, userId: alex.user.id, ref: "alex-deck", owner: alex.user.id, name: "Alex Elves", won: alexWins, place: alexWins ? 1 : 2 },
      { seat: 1, userId: blair.user.id, ref: "library:precon-1", owner: null, name: "Precon One", won: !alexWins, place: alexWins ? 2 : 1 },
    ];
    add("counted-win", { counted: true, test: false, endReason: "win", tb: 3 }, seats(true));
    add("counted-loss", { counted: true, test: false, endReason: "win", tb: 3 }, seats(false));
    add("test-game", { counted: false, test: true, endReason: "win", tb: 3 }, seats(true));
    add("abandoned", { counted: false, test: false, endReason: "abandoned", tb: 3 }, seats(true));
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("counts only counted games (test and abandoned games are left out)", async () => {
    const p = (await ctx.app.inject({ method: "GET", url: "/api/deck-stats/deck/alex-deck", headers: auth(alex.token) })).json() as DeckPerformance;
    expect(p.overall).toMatchObject({ games: 2, wins: 1, winRate: 0.5 });
    expect(p.grid).toEqual([{ tableBracket: 3, players: 2, games: 2, wins: 1, winRate: 0.5, lowSample: true }]);
    expect(p.headToHead).toEqual([expect.objectContaining({ deckRef: "library:precon-1", games: 2, wins: 1, losses: 1 })]);
  });

  it("keeps a personal deck's stats private to its owner", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/deck-stats/deck/alex-deck", headers: auth(blair.token) })).statusCode).toBe(404);
    const blairList = (await ctx.app.inject({ method: "GET", url: "/api/deck-stats", headers: auth(blair.token) })).json() as DeckStatsListResponse;
    expect(blairList.decks.map((d) => d.deckRef)).toEqual(["library:precon-1"]); // the library deck Blair played, not Alex's deck
    const alexList = (await ctx.app.inject({ method: "GET", url: "/api/deck-stats", headers: auth(alex.token) })).json() as DeckStatsListResponse;
    expect(alexList.decks.map((d) => d.deckRef)).toEqual(["alex-deck"]);
  });

  it("aggregates a library deck across all players, readable by anyone signed in", async () => {
    const p = (await ctx.app.inject({ method: "GET", url: `/api/deck-stats/deck/${encodeURIComponent("library:precon-1")}`, headers: auth(alex.token) })).json() as DeckPerformance;
    expect(p.overall).toMatchObject({ games: 2, wins: 1 });
    expect(p.library).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: "/api/deck-stats", headers: {} })).statusCode).toBe(401);
  });
});
