import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/index.js";
import { decks, gameResults, gameResultSeats, libraryDecks } from "../db/schema.js";
import { describeDeck, libraryDeckIdOf, LIBRARY_DECK_PREFIX } from "../rooms/deck.js";
import type { DeckBrackets } from "./brackets.js";

export interface StartSeat {
  seat: number;
  userId: string;
  isBot: boolean;
  deckId: string;
}

/** Per-seat result from the engine's gameOver frame (GameSession.results()). */
export interface EngineSeatResult {
  seat: number;
  place?: number;
  won?: boolean;
  conceded?: boolean;
}

const now = () => new Date().toISOString();

/**
 * Game results for deck statistics (rules-engine tables only; the classic table never writes here).
 * Frozen at game start: table bracket, player count, test flag, and per seat the player (or bot), the deck
 * (reference + name + commanders as text, so history survives deletions) and its bracket at that moment.
 * Finished at game over from Forge's result. COUNTED = not a test game AND Forge reported a winner or a draw.
 * A table closed before Forge finished is "abandoned": recorded, never counted.
 */
export class GameResults {
  constructor(
    private readonly handle: DbHandle,
    readonly brackets: DeckBrackets,
  ) {}

  /** The lobby's default table bracket: the highest bracket among the seated decks (null if none known). */
  defaultTableBracket(seats: Array<{ userId: string; deckId: string | null }>): number | null {
    let best: number | null = null;
    for (const s of seats) {
      if (!s.deckId) continue;
      const b = this.brackets.forSeat(s.userId, s.deckId);
      if (b !== null && (best === null || b > best)) best = b;
    }
    return best;
  }

  /** What a seat's deck is for statistics: a library deck (bots' copies included) or a player's own deck. */
  private deckIdentity(userId: string, deckId: string, isBot: boolean): { ref: string; ownerId: string | null; name: string; commanders: string[] } {
    const lib = libraryDeckIdOf(deckId);
    if (lib) {
      const row = this.handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, lib)).get();
      return { ref: deckId, ownerId: null, name: row?.name ?? "Library deck", commanders: row?.commanders ?? [] };
    }
    const d = this.handle.db.select().from(decks).where(eq(decks.id, deckId)).get();
    const copyOf = d?.sourceUrl ? libraryDeckIdOf(d.sourceUrl) : null;
    if (isBot && copyOf) {
      const row = this.handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, copyOf)).get();
      if (row) return { ref: `${LIBRARY_DECK_PREFIX}${row.id}`, ownerId: null, name: row.name, commanders: row.commanders };
    }
    const pick = describeDeck(this.handle, userId, deckId);
    return { ref: deckId, ownerId: isBot ? null : userId, name: pick?.name ?? d?.name ?? "Deck", commanders: pick?.commanders ?? [] };
  }

  recordStart(room: { id: string; code: string; testGame: boolean; tableBracket: number | null }, seats: StartSeat[]): void {
    const tableBracket = room.tableBracket ?? this.defaultTableBracket(seats);
    const rows = seats.map((s) => {
      const id = this.deckIdentity(s.userId, s.deckId, s.isBot);
      return { seat: s.seat, userId: s.userId, isBot: s.isBot, deckRef: id.ref, deckOwnerId: id.ownerId, deckName: id.name, commanders: id.commanders, deckBracket: this.brackets.forSeat(s.userId, s.deckId) };
    });
    this.handle.sqlite.transaction(() => {
      this.handle.db.delete(gameResults).where(eq(gameResults.id, room.id)).run();
      this.handle.db
        .insert(gameResults)
        .values({ id: room.id, roomCode: room.code, startedAt: now(), endedAt: null, tableBracket, playerCount: seats.length, test: room.testGame, counted: false, endReason: null, detail: null, turns: null })
        .run();
      for (const r of rows) this.handle.db.insert(gameResultSeats).values({ gameId: room.id, ...r, place: null, won: false, conceded: false }).run();
    })();
  }

  /** Forge finished the game. `closed` = the table was closed (host / owner / idle) before a real finish. */
  recordFinish(roomId: string, f: { winnerSeat: number | null; endReason: string | null; turns: number; results: EngineSeatResult[] }, closed: string | null): void {
    const row = this.handle.db.select().from(gameResults).where(eq(gameResults.id, roomId)).get();
    if (!row || row.endReason) return; // a game from before statistics, or already finished/closed
    if (closed) {
      this.abandon(roomId, closed);
      return;
    }
    // a winner, or Forge's own draw; anything else (an engine failure with no outcome) is not a result
    if (f.winnerSeat === null && f.endReason !== "Draw") {
      this.abandon(roomId, `no result from the engine${f.endReason ? ` (${f.endReason})` : ""}`);
      return;
    }
    const reason = f.winnerSeat !== null ? "win" : "draw";
    this.handle.sqlite.transaction(() => {
      this.handle.db
        .update(gameResults)
        .set({ endedAt: now(), endReason: reason, detail: f.endReason, turns: f.turns, counted: !row.test })
        .where(eq(gameResults.id, roomId))
        .run();
      const seats = this.handle.db.select().from(gameResultSeats).where(eq(gameResultSeats.gameId, roomId)).all();
      for (const s of seats) {
        const r = f.results.find((x) => x.seat === s.seat);
        const won = f.winnerSeat === s.seat || (r?.won ?? false);
        const place = r?.place ?? (won ? 1 : null);
        this.handle.db.update(gameResultSeats).set({ won, place, conceded: r?.conceded ?? false }).where(eq(gameResultSeats.id, s.id)).run();
      }
    })();
  }

  /** Who took the first turn (the D20 roll's winner or the random pick), once the table decided. */
  recordStartingSeat(roomId: string, seat: number, method: "roll" | "random"): void {
    this.handle.db.update(gameResults).set({ startingSeat: seat, firstPlayerMethod: method }).where(eq(gameResults.id, roomId)).run();
  }

  /** The table was closed before Forge finished: kept for the record, never counted. */
  abandon(roomId: string, detail: string): void {
    const row = this.handle.db.select().from(gameResults).where(eq(gameResults.id, roomId)).get();
    if (!row || row.endReason) return;
    this.handle.db.update(gameResults).set({ endedAt: now(), endReason: "abandoned", detail, counted: false }).where(eq(gameResults.id, roomId)).run();
  }
}
