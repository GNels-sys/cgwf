import type { EventInput, PendingTrigger } from "@cgwf/shared";

/**
 * Advisory trigger tracker. Lists what probably triggered for me; tapping a
 * line marks it resolved (logged), "Dismiss all" clears mine. Nothing blocks.
 */
export function TriggersPanel({ triggers, me, dispatch }: { triggers: PendingTrigger[]; me: string; dispatch: (e: EventInput) => void }) {
  const mine = triggers.filter((t) => t.controller === me);
  if (!mine.length) return null;
  return (
    <div className="triggers" role="status" aria-live="polite">
      <div className="triggers-head">
        <strong>
          {mine.length} trigger{mine.length === 1 ? "" : "s"}
        </strong>
        <button className="btn btn-small" onClick={() => dispatch({ type: "TriggersDismissed", payload: { player: me } })}>
          Dismiss all
        </button>
      </div>
      <ul>
        {mine.map((t) => (
          <li key={t.id}>
            <button className="trigger-line" onClick={() => dispatch({ type: "TriggerResolved", payload: { id: t.id } })} title="Tap when resolved">
              <span className="trigger-kind">{t.kind}</span>
              <span>{t.name}</span>
              <span className="muted small">&#10003;</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
