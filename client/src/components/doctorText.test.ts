import { describe, expect, it } from "vitest";
import { aiRunLine, stockText } from "./doctorText";

describe("Deck Doctor wording", () => {
  it("says where a suggested card is in stock, and nothing when it is not or nobody knows", () => {
    expect(stockText(2, 1.25)).toBe("In stock at 2 local stores (from $1.25)");
    expect(stockText(1, null)).toBe("In stock at 1 local store");
    expect(stockText(0, 3)).toBeNull();
    expect(stockText(null, null)).toBeNull();
  });

  it("summarises an AI run in one line, naming a refusal fallback", () => {
    const run = { model: "claude-opus-5-5", servedBy: "claude-opus-5-5", status: "done", calls: 3, toolCalls: 4, costUsd: 0.4234, startedAt: "2026-10-19T10:00:00Z", finishedAt: "2026-10-19T10:02:00Z", invalidSubmissions: 1 };
    expect(aiRunLine(run)).toBe("claude-opus-5-5 · done · 3 calls, 4 tool uses · $0.42 · 1 answer sent back · 2 min");
    expect(aiRunLine({ ...run, servedBy: "claude-opus-4-8", status: "running", finishedAt: null, invalidSubmissions: 0 })).toBe("claude-opus-4-8 (fallback from claude-opus-5-5) · working · 3 calls, 4 tool uses · $0.42");
  });
});
