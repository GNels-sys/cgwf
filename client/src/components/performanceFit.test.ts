import { describe, expect, it } from "vitest";
import type { DeckPerformance, GridCell } from "@cgwf/shared";
import { performanceFit, powerValue } from "./performanceFit";

const cell = (opponentBracket: number, players: number, games: number, wins: number): GridCell => ({ opponentBracket, players, games, wins, winRate: games ? wins / games : null, lowSample: games < 5 });
const performance = (...grid: GridCell[]): DeckPerformance => ({ deckRef: "deck", deckName: "Test", commanders: [], library: false, deckBracket: 4, overall: { games: 20, wins: 5, winRate: .25, avgPlace: 2, conceded: 0 }, grid, hint: null, headToHead: [], includeBots: true });

describe("results-based seating hints", () => {
  it("does not infer power from missing or low-sample matchups", () => {
    expect(performanceFit(performance())).toBeNull();
    expect(performanceFit(performance(cell(3, 4, 4, 1)))).toBeNull();
    expect(performanceFit(performance(cell(3, 4, 20, 0)))).toBeNull();
    expect(performanceFit(performance(cell(3, 4, 20, 18)))).toBeNull();
  });
  it("seeks an even share for the actual player count, not the largest raw win rate", () => {
    const p = performance(cell(2, 4, 20, 12), cell(3, 4, 20, 5), cell(4, 2, 20, 8));
    expect(performanceFit(p)).toMatchObject({ level: 3, cell: { players: 4 }, provisional: false });
  });
  it("compares duel and multiplayer baselines fairly", () => {
    expect(performanceFit(performance(cell(3, 2, 20, 10), cell(4, 4, 20, 10)))?.level).toBe(3);
    expect(performanceFit(performance(cell(3, 2, 20, 5), cell(4, 4, 20, 5)))?.level).toBe(4);
  });
  it("requires B3 AND B4 evidence at the same table size for B3+", () => {
    expect(performanceFit(performance(cell(3, 4, 20, 8), cell(4, 4, 20, 2)))).toMatchObject({ level: "3+", evidenceGames: 40, provisional: false, between: true });
    expect(performanceFit(performance(cell(3, 4, 20, 8), cell(4, 3, 20, 2)))?.level).not.toBe("3+");
    expect(performanceFit(performance(cell(3, 4, 20, 8), cell(4, 4, 4, 0)))?.level).not.toBe("3+");
  });
  it("marks small supporting samples as provisional, even if their sum is large", () => {
    expect(performanceFit(performance(cell(3, 4, 100, 40), cell(4, 4, 5, 0)))?.provisional).toBe(true);
    expect(performanceFit(performance(cell(3, 4, 8, 2)))?.provisional).toBe(true);
  });
  it("breaks mathematically equal distances by sample size, preserving source data", () => {
    const p = performance(cell(3, 4, 10, 3), cell(4, 2, 20, 8));
    const before = JSON.stringify(p);
    expect(performanceFit(p)?.level).toBe(4);
    expect(JSON.stringify(p)).toBe(before);
  });
  it("does not rewrite the analysis bracket when the observed fit is B3+", () => {
    const p = performance(cell(3, 4, 20, 8), cell(4, 4, 20, 2));
    const fit = performanceFit(p)!;
    expect(powerValue(fit.level)).toBe(3.5);
    expect(p.deckBracket).toBe(4);
  });
});
