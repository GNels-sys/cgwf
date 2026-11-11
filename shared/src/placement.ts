import type { Bracket } from "./analysis.js";
import type { CardSummary } from "./cards.js";
import type { DoctorRole, DoctorSwap } from "./doctor.js";

/**
 * Card placement (owner only while it is tested, 2026-11-11): "I have these cards; which of my decks should
 * each one go into?" For every pasted card and every one of the player's own decks the server runs the Deck
 * Doctor's scoring (EDHREC synergy and inclusion for that deck's commander, the roles the deck is short of,
 * Commander Spellbook combos the card would complete, the bracket check) and pairs it with the deck's best
 * cut. Each card's decks come back best first; "Add to this deck" is the Doctor's own apply route. No model
 * spend. Server: server/src/analysis/doctor/placement.ts, route POST /api/placement.
 */

export const PLACEMENT_MAX_CARDS = 40;
export const PLACEMENT_MAX_DECKS = 30;

export interface PlacementRequest {
  /** One card per line, any decklist format ("1 Sol Ring", "Sol Ring (C21) 263", "Sol Ring"). */
  text: string;
  /** Only these decks (own deck ids); every own deck when absent or empty. */
  deckIds?: string[] | undefined;
}

/** How well the card fits that deck: strong / good from the add's own score, weak when it barely beats its cut. */
export type PlacementFit = "strong" | "good" | "weak";

export interface PlacementOption {
  deckId: string;
  deckName: string;
  commanders: string[];
  fit: PlacementFit;
  /** The Doctor's gain: what the card adds minus what its cut gives up (can be zero or below). */
  score: number;
  /** The card's own value in this deck (60 x inclusion + 100 x synergy + role gap + combos). */
  addScore: number;
  synergy: number | null;
  inclusion: number | null;
  /** The role this placement is about (what the deck is short of, or what the card shares with its cut). */
  role: DoctorRole | null;
  roles: DoctorRole[];
  reason: string;
  combos: string[];
  cut: DoctorSwap["cut"];
  bracket: DoctorSwap["bracket"];
  targetBracket: Bracket;
}

export interface PlacementSkip {
  deckId: string;
  deckName: string;
  reason: string;
}

export interface PlacementCardResult {
  /** The line as typed. */
  line: string;
  status: "ok" | "unresolved" | "not_legal";
  note: string | null;
  card: CardSummary | null;
  oracleId: string | null;
  /** Best first: decks where it would not raise the bracket floor, then by score. */
  options: PlacementOption[];
  /** Decks it cannot go into, and why (outside the colours, already there, ...). */
  skipped: PlacementSkip[];
}

export interface PlacementDeckInfo {
  deckId: string;
  name: string;
  commanders: string[];
  targetBracket: Bracket | null;
  edhrec: "ok" | "missing" | "unavailable";
  message: string | null;
}

export interface PlacementResponse {
  cards: PlacementCardResult[];
  decks: PlacementDeckInfo[];
  limits: { maxCards: number; maxDecks: number; truncatedCards: boolean; truncatedDecks: boolean };
}

/** Fit label from the add's own score and the gain over its cut. */
export function placementFit(addScore: number, gain: number): PlacementFit {
  if (gain <= 0) return "weak";
  if (addScore >= 45) return "strong";
  if (addScore >= 15) return "good";
  return "weak";
}

/** Best home first: no bracket raise before a raise, then the bigger gain, then the stronger card. */
export function rankPlacements(options: PlacementOption[]): PlacementOption[] {
  return [...options].sort(
    (a, b) => Number(a.bracket.raises) - Number(b.bracket.raises) || b.score - a.score || b.addScore - a.addScore || a.deckName.localeCompare(b.deckName),
  );
}

export const PLACEMENT_FIT_LABELS: Record<PlacementFit, string> = {
  strong: "Strong fit",
  good: "Good fit",
  weak: "Weak fit",
};
