import { AVATAR_COLORS, type PlayerView, type RoomMember, type ViewCard } from "@cgwf/shared";
import { CardTile } from "./CardTile";
import { battlefieldCards, deriveFor, findCard, nameOf, type Printings } from "./model";

/**
 * The sticky bar at the top of my battlefield while I pick attackers or
 * blockers. Attack: choose a target (player or one of their planeswalkers),
 * then tap my creatures; each tile shows who it attacks. Block: choose one of
 * the attackers aimed at me, then tap my untapped creatures. Declaring sends
 * one event; the reducer validates and logs it.
 */

export interface AttackTarget {
  player: string;
  planeswalker: string | null;
}

export type CombatMode = { kind: "attack"; targets: Record<string, AttackTarget>; current: AttackTarget } | { kind: "block"; blocks: Record<string, string>; current: string | null };

export function targetKey(t: AttackTarget): string {
  return t.planeswalker ? `${t.player}:${t.planeswalker}` : t.player;
}

export function colorOf(members: RoomMember[], userId: string): string | undefined {
  const m = members.find((x) => x.userId === userId);
  return m ? AVATAR_COLORS[m.color] : undefined;
}

/** Every legal attack target: each living opponent and their planeswalkers / battles. */
export function attackTargets(view: PlayerView, printings: Printings, me: string): Array<{ target: AttackTarget; label: string; short: string }> {
  const out: Array<{ target: AttackTarget; label: string; short: string }> = [];
  for (const id of view.turnOrder) {
    const p = view.players[id]!;
    if (id === me || p.conceded || p.eliminated) continue;
    out.push({ target: { player: id, planeswalker: null }, label: p.name, short: p.name.slice(0, 2) });
    for (const c of battlefieldCards(p)) {
      const printing = c.printingId ? printings[c.printingId] : null;
      const type = (c.custom?.typeLine ?? printing?.typeLine ?? "").toLowerCase();
      if (!/\b(planeswalker|battle)\b/.test(type) || c.faceDown) continue;
      const name = nameOf(c, printings);
      out.push({ target: { player: id, planeswalker: c.iid }, label: `${p.name}'s ${name}`, short: name.slice(0, 2) });
    }
  }
  return out;
}

export function CombatBar({
  mode,
  view,
  printings,
  members,
  me,
  onPickTarget,
  onPickAttacker,
  onDeclare,
  onCancel,
  onZoom,
}: {
  mode: CombatMode;
  view: PlayerView;
  printings: Printings;
  members: RoomMember[];
  me: string;
  onPickTarget: (t: AttackTarget) => void;
  onPickAttacker: (iid: string) => void;
  onDeclare: () => void;
  onCancel: () => void;
  onZoom: (c: ViewCard) => void;
}) {
  if (mode.kind === "attack") {
    const targets = attackTargets(view, printings, me);
    const n = Object.keys(mode.targets).length;
    return (
      <div className="combat-bar" role="region" aria-label="Declare attackers">
        <div className="combat-bar-head">
          <strong>Attack</strong>
          <span className="muted small">Pick a target, then tap the creatures that attack it. Tap again to take one back.</span>
        </div>
        <div className="combat-chips">
          {targets.map(({ target, label }) => {
            const key = targetKey(target);
            const selected = targetKey(mode.current) === key;
            const count = Object.values(mode.targets).filter((t) => targetKey(t) === key).length;
            return (
              <button key={key} className={`chip combat-chip${selected ? " is-selected" : ""}`} style={{ "--who": colorOf(members, target.player) ?? "var(--accent)" } as React.CSSProperties} onClick={() => onPickTarget(target)} aria-pressed={selected}>
                <span className="combat-chip-dot" aria-hidden="true" />
                {label}
                {count > 0 && <span className="combat-chip-count">{count}</span>}
              </button>
            );
          })}
          {targets.length === 0 && <span className="muted small">Nobody left to attack.</span>}
        </div>
        <div className="combat-bar-actions">
          <button className="btn btn-small btn-primary" disabled={n === 0} onClick={onDeclare}>
            Declare {n === 0 ? "attack" : `${n} attacker${n === 1 ? "" : "s"}`}
          </button>
          <button className="btn btn-small" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const combat = view.combat;
  const attackers = combat ? combat.attackers.filter((a) => a.player === me) : [];
  const n = Object.keys(mode.blocks).length;
  return (
    <div className="combat-bar" role="region" aria-label="Declare blockers">
      <div className="combat-bar-head">
        <strong>Block</strong>
        <span className="muted small">Pick an attacker, then tap your untapped creatures that block it. Several blockers may share one attacker.</span>
      </div>
      <div className="combat-attackers">
        {attackers.map((a) => {
          const c = findCard(view, a.iid);
          if (!c) return null;
          const owner = view.players[c.zone.owner];
          const d = owner ? deriveFor(owner, printings).cards.get(c.iid) : undefined;
          const blockers = Object.entries(mode.blocks).filter(([, att]) => att === a.iid).length;
          const selected = mode.current === a.iid;
          return (
            <div key={a.iid} className={`combat-attacker${selected ? " is-selected" : ""}`} role="button" tabIndex={0} onClick={() => onPickAttacker(a.iid)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPickAttacker(a.iid)} aria-pressed={selected}>
              <CardTile card={c} printings={printings} onHold={onZoom} derived={d} />
              <span className="combat-attacker-text">
                <span>{nameOf(c, printings)}</span>
                {d?.isCreature && d.power !== null && (
                  <strong>
                    {d.power}/{d.toughness}
                  </strong>
                )}
                {d && d.keywords.length > 0 && <span className="muted small">{d.keywords.join(", ")}</span>}
                {a.planeswalker && <span className="muted small">at {creature(view, printings, a.planeswalker)}</span>}
                {blockers > 0 && <span className="combat-chip-count">{blockers} blocking</span>}
              </span>
            </div>
          );
        })}
      </div>
      <div className="combat-bar-actions">
        <button className="btn btn-small btn-primary" onClick={onDeclare}>
          {n === 0 ? "Declare no blocks" : `Declare ${n} block${n === 1 ? "" : "s"}`}
        </button>
        <button className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function creature(view: PlayerView, printings: Printings, iid: string): string {
  const c = findCard(view, iid);
  return c ? nameOf(c, printings) : "a permanent";
}
