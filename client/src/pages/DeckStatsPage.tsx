import { useEffect, useMemo, useState } from "react";
import type { DeckStatsRow } from "@cgwf/shared";
import { api } from "../api";
import { PageHeading } from "../components/PageHeading";
import { PerformancePanel, pct } from "../components/PerformancePanel";
import { RequireUser } from "../components/RequireUser";

type SortKey = "deckName" | "deckBracket" | "games" | "wins" | "winRate" | "avgPlace";
const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "deckName", label: "Deck" },
  { key: "deckBracket", label: "Bracket" },
  { key: "games", label: "Games" },
  { key: "wins", label: "Wins" },
  { key: "winRate", label: "Win rate" },
  { key: "avgPlace", label: "Avg place" },
];

function compare(a: DeckStatsRow, b: DeckStatsRow, key: SortKey): number {
  const va = a[key];
  const vb = b[key];
  if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb);
  return (va === null ? -Infinity : (va as number)) - (vb === null ? -Infinity : (vb as number));
}

/**
 * Deck stats: your own decks and the library decks you have played, from counted rules-engine games.
 * Library decks show every player's games; your own decks only ever show to you. Sortable; tap a deck
 * for the bracket grid and head-to-head.
 */
function DeckStats() {
  const [bots, setBots] = useState(true);
  const [rows, setRows] = useState<DeckStatsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "games", desc: true });
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.deckStats
      .list(bots)
      .then((r) => live && setRows(r.decks))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [bots]);

  const sorted = useMemo(() => {
    const list = [...(rows ?? [])];
    list.sort((a, b) => compare(a, b, sort.key) * (sort.desc ? -1 : 1) || a.deckName.localeCompare(b.deckName));
    return list;
  }, [rows, sort]);

  const by = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "deckName" && key !== "avgPlace" }));

  return (
    <>
      <div className="deck-stats-bar">
        <label className="perf-bots">
          <input type="checkbox" checked={bots} onChange={(e) => setBots(e.target.checked)} /> Include games vs bots
        </label>
        <span className="muted small">Counted games only: finished rules-engine games not marked Test. Games before 2026-10-19 were tests.</span>
      </div>
      {error && <p className="error">{error}</p>}
      {rows && rows.length === 0 && <p className="muted">No counted games yet. Play a rules-engine game that is not marked Test and it will show here.</p>}
      {rows && rows.length > 0 && (
        <div className="deck-stats-wrap">
          <table className="deck-stats-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                    <button type="button" className="deck-stats-sort" onClick={() => by(c.key)}>
                      {c.label}
                      {sort.key === c.key ? (sort.desc ? " ▾" : " ▴") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => (
                <DeckRow key={d.deckRef} d={d} open={open === d.deckRef} onToggle={() => setOpen((o) => (o === d.deckRef ? null : d.deckRef))} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function DeckRow({ d, open, onToggle }: { d: DeckStatsRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={open ? "is-open" : undefined}>
        <th scope="row">
          <button type="button" className="deck-stats-name" onClick={onToggle} aria-expanded={open}>
            {d.deckName}
          </button>
          <span className="muted small">
            {d.library ? " library" : " yours"}
            {d.commanders.length ? ` · ${d.commanders.join(" / ")}` : ""}
          </span>
        </th>
        <td>{d.deckBracket ? `B${d.deckBracket}` : "–"}</td>
        <td>{d.games}</td>
        <td>{d.wins}</td>
        <td>{pct(d.winRate)}</td>
        <td>{d.avgPlace === null ? "–" : d.avgPlace.toFixed(1)}</td>
      </tr>
      {open && (
        <tr className="deck-stats-detail">
          <td colSpan={6}>
            <PerformancePanel deckRef={d.deckRef} title={d.deckName} />
          </td>
        </tr>
      )}
    </>
  );
}

export function DeckStatsPage() {
  return (
    <main className="page deck-stats-page">
      <PageHeading title="Deck stats" eyebrow="How your decks perform">
        Win rates by table bracket and number of players, and head to head, from counted rules-engine games.
      </PageHeading>
      <RequireUser>
        <DeckStats />
      </RequireUser>
    </main>
  );
}
