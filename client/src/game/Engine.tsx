import { useEffect, useState } from "react";
import { AVATAR_COLORS, type EngineAnswer, type EngineEntityRef, type EngineOption, type EnginePrompt, type PlayerView, type RoomMember, type ViewCard } from "@cgwf/shared";
import { CardImage } from "../components/CardImage";
import { CardTile } from "./CardTile";
import { describeOption, sheetPromptSummary } from "./EnginePrompts";
import { findCard, nameOf, type Printings } from "./model";
import { mulliganNote } from "./openingHandText";
import { canConfirm, choiceLabel, isOptionalChoice, noneAnswer, noneLabel, noneQuestion } from "./optionalChoice";
import { GroupedChoiceSheet, primaryLabel } from "./ChoiceSheet";
import { isGroupedChoice } from "./choiceGroups";

/**
 * Rules-engine tables: the UI for the prompt the engine is waiting on. The engine decides what is
 * legal; this file only lets the player pick among the options it sent and answers with ids.
 * Cards that are options glow on the table (Table.tsx passes the sets); the bar at the top of the
 * battlefield names the question and holds the buttons; list-shaped choices open a sheet.
 */

export type EnginePick =
  | { kind: "none" }
  /** targets / chooseMany: option indices picked so far. */
  | { kind: "select"; picked: number[] }
  | { kind: "attack"; targets: Record<string, EngineEntityRef>; current: EngineEntityRef | null }
  | { kind: "block"; blocks: Record<string, string>; current: string | null };

export const NO_PICK: EnginePick = { kind: "none" };

export function refKey(r: EngineEntityRef): string {
  return r.kind === "player" ? `p:${r.player}` : `c:${r.iid}`;
}

export function colorOfMember(members: RoomMember[], userId: string): string | undefined {
  const m = members.find((x) => x.userId === userId);
  return m ? AVATAR_COLORS[m.color] : undefined;
}

/** Option indices of cards (by iid) in a list-shaped prompt. */
export function cardOptionIndex(options: EngineOption[], iid: string): number | null {
  const o = options.find((x) => x.kind === "card" && x.iid === iid);
  return o ? o.index : null;
}

/** Which card iids should glow for this prompt. */
export function promptHighlights(prompt: EnginePrompt | null): Set<string> {
  const out = new Set<string>();
  if (!prompt) return out;
  switch (prompt.kind) {
    case "priority":
      for (const o of prompt.options) out.add(o.iid);
      break;
    case "targets":
    case "choose":
    case "chooseMany":
      for (const o of prompt.options) if (o.kind === "card") out.add(o.iid);
      break;
    case "attackers":
      for (const c of prompt.candidates) out.add(c.iid);
      break;
    case "blockers":
      for (const c of prompt.blockers) out.add(c.iid);
      for (const c of prompt.attackers) out.add(c.iid);
      break;
    case "assign":
      for (const o of prompt.targets) if (o.kind === "card") out.add(o.iid);
      if (prompt.card) out.add(prompt.card.iid);
      break;
    case "confirm":
      if (prompt.card) out.add(prompt.card.iid);
      break;
    default:
      break;
  }
  return out;
}

/** The initial pick state for a prompt. */
export function initialPick(prompt: EnginePrompt | null): EnginePick {
  if (!prompt) return NO_PICK;
  switch (prompt.kind) {
    case "targets":
    case "chooseMany":
      return { kind: "select", picked: [] };
    case "attackers": {
      const first = prompt.defenders.find((d) => d.kind === "player") ?? prompt.defenders[0] ?? null;
      return { kind: "attack", targets: {}, current: first };
    }
    case "blockers":
      return { kind: "block", blocks: {}, current: prompt.attackers[0]?.iid ?? null };
    default:
      return NO_PICK;
  }
}

function describeRef(r: EngineEntityRef, view: PlayerView, printings: Printings): string {
  if (r.kind === "player") return view.players[r.player]?.name ?? r.name ?? "?";
  const c = findCard(view, r.iid);
  return c ? nameOf(c, printings) : (r.name ?? "a permanent");
}

