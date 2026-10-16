import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { AdminStatsResponse, AdminUserDetail, DeckDetail, RegisterResponse } from "@cgwf/shared";
import { ADMIN_WEEKS } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-admin-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { weekStartUtc } = await import("./admin.js");
const { presence } = await import("../social/presence.js");
const { agentRuns, decks, friendships, libraryDecks, librarySubmissions, roomEvents, roomMembers, rooms, sessions, users } = await import("../db/schema.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const DAY = 24 * 60 * 60 * 1000;
const CARD = "a1b2c3d4-0000-4000-8000-000000000001";

interface Person {
  token: string;
  id: string;
}

/**
 * A small world: Alex (account, two devices, two decks, hosts a game), Blair
 * (device only, joined three weeks ago, played in Alex's game, last seen ten
 * days ago), Casey (device only, 40 days quiet, spectator), the Owner, and one
 * agent user that must never appear.
 */
describe("owner-only platform overview", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let alex: Person;
  let blair: Person;
  let casey: Person;
  let owner: Person;
  let agentId = "";
  let alexDeck1 = "";
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();

  const register = async (name: string, ip: string): Promise<Person> => {
    const r = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "owl", color: "jade" }, remoteAddress: ip });
    expect(r.statusCode).toBe(200);
    const body = r.json() as RegisterResponse;
    return { token: body.token, id: body.user.id };
  };
  const as = (p: Person) => ({ authorization: `Bearer ${p.token}` });
  const makeDeck = async (p: Person, name: string): Promise<string> => {
    const r = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: as(p), payload: { name, cards: [{ cardId: CARD, quantity: 1, board: "main" }] } });
    expect(r.statusCode).toBe(201);
    return (r.json() as { deck: DeckDetail }).deck.id;
  };
  const stats = async (qs = "", who: Person = owner): Promise<AdminStatsResponse> => {
    const r = await ctx.app.inject({ method: "GET", url: `/api/admin/stats${qs}`, headers: as(who) });
    expect(r.statusCode).toBe(200);
    return r.json() as AdminStatsResponse;
  };
  const touch = (userId: string, ms: number) => {
    ctx.handle.db.update(users).set({ lastSeenAt: iso(ms) }).where(eq(users.id, userId)).run();
    ctx.handle.db.update(sessions).set({ lastSeenAt: iso(ms), createdAt: iso(ms) }).where(eq(sessions.userId, userId)).run();
  };
  /**
   * Every authenticated request bumps last_seen and the presence map, so the
   * seeded "last seen" dates are applied after the API calls that need those
   * users (and again after the 403 checks). Presence is emptied with a sweep
   * far in the future.
   */
  const freeze = () => {
    touch(blair.id, now - 10 * DAY);
    ctx.handle.db.update(decks).set({ createdAt: iso(now - 10 * DAY), updatedAt: iso(now - 10 * DAY) }).where(eq(decks.userId, blair.id)).run();
    touch(casey.id, now - 40 * DAY);
    presence.sweep(Date.now() + 60 * 60 * 1000);
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false });
    await ctx.ingestor.run({ file: fixture });
    alex = await register("Alex", "10.9.0.1");
    blair = await register("Blair", "10.9.0.2");
    casey = await register("Casey", "10.9.0.3");
    owner = await register("Owner", "10.9.0.4");
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, owner.id)).run();

    // Alex gets an account and signs in from a laptop too (two sessions).
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/signup", headers: as(alex), payload: { email: "alex@example.com", password: "longenough1" }, remoteAddress: "10.9.0.1" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "alex@example.com", password: "longenough1" }, remoteAddress: "10.9.0.5" })).statusCode).toBe(200);

    // Blair joined three weeks ago and was last seen ten days ago; Casey has been quiet for 40 days.
    ctx.handle.db.update(users).set({ createdAt: iso(now - 21 * DAY) }).where(eq(users.id, blair.id)).run();
    ctx.handle.db.update(users).set({ createdAt: iso(now - 40 * DAY) }).where(eq(users.id, casey.id)).run();

    // An agent user: no sessions, excluded everywhere.
    agentId = randomUUID();
    ctx.handle.db.insert(users).values({ id: agentId, displayName: "Krenko bot", avatar: "skull", color: "ruby", isAgent: true, createdAt: iso(now), lastSeenAt: iso(now) }).run();

    alexDeck1 = await makeDeck(alex, "Alex one");
    await makeDeck(alex, "Alex two");
    const blairDeck = await makeDeck(blair, "Blair deck");

    // Submissions: Alex pending + approved (the approved one is in the library at bracket 3), Blair rejected.
    const libId = randomUUID();
    ctx.handle.db
      .insert(libraryDecks)
      .values({ id: libId, name: "Alex one (Alex)", source: "user", sourceKey: `deck:${alexDeck1}`, commanders: [], bracket: 3, tags: [], primer: "", agentEligible: true, createdBy: alex.id, createdAt: iso(now), updatedAt: iso(now) })
      .run();
    const sub = (userId: string, deckId: string, deckName: string, status: string, createdAt: number, libraryDeckId: string | null = null) =>
      ctx.handle.db
        .insert(librarySubmissions)
        .values({ id: randomUUID(), deckId, userId, deckName, note: "", cards: [], commanders: [], status, reason: status === "rejected" ? "too strong" : null, libraryDeckId, createdAt: iso(createdAt), reviewedAt: status === "pending" ? null : iso(createdAt + 1000) })
        .run();
    sub(alex.id, alexDeck1, "Alex one", "approved", now - 2 * DAY, libId);
    sub(alex.id, alexDeck1, "Alex one", "pending", now - DAY);
    sub(blair.id, blairDeck, "Blair deck", "rejected", now - 12 * DAY);

    // A game hosted by Alex with Blair playing and Casey watching, started now; an older empty lobby of Blair's.
    const gameId = randomUUID();
    ctx.handle.db.insert(rooms).values({ id: gameId, code: "ADMIN1", hostUserId: alex.id, status: "playing", format: "commander", seed: "s", lastSeq: 2, createdAt: iso(now), updatedAt: iso(now) }).run();
    ctx.handle.db
      .insert(roomMembers)
      .values([
        { roomId: gameId, userId: alex.id, role: "player", seat: 0, deckId: alexDeck1, joinedAt: iso(now) },
        { roomId: gameId, userId: blair.id, role: "player", seat: 1, deckId: blairDeck, joinedAt: iso(now) },
        { roomId: gameId, userId: casey.id, role: "spectator", seat: null, deckId: null, joinedAt: iso(now) },
      ])
      .run();
    ctx.handle.db
      .insert(roomEvents)
      .values([
        { roomId: gameId, seq: 1, actor: "system", type: "GameStarted", payload: "{}", ts: now },
        { roomId: gameId, seq: 2, actor: blair.id, type: "LifeChanged", payload: "{}", ts: now - 10 * DAY },
      ])
      .run();
    const lobbyId = randomUUID();
    ctx.handle.db.insert(rooms).values({ id: lobbyId, code: "ADMIN2", hostUserId: blair.id, status: "lobby", format: "commander", seed: "s", lastSeq: 0, createdAt: iso(now - 10 * DAY), updatedAt: iso(now - 10 * DAY) }).run();

    // Agent runs: one inside the 30-day window, one outside.
    ctx.handle.db
      .insert(agentRuns)
      .values([
        { id: randomUUID(), roomId: gameId, userId: agentId, seat: 2, deckName: "Precon", model: "m", mode: "live", status: "ended", decisions: 4, costUsd: 1.25, startedAt: iso(now - 5 * DAY) },
        { id: randomUUID(), roomId: lobbyId, userId: agentId, seat: 2, deckName: "Precon", model: "m", mode: "live", status: "ended", decisions: 9, costUsd: 9, startedAt: iso(now - 40 * DAY) },
      ])
      .run();

    ctx.handle.db
      .insert(friendships)
      .values([
        { userId: alex.id, friendId: blair.id, createdAt: iso(now) },
        { userId: blair.id, friendId: alex.id, createdAt: iso(now) },
      ])
      .run();
    freeze();
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("answers 401 signed out and 403 for a player", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/stats" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/stats", headers: as(casey) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/api/admin/users/${alex.id}` })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: `/api/admin/users/${alex.id}`, headers: as(casey) })).statusCode).toBe(403);
    freeze();
  });

  it("reports presence from live requests too", async () => {
    // Blair's own request (a 403) is still a sign of life for the overview.
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/stats", headers: as(blair) })).statusCode).toBe(403);
    expect((await stats("?refresh=1")).users.find((u) => u.displayName === "Blair")?.online).toBe(true);
    freeze();
    expect((await stats("?refresh=1")).users.find((u) => u.displayName === "Blair")?.online).toBe(false);
  });

  it("counts the seeded world, agents excluded", async () => {
    const s = await stats("?refresh=1");
    expect(s.cached).toBe(false);
    expect(s.totals).toMatchObject({
      users: 4,
      usersWithEmail: 1,
      usersDeviceOnly: 3,
      owners: 1,
      activeToday: 2, // Alex and the Owner
      active7d: 2,
      active30d: 3, // + Blair (10 days)
      decks: 3,
      libraryDecks: 1,
      submissions: { pending: 1, approved: 1, rejected: 1 },
      roomsCreated7d: 1,
      roomsCreated30d: 2,
      gamesStarted7d: 1,
      gamesStarted30d: 1,
      agentGames30d: 1,
      agentSpendUsd30d: 1.25,
    });
    // Online right now: Alex and the Owner were seen moments ago (presence was emptied, so this is the last-seen path).
    expect(s.totals.onlineNow).toBe(2);
    expect(s.users.map((u) => u.id)).not.toContain(agentId);
    expect(JSON.stringify(s)).not.toContain("Krenko");
  });

  it("draws twelve Monday-based weeks of sign-ups and active players", async () => {
    const s = await stats();
    expect(s.signupsPerWeek).toHaveLength(ADMIN_WEEKS);
    expect(s.activePerWeek).toHaveLength(ADMIN_WEEKS);
    const thisWeek = weekStartUtc(now);
    expect(s.signupsPerWeek[ADMIN_WEEKS - 1]!.weekStart).toBe(new Date(thisWeek).toISOString().slice(0, 10));
    expect(s.signupsPerWeek[ADMIN_WEEKS - 1]!.value).toBe(2); // Alex, Owner
    expect(s.signupsPerWeek[ADMIN_WEEKS - 4]!.value).toBe(1); // Blair, three weeks ago
    expect(s.signupsPerWeek.reduce((n, p) => n + p.value, 0)).toBe(4); // Casey (40 days) is inside the 12-week window
    expect(s.activePerWeek[ADMIN_WEEKS - 1]!.value).toBe(2); // Alex, Owner
    const blairWeek = Math.floor((weekStartUtc(now - 10 * DAY) - (thisWeek - (ADMIN_WEEKS - 1) * 7 * DAY)) / (7 * DAY));
    expect(s.activePerWeek[blairWeek]!.value).toBeGreaterThanOrEqual(1);
    expect(s.activePerWeek.every((p) => p.value <= 4)).toBe(true);
  });

  it("builds one row per player with devices, decks, submissions, games and friends", async () => {
    const s = await stats();
    expect(s.usersTotal).toBe(4);
    const byName = Object.fromEntries(s.users.map((u) => [u.displayName, u]));
    expect(byName.Alex).toMatchObject({ email: "alex@example.com", isOwner: false, online: true, devices: 2, decks: 2, submissions: { pending: 1, approved: 1, rejected: 0 }, gamesPlayed: 1, gamesHosted: 1, friends: 1 });
    expect(byName.Blair).toMatchObject({ email: null, online: false, devices: 1, decks: 1, submissions: { pending: 0, approved: 0, rejected: 1 }, gamesPlayed: 1, gamesHosted: 0, friends: 1 });
    expect(byName.Casey).toMatchObject({ email: null, devices: 1, decks: 0, gamesPlayed: 0, gamesHosted: 0, friends: 0 });
    expect(byName.Owner).toMatchObject({ isOwner: true, online: true });
    expect(byName.Blair!.lastSeenAt.slice(0, 10)).toBe(iso(now - 10 * DAY).slice(0, 10));
  });

  it("sorts, filters and limits", async () => {
    expect((await stats("?sort=decks")).users[0]!.displayName).toBe("Alex");
    expect((await stats("?sort=created")).users.map((u) => u.displayName).at(-1)).toBe("Casey");
    expect((await stats("?sort=games")).users.slice(0, 2).map((u) => u.displayName).sort()).toEqual(["Alex", "Blair"]);
    expect((await stats("?sort=lastSeen")).users.map((u) => u.displayName).at(-1)).toBe("Casey");
    expect((await stats("?sort=nonsense")).users).toHaveLength(4); // falls back to last seen

    const byName = await stats("?q=ALEX");
    expect(byName.users.map((u) => u.displayName)).toEqual(["Alex"]);
    expect(byName.usersTotal).toBe(1);
    expect((await stats("?q=example.com")).users.map((u) => u.displayName)).toEqual(["Alex"]);
    expect((await stats("?q=krenko")).users).toHaveLength(0);

    const limited = await stats("?limit=2");
    expect(limited.users).toHaveLength(2);
    expect(limited.usersTotal).toBe(4);
    expect((await stats("?limit=0")).users).toHaveLength(4);
  });

  it("serves the snapshot from a short cache and recomputes on refresh", async () => {
    expect((await stats()).cached).toBe(true);
    expect((await stats("?refresh=1")).cached).toBe(false);
  });

  it("lists one player's decks (with the library bracket when approved) and submission history", async () => {
    const r = await ctx.app.inject({ method: "GET", url: `/api/admin/users/${alex.id}`, headers: as(owner) });
    expect(r.statusCode).toBe(200);
    const d = r.json() as AdminUserDetail;
    expect(d.decks.map((x) => [x.name, x.bracket])).toEqual([
      ["Alex two", null],
      ["Alex one", 3],
    ]);
    expect(d.submissions.map((x) => x.status)).toEqual(["pending", "approved"]);
    const blairDetail = (await ctx.app.inject({ method: "GET", url: `/api/admin/users/${blair.id}`, headers: as(owner) })).json() as AdminUserDetail;
    expect(blairDetail.submissions[0]).toMatchObject({ status: "rejected", reason: "too strong" });
    expect((await ctx.app.inject({ method: "GET", url: `/api/admin/users/${agentId}`, headers: as(owner) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/users/nobody", headers: as(owner) })).statusCode).toBe(404);
  });
});
