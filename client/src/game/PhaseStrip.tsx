import { AVATAR_COLORS, STEPS, STEP_LABELS, isOut, type EngineInfo, type EnginePhase, type EventInput, type PlayerView, type RoomMember, type Step, type ViewCard } from "@cgwf/shared";
import { Avatar } from "../components/Avatar";
import { findCard, nameOf, type Printings } from "./model";

/**
 * The phase strip: whose turn it is, every step with the current one lit,
 * and the controls that must always be reachable (next step, pass turn,
 * attack, blocks, damage). Below it, one line of context: who is attacking
 * whom, what the table wants from me, a win prompt. Everything here is a
 * plain event; the reducer does the untap, the draw and the default damage.
 */

const SHORT: Record<Step, string> = {
  untap: "Untap",
  upkeep: "Upkeep",
  draw: "Draw",
  main1: "Main 1",
  beginCombat: "Combat",
  attackers: "Attack",
  blockers: "Block",
  damage: "Damage",
  endCombat: "End cbt",
  main2: "Main 2",
  end: "End",
  cleanup: "Cleanup",
};

export interface PhaseStripProps {
  view: PlayerView;
  printings: Printings;
  members: RoomMember[];
  me: string | null;
  canAct: boolean;
  dispatch: (e: EventInput) => void;
  onAttack: () => void;
  onBlock: () => void;
  onAssignDamage: () => void;
  onZoom: (c: ViewCard) => void;
  onConfirmWin: (iid: string, name: string, condition: string) => void;
  /** A combat mode is open (attack / block picking), so the strip hides its own combat buttons. */
  busy: boolean;
  /** The combat picking bar, rendered inside the strip (never over the battlefield). */
  children?: React.ReactNode;
  /** Rules-engine table: the engine drives steps and combat; the strip only shows them (and who it waits on). */
  engine?: EngineInfo | null | undefined;
  /** Engine tables: tapping a step toggles a stop there (for whose turn it currently is). */
  onToggleStop?: ((phase: EnginePhase, mine: boolean) => void) | undefined;
  /** Engine tables: hold priority for this turn (every priority stops, nothing auto-passes) or release it. */
  onHold?: ((turn: number | null) => void) | undefined;
}

/** Which engine step a strip step stands for (untap and cleanup never give priority). */
export const STEP_TO_PHASE: Partial<Record<Step, EnginePhase>> = {
  upkeep: "UPKEEP",
  draw: "DRAW",
  main1: "MAIN1",
  beginCombat: "COMBAT_BEGIN",
  attackers: "COMBAT_DECLARE_ATTACKERS",
  blockers: "COMBAT_DECLARE_BLOCKERS",
  damage: "COMBAT_DAMAGE",
  endCombat: "COMBAT_END",
  main2: "MAIN2",
  end: "END_OF_TURN",
};

function creatureLabel(view: PlayerView, printings: Printings, iid: string): string {
  const c = findCard(view, iid);
  return c ? nameOf(c, printings) : "a creature";
}

