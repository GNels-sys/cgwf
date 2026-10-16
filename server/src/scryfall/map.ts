import {
  CARD_LAYOUTS,
  hasBackFace,
  normalizeName,
  type CardFace,
  type CardLayout,
  type CardPrinting,
  type CardSummary,
  type Color,
} from "@cgwf/shared";
import type { CardRow, NewCardRow } from "../db/schema.js";

/** The slice of a Scryfall card object we read. Everything optional on purpose. */
export interface ScryfallCard {
  object?: string;
  id: string;
  oracle_id?: string;
  name: string;
  lang?: string;
  released_at?: string;
  set: string;
  set_name?: string;
  set_type?: string;
  collector_number: string;
  rarity?: string;
  layout?: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  legalities?: Record<string, string>;
  image_uris?: Record<string, string>;
  image_status?: string;
  card_faces?: ScryfallFace[];
  artist?: string;
  promo?: boolean;
  digital?: boolean;
  booster?: boolean;
  scryfall_uri?: string;
}

export interface ScryfallFace {
  object?: string;
  name: string;
  oracle_id?: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  colors?: string[];
  artist?: string;
  image_uris?: Record<string, string>;
}

const LAYOUT_SET = new Set<string>(CARD_LAYOUTS);
const COLOR_SET = new Set(["W", "U", "B", "R", "G"]);

function toLayout(raw: string | undefined): CardLayout {
  return raw && LAYOUT_SET.has(raw) ? (raw as CardLayout) : "normal";
}

function toColors(raw: string[] | undefined): Color[] {
  return (raw ?? []).filter((c): c is Color => COLOR_SET.has(c));
}

function pickImages(uris: Record<string, string> | undefined): Record<string, string> | null {
  if (!uris) return null;
  const out: Record<string, string> = {};
  for (const k of ["small", "normal", "large"]) if (uris[k]) out[k] = uris[k] as string;
  return Object.keys(out).length ? out : null;
}

/** Should this Scryfall object be stored at all? English, real card objects only. */
export function shouldKeep(card: ScryfallCard): boolean {
  if (card.object && card.object !== "card") return false;
  if ((card.lang ?? "en") !== "en") return false;
  const layout = card.layout ?? "normal";
  if (layout === "art_series") return false;
  if (card.set_type === "memorabilia" && layout !== "token") return false;
  return true;
}

export function isTokenCard(card: ScryfallCard): boolean {
  const layout = card.layout ?? "normal";
  if (layout === "token" || layout === "double_faced_token" || layout === "emblem") return true;
  if (card.set_type === "token") return true;
  return (card.type_line ?? "").startsWith("Token");
}

/** Convert a raw Scryfall card into a database row. Pure, so it is unit-tested. */
export function toCardRow(card: ScryfallCard, seenRun: number): NewCardRow {
  const layout = toLayout(card.layout);
  const twoFaced = hasBackFace(layout);
  const rawFaces = card.card_faces ?? [];

  const faces: CardFace[] = rawFaces.map((f, i) => ({
    name: f.name,
    manaCost: f.mana_cost ?? "",
    typeLine: f.type_line ?? "",
    oracleText: f.oracle_text ?? "",
    power: f.power ?? null,
    toughness: f.toughness ?? null,
    loyalty: f.loyalty ?? null,
    defense: f.defense ?? null,
    colors: toColors(f.colors ?? (i === 0 ? card.colors : undefined)),
    artist: f.artist ?? card.artist ?? null,
    hasOwnImage: Boolean(f.image_uris),
  }));

  // Single-image multi-part cards (split, flip, adventure) put the image on the card.
  const frontUris = card.image_uris ?? rawFaces[0]?.image_uris;
  const backUris = twoFaced ? rawFaces[1]?.image_uris : undefined;

  // Whole-card mana cost: Scryfall leaves it empty for two-faced cards, so join faces.
  const manaCost =
    card.mana_cost && card.mana_cost.length > 0
      ? card.mana_cost
      : faces
          .map((f) => f.manaCost)
          .filter((c) => c.length > 0)
          .join(" // ");
  const typeLine = card.type_line ?? faces.map((f) => f.typeLine).join(" // ");
  const oracleText = card.oracle_text ?? faces.map((f) => f.oracleText).join("\n//\n");
  const oracleId = card.oracle_id ?? rawFaces.find((f) => f.oracle_id)?.oracle_id ?? null;

  return {
    id: card.id,
    oracleId,
    name: card.name,
    normalizedName: normalizeName(card.name),
    set: card.set,
    setName: card.set_name ?? card.set.toUpperCase(),
    collectorNumber: card.collector_number,
    releasedAt: card.released_at ?? "1993-08-05",
    rarity: card.rarity ?? "common",
    layout,
    manaCost,
    cmc: card.cmc ?? 0,
    typeLine,
    oracleText,
    power: card.power ?? faces[0]?.power ?? null,
    toughness: card.toughness ?? faces[0]?.toughness ?? null,
    loyalty: card.loyalty ?? faces[0]?.loyalty ?? null,
    defense: card.defense ?? faces[0]?.defense ?? null,
    colors: toColors(card.colors ?? faces[0]?.colors),
    colorIdentity: toColors(card.color_identity),
    keywords: card.keywords ?? [],
    legalities: card.legalities ?? {},
    faces,
    imageFront: pickImages(frontUris),
    imageBack: pickImages(backUris),
    imageStatus: card.image_status ?? "",
    isToken: isTokenCard(card),
    isPromo: Boolean(card.promo),
    isDigital: Boolean(card.digital),
    inBooster: Boolean(card.booster),
    artist: card.artist ?? faces[0]?.artist ?? null,
    scryfallUri: card.scryfall_uri ?? "",
    seenRun,
  };
}

/** Database row -> the API shape the client consumes. */
export function rowToPrinting(row: CardRow): CardPrinting {
  return {
    id: row.id,
    oracleId: row.oracleId,
    name: row.name,
    set: row.set,
    setName: row.setName,
    collectorNumber: row.collectorNumber,
    releasedAt: row.releasedAt,
    rarity: row.rarity,
    layout: toLayout(row.layout),
    manaCost: row.manaCost,
    cmc: row.cmc,
    typeLine: row.typeLine,
    oracleText: row.oracleText,
    power: row.power,
    toughness: row.toughness,
    loyalty: row.loyalty,
    defense: row.defense,
    colors: toColors(row.colors),
    colorIdentity: toColors(row.colorIdentity),
    keywords: row.keywords,
    legalities: row.legalities,
    faces: row.faces as CardFace[],
    isToken: row.isToken,
    isPromo: row.isPromo,
    isDigital: row.isDigital,
    artist: row.artist,
    scryfallUri: row.scryfallUri,
  };
}

export function rowToSummary(row: CardRow): CardSummary {
  return {
    id: row.id,
    oracleId: row.oracleId,
    name: row.name,
    set: row.set,
    collectorNumber: row.collectorNumber,
    manaCost: row.manaCost,
    typeLine: row.typeLine,
    layout: toLayout(row.layout),
    isToken: row.isToken,
    faceCount: row.imageBack ? 2 : 1,
  };
}
