/**
 * Deck performance from COUNTED rules-engine games only (not test games, finished with a winner or a
 * draw). Pure: the server loads the rows, these functions do the arithmetic, the client renders.
 */

/** One seat of one counted game, as the server loads it (game_results joined with game_result_seats). */
export interface ResultSeatRow {
  gameId: string;
  endedAt: string | null;
  tableBracket: number | null;
  playerCount: number;
  seat: number;
  userId: string | null;
  isBot: boolean;
  deckRef: string | null;
  deckOwnerId: string | null;
  deckName: string;
  commanders: string[];
  deckBracket: number | null;
  place: number | null;
  won: boolean;
  conceded: boolean;
}

/** A seat with the bracket its opponents played at (see `opponentBracket`). */
export type RatedSeatRow = ResultSeatRow & { opponentBracket: number | null };

export interface Record3 {
  games: number;
  wins: number;
  /** wins / games, 0..1; null with no games. */
  winRate: number | null;
}

export interface GridCell extends Record3 {
  /** The bracket most of this deck's opponents played at (ties: the higher one). */
  opponentBracket: number;
  /** The same number under the field's old name, for copies of the app cached before 2026-10-20. */
  tableBracket: number;
  players: number;
  /** Fewer than LOW_SAMPLE games: shown, but marked as too few to read much into. */
  lowSample: boolean;
}

export interface HeadToHead {
  /** The opposing deck (its reference) and its name as last seen. */
  deckRef: string;
  deckName: string;
  library: boolean;
  /** Games both decks were in. */
  games: number;
  /** This deck won. */
  wins: number;
  /** The opposing deck won. */
  losses: number;
  /** This deck finished above the opposing deck (better place). */
  ahead: number;
}

export interface DeckPerformance {
  deckRef: string;
  deckName: string;
  commanders: string[];
  library: boolean;
  /** The deck's bracket in its most recent counted game (or as supplied). */
  deckBracket: number | null;
  overall: Record3 & { avgPlace: number | null; conceded: number };
  /** Opponents' bracket 1-5 by player count 2-4; cells with no games are omitted. */
  grid: GridCell[];
  /** Plain-language indication, or null when the data says nothing clear. */
  hint: string | null;
  headToHead: HeadToHead[];
  includeBots: boolean;
}

export const LOW_SAMPLE = 5;
export const TABLE_BRACKETS = [1, 2, 3, 4, 5] as const;
export const PLAYER_COUNTS = [2, 3, 4] as const;

const rate = (wins: number, games: number): number | null => (games ? wins / games : null);

/** Rows of games that may be counted under the bots toggle: with it off, any game that had a bot seat is left out. */
export function gamesInScope(rows: ResultSeatRow[], includeBots: boolean): ResultSeatRow[] {
  if (includeBots) return rows;
  const withBots = new Set(rows.filter((r) => r.isBot).map((r) => r.gameId));
  return rows.filter((r) => !withBots.has(r.gameId));
}

/**
 * The bracket a seat played against: the most common deck bracket among the OTHER seats of its game
 * (the deck's own bracket is left out, so a B4 deck at a table of B2 decks counts as a game against
 * B2). A tie goes to the higher bracket, so a record is never flattered. Seats with no recorded
 * bracket are ignored; with none at all, the table bracket agreed in the lobby is used.
 */
