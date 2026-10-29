import { describe, expect, it } from "vitest";
import { classifyLogLine, isEventEntry, isQuietEntry, kindFromEngineLogType, logKind } from "./logLines.js";

describe("log line kinds (what notifications show)", () => {
  it("maps Forge's log entry types", () => {
    expect(kindFromEngineLogType("TURN")).toBe("turn");
    expect(kindFromEngineLogType("PHASE")).toBe("step");
    expect(kindFromEngineLogType("ROUND")).toBe("round");
    expect(kindFromEngineLogType("MANA")).toBe("mana");
    for (const t of ["LAND", "ZONE_CHANGE", "DAMAGE", "LIFE", "STACK_ADD", "STACK_RESOLVE", "COMBAT", "MULLIGAN", "INFORMATION", "GAME_OUTCOME", "FIRST_PLAYER", ""]) {
      expect(kindFromEngineLogType(t)).toBe("event");
    }
  });

  it("classifies by wording when a line carries no kind", () => {
    expect(classifyLogLine("Turn 12 (Kevin)")).toBe("turn");
    expect(classifyLogLine("Round 4 begins")).toBe("round");
    expect(classifyLogLine("Kevin's Untap step")).toBe("step");
    expect(classifyLogLine("Kevin's Upkeep step")).toBe("step");
    expect(classifyLogLine("Kevin's Draw step")).toBe("step");
    expect(classifyLogLine("Kevin's Main phase, precombat")).toBe("step");
    expect(classifyLogLine("Kevin's Beginning of Combat Step")).toBe("step");
    expect(classifyLogLine("Kevin's Cleanup step")).toBe("step");
    expect(classifyLogLine("Chris' End step")).toBe("step");
    expect(classifyLogLine("Kevin played Forest")).toBe("event");
    expect(classifyLogLine("Kevin cast Sol Ring")).toBe("event");
    expect(classifyLogLine("Kevin's Sol Ring phased out")).toBe("event");
    expect(classifyLogLine("Life: Kevin 40 > 37")).toBe("event");
    expect(classifyLogLine("Kevin goes first")).toBe("event");
    expect(classifyLogLine("Plains - {T}: Add {W}.")).toBe("mana");
    expect(classifyLogLine("Sol Ring - {T}: Add {C}{C}.")).toBe("mana");
    expect(classifyLogLine("Giada, Font of Hope - Creature 2 / 2")).toBe("event"); // a spell resolving
  });

  it("knows what the Game Log keeps quiet by default", () => {
    expect(isQuietEntry({ text: "Kevin's Upkeep step", kind: "step" })).toBe(true);
    expect(isQuietEntry({ text: "Plains - {T}: Add {W}.", kind: "mana" })).toBe(true);
    expect(isQuietEntry({ text: "Turn 2 (Kevin)", kind: "turn" })).toBe(false);
    expect(isQuietEntry({ text: "Kevin played Forest", kind: "event" })).toBe(false);
  });

  it("prefers the kind the server set", () => {
    expect(logKind({ text: "Kevin's Upkeep step", kind: "event" })).toBe("event");
    expect(logKind({ text: "Kevin's Upkeep step" })).toBe("step");
    expect(isEventEntry({ text: "Kevin played Forest", kind: "event" })).toBe(true);
    expect(isEventEntry({ text: "Round 2 begins", kind: "round" })).toBe(false);
    expect(isEventEntry({ text: "Turn 2 (Kevin)" })).toBe(false);
  });
});
