import { useEffect, useState } from "react";
import { BRACKET_NAMES, LIBRARY_DECK_PREFIX, deckOptionLabel, type Bracket, type DeckOptionsResponse } from "@cgwf/shared";
import { api } from "../api";

const BRACKETS: Bracket[] = [1, 2, 3, 4, 5];

/**
 * The lobby's deck choice: a bracket filter, then one of your own decks OR a deck from the shared
 * deck library (try a precon before buying it). Two separate lists; picking in one clears the other,
 * because the seat holds one deck. Both lists are alphabetical; "Any bracket" also lists decks whose
 * bracket is not known.
 */
export function DeckPicker({ deckId, onPick }: { deckId: string | null; onPick: (deckId: string | null) => void }) {
  const [bracket, setBracket] = useState<number | null>(null);
  const [opts, setOpts] = useState<DeckOptionsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    api.rooms
      .deckOptions(bracket)
      .then((r) => live && setOpts(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [bracket]);

  const fromLibrary = deckId?.startsWith(LIBRARY_DECK_PREFIX) ?? false;
  const mineValue = deckId && !fromLibrary ? deckId : "";
  const libraryValue = deckId && fromLibrary ? deckId : "";
  const which = bracket === null ? "" : ` at Bracket ${bracket}`;

  return (
    <fieldset className="deck-picker">
      <legend>Your deck for this table</legend>
      <label className="field deck-picker-bracket">
        <span>Bracket</span>
        <select value={bracket ?? ""} onChange={(e) => setBracket(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Any bracket</option>
          {BRACKETS.map((b) => (
            <option key={b} value={b}>
              B{b} · {BRACKET_NAMES[b]}
            </option>
          ))}
        </select>
      </label>
      {failed && <p className="error small">Could not load decks. Try again in a moment.</p>}
      <div className="deck-picker-lists">
        <label className="field deck-picker-list">
          <span>Your decks</span>
          <select value={mineValue} onChange={(e) => e.target.value && onPick(e.target.value)} disabled={!opts || opts.mine.length === 0}>
            <option value="">{opts && opts.mine.length === 0 ? `None${which}` : "Pick one of your decks..."}</option>
            {(opts?.mine ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {deckOptionLabel(d)}
              </option>
            ))}
          </select>
          {opts && opts.mine.length === 0 && (
            <span className="muted small">
              {bracket === null ? (
                <>
                  No decks yet. <a href="/decks/new">Import one</a>, or play a library deck.
                </>
              ) : (
                `None of your decks is Bracket ${bracket} (or its bracket is not known).`
              )}
            </span>
          )}
        </label>
        <span className="deck-picker-or" aria-hidden="true">
          or
        </span>
        <label className="field deck-picker-list">
          <span>Deck library</span>
          <select value={libraryValue} onChange={(e) => e.target.value && onPick(e.target.value)} disabled={!opts || opts.library.length === 0}>
            <option value="">{opts && opts.library.length === 0 ? `None${which}` : "Pick a library deck..."}</option>
            {(opts?.library ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {deckOptionLabel(d)}
              </option>
            ))}
          </select>
          {opts && opts.library.length === 0 && <span className="muted small">{bracket === null ? "The deck library is empty." : `No library decks at Bracket ${bracket}.`}</span>}
        </label>
      </div>
      <p className="muted small deck-picker-note">Library decks are the precons and decks the owner approved: try one before you buy it.</p>
    </fieldset>
  );
}
