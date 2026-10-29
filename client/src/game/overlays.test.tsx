import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CardPrinting } from "@cgwf/shared";
import { GameLog, LinkedText, isStepLine, nameMatcher, printingAsCard } from "./Overlays";

function printing(id: string, name: string): CardPrinting {
  return { id, name } as unknown as CardPrinting;
}

const printings = {
  a: printing("a", "Lightning Strike"),
  b: printing("b", "Krenko, Mob Boss"),
  c: printing("c", "Fire // Ice"),
  d: printing("d", "Ice Age"),
};

describe("game log card names", () => {
  it("links every known name, longest first, and leaves the rest as text", () => {
    const m = nameMatcher(printings);
    const html = renderToStaticMarkup(<LinkedText text="Blair cast Lightning Strike targeting Krenko, Mob Boss" matcher={m} onCard={() => {}} />);
    expect(html).toContain('aria-label="Lightning Strike, read the card"');
    expect(html).toContain('aria-label="Krenko, Mob Boss, read the card"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("Blair cast Lightning Strike targeting Krenko, Mob Boss");
  });

  it("matches split-card faces and never half a word", () => {
    const m = nameMatcher(printings);
    expect(m.byName.get("fire")?.id).toBe("c");
    expect(m.byName.get("ice")?.id).toBe("c");
    const html = renderToStaticMarkup(<LinkedText text="Georgie's Icebreaker melted" matcher={m} onCard={() => {}} />);
    expect(html).not.toContain("log-card");
    const age = renderToStaticMarkup(<LinkedText text="Ice Age resolved" matcher={m} onCard={() => {}} />);
    expect(age).toContain('aria-label="Ice Age, read the card"');
    expect(age).not.toContain('aria-label="Ice, read the card"');
  });

  it("is a no-op without printings", () => {
    const m = nameMatcher({});
    expect(m.regex).toBeNull();
    expect(renderToStaticMarkup(<LinkedText text="plain" matcher={m} onCard={() => {}} />)).toBe("plain");
  });

  it("tells step and turn lines from actions (toasts and the latest action skip them)", () => {
    expect(isStepLine("Blair's End step")).toBe(true);
    expect(isStepLine("Georgie's Main phase, precombat")).toBe(true);
    expect(isStepLine("Blair's Declare Attackers Step")).toBe(true);
    expect(isStepLine("Chris' Upkeep step")).toBe(true); // Forge's possessive for a name ending in s
    expect(isStepLine("Turn 3 (Blair)")).toBe(true);
    expect(isStepLine("Blair played Mountain")).toBe(false);
    expect(isStepLine("Blair cast Krenko, Mob Boss")).toBe(false);
    expect(isStepLine("Blair's Sol Ring phased out")).toBe(false);
    expect(isStepLine("Life: Georgie 40 > 37")).toBe(false);
  });

  it("the Game Log hides step announcements by default and keeps turns and events (owner, 2026-10-29)", () => {
    const log = [
      { seq: 1, actor: "system", text: "Turn 3 (Blair)", ts: 0, kind: "turn" as const },
      { seq: 2, actor: "system", text: "Blair's Untap step", ts: 0, kind: "step" as const },
      { seq: 3, actor: "system", text: "Blair's Upkeep step", ts: 0, kind: "step" as const },
      { seq: 4, actor: "system", text: "Blair played Mountain", ts: 0, kind: "event" as const },
      { seq: 5, actor: "system", text: "Kuan's Draw step", ts: 0 }, // an older line without a kind: by wording
    ];
    const html = renderToStaticMarkup(<GameLog log={log} members={[]} printings={{}} onCard={() => {}} onMinimize={() => {}} />);
    expect(html).toContain("Turn 3 (Blair)");
    expect(html).toContain("Blair played Mountain");
    expect(html).not.toContain("Untap step");
    expect(html).not.toContain("Upkeep step");
    expect(html).not.toContain("Draw step");
    expect(html).toContain("Show steps");
  });

  it("turns a printing into a public card the zoom can show", () => {
    const c = printingAsCard(printings.a, "u1");
    expect(c.printingId).toBe("a");
    expect(c.public).toBe(true);
    expect(c.iid.startsWith("printing:")).toBe(true);
  });
});
