import { PerformancePanel } from "../components/PerformancePanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deckScenery } from "../components/deckScenery";
import { Link, useNavigate, useParams } from "react-router-dom";
import { deckSizeProblem, SUBMISSION_NOTE_MAX, type Board, type CardSummary, type DeckAnalysis, type DeckDetail, type SubmissionInfo } from "@cgwf/shared";
import { api } from "../api";
import { BracketPanel } from "../components/BracketPanel";
import { CardDetail } from "../components/CardDetail";
import { CardImage } from "../components/CardImage";
import { DoctorPanel } from "../components/DoctorPanel";
import { AddCardSearch, DeckEditBar } from "../components/DeckEditor";
import { addCard, draftTotal, isDirty, lastChange, removeOne, setLinePrinting, startDraft, summaryOf, toSaveInput, undo, type DraftState } from "../components/deckDraft";
import { useCardHover } from "../components/CardHoverPreview";
import { PrintingPicker, printingLabel } from "../components/PrintingPicker";
import { ShoppingPanel } from "../components/LocalStores";
import { ManaCost } from "../components/ManaCost";
import { RequireUser } from "../components/RequireUser";
import { StatsPanel } from "../components/StatsPanel";
import { isOwner, useUser } from "../user";

const TYPE_ORDER = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Other"] as const;

function primaryType(typeLine: string): (typeof TYPE_ORDER)[number] {
  const front = typeLine.split(" // ")[0] ?? typeLine;
  for (const t of TYPE_ORDER) if (t !== "Other" && new RegExp(`\\b${t}\\b`).test(front)) return t;
  return "Other";
}

/** One line of the list, from the saved deck or the editor's draft. */
interface Line {
  key: string;
  card: CardSummary;
  quantity: number;
  board: Board;
  entryId?: number;
}

function groupByType(entries: Line[]) {
  const groups = new Map<string, Line[]>();
  for (const e of entries) {
    const t = primaryType(e.card.typeLine);
    const list = groups.get(t) ?? [];
    list.push(e);
    groups.set(t, list);
  }
  return TYPE_ORDER.filter((t) => groups.has(t)).map((t) => ({ type: t, entries: groups.get(t)!.sort((a, b) => a.card.name.localeCompare(b.card.name)) }));
}

type HoverBind = ReturnType<typeof useCardHover>["bind"];

function CardLine({ entry, onOpen, onPrinting, onRemove, hover }: { entry: Line; onOpen: (id: string) => void; onPrinting: ((e: Line) => void) | null; onRemove?: ((e: Line) => void) | undefined; hover: HoverBind }) {
  const label = printingLabel(entry.card);
  return (
    <li className="deck-card-row">
      <button className="deck-card-line" onClick={() => onOpen(entry.card.id)} {...hover({ id: entry.card.id, name: entry.card.name, faceCount: entry.card.faceCount })}>
        <span className="qty">{entry.quantity}</span>
        <span className="deck-card-name">{entry.card.name}</span>
        <ManaCost cost={entry.card.manaCost} size={13} />
      </button>
      {onPrinting && (
        <button type="button" className="printing-chip" onClick={() => onPrinting(entry)} title="Change printing" aria-label={`Change printing of ${entry.card.name}, now ${label}`}>
          {label}
        </button>
      )}
      {onRemove && (
        <button type="button" className="deck-card-remove" onClick={() => onRemove(entry)} aria-label={`Remove one ${entry.card.name}`} title="Remove one copy">
          −
        </button>
      )}
    </li>
  );
}

