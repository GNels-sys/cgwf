/**
 * The table's opening-hand rule (lobby setting on rules-engine tables, 2026-10-20). The host picks it before
 * the start; everyone sees it with its rules in plain words; it is frozen at the start and recorded with the
 * game's result.
 */

export type OpeningHandMode = "draw7" | "draw10";

export interface OpeningHandRule {
  mode: OpeningHandMode;
  /** Draw 7 only: free mulligans per player (0-2). The official multiplayer rule is one. */
  freeMulligans: number;
}

export const MAX_FREE_MULLIGANS = 2;
export const DEFAULT_OPENING_HAND: OpeningHandRule = {
  mode: "draw7",
  freeMulligans: 1,
};

export function isOpeningHandMode(v: unknown): v is OpeningHandMode {
  return v === "draw7" || v === "draw10";
}

/** Anything into a valid rule (unknown mode -> Draw 7; free mulligans clamped to 0-2; 0 for Draw 10). */
export function sanitizeOpeningHand(
  mode: unknown,
  freeMulligans: unknown,
): OpeningHandRule {
  if (mode === "draw10") return { mode: "draw10", freeMulligans: 0 };
  const n = Number(freeMulligans);
  return {
    mode: "draw7",
    freeMulligans: Number.isInteger(n)
      ? Math.min(MAX_FREE_MULLIGANS, Math.max(0, n))
      : DEFAULT_OPENING_HAND.freeMulligans,
  };
}

/** The lobby's names and rules text, shared so the lobby, its tests and the docs agree. */
export const OPENING_HAND_TEXT: Record<
  OpeningHandMode,
  { title: string; rules: string }
> = {
  draw7: {
    title: "Draw 7 (London mulligan)",
    rules:
      "Everyone draws seven. To mulligan, shuffle your hand into your library and draw seven again, then put one card on the bottom of your library for each mulligan beyond your free ones. Under the official multiplayer rules your first mulligan is free.",
  },
  draw10: {
    title: "Draw 10, put 3 back (no mulligans)",
    rules:
      "Everyone draws ten. Each player secretly picks three of their ten; those three are shuffled back into their library and the other seven are the opening hand. There are no mulligans. Nothing goes to the graveyard and no card is revealed. Opening-hand cards (Leylines, Gemstone Caverns, Chancellors) can still be used from the seven you keep.",
  },
};

/** "1 free mulligan", "No free mulligans". */
export function freeMulligansLabel(n: number): string {
  return n === 0
    ? "No free mulligans"
    : `${n} free mulligan${n === 1 ? "" : "s"}`;
}

/** Short summary for a non-host's lobby view and the recent-tables line. */
export function openingHandSummary(r: OpeningHandRule): string {
  return r.mode === "draw10"
    ? OPENING_HAND_TEXT.draw10.title
    : `Draw 7 · ${freeMulligansLabel(r.freeMulligans).toLowerCase()}`;
}
