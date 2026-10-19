import { and, eq } from "drizzle-orm";
import type { DeckForGame } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { cards, deckCards, decks, libraryDeckCards, libraryDecks } from "../db/schema.js";
import { rowToPrinting } from "../scryfall/map.js";

export interface DeckPick {
  id: string;
  name: string;
  commanders: string[];
}

/**
 * A seat's deck is either one of the player's own decks (`decks.id`) or a deck from the shared deck
 * library, stored in `room_members.deck_id` as `library:<library_decks.id>`. Library decks are readable
 * by every signed-in player (the lobby's "Deck library" list); players' own decks stay private.
 */
export { LIBRARY_DECK_PREFIX } from "@cgwf/shared";
import { LIBRARY_DECK_PREFIX } from "@cgwf/shared";

export function libraryDeckIdOf(deckId: string): string | null {
  return deckId.startsWith(LIBRARY_DECK_PREFIX) ? deckId.slice(LIBRARY_DECK_PREFIX.length) : null;
}

/** Card rows of a seat's deck (own or library), with the board each copy sits on. */
export function seatDeckRows(handle: DbHandle, userId: string, deckId: string): { name: string; rows: Array<{ card: typeof cards.$inferSelect; quantity: number; board: string }> } | null {
  const libId = libraryDeckIdOf(deckId);
  if (libId) {
    const lib = handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, libId)).get();
    if (!lib) return null;
    const rows = handle.db
      .select({ lc: libraryDeckCards, card: cards })
      .from(libraryDeckCards)
      .innerJoin(cards, eq(cards.id, libraryDeckCards.cardId))
      .where(eq(libraryDeckCards.libraryDeckId, lib.id))
      .orderBy(libraryDeckCards.position)
      .all();
    return { name: lib.name, rows: rows.map((r) => ({ card: r.card, quantity: r.lc.quantity, board: r.lc.board })) };
  }
  const deck = handle.db.select().from(decks).where(and(eq(decks.id, deckId), eq(decks.userId, userId))).get();
  if (!deck) return null;
  const rows = handle.db
    .select({ dc: deckCards, card: cards })
    .from(deckCards)
    .innerJoin(cards, eq(cards.id, deckCards.cardId))
    .where(eq(deckCards.deckId, deck.id))
    .orderBy(deckCards.position)
    .all();
  return { name: deck.name, rows: rows.map((r) => ({ card: r.card, quantity: r.dc.quantity, board: r.dc.board })) };
}

/** Name + commander names of a deck the user owns, or null. */
export function describeDeck(handle: DbHandle, userId: string, deckId: string): DeckPick | null {
  const libId = libraryDeckIdOf(deckId);
  if (libId) {
    const lib = handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, libId)).get();
    // everyone at the table sees that this seat plays a library deck
    return lib ? { id: deckId, name: `${lib.name} (library)`, commanders: lib.commanders } : null;
  }
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
  if (libraryDeckIdOf(deckId)) {
    const lib = seatDeckRows(handle, userId, deckId);
    if (!lib) return null;
    const out: DeckForGame = { library: [], commanders: [] };
    for (const r of lib.rows) {
      const printing = rowToPrinting(r.card);
      if (r.board === "commander") out.commanders.push(printing);
      else if (r.board === "main") for (let i = 0; i < r.quantity; i++) out.library.push(printing);
    }
    return out;
  }
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
