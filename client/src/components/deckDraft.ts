import { countedCards, hasBackFace, type Board, type CardPrinting, type CardSummary, type DeckCardEntry, type DeckCardInput } from "@cgwf/shared";

/**
 * The deck editor's draft (owner request 2026-10-28): add cards from a search, take one copy off a line with "−",
 * undo the last change, and save the whole list in one go (PUT /api/decks/:id/cards, which refuses anything but
 * exactly 100 cards). Pure; the deck page keeps one DraftState while editing.
 */
export interface DraftLine {
  /** Stable React key for the line (an entry id, or a new key for added cards). */
  key: string;
  cardId: string;
  quantity: number;
  board: Board;
  category: string | null;
  card: CardSummary;
  /** The saved line it came from; undefined for a card added in this edit. */
  entryId?: number;
}

export interface DraftState {
  lines: DraftLine[];
  /** Earlier versions, newest last, each with what the change was ("Removed Sol Ring"). */
  history: Array<{ lines: DraftLine[]; label: string }>;
}

export const HISTORY_MAX = 50;

let added = 0;

export function startDraft(cards: DeckCardEntry[]): DraftState {
  return {
    lines: cards.map((c, i) => ({ key: c.entryId !== undefined ? `e${c.entryId}` : `s${i}`, cardId: c.cardId, quantity: c.quantity, board: c.board, category: c.category ?? null, card: c.card, ...(c.entryId !== undefined ? { entryId: c.entryId } : {}) })),
    history: [],
  };
}

function push(s: DraftState, lines: DraftLine[], label: string): DraftState {
  return { lines, history: [...s.history, { lines: s.lines, label }].slice(-HISTORY_MAX) };
}

/** Add one copy: onto the same printing's line on that board if there is one, else a new line. */
export function addCard(s: DraftState, card: CardSummary, board: Board = "main"): DraftState {
  const i = s.lines.findIndex((l) => l.cardId === card.id && l.board === board);
  const lines =
    i >= 0
      ? s.lines.map((l, j) => (j === i ? { ...l, quantity: l.quantity + 1 } : l))
      : [...s.lines, { key: `n${++added}-${card.id}`, cardId: card.id, quantity: 1, board, category: null, card }];
  return push(s, lines, `Added ${card.name}`);
}

/** The "−" button: one copy off the line; the line goes when its last copy does. */
export function removeOne(s: DraftState, key: string): DraftState {
  const line = s.lines.find((l) => l.key === key);
  if (!line) return s;
  const lines = line.quantity > 1 ? s.lines.map((l) => (l.key === key ? { ...l, quantity: l.quantity - 1 } : l)) : s.lines.filter((l) => l.key !== key);
  return push(s, lines, `Removed ${line.card.name}`);
}

/** Another printing of the same card on one line (the printing picker while editing). */
export function setLinePrinting(s: DraftState, key: string, card: CardSummary): DraftState {
  const line = s.lines.find((l) => l.key === key);
  if (!line || line.cardId === card.id) return s;
  return push(s, s.lines.map((l) => (l.key === key ? { ...l, cardId: card.id, card } : l)), `Changed the printing of ${card.name}`);
}

/** Back to the version before the last change. */
export function undo(s: DraftState): DraftState {
  const last = s.history[s.history.length - 1];
  return last ? { lines: last.lines, history: s.history.slice(0, -1) } : s;
}

/** What "Undo" would take back, for its label; null when there is nothing to undo. */
export function lastChange(s: DraftState): string | null {
  return s.history[s.history.length - 1]?.label ?? null;
}

export function draftTotal(s: DraftState): number {
  return countedCards(s.lines);
}

/** Copies of this card (any printing) already in the 100. */
export function copiesInDeck(s: DraftState, card: Pick<CardSummary, "oracleId" | "name">): number {
  return s.lines
    .filter((l) => (l.board === "main" || l.board === "commander") && (card.oracleId ? l.card.oracleId === card.oracleId : l.card.name === card.name))
    .reduce((n, l) => n + l.quantity, 0);
}

/** The body for PUT /api/decks/:id/cards. */
export function toSaveInput(s: DraftState): DeckCardInput[] {
  return s.lines.map((l) => ({ cardId: l.cardId, quantity: l.quantity, board: l.board, category: l.category }));
}

/** Whether the draft differs from the saved list. */
export function isDirty(s: DraftState, saved: DeckCardEntry[]): boolean {
  const key = (l: { cardId: string; quantity: number; board: Board }) => `${l.board}|${l.cardId}|${l.quantity}`;
  const a = s.lines.map(key).sort();
  const b = saved.map(key).sort();
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
}

/** A card summary from a full printing (the printing picker answers with an id; the line needs its label). */
export function summaryOf(p: CardPrinting): CardSummary {
  return { id: p.id, oracleId: p.oracleId, name: p.name, set: p.set, collectorNumber: p.collectorNumber, manaCost: p.manaCost, typeLine: p.typeLine, layout: p.layout, isToken: p.isToken, faceCount: hasBackFace(p.layout) ? 2 : 1 };
}
