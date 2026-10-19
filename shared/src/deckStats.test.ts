import { describe, expect, it } from "vitest";
import { bracketHint, deckPerformance, gamesInScope, type ResultSeatRow } from "./deckStats.js";

let n = 0;
/** One game: seats as [deckRef, won, place, isBot?]. */
function game(tableBracket: number, seats: Array<[string, boolean, number, boolean?]>, deckBracket = 3): ResultSeatRow[] {
  const id = `g${++n}`;
  return seats.map(([ref, won, place, isBot], seat) => ({
    gameId: id,
    endedAt: `2026-10-19T00:${String(n).padStart(2, "0")}:00Z`,
    tableBracket,
    playerCount: seats.length,
    seat,
    userId: isBot ? `bot${seat}` : `u${seat}`,
    isBot: Boolean(isBot),
    deckRef: ref,
    deckOwnerId: ref.startsWith("library:") ? null : `u${seat}`,
    deckName: ref === "D" ? "My Deck" : ref,
    commanders: ["Cmdr"],
    deckBracket: ref === "D" ? deckBracket : 2,
    place,
    won,
    conceded: false,
  }));
}

describe("deck performance from counted games", () => {
  const rows = [
    // B3 tables: 4 players twice, 2 players once
    ...game(3, [["D", true, 1], ["library:a", false, 2], ["library:b", false, 3], ["library:c", false, 4]]),
    ...game(3, [["D", false, 3], ["library:a", true, 1], ["library:b", false, 2], ["library:c", false, 4]]),
    ...game(3, [["D", true, 1], ["library:a", false, 2]]),
    // a B4 three-player table with a bot
    ...game(4, [["D", false, 2], ["library:b", true, 1, true], ["library:c", false, 3]]),
  ];

  it("overall record, average place, and the bracket-by-players grid", () => {
    const p = deckPerformance(rows, "D", true);
    expect(p.overall).toMatchObject({ games: 4, wins: 2, winRate: 0.5, conceded: 0 });
    expect(p.overall.avgPlace).toBeCloseTo((1 + 3 + 1 + 2) / 4);
    expect(p.grid).toEqual([
      { tableBracket: 3, players: 2, games: 1, wins: 1, winRate: 1, lowSample: true },
      { tableBracket: 3, players: 4, games: 2, wins: 1, winRate: 0.5, lowSample: true },
      { tableBracket: 4, players: 3, games: 1, wins: 0, winRate: 0, lowSample: true },
    ]);
    expect(p.deckName).toBe("My Deck");
  });

  it("head to head: this deck against each opposing deck it met", () => {
    const h = Object.fromEntries(deckPerformance(rows, "D", true).headToHead.map((x) => [x.deckRef, x]));
    expect(h["library:a"]).toMatchObject({ games: 3, wins: 2, losses: 1, ahead: 2, library: true });
    expect(h["library:b"]).toMatchObject({ games: 3, wins: 1, losses: 1, ahead: 1 });
    expect(h["library:c"]).toMatchObject({ games: 3, wins: 1, losses: 0, ahead: 3 });
  });

  it("head to head counts a game once when two opponents played the same deck", () => {
    const twice = game(2, [["D", false, 2], ["library:a", true, 1], ["library:a", false, 3]]);
    const h = deckPerformance(twice, "D", true).headToHead;
    expect(h).toEqual([expect.objectContaining({ deckRef: "library:a", games: 1, wins: 0, losses: 1, ahead: 0 })]);
  });

  it("without bots, any game that had a bot seat is left out", () => {
    expect(new Set(gamesInScope(rows, false).map((r) => r.gameId)).size).toBe(3);
    const p = deckPerformance(rows, "D", false);
    expect(p.overall.games).toBe(3);
    expect(p.grid.some((c) => c.tableBracket === 4)).toBe(false);
  });

  it("gives an indication, not a verdict, only with enough games", () => {
    const strong = Array.from({ length: 6 }, (_, i) => game(4, [["D", i < 4, i < 4 ? 1 : 3], ["x", false, 2], ["y", i >= 4, i >= 4 ? 1 : 3], ["z", false, 4]], 3)).flat();
    const hint = bracketHint(strong.filter((r) => r.deckRef === "D"), 3);
    expect(hint).toMatch(/Wins 4 of 6 games at tables above Bracket 3/);
    expect(hint).toMatch(/may indicate the deck plays stronger/);
    const weak = Array.from({ length: 5 }, () => game(3, [["D", false, 2], ["x", true, 1]], 3)).flat();
    expect(bracketHint(weak.filter((r) => r.deckRef === "D"), 3)).toMatch(/may indicate the deck plays weaker/);
    expect(bracketHint(weak.slice(0, 4).filter((r) => r.deckRef === "D"), 3)).toBeNull(); // too few games
    expect(bracketHint(strong.filter((r) => r.deckRef === "D"), null)).toBeNull();
  });
});
