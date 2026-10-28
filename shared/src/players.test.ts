import { describe, expect, it } from "vitest";
import type { ResultSeatRow } from "./deckStats.js";
import { bracketCounts, matchWith, performanceOf, playerDetail, playerSummaries, type PlayerInput } from "./players.js";

let n = 0;
/** One counted game: seats as [userId, deckBracket, won, place, isBot?]. */
function game(seats: Array<[string, number | null, boolean, number, boolean?]>, commanders = ["Cmdr"]): ResultSeatRow[] {
  const id = `g${++n}`;
  return seats.map(([userId, deckBracket, won, place, isBot], seat) => ({
    gameId: id,
    endedAt: `2026-10-${String(10 + n).padStart(2, "0")}T00:00:00Z`,
    tableBracket: 3,
    playerCount: seats.length,
    seat,
    userId,
    isBot: Boolean(isBot),
    deckRef: `${userId}-deck`,
    deckOwnerId: userId,
    deckName: "Secret Deck Name",
    commanders,
    deckBracket,
    place,
    won,
    conceded: false,
  }));
}

const person = (userId: string, decks: Array<number | null>): PlayerInput => ({
  userId,
  name: userId,
  avatar: "fox",
  color: "jade",
  hasAccount: true,
  online: false,
  isFriend: false,
  decks: decks.map((bracket) => ({ commanders: [`${userId} cmdr`], bracket })),
});

describe("deck brackets on a player card", () => {
  it("counts per bracket, unknowns apart, average to one decimal, most common with ties to the higher", () => {
    const b = bracketCounts([2, 2, 3, 4, null].map((bracket) => ({ commanders: [], bracket })));
    expect(b.counts).toEqual({ 1: 0, 2: 2, 3: 1, 4: 1, 5: 0 });
    expect(b.unknown).toBe(1);
    expect(b.average).toBe(2.8);
    expect(b.typical).toBe(2);
    expect(bracketCounts([3, 4].map((bracket) => ({ commanders: [], bracket }))).typical).toBe(4);
    expect(bracketCounts([])).toMatchObject({ average: null, typical: null, unknown: 0 });
  });
});

describe("performance against an even share", () => {
  it("compares wins with 1 / players per game and labels it, marking small samples", () => {
    // 3 four-player games won out of 4 -> expected 1, ratio 3
    const strong = [game([["a", 3, true, 1], ["x", 3, false, 2], ["y", 3, false, 3], ["z", 3, false, 4]]),
      game([["a", 3, true, 1], ["x", 3, false, 2], ["y", 3, false, 3], ["z", 3, false, 4]]),
      game([["a", 3, true, 1], ["x", 3, false, 2], ["y", 3, false, 3], ["z", 3, false, 4]]),
      game([["a", 3, false, 4], ["x", 3, true, 1], ["y", 3, false, 2], ["z", 3, false, 3]])].flat().filter((r) => r.userId === "a");
    expect(performanceOf(strong)).toMatchObject({ games: 4, wins: 3, ratio: 3, level: "strong", lowSample: true, avgPlace: 1.8 });
    // one win in four two-player games -> expected 2, ratio 0.5
    const weak = [0, 1, 2, 3].flatMap((i) => game([["a", 3, i === 0, i === 0 ? 1 : 2], ["x", 3, i !== 0, i === 0 ? 2 : 1]])).filter((r) => r.userId === "a");
    expect(performanceOf(weak)).toMatchObject({ ratio: 0.5, level: "below" });
    expect(performanceOf([])).toMatchObject({ games: 0, ratio: null, level: null, winRate: null });
  });
});

describe("player summaries and the detail view", () => {
  const rows = [
    // Georgie's B4 deck at a table of B2 decks, then at a table of B3 decks; a bot seat is never a player
    ...game([["georgie", 4, true, 1], ["blair", 2, false, 2], ["bot1", 2, false, 3, true]], ["Stingerquill"]),
    ...game([["georgie", 4, true, 1], ["blair", 3, false, 2], ["cara", 3, false, 3], ["bot2", 3, false, 4, true]], ["Stingerquill"]),
    ...game([["blair", 3, true, 1], ["cara", 3, false, 2]]),
  ];
  const people = [person("georgie", [4, 4, 3]), person("blair", [2, 3]), person("cara", [])];

  it("each player's numbers come from their own seats, with where their opponents usually were", () => {
    const [georgie, blair, cara] = playerSummaries(people, rows, "blair");
    expect(georgie).toMatchObject({ decks: 3, averageBracket: 3.7, typicalBracket: 4, playsAt: 3, isMe: false });
    expect(georgie!.performance).toMatchObject({ games: 2, wins: 2 });
    expect(blair).toMatchObject({ isMe: true, decks: 2, playsAt: 3 }); // opponents per game: B4/B2 tie -> 4, then mostly B3, then B3
    expect(cara).toMatchObject({ decks: 0, averageBracket: null, typicalBracket: null });
    expect(cara!.performance.games).toBe(2);
  });

  it("the detail lists records by opponents' bracket and table size, recent games and decks, never a deck name", () => {
    const d = playerDetail(people[0]!, rows, "blair");
    expect(d.byOpponentBracket).toEqual([
      { opponentBracket: 2, games: 1, wins: 1, winRate: 1, ratio: 3 },
      { opponentBracket: 3, games: 1, wins: 1, winRate: 1, ratio: 4 },
    ]);
    expect(d.byPlayers.map((x) => [x.players, x.games])).toEqual([[3, 1], [4, 1]]);
    expect(d.recent).toHaveLength(2);
    expect(d.recent[0]).toMatchObject({ players: 4, opponentBracket: 3, won: true, commanders: ["Stingerquill"] });
    expect(d.deckList.map((x) => x.bracket)).toEqual([4, 4, 3]);
    expect(JSON.stringify(d)).not.toContain("Secret Deck Name");
  });
});

describe("matching a player's level with my decks", () => {
  const mine = { 1: 0, 2: 2, 3: 1, 4: 0, 5: 0 } as const;
  it("says when I have a deck at their level", () => {
    expect(matchWith(mine, { isMe: false, playsAt: 3, typicalBracket: 4 })).toEqual({ kind: "match", level: 3, text: "Good match: you have 1 B3 deck" });
    expect(matchWith(mine, { isMe: false, playsAt: null, typicalBracket: 2 }).text).toBe("Good match: you have 2 B2 decks");
  });
  it("says when they play above or below everything I have", () => {
    expect(matchWith(mine, { isMe: false, playsAt: 4, typicalBracket: 4 })).toMatchObject({ kind: "above", text: "Plays around B4; your highest deck is B3" });
    expect(matchWith(mine, { isMe: false, playsAt: 1, typicalBracket: null })).toMatchObject({ kind: "below", text: "Plays around B1; your lowest deck is B2" });
    const gap = { 1: 0, 2: 1, 3: 0, 4: 1, 5: 0 } as const;
    expect(matchWith(gap, { isMe: false, playsAt: 3, typicalBracket: null })).toMatchObject({ kind: "below", text: "Plays around B3; your nearest deck is B4" });
  });
  it("handles nothing to compare", () => {
    expect(matchWith(mine, { isMe: false, playsAt: null, typicalBracket: null }).kind).toBe("unknown");
    expect(matchWith({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, { isMe: false, playsAt: 3, typicalBracket: 3 }).kind).toBe("noDecks");
    expect(matchWith(mine, { isMe: true, playsAt: 3, typicalBracket: 3 }).kind).toBe("self");
  });
});
