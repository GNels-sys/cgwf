import { useEffect, useState } from "react";
import type { RoomAgentsResponse } from "@cgwf/shared";
import { api } from "../api";
import { Panel } from "./Panels";

/** Owner-only drawer: every computer opponent's decisions (one-sentence rationale, tool calls, cost) and the spend so far. */
export function AgentsPanel({ code, onClose }: { code: string; onClose: () => void }) {
  const [data, setData] = useState<RoomAgentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.agents
        .room(code)
        .then((r) => alive && setData(r))
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  return (
    <Panel title="Agent reasoning" subtitle={data ? `$${data.totalUsd.toFixed(3)} of $${data.maxUsdPerGame.toFixed(2)} this game` : undefined} onClose={onClose} wide>
      {error && <p className="error small">{error}</p>}
      {!data && !error && <p className="muted small">Loading...</p>}
      {data && (
        <>
          <ul className="agent-runs">
            {data.runs.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong> <span className="muted small">seat {r.seat + 1} · {r.deckName}</span>
                <br />
                <span className="small">
                  {r.mode === "dry_run" ? "dry run (no model)" : r.model} · {r.status}
                  {r.thinking ? " · thinking…" : ""} · {r.decisions} decisions · ${r.costUsd.toFixed(3)} · {r.inputTokens + r.cacheReadTokens} in / {r.outputTokens} out
                  {r.stoppedReason ? ` · ${r.stoppedReason}` : ""}
                </span>
              </li>
            ))}
            {data.runs.length === 0 && <li className="muted small">No computer opponents in this game.</li>}
          </ul>
          <ul className="agent-decisions">
            {data.decisions.map((d) => (
              <li key={d.id} className={`agent-decision is-${d.outcome}`}>
                <div className="small">
                  <strong>{d.name}</strong> · T{d.turn} {d.step} · {d.kind} · {d.outcome}
                  {d.costUsd ? ` · $${d.costUsd.toFixed(4)}` : ""} · {(d.latencyMs / 1000).toFixed(1)}s
                </div>
                {d.rationale && <div className="agent-rationale">{d.rationale}</div>}
                {d.toolCalls.length > 0 && (
                  <div className="small muted agent-calls">
                    {d.toolCalls.map((c, i) => (
                      <span key={i} className={c.ok ? "" : "warn"}>
                        {c.name}
                        {c.ok ? "" : ` ✗ ${c.error ?? ""}`}
                        {i < d.toolCalls.length - 1 ? ", " : ""}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
