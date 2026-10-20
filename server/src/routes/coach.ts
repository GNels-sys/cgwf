import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireOwner, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { coachReports, decisionSnapshots, gameResults, gameResultSeats, rooms } from "../db/schema.js";
import { CoachError, type CoachService } from "../coach/coach.js";

interface Deps {
  handle: DbHandle;
  coach: CoachService;
}

/**
 * AI Coach, OWNER ONLY (requireUser + requireOwner), and only when COACH_AI_ENABLED=1 with an API key:
 * otherwise every route answers 404 and the UI stays hidden.
 */
export function registerCoachRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, coach } = deps;
  const owner = [requireUser(handle), requireOwner(handle)];
  const gate = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!coach.enabled) return reply.code(404).send({ error: "not found" });
  };
  const pre = [...owner, gate as never];

  const findGame = (code: string, userId: string) => {
    const room = handle.db.select().from(rooms).where(eq(rooms.code, code.toUpperCase())).get();
    if (!room) return null;
    const result = handle.db.select().from(gameResults).where(eq(gameResults.id, room.id)).get();
    const seat = handle.db.select().from(gameResultSeats).where(and(eq(gameResultSeats.gameId, room.id), eq(gameResultSeats.userId, userId), eq(gameResultSeats.isBot, false))).get();
    if (!result || !seat) return null;
    const snapshots = handle.db.select({ id: decisionSnapshots.id }).from(decisionSnapshots).where(and(eq(decisionSnapshots.roomId, room.id), eq(decisionSnapshots.userId, userId))).limit(1).all().length;
    return { room, result, seat, kind: snapshots ? ("full" as const) : ("light" as const) };
  };

  app.get("/api/coach/status", { preHandler: pre }, async () => ({ enabled: coach.enabled, model: coach.model, spentTodayUsd: coach.spentToday(), limits: coach.limits }));

  /** The owner's finished engine games, losses first, newest first within. */
  app.get("/api/coach/games", { preHandler: pre }, async (req) => {
    const me = req.user!.id;
    const seats = handle.db.select().from(gameResultSeats).where(and(eq(gameResultSeats.userId, me), eq(gameResultSeats.isBot, false))).all();
    if (!seats.length) return { games: [] };
    const results = handle.db.select().from(gameResults).where(inArray(gameResults.id, seats.map((s) => s.gameId))).orderBy(desc(gameResults.endedAt)).all();
    const reports = new Map(handle.db.select().from(coachReports).where(eq(coachReports.userId, me)).all().map((r) => [r.roomId, r]));
    const games = results
      .filter((r) => r.endReason === "win" || r.endReason === "draw")
      .map((r) => {
        const s = seats.find((x) => x.gameId === r.id)!;
        const rep = reports.get(r.id);
        return { code: r.roomCode, endedAt: r.endedAt, won: s.won, place: s.place, playerCount: r.playerCount, deckName: s.deckName, test: r.test, report: rep ? { status: rep.status, costUsd: rep.costUsd } : null };
      });
    games.sort((a, b) => Number(a.won) - Number(b.won) || (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    return { games: games.slice(0, 50) };
  });

  app.get<{ Params: { code: string } }>("/api/coach/rooms/:code", { preHandler: pre }, async (req, reply) => {
    const g = findGame(req.params.code, req.user!.id);
    if (!g) return reply.code(404).send({ error: "no recorded game of yours with that code" });
    const report = coach.report(g.room.id, req.user!.id);
    return {
      game: { code: g.room.code, won: g.seat.won, place: g.seat.place, playerCount: g.result.playerCount, turns: g.result.turns, endReason: g.result.endReason, deckName: g.seat.deckName, kind: g.kind, test: g.result.test },
      report,
    };
  });

  app.post<{ Params: { code: string } }>("/api/coach/rooms/:code", { preHandler: pre }, async (req, reply) => {
    const g = findGame(req.params.code, req.user!.id);
    if (!g) return reply.code(404).send({ error: "no recorded game of yours with that code" });
    if (g.result.endReason !== "win" && g.result.endReason !== "draw") return reply.code(409).send({ error: "only finished games can be coached" });
    try {
      return coach.start(g.room.id, req.user!.id);
    } catch (err) {
      if (err instanceof CoachError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Params: { code: string }; Body: { question?: string } | null }>("/api/coach/rooms/:code/followup", { preHandler: pre }, async (req, reply) => {
    const g = findGame(req.params.code, req.user!.id);
    const rep = g ? coach.report(g.room.id, req.user!.id) : null;
    if (!g || !rep) return reply.code(404).send({ error: "no report for that game yet" });
    try {
      return coach.followup(rep.id, req.user!.id, String(req.body?.question ?? ""));
    } catch (err) {
      if (err instanceof CoachError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  /** Owner's Admin page: coach spend per report and today. */
  app.get("/api/admin/coach", { preHandler: owner }, async () => ({ enabled: coach.enabled, model: coach.model, spentTodayUsd: coach.spentToday(), limits: coach.limits, reports: coach.usage() }));
}
