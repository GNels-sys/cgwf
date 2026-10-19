/**
 * Hover preview of a card on deck pages, the library deck page and the import review: the rules, with
 * no DOM, so they are unit-tested (hoverPreview.test.ts). CardHoverPreview.tsx draws the result.
 *
 * - Only for a real hovering pointer: the device must match `(hover: hover) and (pointer: fine)` AND the
 *   event's pointer must be a mouse or pen. Touch never previews (phones keep tap-to-open).
 * - Keyboard focus that is :focus-visible shows the same preview beside the line (accessibility).
 * - The first preview waits SHOW_DELAY_MS; moving from one line to the next while a preview is up
 *   swaps the card at once, and leaving waits HIDE_GRACE_MS, so crossing the gap between two lines
 *   never flickers.
 */

export const HOVER_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";
export const SHOW_DELAY_MS = 250;
export const HIDE_GRACE_MS = 120;

export interface PreviewCard {
  id: string;
  name: string;
  /** 2 for two-faced cards (transform, modal DFC, ...). */
  faceCount: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PreviewState {
  card: PreviewCard;
  /** Cursor position, or for keyboard focus the right edge / middle of the focused line. */
  anchor: Point;
  via: "pointer" | "focus";
}

/** May this pointer event start a preview? */
export function pointerPreviewAllowed(hoverCapable: boolean, pointerType: string): boolean {
  return hoverCapable && (pointerType === "mouse" || pointerType === "pen");
}

type Timer = ReturnType<typeof setTimeout>;
interface Clock {
  set: (fn: () => void, ms: number) => Timer;
  clear: (t: Timer) => void;
}

export class HoverController {
  private shown: PreviewState | null = null;
  private pending: PreviewState | null = null;
  private showTimer: Timer | null = null;
  private hideTimer: Timer | null = null;

  constructor(
    private readonly onChange: (state: PreviewState | null) => void,
    private readonly clock: Clock = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
  ) {}

  get state(): PreviewState | null {
    return this.shown;
  }

  /** Pointer entered a line. `hoverCapable` = the media query matched at this moment. */
  enter(card: PreviewCard, at: Point, pointerType: string, hoverCapable: boolean): void {
    if (!pointerPreviewAllowed(hoverCapable, pointerType)) return;
    this.cancelHide();
    const next: PreviewState = { card, anchor: at, via: "pointer" };
    if (this.shown) {
      this.show(next);
      return;
    }
    this.pending = next;
    if (this.showTimer === null) {
      this.showTimer = this.clock.set(() => {
        this.showTimer = null;
        if (this.pending) this.show(this.pending);
        this.pending = null;
      }, SHOW_DELAY_MS);
    }
  }

  move(at: Point): void {
    if (this.pending) this.pending = { ...this.pending, anchor: at };
    if (this.shown && this.shown.via === "pointer") this.show({ ...this.shown, anchor: at });
  }

  leave(): void {
    this.pending = null;
    if (this.showTimer !== null) {
      this.clock.clear(this.showTimer);
      this.showTimer = null;
    }
    if (this.shown && this.hideTimer === null) {
      this.hideTimer = this.clock.set(() => {
        this.hideTimer = null;
        this.show(null);
      }, HIDE_GRACE_MS);
    }
  }

  /** Keyboard focus on a line: only when the browser draws a focus ring (:focus-visible). */
  focus(card: PreviewCard, at: Point, focusVisible: boolean): void {
    if (!focusVisible) return;
    this.cancelAll();
    this.show({ card, anchor: at, via: "focus" });
  }

  blur(): void {
    if (this.shown?.via === "focus") this.hideNow();
  }

  /** A click / tap / Escape / scroll: the preview goes at once. */
  hideNow(): void {
    this.cancelAll();
    this.show(null);
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) {
      this.clock.clear(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private cancelAll(): void {
    this.cancelHide();
    if (this.showTimer !== null) this.clock.clear(this.showTimer);
    this.showTimer = null;
    this.pending = null;
  }

  private show(state: PreviewState | null): void {
    this.shown = state;
    this.onChange(state);
  }
}

/** Card image width for the preview: as wide as 250 px but never taller than the viewport allows (63:88). */
export function previewWidth(viewport: { w: number; h: number }, margin = 12): number {
  const byHeight = ((viewport.h - 2 * margin) * 63) / 88;
  return Math.max(120, Math.floor(Math.min(250, byHeight, viewport.w * 0.4)));
}

/**
 * Where the preview box goes: to the right of the anchor with a gap, or to its left when it would
 * overflow; vertically centred on the anchor, then clamped inside the viewport.
 */
export function placePreview(anchor: Point, box: { w: number; h: number }, viewport: { w: number; h: number }, gap = 18, margin = 12): { left: number; top: number; side: "right" | "left" } {
  let side: "right" | "left" = "right";
  let left = anchor.x + gap;
  if (left + box.w > viewport.w - margin) {
    side = "left";
    left = anchor.x - gap - box.w;
  }
  left = Math.max(margin, Math.min(left, viewport.w - margin - box.w));
  const top = Math.max(margin, Math.min(anchor.y - box.h / 2, viewport.h - margin - box.h));
  return { left, top, side };
}
