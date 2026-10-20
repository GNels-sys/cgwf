import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-coach-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { users, rooms, gameResults, gameResultSeats, roomEvents, decks, deckCards, coachReports } = await import("../db/schema.js");
const { ScriptedCoachLlm, costOf } = await import("./llm.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const ID = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SOL_RING = ID(1);
const ATRAXA = ID(10);
const FOREST = ID(11);

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const REPORT = {
  summary: "You lost a close race.",
  turningPoints: [{ round: 2, turn: 4, title: "Holding Sol Ring", had: "Sol Ring in hand", chose: "pass", betterLine: "Cast Sol Ring on turn 2", why: "Mana advantage early", theme: "mana", cards: ["Sol Ring"] }],
  habits: ["Use mana every turn", "Count lethal", "Hold up interaction"],
  hiddenInfoNote: "Opponents' hands were unknown.",
};

describe("AI Coach (owner only, scripted model)", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let owner: RegisterResponse;
  let other: RegisterResponse;
  const llm = new ScriptedCoachLlm([]);
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const now = new Date().toISOString();

  /** A finished engine game: owner (seat 0, own deck) lost to `other` (seat 1); optional decision snapshots. */
  const makeGame = async (id: string, code: string, withSnapshots: boolean) => {
    ctx.handle.db.insert(rooms).values({ id, code, hostUserId: owner.user.id, status: "ended", format: "commander", seed: "s", lastSeq: 3, engine: true, createdAt: now, updatedAt: now } as never).run();
    ctx.handle.db.insert(gameResults).values({ id, roomCode: code, startedAt: now, endedAt: now, tableBracket: 3, playerCount: 2, test: false, counted: true, endReason: "win", detail: "AllOpponentsLost", turns: 6 }).run();
    ctx.handle.db.insert(gameResultSeats).values({ gameId: id, seat: 0, userId: owner.user.id, isBot: false, deckRef: "owner-deck", deckOwnerId: owner.user.id, deckName: "Owner Forests", commanders: ["Atraxa, Praetors' Voice"], deckBracket: 3, place: 2, won: false, conceded: false }).run();
    ctx.handle.db.insert(gameResultSeats).values({ gameId: id, seat: 1, userId: other.user.id, isBot: false, deckRef: "other-deck", deckOwnerId: other.user.id, deckName: "Other Deck", commanders: ["Krenko"], deckBracket: 3, place: 1, won: true, conceded: false }).run();
    let seq = 0;
    for (const text of ["Turn 1 (Owner)", "Owner played Forest", "Other cast Lightning Bolt targeting Owner", "Other has won the game"]) {
      ctx.handle.db.insert(roomEvents).values({ roomId: id, seq: ++seq, actor: "system", type: "EngineLog", payload: JSON.stringify({ engineSeq: seq, turn: 1, logType: "X", text }), ts: Date.now() } as never).run();
    }
    if (withSnapshots) {
      const view = {
        turn: 4, round: 2, phase: "MAIN1", activePlayer: 1, viewer: 1, stack: [], combat: null, players: [
          { id: 1, seat: 0, name: "Owner", isYou: true, life: 30, poison: 0, lost: false, handCount: 2, libraryCount: 90, landsPlayedThisTurn: 1, commanderDamage: {}, hand: [{ id: 5, name: "Sol Ring", zone: "Hand", controller: 1, owner: 1, tapped: false, faceDown: false, token: false }], battlefield: [], graveyard: [], exile: [], command: [] },
          { id: 2, seat: 1, name: "Other", isYou: false, life: 40, poison: 0, lost: false, handCount: 4, libraryCount: 90, landsPlayedThisTurn: 0, commanderDamage: {}, hand: [{ id: 9, name: "Opponent Secret", zone: "Hand", controller: 2, owner: 2, tapped: false, faceDown: false, token: false }], battlefield: [{ id: 7, name: "Lightning Greaves", zone: "Battlefield", controller: 2, owner: 2, tapped: false, faceDown: false, token: false }], graveyard: [], exile: [], command: [] },
        ],
      };
      ctx.roomsManager.decisions!.record({ roomId: id, seat: 0, userId: owner.user.id, seq: 1 }, { prompt: "priority", title: "You have priority", options: [{ index: 0, description: "Cast Sol Ring" }], view }, { option: null });
      await ctx.roomsManager.decisions!.flush();
    }
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, idleSweep: false, coachLlm: llm, coachLimits: { maxUsdPerReport: 4, maxUsdPerDay: 20, maxTokensPerReport: 600000 } });
    await ctx.ingestor.run({ file: fixture });
    const reg = async (name: string, ip: string) => (await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip })).json() as RegisterResponse;
    owner = await reg("Owner", "10.5.0.1");
    other = await reg("Other", "10.5.0.2");
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, owner.user.id)).run();
    ctx.handle.db.insert(decks).values({ id: "owner-deck", userId: owner.user.id, name: "Owner Forests", format: "commander", createdAt: now, updatedAt: now } as never).run();
    ctx.handle.db.insert(deckCards).values([{ deckId: "owner-deck", cardId: ATRAXA, quantity: 1, board: "commander", position: 0 }, { deckId: "owner-deck", cardId: SOL_RING, quantity: 1, board: "main", position: 1 }, { deckId: "owner-deck", cardId: FOREST, quantity: 98, board: "main", position: 2 }] as never).run();
    await makeGame("game-full", "COACH1", true);
    await makeGame("game-light", "COACH2", false);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it("is owner only: other players get 403", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/coach/games", headers: auth(other.token) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: "/api/coach/rooms/COACH1", headers: auth(other.token) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/coach", headers: auth(other.token) })).statusCode).toBe(403);
  });

  it("lists the owner's finished games, losses first", async () => {
    const r = (await ctx.app.inject({ method: "GET", url: "/api/coach/games", headers: auth(owner.token) })).json() as { games: Array<{ code: string; won: boolean }> };
    expect(r.games.map((g) => g.code).sort()).toEqual(["COACH1", "COACH2"]);
    expect(r.games.every((g) => !g.won)).toBe(true);
  });

  it("writes a report from the owner's own view, using the card tool, and caches it", async () => {
    llm.requests.length = 0;
    llm.script.push(
      () => ({ content: [{ type: "tool_use", id: "t1", name: "card_text", input: { name: "Sol Ring" } } as never], usage: usage(20000, 500, 0, 18000), stopReason: "tool_use", stopCategory: null }),
      (req) => {
        const toolResult = JSON.stringify(req.messages.at(-1));
        expect(toolResult).toMatch(/Sol Ring/);
        expect(toolResult).toMatch(/Add \{C\}\{C\}|\{T\}/); // its oracle text
        return { content: [{ type: "text", text: JSON.stringify(REPORT) } as never], usage: usage(800, 2500, 18000, 0), stopReason: "end_turn", stopCategory: null };
      },
    );
    const start = await ctx.app.inject({ method: "POST", url: "/api/coach/rooms/COACH1", headers: auth(owner.token) });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ status: "running" });
    await ctx.coach.idle();
    const r = (await ctx.app.inject({ method: "GET", url: "/api/coach/rooms/COACH1", headers: auth(owner.token) })).json() as { game: { kind: string }; report: { status: string; report: typeof REPORT; costUsd: number; calls: number; kind: string } };
    expect(r.game.kind).toBe("full");
    expect(r.report).toMatchObject({ status: "done", kind: "full", calls: 2 });
    expect(r.report.report.turningPoints[0]!.cards).toEqual(["Sol Ring"]);
    expect(r.report.costUsd).toBeCloseTo(costOf("claude-opus-5-5", usage(20800, 3000, 18000, 18000)), 6);
    // the prompt carried the owner's own hand and decision, never an opponent's hand
    const first = JSON.stringify(llm.requests[0]);
    expect(first).toMatch(/THE PLAYER'S DECISIONS/);
    expect(first).toMatch(/Your hand: Sol Ring/);
    expect(first).toMatch(/Lightning Greaves/); // public
    expect(first).not.toMatch(/Opponent Secret/);
    expect(llm.requests[0]!.jsonSchema).toBeTruthy();
    // cached: asking again costs nothing
    const before = llm.requests.length;
    expect((await ctx.app.inject({ method: "POST", url: "/api/coach/rooms/COACH1", headers: auth(owner.token) })).json()).toMatchObject({ status: "done" });
    expect(llm.requests.length).toBe(before);
  });

  it("answers one follow-up at a time, counted in spend", async () => {
    llm.script.push({ content: [{ type: "text", text: "Cast Sol Ring first; it doubles your mana next turn." } as never], usage: usage(500, 300, 18000, 0), stopReason: "end_turn", stopCategory: null });
    const q = await ctx.app.inject({ method: "POST", url: "/api/coach/rooms/COACH1/followup", headers: auth(owner.token), payload: { question: "What should I have cast on turn 2?" } });
    expect(q.statusCode).toBe(200);
    await ctx.coach.idle();
    const r = (await ctx.app.inject({ method: "GET", url: "/api/coach/rooms/COACH1", headers: auth(owner.token) })).json() as { report: { followups: Array<{ question: string; answer: string; status: string; costUsd: number }> } };
    expect(r.report.followups).toEqual([expect.objectContaining({ question: "What should I have cast on turn 2?", answer: "Cast Sol Ring first; it doubles your mana next turn.", status: "done" })]);
    expect(r.report.followups[0]!.costUsd).toBeGreaterThan(0);
    const admin = (await ctx.app.inject({ method: "GET", url: "/api/admin/coach", headers: auth(owner.token) })).json() as { spentTodayUsd: number; reports: Array<{ code: string; costUsd: number; followups: number }> };
    expect(admin.reports.find((x) => x.code === "COACH1")).toMatchObject({ followups: 1 });
    expect(admin.spentTodayUsd).toBeGreaterThan(0);
  });

  it("gives a clearly labelled light review when there are no decision snapshots, and stops at the per-report cap", async () => {
    ctx.coach.limits.maxUsdPerReport = 0.01;
    llm.script.push(() => ({ content: [{ type: "tool_use", id: "t2", name: "card_text", input: { name: "Forest" } } as never], usage: usage(50000, 1000), stopReason: "tool_use", stopCategory: null }));
    llm.requests.length = 0;
    await ctx.app.inject({ method: "POST", url: "/api/coach/rooms/COACH2", headers: auth(owner.token) });
    await ctx.coach.idle();
    expect(JSON.stringify(llm.requests[0])).toMatch(/LIGHT REVIEW/);
    expect(JSON.stringify(llm.requests[0])).toMatch(/NO DECISION RECORD/);
    const row = ctx.handle.db.select().from(coachReports).where(eq(coachReports.roomCode, "COACH2")).get()!;
    expect(row).toMatchObject({ kind: "light", status: "capped", calls: 1 });
    expect(row.error).toMatch(/spend cap/);
    ctx.coach.limits.maxUsdPerReport = 4;
  });

  it("refuses new work once the daily budget is used up", async () => {
    ctx.handle.db.delete(coachReports).where(eq(coachReports.roomCode, "COACH2")).run();
    ctx.coach.limits.maxUsdPerDay = 0.0001;
    const r = await ctx.app.inject({ method: "POST", url: "/api/coach/rooms/COACH2", headers: auth(owner.token) });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: string }).error).toMatch(/budget/);
    ctx.coach.limits.maxUsdPerDay = 20;
  });
});

describe("AI Coach disabled", () => {
  it("answers 404 to the owner when COACH_AI_ENABLED is off", async () => {
    const ctx = await buildApp({ logger: false, idleSweep: false, coachLlm: null, dbFile: path.join(tmp, "off.db") });
    const reg = (await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "O", avatar: "fox", color: "jade" }, remoteAddress: "10.6.0.1" })).json() as RegisterResponse;
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, reg.user.id)).run();
    expect((await ctx.app.inject({ method: "GET", url: "/api/coach/status", headers: { authorization: `Bearer ${reg.token}` } })).statusCode).toBe(404);
    await ctx.app.close();
  });
});
