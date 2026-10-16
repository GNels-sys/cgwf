import type { CardRow } from "../db/schema.js";

/**
 * The slice of a card the analysis engine reads. Built from `cards` rows (or
 * hand-written in tests) so every detector is a pure function over plain data.
 */
export interface AnalysisCard {
  name: string;
  typeLine: string;
  oracleText: string;
  manaCost: string;
  cmc: number;
  keywords: string[];
  colorIdentity: string[];
  quantity: number;
  board: "main" | "commander";
  /** Printed colours (Scryfall `colors`); empty for colourless cards and most lands. */
  colors: string[];
  /** Printed power/toughness of the front face ("3", "*", "1+*"), null for non-creatures. */
  power: string | null;
  toughness: string | null;
}

interface FaceLike {
  power?: string | null;
  toughness?: string | null;
}

export function fromRow(
  row: Pick<CardRow, "name" | "typeLine" | "oracleText" | "manaCost" | "cmc" | "keywords" | "colorIdentity"> & Partial<Pick<CardRow, "colors" | "power" | "toughness" | "faces">>,
  quantity: number,
  board: "main" | "commander",
): AnalysisCard {
  // Two-faced cards keep P/T on the faces; the front face is what the deck list casts.
  const front = (row.faces as FaceLike[] | undefined)?.[0];
  return {
    name: row.name,
    typeLine: row.typeLine,
    oracleText: row.oracleText,
    manaCost: row.manaCost,
    cmc: row.cmc,
    keywords: row.keywords ?? [],
    colorIdentity: row.colorIdentity ?? [],
    quantity,
    board,
    colors: row.colors ?? [],
    power: row.power ?? front?.power ?? null,
    toughness: row.toughness ?? front?.toughness ?? null,
  };
}

/**
 * Lower-cased oracle text with the card's own name replaced by "~" (so "Sol Ring"
 * rules read the same as any other) and reminder text "(...)" removed, so
 * Flusterstorm's "(copy it for each spell cast before it this turn)" does not
 * read as a storm payoff.
 */
export function text(card: AnalysisCard): string {
  const front = frontName(card);
  let t = card.oracleText.replace(/\([^()]*\)/g, " ");
  if (front) t = t.split(front).join("~");
  if (card.name !== front) t = t.split(card.name).join("~");
  return t.replace(/[ \t]+/g, " ").toLowerCase();
}

export function typeLine(card: AnalysisCard): string {
  return card.typeLine.toLowerCase();
}

/** "Delver of Secrets // Insectile Aberration" -> "Delver of Secrets". */
export function frontName(card: AnalysisCard): string {
  return card.name.split(" // ")[0]!.trim();
}

export function isLand(card: AnalysisCard): boolean {
  return /\bland\b/.test(typeLine(card).split(" // ")[0]!);
}
export function isCreature(card: AnalysisCard): boolean {
  return /\bcreature\b/.test(typeLine(card));
}
export function isArtifact(card: AnalysisCard): boolean {
  return /\bartifact\b/.test(typeLine(card));
}
export function isEnchantment(card: AnalysisCard): boolean {
  return /\benchantment\b/.test(typeLine(card));
}
export function isInstantOrSorcery(card: AnalysisCard): boolean {
  return /\b(instant|sorcery)\b/.test(typeLine(card));
}
export function hasKeyword(card: AnalysisCard, kw: string): boolean {
  const k = kw.toLowerCase();
  return card.keywords.some((x) => x.toLowerCase() === k);
}

/** Creature subtypes from "Legendary Creature — Elf Druid // ..." (both faces). */
export function creatureSubtypes(card: AnalysisCard): string[] {
  const out: string[] = [];
  for (const face of card.typeLine.split(" // ")) {
    if (!/\bCreature\b/.test(face)) continue;
    const dash = face.indexOf("—");
    if (dash < 0) continue;
    for (const s of face.slice(dash + 1).trim().split(/\s+/)) if (s) out.push(s);
  }
  return [...new Set(out)];
}

/** Expand quantities so counts ("3 tutors") treat duplicates honestly. */
export function expanded(cards: AnalysisCard[]): AnalysisCard[] {
  const out: AnalysisCard[] = [];
  for (const c of cards) for (let i = 0; i < Math.max(1, c.quantity); i++) out.push(c);
  return out;
}

export function uniqueNames(cards: AnalysisCard[]): string[] {
  return [...new Set(cards.map((c) => c.name))];
}
