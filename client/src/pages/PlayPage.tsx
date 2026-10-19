import { PageHeading } from "../components/PageHeading";
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
  const [engineAvailable, setEngineAvailable] = useState(false);
  const [useEngine, setUseEngine] = useState(false);

  useEffect(() => {
    api.rooms
      .mine()
      .then((r) => setRecent(r.rooms))
      .catch(() => setRecent([]));
    api
      .features()
      .then((f) => setEngineAvailable(f.engine))
      .catch(() => setEngineAvailable(false));
  }, []);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.rooms.create(useEngine && engineAvailable ? { engine: true } : {});
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
      <div className="play-options">
        <section className="surface play-create">
          <p className="eyebrow">01 · Host a game</p>
          <h2>A table for your friends.</h2>
          <p className="muted">Choose your deck in the lobby, then share the table code.</p>
          <fieldset className="table-kind" aria-label="Kind of table">
            {engineAvailable && (
              <label className={`table-kind-opt is-engine${useEngine ? " is-on" : ""}`}>
                <input type="radio" name="table-kind" checked={useEngine} onChange={() => setUseEngine(true)} />
                <span>
                  <span className="mode-glyph" aria-hidden="true">◇</span><strong>Rules engine (beta)</strong>
                  <span className="muted small">The rules are enforced: one land per turn, mana, the stack, combat, untap and draw happen on their own. Decks must be legal Commander decks.</span>
                </span>
              </label>
            )}
            <label className={`table-kind-opt${!useEngine || !engineAvailable ? " is-on" : ""}`}>
              <input type="radio" name="table-kind" checked={!useEngine || !engineAvailable} onChange={() => setUseEngine(false)} />
              <span>
                <span className="mode-glyph" aria-hidden="true">✦</span><strong>Casual (no rules)</strong>
                <span className="muted small">Nothing is enforced: like a real table, players move, tap and count land drops themselves. Any deck.</span>
              </span>
            </label>
          </fieldset>
          {useEngine && engineAvailable && <div className="rules-capabilities" aria-label="Rules engine features"><span>Mana & timing</span><span>Combat & stack</span><span>Legal Commander</span></div>}
          <button className="btn btn-primary btn-big" onClick={() => void create()} disabled={busy}>
            {useEngine && engineAvailable ? "New rules-engine table" : "New casual table"}
          </button>
        </section>
        <section className="surface play-join">
          <p className="eyebrow">02 · Take your seat</p>
          <h2>Have an invitation?</h2>
          <p className="muted">Enter your friend's six-character table code.</p>
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
        </section>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted small">
        A table holds up to four players plus spectators. Share the code or the link; nobody needs an account. <Link to="/settings">Personalize</Link> your playmat and sleeves before you sit down.
      </p>

      {recent.length > 0 && (
        <>
          <h3>Recent tables</h3>
          <ul className="room-list">
            {recent.map((r) => (
              <li key={r.code}>
                <Link to={`/room/${r.code}`} className="room-row">
                  <span className="room-code">{r.code}</span>
                  <span className={`table-kind-tag${r.engine ? " is-engine" : ""}`}>{r.engine ? "Rules engine" : "Casual (no rules)"}</span>
                  <span className="muted small">
                    {r.status === "lobby" ? "Waiting" : r.status === "playing" ? "In progress" : "Finished"} &middot; {r.players} player{r.players === 1 ? "" : "s"} &middot; host {r.hostName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {recent.length === 0 && <div className="empty-state compact-empty"><span className="empty-state-mark" aria-hidden="true">◇</span><h2>Your next game starts here.</h2><p className="muted">Recent tables will appear here, ready for you to rejoin.</p></div>}
    </>
  );
}

export function PlayPage() {
  return (
    <main className="page play-page">
      <PageHeading title="Play" eyebrow="Gather around the table" illustrated>Open a table for your friends, or take your seat with a join code.</PageHeading>
      <RequireUser>
        <PlayHome />
      </RequireUser>
    </main>
  );
}
