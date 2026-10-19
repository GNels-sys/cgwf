import { useEffect, useState } from "react";
import { PLAYER_COUNTS, TABLE_BRACKETS, LOW_SAMPLE, type DeckPerformance } from "@cgwf/shared";
import { api } from "../api";

export function pct(r: number | null): string {
  return r === null ? "–" : `${Math.round(r * 100)}%`;
}

/**
 * A deck's record in counted rules-engine games (not test games, finished with a result): overall,
 * a table-bracket x player-count grid (cells under LOW_SAMPLE games marked), a plain-language hint when
 * the deck clearly over- or under-performs its bracket, and head-to-head. "Include games vs bots" toggle.
 * `deckRef` = an own deck id or `library:<id>`.
 */
export function PerformancePanel({ deckRef, title = "Performance" }: { deckRef: string; title?: string }) {
  const [bots, setBots] = useState(true);
  const [p, setP] = useState<DeckPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api.deckStats
      .deck(deckRef, bots)
      .then((r) => live && setP(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [deckRef, bots]);

  const cell = (tb: number, pc: number) => p?.grid.find((c) => c.tableBracket === tb && c.players === pc);

  return (
    <section className="surface perf-panel" aria-label={title}>
      <div className="perf-head">
        <h2>{title}</h2>
        <label className="perf-bots">
          <input type="checkbox" checked={bots} onChange={(e) => setBots(e.target.checked)} /> Include games vs bots
        </label>
      </div>
      {error && <p className="error small">{error}</p>}
      {p && p.overall.games === 0 && (
        <p className="muted">No counted games yet. Games count when they finish on a rules-engine table that is not marked Test{bots ? "" : " and had no bots"}.</p>
      )}
      {p && p.overall.games > 0 && (
        <>
          <dl className="perf-overall">
            <div>
              <dt>Games</dt>
              <dd>{p.overall.games}</dd>
            </div>
            <div>
              <dt>Wins</dt>
              <dd>{p.overall.wins}</dd>
            </div>
            <div>
              <dt>Win rate</dt>
              <dd>{pct(p.overall.winRate)}</dd>
            </div>
            <div>
              <dt>Avg place</dt>
              <dd>{p.overall.avgPlace === null ? "–" : p.overall.avgPlace.toFixed(1)}</dd>
            </div>
          </dl>
          {p.hint && <p className="perf-hint small">{p.hint}</p>}
          <div className="perf-grid-wrap">
            <table className="perf-grid">
              <caption className="small muted">Wins / games by table bracket and number of players{p.deckBracket ? ` (this deck: B${p.deckBracket})` : ""}</caption>
              <thead>
                <tr>
                  <th scope="col">Table</th>
                  {PLAYER_COUNTS.map((pc) => (
                    <th key={pc} scope="col">
                      {pc} players
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TABLE_BRACKETS.map((tb) => (
                  <tr key={tb} className={p.deckBracket === tb ? "is-own-bracket" : undefined}>
                    <th scope="row">B{tb}</th>
                    {PLAYER_COUNTS.map((pc) => {
                      const c = cell(tb, pc);
                      return (
                        <td key={pc} className={c ? (c.lowSample ? "is-low" : "") : "is-empty"} title={c?.lowSample ? `Fewer than ${LOW_SAMPLE} games: too few to read much into` : undefined}>
                          {c ? (
                            <>
                              {c.wins}/{c.games} <span className="muted">{pct(c.winRate)}</span>
                              {c.lowSample && <span className="perf-low" aria-label="few games">*</span>}
                            </>
                          ) : (
                            "–"
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">* fewer than {LOW_SAMPLE} games. An even share at a table of N players is 1 in N.</p>
          {p.headToHead.length > 0 && (
            <details className="perf-h2h">
              <summary>Head to head ({p.headToHead.length} opposing decks)</summary>
              <table className="perf-h2h-table">
                <thead>
                  <tr>
                    <th scope="col">Against</th>
                    <th scope="col">Games</th>
                    <th scope="col">Won</th>
                    <th scope="col">Lost to it</th>
                    <th scope="col">Placed above</th>
                  </tr>
                </thead>
                <tbody>
                  {p.headToHead.map((h) => (
                    <tr key={h.deckRef}>
                      <th scope="row">
                        {h.deckName}
                        {h.library && <span className="muted small"> (library)</span>}
                      </th>
                      <td>{h.games}</td>
                      <td>{h.wins}</td>
                      <td>{h.losses}</td>
                      <td>{h.ahead}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </section>
  );
}
