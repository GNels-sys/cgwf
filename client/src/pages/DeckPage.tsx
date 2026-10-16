import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Board, DeckCardEntry, DeckDetail } from "@cgwf/shared";
import { api } from "../api";
import { CardDetail } from "../components/CardDetail";
import { CardImage } from "../components/CardImage";
import { ManaCost } from "../components/ManaCost";
import { RequireUser } from "../components/RequireUser";

const TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Other"] as const;

function primaryType(typeLine: string): (typeof TYPE_ORDER)[number] {
  const front = typeLine.split(" // ")[0] ?? typeLine;
  for (const t of TYPE_ORDER) if (t !== "Other" && new RegExp(`\\b${t}\\b`).test(front)) return t;
  return "Other";
}

function groupByType(entries: DeckCardEntry[]) {
  const groups = new Map<string, DeckCardEntry[]>();
  for (const e of entries) {
    const t = primaryType(e.card.typeLine);
    const list = groups.get(t) ?? [];
    list.push(e);
    groups.set(t, list);
  }
  return TYPE_ORDER.filter((t) => groups.has(t)).map((t) => ({ type: t, entries: groups.get(t)!.sort((a, b) => a.card.name.localeCompare(b.card.name)) }));
}

function CardLine({ entry, onOpen }: { entry: DeckCardEntry; onOpen: (id: string) => void }) {
  return (
    <li>
      <button className="deck-card-line" onClick={() => onOpen(entry.card.id)}>
        <span className="qty">{entry.quantity}</span>
        <span className="deck-card-name">{entry.card.name}</span>
        <ManaCost cost={entry.card.manaCost} size={13} />
      </button>
    </li>
  );
}

function DeckView({ id }: { id: string }) {
  const navigate = useNavigate();
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    api.decks
      .get(id)
      .then((r) => setDeck(r.deck))
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const sections = useMemo(() => {
    if (!deck) return null;
    const by = (b: Board) => deck.cards.filter((c) => c.board === b);
    return {
      commanders: by("commander"),
      main: groupByType(by("main")),
      companion: by("companion"),
      sideboard: by("sideboard"),
      maybeboard: by("maybeboard"),
    };
  }, [deck]);

  if (error) return <p className="error">{error}</p>;
  if (!deck || !sections) return <p className="muted">Loading deck...</p>;

  const rename = async () => {
    const r = await api.decks.rename(deck.id, newName);
    setDeck(r.deck);
    setRenaming(false);
  };
  const remove = async () => {
    if (!confirm(`Delete "${deck.name}"? This cannot be undone.`)) return;
    await api.decks.remove(deck.id);
    navigate("/");
  };

  return (
    <>
      <div className="row-between">
        {renaming ? (
          <form
            className="inline-field"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} autoFocus />
            <button className="btn btn-small" type="submit">
              Save
            </button>
            <button className="btn btn-small" type="button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <h1>{deck.name}</h1>
        )}
        <div className="actions">
          <button
            className="btn btn-small"
            onClick={() => {
              setNewName(deck.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <button className="btn btn-small btn-danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>
      <p className="muted small">
        {deck.cardCount} cards &middot; Commander
        {deck.sourceUrl && (
          <>
            {" "}
            &middot;{" "}
            <a href={deck.sourceUrl} target="_blank" rel="noreferrer">
              source
            </a>
          </>
        )}
      </p>

      {deck.warnings.length > 0 && (
        <div className="notice warn-box">
          <strong>Heads up</strong>
          <ul>
            {deck.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="commanders">
        {sections.commanders.map((c) => (
          <button key={c.cardId} className="commander-card" onClick={() => setOpen(c.card.id)}>
            <CardImage id={c.card.id} name={c.card.name} size="normal" loading="eager" />
            <span>{c.card.name}</span>
          </button>
        ))}
      </section>

      <div className="deck-columns">
        {sections.main.map((g) => (
          <section key={g.type} className="deck-group">
            <h3>
              {g.type} <span className="muted">({g.entries.reduce((n, e) => n + e.quantity, 0)})</span>
            </h3>
            <ul>
              {g.entries.map((e) => (
                <CardLine key={e.cardId + e.board} entry={e} onOpen={setOpen} />
              ))}
            </ul>
          </section>
        ))}
        {(["companion", "sideboard", "maybeboard"] as const).map((b) =>
          sections[b].length ? (
            <section key={b} className="deck-group">
              <h3>{b[0]!.toUpperCase() + b.slice(1)}</h3>
              <ul>
                {sections[b].map((e) => (
                  <CardLine key={e.cardId + e.board} entry={e} onOpen={setOpen} />
                ))}
              </ul>
            </section>
          ) : null,
        )}
      </div>

      {open && <CardDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function DeckPage() {
  const { id } = useParams();
  return (
    <main className="page">
      <p>
        <Link to="/" className="muted small">
          &larr; All decks
        </Link>
      </p>
      <RequireUser>{id && <DeckView id={id} />}</RequireUser>
    </main>
  );
}
