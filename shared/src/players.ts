/**
 * The Players page (owner request 2026-10-28): everyone signed up, what their decks are (count, brackets) and how
 * they do in counted rules-engine games, so a player can tell whether someone tends to play at their level
 * before inviting them. Pure arithmetic here; the server loads the rows (routes/players.ts), the client renders.
 *
 * Privacy: deck lists and deck names are never part of this; a deck appears only as its commanders and bracket
 * (commanders are public at any table). A player can hide themself (`UserSettings.hideFromPlayers`).
 */
import type { AvatarColorKey, AvatarKey } from "./user.js";
import { withOpponentBrackets, LOW_SAMPLE, type ResultSeatRow } from "./deckStats.js";

export const PLAYER_BRACKETS = [1, 2, 3, 4, 5] as const;
export type BracketCounts = Record<1 | 2 | 3 | 4 | 5, number>;

/** One of a player's own decks, as the Players page may show it. */
export interface PlayerDeckRow {
  commanders: string[];
  /** The analysis engine's suggestion; null when it cannot be worked out (an empty or broken deck). */
  bracket: number | null;
}

export type PerformanceLevel = "strong" | "even" | "below";

export interface PlayerPerformance {
  games: number;
  wins: number;
  winRate: number | null;
  avgPlace: number | null;
  /** Wins over an even share (1 / players, summed over games): 1 = exactly even. Null with no games. */
  ratio: number | null;
  /** Null with no games. With fewer than LOW_SAMPLE games it is shown but marked `lowSample`. */
  level: PerformanceLevel | null;
  lowSample: boolean;
}

export interface PlayerSummary {
  userId: string;
  name: string;
  avatar: AvatarKey;
  color: AvatarColorKey;
  isMe: boolean;
  isFriend: boolean;
  online: boolean;
  /** Has an email account (vs a device-only profile). */
  hasAccount: boolean;
  decks: number;
  bracketCounts: BracketCounts;
  /** Decks whose bracket could not be worked out. */
  unknownBracket: number;
  /** Mean of the known deck brackets, one decimal. */
  averageBracket: number | null;
  /** The most common deck bracket (ties: the higher). */
  typicalBracket: number | null;
  /** The bracket most of their opponents played at in counted games (ties: the higher). */
  playsAt: number | null;
  performance: PlayerPerformance;
}

export interface BracketRecord {
  opponentBracket: number;
  games: number;
  wins: number;
  winRate: number | null;
  ratio: number | null;
}

export interface PlayerGameLine {
  endedAt: string | null;
  players: number;
  opponentBracket: number | null;
  place: number | null;
  won: boolean;
  /** The commanders they played (never the deck's name). */
  commanders: string[];
  deckBracket: number | null;
}

export interface PlayerDetail extends PlayerSummary {
  /** Their decks as commanders + bracket, highest bracket first. */
  deckList: PlayerDeckRow[];
  /** Counted games by the bracket their opponents played. */
  byOpponentBracket: BracketRecord[];
  /** Counted games by table size. */
  byPlayers: Array<{ players: number; games: number; wins: number; winRate: number | null }>;
  /** The last ten counted games, newest first. */
  recent: PlayerGameLine[];
}

/** The detail route's answer: a friend request waiting either way, and whether this player is hidden (only ever true for yourself). */
export interface PlayerDetailResponse extends PlayerDetail {
  friendRequest: "sent" | "received" | null;
  hidden: boolean;
}

export interface PlayersResponse {
  players: PlayerSummary[];
}

export const PERFORMANCE_TEXT: Record<PerformanceLevel, string> = {
  strong: "Wins more than an even share",
  even: "Wins about an even share",
  below: "Wins less than an even share",
};

const rate = (wins: number, games: number): number | null => (games ? wins / games : null);

/** The most common value, ties to the higher one; null for an empty list. */
function modeHigh(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  for (const [v, c] of counts) if (best === null || c > counts.get(best)! || (c === counts.get(best)! && v > best)) best = v;
  return best;
}

export function bracketCounts(decks: PlayerDeckRow[]): { counts: BracketCounts; unknown: number; average: number | null; typical: number | null } {
  const counts: BracketCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const known: number[] = [];
  let unknown = 0;
  for (const d of decks) {
    const b = d.bracket;
    if (b !== null && b >= 1 && b <= 5) {
      counts[b as 1 | 2 | 3 | 4 | 5]++;
      known.push(b);
    } else unknown++;
  }
  const average = known.length ? Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10 : null;
  return { counts, unknown, average, typical: modeHigh(known) };
}

/** Wins against an even share: strong at 1.25x or more, below at 0.75x or less. */
export function performanceOf(seats: ResultSeatRow[]): PlayerPerformance {
  const games = seats.length;
  const wins = seats.filter((s) => s.won).length;
  const placed = seats.filter((s) => s.place !== null);
  const expected = seats.reduce((n, s) => n + 1 / Math.max(2, s.playerCount), 0);
  const ratio = games ? Math.round((wins / expected) * 100) / 100 : null;
  return {
    games,
    wins,
    winRate: rate(wins, games),
    avgPlace: placed.length ? Math.round((placed.reduce((n, s) => n + (s.place as number), 0) / placed.length) * 10) / 10 : null,
    ratio,
    level: ratio === null ? null : ratio >= 1.25 ? "strong" : ratio <= 0.75 ? "below" : "even",
    lowSample: games < LOW_SAMPLE,
  };
}

