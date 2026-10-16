import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { MyRoomsResponse } from "@cgwf/shared";
import { api } from "../api";
import { RequireUser } from "../components/RequireUser";

/** Play home: start a table, join one by code, or go back to a recent one. */
function PlayHome() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<MyRoomsResponse["rooms"]>([]);

  useEffect(() => {
    api.rooms
      .mine()
      .then((r) => setRecent(r.rooms))
      .catch(() => setRecent([]));
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.rooms.create();
      navigate(`/room/${r.room.code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const join = async (e: FormEvent) => {
    e.preventDefault();
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length !== 6) {
      setError("A join code has 6 letters or numbers.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.rooms.join(clean);
      navigate(`/room/${clean}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="play-actions">
        <button className="btn btn-primary btn-big" onClick={() => void create()} disabled={busy}>
          New table
        </button>
        <form className="inline-field" onSubmit={(e) => void join(e)}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Join code"
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label="Join code"
          />
          <button className="btn" type="submit" disabled={busy}>
            Join
          </button>
        </form>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted small">A table holds up to four players plus spectators. Share the code or the link; nobody needs an account.</p>

      {recent.length > 0 && (
        <>
          <h3>Recent tables</h3>
          <ul className="room-list">
            {recent.map((r) => (
              <li key={r.code}>
                <Link to={`/room/${r.code}`} className="room-row">
                  <span className="room-code">{r.code}</span>
                  <span className="muted small">
                    {r.status === "lobby" ? "Waiting" : r.status === "playing" ? "In progress" : "Finished"} &middot; {r.players} player{r.players === 1 ? "" : "s"} &middot; host {r.hostName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function PlayPage() {
  return (
    <main className="page narrow">
      <h1>Play</h1>
      <RequireUser>
        <PlayHome />
      </RequireUser>
    </main>
  );
}
