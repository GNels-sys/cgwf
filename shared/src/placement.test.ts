import { describe, expect, it } from "vitest";
import { placementFit, rankPlacements, type PlacementOption } from "./placement.js";

const opt = (deckName: string, score: number, addScore: number, raises = false): PlacementOption => ({
  deckId: deckName,
  deckName,
  commanders: [],
  fit: placementFit(addScore, score),
  score,
  addScore,
  synergy: null,
  inclusion: null,
  role: null,
  roles: [],
  reason: "",
  combos: [],
  cut: { entryId: 1, cardId: "c", oracleId: "o", name: "Cut", manaCost: "", typeLine: "", faceCount: 1, synergy: null, inclusion: null } as unknown as PlacementOption["cut"],
  bracket: { floorBefore: 2, floorAfter: raises ? 4 : 2, raises, note: raises ? "raises" : null },
  targetBracket: 2,
});

describe("card placement ranking", () => {
  it("labels fit from the card's own score, weak when it does not beat its cut", () => {
    expect(placementFit(80, 30)).toBe("strong");
    expect(placementFit(30, 10)).toBe("good");
    expect(placementFit(10, 5)).toBe("weak");
    expect(placementFit(90, 0)).toBe("weak");
    expect(placementFit(90, -4)).toBe("weak");
  });

  it("puts decks it would not push up a bracket first, then the bigger gain, then the stronger card", () => {
    const ranked = rankPlacements([opt("Raises", 90, 95, true), opt("Small", 10, 20), opt("Big", 40, 60), opt("Tie", 40, 70)]);
    expect(ranked.map((o) => o.deckName)).toEqual(["Tie", "Big", "Small", "Raises"]);
  });
});
