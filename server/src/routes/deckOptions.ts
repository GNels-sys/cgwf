import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { filterDeckOptions, LIBRARY_DECK_PREFIX, type DeckOption, type DeckOptionsResponse } from "@cgwf/shared";
import { requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { cards, decks, libraryDeckCards, libraryDecks } from "../db/schema.js";
import type { DeckAnalyzer } from "../analysis/service.js";
import { describeDeck } from "../rooms/deck.js";

interface Deps {
  handle: DbHandle;
  analyzer: DeckAnalyzer;
}

/** Suggested bracket per own deck, keyed by deck id + updatedAt (every card change bumps updatedAt). */
class BracketCache {
  private map = new Map<string, number | null>();
  constructor(private readonly analyzer: DeckAnalyzer) {}
  get(deckId: string, updatedAt: string): number | null {
    const key = `${deckId}|${updatedAt}`;
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    let bracket: number | null = null;
    try {
      const cardsOf = this.analyzer.loadDeckCards(deckId);
      if (cardsOf.length) {
        const s = this.analyzer.analyzeSync(cardsOf).suggested;
        bracket = typeof s === "number" && s >= 1 && s <= 5 ? s : null;
      }
    } catch {
      bracket = null;
    }
    if (this.map.size > 2000) this.map.clear();
    this.map.set(key, bracket);
    return bracket;
  }
}

function parseBracket(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/**
 * The lobby's deck picker and the shared deck library, read-only, for every signed-in player.
 * Players' own decks stay private (only the caller's own decks are listed); editing library decks,
 * primers and agents stays behind the owner-only /api/library routes.
 */
export function registerDeckOptionRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, analyzer } = deps;
  const auth = requireUser(handle);
  const brackets = new BracketCache(analyzer);

  const libraryOptions = (): DeckOption[] =>
    handle.db
      .select()
      .from(libraryDecks)
      .all()
      .map((d) => ({ id: `${LIBRARY_DECK_PREFIX}${d.id}`, name: d.name, commanders: d.commanders, bracket: d.bracket, tags: d.tags }));

  /** GET /api/rooms/deck-options?bracket=N: the caller's decks and the library, filtered and sorted. */
  app.get<{ Querystring: { bracket?: string } }>(
    "/api/rooms/deck-options",
    { preHandler: auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req): Promise<DeckOptionsResponse> => {
      const bracket = parseBracket(req.query.bracket);
      const userId = req.user!.id;
      const mine: DeckOption[] = [];
      for (const d of handle.db.select().from(decks).where(eq(decks.userId, userId)).all()) {
        const pick = describeDeck(handle, userId, d.id);
        if (!pick) continue;
        mine.push({ id: d.id, name: d.name, commanders: pick.commanders, bracket: brackets.get(d.id, d.updatedAt), tags: [] });
      }
      return { mine: filterDeckOptions(mine, bracket), library: filterDeckOptions(libraryOptions(), bracket) };
    },
  );

  /** GET /api/library-decks: every library deck (read-only summary). */
  app.get<{ Querystring: { bracket?: string } }>("/api/library-decks", { preHandler: auth }, async (req) => {
    return { decks: filterDeckOptions(libraryOptions(), parseBracket(req.query.bracket)) };
  });

  /** GET /api/library-decks/:id: one library deck with its card list (read-only). */
  app.get<{ Params: { id: string } }>("/api/library-decks/:id", { preHandler: auth }, async (req, reply) => {
    const d = handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, req.params.id)).get();
    if (!d) return reply.code(404).send({ error: "no such library deck" });
    const rows = handle.db
      .select({ lc: libraryDeckCards, card: cards })
      .from(libraryDeckCards)
      .innerJoin(cards, eq(cards.id, libraryDeckCards.cardId))
      .where(eq(libraryDeckCards.libraryDeckId, d.id))
      .orderBy(asc(libraryDeckCards.position))
      .all();
    return {
      deck: {
        id: `${LIBRARY_DECK_PREFIX}${d.id}`,
        name: d.name,
        commanders: d.commanders,
        bracket: d.bracket,
        tags: d.tags,
        cards: rows.map((r) => ({ name: r.card.name, printingId: r.card.id, quantity: r.lc.quantity, board: r.lc.board })),
      },
    };
  });
}
