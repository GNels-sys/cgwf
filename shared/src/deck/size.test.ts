import { describe, expect, it } from "vitest";
import { deckSizeProblem, deckSizeRule, STANDARD_DECK_SIZE } from "./types.js";

// Oracle text as Scryfall prints it (checked against the local card data 2026-10-28).
const WHTZ = { name: "Whtz, the Bibliophile", oracleText: "Rulebreaker — A deck with this commander has no maximum deck size.\n{3}, {T}: You draw a card and gain 1 life. This ability costs {3} less to activate if you had 200 or more cards in your starting deck." };
const BLUE_MAGE = { name: "The Covert Blue Mage", oracleText: "If The Covert Blue Mage is your commander, your starting deck can contain any number of cards beyond the maximum deck size." };
const ATRAXA = { name: "Atraxa, Praetors' Voice", oracleText: "Flying, vigilance, deathtouch, lifelink\nAt the beginning of your end step, proliferate." };

describe("deck size rule", () => {
  it("is exactly 100 for an ordinary commander or none", () => {
    expect(deckSizeRule([ATRAXA])).toEqual(STANDARD_DECK_SIZE);
    expect(deckSizeRule([])).toEqual({ min: 100, max: 100, grantedBy: null });
  });

  it("has no maximum under Whtz, the Bibliophile or The Covert Blue Mage, even beside a partner", () => {
    expect(deckSizeRule([WHTZ])).toEqual({ min: 100, max: null, grantedBy: "Whtz, the Bibliophile" });
    expect(deckSizeRule([BLUE_MAGE])).toEqual({ min: 100, max: null, grantedBy: "The Covert Blue Mage" });
    expect(deckSizeRule([ATRAXA, WHTZ]).grantedBy).toBe("Whtz, the Bibliophile");
  });

  it("keeps the owner's messages and only drops the maximum", () => {
    expect(deckSizeProblem(101)).toBe("Your deck currently has 101 cards. Please remove 1 card prior to saving.");
    expect(deckSizeProblem(98)).toBe("Your deck currently has 98 cards. Please add 2 cards prior to saving.");
    expect(deckSizeProblem(100)).toBeNull();
    const whtz = deckSizeRule([WHTZ]);
    expect(deckSizeProblem(100, whtz)).toBeNull();
    expect(deckSizeProblem(101, whtz)).toBeNull();
    expect(deckSizeProblem(250, whtz)).toBeNull();
    expect(deckSizeProblem(99, whtz)).toBe("Your deck currently has 99 cards. Please add 1 card prior to saving.");
  });
});
