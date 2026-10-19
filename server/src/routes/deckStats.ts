import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { deckPerformance, statsRow, type DeckPerformance, type DeckStatsListResponse, type ResultSeatRow } from "@cgwf/shared";
import { requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { decks, gameResults, gameResultSeats, libraryDecks } from "../db/schema.js";
import { describeDeck, libraryDeckIdOf } from "../rooms/deck.js";

interface Deps {
  handle: DbHandle;
}

/** Every seat of every COUNTED game (test games, abandoned games and unfinished games never appear). */
function countedRows(handle: DbHandle): ResultSeatRow[] {
  return handle.db
    .select({ g: gameResults, s: gameResultSeats })
    .from(gameResultSeats)
    .innerJoin(gameResults, eq(gameResults.id, gameResultSeats.gameId))
    .where(eq(gameResults.counted, true))
    .all()
    .map(({ g, s }) => ({
      gameId: g.id,
      endedAt: g.endedAt,
      tableBracket: g.tableBracket,
      playerCount: g.playerCount,
      seat: s.seat,
      userId: s.userId,
      isBot: s.isBot,
      deckRef: s.deckRef,
      deckOwnerId: s.deckOwnerId,
      deckName: s.deckName,
      commanders: s.commanders,
      deckBracket: s.deckBracket,
      place: s.place,
      won: s.won,
      conceded: s.conceded,
    }));
}

const bots = (q: { bots?: string }): boolean => q.bots !== "0";

/**
 * Deck statistics from counted rules-engine games. Library decks aggregate across every player and are
 * open to every signed-in player; a personal deck's numbers are visible only to its owner (anyone else
 * gets 404, so the deck's existence is not confirmed either).
 */
export function registerDeckStatsRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle } = deps;
  const auth = requireUser(handle);

  /** GET /api/deck-stats?bots=0: the caller's own decks and every library deck they have played. */
  app.get<{ Querystring: { bots?: string } }>("/api/deck-stats", { preHandler: auth }, async (req): Promise<DeckStatsListResponse> => {
    const me = req.user!.id;
    const includeBots = bots(req.query);
    const rows = countedRows(handle);
    const refs = new Set<string>();
    for (const r of rows) {
      if (!r.deckRef) continue;
      if (r.deckOwnerId === me) refs.add(r.deckRef);
      else if (r.deckRef.startsWith("library:") && r.userId === me && !r.isBot) refs.add(r.deckRef);
    }
    const list = [...refs].map((ref) => statsRow(deckPerformance(rows, ref, includeBots))).filter((d) => d.games > 0);
    list.sort((a, b) => b.games - a.games || a.deckName.localeCompare(b.deckName));
    return { decks: list, includeBots };
  });

  /** GET /api/deck-stats/deck/:ref?bots=0: one deck (own deck id or library:<id>) with its grid and head-to-head. */
  app.get<{ Params: { ref: string }; Querystring: { bots?: string } }>("/api/deck-stats/deck/:ref", { preHandler: auth }, async (req, reply): Promise<DeckPerformance | void> => {
    const me = req.user!.id;
    const ref = req.params.ref;
    const rows = countedRows(handle);
    const lib = libraryDeckIdOf(ref);
    let name = "";
    let commanders: string[] = [];
    if (lib) {
      const row = handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, lib)).get();
      if (!row && !rows.some((r) => r.deckRef === ref)) return reply.code(404).send({ error: "no such deck" });
      name = row?.name ?? "";
      commanders = row?.commanders ?? [];
    } else {
      const own = handle.db.select().from(decks).where(and(eq(decks.id, ref), eq(decks.userId, me))).get();
      const history = rows.some((r) => r.deckRef === ref && r.deckOwnerId === me);
      if (!own && !history) return reply.code(404).send({ error: "no such deck" });
      if (own) {
        name = own.name;
        commanders = describeDeck(handle, me, own.id)?.commanders ?? [];
      }
      // a personal deck's seats are only ever the owner's own
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.deckRef === ref && rows[i]!.deckOwnerId !== me) rows.splice(i, 1);
    }
    const perf = deckPerformance(rows, ref, bots(req.query));
    if (!perf.deckName) perf.deckName = name;
    if (!perf.commanders.length) perf.commanders = commanders;
    return perf;
  });
}
