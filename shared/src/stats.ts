/**
 * Deck statistics (Phase 9): the numbers the usual deck sites show, computed by
 * `server/src/analysis/stats.ts` from card data alone (no model, no network).
 * Shared so the client draws exactly what the server counted.
 *
 * "Exact" statistics are counts over card data (mana values, pips, types, lands,
 * P/T). "Heuristic" statistics read Oracle text with regular expressions
 * (mana sources, ramp, draw, removal, ...) and can miss unusual wordings; every
 * heuristic result lists the card names it matched so the reader can check.
 */

export type WubrgColor = "W" | "U" | "B" | "R" | "G";
export type PipColor = WubrgColor | "C";

export const WUBRG: readonly WubrgColor[] = ["W", "U", "B", "R", "G"];
export const PIP_COLORS: readonly PipColor[] = ["W", "U", "B", "R", "G", "C"];

export const PIP_COLOR_NAMES: Record<PipColor, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colourless",
};

/** One bar of the mana curve. `value` 7 means "7 or more". */
export interface CurveBucket {
  value: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Nonland cards at this mana value (X counts as 0). */
  nonland: number;
  /** Lands at this mana value (always bucket 0 in practice, kept general). */
  lands: number;
}

export interface ManaValueTotals {
  /** Sum of mana value over every card, X = 0, lands = 0. */
  total: number;
  /** Sum over nonland cards only. */
  nonlandTotal: number;
  nonlandCount: number;
  landCount: number;
  cardCount: number;
  /** Mean mana value of nonland cards, two decimals; 0 when there are none. */
  averageNonland: number;
  /** Mean over every card including lands, two decimals. */
  averageAll: number;
}

export interface PipCounts {
  /** Coloured pips per colour. Hybrid symbols add 0.5 to each of their colours, so halves appear. */
  colored: Record<PipColor, number>;
  /** Sum of the five colours plus {C}. */
  coloredTotal: number;
  /** Generic mana (numbers); X counts as 0. */
  generic: number;
  /** How many hybrid symbols were split in half. */
  hybridSymbols: number;
  /** How many Phyrexian symbols were counted for their colour. */
  phyrexianSymbols: number;
  /** Cards with {X} in their cost. */
  xSpells: number;
  xSpellNames: string[];
}

export type SourceKind = "land" | "rock" | "dork" | "other";

export interface ManaSourceCard {
  name: string;
  quantity: number;
  kind: SourceKind;
  /** Colours this card can produce; `["any"]` for "one mana of any color" style producers. */
  produces: Array<PipColor | "any">;
}

export interface ColorSourceRow {
  color: PipColor;
  pips: number;
  /** Cards that can make this colour: fixed producers plus "any colour" producers when the colour is in the deck's identity. */
  sources: number;
  byKind: Record<SourceKind, number>;
  /** sources / pips, null when there are no pips. */
  ratio: number | null;
  /** Share of all coloured pips that are this colour (0..1). */
  pipShare: number;
  /** Share of all colour-producing source slots that make this colour (0..1). */
  sourceShare: number;
  /** Plain-language reading of the row. */
  note: string;
}

export interface ManaProduction {
  rows: ColorSourceRow[];
  /** Colours the deck plays, in WUBRG order: the commander's colour identity, else the colours of its nonland cards. */
  identity: WubrgColor[];
  /** Number of "any colour" producers (Command Tower, Arcane Signet, basic-fetching lands). */
  anyColorSources: number;
  totalSources: number;
  byKind: Record<SourceKind, number>;
  cards: ManaSourceCard[];
  /** One or two sentences about the whole mana base. */
  summary: string;
  /** Where the rule of thumb comes from; shown as a guideline, never a rule. */
  guideline: { text: string; author: string; title: string; url: string };
}

export type CardTypeKey = "creature" | "instant" | "sorcery" | "artifact" | "enchantment" | "planeswalker" | "battle" | "land";

export const CARD_TYPE_KEYS: readonly CardTypeKey[] = ["creature", "instant", "sorcery", "artifact", "enchantment", "planeswalker", "battle", "land"];

export const CARD_TYPE_LABELS: Record<CardTypeKey, string> = {
  creature: "Creatures",
  instant: "Instants",
  sorcery: "Sorceries",
  artifact: "Artifacts",
  enchantment: "Enchantments",
  planeswalker: "Planeswalkers",
  battle: "Battles",
  land: "Lands",
};

export interface Breakdowns {
  /** A card with two types (Artifact Creature) counts once in each. Front face only. */
  types: Record<CardTypeKey, number>;
  /** Nonland cards per colour; a multicolour card counts once in each of its colours. */
  colors: Record<WubrgColor, number>;
  multicolor: number;
  colorless: number;
  lands: { total: number; basic: number; nonbasic: number };
  creatures: {
    count: number;
    /** Mean printed power/toughness over creatures with numeric P/T, two decimals; null when none. */
    averagePower: number | null;
    averageToughness: number | null;
    /** Creatures whose P/T is not a plain number ("*", "1+*"), left out of the averages. */
    nonNumeric: number;
  };
  xSpells: number;
  tokenMakers: { count: number; names: string[] };
}

export type FunctionalKey = "ramp" | "draw" | "removal" | "wipes" | "counterspells" | "tutors" | "recursion" | "protection";

export const FUNCTIONAL_KEYS: readonly FunctionalKey[] = ["ramp", "draw", "removal", "wipes", "counterspells", "tutors", "recursion", "protection"];

export const FUNCTIONAL_LABELS: Record<FunctionalKey, string> = {
  ramp: "Ramp",
  draw: "Card draw / advantage",
  removal: "Targeted removal",
  wipes: "Board wipes",
  counterspells: "Counterspells",
  tutors: "Tutors",
  recursion: "Recursion",
  protection: "Protection",
};

export interface FunctionalCount {
  key: FunctionalKey;
  count: number;
  /** Matched card names (one entry per name, with its quantity). */
  cards: Array<{ name: string; quantity: number }>;
}

export interface DeckStats {
  curve: CurveBucket[];
  manaValue: ManaValueTotals;
  pips: PipCounts;
  production: ManaProduction;
  breakdowns: Breakdowns;
  functional: FunctionalCount[];
  /** Commanders are counted with the main deck everywhere. */
  commanders: string[];
  computedAt: string;
}

export interface DeckStatsResponse {
  stats: DeckStats;
  /** True when the answer came from the in-memory cache for this deck version. */
  cached: boolean;
}
