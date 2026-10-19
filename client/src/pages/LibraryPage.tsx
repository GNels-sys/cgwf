import { PageHeading } from "../components/PageHeading";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ARCHETYPE_LABELS, ARCHETYPE_TAGS, BRACKET_NAMES, type LibraryDeckSummary, type LibraryImportState, type SubmissionInfo } from "@cgwf/shared";
import { api } from "../api";
import { EdhrecCredit } from "../components/EdhrecCredit";
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

/** Owner: decks players submitted for the agent library. Approve copies the frozen list in; reject sends a short reason. */
function SubmissionQueue({ onChanged }: { onChanged: () => void }) {
  const [subs, setSubs] = useState<SubmissionInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      setSubs((await api.social.queue()).submissions);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (s: SubmissionInfo) => {
    setBusy(s.id);
    setError(null);
    try {
      await api.social.approve(s.id);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const reject = async (s: SubmissionInfo) => {
    setBusy(s.id);
    setError(null);
    try {
      await api.social.reject(s.id, reason);
      setRejecting(null);
      setReason("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!subs) return null;
  const pending = subs.filter((s) => s.status === "pending");
  const decided = subs.filter((s) => s.status !== "pending");
  return (
    <section className="notice queue-admin">
      <div className="row-between">
        <strong>Agent deck queue</strong>
        <span className="muted small">{pending.length === 0 ? "nothing waiting" : `${pending.length} waiting`}</span>
      </div>
      {error && <p className="error small">{error}</p>}
      {pending.length > 0 && (
        <ul className="queue-list">
          {pending.map((s) => (
            <li key={s.id}>
              <div className="queue-main">
                <strong>{s.deckName}</strong>{" "}
                <span className="muted small">
                  from {s.submitter.name} &middot; {s.commanders.join(" / ") || "no commander"} &middot; {s.cardCount} cards
                  {s.bracketSuggested ? ` · engine suggests B${s.bracketSuggested}` : ""} &middot; {new Date(s.createdAt).toLocaleDateString()}
                </span>
                {s.tags && s.tags.length > 0 && (
                  <span className="library-row-tags">
                    {s.tags.slice(0, 4).map((t) => (
                      <span key={t} className="chip tag-chip small">
                        {ARCHETYPE_LABELS[t]}
                      </span>
                    ))}
                  </span>
                )}
                {s.note && <p className="small queue-note">&ldquo;{s.note}&rdquo;</p>}
              </div>
              {rejecting === s.id ? (
                <form
                  className="inline-field"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void reject(s);
                  }}
                >
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Short reason for the player" maxLength={300} autoFocus required />
                  <button className="btn btn-small btn-danger" type="submit" disabled={busy === s.id || !reason.trim()}>
                    Reject
                  </button>
                  <button className="btn btn-small" type="button" onClick={() => setRejecting(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <span className="actions">
                  <button className="btn btn-small btn-primary" disabled={busy === s.id} onClick={() => void approve(s)}>
                    {busy === s.id ? "Adding..." : "Approve"}
                  </button>
                  <button className="btn btn-small" disabled={busy === s.id} onClick={() => setRejecting(s.id)}>
                    Reject
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <details>
          <summary className="small">Recent decisions ({decided.length})</summary>
          <ul className="small queue-decided">
            {decided.map((s) => (
              <li key={s.id}>
                {s.status === "approved" ? "Approved" : "Rejected"}: <strong>{s.deckName}</strong> from {s.submitter.name}
                {s.reason ? ` (${s.reason})` : ""}
                {s.libraryDeckId && (
                  <>
                    {" "}
                    &middot; <Link to={`/admin/library/${s.libraryDeckId}`}>library</Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">Approving copies the list as submitted into the library, agent-eligible, with the engine&apos;s bracket and tags, credited to the player. You can still edit it afterwards.</p>
    </section>
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
      <SubmissionQueue onChanged={() => void load()} />
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
          <option value="">All sources</option>
          <option value="precon">Precons</option>
          <option value="edhrec">EDHREC averages</option>
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
        <div className="empty-state"><span className="empty-state-mark" aria-hidden="true">◇</span><h2>Make room for a few favorites.</h2><p className="muted">Nothing here yet. Import the precons, or open one of your decks and press "Add to library".</p></div>
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
                      {d.releaseDate ? ` · ${d.releaseDate.slice(0, 4)}` : ""}
                      {d.createdByName ? ` · from ${d.createdByName}` : ""} · {d.cardCount} cards
                      {d.floor !== null && d.suggested !== null ? ` · floor ${d.floor}, suggested ${d.suggested}` : ""}
                    </span>
                    <EdhrecCredit deck={d} compact />
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
    <main className="page library-page">
      <RequireUser>
        <PageHeading title="Deck library" eyebrow="A shelf of possibilities">Browse preconstructed decks and player lists. Prepare the next table.</PageHeading>
        {isOwner(user) ? <LibraryList /> : <p className="muted">The library is for the owner only.</p>}
      </RequireUser>
    </main>
  );
}
