import { useEffect, useState, type ReactNode } from "react";
import type { Bracket, DoctorAiState, DoctorAiSwap } from "@cgwf/shared";
import { api } from "../api";
import { aiRunLine } from "./doctorText";

/**
 * Owner-only "Ask Claude" block inside the Deck Doctor panel (M2). Hidden for everyone else (the server
 * refuses them too). A finished run is cached per deck version; "Run again" starts a fresh, billed run.
 */
export function DoctorAiSection({
  kind,
  id,
  version,
  bracket,
  allowHigher,
  canApply,
  renderPair,
  onApply,
  onPref,
  busy,
}: {
  kind: "own" | "library";
  id: string;
  version: string;
  bracket: Bracket | null;
  allowHigher: boolean;
  canApply: boolean;
  renderPair: (s: DoctorAiSwap) => ReactNode;
  onApply: (cutEntryId: number, addOracleId: string) => void;
  onPref: (kind: "keep" | "dismiss", oracleId: string | null, name: string) => void;
  busy: boolean;
}) {
  const [state, setState] = useState<DoctorAiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const running = state?.run?.status === "running";

  useEffect(() => {
    let live = true;
    api.doctor
      .ai(kind, id)
      .then((s) => {
        if (live) setState(s);
      })
      .catch(() => {
        if (live) setState(null);
      });
    return () => {
      live = false;
    };
  }, [kind, id, version]);

  // Poll while a run is in progress.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      api.doctor.ai(kind, id).then(setState).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [running, kind, id]);

  if (!state) return null;
  if (!state.enabled) return <p className="small muted doctor-ai-off">Claude upgrade: off (set DOCTOR_AI_ENABLED=1 on the server).</p>;

  const start = async (force: boolean) => {
    setStarting(true);
    setError(null);
    try {
      setState(await api.doctor.aiStart(kind, id, { ...(bracket ? { bracket } : {}), allowHigher, force }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const run = state.run;
  return (
    <section className="doctor-ai" aria-label="Claude deck upgrade">
      <div className="row-between">
        <div>
          <p className="eyebrow">Owner only</p>
          <h3>Ask Claude for the best upgrade</h3>
        </div>
        <div className="actions">
          {!run || run.status !== "done" || !run.current ? (
            <button className="btn btn-small btn-primary" disabled={starting || running || Boolean(state.problem)} onClick={() => void start(false)}>
              {running ? "Claude is reading the deck…" : starting ? "Starting…" : "Ask Claude"}
            </button>
          ) : (
            <button className="btn btn-small" disabled={starting || running} onClick={() => void start(true)} title="Starts a new, billed run">
              Run again
            </button>
          )}
        </div>
      </div>
      <p className="small muted">
        {state.model} · up to ${state.maxUsdPerRun.toFixed(2)} a run · today ${state.todayUsd.toFixed(2)} of ${state.maxUsdPerDay.toFixed(2)}
      </p>
      {state.problem && <p className="small warn">{state.problem}</p>}
      {error && <p className="small error">{error}</p>}
      {run && (
        <>
          <p className="small muted">{aiRunLine(run)}</p>
          {run.status !== "done" && run.status !== "running" && run.error && <p className="small warn">{run.error}</p>}
          {run.result && (
            <>
              {!run.current && <p className="small warn">The deck changed after this run; Run again for an up-to-date read.</p>}
              <p className="doctor-ai-read">{run.result.read}</p>
              <ol className="doctor-swaps">
                {run.result.swaps.map((s) => (
                  <li key={`${s.add.oracleId}-${s.cut.entryId}`} className="doctor-swap is-ai">
                    {renderPair(s)}
                    <p className="small doctor-reason">{s.reason}</p>
                    {s.bracket.raises && <p className="small warn">Raises the bracket floor to {s.bracket.floorAfter}.</p>}
                    <div className="actions doctor-actions">
                      {canApply && run.current && s.cut.entryId !== null && s.add.oracleId && (
                        <button className="btn btn-small btn-primary" disabled={busy} onClick={() => onApply(s.cut.entryId!, s.add.oracleId!)}>
                          Apply swap
                        </button>
                      )}
                      <button className="btn btn-small" disabled={busy} onClick={() => onPref("keep", s.cut.oracleId, s.cut.name)}>
                        Keep {s.cut.name.split(",")[0]}
                      </button>
                      <button className="btn btn-small" disabled={busy} onClick={() => onPref("dismiss", s.add.oracleId, s.add.name)}>
                        Not interested
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
}
