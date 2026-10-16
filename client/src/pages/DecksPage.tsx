import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BRACKET_NAMES, PIP_COLORS, PIP_COLOR_NAMES, type DeckSummary } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "../components/CardImage";
import { deckScenery } from "../components/deckScenery";
import { loadDeckMetrics, sortDecks, type DeckMetrics, type DeckSort } from "../components/deckMetrics";
import { RequireUser } from "../components/RequireUser";
import { Tour } from "../components/Tour";
import { useUser } from "../user";

function DeckTileMetrics({ value }: { value: DeckMetrics | undefined }) {
  const bracket = value?.bracket;
  const pips = value?.pips;
  return <div className="deck-tile-metrics">
    <span className="deck-bracket" title="Suggested bracket from deck analysis">
      {bracket ? `B${bracket} · ${BRACKET_NAMES[bracket]}` : value ? "Bracket unavailable" : "Bracket loading…"}
    </span>
    {pips ? <>
      <span className="deck-pip-total"><strong>{pips.coloredTotal.toLocaleString()}</strong> mana pips</span>
      <span className="deck-pip-breakdown">
        {PIP_COLORS.filter((c) => pips.colored[c] > 0).map((c) => <span key={c} aria-label={`${PIP_COLOR_NAMES[c]}: ${pips.colored[c]}`} title={PIP_COLOR_NAMES[c]}><i style={{ background: `var(--mana-${c})` }} aria-hidden="true" />{c} {pips.colored[c].toLocaleString()}</span>)}
      </span>
      <span className="muted small">+ {pips.generic.toLocaleString()} generic mana</span>
    </> : <span className="muted small">{value ? "Mana pips unavailable" : "Counting mana pips…"}</span>}
  </div>;
}

function DeckList() {
  const { user } = useUser();
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, DeckMetrics>>({});
  const [bracket, setBracket] = useState("all");
  const [sort, setSort] = useState<DeckSort>("updated");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setDecks(null);
    setMetrics({});
    setError(null);
    api.decks
      .list()
      .then((r) => { if (!cancelled) setDecks(r.decks); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [user?.id]);

  useEffect(() => {
    if (!decks || !user) return;
    let cancelled = false;
    const userId = user.id;
    async function load() {
      for (const deck of decks!) {
        if (cancelled) break;
        const result = await loadDeckMetrics(userId, deck).catch(() => ({ bracket: null, pips: null }));
        if (!cancelled) setMetrics((previous) => ({ ...previous, [deck.id]: result }));
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [decks, user?.id, attempt]);

  if (error) return <p className="error">{error}</p>;
  if (!decks) return <p className="muted">Loading decks...</p>;
  const pending = decks.filter((d) => !metrics[d.id]).length;
  const failed = decks.some((d) => { const value = metrics[d.id]; return value && (!value.bracket || !value.pips); });
  const visible = sortDecks(decks.filter((d) => bracket === "all" || (bracket === "unavailable"
    ? metrics[d.id]?.bracket === null : metrics[d.id]?.bracket === Number(bracket))), metrics, sort);
  return (
    <>
      <div className="row-between">
        <h2>Your decks</h2>
        <Link to="/decks/new" className="btn btn-primary">
          + Import a deck
        </Link>
      </div>
      {decks.length > 0 && <div className="deck-collection-controls">
        <div className="deck-collection-fields">
          <label>Bracket
            <select aria-label="Bracket" value={bracket} onChange={(e) => setBracket(e.target.value)}>
              <option value="all">All brackets</option>
              {([1, 2, 3, 4, 5] as const).map((b) => <option key={b} value={b}>B{b} · {BRACKET_NAMES[b]} ({decks.filter((d) => metrics[d.id]?.bracket === b).length})</option>)}
              <option value="unavailable">Bracket unavailable</option>
            </select>
          </label>
          <label>Sort by
            <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as DeckSort)}>
              <option value="updated">Recently updated</option>
              <option value="bracket-asc">Bracket: low to high</option>
              <option value="bracket-desc">Bracket: high to low</option>
              <option value="pips">Mana pips: high to low</option>
              <option value="name">Deck name: A–Z</option>
            </select>
          </label>
          <span className="muted small" role="status">{visible.length} of {decks.length} decks{pending > 0 ? ` · Analysing ${pending} remaining…` : ""}</span>
        </div>
        <p className="muted small">Suggested brackets help compare power. Mana pips show mana requirements, not a power score.</p>
        {failed && <p className="small">Some values are unavailable. <button className="btn btn-small" onClick={() => setAttempt((n) => n + 1)}>Retry values</button></p>}
      </div>}
      {decks.length === 0 && (
        <div className="notice">
          <p>No decks yet. Paste a list from Archidekt, Moxfield, MTGGoldfish, TappedOut or Arena to get started.</p>
        </div>
      )}
      <ul className="deck-grid">
        {visible.map((d) => (
          <li key={d.id}>
            <Link to={`/decks/${d.id}`} className="deck-tile" data-realm={deckScenery(d.id)}>
              <div className={`deck-tile-art n${Math.min(d.commanders.length, 2)}`}>
                {d.commanders.length === 0 && <div className="deck-tile-blank">No commander</div>}
                {d.commanders.slice(0, 2).map((c) => (
                  <CardImage key={c.id} id={c.id} name={c.name} size="normal" />
                ))}
              </div>
              <span className="deck-tile-name">{d.name}</span>
              <span className="muted small">
                {d.commanders.map((c) => c.name).join(" / ") || "Commander"} &middot; {d.cardCount} cards
              </span>
              <DeckTileMetrics value={metrics[d.id]} />
            </Link>
          </li>
        ))}
      </ul>
      {decks.length > 0 && visible.length === 0 && <p className="notice">{pending > 0 ? "Checking decks for this bracket…" : "No decks in this bracket."}</p>}
    </>
  );
}

export function DecksPage() {
  const { user } = useUser();
  return (
    <main className="page collection-page">
      <header className="collection-hero">
        <p className="eyebrow">Your collection · Your possibilities</p>
        <h1>{user ? `Welcome back, ${user.displayName}.` : "Card Games with Friends"}</h1>
        <p className="tagline">Choose your deck. Gather your friends. Make a little history.</p>
        <Link to="/play" className="btn btn-primary">Find your table <span aria-hidden="true">↗</span></Link>
      </header>
      <RequireUser>
        <Tour />
        <DeckList />
      </RequireUser>
    </main>
  );
}
