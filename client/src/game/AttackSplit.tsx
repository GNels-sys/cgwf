import { useEffect, useMemo } from "react";
import type { EngineAnswer, EngineEntityRef, EnginePrompt, PlayerView, RoomMember } from "@cgwf/shared";
import { AVATAR_COLORS } from "@cgwf/shared";
import { attackGroups, clearGroup, countAt, countFree, groupLabel, refKey, sendRest, setCount, splitEvenly, type AttackGroup, type AttackTargets } from "./attackGroups";
import { findCard, nameOf, type Printings } from "./model";

type AttackersPrompt = Extract<EnginePrompt, { kind: "attackers" }>;

interface Props {
  prompt: AttackersPrompt;
  view: PlayerView;
  printings: Printings;
  members: RoomMember[];
  targets: AttackTargets;
  setTargets: (t: AttackTargets) => void;
  answer: (a: EngineAnswer) => void;
  onClose: () => void;
}

function defenderName(d: EngineEntityRef, view: PlayerView, printings: Printings): string {
  if (d.kind === "player") return view.players[d.player]?.name ?? d.name ?? "?";
  const c = findCard(view, d.iid);
  return c ? nameOf(c, printings) : (d.name ?? "a permanent");
}

function colorOf(members: RoomMember[], d: EngineEntityRef): string | undefined {
  const id = d.kind === "player" ? d.player : (d.controller ?? null);
  const m = id ? members.find((x) => x.userId === id) : undefined;
  return m ? AVATAR_COLORS[m.color] : undefined;
}

/**
 * "Send by number" (owner request 2026-11-18): every group of identical attackers with a number per defender,
 * so 110 tokens go out as "30 at Alex, 30 at Blair, 50 at Casey" in a few taps. The numbers edit the same pick
 * state as tapping creatures on the table; closing the sheet keeps them. Nothing is declared until the
 * Declare button (here or in the bar) is pressed.
 */
export function AttackSplitSheet({ prompt, view, printings, members, targets, setTargets, answer, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const groups = useMemo(() => attackGroups(prompt.candidates), [prompt.candidates]);
  const players = prompt.defenders.filter((d) => d.kind === "player");
  const n = Object.keys(targets).length;
  const total = prompt.candidates.length;
  const declare = () => {
    answer({ promptId: prompt.promptId, attacks: Object.entries(targets).map(([iid, defender]) => ({ iid, defender })) });
    onClose();
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet engine-sheet attack-split" role="dialog" aria-modal="true" aria-label="Send attackers by number" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>Send by number</strong>
          <span className="muted small">
            {n} of {total} attacking. Type how many of each group attack each player.
          </span>
          <button className="sheet-close" onClick={onClose} aria-label="Close (your numbers are kept)">
            &times;
          </button>
        </div>
        <div className="split-groups">
          {groups.map((g) => (
            <GroupRow key={g.key} group={g} defenders={prompt.defenders} players={players} view={view} printings={printings} members={members} targets={targets} setTargets={setTargets} />
          ))}
          {groups.length === 0 && <p className="muted small">None of your creatures can attack.</p>}
        </div>
        <div className="split-actions">
          <button className="btn" onClick={onClose}>
            Back to the table
          </button>
          <button className="btn btn-primary" disabled={n === 0} onClick={declare}>
            Declare {n === 0 ? "attack" : `${n} attacker${n === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupRow({ group, defenders, players, view, printings, members, targets, setTargets }: { group: AttackGroup; defenders: EngineEntityRef[]; players: EngineEntityRef[]; view: PlayerView; printings: Printings; members: RoomMember[]; targets: AttackTargets; setTargets: (t: AttackTargets) => void }) {
  const size = group.iids.length;
  const free = countFree(group, targets);
  const label = groupLabel(group);
  const allowed = defenders.filter((d) => group.pool.some((p) => refKey(p) === refKey(d)));
  const evenTo = players.filter((d) => group.pool.some((p) => refKey(p) === refKey(d)));
  return (
    <section className="split-group" aria-label={`${size} ${label}`}>
      <div className="split-group-head">
        <strong>{label}</strong>
        <span className="split-size">&times;{size}</span>
        <span className="muted small">{free === 0 ? "all attacking" : free === size ? "none attacking" : `${free} not attacking`}</span>
        {group.required && <span className="split-must small">must attack</span>}
        <span className="split-group-tools">
          {size > 1 && evenTo.length > 1 && (
            <button className="btn btn-small" onClick={() => setTargets(splitEvenly(targets, group, evenTo))}>
              Split evenly
            </button>
          )}
          <button className="btn btn-small" disabled={free === size} onClick={() => setTargets(clearGroup(targets, group))}>
            None
          </button>
        </span>
      </div>
      <div className="split-cells">
        {allowed.map((d) => {
          const here = countAt(group, targets, d);
          const who = defenderName(d, view, printings);
          const set = (value: number) => setTargets(setCount(targets, group, d, value));
          return (
            <div key={refKey(d)} className="split-cell" style={{ "--who": colorOf(members, d) ?? "var(--accent)" } as React.CSSProperties}>
              <span className="split-who">
                <span className="combat-chip-dot" aria-hidden="true" />
                {who}
              </span>
              <span className="split-stepper">
                <button className="btn btn-small" disabled={here === 0} onClick={() => set(here - 1)} aria-label={`One fewer ${group.name} at ${who}`}>
                  &minus;
                </button>
                <input
                  className="split-input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={String(here)}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => set(Number(e.currentTarget.value.replace(/\D/g, "").slice(0, 5)) || 0)}
                  aria-label={`${group.name} attacking ${who}, of ${here + free} available`}
                />
                <button className="btn btn-small" disabled={free === 0} onClick={() => set(here + 1)} aria-label={`One more ${group.name} at ${who}`}>
                  +
                </button>
              </span>
              <button className="btn btn-small split-rest" disabled={free === 0} onClick={() => setTargets(sendRest(targets, group, d))}>
                {free === 0 ? "No more" : free === size ? `All ${size}` : `Rest (${free})`}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
