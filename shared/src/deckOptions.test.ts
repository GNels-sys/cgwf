import { describe, expect, it } from "vitest";
import { deckOptionLabel, filterDeckOptions, type DeckOption } from "./deckOptions.js";

const d = (name: string, bracket: number | null, id = name): DeckOption => ({ id, name, commanders: ["Atraxa"], bracket, tags: [] });

describe("lobby deck options", () => {
  const list = [d("zeta", 2), d("Alpha", 3), d("mid", null), d("beta", 2)];

  it("sorts alphabetically (case-insensitive) and keeps unknown brackets only under Any bracket", () => {
    expect(filterDeckOptions(list, null).map((x) => x.name)).toEqual(["Alpha", "beta", "mid", "zeta"]);
    expect(filterDeckOptions(list, 2).map((x) => x.name)).toEqual(["beta", "zeta"]);
    expect(filterDeckOptions(list, 5)).toEqual([]);
  });

  it("labels each option with the bracket and the commanders", () => {
    expect(deckOptionLabel(d("Alpha", 3))).toBe("Alpha · B3 · Atraxa");
    expect(deckOptionLabel(d("mid", null))).toBe("mid · bracket unknown · Atraxa");
  });
});
