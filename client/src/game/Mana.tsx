import { useState } from "react";
import { MANA_COLORS, type EventInput, type ManaColor, type ViewPlayer } from "@cgwf/shared";
import { manaTotal } from "./model";

const COLOR_STYLE: Record<ManaColor, { bg: string; fg: string; label: string }> = {
  W: { bg: "#f3ecd2", fg: "#1a1a1a", label: "White" },
  U: { bg: "#2f7fd6", fg: "#fff", label: "Blue" },
  B: { bg: "#3a3240", fg: "#fff", label: "Black" },
  R: { bg: "#d64a3a", fg: "#fff", label: "Red" },
  G: { bg: "#3f9a56", fg: "#fff", label: "Green" },
  C: { bg: "#9a9a9a", fg: "#1a1a1a", label: "Colorless" },
};

/** Compact "W2 G1" summary for chips and the opponent panel. */
export function ManaSummary({ player }: { player: ViewPlayer }) {
  const parts = MANA_COLORS.filter((c) => player.mana[c] > 0);
  if (!parts.length) return null;
  return (
    <span className="mana-summary" title="Floating mana">
      {parts.map((c) => (
        <span key={c} className="mana-pip" style={{ background: COLOR_STYLE[c].bg, color: COLOR_STYLE[c].fg }}>
          {player.mana[c] > 1 ? player.mana[c] : ""}
          {c}
        </span>
      ))}
    </span>
  );
}

/**
 * Floating mana bank. Collapsed: a pill with the total. Expanded: +/- per
 * colour, convert all, empty, and the "keep between steps" toggle. Every tap is
 * an event so everyone sees the same pool and the log reads "Jordan added GG".
 */
export function ManaBank({ player, dispatch, disabled }: { player: ViewPlayer; dispatch: (e: EventInput) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const total = manaTotal(player);
  const change = (color: ManaColor, delta: number) => dispatch({ type: "ManaChanged", payload: { player: player.id, color, delta } });
  return (
    <div className={`mana-bank${open ? " is-open" : ""}`}>
      <button className={`mana-pill${total ? " has-mana" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} title="Floating mana">
        <span className="mana-word">Mana </span>&#9670; {total}
        {player.keepMana && <span className="mana-keep-mark" title="Kept between steps">&#x1F512;</span>}
      </button>
      {open && (
        <div className="mana-panel" role="group" aria-label="Mana bank">
          <div className="mana-grid">
            {MANA_COLORS.map((c) => (
              <div key={c} className="mana-row">
                <button className="mana-btn" disabled={disabled || player.mana[c] === 0} onClick={() => change(c, -1)} aria-label={`Spend ${COLOR_STYLE[c].label}`}>
                  &minus;
                </button>
                <span className="mana-pip is-big" style={{ background: COLOR_STYLE[c].bg, color: COLOR_STYLE[c].fg }}>
                  {player.mana[c]}
                  <small>{c}</small>
                </span>
                <button className="mana-btn" disabled={disabled} onClick={() => change(c, 1)} aria-label={`Add ${COLOR_STYLE[c].label}`}>
                  +
                </button>
              </div>
            ))}
          </div>
          <div className="mana-actions">
            <label className="mana-convert">
              <span className="muted small">Convert all to</span>
              <select
                disabled={disabled || total === 0}
                value=""
                onChange={(e) => {
                  const to = e.target.value as ManaColor;
                  if (to) dispatch({ type: "ManaConverted", payload: { player: player.id, to } });
                }}
              >
                <option value="">...</option>
                {MANA_COLORS.map((c) => (
                  <option key={c} value={c}>
                    {COLOR_STYLE[c].label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-small" disabled={disabled || total === 0} onClick={() => dispatch({ type: "ManaEmptied", payload: { player: player.id } })}>
              Empty
            </button>
            <label className="toggle mana-keep">
              <input type="checkbox" checked={player.keepMana} disabled={disabled} onChange={(e) => dispatch({ type: "KeepManaToggled", payload: { player: player.id, keep: e.target.checked } })} />
              <span className="small">Keep between steps</span>
            </label>
          </div>
          <p className="muted small mana-note">Empties on its own at each step and turn change unless kept.</p>
        </div>
      )}
    </div>
  );
}