export function PhaseStrip({ view, printings, members, me, canAct, dispatch, onAttack, onBlock, onAssignDamage, onZoom, onConfirmWin, busy, children, engine = null, onToggleStop, onHold }: PhaseStripProps) {
  const engineMode = engine !== null;
  const stopList = engine ? (view.activePlayer === me ? engine.stops.myTurn : engine.stops.theirTurn) : [];
  const holding = engine !== null && engine.holdTurn === view.turn;
  const active = view.players[view.activePlayer];
  const member = members.find((m) => m.userId === view.activePlayer);
  const isMyTurn = me !== null && me === view.activePlayer;
  const playing = view.phase === "playing";
  const current = STEPS.indexOf(view.step);
  const combat = view.combat;
  const mePlayer = me ? view.players[me] : undefined;

  // ---- what the strip asks of me right now
  let prompt: React.ReactNode = null;
  if (engineMode && playing) {
    if (mePlayer?.eliminated) {
      prompt = <span className="phase-note is-warn">You are out of the game.</span>;
    } else if (!engine.prompt) {
      const waiting = engine.waitingOn.map((id) => view.players[id]?.name ?? "?");
      const stackTop = view.stack[0];
      prompt = (
        <span className="phase-note engine-wait">
          {waiting.length ? `Waiting for ${waiting.join(", ")}.` : "The engine is working..."}
          {stackTop ? ` On the stack: ${stackTop.description}` : ""}
        </span>
      );
    }
  } else if (playing && mePlayer?.eliminated) {
    prompt = (
      <span className="phase-note is-warn">
        You are out of the game ({mePlayer.eliminated}). Rewind from the log if that was a mistake.
      </span>
    );
  } else if (playing && combat && !combat.damageDealt && combat.attackers.length > 0) {
    const attacker = view.players[combat.attacker];
    const groups = new Map<string, string[]>();
    for (const a of combat.attackers) {
      const who = view.players[a.player]?.name ?? "?";
      const key = a.planeswalker ? `${who}'s ${creatureLabel(view, printings, a.planeswalker)}` : who;
      groups.set(key, [...(groups.get(key) ?? []), creatureLabel(view, printings, a.iid)]);
    }
    const summary = [...groups].map(([who, names]) => `${who} with ${names.join(", ")}`).join("; ");
    const attackedMe = me !== null && combat.attackers.some((a) => a.player === me);
    const defenders = [...new Set(combat.attackers.map((a) => a.player))];
    if (me === combat.attacker) {
      const waiting = defenders.filter((d) => !combat.blockersDeclared.includes(d)).map((d) => view.players[d]?.name ?? "?");
      prompt = (
        <>
          <span className="phase-note">
            Attacking {summary}. {waiting.length ? `Waiting for blocks from ${waiting.join(", ")}.` : "Blocks are in."}
          </span>
          {!busy && (
            <span className="phase-prompt-actions">
              <button className="btn btn-small btn-primary" onClick={onAssignDamage} disabled={!canAct}>
                Assign damage
              </button>
              <button className="btn btn-small" onClick={onAttack} disabled={!canAct}>
                Change attackers
              </button>
            </span>
          )}
        </>
      );
    } else if (attackedMe) {
      const mine = combat.attackers.filter((a) => a.player === me);
      const declared = combat.blockersDeclared.includes(me!);
      const myBlocks = combat.blockers.filter((b) => b.player === me);
      prompt = (
        <>
          <span className="phase-note is-alert">
            {attacker?.name ?? "Someone"} attacks you with{" "}
            {mine.map((a, i) => {
              const c = findCard(view, a.iid);
              return (
                <span key={a.iid}>
                  {i > 0 ? ", " : ""}
                  {c ? (
                    <button className="link-btn" onClick={() => onZoom(c)}>
                      {nameOf(c, printings)}
                    </button>
                  ) : (
                    "a creature"
                  )}
                  {a.planeswalker ? ` (at ${creatureLabel(view, printings, a.planeswalker)})` : ""}
                </span>
              );
            })}
            {declared ? ` - ${myBlocks.length ? `${myBlocks.length} block${myBlocks.length === 1 ? "" : "s"} declared` : "no blocks declared"}` : ""}
          </span>
          {!busy && (
            <span className="phase-prompt-actions">
              <button className={`btn btn-small${declared ? "" : " btn-primary"}`} onClick={onBlock} disabled={!canAct}>
                {declared ? "Change blocks" : "Block..."}
              </button>
              {!declared && (
                <button className="btn btn-small" onClick={() => dispatch({ type: "BlockersDeclared", payload: { player: me!, blocks: [] } })} disabled={!canAct}>
                  No blocks
                </button>
              )}
            </span>
          )}
        </>
      );
    } else {
      prompt = <span className="phase-note">{attacker?.name ?? "Someone"} attacks {summary}.</span>;
    }
  } else if (playing && me) {
    const win = view.winAdvisories.find((w) => w.controller === me);
    if (win) {
      prompt = (
        <>
          <span className="phase-note is-win">
            Win condition met: {win.name} ({win.condition})
          </span>
          <span className="phase-prompt-actions">
            <button className="btn btn-small btn-primary" onClick={() => onConfirmWin(win.iid, win.name, win.condition)} disabled={!canAct}>
              Claim the win
            </button>
            <button className="btn btn-small" onClick={() => dispatch({ type: "WinAdvisoryDismissed", payload: { iid: win.iid } })} disabled={!canAct}>
              Not yet
            </button>
          </span>
        </>
      );
    }
  }

  const canAttack = isMyTurn && canAct && !busy && !(combat && !combat.damageDealt && combat.attackers.length > 0) && Boolean(mePlayer && Object.values(mePlayer.battlefield).flat().some((c) => !c.tapped));

  return (
    <div className={`phase-strip${isMyTurn ? " is-mine" : ""}`} role="region" aria-label="Turn and phase">
      <div className="phase-row">
        <div className="phase-turn" style={member ? ({ "--who": AVATAR_COLORS[member.color] } as React.CSSProperties) : undefined}>
          {member && <Avatar avatar={member.avatar} color={member.color} size={22} />}
          {!engineMode && (
            <span className="table-kind-tag" title="Casual table: nothing is enforced; players apply the rules themselves">
              Casual
            </span>
          )}
          <span className="phase-turn-text">
            {engineMode && view.round ? <strong>Round {view.round}</strong> : <strong>T{view.turn}</strong>}
            {engineMode && view.round ? " · " : " "}
            {view.phase === "mulligan" ? "Mulligans" : view.phase === "ended" ? (view.winner ? `${view.players[view.winner]?.name} wins` : "Game over") : isMyTurn ? "Your turn" : `${active?.name ?? ""}'s turn`}
            {engineMode && view.round ? <small className="phase-gameturn" title="Forge's game turn number">Game turn {view.turn}</small> : null}
          </span>
        </div>
        {playing && (
          <ol className="phase-steps" aria-label="Steps">
            {STEPS.map((step, i) => {
              const phase = STEP_TO_PHASE[step];
              const stop = engineMode && phase !== undefined && stopList.includes(phase);
              const toggles = engineMode && phase !== undefined && !!onToggleStop && !!me && !!view.players[me];
              return (
                <li key={step}>
                  <button
                    className={`phase-step${i === current ? " is-current" : i < current ? " is-past" : ""}${stop ? " has-stop" : ""}`}
                    disabled={engineMode ? !toggles : !canAct || i === current}
                    onClick={() => (engineMode ? phase && onToggleStop?.(phase, view.activePlayer === me) : dispatch({ type: "StepSet", payload: { step } }))}
                    aria-current={i === current ? "step" : undefined}
                    aria-pressed={engineMode && toggles ? stop : undefined}
                    aria-label={`${STEP_LABELS[step]}${i === current ? ", current step" : ""}${engineMode && toggles ? (stop ? ", stop set, tap to clear" : ", tap to stop here") : ""}`}
                    title={engineMode && toggles ? `${STEP_LABELS[step]}: ${stop ? "stop set (tap to clear)" : "tap to stop here"} on ${view.activePlayer === me ? "your" : "opponents'"} turns` : STEP_LABELS[step]}
                  >
                    <span className="phase-dot" aria-hidden="true" />
                    <span className="phase-step-label">{SHORT[step]}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {playing && engineMode && onHold && me && view.players[me] && !isOut(view.players[me]!) && (
          <div className="phase-actions">
            <button className={`btn btn-small phase-hold${holding ? " is-on" : ""}`} onClick={() => onHold(holding ? null : view.turn)} aria-pressed={holding} title="Hold priority this turn: the engine asks you at every step and never passes for you">
              {holding ? "Holding" : "Hold"}
            </button>
          </div>
        )}
        {playing && !engineMode && (
          <div className="phase-actions">
            {canAttack && (
              <button className="btn btn-small btn-attack" onClick={onAttack}>
                Attack
              </button>
            )}
            <button className="btn btn-small" disabled={!canAct} onClick={() => dispatch({ type: "StepAdvanced", payload: {} })} aria-label="Next step">
              Next step
            </button>
            <button className={`btn btn-small${isMyTurn ? " btn-primary" : ""}`} disabled={!canAct} onClick={() => dispatch({ type: "TurnAdvanced", payload: {} })}>
              Pass turn
            </button>
          </div>
        )}
      </div>
      {children}
      {prompt && !busy && <div className="phase-prompt">{prompt}</div>}
      {playing && !engineMode && !prompt && isMyTurn && view.drewForTurn && current <= STEPS.indexOf("main1") && <div className="phase-prompt phase-prompt-quiet muted small">Untapped and drew for the turn.</div>}
      {playing && !prompt && view.turnOrder.some((id) => isOut(view.players[id]!) && !view.players[id]!.conceded) && (
        <div className="phase-prompt phase-prompt-quiet muted small">
          Out: {view.turnOrder.filter((id) => view.players[id]!.eliminated && !view.players[id]!.conceded).map((id) => `${view.players[id]!.name} (${view.players[id]!.eliminated})`).join(", ")}
        </div>
      )}
    </div>
  );
}
