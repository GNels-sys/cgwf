import type { CardSummary } from "../cards.js";
import type { Board, ParsedLine } from "./parse.js";

/** What the server says about each pasted line after matching it to card data. */
export type ResolveStatus = "resolved" | "ambiguous" | "unresolved";

export interface ResolvedLine {
  line: ParsedLine;
  status: ResolveStatus;
  /** The chosen printing (resolved, or the best guess for ambiguous lines). */
  card: CardSummary | null;
  /** Alternatives the user can pick from (ambiguous / unresolved). */
  candidates: CardSummary[];
  /** Human-readable note, e.g. "printing (CMR) 123 not found, using newest". */
  note: string | null;
  /** True when the server decided this line is a commander (explicit tag or heuristic). */
  commander: boolean;
}

export interface ResolveRequest {
  text: string;
}

export interface ResolveResponse {
  lines: ResolvedLine[];
  /** Deck name suggestion (from an Arena About block or the first commander). */
  suggestedName: string | null;
  counts: { resolved: number; ambiguous: number; unresolved: number };
}

export interface ImportUrlResponse {
  source: "archidekt";
  name: string;
  /** Decklist text in our own canonical shape, ready for /parse. */
  text: string;
  url: string;
}

export interface DeckCardInput {
  cardId: string;
  quantity: number;
  board: Board;
  category?: string | null;
}

export interface CreateDeckRequest {
  name: string;
  cards: DeckCardInput[];
  sourceText?: string | null;
  sourceUrl?: string | null;
}

export interface DeckCardEntry extends DeckCardInput {
  card: CardSummary;
  /** The deck line's id (deck_cards.id), for PATCH /api/decks/:id/cards/:entry. */
  entryId?: number;
}

/** PATCH /api/decks/:id/cards/:entry and PATCH /api/library/:id/cards/:entry: another printing of the same card. */
export interface SetPrintingRequest {
  cardId: string;
}

export interface DeckWarning {
  code: "size" | "singleton" | "color_identity" | "no_commander" | "too_many_commanders" | "format";
  message: string;
}

export interface DeckSummary {
  id: string;
  name: string;
  format: string;
  cardCount: number;
  commanders: CardSummary[];
  updatedAt: string;
}

export interface DeckDetail extends DeckSummary {
  cards: DeckCardEntry[];
  warnings: DeckWarning[];
  /** How many cards this deck may have, from its saved commander(s). Absent from servers before 2026-10-28. */
  sizeRule?: DeckSizeRule;
  sourceUrl: string | null;
  createdAt: string;
}

export const COMMANDER_DECK_SIZE = 100;

/** The boards that make up the 100: main deck and commander(s). A companion, sideboard and maybeboard sit outside. */
export const COUNTED_BOARDS: readonly Board[] = ["main", "commander"];

/** Cards that count toward the 100 (main + commander lines). */
export function countedCards(lines: Array<{ board: Board; quantity: number }>): number {
  return lines.filter((l) => COUNTED_BOARDS.includes(l.board)).reduce((n, l) => n + l.quantity, 0);
}

/**
 * How many cards (main + commanders) a deck may have. Normally exactly 100. A commander can lift the maximum
 * (owner, 2026-10-28): Whtz, the Bibliophile ("Rulebreaker — A deck with this commander has no maximum deck size.")
 * and The Covert Blue Mage ("your starting deck can contain any number of cards beyond the maximum deck size").
 * The minimum of 100 still applies. Forge reads the same cards' `DeckRule:Size:AdjustMax$ Unlimited`.
 */
export interface DeckSizeRule {
  min: number;
  /** null = no maximum. */
  max: number | null;
  /** The commander that lifts the maximum, null for the standard rule. */
  grantedBy: string | null;
}

export const STANDARD_DECK_SIZE: DeckSizeRule = { min: COMMANDER_DECK_SIZE, max: COMMANDER_DECK_SIZE, grantedBy: null };

/** Oracle wording of the commanders that lift the maximum deck size. */
export const NO_MAXIMUM_DECK_SIZE = /no maximum deck size|any number of cards beyond the maximum deck size/i;

/** The size rule for a deck with these commanders (read from their Oracle text, so a reprint or a new card with the same wording counts). */
export function deckSizeRule(commanders: Array<{ name: string; oracleText?: string | null }>): DeckSizeRule {
  const lifts = commanders.find((c) => NO_MAXIMUM_DECK_SIZE.test(c.oracleText ?? ""));
  return lifts ? { min: COMMANDER_DECK_SIZE, max: null, grantedBy: lifts.name } : STANDARD_DECK_SIZE;
}

/**
 * The deck editor's save check (owner request 2026-10-28): a Commander deck is exactly 100 cards including the
 * commander(s), or at least 100 when a commander lifts the maximum. Null when the count is fine, else the message
 * the player sees. Saving from the editor is refused with this message, on the page and by the server.
 */
export function deckSizeProblem(total: number, rule: DeckSizeRule = STANDARD_DECK_SIZE): string | null {
  const plural = (n: number) => `${n} card${n === 1 ? "" : "s"}`;
  if (total < rule.min) return `Your deck currently has ${total} cards. Please add ${plural(rule.min - total)} prior to saving.`;
  if (rule.max !== null && total > rule.max) return `Your deck currently has ${total} cards. Please remove ${plural(total - rule.max)} prior to saving.`;
  return null;
}
