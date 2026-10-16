import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Board, CardSummary, ResolveResponse, ResolvedLine } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "../components/CardImage";
import { ManaCost } from "../components/ManaCost";
import { RequireUser } from "../components/RequireUser";

/** The user's decision for one pasted line. */
interface Choice {
  card: CardSummary | null;
  board: Board;
  quantity: number;
  skipped: boolean;
}

const BOARD_LABEL: Record<Board, string> = {
  commander: "Commander",
  main: "Main deck",
  sideboard: "Sideboard",
  maybeboard: "Maybeboard",
  companion: "Companion",
};

function initialChoices(result: ResolveResponse): Choice[] {
  return result.lines.map((l) => ({
    card: l.card,
    board: l.commander ? "commander" : l.line.board,
    quantity: l.line.quantity,
    skipped: false,
  }));
}

function LineRow({
  line,
  choice,
  onChange,
}: {
  line: ResolvedLine;
  choice: Choice;
  onChange: (c: Choice) => void;
}) {
  const problem = line.status !== "resolved";
  return (
    <li className={`import-line status-${line.status}${choice.skipped ? " is-skipped" : ""}`}>
      <div className="import-line-main">
        {choice.card ? (
          <div className="import-thumb">
            <CardImage id={choice.card.id} name={choice.card.name} size="small" />
          </div>
        ) : (
          <div className="import-thumb import-thumb-empty">?</div>
        )}
        <div className="import-line-text">
          <div className="import-line-title">
            <span className="qty">{choice.quantity}&times;</span>{" "}
            <strong>{choice.card ? choice.card.name : line.line.name}</strong>{" "}
            {choice.card && <ManaCost cost={choice.card.manaCost} size={13} />}
          </div>
          <div className="muted small">
            {choice.card ? `${choice.card.set.toUpperCase()} #${choice.card.collectorNumber}` : "no match"}
            {problem && line.note ? ` · ${line.note}` : ""}
            {!problem && line.note ? ` · ${line.note}` : ""}
            {" · "}
            <span className="muted">line {line.line.lineNo}: &ldquo;{line.line.raw.trim()}&rdquo;</span>
          </div>
          {problem && line.candidates.length > 0 && (
            <div className="candidates">
              {line.candidates.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`chip${choice.card?.id === c.id ? " is-selected" : ""}`}
                  onClick={() => onChange({ ...choice, card: c, skipped: false })}
                >
                  {c.name} <span className="muted">({c.set.toUpperCase()})</span>
                </button>
              ))}
            </div>
          )}
          {problem && <CandidateSearch onPick={(c) => onChange({ ...choice, card: c, skipped: false })} />}
        </div>
      </div>
      <div className="import-line-controls">
        <label className="small">
          <span className="sr-only">Board</span>
          <select value={choice.board} onChange={(e) => onChange({ ...choice, board: e.target.value as Board })}>
            {(Object.keys(BOARD_LABEL) as Board[]).map((b) => (
              <option key={b} value={b}>
                {BOARD_LABEL[b]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-small" onClick={() => onChange({ ...choice, skipped: !choice.skipped })}>
          {choice.skipped ? "Keep" : "Skip"}
        </button>
      </div>
    </li>
  );
}

/** Tiny inline search so an unresolved line can be fixed by typing the right name. */
function CandidateSearch({ onPick }: { onPick: (c: CardSummary) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CardSummary[]>([]);
  const run = async (value: string) => {
    setQ(value);
    if (value.trim().length < 2) {
      setHits([]);
      return;
    }
    try {
      const r = await api.search(value.trim(), false);
      setHits(r.results.slice(0, 6));
    } catch {
      setHits([]);
    }
  };
  return (
    <div className="candidate-search">
      <input type="search" placeholder="Type the correct card name" value={q} onChange={(e) => void run(e.target.value)} />
      {hits.length > 0 && (
        <div className="candidates">
          {hits.map((c) => (
            <button
              type="button"
              key={c.id}
              className="chip"
              onClick={() => {
                onPick(c);
                setQ("");
                setHits([]);
              }}
            >
              {c.name} <span className="muted">({c.set.toUpperCase()})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportFlow() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "fetch" | "check" | "save">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);

  const check = async (source = text) => {
    setBusy("check");
    setError(null);
    try {
      const r = await api.decks.parse(source);
      setResult(r);
      setChoices(initialChoices(r));
      if (!name && r.suggestedName) setName(r.suggestedName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not read the list");
    } finally {
      setBusy("idle");
    }
  };

  const fetchUrl = async () => {
    setBusy("fetch");
    setError(null);
    try {
      const r = await api.decks.importUrl(url.trim());
      setText(r.text);
      setName(r.name);
      setSourceUrl(r.url);
      await check(r.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not fetch that link");
      setBusy("idle");
    }
  };

  const save = async () => {
    if (!result) return;
    setBusy("save");
    setError(null);
    try {
      const cards = choices
        .filter((c) => !c.skipped && c.card)
        .map((c, i) => ({ cardId: c.card!.id, quantity: c.quantity, board: c.board, category: result.lines[i]?.line.tags[0] ?? null }));
      const r = await api.decks.create({ name: name.trim() || "Untitled deck", cards, sourceText: text, sourceUrl });
      navigate(`/decks/${r.deck.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save");
      setBusy("idle");
    }
  };

  const summary = useMemo(() => {
    if (!result) return null;
    const open = choices.filter((c, i) => !c.skipped && !c.card && result.lines[i]?.status !== "resolved").length;
    const unconfirmed = choices.filter((c, i) => !c.skipped && result.lines[i]?.status === "ambiguous").length;
    const total = choices.filter((c) => !c.skipped && c.card && (c.board === "main" || c.board === "commander")).reduce((n, c) => n + c.quantity, 0);
    const commanders = choices.filter((c) => !c.skipped && c.card && c.board === "commander").length;
    return { open, unconfirmed, total, commanders };
  }, [result, choices]);

  const update = (i: number, c: Choice) => setChoices((prev) => prev.map((p, j) => (j === i ? c : p)));

  const problemIdx = result ? result.lines.map((l, i) => i).filter((i) => result.lines[i]!.status !== "resolved") : [];
  const okIdx = result ? result.lines.map((l, i) => i).filter((i) => result.lines[i]!.status === "resolved") : [];

  return (
    <>
      {!result && (
        <section className="import-input">
          <label className="field">
            <span>Paste a decklist</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              placeholder={"1 Sol Ring\n1 Arcane Signet\n...\n\nExports from Archidekt, Moxfield, MTGGoldfish, TappedOut and Arena all work."}
              spellCheck={false}
            />
          </label>
          <button className="btn btn-primary" disabled={busy !== "idle" || !text.trim()} onClick={() => void check()}>
            {busy === "check" ? "Checking..." : "Check list"}
          </button>
          <div className="or">or</div>
          <label className="field">
            <span>Public Archidekt link</span>
            <div className="inline-field">
              <input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://archidekt.com/decks/123456/..." />
              <button className="btn" disabled={busy !== "idle" || !url.trim()} onClick={() => void fetchUrl()}>
                {busy === "fetch" ? "Fetching..." : "Fetch"}
              </button>
            </div>
            <span className="muted small">Moxfield does not allow apps to read decks: use Export &rarr; Text there and paste it above.</span>
          </label>
          {error && <p className="error">{error}</p>}
        </section>
      )}

      {result && summary && (
        <section className="import-review">
          <label className="field">
            <span>Deck name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>

          <div className="notice">
            <p>
              <strong>{summary.total}</strong> cards in deck &middot; <strong>{summary.commanders}</strong> commander{summary.commanders === 1 ? "" : "s"}
              {summary.open > 0 && (
                <>
                  {" "}
                  &middot; <span className="error">{summary.open} unmatched</span>
                </>
              )}
              {summary.unconfirmed > 0 && (
                <>
                  {" "}
                  &middot; <span className="warn">{summary.unconfirmed} to confirm</span>
                </>
              )}
            </p>
            {summary.total !== 100 && <p className="muted small">Commander decks are 100 cards. Saving is still allowed; the deck page will show the warning.</p>}
          </div>

          {problemIdx.length > 0 && (
            <>
              <h3>Needs a look ({problemIdx.length})</h3>
              <p className="muted small">Pick the right card, type a name to search, or skip the line.</p>
              <ul className="import-lines">
                {problemIdx.map((i) => (
                  <LineRow key={i} line={result.lines[i]!} choice={choices[i]!} onChange={(c) => update(i, c)} />
                ))}
              </ul>
            </>
          )}

          <h3>Matched ({okIdx.length})</h3>
          <ul className="import-lines compact">
            {okIdx.map((i) => (
              <LineRow key={i} line={result.lines[i]!} choice={choices[i]!} onChange={(c) => update(i, c)} />
            ))}
          </ul>

          {error && <p className="error">{error}</p>}
          <div className="sticky-actions">
            <button className="btn" onClick={() => setResult(null)} disabled={busy === "save"}>
              Back to text
            </button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy === "save" || summary.total === 0}>
              {busy === "save" ? "Saving..." : summary.open > 0 ? `Save (skipping ${summary.open})` : "Save deck"}
            </button>
          </div>
        </section>
      )}
    </>
  );
}

export function ImportPage() {
  return (
    <main className="page narrow">
      <h1>Import a deck</h1>
      <RequireUser>
        <ImportFlow />
      </RequireUser>
    </main>
  );
}