/** Offer this deck for the owner's agent library; shows the current status once submitted. */
function QueuePanel({ deck }: { deck: DeckDetail }) {
  const [sub, setSub] = useState<SubmissionInfo | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.social
      .deckSubmission(deck.id)
      .then((r) => setSub(r.submission))
      .catch(() => setSub(null));
  }, [deck.id]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.social.submitDeck(deck.id, note);
      setSub(r.submission);
      setOpen(false);
      setNote("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!sub || !confirm("Take this deck out of the queue?")) return;
    setBusy(true);
    try {
      await api.social.withdraw(sub.id);
      const r = await api.social.deckSubmission(deck.id);
      setSub(r.submission);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sub === undefined) return null;
  return (
    <section className="notice queue-panel">
      <div className="row-between">
        <strong>Agent deck queue</strong>
        {sub?.status === "pending" ? (
          <span className="tag">In the queue</span>
        ) : sub?.status === "approved" ? (
          <span className="tag tag-ok">Approved</span>
        ) : sub?.status === "rejected" ? (
          <span className="tag tag-no">Not added</span>
        ) : null}
      </div>
      {sub?.status === "pending" && (
        <>
          <p className="small muted">
            Submitted {new Date(sub.createdAt).toLocaleDateString()}
            {sub.note ? ` with the note "${sub.note}"` : ""}. The owner reviews the list as it was when you submitted it; edits here do not change it.
          </p>
          <button className="btn btn-small" disabled={busy} onClick={() => void withdraw()}>
            Withdraw
          </button>
        </>
      )}
      {sub?.status === "approved" && <p className="small muted">This list is in the library now and computer opponents can pilot it. Thank you!</p>}
      {sub?.status === "rejected" && (
        <p className="small muted">
          The owner&apos;s note: <em>{sub.reason}</em>. You can submit it again after changes.
        </p>
      )}
      {(!sub || sub.status === "rejected") && !open && (
        <>
          <p className="small muted">Offer this deck for the computer opponents to play. The owner reviews it; nothing about your deck changes.</p>
          <button className="btn btn-small btn-primary" onClick={() => setOpen(true)}>
            Submit to the queue
          </button>
        </>
      )}
      {open && (
        <form
          className="profile-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>Note for the owner (optional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={SUBMISSION_NOTE_MAX} rows={3} placeholder="What the deck does, which bracket you would call it, anything a pilot should know" />
          </label>
          {error && <p className="error small">{error}</p>}
          <div className="actions">
            <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
              {busy ? "Submitting..." : "Submit"}
            </button>
            <button className="btn btn-small" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && !open && <p className="error small">{error}</p>}
    </section>
  );
}

function DeckView({ id }: { id: string }) {
  const navigate = useNavigate();
  const { user } = useUser();
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [libraryNote, setLibraryNote] = useState<string | null>(null);
  const [picking, setPicking] = useState<Line | null>(null);
  const hover = useCardHover();
  // the deck editor (owner request 2026-10-28): a local draft until Save
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const dirty = Boolean(draft && deck && isDirty(draft, deck.cards));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    api.decks
      .get(id)
      .then((r) => setDeck(r.deck))
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const [analysisRecord, setAnalysisRecord] = useState<{ deckId: string; value: DeckAnalysis | null } | null>(null);
  const analysisDeckId = deck?.id ?? id;
  const receiveAnalysis = useCallback((value: DeckAnalysis | null) => setAnalysisRecord({ deckId: analysisDeckId, value }), [analysisDeckId]);
  const loadStats = useCallback(() => api.decks.stats(id), [id]);
  const loadShopping = useCallback(() => api.singles.deckShopping(id), [id]);

  const sections = useMemo(() => {
    if (!deck) return null;
    const lines: Line[] = draft
      ? draft.lines
      : deck.cards.map((c, i) => ({ key: c.entryId !== undefined ? `e${c.entryId}` : `s${i}`, card: c.card, quantity: c.quantity, board: c.board, ...(c.entryId !== undefined ? { entryId: c.entryId } : {}) }));
    const by = (b: Board) => lines.filter((c) => c.board === b);
    return {
      commanders: by("commander"),
      main: groupByType(by("main")),
      companion: by("companion"),
      sideboard: by("sideboard"),
      maybeboard: by("maybeboard"),
    };
  }, [deck, draft]);

  // Follow the displayed section order, visiting each printing once rather than
  // repeating basic lands or the same printing listed on multiple boards.
  const browseIds = useMemo(() => sections ? [...new Set([
    ...sections.commanders,
    ...sections.main.flatMap((group) => group.entries),
    ...sections.companion, ...sections.sideboard, ...sections.maybeboard,
  ].map((entry) => entry.card.id))] : [], [sections]);
  const browseIndex = open ? browseIds.indexOf(open) : -1;

  if (error) return <p className="error">{error}</p>;
  if (!deck || !sections) return <p className="muted">Loading deck...</p>;

  const changePrinting = (e: Line) => (e.card.oracleId && (draft || e.entryId !== undefined) ? () => setPicking(e) : null);
  const openPicker = (e: Line) => {
    hover.hide();
    setPicking(e);
  };

  const startEditing = () => {
    setDraft(startDraft(deck.cards));
    setEditError(null);
    setSavedNote(null);
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const cancelEditing = () => {
    if (dirty && !confirm("Discard your changes to this deck?")) return;
    setDraft(null);
    setEditError(null);
  };
  const saveEdits = async () => {
    if (!draft) return;
    const problem = deckSizeProblem(draftTotal(draft));
    if (problem) {
      setEditError(problem);
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      const r = await api.decks.replaceCards(deck.id, toSaveInput(draft));
      setDeck(r.deck);
      setDraft(null);
      setSavedNote("Deck saved.");
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const removeLine = draft
    ? (e: Line) => {
        setDraft(removeOne(draft, e.key));
        setEditError(null);
      }
    : undefined;

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
  const addToLibrary = async () => {
    setLibraryNote("Adding...");
    try {
      const r = await api.library.fromDeck(deck.id);
      setLibraryNote(`Added to the library as Bracket ${r.deck.bracket}.`);
      setTimeout(() => navigate(`/admin/library/${r.deck.id}`), 600);
    } catch (e) {
      setLibraryNote((e as Error).message);
    }
  };

  return (
    <>
      <header className="detail-heading">
        <p className="eyebrow">Your deck workshop</p>
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
            {!draft && (
              <button className="btn btn-small btn-primary" onClick={startEditing}>
                Edit cards
              </button>
            )}
            <button
              className="btn btn-small"
              onClick={() => {
                setNewName(deck.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
            {isOwner(user) && (
              <button className="btn btn-small" onClick={() => void addToLibrary()}>
                Add to library
              </button>
            )}
            <button className="btn btn-small btn-danger" onClick={() => void remove()}>
              Delete
            </button>
          </div>
        </div>
      </header>
      {libraryNote && <p className="small muted">{libraryNote}</p>}
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
          <div key={c.key} className="commander-slot">
            <button className="commander-card" onClick={() => setOpen(c.card.id)}>
              <CardImage id={c.card.id} name={c.card.name} size="normal" loading="eager" />
              <span>{c.card.name}</span>
            </button>
            {changePrinting(c) && (
              <button type="button" className="printing-chip" onClick={() => openPicker(c)} title="Change printing" aria-label={`Change printing of ${c.card.name}, now ${printingLabel(c.card)}`}>
                {printingLabel(c.card)}
              </button>
            )}
            {removeLine && (
              <button type="button" className="deck-card-remove" onClick={() => removeLine(c)} aria-label={`Remove ${c.card.name}`} title="Remove the commander">
                −
              </button>
            )}
          </div>
        ))}
      </section>

      <div className="analysis-row">
        <BracketPanel deckId={deck.id} version={`${deck.updatedAt}:${deck.cards.length}`} onAnalysis={receiveAnalysis} />
        <StatsPanel load={loadStats} version={`${deck.updatedAt}:${deck.cards.length}`} />
      </div>

      <PerformancePanel key={deck.id} deckRef={deck.id} analysis={analysisRecord?.deckId === deck.id ? analysisRecord.value : null} />

      <DoctorPanel kind="own" id={deck.id} version={`${deck.updatedAt}:${deck.cards.length}`} onApplied={() => void api.decks.get(deck.id).then((r) => setDeck(r.deck))} />

      <ShoppingPanel load={loadShopping} version={`${deck.updatedAt}:${deck.cards.length}`} />

      <QueuePanel deck={deck} />

      <div className="deck-edit-scope" ref={editorRef}>
      {savedNote && !draft && (
        <p className="notice small deck-saved-note" role="status">
          {savedNote}
        </p>
      )}
      {draft && (
        <div className="surface deck-edit-sticky">
          <DeckEditBar
            total={draftTotal(draft)}
            lastChange={lastChange(draft)}
            error={editError}
            saving={saving}
            onUndo={() => {
              setDraft(undo(draft));
              setEditError(null);
            }}
            onCancel={cancelEditing}
            onSave={() => void saveEdits()}
          />
        </div>
      )}
      {draft && (
        <section className="surface deck-editor">
          <AddCardSearch
            draft={draft}
            onAdd={(card) => {
              setDraft(addCard(draft, card));
              setEditError(null);
            }}
            onOpen={setOpen}
          />
          <p className="small muted">Tap − beside a card to take one copy out. Nothing changes until you save; a saved deck has exactly 100 cards including the commander.</p>
        </section>
      )}
      <div className="deck-columns">
        {sections.main.map((g) => (
          <section key={g.type} className="deck-group">
            <h3>
              {g.type} <span className="muted">({g.entries.reduce((n, e) => n + e.quantity, 0)})</span>
            </h3>
            <ul>
              {g.entries.map((e) => (
                <CardLine key={e.key} entry={e} onOpen={setOpen} onPrinting={changePrinting(e) ? openPicker : null} onRemove={removeLine} hover={hover.bind} />
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
                  <CardLine key={e.key} entry={e} onOpen={setOpen} onPrinting={changePrinting(e) ? openPicker : null} onRemove={removeLine} hover={hover.bind} />
                ))}
              </ul>
            </section>
          ) : null,
        )}
      </div>
      </div>

      {hover.preview}
      {picking && picking.card.oracleId && (draft || picking.entryId !== undefined) && (
        <PrintingPicker
          oracleId={picking.card.oracleId}
          cardName={picking.card.name}
          currentId={picking.card.id}
          onClose={() => setPicking(null)}
          onPick={async (cardId) => {
            if (draft) {
              // while editing, the new printing goes into the draft and is saved with everything else
              const r = await api.card(cardId);
              setDraft((d) => (d ? setLinePrinting(d, picking.key, summaryOf(r.card)) : d));
              return;
            }
            const r = await api.decks.setPrinting(deck.id, picking.entryId!, cardId);
            setDeck(r.deck);
          }}
        />
      )}

      {open && <CardDetail id={open} onClose={() => setOpen(null)} navigation={{
        position: browseIndex + 1,
        total: browseIds.length,
        onPrevious: browseIndex > 0 ? () => setOpen(browseIds[browseIndex - 1]!) : null,
        onNext: browseIndex >= 0 && browseIndex < browseIds.length - 1 ? () => setOpen(browseIds[browseIndex + 1]!) : null,
      }} />}
    </>
  );
}

export function DeckPage() {
  const { id } = useParams();
  return (
    <main className="page deck-page" data-realm={deckScenery(id ?? "")}>
      <p>
        <Link to="/" className="muted small">
          &larr; All decks
        </Link>
      </p>
      <RequireUser>{id && <DeckView id={id} />}</RequireUser>
    </main>
  );
}
