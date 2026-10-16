import { useEffect, useRef, useState } from "react";
import type { ViewPlayer } from "@cgwf/shared";
import { totalCommanderDamage } from "./model";

const HOLD_MS = 450;

/**
 * Floating "+3" / "-5" that rises and fades when a life total changes.
 * Returns the ticks to render; the CSS animation is skipped under
 * prefers-reduced-motion.
 */
export function useLifeTicks(life: number): Array<{ id: number; delta: number }> {
  const prev = useRef(life);
  const [ticks, setTicks] = useState<Array<{ id: number; delta: number }>>([]);
  useEffect(() => {
    const delta = life - prev.current;
    prev.current = life;
    if (delta === 0) return;
    const id = Date.now() + Math.random();
    setTicks((t) => [...t.slice(-2), { id, delta }]);
    const timer = window.setTimeout(() => setTicks((t) => t.filter((x) => x.id !== id)), 1100);
    return () => window.clearTimeout(timer);
  }, [life]);
  return ticks;
}

export function LifeTicks({ ticks }: { ticks: Array<{ id: number; delta: number }> }) {
  if (ticks.length === 0) return null;
  return (
    <span className="life-ticks" aria-hidden="true">
      {ticks.map((t) => (
        <span key={t.id} className={`life-tick${t.delta > 0 ? " is-up" : " is-down"}`}>
          {t.delta > 0 ? `+${t.delta}` : t.delta}
        </span>
      ))}
    </span>
  );
}

/**
 * Life total: tap - / + for one point; press and hold the number for a
 * bigger change (the parent opens a number dialog). Poison and commander
 * damage ride along as small badges.
 */
export function LifeWidget({ player, mine, onDelta, onBig, onCounters }: { player: ViewPlayer; mine: boolean; onDelta: (d: number) => void; onBig: () => void; onCounters: () => void }) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  const ticks = useLifeTicks(player.life);
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
        aria-live="polite"
      >
        {player.life}
        <LifeTicks ticks={ticks} />
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
