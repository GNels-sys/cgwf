import { useState } from "react";
import { DEFAULT_ENGINE_STOPS, type EnginePhase, type EngineStops } from "@cgwf/shared";
import { Panel } from "./Panels";

/**
 * Rules-engine tables: where the engine should stop and offer you priority (Arena-style stops).
 * Everything else passes automatically. Saved per seat for this game (sent with {t:"stops"}).
 */

const STEPS: Array<{ phase: EnginePhase; label: string }> = [
  { phase: "UPKEEP", label: "Upkeep" },
  { phase: "DRAW", label: "Draw" },
  { phase: "MAIN1", label: "Main 1" },
  { phase: "COMBAT_BEGIN", label: "Begin combat" },
  { phase: "COMBAT_DECLARE_ATTACKERS", label: "After attackers" },
  { phase: "COMBAT_DECLARE_BLOCKERS", label: "After blockers" },
  { phase: "COMBAT_DAMAGE", label: "Combat damage" },
  { phase: "COMBAT_END", label: "End of combat" },
  { phase: "MAIN2", label: "Main 2" },
  { phase: "END_OF_TURN", label: "End step" },
];

export function StopsPanel({ stops, onSave, onClose }: { stops: EngineStops; onSave: (s: EngineStops) => void; onClose: () => void }) {
  const [mine, setMine] = useState<Set<EnginePhase>>(new Set(stops.myTurn));
  const [theirs, setTheirs] = useState<Set<EnginePhase>>(new Set(stops.theirTurn));
  const [respond, setRespond] = useState(stops.respond);

  const toggle = (set: Set<EnginePhase>, setter: (s: Set<EnginePhase>) => void, p: EnginePhase) => {
    const next = new Set(set);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setter(next);
  };
  const save = () => {
    onSave({ myTurn: [...mine], theirTurn: [...theirs], respond });
    onClose();
  };
  const reset = () => {
    setMine(new Set(DEFAULT_ENGINE_STOPS.myTurn));
    setTheirs(new Set(DEFAULT_ENGINE_STOPS.theirTurn));
    setRespond(DEFAULT_ENGINE_STOPS.respond);
  };

  return (
    <Panel title="Stops" subtitle="Where the engine pauses and asks you; everything else passes on its own" onClose={onClose}>
      <div className="stops-grid">
        <div className="stops-col">
          <h3>My turn</h3>
          {STEPS.map((s) => (
            <label key={s.phase} className="check-row">
              <input type="checkbox" checked={mine.has(s.phase)} onChange={() => toggle(mine, setMine, s.phase)} />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
        <div className="stops-col">
          <h3>Opponents&apos; turns</h3>
          {STEPS.map((s) => (
            <label key={s.phase} className="check-row">
              <input type="checkbox" checked={theirs.has(s.phase)} onChange={() => toggle(theirs, setTheirs, s.phase)} />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={respond} onChange={(e) => setRespond(e.target.checked)} />
        <span>
          <strong>Always stop when someone else puts something on the stack</strong>
          <span className="muted small">So you can respond before it resolves. Attacks and blocks always ask you regardless of stops.</span>
        </span>
      </label>
      <div className="actions">
        <button className="btn" onClick={reset}>
          Defaults
        </button>
        <button className="btn btn-primary" onClick={save}>
          Save
        </button>
      </div>
    </Panel>
  );
}