export interface PlayerInput {
  userId: string;
  name: string;
  avatar: AvatarKey;
  color: AvatarColorKey;
  hasAccount: boolean;
  online: boolean;
  isFriend: boolean;
  decks: PlayerDeckRow[];
}

/**
 * Every player's numbers. `rows` = every seat of every COUNTED game (all players, so opponents' brackets can be
 * worked out); a player's own games are the seats with their user id.
 */
export function playerSummaries(players: PlayerInput[], rows: ResultSeatRow[], me: string): PlayerSummary[] {
  const rated = withOpponentBrackets(rows);
  const byUser = new Map<string, typeof rated>();
  for (const r of rated) if (r.userId && !r.isBot) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  return players.map((p) => summaryOf(p, byUser.get(p.userId) ?? [], me));
}

function summaryOf(p: PlayerInput, seats: Array<ResultSeatRow & { opponentBracket: number | null }>, me: string): PlayerSummary {
  const b = bracketCounts(p.decks);
  return {
    userId: p.userId,
    name: p.name,
    avatar: p.avatar,
    color: p.color,
    isMe: p.userId === me,
    isFriend: p.isFriend,
    online: p.online,
    hasAccount: p.hasAccount,
    decks: p.decks.length,
    bracketCounts: b.counts,
    unknownBracket: b.unknown,
    averageBracket: b.average,
    typicalBracket: b.typical,
    playsAt: modeHigh(seats.map((s) => s.opponentBracket).filter((x): x is number => x !== null)),
    performance: performanceOf(seats),
  };
}

/** One player's card plus the detail view. */
export function playerDetail(p: PlayerInput, rows: ResultSeatRow[], me: string): PlayerDetail {
  const rated = withOpponentBrackets(rows).filter((r) => r.userId === p.userId && !r.isBot);
  const summary = summaryOf(p, rated, me);
  const byOpponentBracket: BracketRecord[] = [];
  for (const ob of PLAYER_BRACKETS) {
    const g = rated.filter((r) => r.opponentBracket === ob);
    if (!g.length) continue;
    const perf = performanceOf(g);
    byOpponentBracket.push({ opponentBracket: ob, games: perf.games, wins: perf.wins, winRate: perf.winRate, ratio: perf.ratio });
  }
  const byPlayers = [2, 3, 4]
    .map((pc) => {
      const g = rated.filter((r) => r.playerCount === pc);
      const wins = g.filter((r) => r.won).length;
      return { players: pc, games: g.length, wins, winRate: rate(wins, g.length) };
    })
    .filter((x) => x.games > 0);
  const recent = [...rated]
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))
    .slice(0, 10)
    .map((r) => ({ endedAt: r.endedAt, players: r.playerCount, opponentBracket: r.opponentBracket, place: r.place, won: r.won, commanders: r.commanders, deckBracket: r.deckBracket }));
  const deckList = [...p.decks].sort((a, b) => (b.bracket ?? 0) - (a.bracket ?? 0) || (a.commanders[0] ?? "").localeCompare(b.commanders[0] ?? ""));
  return { ...summary, deckList, byOpponentBracket, byPlayers, recent };
}

export type MatchKind = "match" | "above" | "below" | "unknown" | "noDecks" | "self";

export interface PlayerMatch {
  kind: MatchKind;
  /** The level compared: where they play, else their typical deck bracket. */
  level: number | null;
  text: string;
}

/**
 * How a player's level compares with my decks: do I have a deck at the bracket they usually play at? Their level
 * is where their opponents usually were (games say more than deck labels), else their most common deck bracket.
 */
export function matchWith(mine: BracketCounts, player: Pick<PlayerSummary, "isMe" | "playsAt" | "typicalBracket">): PlayerMatch {
  if (player.isMe) return { kind: "self", level: player.playsAt ?? player.typicalBracket, text: "This is you" };
  const level = player.playsAt ?? player.typicalBracket;
  const myBrackets = PLAYER_BRACKETS.filter((b) => mine[b] > 0);
  if (level === null) return { kind: "unknown", level: null, text: "No decks or games yet" };
  if (!myBrackets.length) return { kind: "noDecks", level, text: `Plays around B${level}; you have no decks yet` };
  if (mine[level as 1 | 2 | 3 | 4 | 5] > 0) {
    const n = mine[level as 1 | 2 | 3 | 4 | 5];
    return { kind: "match", level, text: `Good match: you have ${n} B${level} deck${n === 1 ? "" : "s"}` };
  }
  const highest = Math.max(...myBrackets);
  const lowest = Math.min(...myBrackets);
  if (level > highest) return { kind: "above", level, text: `Plays around B${level}; your highest deck is B${highest}` };
  if (level < lowest) return { kind: "below", level, text: `Plays around B${level}; your lowest deck is B${lowest}` };
  const nearest = [...myBrackets].sort((a, b) => Math.abs(a - level) - Math.abs(b - level) || b - a)[0]!;
  return { kind: nearest > level ? "below" : "above", level, text: `Plays around B${level}; your nearest deck is B${nearest}` };
}
