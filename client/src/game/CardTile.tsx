import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { cardImagePath, type ViewCard } from "@cgwf/shared";
import type { SleeveStyle } from "./look";
import { imageFace, nameOf, printingOf, type Printings } from "./model";

interface Props {
  card: ViewCard;
  printings: Printings;
  onTap?: (card: ViewCard) => void;
  onHold?: (card: ViewCard) => void;
  draggable?: boolean;
  selected?: boolean;
  /** Drawn smaller and offset: an attachment under its host. */
  attached?: boolean;
  dim?: boolean;
  /** The owner's sleeve, drawn when the card is hidden. */
  sleeve?: SleeveStyle | undefined;
}

const HOLD_MS = 450;
const FLIP_MS = 320;

/**
 * One card on the table. Tap opens the action sheet; press-and-hold zooms.
 * Tapped cards turn sideways, counters show as badges, hidden cards show the
 * owner's sleeve (a CGwF design or their upload, never the official card back).
 * Light animations: fade in on arrival, a flip when a face changes; all off
 * under prefers-reduced-motion (see game.css).
 */
export function CardTile({ card, printings, onTap, onHold, draggable = false, selected = false, attached = false, dim = false, sleeve }: Props) {
  const printing = printingOf(card, printings);
  const name = nameOf(card, printings);
  const hidden = card.faceDown || (!card.printingId && !card.custom);
  const face = imageFace(card, printing);
  const holdTimer = useRef<number | null>(null);
  const held = useRef(false);
  const [flipping, setFlipping] = useState(false);
  const faceKey = `${card.face}:${card.faceDown ? 1 : 0}`;
  const prevFaceKey = useRef(faceKey);

  useEffect(() => {
    if (prevFaceKey.current === faceKey) return;
    prevFaceKey.current = faceKey;
    setFlipping(true);
    const t = window.setTimeout(() => setFlipping(false), FLIP_MS);
    return () => window.clearTimeout(t);
  }, [faceKey]);

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.iid, disabled: !draggable, data: { card } });

  const clearHold = () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    held.current = false;
    clearHold();
    if (!onHold) return;
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      onHold(card);
    }, HOLD_MS);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerUp = () => clearHold();
  const onPointerMove = (e: ReactPointerEvent) => {
    // A real move means a scroll or a drag, not a hold.
    if (e.buttons !== 0 || e.pointerType === "touch") {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 4) clearHold();
    }
  };
  const onClick = () => {
    if (held.current) {
      held.current = false;
      return;
    }
    onTap?.(card);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onTap?.(card);
    } else if (e.key.toLowerCase() === "z") onHold?.(card);
  };

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : dim ? 0.55 : 1,
  };
  const badges = Object.entries(card.counters);
  const label = `${name}${card.tapped ? ", tapped" : ""}${card.faceDown ? ", face down" : ""}${badges.length ? `, ${badges.map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}`;

  return (
    <div
      ref={setNodeRef}
      className={`tile${card.tapped ? " is-tapped" : ""}${selected ? " is-selected" : ""}${attached ? " is-attached" : ""}${card.isToken ? " is-token" : ""}${card.isCommander ? " is-commander" : ""}${flipping ? " is-flipping" : ""}`}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      aria-label={label}
      title={name}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerMove={onPointerMove}
      onClick={onClick}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="tile-inner">
        {hidden || !printing ? (
          <div className={`tile-back${card.custom ? " is-custom" : ` ${sleeve?.className ?? "sleeve-classic"}`}`} style={card.custom ? undefined : sleeve?.style}>
            {card.custom ? (
              <span className="tile-custom">
                <strong>{card.custom.name}</strong>
                {card.custom.power && (
                  <em>
                    {card.custom.power}/{card.custom.toughness}
                  </em>
                )}
              </span>
            ) : (
              <span className="sleeve-mark">{card.faceDown ? "?" : ""}</span>
            )}
          </div>
        ) : (
          <img src={cardImagePath(printing.id, "small", face)} alt="" draggable={false} loading="lazy" decoding="async" />
        )}
      </div>
      {badges.length > 0 && (
        <div className="tile-badges">
          {badges.map(([k, v]) => (
            <span key={k} className="tile-badge" title={`${v} ${k}`}>
              {k === "+1/+1" ? `+${v}` : k === "-1/-1" ? `-${v}` : `${v}${k[0]?.toUpperCase() ?? ""}`}
            </span>
          ))}
        </div>
      )}
      {card.isCommander && <span className="tile-mark" title="Commander">C</span>}
    </div>
  );
}
