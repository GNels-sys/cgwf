import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ARCHETYPE_LABELS, ARCHETYPE_TAGS, BRACKET_NAMES, type LibraryDeckSummary, type LibraryImportState } from "@cgwf/shared";
import { api } from "../api";
import { RequireUser } from "../components/RequireUser";
import { isOwner, useUser } from "../user";

/**
 * Owner-only: the deck library (precons + hand-picked decks) with bracket and
 * archetype filters, the "Import precons" background job, and links to edit.
 */
function ImportBox({ state, onStart }: { state: LibraryImportState; onStart: (force: boolean) => void }) {
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  return (
    <div className="notice">
      <div className="row-between">
        <div>
          <strong>Commander precons</strong>{" "}
          <span className="muted small">
            from{" "}
            <a href="https://mtgjson.com" target="_blank" rel="noreferrer">
              MTGJSON
            </a>
          </span>
          {state.running ? (
            <p className="small">
              Importing {state.done}/{state.total} ({state.imported} new, {state.skipped} already here)...
            </p>
          ) : state.phase === "done" ? (
            <p className="small">
              Last run: {state.imported} imported, {state.skipped} skipped, {state.errors.length} problems.
            </p>
          ) : state.phase === "error" ? (
            <p className="small error">Import failed: {state.error}</p>
          ) : (
            <p className="small muted">Adds every Commander preconstructed decklist (about 200) at Bracket 2. Already-imported decks are skipped.</p>
          )}
        </div>
        <button className="btn btn-primary btn-small" disabled={state.running} onClick={() => onStart(false)}>
          {state.running ? "Importing..." : "Import precons"}
        </button>
      </div>
      {state.running && (
        <div className="progress" aria-label="import progress">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
        </div>
      )}
      {state.errors.length > 0 && (
        <details>
          <summary className="small">{state.errors.length} problems</summary>
          <ul className="small">
            {state.errors.slice(0, 40).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function LibraryList() {
  const [decks, setDecks] = useState<LibraryDeckSummary[] | null>(null);
  const [state, setState] = useState<LibraryImportState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bracket, setBracket] = useState(0);
  const [tag, setTag] = useState("");
  const [source, setSource] = useState("");
  const [agent, setAgent] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.library.list({ bracket, tag, source, agent, q });
      setDecks(r.decks);
      setState(r.importState);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [bracket, tag, source, agent, q]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while an import runs.
  useEffect(() => {
    if (!state?.running) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [state?.running, load]);

  const start = async (force: boolean) => {
    try {
      const r = await api.library.importPrecons({ force });
      setState(r.importState);
      setTimeout(() => void load(), 500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <p className="error">{error}</p>;
  return (
    <>
      {state && <ImportBox state={state} onStart={(f) => void start(f)} />}
      <div className="library-filters">
        <select value={bracket} onChange={(e) => setBracket(Number(e.target.value))} aria-label="Bracket">
          <option value={0}>Any bracket</option>
          {([1, 2, 3, 4, 5] as const).map((b) => (
            <option key={b} value={b}>
              Bracket {b} · {BRACKET_NAMES[b]}
            </option>
          ))}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Archetype">
          <option value="">Any archetype</option>
          {ARCHETYPE_TAGS.map((t) => (
            <option key={t} value={t}>
              {ARCHETYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          <option value="">Precons + mine</option>
          <option value="precon">Precons</option>
          <option value="user">Mine</option>
        </select>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent eligible">
          <option value="">Any</option>
          <option value="1">Agent-eligible</option>
          <option value="0">Not eligible</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / commander / set" aria-label="Search" />
      </div>
      {!decks ? (
        <p className="muted">Loading library...</p>
      ) : decks.length === 0 ? (
        <p className="muted">Nothing here yet. Import the precons, or open one of your decks and press "Add to library".</p>
      ) : (
        <>
          <p className="muted small">{decks.length} decks</p>
          <ul className="library-list">
            {decks.map((d) => (
              <li key={d.id}>
                <Link to={`/admin/library/${d.id}`} className="library-row">
                  <span className={`bracket-pill b${d.bracket}`}>B{d.bracket}</span>
                  <span className="library-row-main">
                    <span className="library-row-name">{d.name}</span>
                    <span className="muted small">
                      {d.commanders.join(" / ") || "no commander"}
                      {d.setCode ? ` · ${d.setCode.toUpperCase()}` : ""}
                      {d.releaseDate ? ` · ${d.releaseDate.slice(0, 4)}` : ""} · {d.cardCount} cards
                      {d.floor !== null && d.suggested !== null ? ` · floor ${d.floor}, suggested ${d.suggested}` : ""}
                    </span>
                  </span>
                  <span className="library-row-tags">
                    {d.tags.slice(0, 3).map((t) => (
                      <span key={t} className="chip tag-chip small">
                        {ARCHETYPE_LABELS[t]}
                      </span>
                    ))}
                    {d.agentEligible && <span className="chip tag-chip small is-selected">agent</span>}
                    {d.hasPrimer && <span className="chip tag-chip small">primer</span>}
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

export function LibraryPage() {
  const { user } = useUser();
  return (
    <main className="page">
      <RequireUser>
        <div className="row-between">
          <h1>Deck library</h1>
        </div>
        {isOwner(user) ? <LibraryList /> : <p className="muted">The library is for the owner only.</p>}
      </RequireUser>
    </main>
  );
}