export interface EngineBarProps {
  prompt: EnginePrompt;
  view: PlayerView;
  printings: Printings;
  members: RoomMember[];
  me: string;
  pick: EnginePick;
  setPick: (p: EnginePick) => void;
  answer: (a: EngineAnswer) => void;
  onZoom: (c: ViewCard) => void;
  /** Open the list sheet for the current prompt (choose / chooseMany / targets with non-card options). */
  openList: () => void;
}

/** The bar inside the phase strip while the engine waits on me. */
export function EngineBar({ prompt, view, printings, members, me, pick, setPick, answer, onZoom, openList }: EngineBarProps) {
  const id = prompt.promptId;
  switch (prompt.kind) {
    case "priority": {
      const lands = prompt.options.filter((o) => o.kind === "land").length;
      const spells = prompt.options.filter((o) => o.kind === "spell").length;
      const abilities = prompt.options.filter((o) => o.kind === "ability").length;
      const parts = [lands ? `${lands} land${lands === 1 ? "" : "s"}` : "", spells ? `${spells} spell${spells === 1 ? "" : "s"}` : "", abilities ? `${abilities} abilit${abilities === 1 ? "y" : "ies"}` : ""].filter(Boolean);
      return (
        <div className="engine-bar" role="region" aria-label="Your priority">
          <div className="engine-bar-head">
            <strong>{prompt.stackEmpty ? (prompt.myTurn ? "Your move" : "You may respond") : prompt.stackTopMine ? "Your spell or ability is on the stack" : "Something is on the stack: respond?"}</strong>
            <span className="muted small">{prompt.options.length === 0 ? "Nothing to play right now." : `Tap a glowing card to play it (${parts.join(", ")}). Mana is paid for you; hold a card to choose what to tap.`}</span>
          </div>
          <div className="engine-bar-actions">
            <button className={`btn btn-small${prompt.options.length === 0 ? " btn-primary" : ""}`} onClick={() => answer({ promptId: id, option: null })}>
              {prompt.stackEmpty ? "Pass" : "Let it resolve"}
            </button>
            {prompt.myTurn && prompt.stackEmpty && (
              <button className="btn btn-small" onClick={() => answer({ promptId: id, option: null, passUntilTurn: view.turn })} title="Pass every remaining priority this turn">
                End turn
              </button>
            )}
          </div>
        </div>
      );
    }
    case "targets": {
      const picked = pick.kind === "select" ? pick.picked : [];
      const players = prompt.options.filter((o) => o.kind === "player");
      const hasOther = prompt.options.some((o) => o.kind === "text");
      return (
        <div className="engine-bar" role="region" aria-label="Choose targets">
          <div className="engine-bar-head">
            <strong>
              Choose {prompt.min === prompt.max ? prompt.min : `${prompt.min}-${prompt.max}`} target{prompt.max === 1 ? "" : "s"}
            </strong>
            <span className="muted small">{prompt.ability}. Tap glowing cards{players.length ? " or a player" : ""}; {picked.length} picked.</span>
          </div>
          {players.length > 0 && (
            <div className="combat-chips">
              {players.map((o) => {
                if (o.kind !== "player") return null;
                const selected = picked.includes(o.index);
                return (
                  <button key={o.index} className={`chip combat-chip${selected ? " is-selected" : ""}`} style={{ "--who": colorOfMember(members, o.player) ?? "var(--accent)" } as React.CSSProperties} onClick={() => setPick({ kind: "select", picked: toggle(picked, o.index, prompt.max) })} aria-pressed={selected}>
                    <span className="combat-chip-dot" aria-hidden="true" />
                    {view.players[o.player]?.name ?? o.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="engine-bar-actions">
            {hasOther && (
              <button className="btn btn-small" onClick={openList}>
                List
              </button>
            )}
            <button className="btn btn-small" onClick={openList}>
              Choose...
            </button>
            <button className="btn btn-small btn-primary" disabled={!canConfirm(prompt, picked)} onClick={() => answer({ promptId: id, options: picked })}>
              {primaryLabel(prompt, picked, (o) => describeOption(o, view).title)}
            </button>
            {!isOptionalChoice(prompt) && (
              <button className="btn btn-small" onClick={() => answer({ promptId: id, options: [], cancel: true })}>
                {prompt.cancelLabel ?? "Cancel"}
              </button>
            )}
          </div>
        </div>
      );
    }
    case "attackers": {
      const targets = pick.kind === "attack" ? pick.targets : {};
      const current = pick.kind === "attack" ? pick.current : null;
      const n = Object.keys(targets).length;
      return (
        <div className="engine-bar" role="region" aria-label="Declare attackers">
          <div className="engine-bar-head">
            <strong>Attack</strong>
            <span className="muted small">Pick a target, then tap the creatures that attack it. Tap again to take one back.</span>
          </div>
          <div className="combat-chips">
            {prompt.defenders.map((d) => {
              const key = refKey(d);
              const selected = current !== null && refKey(current) === key;
              const count = Object.values(targets).filter((t) => refKey(t) === key).length;
              const color = d.kind === "player" ? colorOfMember(members, d.player) : d.controller ? colorOfMember(members, d.controller) : undefined;
              return (
                <button key={key} className={`chip combat-chip${selected ? " is-selected" : ""}`} style={{ "--who": color ?? "var(--accent)" } as React.CSSProperties} onClick={() => setPick({ kind: "attack", targets, current: d })} aria-pressed={selected}>
                  <span className="combat-chip-dot" aria-hidden="true" />
                  {describeRef(d, view, printings)}
                  {d.kind === "player" && d.life !== undefined && <span className="muted small"> {d.life}</span>}
                  {count > 0 && <span className="combat-chip-count">{count}</span>}
                </button>
              );
            })}
          </div>
          <div className="engine-bar-actions">
            <button className="btn btn-small btn-primary" disabled={n === 0} onClick={() => answer({ promptId: id, attacks: Object.entries(targets).map(([iid, defender]) => ({ iid, defender })) })}>
              Declare {n === 0 ? "attack" : `${n} attacker${n === 1 ? "" : "s"}`}
            </button>
            <button className="btn btn-small" onClick={() => answer({ promptId: id, attacks: [] })}>
              No attack
            </button>
          </div>
        </div>
      );
    }
    case "blockers": {
      const blocks = pick.kind === "block" ? pick.blocks : {};
      const current = pick.kind === "block" ? pick.current : null;
      const n = Object.keys(blocks).length;
      return (
        <div className="engine-bar" role="region" aria-label="Declare blockers">
          <div className="engine-bar-head">
            <strong>Block</strong>
            <span className="muted small">Pick an attacker, then tap your creatures that block it. Several blockers may share one attacker.</span>
          </div>
          <div className="combat-attackers">
            {prompt.attackers.map((a) => {
              const c = findCard(view, a.iid);
              const selected = current === a.iid;
              const blockers = Object.values(blocks).filter((x) => x === a.iid).length;
              return (
                <div key={a.iid} className={`combat-attacker${selected ? " is-selected" : ""}`} role="button" tabIndex={0} onClick={() => setPick({ kind: "block", blocks, current: a.iid })} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setPick({ kind: "block", blocks, current: a.iid })} aria-pressed={selected}>
                  {c && <CardTile card={c} printings={printings} onHold={onZoom} />}
                  <span className="combat-attacker-text">
                    <span>{a.name}</span>
                    {a.power !== null && (
                      <strong>
                        {a.power}/{a.toughness}
                      </strong>
                    )}
                    {a.attacking && <span className="muted small">at {describeRef(a.attacking, view, printings)}</span>}
                    {blockers > 0 && <span className="combat-chip-count">{blockers} blocking</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="engine-bar-actions">
            <button className="btn btn-small btn-primary" onClick={() => answer({ promptId: id, blocks: Object.entries(blocks).map(([blockerIid, attackerIid]) => ({ blockerIid, attackerIid })) })}>
              {n === 0 ? "No blocks" : `Declare ${n} block${n === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      );
    }
    case "chooseMany": {
      const picked = pick.kind === "select" ? pick.picked : [];
      return (
        <div className="engine-bar" role="region" aria-label={prompt.title}>
          <div className="engine-bar-head">
            <strong>{prompt.title}</strong>
            <span className="muted small">
              {prompt.source ? `${prompt.source}: ` : ""}choose {prompt.min === prompt.max ? prompt.min : `${prompt.min}-${prompt.max}`}; {picked.length} picked. Tap glowing cards or open the list.
            </span>
          </div>
          <div className="engine-bar-actions">
            <button className="btn btn-small" onClick={openList}>
              List
            </button>
            <button className="btn btn-small btn-primary" disabled={!canConfirm(prompt, picked)} onClick={() => answer({ promptId: id, options: picked })}>
              {primaryLabel(prompt, picked, (o) => describeOption(o, view).title)}
            </button>
          </div>
        </div>
      );
    }
    case "choose":
      return (
        <div className="engine-bar" role="region" aria-label={prompt.title}>
          <div className="engine-bar-head">
            <strong>{prompt.title}</strong>
            <span className="muted small">{prompt.source ? `${prompt.source}: ` : ""}tap a glowing card or pick from the list.</span>
          </div>
          <div className="engine-bar-actions">
            <button className="btn btn-small btn-primary" onClick={openList}>
              Choose...
            </button>
            {/* "Don't use this" lives in the list, behind one confirmation */}
          </div>
        </div>
      );
    case "confirm":
      return (
        <div className="engine-bar" role="region" aria-label={prompt.title}>
          <div className="engine-bar-head">
            <strong>{prompt.title}</strong>
            {(prompt.detail || prompt.source) && <span className="muted small">{prompt.detail ?? prompt.source}</span>}
          </div>
          <div className="engine-bar-actions">
            {prompt.card && (
              <button className="btn btn-small" onClick={openList}>
                Show card
              </button>
            )}
            <button className="btn btn-small" onClick={() => answer({ promptId: id, confirm: false })}>
              {prompt.options[1] ?? "No"}
            </button>
            <button className="btn btn-small btn-primary" onClick={() => answer({ promptId: id, confirm: true })}>
              {prompt.options[0] ?? "Yes"}
            </button>
          </div>
        </div>
      );
    case "number":
    case "order":
    case "assign":
    case "mode":
    case "text": {
      const { head, hint } = sheetPromptSummary(prompt);
      return (
        <div className="engine-bar" role="region" aria-label={prompt.title}>
          <div className="engine-bar-head">
            <strong>{head}</strong>
            {hint && <span className="muted small">{hint}</span>}
          </div>
          <div className="engine-bar-actions">
            <button className="btn btn-small btn-primary" onClick={openList}>
              Answer...
            </button>
          </div>
        </div>
      );
    }
    case "mulligan":
      return null; // the overlay handles it
    default:
      return null;
  }
}

function toggle(picked: number[], index: number, max: number): number[] {
  if (picked.includes(index)) return picked.filter((i) => i !== index);
  if (max === 1) return [index];
  if (picked.length >= max) return picked;
  return [...picked, index];
}

/** A sheet listing every option of a choose / chooseMany / targets prompt (cards, players, text). */
/** The source card's printing for a list prompt: on a battlefield or in a command zone, else on the stack (all public). */
function sourcePrinting(view: PlayerView, printings: Printings, name: string | null): string | null {
  if (!name) return null;
  for (const pl of Object.values(view.players)) {
    for (const c of [...Object.values(pl.battlefield).flat(), ...pl.command]) if (c.printingId && printings[c.printingId]?.name === name) return c.printingId;
  }
  for (const it of view.stack) if (it.name === name && it.printingId) return it.printingId;
  return null;
}

export function EngineListSheet({ prompt, view, printings, pick, setPick, answer, onClose, onZoom, members = [], me = null }: { prompt: EnginePrompt; view: PlayerView; printings: Printings; pick: EnginePick; setPick: (p: EnginePick) => void; answer: (a: EngineAnswer) => void; onClose: () => void; onZoom: (c: ViewCard) => void; members?: RoomMember[]; me?: string | null }) {
  const [filter, setFilter] = useState("");
  const [askNone, setAskNone] = useState(false);
  useEffect(() => {
    setFilter("");
    setAskNone(false);
  }, [prompt.promptId]);
  useEffect(() => {
    // Escape / tap outside / the close button only minimise the sheet: they never answer
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (prompt.kind !== "choose" && prompt.kind !== "chooseMany" && prompt.kind !== "targets") return null;
  // cards, players and stack items: the list grouped by player and zone (text-only lists stay flat below)
  if (isGroupedChoice(prompt)) return <GroupedChoiceSheet prompt={prompt} view={view} printings={printings} members={members} me={me} pick={pick} setPick={setPick} answer={answer} onClose={onClose} onZoom={onZoom} />;
  const single = prompt.kind === "choose";
  const optional = isOptionalChoice(prompt);
  const picked = pick.kind === "select" ? pick.picked : [];
  const max = single ? 1 : prompt.max;
  const min = single ? 1 : prompt.min;
  const label = (o: EngineOption) => describeOption(o, view);
  const shown = filter.trim() ? prompt.options.filter((o) => label(o).title.toLowerCase().includes(filter.trim().toLowerCase())) : prompt.options;
  const onlyOne = optional && prompt.options.length === 1 && max === 1;
  const srcArt = optional ? sourcePrinting(view, printings, prompt.source) : null;
  const what = prompt.kind === "targets" ? prompt.ability : null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${optional ? " optional-choice" : ""}`} role="dialog" aria-modal="true" aria-label={prompt.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>{prompt.title}</strong>
          <span className="muted small">{single ? (optional ? "Pick one, or don't use it." : "Pick one.") : optional ? `Pick up to ${max}.` : `Pick ${min === max ? min : `${min} to ${max}`}.`}</span>
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        {optional && (prompt.source || what) && (
          <div className="optional-source">
            {srcArt && <CardImage id={srcArt} name={prompt.source ?? ""} size="small" className="engine-row-img" />}
            <p className="small">
              {prompt.source && <strong>{prompt.source}</strong>}
              {prompt.source && what ? ": " : ""}
              {what}
            </p>
          </div>
        )}
        {prompt.options.length > 12 && <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter options" style={{ marginBottom: 8 }} />}
        <div className="engine-options">
          {prompt.options.length === 0 && <p className="muted">Nothing to choose.</p>}
          {shown.map((o) => {
            const { title, hint } = label(o);
            const selected = picked.includes(o.index);
            const card = o.kind === "card" ? findCard(view, o.iid) : null;
            const art = !card && o.kind === "card" && o.printingId ? <CardImage id={o.printingId} name={o.name} size="small" className="engine-row-img" /> : null;
            return (
              <button
                key={o.index}
                className={`engine-option${selected ? " is-selected" : ""}${onlyOne ? " is-only" : ""}`}
                aria-pressed={single ? undefined : selected}
                onClick={() => {
                  setAskNone(false);
                  if (single) {
                    onClose();
                    answer({ promptId: prompt.promptId, option: o.index });
                  } else setPick({ kind: "select", picked: toggle(picked, o.index, max) });
                }}
              >
                {card && <CardTile card={card} printings={printings} onHold={onZoom} />}
                {art}
                <span>
                  <span>{title}</span>
                  {hint && <small> {hint}</small>}
                </span>
              </button>
            );
          })}
        </div>
        {askNone && optional ? (
          <div className="optional-none-confirm" role="alertdialog" aria-label={noneQuestion(prompt)}>
            <p>
              <strong>{noneQuestion(prompt)}</strong>
            </p>
            <div className="actions">
              <button className="btn" onClick={() => setAskNone(false)}>
                Back
              </button>
              <button className="btn btn-danger-quiet optional-none-yes" onClick={() => answer(noneAnswer(prompt))}>
                Yes, {noneLabel(prompt).toLowerCase()}
              </button>
            </div>
          </div>
        ) : (
          <>
            {!single && (
              <div className="actions" style={{ marginTop: 10 }}>
                <button className="btn btn-primary optional-confirm" disabled={!canConfirm(prompt, picked)} onClick={() => answer({ promptId: prompt.promptId, options: picked })}>
                  {optional ? choiceLabel(prompt, picked, (o) => label(o).title) : `Confirm ${picked.length ? `(${picked.length})` : ""}`}
                </button>
                {optional && (
                  <button className="btn btn-small optional-none" onClick={() => setAskNone(true)}>
                    {noneLabel(prompt)}
                  </button>
                )}
                {prompt.kind === "targets" && prompt.cancelLabel && (
                  <button className="btn btn-small" onClick={() => answer({ promptId: prompt.promptId, options: [], cancel: true })}>
                    {prompt.cancelLabel}
                  </button>
                )}
                {prompt.kind === "targets" && !prompt.cancelLabel && !optional && (
                  <button className="btn" onClick={() => answer({ promptId: prompt.promptId, options: [], cancel: true })}>
                    Cancel
                  </button>
                )}
              </div>
            )}
            {single && optional && (
              <div className="actions" style={{ marginTop: 10 }}>
                <button className="btn btn-small optional-none" onClick={() => setAskNone(true)}>
                  {noneLabel(prompt)}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Several abilities on one card: pick which to play. */
export function EngineAbilitySheet({ options, name, onPick, onClose }: { options: Array<{ index: number; description: string; cost: string | null; kind: string }>; name: string; onPick: (index: number) => void; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={name} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>{name}</strong>
          <span className="muted small">Which one?</span>
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="sheet-actions">
          {options.map((o) => (
            <button key={o.index} className="sheet-action" onClick={() => onPick(o.index)}>
              <span>{o.kind === "land" ? "Play" : o.kind === "spell" ? "Cast" : "Activate"}</span>
              <small className="muted">
                {o.description}
                {o.cost ? ` (${o.cost})` : ""}
              </small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Mulligan overlay for engine tables: keep / mulligan, then "put N on the bottom" as a chooseMany. */
export function EngineMulligan({ prompt, view, printings, me, pick, setPick, answer, onZoom }: { prompt: EnginePrompt; view: PlayerView; printings: Printings; me: string; pick: EnginePick; setPick: (p: EnginePick) => void; answer: (a: EngineAnswer) => void; onZoom: (c: ViewCard) => void }) {
  const mePlayer = view.players[me];
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [prompt.promptId]);
  if (!mePlayer) return null;
  if (prompt.kind === "mulligan") {
    return (
      <div className="mulligan">
        <div className="mulligan-box">
          <h2>Keep this hand?</h2>
          <p className="muted small">{mulliganNote(prompt)}</p>
          <div className="mulligan-hand">
            {prompt.hand.map((h) => {
              const c = findCard(view, h.iid) ?? mePlayer.hand.cards.find((x) => x.iid === h.iid);
              return c ? <CardTile key={h.iid} card={c} printings={printings} onTap={onZoom} onHold={onZoom} /> : null;
            })}
          </div>
          <div className="actions">
            {prompt.serumPowder?.[0] && (
              <button className="btn" disabled={busy} title="Exile your whole hand and draw that many cards, then decide again" onClick={() => (setBusy(true), answer({ promptId: prompt.promptId, serumPowder: prompt.serumPowder![0]! }))}>
                Use Serum Powder
              </button>
            )}
            <button className="btn" disabled={busy} onClick={() => (setBusy(true), answer({ promptId: prompt.promptId, keep: false }))}>
              Mulligan
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => (setBusy(true), answer({ promptId: prompt.promptId, keep: true }))}>
              Keep
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (prompt.kind === "chooseMany" && (prompt.reason === "mulligan" || prompt.reason === "putBack")) {
    const picked = pick.kind === "select" ? pick.picked : [];
    const putBack = prompt.reason === "putBack";
    return (
      <div className="mulligan">
        <div className="mulligan-box">
          <h2>{putBack ? `Put ${prompt.min} back into your library` : `Put ${prompt.min} on the bottom`}</h2>
          <p className="muted small">
            {putBack
              ? `Draw 10: pick ${prompt.min} of your ten. They are shuffled back into your library and nobody sees which; the other ${prompt.options.length - prompt.min} are your opening hand. Everyone picks at the same time.`
              : "Tap the cards to put on the bottom of your library, then confirm."}
          </p>
          <div className="mulligan-hand">
            {prompt.options.map((o) => {
              if (o.kind !== "card") return null;
              const c = findCard(view, o.iid) ?? mePlayer.hand.cards.find((x) => x.iid === o.iid);
              return c ? <CardTile key={o.iid} card={c} printings={printings} selected={picked.includes(o.index)} onTap={() => setPick({ kind: "select", picked: toggle(picked, o.index, prompt.max) })} onHold={onZoom} /> : null;
            })}
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={picked.length !== prompt.min || busy} onClick={() => (setBusy(true), answer({ promptId: prompt.promptId, options: picked }))}>
              Confirm
            </button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
