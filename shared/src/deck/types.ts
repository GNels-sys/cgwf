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
  sourceUrl: string | null;
  createdAt: string;
}

export const COMMANDER_DECK_SIZE = 100;
