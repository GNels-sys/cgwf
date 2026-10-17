import { PageHeading } from "../components/PageHeading";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AgentGamesResponse } from "@cgwf/shared";
import { api } from "../api";
import { RequireUser } from "../components/RequireUser";
import { isOwner, useUser } from "../user";

/** Owner-only: computer-opponent status, caps, today's spend and recent agent games. */
function Games() {
  const [data, setData] = useState<AgentGamesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.agents
      .games()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  const s = data.status;
  return (
    <>
      <div className="notice">
        <p>
          <strong>{s.enabled ? "Agents are on" : "Agents are off"}</strong>
          {s.enabled && (s.dryRun ? " · dry run (no API key: scripted play, no cost)" : ` · ${s.model}`)}
        </p>
        <p className="small muted">
          Caps: ${s.maxUsdPerGame.toFixed(2)} per game, ${s.maxUsdPerDay.toFixed(2)} per day. Spent today: ${s.todayUsd.toFixed(3)}.
        </p>
        <p className="small muted">
          To play against agents: open a table, sit down with a deck, then "Add computer opponents" in the lobby. Decks come from the Library's agent-eligible list.
        </p>
      </div>
      <h3>Recent agent games</h3>
      {data.games.length === 0 ? (
        <div className="empty-state"><span className="empty-state-mark" aria-hidden="true">◇</span><h2>A little company for your next game.</h2><p className="muted">None yet. Add computer opponents from a table lobby to begin.</p></div>
      ) : (
        <ul className="library-list">
          {data.games.map((g) => (
            <li key={g.roomId}>
              <Link to={`/room/${g.code}`} className="library-row">
                <span className="bracket-pill">{g.code}</span>
                <span className="library-row-main">
                  <span className="library-row-name">
                    {g.agents} agent{g.agents === 1 ? "" : "s"} · {g.deckNames.join(", ")}
                  </span>
                  <span className="muted small">
                    {g.status} · {new Date(g.startedAt).toLocaleString()} · {g.decisions} decisions · ${g.costUsd.toFixed(3)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function AgentsPage() {
  const { user } = useUser();
  return (
    <main className="page agents-page">
      <RequireUser>
        <PageHeading title="Computer opponents" eyebrow="The other seats at the table">Review activity, recent games, and your play budget.</PageHeading>
        {isOwner(user) ? <Games /> : <p className="muted">Owner only.</p>}
      </RequireUser>
    </main>
  );
}
