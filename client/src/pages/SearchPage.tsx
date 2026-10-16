import { useEffect, useRef, useState } from "react";
import type { CardSummary, StatusResponse } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "../components/CardImage";
import { ManaCost } from "../components/ManaCost";
import { CardDetail } from "../components/CardDetail";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [tokens, setTokens] = useState(false);
  const [results, setResults] = useState<CardSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const debounced = useDebounced(query.trim(), 250);
  const inputRef = useRef<HTMLInputElement>(null);

  // Poll status while card data is still downloading, otherwise fetch once.
  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.status();
        if (cancelled) return;
        setStatus(s);
        if (s.ingestRunning || s.cardCount === 0) timer = window.setTimeout(tick, 3000);
      } catch {
        if (!cancelled) timer = window.setTimeout(tick, 5000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (debounced.length < 2) {
      setResults([]);
      setError(null);
      return;
    }
    const ctl = new AbortController();
    setBusy(true);
    api
      .search(debounced, tokens, ctl.signal)
      .then((r) => {
        setResults(r.results);
        setError(null);
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => setBusy(false));
    return () => ctl.abort();
  }, [debounced, tokens]);

  const ingesting = status?.ingestRunning ?? false;
  const noData = status !== null && status.cardCount === 0;

  return (
    <main className="page search-page">
      <header className="page-header">
        <h1>CGwF</h1>
        <p className="tagline">Card Games with Friends</p>
      </header>

      <div className="search-bar">
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={tokens ? "Search tokens, e.g. Treasure" : "Search cards, e.g. Sol Ring"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Card search"
        />
        <label className="toggle">
          <input type="checkbox" checked={tokens} onChange={(e) => setTokens(e.target.checked)} />
          <span>Tokens</span>
        </label>
      </div>

      {(ingesting || noData) && (
        <div className="notice">
          {ingesting ? (
            <>
              <p>Downloading card data from Scryfall&hellip; {Math.round((status?.ingestProgress ?? 0) * 100)}%</p>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${Math.round((status?.ingestProgress ?? 0) * 100)}%` }} />
              </div>
            </>
          ) : (
            <p>No card data yet. {status?.ingestError ? `Last attempt failed: ${status.ingestError}` : "The first download starts shortly."}</p>
          )}
        </div>
      )}

      {error && <p className="error">Search failed: {error}</p>}

      <section className={`results${busy ? " is-busy" : ""}`} aria-live="polite">
        {results.length === 0 && debounced.length >= 2 && !busy && !error && <p className="muted">No cards match.</p>}
        {results.length === 0 && debounced.length < 2 && status && status.cardCount > 0 && (
          <p className="muted">{status.cardCount.toLocaleString()} printings loaded. Type at least two letters.</p>
        )}
        <ul className="card-grid">
          {results.map((c) => (
            <li key={c.id}>
              <button className="card-tile" onClick={() => setSelected(c.id)}>
                <CardImage id={c.id} name={c.name} size="normal" />
                <span className="card-tile-name">{c.name}</span>
                <span className="card-tile-meta">
                  <ManaCost cost={c.manaCost} size={14} />
                </span>
                <span className="card-tile-type">{c.typeLine}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected && <CardDetail id={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}
