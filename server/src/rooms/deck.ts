import { and, eq } from "drizzle-orm";
import type { DeckForGame } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { cards, deckCards, decks } from "../db/schema.js";
import { rowToPrinting } from "../scryfall/map.js";

export interface DeckPick {
  id: string;
  name: string;
  commanders: string[];
}

/** Name + commander names of a deck the user owns, or null. */
export function describeDeck(handle: DbHandle, userId: string, deckId: string): DeckPick | null {
  const deck = handle.db.select().from(decks).where(and(eq(decks.id, deckId), eq(decks.userId, userId))).get();
  if (!deck) return null;
  const rows = handle.db
    .select({ name: cards.name, board: deckCards.board })
    .from(deckCards)
    .innerJoin(cards, eq(cards.id, deckCards.cardId))
    .where(and(eq(deckCards.deckId, deck.id), eq(deckCards.board, "commander")))
    .all();
  return { id: deck.id, name: deck.name, commanders: rows.map((r) => r.name) };
}

/**
 * Expand a saved deck into the full printing objects the game needs: main
 * board copies become library cards, the commander board the command zone.
 */
export function loadDeckForGame(handle: DbHandle, userId: string, deckId: string): DeckForGame | null {
  const deck = handle.db.select().from(decks).where(and(eq(decks.id, deckId), eq(decks.userId, userId))).get();
  if (!deck) return null;
  const rows = handle.db
    .select({ dc: deckCards, card: cards })
    .from(deckCards)
    .innerJoin(cards, eq(cards.id, deckCards.cardId))
    .where(eq(deckCards.deckId, deck.id))
    .orderBy(deckCards.position)
    .all();
  const out: DeckForGame = { library: [], commanders: [] };
  for (const r of rows) {
    const printing = rowToPrinting(r.card);
    if (r.dc.board === "commander") out.commanders.push(printing);
    else if (r.dc.board === "main") for (let i = 0; i < r.dc.quantity; i++) out.library.push(printing);
  }
  return out;
}
