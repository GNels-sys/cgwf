/**
 * Which printing of a card is "regular"? Scryfall lists every printing of a card: the plain one from
 * its set, but also borderless, showcase and extended-art versions, surge and galaxy foils, Secret
 * Lair drops, The List reprints, full-art basics, promos. When a decklist names a card without a set,
 * players expect the plain one, so the name index picks the newest REGULAR printing and falls back
 * to anything else only when a card has no regular printing at all.
 *
 * The same function labels printings in the printing picker ("Borderless", "Showcase", ...).
 */

import type { CardSummary } from "./cards.js";

/** One printing in the printing picker (GET /api/cards/oracle/:oracleId/printings). */
export interface PrintingOption extends CardSummary {
  setName: string;
  releasedAt: string;
  rarity: string;
  /** Special-treatment labels ("Borderless", "Showcase", ...); empty for a regular printing. */
  treatments: string[];
  isRegular: boolean;
  finishes: string[];
}

export interface PrintingsResponse {
  printings: PrintingOption[];
  /** The printing an unqualified card name resolves to (newest regular). */
  defaultId: string | null;
}

/** The Scryfall fields that describe how a printing looks (stored per row in `cards`). */
export interface PrintingTraits {
  set: string;
  setType: string;
  /** Scryfall `frame`: "1993" | "1997" | "2003" | "2015" | "future". */
  frame: string;
  frameEffects: string[];
  /** "black" | "white" | "borderless" | "silver" | "gold" | "yellow". */
  borderColor: string;
  fullArt: boolean;
  textless: boolean;
  promo: boolean;
  promoTypes: string[];
  /** "nonfoil" | "foil" | "etched". */
  finishes: string[];
  oversized: boolean;
  releasedAt: string;
}

/** Sets whose cards are reprints with a set symbol of their own (The List, Mystery Booster). */
const LIST_SETS = new Set(["plst", "mb1", "mb2", "ulst"]);

/** Set types that are never a card's regular printing. */
const SPECIAL_SET_TYPES: Record<string, string> = {
  box: "Secret Lair",
  masterpiece: "Masterpiece",
  from_the_vault: "From the Vault",
  memorabilia: "Memorabilia",
  funny: "Un-set",
  minigame: "Minigame",
  vanguard: "Vanguard",
  treasure_chest: "Treasure chest",
  alchemy: "Alchemy",
  promo: "Promo",
};

const FRAME_EFFECT_LABELS: Record<string, string> = {
  showcase: "Showcase",
  extendedart: "Extended art",
  inverted: "Inverted frame",
  etched: "Etched",
  shatteredglass: "Shattered glass",
  colorshifted: "Colorshifted",
  textless: "Textless",
  fullart: "Full art",
};

/** Promo types that mark a special treatment (foil treatments, Booster Fun, serialised, ...). */
const PROMO_TYPE_LABELS: Record<string, string> = {
  boosterfun: "Booster Fun",
  surgefoil: "Surge foil",
  galaxyfoil: "Galaxy foil",
  textured: "Textured foil",
  thick: "Thick stock",
  serialized: "Serialized",
  embossed: "Embossed",
  gilded: "Gilded",
  oilslick: "Oil slick",
  neonink: "Neon ink",
  invisibleink: "Invisible ink",
  stepandcompleat: "Step-and-compleat",
  halofoil: "Halo foil",
  confettifoil: "Confetti foil",
  rainbowfoil: "Rainbow foil",
  doublerainbow: "Double rainbow",
  raisedfoil: "Raised foil",
  ripplefoil: "Ripple foil",
  fracturefoil: "Fracture foil",
  manafoil: "Mana foil",
  dragonscalefoil: "Dragonscale foil",
  singularityfoil: "Singularity foil",
  cosmicfoil: "Cosmic foil",
  firstplacefoil: "First-place foil",
  concept: "Concept art",
};

/**
 * Human labels for every special treatment of a printing, in a stable order. An empty list means
 * the printing is regular: normal frame, black (or white) border, not full art, not a promo, not a
 * special foil, not Secret Lair / The List, and available without foil.
 */
export function printingTreatments(p: PrintingTraits): string[] {
  const out: string[] = [];
  const add = (label: string) => {
    if (!out.includes(label)) out.push(label);
  };
  if (p.borderColor === "borderless") add("Borderless");
  else if (p.borderColor && p.borderColor !== "black" && p.borderColor !== "white") add(`${p.borderColor[0]!.toUpperCase()}${p.borderColor.slice(1)} border`);
  for (const e of p.frameEffects) {
    const label = FRAME_EFFECT_LABELS[e];
    if (label) add(label);
  }
  if (p.fullArt) add("Full art");
  if (p.textless) add("Textless");
  // An old frame on a card printed after 2003 is a deliberate "retro frame" treatment.
  if ((p.frame === "1993" || p.frame === "1997") && p.releasedAt >= "2004-01-01") add("Retro frame");
  if (p.frame === "future") add("Future frame");
  if (LIST_SETS.has(p.set)) add("The List");
  const setLabel = SPECIAL_SET_TYPES[p.setType];
  if (setLabel) add(setLabel);
  // A foil treatment (surge foil, galaxy foil, ...) only changes how the FOIL copies look. Scryfall tags
  // e.g. every Final Fantasy / Fallout precon card "surgefoil" although its non-foil copy is the plain
  // card, so foil treatments count only when the printing has no non-foil copy.
  const nonfoil = p.finishes.length === 0 || p.finishes.includes("nonfoil");
  for (const t of p.promoTypes) {
    const isFoilTreatment = t.endsWith("foil") || t === "textured";
    if (isFoilTreatment && nonfoil) continue;
    const label = PROMO_TYPE_LABELS[t] ?? (t.endsWith("foil") ? `${t.slice(0, -4)} foil` : null);
    if (label) add(label);
  }
  if (p.promo) add("Promo");
  if (p.finishes.length > 0 && !p.finishes.includes("nonfoil")) add(p.finishes.includes("etched") && !p.finishes.includes("foil") ? "Etched only" : "Foil only");
  if (p.oversized) add("Oversized");
  return out;
}

export function isRegularPrinting(p: PrintingTraits): boolean {
  return printingTreatments(p).length === 0;
}

/**
 * How special a printing is: 0 = regular, else the number of treatments. The name index prefers the
 * lowest rank, so a card with no regular printing (a foil-only precon face commander) falls back to its
 * least special printing rather than a borderless showcase one.
 */
export function treatmentRank(p: PrintingTraits): number {
  return printingTreatments(p).length;
}
