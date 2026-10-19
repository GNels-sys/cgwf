import { useCallback, useEffect, useMemo, useState, type FocusEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { CardImage } from "./CardImage";
import { HOVER_MEDIA_QUERY, HoverController, placePreview, previewWidth, type PreviewCard, type PreviewState } from "./hoverPreview";

const GAP = 8;

/**
 * Hover preview for card lines (deck page, library deck page, import review). Spread `bind(card)` on
 * the line element; render `preview` once. Rules live in hoverPreview.ts: mouse/pen on a hover-capable
 * device only, short delay, no flicker between lines, keyboard focus-visible too. The preview never
 * takes pointer events, so a click on the line still opens the full card view.
 */
export function useCardHover() {
  const [state, setState] = useState<PreviewState | null>(null);
  const ctl = useMemo(() => new HoverController(setState), []);

  useEffect(() => {
    const hide = () => ctl.hideNow();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", hide);
      ctl.hideNow();
    };
  }, [ctl]);

  const bind = useCallback(
    (card: PreviewCard) => ({
      onPointerEnter: (e: PointerEvent<HTMLElement>) => {
        const capable = typeof window.matchMedia === "function" && window.matchMedia(HOVER_MEDIA_QUERY).matches;
        ctl.enter(card, { x: e.clientX, y: e.clientY }, e.pointerType, capable);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => ctl.move({ x: e.clientX, y: e.clientY }),
      onPointerLeave: () => ctl.leave(),
      onPointerDown: () => ctl.hideNow(),
      onFocus: (e: FocusEvent<HTMLElement>) => {
        let visible = false;
        try {
          visible = e.currentTarget.matches(":focus-visible");
        } catch {
          visible = false;
        }
        const r = e.currentTarget.getBoundingClientRect();
        ctl.focus(card, { x: r.right, y: r.top + r.height / 2 }, visible);
      },
      onBlur: () => ctl.blur(),
    }),
    [ctl],
  );

  const hide = useCallback(() => ctl.hideNow(), [ctl]);
  return { bind, hide, preview: <CardHoverPreview state={state} /> };
}

function CardHoverPreview({ state }: { state: PreviewState | null }) {
  if (!state || typeof document === "undefined") return null;
  const vp = { w: window.innerWidth, h: window.innerHeight };
  const w = previewWidth(vp);
  const h = Math.round((w * 88) / 63);
  const twoFaced = state.card.faceCount > 1;
  // Both faces side by side when the window has room beside the cursor; otherwise the front and a hint.
  const sideBySide = twoFaced && vp.w >= 2 * w + GAP + 320;
  const box = { w: sideBySide ? 2 * w + GAP : w, h: h + (twoFaced && !sideBySide ? 26 : 0) };
  const pos = placePreview(state.anchor, box, vp);
  return createPortal(
    <div className={`card-hover-preview is-${pos.side}`} style={{ left: pos.left, top: pos.top, width: box.w }} aria-hidden="true">
      <div className="card-hover-faces" style={{ gridTemplateColumns: sideBySide ? `${w}px ${w}px` : `${w}px` }}>
        <CardImage key={`${state.card.id}:0`} id={state.card.id} name={state.card.name} size="normal" loading="eager" />
        {sideBySide && <CardImage key={`${state.card.id}:1`} id={state.card.id} name={`${state.card.name} (back)`} size="normal" face={1} loading="eager" />}
      </div>
      {twoFaced && !sideBySide && <p className="card-hover-hint">Two-faced: click for the back</p>}
    </div>,
    document.body,
  );
}
