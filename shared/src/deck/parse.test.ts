import { describe, expect, it } from "vitest";
import { ARCHIDEKT, ARENA, HAND_TYPED, MOXFIELD, MTGGOLDFISH, TAPPEDOUT } from "./fixtures.js";
import { parseCardLine, parseDecklist } from "./parse.js";

const byName = (d: ReturnType<typeof parseDecklist>, name: string) => d.lines.find((l) => l.name === name);

describe("parseCardLine", () => {
  it("handles the common line shapes", () => {
    expect(parseCardLine("1 Sol Ring")).toMatchObject({ quantity: 1, name: "Sol Ring", set: null });
    expect(parseCardLine("1x Sol Ring")).toMatchObject({ quantity: 1, name: "Sol Ring" });
    expect(parseCardLine("4 Sol Ring (CMR) 123")).toMatchObject({ quantity: 4, set: "cmr", collectorNumber: "123" });
    expect(parseCardLine("1 Sol Ring (CMR) 123 *F*")).toMatchObject({ set: "cmr", collectorNumber: "123", foil: true });
    expect(parseCardLine("SB: 1 Sol Ring")).toMatchObject({ boardHint: "sideboard", name: "Sol Ring" });
    expect(parseCardLine("Sol Ring")).toMatchObject({ quantity: 1, name: "Sol Ring" });
    expect(parseCardLine("1 Sol Ring [Ramp]")).toMatchObject({ tags: ["Ramp"] });
    expect(parseCardLine("1 Sol Ring (cmr)")).toMatchObject({ set: "cmr", collectorNumber: null });
  });
  it("keeps commas and split names intact", () => {
    expect(parseCardLine("1 Atraxa, Praetors' Voice (CM2) 1")?.name).toBe("Atraxa, Praetors' Voice");
    expect(parseCardLine("1 Fire // Ice")?.name).toBe("Fire // Ice");
  });
  it("returns null for non-card lines", () => {
    expect(parseCardLine("")).toBeNull();
    expect(parseCardLine("Total: 100")).toBeNull();
  });
});

describe("parseDecklist per site", () => {
  it("Archidekt: tags, foil, commander category, set + number, maybeboard tag", () => {
    const d = parseDecklist(ARCHIDEKT);
    expect(d.hasExplicitCommander).toBe(true);
    expect(byName(d, "Atraxa, Praetors' Voice")).toMatchObject({ board: "commander", set: "cm2", collectorNumber: "1", tags: [] });
    expect(byName(d, "Sol Ring")).toMatchObject({ foil: true, tags: ["Ramp", "Artifacts"], set: "cmm", collectorNumber: "410" });
    expect(byName(d, "Swords to Plowshares")).toMatchObject({ tags: ["Removal"] });
    expect(byName(d, "Forest")?.quantity).toBe(3);
    expect(byName(d, "Lightning Bolt")?.tags).toEqual(["Maybeboard"]);
    expect(d.lines).toHaveLength(8);
  });

  it("Moxfield: commander in its own first block, SIDEBOARD header", () => {
    const d = parseDecklist(MOXFIELD);
    expect(d.hasExplicitCommander).toBe(false);
    const atraxa = byName(d, "Atraxa, Praetors' Voice")!;
    expect(atraxa.group).toBe(0);
    expect(byName(d, "Sol Ring")).toMatchObject({ group: 1, foil: true, set: "cmm" });
    expect(byName(d, "Lightning Bolt")?.board).toBe("sideboard");
    expect(d.lines.filter((l) => l.board === "main")).toHaveLength(7);
  });

  it("MTGGoldfish: bare names, blank-line groups", () => {
    const d = parseDecklist(MTGGOLDFISH);
    expect(d.lines.every((l) => l.set === null)).toBe(true);
    expect(byName(d, "Atraxa, Praetors' Voice")?.group).toBe(0);
    expect(byName(d, "Sol Ring")?.group).toBe(1);
    expect(byName(d, "Lightning Bolt")?.group).toBe(2);
  });

  it("TappedOut: *CMDR*, SB: prefix, single-slash split names, set without number", () => {
    const d = parseDecklist(TAPPEDOUT);
    expect(d.hasExplicitCommander).toBe(true);
    expect(byName(d, "Atraxa, Praetors' Voice")?.board).toBe("commander");
    expect(byName(d, "Sol Ring")).toMatchObject({ set: "cmm", collectorNumber: null, foil: true });
    expect(byName(d, "Fire / Ice")).toBeDefined();
    expect(byName(d, "Lightning Bolt")?.board).toBe("sideboard");
  });

  it("Arena: About/Name block, Commander/Deck/Sideboard headers", () => {
    const d = parseDecklist(ARENA);
    expect(d.name).toBe("Atraxa Counters");
    expect(d.hasExplicitCommander).toBe(true);
    expect(byName(d, "Atraxa, Praetors' Voice")?.board).toBe("commander");
    expect(byName(d, "Sol Ring")?.board).toBe("main");
    expect(byName(d, "Lightning Bolt")?.board).toBe("sideboard");
    expect(d.ignored.filter((i) => i.reason === "header").length).toBeGreaterThanOrEqual(4);
  });

  it("hand-typed: comments, 'Commander:' header, 'x1' suffix", () => {
    const d = parseDecklist(HAND_TYPED);
    expect(byName(d, "Atraxa, Praetors' Voice")?.board).toBe("commander");
    expect(byName(d, "Sol Ring")).toMatchObject({ quantity: 1, board: "main" });
    expect(byName(d, "Forest")?.quantity).toBe(2);
    expect(d.ignored.filter((i) => i.reason === "comment")).toHaveLength(2);
  });
});
