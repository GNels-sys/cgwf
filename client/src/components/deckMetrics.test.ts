import { describe, expect, it } from "vitest";
import type { DeckSummary, PipCounts } from "@cgwf/shared";
import { sortDecks, type DeckMetrics } from "./deckMetrics";

const decks: DeckSummary[] = [
  { id: "unknown", name: "Alpha", updatedAt: "2026-10-16" },
  { id: "core", name: "Forest", updatedAt: "2026-10-14" },
  { id: "optimized", name: "Ember", updatedAt: "2026-10-15" },
].map((d) => ({ ...d, format: "commander", cardCount: 100, commanders: [] }));
const pips = (coloredTotal: number): PipCounts => ({
  coloredTotal, colored: { W: 0, U: 0, B: 0, R: 0, G: coloredTotal, C: 0 },
  generic: 100, hybridSymbols: 0, phyrexianSymbols: 0, xSpells: 0, xSpellNames: [],
});
const metrics: Record<string, DeckMetrics> = {
  unknown: { bracket: null, pips: null },
  core: { bracket: 2, pips: pips(23.5) },
  optimized: { bracket: 4, pips: pips(17) },
};

describe("collection sorting", () => {
  it("sorts brackets in both directions with unavailable decks last", () => {
    expect(sortDecks(decks, metrics, "bracket-asc").map((d) => d.id)).toEqual(["core", "optimized", "unknown"]);
    expect(sortDecks(decks, metrics, "bracket-desc").map((d) => d.id)).toEqual(["optimized", "core", "unknown"]);
  });
  it("sorts fractional pip totals without counting generic mana", () => {
    expect(sortDecks(decks, metrics, "pips").map((d) => d.id)).toEqual(["core", "optimized", "unknown"]);
  });
  it("sorts dates and names without mutating the collection", () => {
    expect(sortDecks(decks, metrics, "updated").map((d) => d.id)).toEqual(["unknown", "optimized", "core"]);
    expect(sortDecks(decks, metrics, "name").map((d) => d.id)).toEqual(["unknown", "optimized", "core"]);
    expect(decks.map((d) => d.id)).toEqual(["unknown", "core", "optimized"]);
  });
  it("keeps loading decks last and uses names to break ties", () => {
    expect(sortDecks(decks, {}, "pips").map((d) => d.name)).toEqual(["Alpha", "Ember", "Forest"]);
    expect(sortDecks(decks, { ...metrics, optimized: metrics.core! }, "bracket-desc").map((d) => d.id)).toEqual(["optimized", "core", "unknown"]);
  });
});
