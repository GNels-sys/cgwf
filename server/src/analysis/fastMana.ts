import { normalizeName } from "@cgwf/shared";
import { expanded, isArtifact, isCreature, isInstantOrSorcery, isLand, text, type AnalysisCard } from "./cards.js";
import { expandedHits, findCardDraw, findInteraction, findRamp, hitCount } from "./functional.js";

/**
 * Fast mana: cards that produce more mana than they cost in the first turns.
 * A curated list catches the famous ones; heuristics catch 0-cost rocks,
 * rituals and "exile from hand" spirit guides. Signets, Talismans and Arcane
 * Signet are ordinary ramp and are left out on purpose.
 */
const NAMES = [
  "Sol Ring",
  "Mana Crypt",
  "Mana Vault",
  "Grim Monolith",
  "Basalt Monolith",
  "Chrome Mox",
  "Mox Diamond",
  "Mox Opal",
  "Mox Amber",
  "Mox Tantalite",
  "Lotus Petal",
  "Jeweled Lotus",
  "Lion's Eye Diamond",
  "Ancient Tomb",
  "City of Traitors",
  "Gaea's Cradle",
  "Mishra's Workshop",
  "Serra's Sanctum",
  "Dark Ritual",
  "Cabal Ritual",
  "Culling the Weak",
  "Rite of Flame",
  "Seething Song",
  "Pyretic Ritual",
  "Desperate Ritual",
  "Jeska's Will",
  "Mana Geyser",
  "Simian Spirit Guide",
  "Elvish Spirit Guide",
  "Carpet of Flowers",
  "Dockside Extortionist",
  "Treasonous Ogre",
].map(normalizeName);

const NAME_SET = new Set(NAMES);
const RITUAL = /\badd (?:\{[wubrgc]\}){3,}/;
const RITUAL_X = /\badd (?:an amount of|x) (?:\{[wubrgc]\}|mana)/;
const SPIRIT_GUIDE = /\bexile ~ from your hand: add \{[wubrgc]\}/;

export function detectFastMana(cards: AnalysisCard[]): string[] {
  const out: string[] = [];
  for (const c of expanded(cards)) {
    const norm = normalizeName(c.name);
    const t = text(c);
    let hit = NAME_SET.has(norm);
    if (!hit && c.cmc === 0 && isArtifact(c) && !isLand(c) && /\badd \{/.test(t)) hit = true;
    if (!hit && isInstantOrSorcery(c) && c.cmc <= 2 && (RITUAL.test(t) || RITUAL_X.test(t))) hit = true;
    if (!hit && isCreature(c) && SPIRIT_GUIDE.test(t)) hit = true;
    if (hit) out.push(c.name);
  }
  return out;
}

/** Cheap rocks and dorks plus land ramp: ordinary ramp, counted for the stats line (see functional.ts). */
export function countRamp(cards: AnalysisCard[]): number {
  return hitCount(expandedHits(cards, findRamp));
}

/** Removal + counterspells (functional.ts), counted with duplicates. */
export function countInteraction(cards: AnalysisCard[]): number {
  return hitCount(expandedHits(cards, findInteraction));
}

export function countCardDraw(cards: AnalysisCard[]): number {
  return hitCount(expandedHits(cards, findCardDraw));
}

/** Free interaction (pitch / "if you control a commander" spells): a strong Bracket 4 tell. */
const FREE_INTERACTION = [
  "Force of Will",
  "Force of Negation",
  "Fierce Guardianship",
  "Deflecting Swat",
  "Deadly Rollick",
  "Flawless Maneuver",
  "Obscuring Haze",
  "Pact of Negation",
  "Slaughter Pact",
  "Daze",
  "Foil",
  "Snapback",
  "Commandeer",
  "Misdirection",
  "Mental Misstep",
  "Gush",
  "Snuff Out",
  "Mindbreak Trap",
  "Dismember",
  "Solitude",
  "Subtlety",
  "Endurance",
  "Fury",
  "Grief",
].map(normalizeName);
const FREE_SET = new Set(FREE_INTERACTION);

export function detectFreeInteraction(cards: AnalysisCard[]): string[] {
  const out: string[] = [];
  for (const c of expanded(cards)) {
    const t = text(c);
    if (
      FREE_SET.has(normalizeName(c.name)) ||
      /\bif you control a commander, you may cast (?:~|this spell) without paying its mana cost\b/.test(t) ||
      /\byou may (?:pay \d+ life|exile a (?:blue|black|red|green|white) card from your hand) rather than pay (?:~'s|this spell's) mana cost\b/.test(t)
    ) {
      out.push(c.name);
    }
  }
  return out;
}
