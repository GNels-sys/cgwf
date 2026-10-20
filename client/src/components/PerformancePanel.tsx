import { useEffect, useState } from "react";
import { PLAYER_COUNTS, TABLE_BRACKETS, LOW_SAMPLE, type DeckAnalysis, type DeckPerformance } from "@cgwf/shared";
import { api } from "../api";
import { PowerBadge } from "./PowerBadge";
import { performanceFit, powerValue } from "./performanceFit";

export function pct(r: number | null): string {
  return r === null ? "–" : `${Math.round(r * 100)}%`;
}

/** Counted game results, with an explicitly provisional best-fit seating hint. */
export function PerformancePanel({ deckRef, title = "Performance", analysis, includeBots, onIncludeBotsChange }: {
  deckRef: string; title?: string; analysis?: DeckAnalysis | null;
  includeBots?: boolean; onIncludeBotsChange?: (value: boolean) => void;
}) {
  const [localBots, setLocalBots] = useState(true);
  const bots = includeBots ?? localBots;
  const [p, setP] = useState<DeckPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    setP(null); // Never show a recommendation from the previous deck/filter.
    api.deckStats.deck(deckRef, bots)
      .then((r) => { if (live) setP(r); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [deckRef, bots, attempt]);

  const fit = p ? performanceFit(p) : null;
  const belowFloor = Boolean(fit && analysis && powerValue(fit.level) < analysis.floor);
  const differs = Boolean(fit && analysis && powerValue(fit.level) !== analysis.suggested);
  const cell = (tb: number, pc: number) => p?.grid.find((c) => c.tableBracket === tb && c.players === pc);

  return <section className="surface perf-panel" aria-label={title}>
    <div className="perf-head analysis-panel-heading">
      <div className="analysis-panel-title">
        <span className="analysis-panel-glyph" aria-hidden="true">◇</span>
        <div><p className="eyebrow">Battle record</p><h2>{title}</h2></div>
      </div>
      <label className="perf-bots">
        <input type="checkbox" checked={bots} onChange={(e) => (onIncludeBotsChange ?? setLocalBots)(e.target.checked)} /> Include games vs bots
      </label>
    </div>
    {error && <div className="notice error"><p>{error}</p><button className="btn btn-small" onClick={() => setAttempt((n) => n + 1)}>Retry performance</button></div>}
    {!p && !error && <p className="muted" role="status">Loading counted results…</p>}
    {p && p.overall.games === 0 && <div className="perf-empty">
      <strong>Your record starts here.</strong>
      <p className="muted">No counted games yet. Games count when they finish on a rules-engine table that is not marked Test{bots ? "" : " and had no bots"}.</p>
      <p className="small muted">A results-based recommendation needs at least {LOW_SAMPLE} games in a tested matchup.</p>
    </div>}
    {p && p.overall.games > 0 && <>
      <dl className="perf-overall">
        <div><dt>Games</dt><dd>{p.overall.games}</dd></div>
        <div><dt>Wins</dt><dd>{p.overall.wins}</dd></div>
        <div><dt>Win rate</dt><dd>{pct(p.overall.winRate)}</dd></div>
        <div><dt>Avg place</dt><dd>{p.overall.avgPlace === null ? "–" : p.overall.avgPlace.toFixed(1)}</dd></div>
      </dl>
      <div className={`perf-fit${fit ? " has-fit" : ""}`} data-power={fit?.level ?? "unknown"}>
        <div className="perf-fit-heading">
          <div><p className="eyebrow">{belowFloor ? "Observed fit · review seating" : fit?.provisional ? "Provisional recommendation" : fit ? "Recommended spot" : "More results needed"}</p>
            <h3>{fit ? `${fit.level === "3+" ? "Between B3 and B4" : `Best tested fit: B${fit.level}`} · ${fit.cell.players} players` : "No balanced fit established yet"}</h3>
          </div>
          {fit && <PowerBadge level={fit.level} label="Results fit" />}
        </div>
        {fit ? <>
          <p className="small">{fit.between ? "Above an even share at B3, below it at B4 for this player count. B3+ is an informal discussion label, not a change to the recorded table brackets." : "Closest tested win rate to an even share for this table size; it is not the matchup with the most wins."} Based on {fit.evidenceGames} counted games{bots ? ", including games against bots" : ", with bot games excluded"}.</p>
          {fit.provisional && <p className="small muted">Early signal: fewer than 20 games in at least one supporting matchup. Keep testing before treating this as a settled rating.</p>}
          <div className={`perf-analysis-comparison${differs ? " is-different" : ""}`}>
            {analysis ? <>
              <PowerBadge level={analysis.suggested} label="Card analysis" />
              <span className="small">{differs ? `Results differ from card analysis (B${analysis.suggested} → B${fit.level}).` : "Results and card analysis agree."}</span>
              {belowFloor && <p className="perf-floor-note small">Card analysis sets a B{analysis.floor} minimum. These results do not make this list eligible for a lower-bracket table; discuss the list and any changes before seating it there.</p>}
            </> : <>
              {p.deckBracket !== null && <PowerBadge level={p.deckBracket} label="Last recorded" />}
              <span className="small muted">The current card analysis is not available in this view. A recorded bracket is historical.</span>
            </>}
          </div>
        </> : <p className="small muted">Each matchup needs at least {LOW_SAMPLE} games. Untested or consistently one-sided matchups are not recommended.</p>}
      </div>
      {p.hint && <p className="perf-hint small">{p.hint}</p>}
      <div className="perf-grid-wrap" role="region" aria-label="Win rates by table bracket and player count" tabIndex={0}>
        <table className="perf-grid">
          <caption className="small muted">Wins / games by table bracket and number of players{p.deckBracket ? ` (last recorded deck bracket: B${p.deckBracket})` : ""}</caption>
          <thead><tr><th scope="col">Table</th>{PLAYER_COUNTS.map((pc) => <th key={pc} scope="col">{pc} players<span className="perf-baseline">Even share {pct(1 / pc)}</span></th>)}</tr></thead>
          <tbody>{TABLE_BRACKETS.map((tb) => <tr key={tb} className={p.deckBracket === tb ? "is-own-bracket" : undefined} data-power={tb}>
            <th scope="row"><PowerBadge level={tb} /></th>
            {PLAYER_COUNTS.map((pc) => {
              const c = cell(tb, pc);
              const best = fit?.cell.tableBracket === tb && fit.cell.players === pc;
              return <td key={pc} data-power={best ? fit.level : tb} className={`${c ? c.lowSample ? "is-low" : "" : "is-empty"}${best ? " is-recommended" : ""}`} title={c?.lowSample ? `Fewer than ${LOW_SAMPLE} games: too few to read much into` : undefined}>
                {c ? <>
                  {best && <span className="perf-cell-pick"><span aria-hidden="true">✦ </span>{belowFloor ? "Best observed fit" : "Recommended"}{fit?.level === "3+" ? " · B3+" : ""}</span>}
                  <span className="perf-cell-record">{c.wins}/{c.games} <span className="muted">{pct(c.winRate)}</span>{c.lowSample && <span className="perf-low" aria-label="few games">*</span>}</span>
                  <span className="perf-win-track" aria-hidden="true"><i style={{ width: `${(c.winRate ?? 0) * 100}%` }} /></span>
                </> : "–"}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <p className="small muted">* fewer than {LOW_SAMPLE} games. An even share at a table of N players is 1 in N. A B3+ highlight marks a tested B3 cell and an inferred fit between B3 and B4.</p>
      <details className="perf-method"><summary>How the recommendation is chosen</summary>
        <p className="small muted">Compare each tested matchup with its own 1/N baseline. Prefer the closest win rate, then more games, then larger tables, then the higher bracket if tied. At least {LOW_SAMPLE} games are required per cell. B3+ needs the same player count tested at both B3 and B4: at least 1.25× an even share at B3 and at most 0.75× at B4. Other recommendations need between 0.5× and 1.5× an even share. Results include earlier recorded versions of this deck. This is a table-discussion aid, not a rules classification.</p>
      </details>
      {p.headToHead.length > 0 && <details className="perf-h2h">
        <summary>Head to head ({p.headToHead.length} opposing decks)</summary>
        <div className="perf-grid-wrap" tabIndex={0} role="region" aria-label="Head to head results"><table className="perf-h2h-table">
          <thead><tr><th scope="col">Against</th><th scope="col">Games</th><th scope="col">Won</th><th scope="col">Lost to it</th><th scope="col">Placed above</th></tr></thead>
          <tbody>{p.headToHead.map((h) => <tr key={h.deckRef}><th scope="row">{h.deckName}{h.library && <span className="muted small"> (library)</span>}</th><td>{h.games}</td><td>{h.wins}</td><td>{h.losses}</td><td>{h.ahead}</td></tr>)}</tbody>
        </table></div>
      </details>}
    </>}
  </section>;
}
