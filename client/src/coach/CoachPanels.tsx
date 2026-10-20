import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CoachAdminResponse, CoachGameRow } from "@cgwf/shared";
import { api } from "../api";
import { useCoachEnabled } from "./coach";

/** Deck stats page (owner, coach on): the owner's finished games, losses first, each with "Coach me". */
export function CoachGamesPanel() {
  const on = useCoachEnabled();
  const [games, setGames] = useState<CoachGameRow[] | null>(null);
  useEffect(() => {
    if (!on) return;
    api.coach
      .games()
      .then((r) => setGames(r.games))
      .catch(() => setGames([]));
  }, [on]);
  if (!on) return null;
  return (
    <section className="surface coach-games" aria-label="AI Coach">
      <h2>AI Coach</h2>
      <p className="muted small">Your finished rules-engine games, losses first. Games from before 2026-10-19 get a lighter review (no decision record).</p>
      {games && games.length === 0 && <p className="muted">No finished games yet.</p>}
      {games && games.length > 0 && (
        <ul className="coach-game-list">
          {games.slice(0, 12).map((g) => (
            <li key={g.code}>
              <span className={g.won ? "coach-win" : "coach-loss"}>{g.won ? "Won" : `Lost (${g.place ?? "?"}/${g.playerCount})`}</span>
              <span className="muted small">
                {g.code} · {g.deckName}
                {g.test ? " · test" : ""}
              </span>
              <Link className="btn btn-small" to={`/coach/${g.code}`}>
                {g.report ? (g.report.status === "done" ? "Read report" : "Report…") : "Coach me"}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Owner's Admin page: coach spend per report and today. */
export function CoachUsageCard() {
  const [d, setD] = useState<CoachAdminResponse | null>(null);
  useEffect(() => {
    api.coach
      .admin()
      .then(setD)
      .catch(() => setD(null));
  }, []);
  if (!d) return null;
  return (
    <section className="admin-coach" aria-label="AI Coach spend">
      <p className="small">
        <strong>AI Coach.</strong> {d.enabled ? `On (${d.model})` : "Off (COACH_AI_ENABLED not set)"} · today ${d.spentTodayUsd.toFixed(2)} of ${d.limits.maxUsdPerDay} · per report cap ${d.limits.maxUsdPerReport}
      </p>
      {d.reports.length > 0 && (
        <table className="admin-coach-table small">
          <thead>
            <tr>
              <th scope="col">Table</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Calls</th>
              <th scope="col">Tokens in / out / cache read / write</th>
              <th scope="col">Report $</th>
              <th scope="col">Follow-ups $</th>
            </tr>
          </thead>
          <tbody>
            {d.reports.slice(0, 20).map((r) => (
              <tr key={r.code}>
                <td>
                  <Link to={`/coach/${r.code}`}>{r.code}</Link>
                </td>
                <td>{r.kind}</td>
                <td>{r.status}</td>
                <td>{r.calls}</td>
                <td>
                  {r.inputTokens} / {r.outputTokens} / {r.cacheReadTokens} / {r.cacheWriteTokens}
                </td>
                <td>{r.costUsd.toFixed(3)}</td>
                <td>
                  {r.followups} · {r.followupUsd.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
