import { PerformancePanel } from "../components/PerformancePanel";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ARCHETYPE_LABELS, ARCHETYPE_TAGS, BRACKET_NAMES, type ArchetypeTag, type Bracket, type LibraryDeckDetail } from "@cgwf/shared";
import { api } from "../api";
import { EdhrecCredit } from "../components/EdhrecCredit";
import { AnalysisBody } from "../components/BracketPanel";
import { ShoppingPanel } from "../components/LocalStores";
import { RequireUser } from "../components/RequireUser";
import { StatsPanel } from "../components/StatsPanel";
import { isOwner, useUser } from "../user";

/** Owner-only: one library deck. Edit bracket, tags, primer, agent flag; re-run the analysis. */
function Editor({ id }: { id: string }) {
  const navigate = useNavigate();
  const [deck, setDeck] = useState<LibraryDeckDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bracket, setBracket] = useState<Bracket>(2);
  const [tags, setTags] = useState<ArchetypeTag[]>([]);
  const [primer, setPrimer] = useState("");
  const [agentEligible, setAgentEligible] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  const loadStats = useCallback(() => api.library.stats(id), [id]);
  const loadShopping = useCallback(() => api.singles.libraryShopping(id), [id]);

  const apply = (d: LibraryDeckDetail) => {
    setDeck(d);
    setBracket(d.bracket);
    setTags(d.tags);
    setPrimer(d.primer);
    setAgentEligible(d.agentEligible);
    setName(d.name);
  };

  useEffect(() => {
    api.library
      .get(id)
      .then((r) => apply(r.deck))
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!deck) return <p className="muted">Loading...</p>;

  const dirty = bracket !== deck.bracket || primer !== deck.primer || agentEligible !== deck.agentEligible || name !== deck.name || tags.join(",") !== deck.tags.join(",");

  const save = async () => {
    setBusy("save");
    try {
      const r = await api.library.patch(deck.id, { name, bracket, tags, primer, agentEligible });
      apply(r.deck);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const reanalyze = async () => {
    setBusy("analyze");
    try {
      const r = await api.library.analyze(deck.id);
      setDeck(r.deck);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const skeleton = async () => {
    if (primer.trim() && !confirm("Replace the current primer text with a fresh skeleton?")) return;
    setBusy("skeleton");
    try {
      const r = await api.library.primerSkeleton(deck.id);
      setPrimer(r.primer);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const draft = async () => {
    const force = Boolean(deck.primer.trim());
    if (force && !confirm("Ask Claude to redraft the primer? The current text is replaced (you can still edit before saving).")) return;
    setBusy("draft");
    try {
      const r = await api.library.draftPrimer(deck.id, force);
      setPrimer(r.primer);
      setDraftNote(r.cached ? "Using the primer Claude drafted earlier." : `Drafted by ${r.model} for $${r.costUsd.toFixed(3)}. Review, edit, then Save.`);
    } catch (e) {
      setDraftNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove "${deck.name}" from the library?`)) return;
    await api.library.remove(deck.id);
    navigate("/admin/library");
  };
  const toggleTag = (t: ArchetypeTag) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const a = deck.analysis;
  return (
    <>
      <header className="detail-heading">
        <p className="eyebrow">Library workshop</p>
        <div className="row-between">
          <h1>{deck.name}</h1>
          <div className="actions">
            <button className="btn btn-small" disabled={busy !== null} onClick={() => void reanalyze()}>
              {busy === "analyze" ? "Analysing..." : "Re-analyse"}
            </button>
            <button className="btn btn-small btn-danger" onClick={() => void remove()}>
              Remove
            </button>
          </div>
        </div>
      </header>
      <p className="muted small">
        {deck.commanders.join(" / ") || "no commander"} · {deck.cardCount} cards ·{" "}
        {deck.source === "precon" ? `precon${deck.setCode ? ` (${deck.setCode.toUpperCase()}` : ""}${deck.releaseDate ? `, ${deck.releaseDate})` : ")"}` : deck.source === "edhrec" ? "EDHREC average deck" : "from a player's deck"}
        {a ? ` · engine says floor ${a.floor}, suggested ${a.suggested}` : ""}
      </p>

      <EdhrecCredit deck={deck} />

      <section className="library-edit surface">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
        <label className="field">
          <span>Bracket (your call)</span>
          <select value={bracket} onChange={(e) => setBracket(Number(e.target.value) as Bracket)}>
            {([1, 2, 3, 4, 5] as const).map((b) => (
              <option key={b} value={b}>
                {b} · {BRACKET_NAMES[b]}
              </option>
            ))}
          </select>
        </label>
        <label className="field toggle-field">
          <input type="checkbox" checked={agentEligible} onChange={(e) => setAgentEligible(e.target.checked)} />
          <span>Agent-eligible (Phase 7 opponents may pilot this deck)</span>
        </label>
        <div className="field">
          <span>Archetype tags</span>
          <div className="tag-row">
            {ARCHETYPE_TAGS.map((t) => (
              <button key={t} type="button" className={`chip tag-chip${tags.includes(t) ? " is-selected" : ""}`} onClick={() => toggleTag(t)}>
                {ARCHETYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <div className="row-between">
            <span>Primer (Markdown)</span>
            <span className="actions">
              <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => void skeleton()}>
                {busy === "skeleton" ? "Building..." : "Fill in a skeleton"}
              </button>
              <button type="button" className="btn btn-small btn-primary" disabled={busy !== null} onClick={() => void draft()}>
                {busy === "draft" ? "Drafting..." : "Draft with Claude"}
              </button>
            </span>
          </div>
          {draftNote && <p className="small muted">{draftNote}</p>}
          <textarea value={primer} onChange={(e) => setPrimer(e.target.value)} rows={18} spellCheck={false} placeholder="How this deck wins, what to protect, what to mulligan for. A model may draft this in Phase 7; the headings from the skeleton are what the agent reads." />
        </div>
        <div className="sticky-actions">
          <button className="btn btn-primary" disabled={!dirty || busy !== null} onClick={() => void save()}>
            {busy === "save" ? "Saving..." : saved ? "Saved" : "Save"}
          </button>
        </div>
      </section>

      <div className="analysis-row">
        {a && (
          <section className="bracket-panel">
            <h3>Engine analysis</h3>
            <AnalysisBody a={a} />
          </section>
        )}
        <StatsPanel load={loadStats} version={deck.updatedAt} />
      </div>

      <PerformancePanel deckRef={`library:${deck.id}`} title="Performance (all players)" />

      <ShoppingPanel load={loadShopping} version={deck.updatedAt} />

      <section className="deck-group">
        <h3>Cards</h3>
        <ul className="library-cards">
          {deck.cards.map((c) => (
            <li key={`${c.cardId}-${c.board}`}>
              <span className="qty">{c.quantity}</span> {c.name}
              {c.board !== "main" && <span className="muted small"> · {c.board}</span>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function LibraryDeckPage() {
  const { id } = useParams();
  const { user } = useUser();
  return (
    <main className="page library-deck-page">
      <p>
        <Link to="/admin/library" className="muted small">
          &larr; Library
        </Link>
      </p>
      <RequireUser>{isOwner(user) ? id && <Editor id={id} /> : <p className="muted">The library is for the owner only.</p>}</RequireUser>
    </main>
  );
}
