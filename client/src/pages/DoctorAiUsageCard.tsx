import { useEffect, useState } from "react";
import type { DoctorAiUsage } from "@cgwf/shared";
import { api } from "../api";

/** Admin: Deck Doctor AI upgrade spend (owner only; runs are rows in doctor_ai_runs). */
export function DoctorAiUsageCard() {
  const [u, setU] = useState<DoctorAiUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.doctor
      .aiUsage()
      .then(setU)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <section className="surface admin-card"><p className="small error">Deck Doctor AI: {error}</p></section>;
  if (!u) return null;
  return (
    <section className="surface admin-card doctor-ai-usage" aria-label="Deck Doctor AI usage">
      <h2>Deck Doctor AI</h2>
      <p className="small muted">
        {u.enabled ? "On" : "Off (DOCTOR_AI_ENABLED)"} · {u.model} · caps ${u.maxUsdPerRun.toFixed(2)} a run, ${u.maxUsdPerDay.toFixed(2)} a day · today ${u.todayUsd.toFixed(2)} · last 30 days ${u.last30Usd.toFixed(2)}
      </p>
      {u.runs.length === 0 ? (
        <p className="small muted">No runs yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Deck</th>
                <th>Status</th>
                <th>Calls</th>
                <th>Tokens in / out</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {u.runs.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.startedAt).toLocaleString()}</td>
                  <td>{r.deckName}</td>
                  <td title={r.error ?? undefined}>{r.status}</td>
                  <td>{r.calls}</td>
                  <td>
                    {(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens).toLocaleString()} / {r.outputTokens.toLocaleString()}
                  </td>
                  <td>${r.costUsd.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
