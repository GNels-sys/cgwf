import { describe, expect, it } from "vitest";
import { parseManaCost, parseOracleText } from "./mana.js";
import { editDistance, normalizeName } from "./text.js";

describe("parseManaCost", () => {
  it("parses generic + coloured", () => {
    const dots = parseManaCost("{2}{U}{U}");
    expect(dots.map((d) => d.kind)).toEqual(["generic", "colored", "colored"]);
    expect(dots[0]?.label).toBe("2");
    expect(dots[1]?.colors).toEqual(["U"]);
  });
  it("parses hybrid, phyrexian, X and colourless", () => {
    const dots = parseManaCost("{B/R}{W/P}{X}{C}{2/G}");
    expect(dots[0]).toMatchObject({ kind: "hybrid", colors: ["B", "R"] });
    expect(dots[1]).toMatchObject({ kind: "colored", colors: ["W"], phyrexian: true, label: "P" });
    expect(dots[2]).toMatchObject({ kind: "variable", label: "X" });
    expect(dots[3]).toMatchObject({ kind: "colorless", colors: ["C"] });
    expect(dots[4]).toMatchObject({ kind: "hybrid", colors: ["G"], label: "2" });
  });
  it("handles empty and split costs", () => {
    expect(parseManaCost("")).toEqual([]);
    expect(parseManaCost(null)).toEqual([]);
    expect(parseManaCost("{1}{R} // {2}{U}").length).toBe(4);
  });
});

describe("parseOracleText", () => {
  it("interleaves text and symbols", () => {
    const segs = parseOracleText("{T}: Add {C}.");
    expect(segs).toHaveLength(4);
    expect(segs[0]).toMatchObject({ type: "symbol", dot: { kind: "tap" } });
    expect(segs[1]).toEqual({ type: "text", text: ": Add " });
  });
});

describe("normalizeName", () => {
  it("strips accents and punctuation", () => {
    expect(normalizeName("Lim-Dûl's Vault")).toBe("lim duls vault");
    expect(normalizeName("Æther Vial")).toBe("aether vial");
    expect(normalizeName("Fire // Ice")).toBe("fire // ice");
    expect(normalizeName("  Sol   Ring ")).toBe("sol ring");
  });
});

describe("editDistance", () => {
  it("counts transpositions as one", () => {
    expect(editDistance("sol ring", "sol rign")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abc", "xyz", 2)).toBe(3);
  });
});
