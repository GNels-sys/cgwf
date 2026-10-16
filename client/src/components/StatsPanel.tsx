import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  CARD_TYPE_KEYS,
  CARD_TYPE_LABELS,
  FUNCTIONAL_LABELS,
  PIP_COLOR_NAMES,
  WUBRG,
  parseManaSymbol,
  type DeckStats,
  type DeckStatsResponse,
  type FunctionalKey,
  type PipColor,
} from "@cgwf/shared";
import { ManaDotView } from "./ManaCost";
import "../stats.css";

/**
 * The "Stats" panel on a deck page: mana curve, mana value totals, pips, mana
 * sources against pips, type/colour/land/creature breakdowns and the functional
 * counts (ramp, draw, removal, ...). Charts are plain CSS bars in the app's
 * theme colours; every value is also written out as text, so nothing depends
 * on colour alone. No model spend; the server computes everything from card data.
 */

interface BarRow {
  key: string;
  /** Visible label (text or a mana dot + text). */
  label: ReactNode;
  /** Plain-text name for assistive tech. */
  name: string;
  value: number;
  /** CSS colour for the fill; defaults to the accent. */
  color?: string;
  /** Second, lighter bar drawn under the first (sources under pips). */
  secondary?: { value: number; name: string };
  note?: string;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

/** Horizontal bars: label | bar | value. Thin marks, rounded data end, square baseline. */
function Bars({ rows, max, unit = "" }: { rows: BarRow[]; max?: number; unit?: string }) {
  const top = Math.max(1, max ?? Math.max(...rows.flatMap((r) => [r.value, r.secondary?.value ?? 0])));
  return (
    <ul className="stat-bars" role="list">
      {rows.map((r) => (
        <li key={r.key} className={r.secondary ? "stat-bar-row has-secondary" : "stat-bar-row"}>
          <span className="stat-bar-label">{r.label}</span>
          <span className="stat-bar-track" aria-hidden="true">
            <span className="stat-bar-fill" style={{ width: `${(r.value / top) * 100}%`, background: r.color ?? "var(--accent)" }} />
            {r.secondary && <span className="stat-bar-fill stat-bar-fill-secondary" style={{ width: `${(r.secondary.value / top) * 100}%`, background: r.color ?? "var(--accent)" }} />}
          </span>
          <span className="stat-bar-value">
            <span className="sr-only">{r.name}: </span>
            {r.secondary ? (
              <>
                {fmt(r.value)}
                {unit} <span className="muted">/ {fmt(r.secondary.value)}</span>
              </>
            ) : (
              <>
                {fmt(r.value)}
                {unit}
              </>
            )}
          </span>
          {r.note && <span className="stat-bar-note small muted">{r.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function colorVar(c: PipColor): string {
  return `var(--mana-${c})`;
}

function ColorLabel({ color }: { color: PipColor }) {
  return (
    <span className="stat-color-label">
      <ManaDotView dot={parseManaSymbol(color)} size={16} />
      <span>{color}</span>
    </span>
  );
}

function Section({ title, defaultOpen = false, children, aside }: { title: string; defaultOpen?: boolean; children: ReactNode; aside?: ReactNode }) {
  return (
    <details className="stat-section" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {aside && <span className="muted small stat-section-aside">{aside}</span>}
      </summary>
      <div className="stat-section-body">{children}</div>
    </details>
  );
}

function Curve({ s }: { s: DeckStats }) {
  const [withLands, setWithLands] = useState(false);
  const rows: BarRow[] = s.curve.map((b) => ({
    key: String(b.value),
    label: b.value === 7 ? "7+" : String(b.value),
    name: `mana value ${b.value === 7 ? "7 or more" : b.value}`,
    value: withLands ? b.nonland + b.lands : b.nonland,
  }));
  const mv = s.manaValue;
  return (
    <>
      <label className="stat-toggle">
        <input type="checkbox" checked={withLands} onChange={(e) => setWithLands(e.target.checked)} />
        <span>Include lands</span>
      </label>
      <Bars rows={rows} />
      <dl className="stat-facts">
        <div>
          <dt>Average mana value</dt>
          <dd>
            {mv.averageNonland.toFixed(2)} <span className="muted small">without lands</span> · {mv.averageAll.toFixed(2)} <span className="muted small">with lands</span>
          </dd>
        </div>
        <div>
          <dt>Total mana value</dt>
          <dd>
            {fmt(mv.total)} <span className="muted small">over {mv.cardCount} cards, X counted as 0</span>
          </dd>
        </div>
      </dl>
    </>
  );
}

function Pips({ s }: { s: DeckStats }) {
  const p = s.pips;
  const colours = (["W", "U", "B", "R", "G", "C"] as PipColor[]).filter((c) => p.colored[c] > 0);
  const rows: BarRow[] = colours.map((c) => ({ key: c, label: <ColorLabel color={c} />, name: `${PIP_COLOR_NAMES[c]} pips`, value: p.colored[c], color: colorVar(c) }));
  const max = Math.max(1, ...colours.map((c) => p.colored[c]), p.generic);
  return (
    <>
      {rows.length ? <Bars rows={rows} max={max} /> : <p className="small muted">No coloured pips.</p>}
      <Bars rows={[{ key: "generic", label: "Generic", name: "generic mana", value: p.generic, color: "var(--mana-generic)" }]} max={max} />
      <p className="small muted">
        {fmt(p.coloredTotal)} coloured pips and {p.generic} generic in the costs.
        {p.hybridSymbols > 0 && ` ${p.hybridSymbols} hybrid symbol${p.hybridSymbols === 1 ? "" : "s"} split half to each colour.`}
        {p.phyrexianSymbols > 0 && ` ${p.phyrexianSymbols} Phyrexian symbol${p.phyrexianSymbols === 1 ? "" : "s"} counted for ${p.phyrexianSymbols === 1 ? "its" : "their"} colour.`}
        {p.xSpells > 0 && ` X spells (${p.xSpellNames.join(", ")}) count X as 0.`}
      </p>
    </>
  );
}

function Sources({ s }: { s: DeckStats }) {
  const pr = s.production;
  const rows: BarRow[] = pr.rows.map((r) => ({
    key: r.color,
    label: <ColorLabel color={r.color} />,
    name: `${PIP_COLOR_NAMES[r.color]}: pips`,
    value: r.pips,
    color: colorVar(r.color),
    secondary: { value: r.sources, name: "sources" },
    ...(r.note ? { note: r.note } : {}),
  }));
  const kinds = [
    ["land", "Lands"],
    ["rock", "Rocks"],
    ["dork", "Dorks"],
    ["other", "Other"],
  ] as const;
  return (
    <>
      <p className="small muted stat-legend">
        <span className="stat-legend-key" aria-hidden="true">
          <span className="stat-legend-swatch" />
        </span>{" "}
        pips in costs <span className="muted">/</span>{" "}
        <span className="stat-legend-key" aria-hidden="true">
          <span className="stat-legend-swatch is-secondary" />
        </span>{" "}
        cards that make the colour
      </p>
      {rows.length ? <Bars rows={rows} /> : <p className="small muted">No coloured costs and no mana sources found.</p>}
      <p className="stat-summary">{pr.summary}</p>
      <p className="small muted">
        {pr.guideline.text}{" "}
        <a href={pr.guideline.url} target="_blank" rel="noreferrer">
          {pr.guideline.author}, &ldquo;{pr.guideline.title}&rdquo;
        </a>
        .
      </p>
      <details className="stat-sublist">
        <summary>
          Source cards <span className="muted small">({pr.totalSources})</span>
        </summary>
        {kinds.map(([kind, label]) => {
          const list = pr.cards.filter((c) => c.kind === kind);
          if (!list.length) return null;
          return (
            <p key={kind} className="small">
              <strong>{label}</strong> ({pr.byKind[kind]}):{" "}
              {list.map((c, i) => (
                <span key={c.name}>
                  {i > 0 && ", "}
                  {c.quantity > 1 ? `${c.quantity} ` : ""}
                  {c.name} <span className="muted">({c.produces.map((x) => (x === "any" ? "any" : x)).join("/")})</span>
                </span>
              ))}
            </p>
          );
        })}
      </details>
    </>
  );
}

function BreakdownsView({ s }: { s: DeckStats }) {
  const b = s.breakdowns;
  const typeRows: BarRow[] = CARD_TYPE_KEYS.filter((k) => b.types[k] > 0).map((k) => ({ key: k, label: CARD_TYPE_LABELS[k], name: CARD_TYPE_LABELS[k], value: b.types[k] }));
  const colourRows: BarRow[] = WUBRG.filter((c) => b.colors[c] > 0).map((c) => ({ key: c, label: <ColorLabel color={c} />, name: `${PIP_COLOR_NAMES[c]} cards`, value: b.colors[c], color: colorVar(c) }));
  return (
    <>
      <h5>Card types</h5>
      <Bars rows={typeRows} />
      <p className="small muted">A card with two types (an artifact creature) counts once in each; the front face decides.</p>
      <h5>Colours of nonland cards</h5>
      {colourRows.length ? <Bars rows={colourRows} /> : <p className="small muted">No coloured cards.</p>}
      <p className="small muted">
        A multicolour card counts in each of its colours. {b.multicolor} multicolour, {b.colorless} colourless.
      </p>
      <dl className="stat-facts">
        <div>
          <dt>Lands</dt>
          <dd>
            {b.lands.total} <span className="muted small">({b.lands.basic} basic, {b.lands.nonbasic} nonbasic)</span>
          </dd>
        </div>
        <div>
          <dt>Creatures</dt>
          <dd>
            {b.creatures.count}
            {b.creatures.averagePower !== null && b.creatures.averageToughness !== null && (
              <span className="muted small">
                {" "}
                · average {fmt(b.creatures.averagePower)}/{fmt(b.creatures.averageToughness)}
                {b.creatures.nonNumeric > 0 && ` (${b.creatures.nonNumeric} with */* left out)`}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>X spells</dt>
          <dd>
            {b.xSpells}
            {s.pips.xSpellNames.length > 0 && <span className="muted small"> · {s.pips.xSpellNames.join(", ")}</span>}
          </dd>
        </div>
        <div>
          <dt>Token makers</dt>
          <dd>
            {b.tokenMakers.count}
            {b.tokenMakers.names.length > 0 && (
              <details className="stat-inline-details">
                <summary className="small">show cards</summary>
                <span className="small muted">{b.tokenMakers.names.join(", ")}</span>
              </details>
            )}
          </dd>
        </div>
      </dl>
    </>
  );
}

function Functional({ s }: { s: DeckStats }) {
  return (
    <>
      <ul className="stat-functional" role="list">
        {s.functional.map((f) => (
          <li key={f.key}>
            <details className="stat-sublist">
              <summary>
                <span>{FUNCTIONAL_LABELS[f.key]}</span>
                <span className="stat-functional-count">{f.count}</span>
              </summary>
              {f.cards.length ? (
                <p className="small">
                  {f.cards.map((c, i) => (
                    <span key={c.name}>
                      {i > 0 && ", "}
                      {c.quantity > 1 ? `${c.quantity} ` : ""}
                      {c.name}
                    </span>
                  ))}
                </p>
              ) : (
                <p className="small muted">None matched.</p>
              )}
            </details>
          </li>
        ))}
      </ul>
      <p className="small muted">Counted from card text with simple patterns, so unusual wordings are missed and a card can sit in more than one list. Tap a row to see what was counted.</p>
    </>
  );
}

function count(s: DeckStats, key: FunctionalKey): number {
  return s.functional.find((f) => f.key === key)?.count ?? 0;
}

export function StatsBody({ s }: { s: DeckStats }) {
  const total = s.manaValue;
  return (
    <>
      <Section title="Mana curve" defaultOpen aside={`avg ${total.averageNonland.toFixed(2)}`}>
        <Curve s={s} />
      </Section>
      <Section title="Pips" aside={`${fmt(s.pips.coloredTotal)} coloured`}>
        <Pips s={s} />
      </Section>
      <Section title="Mana sources vs pips" defaultOpen aside={`${s.production.totalSources} sources`}>
        <Sources s={s} />
      </Section>
      <Section title="Breakdowns" aside={`${total.landCount} lands · ${s.breakdowns.creatures.count} creatures`}>
        <BreakdownsView s={s} />
      </Section>
      <Section title="What the deck does" aside={`${count(s, "ramp")} ramp · ${count(s, "draw")} draw · ${count(s, "removal")} removal`}>
        <Functional s={s} />
      </Section>
    </>
  );
}

/**
 * `load` fetches the stats (own deck or library deck); `version` changes
 * whenever the list changes, which refetches. The server caches per version.
 */
export function StatsPanel({ load, version }: { load: () => Promise<DeckStatsResponse>; version: string }) {
  const [stats, setStats] = useState<DeckStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    try {
      const r = await load();
      setStats(r.stats);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [load]);

  useEffect(() => {
    void run();
  }, [run, version]);

  return (
    <section className="bracket-panel stats-panel" aria-labelledby="stats-heading">
      <div className="row-between">
        <h3 id="stats-heading">Stats</h3>
        {stats && (
          <span className="muted small">
            {stats.manaValue.cardCount} cards{stats.commanders.length ? " incl. commander" : ""}
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {!stats && !error && <p className="muted small">Counting...</p>}
      {stats && <StatsBody s={stats} />}
    </section>
  );
}
