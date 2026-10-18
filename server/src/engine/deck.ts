import { and, eq } from "drizzle-orm";
import type { Board, EngineDeck } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { cards, deckCards, decks } from "../db/schema.js";
import { deckWarnings } from "../routes/decks.js";

/**
 * A saved CGwF deck as the engine wants it: name + set + collector number + Scryfall id per
 * printing, with quantities. On engine tables the Commander checks that are only warnings on the
 * deck page become blocking (Forge would happily play an illegal deck).
 */
export function deckForEngine(handle: DbHandle, userId: string, deckId: string): { deck: EngineDeck; problems: string[] } | null {
  const deck = handle.db.select().from(decks).where(and(eq(decks.id, deckId), eq(decks.userId, userId))).get();
  if (!deck) return null;
  const rows = handle.db
    .select({ dc: deckCards, card: cards })
    .from(deckCards)
    .innerJoin(cards, eq(cards.id, deckCards.cardId))
    .where(eq(deckCards.deckId, deck.id))
    .orderBy(deckCards.position)
    .all();
  const out: EngineDeck = { name: deck.name, commanders: [], main: [], companions: [] };
  for (const r of rows) {
    const entry = { name: r.card.name, setCode: r.card.set, number: r.card.collectorNumber, scryfallId: r.card.id, count: r.dc.quantity };
    if (r.dc.board === "commander") out.commanders.push(entry);
    else if (r.dc.board === "main") out.main.push(entry);
    else if (r.dc.board === "companion") out.companions!.push(entry);
  }
  const problems = deckWarnings(rows.map((r) => ({ row: r.card, quantity: r.dc.quantity, board: r.dc.board as Board }))).map((w) => w.message);
  return { deck: out, problems };
}
