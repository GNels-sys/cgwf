import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  DOCTOR_ROLE_LABELS,
  PLACEMENT_FIT_LABELS,
  PLACEMENT_MAX_CARDS,
  type DeckCardEntry,
  type DeckSummary,
  type PlacementCardResult,
  type PlacementOption,
  type PlacementResponse,
} from "@cgwf/shared";
import { api } from "../api";
import { CardDetail } from "../components/CardDetail";
import { useCardHover } from "../components/CardHoverPreview";
import { ManaCost } from "../components/ManaCost";
import { PageHeading } from "../components/PageHeading";
import { PowerBadge } from "../components/PowerBadge";
import { RequireUser } from "../components/RequireUser";
import { isOwner, useUser } from "../user";

/**
 * Card placement (owner only while it is tested): paste the cards you picked up, see which of your decks each
 * one fits best (the Deck Doctor's EDHREC synergy, role gaps, combos and bracket check, per deck), and add it
 * there with the swap shown. Server: POST /api/placement; adding is the Doctor's apply route.
 */
export function PlacementPage() {
  const { user } = useUser();
  return (
    <main className="page">
      <RequireUser>
        <PageHeading title="Card placement" eyebrow="New cards, best homes">
          Paste the cards you picked up. Each one is weighed against every one of your decks, and the best home comes first.
        </PageHeading>
        {isOwner(user) ? <Placement /> : <p className="muted">Owner only while this is tested.</p>}
      </RequireUser>
    </main>
  );
}

interface Added {
  card: string;
  deckId: string;
  deckName: string;
  cut: string;
}