export function opponentBracket(me: ResultSeatRow, gameSeats: ResultSeatRow[]): number | null {
  const counts = new Map<number, number>();
  for (const s of gameSeats) {
    if (s.seat === me.seat || s.deckBracket === null) continue;
    counts.set(s.deckBracket, (counts.get(s.deckBracket) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [b, c] of counts) if (best === null || c > counts.get(best)! || (c === counts.get(best)! && b > best)) best = b;
  return best ?? me.tableBracket;
}

/** Every row with its opponents' bracket, computed from the other seats of the same game in `rows`. */
export function withOpponentBrackets(rows: ResultSeatRow[]): RatedSeatRow[] {
  const byGame = new Map<string, ResultSeatRow[]>();
  for (const r of rows) byGame.set(r.gameId, [...(byGame.get(r.gameId) ?? []), r]);
  return rows.map((r) => ({ ...r, opponentBracket: opponentBracket(r, byGame.get(r.gameId) ?? []) }));
}

/**
 * One deck's performance. `rows` = every seat of every counted game in scope (all decks, so head-to-head
 * can see the opponents); the deck's own seats are those with its `deckRef` (and, for a personal deck,
 * the caller has already restricted them to the owner).
 */
export function deckPerformance(allRows: ResultSeatRow[], deckRef: string, includeBots: boolean): DeckPerformance {
  const rows = withOpponentBrackets(gamesInScope(allRows, includeBots));
  const mine = rows.filter((r) => r.deckRef === deckRef);
  const latest = [...mine].sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  const wins = mine.filter((r) => r.won).length;
  const placed = mine.filter((r) => r.place !== null);
  const overall = {
    games: mine.length,
    wins,
    winRate: rate(wins, mine.length),
    avgPlace: placed.length ? placed.reduce((n, r) => n + (r.place as number), 0) / placed.length : null,
    conceded: mine.filter((r) => r.conceded).length,
  };
  const grid: GridCell[] = [];
  for (const ob of TABLE_BRACKETS) {
    for (const pc of PLAYER_COUNTS) {
      const cell = mine.filter((r) => r.opponentBracket === ob && r.playerCount === pc);
      if (!cell.length) continue;
      const w = cell.filter((r) => r.won).length;
      grid.push({ opponentBracket: ob, tableBracket: ob, players: pc, games: cell.length, wins: w, winRate: rate(w, cell.length), lowSample: cell.length < LOW_SAMPLE });
    }
  }
  // head to head: every opposing seat in this deck's games
  const byGame = new Map<string, ResultSeatRow[]>();
  for (const r of rows) {
    const list = byGame.get(r.gameId) ?? [];
    list.push(r);
    byGame.set(r.gameId, list);
  }
  const h2h = new Map<string, HeadToHead>();
  for (const me of mine) {
    // once per game per opposing deck, even when two seats played the same deck
    const opponents = new Map<string, ResultSeatRow[]>();
    for (const opp of byGame.get(me.gameId) ?? []) {
      if (opp.seat === me.seat || !opp.deckRef) continue;
      opponents.set(opp.deckRef, [...(opponents.get(opp.deckRef) ?? []), opp]);
    }
    for (const [ref, seats] of opponents) {
      const h = h2h.get(ref) ?? { deckRef: ref, deckName: seats[0]!.deckName, library: ref.startsWith("library:"), games: 0, wins: 0, losses: 0, ahead: 0 };
      h.games++;
      if (me.won) h.wins++;
      if (seats.some((o) => o.won)) h.losses++;
      const best = Math.min(...seats.map((o) => o.place ?? Infinity));
      if (me.place !== null && me.place < best) h.ahead++;
      h2h.set(ref, h);
    }
  }
  const deckBracket = latest?.deckBracket ?? null;
  return {
    deckRef,
    deckName: latest?.deckName ?? "",
    commanders: latest?.commanders ?? [],
    library: deckRef.startsWith("library:"),
    deckBracket,
    overall,
    grid,
    hint: bracketHint(mine, deckBracket),
    headToHead: [...h2h.values()].sort((a, b) => b.games - a.games || a.deckName.localeCompare(b.deckName)),
    includeBots,
  };
}

/**
 * An indication, never a verdict: compares wins with what an even table would give (1 / players per
 * game) against opponents above and at-or-below the deck's own bracket. Needs LOW_SAMPLE games in a group.
 */
export function bracketHint(mine: RatedSeatRow[], deckBracket: number | null): string | null {
  if (deckBracket === null) return null;
  const group = (pred: (r: RatedSeatRow) => boolean) => {
    const g = mine.filter((r) => r.opponentBracket !== null && pred(r));
    const expected = g.reduce((n, r) => n + 1 / Math.max(2, r.playerCount), 0);
    return { games: g.length, wins: g.filter((r) => r.won).length, expected };
  };
  const above = group((r) => (r.opponentBracket as number) > deckBracket);
  const atOrBelow = group((r) => (r.opponentBracket as number) <= deckBracket);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (above.games >= LOW_SAMPLE && above.wins >= above.expected * 1.5 && above.wins >= 2) {
    return `Wins ${above.wins} of ${above.games} games against opponents above Bracket ${deckBracket} (an even share would be about ${Math.round(above.expected)}, ${pct(above.expected / above.games)}). This may indicate the deck plays stronger than its bracket.`;
  }
  if (atOrBelow.games >= LOW_SAMPLE && atOrBelow.wins <= atOrBelow.expected * 0.5) {
    return `Wins ${atOrBelow.wins} of ${atOrBelow.games} games against Bracket ${deckBracket} opponents or lower (an even share would be about ${Math.round(atOrBelow.expected)}, ${pct(atOrBelow.expected / atOrBelow.games)}). This may indicate the deck plays weaker than its bracket.`;
  }
  return null;
}

/** One line of the Deck stats page. */
export interface DeckStatsRow {
  deckRef: string;
  deckName: string;
  commanders: string[];
  library: boolean;
  deckBracket: number | null;
  games: number;
  wins: number;
  winRate: number | null;
  avgPlace: number | null;
}

export interface DeckStatsListResponse {
  decks: DeckStatsRow[];
  includeBots: boolean;
}

export function statsRow(p: DeckPerformance): DeckStatsRow {
  return {
    deckRef: p.deckRef,
    deckName: p.deckName,
    commanders: p.commanders,
    library: p.library,
    deckBracket: p.deckBracket,
    games: p.overall.games,
    wins: p.overall.wins,
    winRate: p.overall.winRate,
    avgPlace: p.overall.avgPlace,
  };
}
