import type { Board, EngineDeck } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { seatDeckRows } from "../rooms/deck.js";
import { deckWarnings } from "../routes/decks.js";

/**
 * A saved CGwF deck as the engine wants it: name + set + collector number + Scryfall id per
 * printing, with quantities. On engine tables the Commander checks that are only warnings on the
 * deck page become blocking (Forge would happily play an illegal deck).
 */
export function deckForEngine(handle: DbHandle, userId: string, deckId: string): { deck: EngineDeck; problems: string[] } | null {
  // own decks and library decks ("library:<id>") convert the same way: same boards, same legality checks
  const src = seatDeckRows(handle, userId, deckId);
  if (!src) return null;
  const out: EngineDeck = { name: src.name, commanders: [], main: [], companions: [] };
  for (const r of src.rows) {
    const entry = { name: r.card.name, setCode: r.card.set, number: r.card.collectorNumber, scryfallId: r.card.id, count: r.quantity };
    if (r.board === "commander") out.commanders.push(entry);
    else if (r.board === "main") out.main.push(entry);
    else if (r.board === "companion") out.companions!.push(entry);
  }
  const problems = deckWarnings(src.rows.map((r) => ({ row: r.card, quantity: r.quantity, board: r.board as Board }))).map((w) => w.message);
  return { deck: out, problems };
}
