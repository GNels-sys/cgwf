import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DeckSummary } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "../components/CardImage";
import { RequireUser } from "../components/RequireUser";
import { useUser } from "../user";

function DeckList() {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.decks
      .list()
      .then((r) => setDecks(r.decks))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!decks) return <p className="muted">Loading decks...</p>;
  return (
    <>
      <div className="row-between">
        <h2>Your decks</h2>
        <Link to="/decks/new" className="btn btn-primary">
          + Import a deck
        </Link>
      </div>
      {decks.length === 0 && (
        <div className="notice">
          <p>No decks yet. Paste a list from Archidekt, Moxfield, MTGGoldfish, TappedOut or Arena to get started.</p>
        </div>
      )}
      <ul className="deck-grid">
        {decks.map((d) => (
          <li key={d.id}>
            <Link to={`/decks/${d.id}`} className="deck-tile">
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
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function DecksPage() {
  const { user } = useUser();
  return (
    <main className="page">
      <header className="page-header">
        <h1>CGwF</h1>
        <p className="tagline">{user ? `Hi ${user.displayName}` : "Card Games with Friends"}</p>
      </header>
      <RequireUser>
        <DeckList />
      </RequireUser>
    </main>
  );
}
