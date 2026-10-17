import { useMemo, useState } from "react";
import { combatContextFromView, lethalFrom, proposeDamage, type DamageAssignment, type EventInput, type PlayerView } from "@cgwf/shared";
import { findCard, nameOf, type Printings } from "./model";
import { Panel } from "./Panels";

/**
 * The attacker's damage sheet: the table's default assignment (power to
 * blockers in order, the rest to the player, blockers hitting back), each
 * amount editable, with a note on what would die. "Apply" sends one
 * CombatDamageDealt; untouched rows send the default so the log says so.
 */

interface Row {
  key: string;
  source: string;
  target: DamageAssignment["target"];
  amount: number;
  /** An extra row the proposal did not have (e.g. trample over to the player), shown at 0. */
  extra: boolean;
}

function rowKey(a: { source: string; target: DamageAssignment["target"] }): string {
  return `${a.source}>${a.target.kind === "player" ? `p:${a.target.player}` : `c:${a.target.iid}`}`;
}

export function DamageSheet({ view, printings, dispatch, onClose }: { view: PlayerView; printings: Printings; dispatch: (e: EventInput) => void; onClose: () => void }) {
  const ctx = useMemo(() => combatContextFromView(view, printings), [view, printings]);
  const proposal = useMemo(() => proposeDamage(ctx), [ctx]);
  const initial = useMemo(() => {
    const rows: Row[] = proposal.map((a) => ({ key: rowKey(a), source: a.source, target: a.target, amount: a.amount, extra: false }));
    // A blocked attacker may also want to assign to the player (trample, or a player's call): offer the row at 0.
    for (const a of view.combat?.attackers ?? []) {
      const blocked = (view.combat?.blockers ?? []).some((b) => b.attacker === a.iid);
      if (!blocked) continue;
      const target: DamageAssignment["target"] = a.planeswalker ? { kind: "card", iid: a.planeswalker } : { kind: "player", player: a.player };
      const key = rowKey({ source: a.iid, target });
      if (!rows.some((r) => r.key === key)) rows.push({ key, source: a.iid, target, amount: 0, extra: true });
    }
    return rows;
  }, [proposal, view.combat]);
  const [rows, setRows] = useState<Row[]>(initial);
  const edited = rows.some((r) => {
    const p = proposal.find((a) => rowKey(a) === r.key);
    return (p?.amount ?? 0) !== r.amount;
  });
  const lethal = useMemo(() => lethalFrom(ctx, rows.map((r) => ({ source: r.source, target: r.target, amount: r.amount }))), [ctx, rows]);

  const label = (iid: string) => {
    const c = findCard(view, iid);
    return c ? nameOf(c, printings) : "a card";
  };
  const targetLabel = (t: DamageAssignment["target"]) => (t.kind === "player" ? (view.players[t.player]?.name ?? "?") : label(t.iid));
  const bySource = new Map<string, Row[]>();
  for (const r of rows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);

  const apply = () => {
    if (edited) dispatch({ type: "CombatDamageDealt", payload: { assignments: rows.filter((r) => r.amount > 0).map((r) => ({ source: r.source, target: r.target, amount: r.amount })) } });
    else dispatch({ type: "CombatDamageDealt", payload: {} });
    onClose();
  };

  return (
    <Panel title="Combat damage" subtitle="The table's default; change any number before applying" onClose={onClose} className="damage-sheet">
      {rows.length === 0 && <p className="muted">No damage to assign: nothing is attacking.</p>}
      <div className="damage-groups">
        {[...bySource].map(([source, list]) => {
          const src = findCard(view, source);
          const stats = ctx.stats(source);
          return (
            <section key={source} className="damage-group">
              <h3>
                {label(source)}
                {stats?.isCreature && stats.power !== null && (
                  <span className="muted small">
                    {" "}
                    {stats.power}/{stats.toughness}
                    {stats.keywords.length ? ` - ${stats.keywords.join(", ")}` : ""}
                  </span>
                )}
                {src && src.zone.owner !== view.combat?.attacker && <span className="muted small"> (blocker)</span>}
              </h3>
              {list.map((r) => (
                <label key={r.key} className={`damage-row${r.extra && r.amount === 0 ? " is-extra" : ""}`}>
                  <span className="damage-target">
                    &rarr; {targetLabel(r.target)}
                    {r.target.kind === "player" && view.players[r.target.player] ? <span className="muted small"> ({view.players[r.target.player]!.life} life)</span> : null}
                  </span>
                  <span className="damage-amount">
                    <button type="button" className="chip" aria-label="Less" onClick={() => setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: Math.max(0, x.amount - 1) } : x)))}>
                      &minus;
                    </button>
                    <input type="number" inputMode="numeric" min={0} max={999} value={r.amount} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: Math.max(0, Math.min(999, Math.trunc(Number(e.target.value)) || 0)) } : x)))} />
                    <button type="button" className="chip" aria-label="More" onClick={() => setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: Math.min(999, x.amount + 1) } : x)))}>
                      +
                    </button>
                  </span>
                </label>
              ))}
            </section>
          );
        })}
      </div>
      {lethal.length > 0 && (
        <p className="small damage-lethal">
          Lethal damage on {lethal.map(label).join(", ")}: move them to the graveyard afterwards unless something saves them.
        </p>
      )}
      <p className="muted small">Life, poison (infect), commander damage, lifelink and planeswalker loyalty are applied for you. First strike and prevention are not: adjust the numbers.</p>
      <div className="actions">
        <button className="btn" onClick={onClose}>
          Not yet
        </button>
        <button className="btn btn-primary" onClick={apply} disabled={rows.length === 0}>
          {edited ? "Apply this damage" : "Apply default damage"}
        </button>
      </div>
    </Panel>
  );
}
