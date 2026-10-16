/**
 * Card data types shared by server and client. These mirror the Scryfall
 * fields we keep, so a future rules engine can read costs, types and keywords
 * straight off a card object in game state.
 */

/** Scryfall layouts we handle explicitly. Anything else falls into "normal". */
export const CARD_LAYOUTS = [
  "normal",
  "split",
  "flip",
  "transform",
  "modal_dfc",
  "meld",
  "leveler",
  "class",
  "case",
  "saga",
  "adventure",
  "mutate",
  "prototype",
  "battle",
  "planar",
  "scheme",
  "vanguard",
  "token",
  "double_faced_token",
  "emblem",
  "augment",
  "host",
  "reversible_card",
] as const;
export type CardLayout = (typeof CARD_LAYOUTS)[number];

/** Layouts where the card physically has two faces (a "back" image). */
export const TWO_FACED_LAYOUTS: ReadonlySet<CardLayout> = new Set<CardLayout>([
  "transform",
  "modal_dfc",
  "double_faced_token",
  "reversible_card",
]);

export type Color = "W" | "U" | "B" | "R" | "G";

export type ImageSize = "small" | "normal" | "large";
export const IMAGE_SIZES: readonly ImageSize[] = ["small", "normal", "large"];

/**
 * Scryfall's outbound purchase links for a printing (its `purchase_uris`).
 * CGwF only links out: it never sells anything itself.
 */
export interface PurchaseLinks {
  tcgplayer: string | null;
  cardmarket: string | null;
  cardhoarder: string | null;
}

export interface CardFace {
  name: string;
  manaCost: string;
  typeLine: string;
  oracleText: string;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  defense: string | null;
  colors: Color[];
  artist: string | null;
  /** True when this face has its own image (two-faced layouts). */
  hasOwnImage: boolean;
}

export interface CardPrinting {
  /** Scryfall printing id (uuid). */
  id: string;
  /** Scryfall oracle id. Null only for odd reversible printings. */
  oracleId: string | null;
  name: string;
  set: string;
  setName: string;
  collectorNumber: string;
  releasedAt: string;
  rarity: string;
  layout: CardLayout;
  /** Whole-card mana cost (split cards: both halves joined with " // "). */
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  defense: string | null;
  colors: Color[];
  colorIdentity: Color[];
  keywords: string[];
  legalities: Record<string, string>;
  faces: CardFace[];
  isToken: boolean;
  isPromo: boolean;
  isDigital: boolean;
  artist: string | null;
  scryfallUri: string;
  /** Outbound store links from Scryfall; absent/null for printings without any. */
  purchaseUris?: PurchaseLinks | null;
}

/** Compact card shape the search page lists. */
export interface CardSummary {
  id: string;
  oracleId: string | null;
  name: string;
  set: string;
  collectorNumber: string;
  manaCost: string;
  typeLine: string;
  layout: CardLayout;
  isToken: boolean;
  /** Number of images: 1 or 2. */
  faceCount: number;
  /** Outbound store links from Scryfall; absent/null for printings without any. */
  purchaseUris?: PurchaseLinks | null;
}

export function hasBackFace(layout: CardLayout): boolean {
  return TWO_FACED_LAYOUTS.has(layout);
}

/** Path (served by our own server) for a cached card image. */
export function cardImagePath(id: string, size: ImageSize = "normal", face: 0 | 1 = 0): string {
  return face === 0 ? `/img/${size}/${id}.jpg` : `/img/${size}/${id}/back.jpg`;
}
