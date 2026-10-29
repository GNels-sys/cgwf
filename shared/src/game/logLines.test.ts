import { describe, expect, it } from "vitest";
import { classifyLogLine, isEventEntry, kindFromEngineLogType, logKind } from "./logLines.js";

describe("log line kinds (what notifications show)", () => {
  it("maps Forge's log entry types", () => {
    expect(kindFromEngineLogType("TURN")).toBe("turn");
    expect(kindFromEngineLogType("PHASE")).toBe("step");
    expect(kindFromEngineLogType("ROUND")).toBe("round");
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
  });

  it("prefers the kind the server set", () => {
    expect(logKind({ text: "Kevin's Upkeep step", kind: "event" })).toBe("event");
    expect(logKind({ text: "Kevin's Upkeep step" })).toBe("step");
    expect(isEventEntry({ text: "Kevin played Forest", kind: "event" })).toBe(true);
    expect(isEventEntry({ text: "Round 2 begins", kind: "round" })).toBe(false);
    expect(isEventEntry({ text: "Turn 2 (Kevin)" })).toBe(false);
  });
});
