import type { Color } from "./cards.js";

/**
 * We draw mana symbols as plain coloured dots (no Wizards artwork).
 * This parser turns "{2}{U}{B/R}{X}" into a list of dot descriptions.
 */
export type DotColor = Color | "C";

export interface ManaDot {
  /** Raw symbol text without braces, e.g. "U", "2", "B/R", "W/P". */
  symbol: string;
  /** One colour for a plain dot, two for a hybrid split dot, none for generic. */
  colors: DotColor[];
  /** Text drawn in the centre: a number, "X", "C", "S", "T", "P" or "". */
  label: string;
  /** Phyrexian symbols get a small marker. */
  phyrexian: boolean;
  kind:
    | "colored"
    | "hybrid"
    | "generic"
    | "colorless"
    | "variable"
    | "snow"
    | "tap"
    | "untap"
    | "energy"
    | "other";
}

const COLOR_SET = new Set(["W", "U", "B", "R", "G"]);

export function parseManaSymbol(raw: string): ManaDot {
  const symbol = raw.replace(/[{}]/g, "").toUpperCase();
  const parts = symbol.split("/");
  const phyrexian = parts.includes("P");
  const colors = parts.filter((p): p is Color => COLOR_SET.has(p));
  if (/^\d+$/.test(symbol)) return { symbol, colors: [], label: symbol, phyrexian: false, kind: "generic" };
  if (symbol === "X" || symbol === "Y" || symbol === "Z") {
    return { symbol, colors: [], label: symbol, phyrexian: false, kind: "variable" };
  }
  if (symbol === "C") return { symbol, colors: ["C"], label: "C", phyrexian: false, kind: "colorless" };
  if (symbol === "S") return { symbol, colors: [], label: "S", phyrexian: false, kind: "snow" };
  if (symbol === "T") return { symbol, colors: [], label: "T", phyrexian: false, kind: "tap" };
  if (symbol === "Q") return { symbol, colors: [], label: "Q", phyrexian: false, kind: "untap" };
  if (symbol === "E") return { symbol, colors: [], label: "E", phyrexian: false, kind: "energy" };
  if (colors.length >= 2) return { symbol, colors, label: "", phyrexian, kind: "hybrid" };
  if (colors.length === 1) {
    // "2/W" style hybrid: generic-or-colour. Show the number on the colour dot.
    const generic = parts.find((p) => /^\d+$/.test(p));
    return {
      symbol,
      colors,
      label: generic ?? (phyrexian ? "P" : ""),
      phyrexian,
      kind: generic ? "hybrid" : "colored",
    };
  }
  return { symbol, colors: [], label: symbol.slice(0, 2), phyrexian: false, kind: "other" };
}

/** Parse a full cost string such as "{1}{G}{G}". Unknown text is ignored. */
export function parseManaCost(cost: string | null | undefined): ManaDot[] {
  if (!cost) return [];
  const out: ManaDot[] = [];
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) out.push(parseManaSymbol(m[1] ?? ""));
  return out;
}

export type OracleSegment = { type: "text"; text: string } | { type: "symbol"; dot: ManaDot };

/** Split oracle text into text runs and inline symbols so the client can draw dots inline. */
export function parseOracleText(text: string | null | undefined): OracleSegment[] {
  if (!text) return [];
  const out: OracleSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{([^}]+)\}/g)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: "text", text: text.slice(last, idx) });
    out.push({ type: "symbol", dot: parseManaSymbol(m[1] ?? "") });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
