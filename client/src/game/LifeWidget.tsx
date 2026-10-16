import { useRef } from "react";
import type { ViewPlayer } from "@cgwf/shared";
import { totalCommanderDamage } from "./model";

const HOLD_MS = 450;

/**
 * Life total: tap - / + for one point; press and hold the number for a
 * bigger change (the parent opens a number dialog). Poison and commander
 * damage ride along as small badges.
 */
export function LifeWidget({ player, mine, onDelta, onBig, onCounters }: { player: ViewPlayer; mine: boolean; onDelta: (d: number) => void; onBig: () => void; onCounters: () => void }) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const down = () => {
    held.current = false;
    timer.current = window.setTimeout(() => {
      held.current = true;
      onBig();
    }, HOLD_MS);
  };
  const up = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const poison = player.counters.poison ?? 0;
  const cmd = totalCommanderDamage(player);
  return (
    <div className={`life${mine ? " is-mine" : ""}${player.conceded ? " is-out" : ""}`}>
      <button className="life-btn" onClick={() => onDelta(-1)} aria-label="Lose 1 life">
        &minus;
      </button>
      <button
        className="life-total"
        onPointerDown={down}
        onPointerUp={up}
        onPointerLeave={up}
        onPointerCancel={up}
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          onCounters();
        }}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={`${player.life} life. Tap for counters, hold for a bigger change`}
      >
        {player.life}
        {(poison > 0 || cmd > 0) && (
          <span className="life-badges">
            {poison > 0 && <span className="life-badge is-poison">{poison}p</span>}
            {cmd > 0 && <span className="life-badge">{cmd}c</span>}
          </span>
        )}
      </button>
      <button className="life-btn" onClick={() => onDelta(1)} aria-label="Gain 1 life">
        +
      </button>
    </div>
  );
}
