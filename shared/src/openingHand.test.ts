import { describe, expect, it } from "vitest";
import {
  OPENING_HAND_TEXT,
  openingHandSummary,
  sanitizeOpeningHand,
} from "./openingHand.js";

describe("the opening-hand rule", () => {
  it("sanitises anything into a valid rule", () => {
    expect(sanitizeOpeningHand("draw7", 2)).toEqual({
      mode: "draw7",
      freeMulligans: 2,
    });
    expect(sanitizeOpeningHand("draw7", 9)).toEqual({
      mode: "draw7",
      freeMulligans: 2,
    });
    expect(sanitizeOpeningHand("draw7", -1)).toEqual({
      mode: "draw7",
      freeMulligans: 0,
    });
    expect(sanitizeOpeningHand("nonsense", "x")).toEqual({
      mode: "draw7",
      freeMulligans: 1,
    });
    expect(sanitizeOpeningHand("draw10", 2)).toEqual({
      mode: "draw10",
      freeMulligans: 0,
    });
  });
  it("describes both options in plain words", () => {
    expect(OPENING_HAND_TEXT.draw7.rules).toMatch(/first mulligan is free/);
    expect(OPENING_HAND_TEXT.draw10.title).toBe(
      "Draw 10, put 3 back (no mulligans)",
    );
    expect(OPENING_HAND_TEXT.draw10.rules).toMatch(
      /shuffled back into their library/,
    );
    expect(OPENING_HAND_TEXT.draw10.rules).toMatch(
      /Nothing goes to the graveyard/,
    );
    expect(openingHandSummary({ mode: "draw7", freeMulligans: 1 })).toBe(
      "Draw 7 · 1 free mulligan",
    );
  });
});
