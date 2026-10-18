import { useState } from "react";
import { DEFAULT_ENGINE_STOPS, STOPPABLE_PHASES, type EnginePhase, type EngineStops } from "@cgwf/shared";
import { Panel } from "./Panels";

/**
 * Rules-engine tables: where the engine stops and offers you priority (Arena-style stops), as a
 * row of step toggles for your turn and one for everyone else's, plus the two automatic passes.
 * Saved per user (the table sends {t:"stops"} and the client stores it in settings), so the next
 * engine game starts with the same stops. The phase strip toggles the same steps with one tap.
 */

export const STOP_LABELS: Record<EnginePhase, string> = {
  UNTAP: "Untap",
  UPKEEP: "Upkeep",
  DRAW: "Draw",
  MAIN1: "Main 1",
  COMBAT_BEGIN: "Begin combat",
  COMBAT_DECLARE_ATTACKERS: "Attackers",
  COMBAT_DECLARE_BLOCKERS: "Blockers",
  COMBAT_FIRST_STRIKE_DAMAGE: "First strike",
  COMBAT_DAMAGE: "Damage",
  COMBAT_END: "End combat",
  MAIN2: "Main 2",
  END_OF_TURN: "End step",
  CLEANUP: "Cleanup",
};

/** Toggle one step in one of the two lists (pure). */
export function toggleStop(stops: EngineStops, phase: EnginePhase, mine: boolean): EngineStops {
  const key = mine ? "myTurn" : "theirTurn";
  const list = stops[key].includes(phase) ? stops[key].filter((p) => p !== phase) : [...stops[key], phase];
  return { ...stops, [key]: STOPPABLE_PHASES.filter((p) => list.includes(p)) };
}

function StopRow({ label, hint, picked, onToggle }: { label: string; hint: string; picked: EnginePhase[]; onToggle: (p: EnginePhase) => void }) {
  return (
    <div className="stops-row">
      <div className="stops-row-head">
        <strong>{label}</strong>
        <span className="muted small">{hint}</span>
      </div>
      <div className="stops-chips" role="group" aria-label={label}>
        {STOPPABLE_PHASES.map((p) => {
          const on = picked.includes(p);
          return (
            <button key={p} className={`chip stop-chip${on ? " is-selected" : ""}`} onClick={() => onToggle(p)} aria-pressed={on}>
              {STOP_LABELS[p]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StopsPanel({ stops, onSave, onClose }: { stops: EngineStops; onSave: (s: EngineStops) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<EngineStops>(stops);
  const save = () => {
    onSave(draft);
    onClose();
  };
  return (
    <Panel title="Stops" subtitle="Where the engine pauses and asks you; everything else passes on its own" onClose={onClose}>
      <StopRow label="My turn" hint="Tap a step to stop there" picked={draft.myTurn} onToggle={(p) => setDraft(toggleStop(draft, p, true))} />
      <StopRow label="Opponents' turns" hint="Attacks and blocks always ask you" picked={draft.theirTurn} onToggle={(p) => setDraft(toggleStop(draft, p, false))} />
      <label className="check-row">
        <input type="checkbox" checked={draft.respond} onChange={(e) => setDraft({ ...draft, respond: e.target.checked })} />
        <span>
          <strong>Always stop when someone else puts something on the stack</strong>
          <span className="muted small">So you can respond before it resolves.</span>
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={draft.autoPassEmpty} onChange={(e) => setDraft({ ...draft, autoPassEmpty: e.target.checked })} />
        <span>
          <strong>Pass automatically when I have nothing to do</strong>
          <span className="muted small">No castable spell, ability or land at that moment: the stop is skipped. A quick pass can hint that your hand is empty of answers, like Arena. &quot;Hold&quot; in the turn bar switches this off for one turn.</span>
        </span>
      </label>
      <div className="actions">
        <button className="btn" onClick={() => setDraft(DEFAULT_ENGINE_STOPS)}>
          Defaults
        </button>
        <button className="btn btn-primary" onClick={save}>
          Save
        </button>
      </div>
    </Panel>
  );
}
