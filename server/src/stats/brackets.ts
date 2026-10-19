import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../db/index.js";
import { decks, libraryDecks } from "../db/schema.js";
import type { DeckAnalyzer } from "../analysis/service.js";
import { libraryDeckIdOf } from "../rooms/deck.js";

/**
 * A deck's bracket for the lobby and for game results: a library deck's stored bracket, or the analysis
 * engine's suggestion for a player's own deck (computed on demand, cached per deck id + updatedAt, which
 * every card change bumps). Null when it cannot be worked out.
 */
export class DeckBrackets {
  private cache = new Map<string, number | null>();

  constructor(
    private readonly handle: DbHandle,
    private readonly analyzer: DeckAnalyzer,
  ) {}

  /** Own deck by id (any owner; callers check access). */
  ownDeck(deckId: string, updatedAt: string): number | null {
    const key = `${deckId}|${updatedAt}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let bracket: number | null = null;
    try {
      const cards = this.analyzer.loadDeckCards(deckId);
      if (cards.length) {
        const s = this.analyzer.analyzeSync(cards).suggested;
        bracket = typeof s === "number" && s >= 1 && s <= 5 ? s : null;
      }
    } catch {
      bracket = null;
    }
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, bracket);
    return bracket;
  }

  /** A seat's deck reference: own deck id (of `userId`) or `library:<id>`. */
  forSeat(userId: string, deckRef: string): number | null {
    const lib = libraryDeckIdOf(deckRef);
    if (lib) return this.handle.db.select({ b: libraryDecks.bracket }).from(libraryDecks).where(eq(libraryDecks.id, lib)).get()?.b ?? null;
    const d = this.handle.db.select({ id: decks.id, updatedAt: decks.updatedAt, sourceUrl: decks.sourceUrl }).from(decks).where(and(eq(decks.id, deckRef), eq(decks.userId, userId))).get();
    if (!d) return null;
    // a bot's copy of a library deck keeps the library deck's bracket
    const libCopy = d.sourceUrl ? libraryDeckIdOf(d.sourceUrl) : null;
    if (libCopy) {
      const b = this.handle.db.select({ b: libraryDecks.bracket }).from(libraryDecks).where(eq(libraryDecks.id, libCopy)).get()?.b;
      if (b) return b;
    }
    return this.ownDeck(d.id, d.updatedAt);
  }
}
