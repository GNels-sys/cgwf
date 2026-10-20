/**
 * A repeatable layout check for the table: every control a player needs must be on screen and
 * actually reachable (the topmost element at its centre is the control itself, not an overlay),
 * and at phone landscape the Active Board and Game Log must never be open together.
 *
 * `layoutProblems` is pure (unit-tested); `collectLayout` reads the live DOM. The table installs
 * `window.cgwfLayoutCheck()` so the same check runs in any browser console, including on prod:
 * rotate, open and close the overlays, run it, expect `[]`.
 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ControlSample {
  name: string;
  box: Box;
  /** The topmost element at the control's centre is the control (or inside it). */
  reachable: boolean;
}

export interface LayoutSample {
  landscape: boolean;
  viewport: { width: number; height: number };
  controls: ControlSample[];
  board: Box | null;
  log: Box | null;
}

const SLACK = 1; // sub-pixel rounding

export function layoutProblems(s: LayoutSample): string[] {
  const out: string[] = [];
  if (s.landscape && s.board && s.log) out.push("landscape: Active Board and Game Log are both open");
  for (const c of s.controls) {
    const b = c.box;
    if (b.right - b.left <= 0 || b.bottom - b.top <= 0) continue; // not rendered
    if (b.left < -SLACK || b.top < -SLACK || b.right > s.viewport.width + SLACK || b.bottom > s.viewport.height + SLACK) {
      out.push(`${c.name}: off screen (${Math.round(b.left)},${Math.round(b.top)} to ${Math.round(b.right)},${Math.round(b.bottom)} in ${s.viewport.width}x${s.viewport.height})`);
    } else if (!c.reachable) {
      out.push(`${c.name}: covered by another element`);
    }
  }
  return out;
}

/** The controls that must stay reachable; selectors match Table, PhaseStrip, Engine, Overlays, StackPanel. */
const CONTROLS: Array<[string, string]> = [
  ["phase strip step", ".phase-step"],
  ["Hold", ".phase-hold"],
  ["engine bar action", ".engine-bar-actions button"],
  ["Board tab", ".edge-tab.is-left"],
  ["Log tab", ".edge-tab.is-right"],
  ["Active Board minimise", ".active-board-head .sheet-close"],
  ["Game Log minimise", ".game-log-head .sheet-close"],
  ["Stack panel", ".stack-panel-head"],
  ["menu", "button[aria-label='Menu']"],
  ["voice", "a[aria-label='Join voice on Discord']"],
];

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** While the D20 roll for who goes first covers the table, its own controls are the ones that must be reachable. */
const FIRST_ROLL_CONTROLS: Array<[string, string]> = [
  ["Roll", ".first-roll-roll"],
  ["first-roll Continue", ".first-roll-close"],
  ["first-roll panel", ".first-roll-box h2"],
];

/** The pregame modals (keep / mulligan, put on the bottom, Draw 10's put back) cover the table on purpose. */
const PREGAME_CONTROLS: Array<[string, string]> = [
  ["pregame action", ".mulligan-box .actions button"],
  ["pregame title", ".mulligan-box h2"],
];

/** An open sheet (prompt lists, optional choices, Pay with) is modal too: its own buttons must be reachable. */
const SHEET_CONTROLS: Array<[string, string]> = [
  ["sheet close", ".sheet-backdrop .sheet-close"],
  ["sheet action", ".sheet-backdrop .actions button"],
];

export function collectLayout(root: Document = document): LayoutSample {
  const controls: ControlSample[] = [];
  const list = root.querySelector(".first-roll")
    ? FIRST_ROLL_CONTROLS
    : root.querySelector(".mulligan .mulligan-box")
      ? PREGAME_CONTROLS
      : root.querySelector(".sheet-backdrop .sheet")
        ? SHEET_CONTROLS
        : CONTROLS;
  for (const [name, selector] of list) {
    const seen = new Set<Element>();
    root.querySelectorAll(selector).forEach((el, i) => {
      if (seen.has(el)) return;
      seen.add(el);
      const box = boxOf(el);
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      const hit = root.elementFromPoint(cx, cy);
      controls.push({ name: i === 0 ? name : `${name} #${i + 1}`, box, reachable: !!hit && (hit === el || el.contains(hit)) });
    });
  }
  const board = root.querySelector(".active-board");
  const log = root.querySelector(".game-log");
  return {
    landscape: typeof window.matchMedia === "function" ? window.matchMedia("(orientation: landscape)").matches : window.innerWidth >= window.innerHeight,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    controls,
    board: board ? boxOf(board) : null,
    log: log ? boxOf(log) : null,
  };
}

declare global {
  interface Window {
    cgwfLayoutCheck?: () => string[];
  }
}

/** Installs `window.cgwfLayoutCheck()`; returns an uninstaller. */
export function installLayoutCheck(): () => void {
  if (typeof window === "undefined") return () => {};
  window.cgwfLayoutCheck = () => layoutProblems(collectLayout());
  return () => {
    delete window.cgwfLayoutCheck;
  };
}
