import { describe, expect, it } from "vitest";
import { agentPoolIsSmall, agentPoolSize, isAgentBracketChoice, nearBrackets, nearLabel } from "./agents.js";

describe("bot box pool helpers", () => {
  const pool = { eligible: { 1: 0, 2: 4, 3: 75, 4: 75, 5: 24 }, hostBracket: 2 as const };

  it("'near' is the host's bracket and one either side, clipped to 1-5", () => {
    expect(nearBrackets(2)).toEqual([1, 2, 3]);
    expect(nearBrackets(1)).toEqual([1, 2]);
    expect(nearBrackets(5)).toEqual([4, 5]);
    expect(nearBrackets(null)).toEqual([1, 2, 3]);
    expect(nearLabel(4)).toBe("B3-B5");
  });

  it("counts the decks an option deals from and warns below five per bot seat", () => {
    expect(agentPoolSize(pool, 2)).toBe(4);
    expect(agentPoolSize(pool, "near")).toBe(79);
    expect(agentPoolIsSmall(4, 3)).toBe(true);
    expect(agentPoolIsSmall(15, 3)).toBe(false);
    expect(agentPoolIsSmall(4, 0)).toBe(true);
  });

  it("accepts 1-5 and 'near' only", () => {
    expect([1, 5, "near"].every(isAgentBracketChoice)).toBe(true);
    expect([0, 6, 2.5, "far", null].some(isAgentBracketChoice)).toBe(false);
  });
});
