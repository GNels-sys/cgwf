import { useState } from "react";
import type { EngineRepeatOffer } from "@cgwf/shared";

/**
 * "Repeat this cast N times" (owner, 2026-11-04: an infinite Sprout Swarm loop took forty separate casts). The
 * engine offers it when the last spell this seat cast is castable again from the same zone; the seat says how
 * many and the engine casts it that many times with the same choices, letting each copy resolve in between.
 * It stops early, and asks as usual, when a choice no longer fits (a target is gone), the card can no longer be
 * cast, or an opponent puts something on the stack.
 */
export function RepeatControl({ offer, onGo }: { offer: EngineRepeatOffer; onGo: (times: number) => void }) {
  const [times, setTimes] = useState(() => String(offer.last > 1 ? offer.last : 10));
  const parsed = Math.floor(Number(times));
  const ok = Number.isFinite(parsed) && parsed >= 2;
  const n = Math.max(2, Math.min(offer.max, ok ? parsed : 2));
  return (
    <form
      className="repeat-cast"
      aria-label={`Repeat ${offer.cardName}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onGo(n);
      }}
    >
      <span className="repeat-cast-label">
        <strong>Repeat {offer.cardName}</strong>
        <span className="muted small">Same choices each time, each copy resolving in between; it stops and asks you if anything changes or an opponent responds.</span>
      </span>
      <label className="repeat-cast-times">
        <span aria-hidden="true">&times;</span>
        <input type="number" inputMode="numeric" min={2} max={offer.max} value={times} onChange={(e) => setTimes(e.target.value)} aria-label="How many times" />
      </label>
      <button type="submit" className="btn btn-small btn-primary" disabled={!ok}>
        Go
      </button>
    </form>
  );
}
