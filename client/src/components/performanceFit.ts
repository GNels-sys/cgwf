import { LOW_SAMPLE, type DeckPerformance, type GridCell } from "@cgwf/shared";

export type PowerLevel = 1 | 2 | 3 | 4 | 5 | "3+";
export interface PerformanceFit {
  level: PowerLevel;
  cell: GridCell;
  evidenceGames: number;
  provisional: boolean;
  between: boolean;
}

const ratio = (cell: GridCell) => cell.wins * cell.players / cell.games;
const distance = (cell: GridCell) => Math.round(Math.abs(ratio(cell) - 1) * 1e9) / 1e9;

/** A presentation hint from counted results, never a rules/bracket reassignment.
 * Compare like-sized tables against 1/N. Do not recommend a spot from <5 games.
 * B3+ needs evidence at BOTH B3 and B4 for the SAME player count.
 */
export function performanceFit(performance: DeckPerformance): PerformanceFit | null {
  const tested = performance.grid.filter((cell) => cell.games >= LOW_SAMPLE && cell.winRate !== null && cell.players >= 2 && cell.players <= 4 && cell.tableBracket >= 1 && cell.tableBracket <= 5);
  const bands = tested.filter((cell) => cell.tableBracket === 3 && ratio(cell) >= 1.25)
    .map((lower) => ({ lower, upper: tested.find((cell) => cell.tableBracket === 4 && cell.players === lower.players && ratio(cell) <= .75) }))
    .filter((pair) => pair.upper)
    .sort((a, b) => (b.lower.games + b.upper!.games) - (a.lower.games + a.upper!.games) || b.lower.players - a.lower.players);
  const band = bands[0];
  if (band) {
    const evidenceGames = band.lower.games + band.upper!.games;
    return { level: "3+", cell: band.lower, evidenceGames, provisional: band.lower.games < 20 || band.upper!.games < 20, between: true };
  }
  const balanced = tested.filter((cell) => ratio(cell) > .5 && ratio(cell) < 1.5)
    .sort((a, b) => distance(a) - distance(b) || b.games - a.games || b.players - a.players || b.tableBracket - a.tableBracket);
  const best = balanced[0];
  return best ? { level: best.tableBracket as PowerLevel, cell: best, evidenceGames: best.games, provisional: best.games < 20, between: false } : null;
}

export function powerValue(level: PowerLevel): number {
  return level === "3+" ? 3.5 : level;
}
