import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { PlayerDetailResponse, PlayersResponse, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-players-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { decks, gameResults, gameResultSeats, users } = await import("../db/schema.js");

describe("players page: who is listed, what is shown, hiding, friend requests", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let alex: RegisterResponse; // account, decks, games
  let blair: RegisterResponse; // device-only, one counted game
  let cara: RegisterResponse; // device-only, nothing: not listed
  let dana: RegisterResponse; // account, hides herself
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const now = "2026-10-28T00:00:00.000Z";

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, idleSweep: false });
    const reg = async (name: string, ip: string) => (await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip })).json() as RegisterResponse;
    alex = await reg("Alex", "10.7.0.1");
    blair = await reg("Blair", "10.7.0.2");
    cara = await reg("Cara", "10.7.0.3");
    dana = await reg("Dana", "10.7.0.4");
    for (const [u, email, ip] of [[alex, "alex@example.com", "10.7.0.1"], [dana, "dana@example.com", "10.7.0.4"]] as const) {
      expect((await ctx.app.inject({ method: "POST", url: "/api/auth/signup", headers: auth(u.token), payload: { email, password: "longenough1" }, remoteAddress: ip })).statusCode).toBeLessThan(300);
    }
    ctx.handle.db.insert(users).values({ id: "bot-1", displayName: "Krenko bot", avatar: "skull", color: "ruby", isAgent: true, createdAt: now, lastSeenAt: now }).run();
    ctx.handle.db.insert(decks).values({ id: "alex-deck", userId: alex.user.id, name: "Alex's Secret Elves", format: "commander", createdAt: now, updatedAt: now } as never).run();
    const add = (id: string, counted: boolean, seats: Array<{ seat: number; userId: string; won: boolean; place: number; bracket: number; isBot?: boolean }>) => {
      ctx.handle.db.insert(gameResults).values({ id, roomCode: id.slice(0, 6), startedAt: now, endedAt: now, tableBracket: 3, playerCount: seats.length, test: !counted, counted, endReason: "win", detail: null, turns: 7 }).run();
      for (const s of seats) ctx.handle.db.insert(gameResultSeats).values({ gameId: id, seat: s.seat, userId: s.userId, isBot: Boolean(s.isBot), deckRef: `${s.userId}-ref`, deckOwnerId: s.isBot ? null : s.userId, deckName: "Hidden Name", commanders: ["Lathril"], deckBracket: s.bracket, place: s.place, won: s.won, conceded: false }).run();
    };
    add("game-1", true, [{ seat: 0, userId: alex.user.id, won: true, place: 1, bracket: 3 }, { seat: 1, userId: blair.user.id, won: false, place: 2, bracket: 2 }, { seat: 2, userId: "bot-1", won: false, place: 3, bracket: 2, isBot: true }]);
    add("test-game", false, [{ seat: 0, userId: alex.user.id, won: false, place: 2, bracket: 3 }, { seat: 1, userId: blair.user.id, won: true, place: 1, bracket: 2 }]);
    // Dana hides herself from the page
    expect((await ctx.app.inject({ method: "PUT", url: "/api/me/settings", headers: auth(dana.token), payload: { hideFromPlayers: true } })).statusCode).toBe(200);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const list = async (token: string) => (await ctx.app.inject({ method: "GET", url: "/api/players", headers: auth(token) })).json() as PlayersResponse;

  it("lists accounts and anyone with a deck or a counted game, never bots or hidden players, me first", async () => {
    const res = await list(blair.token);
    expect(res.players.map((p) => p.name)).toEqual(["Blair", "Alex"]);
    expect(res.players[0]!.isMe).toBe(true);
    const alexCard = res.players[1]!;
    expect(alexCard).toMatchObject({ decks: 1, hasAccount: true, isFriend: false, playsAt: 2 });
    expect(alexCard.performance).toMatchObject({ games: 1, wins: 1 }); // the test game is not counted
    expect((await ctx.app.inject({ method: "GET", url: "/api/players" })).statusCode).toBe(401);
  });

  it("a hidden player still sees herself, marked hidden, and nobody else can open her", async () => {
    const own = await list(dana.token);
    expect(own.players[0]).toMatchObject({ name: "Dana", isMe: true });
    const mine = (await ctx.app.inject({ method: "GET", url: `/api/players/${dana.user.id}`, headers: auth(dana.token) })).json() as PlayerDetailResponse;
    expect(mine.hidden).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: `/api/players/${dana.user.id}`, headers: auth(alex.token) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/api/players/${cara.user.id}`, headers: auth(alex.token) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/api/players/bot-1", headers: auth(alex.token) })).statusCode).toBe(404);
  });

  it("the detail shows records and commanders, never a deck name or list", async () => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/players/${alex.user.id}`, headers: auth(blair.token) });
    expect(res.statusCode).toBe(200);
    const d = res.json() as PlayerDetailResponse;
    expect(d.byOpponentBracket).toEqual([expect.objectContaining({ opponentBracket: 2, games: 1, wins: 1 })]);
    expect(d.recent[0]).toMatchObject({ players: 3, won: true, commanders: ["Lathril"] });
    expect(d.deckList).toHaveLength(1);
    expect(res.body).not.toContain("Secret Elves");
    expect(res.body).not.toContain("Hidden Name");
    expect(d.friendRequest).toBeNull();
  });

  it("sends a friend request from a player card, and the other side sees it waiting", async () => {
    const sent = await ctx.app.inject({ method: "POST", url: `/api/players/${alex.user.id}/friend-request`, headers: auth(blair.token) });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ outcome: "sent" });
    const again = await ctx.app.inject({ method: "POST", url: `/api/players/${alex.user.id}/friend-request`, headers: auth(blair.token) });
    expect(again.statusCode).toBe(409);
    const seen = (await ctx.app.inject({ method: "GET", url: `/api/players/${blair.user.id}`, headers: auth(alex.token) })).json() as PlayerDetailResponse;
    expect(seen.friendRequest).toBe("received");
    // answering from the card accepts the crossed request
    const accept = await ctx.app.inject({ method: "POST", url: `/api/players/${blair.user.id}/friend-request`, headers: auth(alex.token) });
    expect(accept.json()).toMatchObject({ outcome: "accepted" });
    expect((await list(alex.token)).players.find((p) => p.name === "Blair")!.isFriend).toBe(true);
    expect((await ctx.app.inject({ method: "POST", url: `/api/players/${dana.user.id}/friend-request`, headers: auth(alex.token) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: `/api/players/${alex.user.id}/friend-request`, headers: auth(alex.token) })).statusCode).toBe(400);
  });
});
