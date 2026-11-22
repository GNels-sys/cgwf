import { useState } from "react";
import type { EngineLoopOffer, EngineLoopPause, EngineRepeating } from "@cgwf/shared";

/**
 * "Run the loop" (owner, 2026-11-21: Enduring Tenacity + Bloodthirsty Conqueror asked the same three questions
 * every round until the table was dead). The engine offers it when the same run of questions was answered the
 * same way again and again; accepting answers the rounds from those choices. Every round is still played out,
 * so opponents can respond, and the game is won when the loop really takes the last life.
 *
 * A round that is one yes/no question (owner, 2026-11-21: sixty "pay life to draw?" triggers, wanted "X of them one
 * way and the rest the other") also offers: this answer N more times, then the other answer for the rest.
 */

export function loopSeenText(offer: EngineLoopOffer): string {
  const what = offer.steps === 1 ? "the same question" : `the same ${offer.steps} questions`;
  const times = offer.seen === 2 ? "twice" : `${offer.seen} times`;
  return `You answered ${what} the same way ${times} in a row.`;
}

export function loopPausedText(pause: EngineLoopPause): string {
  const why = pause.reason ? `${pause.reason.charAt(0).toUpperCase()}${pause.reason.slice(1)}.` : "A choice cannot be repeated.";
  return `${why} Answer this one and the loop carries on with your new answer.`;
}

const LOOP_RULES = "Each round is still played out, so opponents can respond. It stops by itself if they do, or when something new is asked. If a choice is gone (a player is out) you pick once and it carries on.";

/** The pop-up: what was spotted, and the two ways to run it. */
export function LoopOfferDialog({ offer, onRun, onLater }: { offer: EngineLoopOffer; onRun: (times: number, thenOther?: boolean) => void; onLater: () => void }) {
  const [times, setTimes] = useState("10");
  const parsed = Math.floor(Number(times));
  const ok = Number.isFinite(parsed) && parsed >= 1;
  const n = Math.max(1, Math.min(offer.max, ok ? parsed : 1));
  return (
    <div className="loop-backdrop">
      <div className="loop-dialog" role="alertdialog" aria-modal="true" aria-label="This looks like a loop">
        <h2>This looks like a loop</h2>
        <p>{loopSeenText(offer)} Run it without being asked each time?</p>
        {offer.titles.length > 0 && (
          <ol className="loop-steps">
            {offer.titles.map((t, i) => (
              <li key={i}>{t || "A choice"}</li>
            ))}
          </ol>
        )}
        <div className="loop-actions">
          <button className="btn btn-primary" onClick={() => onRun(offer.max)}>
            Run it until it ends
          </button>
          <button className="btn btn-small" onClick={onLater}>
            Not now
          </button>
          <form
            className="loop-times"
            onSubmit={(e) => {
              e.preventDefault();
              if (ok) onRun(n);
            }}
          >
            <label>
              <span>{offer.flip ? `or "${offer.flip.now}" this many more times` : "or this many rounds"}</span>
              <input type="number" inputMode="numeric" min={1} max={offer.max} value={times} onChange={(e) => setTimes(e.target.value)} aria-label="How many rounds" />
            </label>
            {offer.flip ? (
              <>
                <button type="button" className="btn btn-small btn-primary" disabled={!ok} onClick={() => ok && onRun(n, true)}>
                  then "{offer.flip.then}" for the rest
                </button>
                <button type="submit" className="btn btn-small" disabled={!ok}>
                  then ask me again
                </button>
              </>
            ) : (
              <button type="submit" className="btn btn-small" disabled={!ok}>
                Go
              </button>
            )}
          </form>
        </div>
        <p className="muted small">
          {LOOP_RULES} At most {offer.max} rounds.
        </p>
      </div>
    </div>
  );
}

export function repeatingText(r: EngineRepeating): string {
  const what = r.kind === "cast" ? `Repeating ${r.name}` : "Running the loop";
  return r.wanted > 0 ? `${what}: ${r.done} of ${r.wanted}.` : `${what}: ${r.done} so far.`;
}

/**
 * While the engine repeats a cast or a loop for me nothing is asked, so this is the only control on screen
 * (owner, 2026-11-22: "how do I stop the loop if it's causing the game to slow down?"). Stop ends it after the
 * step in hand; what was already made stays.
 */
export function RepeatingBanner({ repeating, onStop }: { repeating: EngineRepeating; onStop: () => void }) {
  const [asked, setAsked] = useState(false);
  return (
    <div className="loop-banner" role="status">
      <span>
        <strong>{repeatingText(repeating)}</strong> {asked ? "Stopping after this one..." : "You are not asked anything while it runs."}
      </span>
      <button
        className="btn btn-small btn-primary"
        disabled={asked}
        onClick={() => {
          setAsked(true);
          onStop();
        }}
      >
        Stop
      </button>
    </div>
  );
}

/** Stays above any open sheet: the paused loop, or an offer that was put aside. */
export function LoopBanner({ offer, pause, stopping, onOpen, onStop }: { offer: EngineLoopOffer | null; pause: EngineLoopPause | null; stopping: boolean; onOpen: () => void; onStop: (stop: boolean) => void }) {
  if (pause) {
    return (
      <div className="loop-banner" role="status">
        <span>
          <strong>Loop paused.</strong> {stopping ? "The loop ends with this answer." : loopPausedText(pause)}
          {!stopping && pause.left > 0 ? ` ${pause.left} ${pause.left === 1 ? "round" : "rounds"} left.` : ""}
        </span>
        <button className="btn btn-small" onClick={() => onStop(!stopping)}>
          {stopping ? "Keep the loop" : "Stop the loop"}
        </button>
      </div>
    );
  }
  if (!offer) return null;
  return (
    <div className="loop-banner" role="status">
      <span>
        <strong>Loop found.</strong> {loopSeenText(offer)}
      </span>
      <button className="btn btn-small btn-primary" onClick={onOpen}>
        Run it...
      </button>
    </div>
  );
}