function Placement() {
  const [text, setText] = useState("");
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null); // null = every deck
  const [data, setData] = useState<PlacementResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [deckCards, setDeckCards] = useState<Record<string, DeckCardEntry[]>>({});
  const hover = useCardHover();

  const loadDeck = (deckId: string) => {
    if (deckCards[deckId]) return;
    api.decks
      .get(deckId)
      .then((r) => setDeckCards((m) => ({ ...m, [deckId]: r.deck.cards })))
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    api.decks
      .list()
      .then((r) => setDecks(r.decks))
      .catch((e: Error) => setError(e.message));
  }, []);

  const run = async (keepAdded = false) => {
    setRunning(true);
    setError(null);
    if (!keepAdded) setAdded([]);
    try {
      setData(await api.doctor.place({ text, deckIds: picked ? [...picked] : undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const add = async (c: PlacementCardResult, o: PlacementOption, cut?: { entryId: number; name: string }) => {
    const cutEntryId = cut?.entryId ?? o.cut.entryId;
    if (cutEntryId === null || !c.oracleId || !c.card) return;
    const key = `${c.oracleId}:${o.deckId}`;
    setBusy(key);
    setError(null);
    try {
      await api.doctor.apply(o.deckId, cutEntryId, c.oracleId);
      setAdded((a) => [...a, { card: c.card!.name, deckId: o.deckId, deckName: o.deckName, cut: cut?.name ?? o.cut.name }]);
      setDeckCards((m) => {
        const next = { ...m };
        delete next[o.deckId];
        return next;
      });
      // The deck changed: weigh again so the other cards get fresh cuts (EDHREC is cached now, so this is quick).
      await run(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) => {
    const all = decks?.map((d) => d.id) ?? [];
    const next = new Set(picked ?? all);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next.size === all.length ? null : next);
  };

  const lines = text.split("\n").filter((l) => l.trim()).length;
  const name = (cardId: string, label: string, faceCount: number, cls = "") => (
    <button type="button" className={`doctor-card ${cls}`} onClick={() => setOpen(cardId)} {...hover.bind({ id: cardId, name: label, faceCount })}>
      <span className="doctor-card-name">{label}</span>
    </button>
  );

  const option = (c: PlacementCardResult, o: PlacementOption, best: boolean) => (
    <li key={o.deckId} className={`doctor-swap placement-option${best ? " is-best" : ""}`}>
      <div className="placement-option-head">
        <div>
          <strong>{o.deckName}</strong>
          <span className="small muted"> · {o.commanders.join(" + ")}</span>
        </div>
        <span className={`chip small placement-fit is-${o.fit}`}>{PLACEMENT_FIT_LABELS[o.fit]}</span>
      </div>
      <p className="small doctor-reason">{o.reason}</p>
      {o.score <= 0 && <p className="small warn">Every card it could replace here already scores higher in this deck, so this would trade down.</p>}
      <div className="doctor-meta small">
        {o.synergy !== null && <span className="muted">Synergy {o.synergy >= 0 ? "+" : ""}{Math.round(o.synergy * 100)}%</span>}
        {o.inclusion !== null && <span className="muted">In {Math.round(o.inclusion * 100)}% of decks</span>}
        {o.role && <span className="chip tag-chip small">{DOCTOR_ROLE_LABELS[o.role]}</span>}
        {o.combos.length > 0 && (
          <span className="chip tag-chip small is-combo" title={o.combos.join("\n")}>
            Combo
          </span>
        )}
        {o.bracket.raises && (
          <span className="doctor-bracket warn">
            <PowerBadge level={o.bracket.floorAfter} label="Floor" /> {o.bracket.note}
          </span>
        )}
      </div>
      <div className="placement-cut small">
        <span className="muted">Cuts</span>
        <button type="button" className="doctor-card is-cut" onClick={() => setOpen(o.cut.cardId)} {...hover.bind({ id: o.cut.cardId, name: o.cut.name, faceCount: o.cut.faceCount })}>
          <span className="doctor-sign" aria-hidden="true">−</span>
          <span className="doctor-card-name">{o.cut.name}</span>
          <ManaCost cost={o.cut.manaCost} size={12} />
        </button>
      </div>
      <div className="actions doctor-actions">
        {o.cut.entryId !== null && (
          <button className={`btn btn-small${best ? " btn-primary" : ""}`} disabled={busy !== null || running} onClick={() => void add(c, o)}>
            {busy === `${c.oracleId}:${o.deckId}` ? "Adding…" : `Add to ${o.deckName}`}
          </button>
        )}
        <Link className="btn btn-small" to={`/decks/${encodeURIComponent(o.deckId)}`}>
          Open deck
        </Link>
      </div>
      <CutPicker
        cards={deckCards[o.deckId]}
        suggested={o.cut.entryId}
        disabled={busy !== null || running}
        onOpen={() => loadDeck(o.deckId)}
        onPick={(cut) => void add(c, o, cut)}
      />
    </li>
  );

  const placed = data?.cards.filter((c) => c.status === "ok") ?? [];
  return (
    <>
      <section className="surface placement-form">
        <label className="placement-label" htmlFor="placement-text">
          Cards to place <span className="small muted">(one per line, up to {PLACEMENT_MAX_CARDS}; "1 Sol Ring" or "Sol Ring (C21) 263" both work)</span>
        </label>
        <textarea
          id="placement-text"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Rhystic Study\nSylvan Library\nAnointed Procession"}
        />
        {decks && decks.length > 0 && (
          <details className="placement-decks">
            <summary className="small">
              Decks to weigh: {picked ? `${picked.size} of ${decks.length}` : `all ${decks.length}`}
            </summary>
            <ul>
              {decks.map((d) => (
                <li key={d.id}>
                  <label className="small">
                    <input type="checkbox" checked={picked ? picked.has(d.id) : true} onChange={() => toggle(d.id)} /> {d.name}
                    {d.commanders.length > 0 && <span className="muted"> · {d.commanders.map((c) => c.name).join(" + ")}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}
        {decks && decks.length === 0 && (
          <p className="small warn">
            You have no decks yet. <Link to="/decks/new">Import one</Link> first.
          </p>
        )}
        <div className="actions">
          <button className="btn btn-primary" disabled={running || lines === 0 || picked?.size === 0} onClick={() => void run()}>
            {running ? "Weighing your decks…" : "Find the best homes"}
          </button>
          {running && <span className="small muted" role="status">The first run reads EDHREC for each deck, about two seconds a deck. Later runs are quick.</span>}
        </div>
      </section>

      {error && <p className="notice error">{error}</p>}

      {added.length > 0 && (
        <div className="notice">
          <p>
            <strong>Added</strong>
          </p>
          <ul className="small">
            {added.map((a, i) => (
              <li key={i}>
                {a.card} into <Link to={`/decks/${encodeURIComponent(a.deckId)}`}>{a.deckName}</Link>, cutting {a.cut}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && (
        <>
          {(data.limits.truncatedCards || data.limits.truncatedDecks) && (
            <p className="small warn">
              {data.limits.truncatedCards && `Only the first ${data.limits.maxCards} cards were placed. `}
              {data.limits.truncatedDecks && `Only ${data.limits.maxDecks} decks were weighed; pick fewer decks to choose which.`}
            </p>
          )}
          {data.decks.some((d) => d.edhrec !== "ok") && (
            <details className="small">
              <summary className="warn">Some decks could not be compared with EDHREC, so their scores lean on roles and combos only</summary>
              <ul>
                {data.decks
                  .filter((d) => d.edhrec !== "ok")
                  .map((d) => (
                    <li key={d.deckId}>
                      {d.name}: {d.message}
                    </li>
                  ))}
              </ul>
            </details>
          )}

          {placed.length > 1 && (
            <section className="surface placement-summary" aria-label="Best home for each card">
              <h2>Best home for each card</h2>
              <table className="placement-table">
                <thead>
                  <tr>
                    <th>Card</th>
                    <th>Best deck</th>
                    <th>Fit</th>
                  </tr>
                </thead>
                <tbody>
                  {placed.map((c) => {
                    const b = c.options[0];
                    return (
                      <tr key={c.oracleId}>
                        <td>
                          <a href={`#place-${c.oracleId}`}>{c.card!.name}</a>
                        </td>
                        <td>{b ? b.deckName : <span className="muted">No deck can take it</span>}</td>
                        <td>{b && <span className={`chip small placement-fit is-${b.fit}`}>{PLACEMENT_FIT_LABELS[b.fit]}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          <ol className="placement-cards">
            {data.cards.map((c, i) => (
              <li key={c.oracleId ?? `line-${i}`} id={c.oracleId ? `place-${c.oracleId}` : undefined} className="surface placement-card">
                <div className="placement-card-head">
                  {c.card ? name(c.card.id, c.card.name, c.card.faceCount, "is-add") : <strong>{c.line}</strong>}
                  {c.card && <ManaCost cost={c.card.manaCost} size={14} />}
                  {c.card && <span className="small muted">{c.card.typeLine}</span>}
                </div>
                {c.note && <p className={`small ${c.status === "ok" ? "muted" : "warn"}`}>{c.note}</p>}
                {c.status === "ok" && c.options.length === 0 && <p className="small muted">None of the weighed decks can take this card. The reasons are below.</p>}
                {c.options.length > 0 && <ol className="doctor-swaps">{option(c, c.options[0]!, true)}</ol>}
                {c.options.length > 1 && (
                  <details className="placement-more">
                    <summary className="small">Other decks it fits ({c.options.length - 1})</summary>
                    <ol className="doctor-swaps">{c.options.slice(1).map((o) => option(c, o, false))}</ol>
                  </details>
                )}
                {c.skipped.length > 0 && (
                  <details className="placement-more">
                    <summary className="small muted">Decks that cannot take it ({c.skipped.length})</summary>
                    <ul className="small">
                      {c.skipped.map((s) => (
                        <li key={s.deckId}>
                          <strong>{s.deckName}</strong>: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {hover.preview}
      {open && <CardDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** "Cut something else": any main-board card of that deck instead of the suggested cut (lands listed last). */
function CutPicker({ cards, suggested, disabled, onOpen, onPick }: {
  cards: DeckCardEntry[] | undefined;
  suggested: number | null;
  disabled: boolean;
  onOpen: () => void;
  onPick: (cut: { entryId: number; name: string }) => void;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const main = (cards ?? []).filter((e) => e.board === "main" && e.entryId !== undefined && e.entryId !== suggested);
  const isLand = (e: DeckCardEntry) => /\bLand\b/.test(e.card.typeLine);
  const byName = (a: DeckCardEntry, b: DeckCardEntry) => a.card.name.localeCompare(b.card.name);
  const spells = main.filter((e) => !isLand(e)).sort(byName);
  const lands = main.filter(isLand).sort(byName);
  const picked = main.find((e) => e.entryId === choice);
  return (
    <details className="placement-more placement-cut-picker" onToggle={(e) => (e.currentTarget.open ? onOpen() : undefined)}>
      <summary className="small">Cut something else</summary>
      {!cards ? (
        <p className="small muted">Loading the deck…</p>
      ) : (
        <div className="placement-cut-row">
          <select value={choice ?? ""} onChange={(e) => setChoice(e.target.value ? Number(e.target.value) : null)} aria-label="Card to cut instead">
            <option value="">Choose a card to cut…</option>
            <optgroup label="Spells">
              {spells.map((e) => (
                <option key={e.entryId} value={e.entryId}>
                  {e.card.name}
                </option>
              ))}
            </optgroup>
            {lands.length > 0 && (
              <optgroup label="Lands">
                {lands.map((e) => (
                  <option key={e.entryId} value={e.entryId}>
                    {e.card.name}
                    {e.quantity > 1 ? ` (${e.quantity})` : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn btn-small" disabled={disabled || !picked} onClick={() => picked && onPick({ entryId: picked.entryId!, name: picked.card.name })}>
            {picked ? `Add, cutting ${picked.card.name}` : "Add"}
          </button>
        </div>
      )}
    </details>
  );
}
