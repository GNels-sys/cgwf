import { useEffect, useState } from "react";
import { SECTIONS, SECTION_LABELS, defaultSection, type Color, type Row, type TokenSummary } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "../components/CardImage";
import { Panel } from "./Panels";

/**
 * Token finder: searches the Scryfall token catalogue already in the cards
 * table ("treasure", "2/2 zombie", "spirit"), remembers the tokens you used
 * recently, and falls back to a text-only custom token. Creating N copies is
 * one tap; the row (lands / creatures / other) is guessed from the type line.
 */

export interface TokenRequest {
  printingId: string | null;
  custom: { name: string; typeLine: string; power: string | null; toughness: string | null; colors: Color[]; text: string } | null;
  count: number;
  row: Row;
}

const COLORS: Color[] = ["W", "U", "B", "R", "G"];
const COLOR_DOT: Record<Color, string> = { W: "#f6f1d6", U: "#5aa0d8", B: "#6b5d73", R: "#e05a4f", G: "#5fae62" };
const RECENT_KEY = "cgwf.recentTokens";
const COUNTS = [1, 2, 3, 4, 5, 8, 10];

function readRecent(): TokenSummary[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as TokenSummary[]).slice(0, 8) : [];
  } catch {
    return [];
  }
}

function pushRecent(t: TokenSummary): void {
  try {
    const next = [t, ...readRecent().filter((x) => x.id !== t.id)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function rowFor(typeLine: string): Row {
  return defaultSection(typeLine);
}

function ColorDots({ colors }: { colors: Color[] }) {
  if (colors.length === 0) return null;
  return (
    <span className="color-dots" aria-label={`colours ${colors.join("")}`}>
      {colors.map((c) => (
        <i key={c} style={{ background: COLOR_DOT[c] }} />
      ))}
    </span>
  );
}

function TokenCard({ t, count, onCreate }: { t: TokenSummary; count: number; onCreate: (t: TokenSummary) => void }) {
  const type = t.typeLine.replace(/^Token\s*/, "").replace(/^Creature — /, "");
  return (
    <button className="token-result" onClick={() => onCreate(t)} aria-label={`Create ${count} ${t.name}${t.power ? ` ${t.power}/${t.toughness}` : ""}`}>
      <CardImage id={t.id} name={t.name} size="small" />
      <span className="token-name">
        {t.name}
        {t.power !== null && (
          <strong>
            {" "}
            {t.power}/{t.toughness}
          </strong>
        )}
      </span>
      <span className="muted small token-type">
        <ColorDots colors={t.colors} /> {type}
      </span>
      {t.oracleText && <span className="muted token-text">{t.oracleText.length > 90 ? `${t.oracleText.slice(0, 88)}...` : t.oracleText}</span>}
    </button>
  );
}

export function TokenFinder({ onCreate, onClose }: { onCreate: (req: TokenRequest) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"search" | "custom">("search");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<TokenSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(1);
  const [recent, setRecent] = useState<TokenSummary[]>(readRecent);
  const [name, setName] = useState("");
  const [typeLine, setTypeLine] = useState("Creature");
  const [pt, setPt] = useState("1/1");
  const [colors, setColors] = useState<Color[]>([]);
  const [text, setText] = useState("");
  const [row, setRow] = useState<Row>("creatures");

  useEffect(() => {
    if (mode !== "search") return;
    const ctl = new AbortController();
    setBusy(true);
    const t = setTimeout(
      () => {
        api
          .tokens(q.trim(), ctl.signal)
          .then((r) => setResults(r.tokens))
          .catch(() => {})
          .finally(() => setBusy(false));
      },
      q.trim() ? 180 : 0,
    );
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, mode]);

  const create = (t: TokenSummary) => {
    pushRecent(t);
    setRecent(readRecent());
    onCreate({ printingId: t.id, custom: null, count, row: rowFor(t.typeLine) });
  };

  const showing = results ?? [];
  const showRecent = mode === "search" && !q.trim() && recent.length > 0;

  return (
    <Panel title="Create tokens" subtitle={`Tap a token to put ${count === 1 ? "one" : count} onto your battlefield`} onClose={onClose} wide>
      <div className="token-head">
        <div className="chips">
          <button className={`chip${mode === "search" ? " is-selected" : ""}`} onClick={() => setMode("search")}>
            Find a token
          </button>
          <button className={`chip${mode === "custom" ? " is-selected" : ""}`} onClick={() => setMode("custom")}>
            Custom
          </button>
        </div>
        <div className="count-picker" role="group" aria-label="How many">
          <span className="muted small">How many</span>
          {COUNTS.map((n) => (
            <button key={n} className={`chip${count === n ? " is-selected" : ""}`} onClick={() => setCount(n)} aria-pressed={count === n}>
              {n}
            </button>
          ))}
        </div>
      </div>
      {mode === "search" ? (
        <>
          <input className="token-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="treasure, 2/2 zombie, spirit, clue..." autoFocus aria-label="Search tokens" />
          {showRecent && (
            <>
              <p className="muted small token-section">Recently used</p>
              <div className="token-results">
                {recent.map((t) => (
                  <TokenCard key={`r-${t.id}`} t={t} count={count} onCreate={create} />
                ))}
              </div>
              <p className="muted small token-section">Common tokens</p>
            </>
          )}
          <div className={`token-results${busy ? " is-busy" : ""}`}>
            {showing.map((t) => (
              <TokenCard key={t.id} t={t} count={count} onCreate={create} />
            ))}
          </div>
          {results && results.length === 0 && q.trim() && (
            <p className="muted small">
              No token called "{q.trim()}". Try another name, or{" "}
              <button
                className="link-btn"
                onClick={() => {
                  setName(q.trim());
                  setMode("custom");
                }}
              >
                make a custom one
              </button>
              .
            </p>
          )}
        </>
      ) : (
        <form
          className="token-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const [power, toughness] = pt.includes("/") ? pt.split("/").map((s) => s.trim()) : [null, null];
            onCreate({ printingId: null, custom: { name: name.trim(), typeLine: typeLine.trim() || "Token", power: power || null, toughness: toughness || null, colors, text: text.trim() }, count, row });
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Spirit" autoFocus />
          </label>
          <div className="two-up">
            <label className="field">
              <span>Type</span>
              <input value={typeLine} onChange={(e) => setTypeLine(e.target.value)} maxLength={60} />
            </label>
            <label className="field">
              <span>P/T</span>
              <input value={pt} onChange={(e) => setPt(e.target.value)} maxLength={9} placeholder="1/1" />
            </label>
          </div>
          <div className="field">
            <span>Colours</span>
            <div className="chips">
              {COLORS.map((c) => (
                <button key={c} type="button" className={`chip${colors.includes(c) ? " is-selected" : ""}`} onClick={() => setColors(colors.includes(c) ? colors.filter((x) => x !== c) : [...colors, c])} aria-pressed={colors.includes(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Text (optional)</span>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Flying" />
          </label>
          <label className="field">
            <span>Row</span>
            <select value={row} onChange={(e) => setRow(e.target.value as Row)}>
              {SECTIONS.map((sec) => (
                <option key={sec} value={sec}>
                  {SECTION_LABELS[sec]}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
            Create {count > 1 ? `${count} tokens` : "token"}
          </button>
        </form>
      )}
    </Panel>
  );
}
