import { useEffect, useState } from "react";
import { type CardSummary, type DeckSizeRule } from "@cgwf/shared";
import { api } from "../api";
import { ManaCost } from "./ManaCost";
import { copiesInDeck, type DraftState } from "./deckDraft";

/** The editor's sticky bar: the running count against 100 (or "no maximum" under Whtz), Undo, Cancel and Save. */
export function DeckEditBar({ total, rule, lastChange, error, saving, onUndo, onCancel, onSave }: {
  total: number;
  rule: DeckSizeRule;
  lastChange: string | null;
  error: string | null;
  saving: boolean;
  onUndo: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  // Positive = too many, negative = short, 0 = fine.
  const off = total < rule.min ? total - rule.min : rule.max !== null && total > rule.max ? total - rule.max : 0;
  return (
    <div className="deck-edit-bar" role="region" aria-label="Editing the deck">
      <div className="deck-edit-count" aria-live="polite">
        <strong className={off === 0 ? "is-ok" : "is-off"}>{total}</strong>
        {rule.max === null ? <span> cards · at least {rule.min}, no maximum</span> : <span> / {rule.max} cards</span>}
        {off !== 0 && <span className="small deck-edit-off">{off > 0 ? `${off} too many` : `${-off} to add`}</span>}
        {rule.max === null && rule.grantedBy && <span className="small muted deck-edit-rule">({rule.grantedBy})</span>}
      </div>
      <div className="deck-edit-actions">
        <button type="button" className="btn btn-small" onClick={onUndo} disabled={!lastChange} title={lastChange ? `Undo: ${lastChange}` : "Nothing to undo"}>
          ↶ Undo{lastChange ? <span className="deck-edit-undo-what">: {lastChange}</span> : null}
        </button>
        <button type="button" className="btn btn-small" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
      {error && (
        <p className="deck-edit-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Search the card data and add a card to the deck (one copy per tap). */
export function AddCardSearch({ draft, onAdd, onOpen }: { draft: DraftState; onAdd: (card: CardSummary) => void; onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CardSummary[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    const ctrl = new AbortController();
    setStatus("loading");
    const t = setTimeout(() => {
      api
        .search(query, false, ctrl.signal)
        .then((r) => {
          setResults(r.results.slice(0, 8));
          setStatus("idle");
        })
        .catch((e: Error) => {
          if (e.name !== "AbortError") setStatus("error");
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);
  return (
    <div className="deck-add">
      <label className="deck-add-label" htmlFor="deck-add-search">
        Add a card
      </label>
      <input id="deck-add-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by card name" autoComplete="off" />
      {status === "error" && <p className="small error">Search failed. Try again.</p>}
      {q.trim().length >= 2 && status === "idle" && results.length === 0 && <p className="small muted">No cards match.</p>}
      {results.length > 0 && (
        <ul className="deck-add-results">
          {results.map((c) => {
            const have = copiesInDeck(draft, c);
            return (
              <li key={c.id}>
                <button type="button" className="deck-add-name" onClick={() => onOpen(c.id)} title="Read the card">
                  <strong>{c.name}</strong>
                  <span className="small muted">{c.typeLine}</span>
                </button>
                <ManaCost cost={c.manaCost} size={12} />
                {have > 0 && <span className="small deck-add-have">In deck ×{have}</span>}
                <button type="button" className="btn btn-small deck-add-btn" onClick={() => onAdd(c)} aria-label={`Add ${c.name} to the deck`}>
                  + Add
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
