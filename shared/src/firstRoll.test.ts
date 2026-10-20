import { describe, expect, it } from "vitest";
import {
  firstRollText,
  isFirstPlayerMethod,
  joinNames,
  resolveRound,
} from "./firstRoll.js";

describe("rolling for who goes first", () => {
  it("the single highest roll wins", () => {
    expect(
      resolveRound([
        { seat: 0, value: 4 },
        { seat: 1, value: 19 },
        { seat: 2, value: 11 },
      ]),
    ).toEqual({ winner: 1 });
  });
  it("a tie at the top sends only the tied seats to roll again", () => {
    expect(
      resolveRound([
        { seat: 3, value: 17 },
        { seat: 0, value: 2 },
        { seat: 1, value: 17 },
      ]),
    ).toEqual({ tied: [1, 3], value: 17 });
  });
  it("a tie below the top does not matter", () => {
    expect(
      resolveRound([
        { seat: 0, value: 5 },
        { seat: 1, value: 5 },
        { seat: 2, value: 6 },
      ]),
    ).toEqual({ winner: 2 });
  });
  it("names and log lines read as sentences", () => {
    expect(joinNames(["Alex"])).toBe("Alex");
    expect(joinNames(["Alex", "Blair"])).toBe("Alex and Blair");
    expect(joinNames(["Alex", "Blair", "Casey"])).toBe("Alex, Blair and Casey");
    expect(firstRollText.rolled("Alex", 17)).toBe("Alex rolled 17");
    expect(firstRollText.tied(["Alex", "Blair"], 9)).toBe(
      "Alex and Blair tied with 9: they roll again",
    );
    expect(firstRollText.goesFirst("Alex")).toBe("Alex goes first");
  });
  it("only two methods exist", () => {
    expect(isFirstPlayerMethod("roll")).toBe(true);
    expect(isFirstPlayerMethod("random")).toBe(true);
    expect(isFirstPlayerMethod("coin")).toBe(false);
  });
});
