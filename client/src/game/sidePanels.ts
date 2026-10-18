/**
 * Which side overlays are open on an engine table: the Active Board (left edge) and the Game Log
 * (right third). One rule decides it everywhere, including when the phone rotates:
 *
 * - Phone landscape: never both open (they would cover the whole battlefield). Opening one closes
 *   the other; when the board pushed the log aside, closing the board gives the log back.
 * - Portrait: they stack (board top half, log bottom half), so both may be open.
 * - Rotating to landscape with both open keeps the one that matters now: the board on an
 *   opponent's turn (the log steps aside and comes back with the board's close), else the log.
 * - Rotating to portrait gives back a log that had only stepped aside for the board.
 *
 * Every event that depends on orientation carries it, read live from matchMedia at dispatch time:
 * nothing here caches the orientation, so a late or missed media-query event cannot leave it stale.
 */
export interface PanelState {
  board: boolean;
  log: boolean;
  /** The log was closed only to make room for the board (landscape); it returns when the board closes. */
  logYielded: boolean;
}

export type PanelEvent =
  | { type: "openBoard"; landscape: boolean }
  | { type: "closeBoard" }
  | { type: "openLog"; landscape: boolean }
  | { type: "closeLog" }
  | { type: "layout"; landscape: boolean; opponentsTurn: boolean };

export const INITIAL_PANELS: PanelState = { board: false, log: true, logYielded: false };

export function panelsReducer(s: PanelState, e: PanelEvent): PanelState {
  switch (e.type) {
    case "openBoard":
      if (e.landscape && s.log) return { board: true, log: false, logYielded: true };
      return s.board ? s : { ...s, board: true };
    case "closeBoard":
      if (!s.board && !s.logYielded) return s;
      return { board: false, log: s.log || s.logYielded, logYielded: false };
    case "openLog":
      if (e.landscape) return s.log && !s.board ? s : { board: false, log: true, logYielded: false };
      return s.log && !s.logYielded ? s : { ...s, log: true, logYielded: false };
    case "closeLog":
      return s.log || s.logYielded ? { ...s, log: false, logYielded: false } : s;
    case "layout":
      if (e.landscape) {
        if (!(s.board && s.log)) return s;
        return e.opponentsTurn ? { board: true, log: false, logYielded: true } : { board: false, log: true, logYielded: false };
      }
      if (s.board && s.logYielded && !s.log) return { board: true, log: true, logYielded: false };
      return s;
  }
}

/** Live orientation, the same test the CSS uses (`@media (orientation: landscape)`). */
export function isLandscapeNow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(orientation: landscape)").matches;
}
