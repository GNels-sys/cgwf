import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DndContext, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { HAND_SIZE, STEP_LABELS, type PlayerView, type RoomInfo, type Row, type ViewCard, type ViewPlayer } from "@cgwf/shared";
import { Avatar } from "../components/Avatar";
import { cardActions, diceActions, libraryActions, playerActions, type Ctx } from "./actions";
import { CardTile } from "./CardTile";
import { CardZoom } from "./CardZoom";
import { LifeWidget } from "./LifeWidget";
import { nameOf, seatOrderFrom, type Printings } from "./model";
import { CardList, LogPanel, MenuPanel, OpponentPanel, Panel, TokenPanel } from "./Panels";
import { ActionSheet, DialogView, type Action, type Dialog } from "./Sheets";
import type { RoomSocket } from "./socket";

/**
 * The table. Phone landscape first: opponents across the top, my battlefield
 * rows in the middle, hand + zones + life along the bottom. Every action goes
 * through the server as an event; this component only renders the view.
 */

type Sheet = { kind: "card"; card: ViewCard } | { kind: "library" } | { kind: "player"; player: ViewPlayer } | { kind: "dice" } | null;
interface CardsPanel {
  title: string;
  subtitle?: string;
  cards: ViewCard[];
}

const ROW_LABEL: Record<Row, string> = { lands: "Lands", creatures: "Creatures", other: "Other" };

function DropRow({ id, className, children }: { id: string; className: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`${className}${isOver ? " is-over" : ""}`}>
      {children}
    </div>
  );
}

function DropButton({ id, className, onClick, children }: { id: string; className?: string; onClick: () => void; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <button ref={setNodeRef} className={`zone-btn${className ? ` ${className}` : ""}${isOver ? " is-over" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function Table({ room, view, printings, sock }: { room: RoomInfo; view: PlayerView; printings: Printings; sock: RoomSocket }) {
  const navigate = useNavigate();
  const me = view.viewer;
  const mePlayer = me ? view.players[me] : undefined;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [zoom, setZoom] = useState<ViewCard | null>(null);
  const [cardsPanel, setCardsPanel] = useState<CardsPanel | null>(null);
  const [opponent, setOpponent] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showTokens, setShowTokens] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const closeSheet = useCallback(() => setSheet(null), []);
  const showCards = useCallback((title: string, cards: ViewCard[], subtitle?: string) => setCardsPanel(subtitle ? { title, cards, subtitle } : { title, cards }), []);

  const ctx: Ctx = useMemo(
    () => ({ view, printings, me, dispatch: sock.dispatch, send: sock.send, dialog: setDialog, zoom: setZoom, showCards, close: closeSheet }),
    [view, printings, me, sock.dispatch, sock.send, showCards, closeSheet],
  );

  const tapCard = useCallback((card: ViewCard) => setSheet({ kind: "card", card }), []);
  const holdCard = useCallback((card: ViewCard) => setZoom(card), []);

  // Keep panels in sync with the live view (a card list opened from a zone follows that zone).
  const liveCardsPanel = useMemo(() => {
    if (!cardsPanel) return null;
    const ids = new Set(cardsPanel.cards.map((c) => c.iid));
    const all = Object.values(view.players).flatMap((p) => [...p.graveyard, ...p.exile, ...p.command, ...p.hand.cards, ...p.library.known, ...p.battlefield.lands, ...p.battlefield.creatures, ...p.battlefield.other]);
    return { ...cardsPanel, cards: all.filter((c) => ids.has(c.iid)) };
  }, [cardsPanel, view]);

  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const card = (e.active.data.current as { card?: ViewCard } | undefined)?.card;
    const over = e.over?.id;
    if (!card || !over || !me) return;
    const target = String(over);
    if (target.startsWith("row:")) {
      const row = target.slice(4) as Row;
      if (card.zone.kind === "battlefield" && card.zone.owner === me && card.zone.row === row) return;
      sock.dispatch({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "battlefield", owner: me, row, faceDown: card.faceDown } } });
    } else if (target === "zone:graveyard") sock.dispatch({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "graveyard", owner: card.owner } } });
    else if (target === "zone:exile") sock.dispatch({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "exile", owner: card.owner } } });
    else if (target === "zone:library" && card.owner === me) sock.dispatch({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "library", owner: me, position: "top" } } });
    else if (target === "zone:hand" && card.owner === me && card.zone.kind !== "hand") sock.dispatch({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "hand", owner: me } } });
    else if (target === "zone:command" && card.isCommander && card.owner === me) sock.dispatch({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "command", owner: me } } });
  };

  const others = seatOrderFrom(view, me);
  const active = view.players[view.activePlayer];
  const isMyTurn = me === view.activePlayer;
  const canAct = Boolean(mePlayer && !mePlayer.conceded && view.phase !== "ended");

  // ---- mulligan overlay ------------------------------------------------
  const mulliganing = view.phase === "mulligan" && mePlayer && !mePlayer.conceded;
  const needBottom = mePlayer && mePlayer.kept ? Math.max(0, mePlayer.hand.count - (HAND_SIZE - mePlayer.mulligans)) : 0;
  const showMulligan = Boolean(mulliganing && (!mePlayer!.kept || needBottom > 0));

  // ---- sheet contents ----------------------------------------------------
  let sheetView: React.ReactNode = null;
  if (sheet && me) {
    if (sheet.kind === "card") {
      const live = Object.values(view.players)
        .flatMap((p) => [...p.graveyard, ...p.exile, ...p.command, ...p.hand.cards, ...p.library.known, ...p.battlefield.lands, ...p.battlefield.creatures, ...p.battlefield.other])
        .find((c) => c.iid === sheet.card.iid);
      if (live) {
        const owner = view.players[live.zone.owner];
        sheetView = (
          <ActionSheet title={nameOf(live, printings)} subtitle={`${live.zone.kind}${live.zone.owner !== me ? ` - ${owner?.name ?? ""}` : ""}${live.tapped ? " - tapped" : ""}`} actions={cardActions(ctx, live)} onClose={closeSheet} />
        );
      }
    } else if (sheet.kind === "library" && mePlayer) {
      sheetView = <ActionSheet title={`Your library (${mePlayer.library.count})`} actions={libraryActions(ctx, mePlayer)} onClose={closeSheet} />;
    } else if (sheet.kind === "player") {
      const p = view.players[sheet.player.id] ?? sheet.player;
      sheetView = <ActionSheet title={p.id === me ? "Your counters" : `${p.name}'s counters`} subtitle={`${p.life} life`} actions={playerActions(ctx, p)} onClose={closeSheet} />;
    } else if (sheet.kind === "dice") {
      sheetView = <ActionSheet title="Dice and coins" subtitle="Results go to the log" actions={diceActions(ctx)} onClose={closeSheet} />;
    }
  }

  const lifeBig = (p: ViewPlayer) =>
    setDialog({
      kind: "number",
      title: `${p.id === me ? "Your" : `${p.name}'s`} life (now ${p.life})`,
      initial: -5,
      quick: [-10, -5, -3, 3, 5, 10],
      submitLabel: "Apply",
      onSubmit: (n) => sock.dispatch({ type: "LifeChanged", payload: { player: p.id, delta: n } }),
    });

  const menuActions: Action[] = [
    { label: "Game log", run: () => (setShowMenu(false), setShowLog(true)) },
    { label: "Dice, coin, random opponent", run: () => (setShowMenu(false), setSheet({ kind: "dice" })), disabled: !canAct },
    { label: "Create tokens", run: () => (setShowMenu(false), setShowTokens(true)), disabled: !canAct },
    { label: "Undo my last action", run: () => (setShowMenu(false), sock.send({ t: "undo" })), disabled: !canAct },
    { label: "Untap all my permanents", run: () => (setShowMenu(false), sock.dispatch({ type: "UntapAll", payload: { player: me! } })), disabled: !canAct },
    {
      label: "Concede",
      danger: true,
      disabled: !canAct,
      run: () => {
        setShowMenu(false);
        setDialog({ kind: "confirm", title: "Concede the game?", body: "You stay at the table as a spectator.", confirmLabel: "Concede", danger: true, onConfirm: () => sock.dispatch({ type: "PlayerConceded", payload: { player: me! } }) });
      },
    },
    {
      label: "Leave table",
      danger: true,
      run: () => {
        setShowMenu(false);
        setDialog({
          kind: "confirm",
          title: "Leave the table?",
          body: canAct ? "Leaving during a game concedes it. To come back later, just close the app instead." : undefined,
          confirmLabel: "Leave",
          danger: true,
          onConfirm: () => {
            sock.leave();
            navigate("/play");
          },
        });
      },
    },
  ];

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className={`table${isMyTurn ? " is-my-turn" : ""}`}>
        {/* ---- top: opponents + turn tracker ---- */}
        <div className="table-top">
          <div className="opp-strip">
            {others.map((p) => {
              const member = room.members.find((m) => m.userId === p.id);
              return (
                <button key={p.id} className={`opp-chip${view.activePlayer === p.id ? " is-active" : ""}${p.conceded ? " is-out" : ""}${member && !member.online ? " is-offline" : ""}`} onClick={() => setOpponent(p.id)}>
                  {member && <Avatar avatar={member.avatar} color={member.color} size={26} />}
                  <span className="opp-name">{p.name}</span>
                  <span className="opp-life">{p.life}</span>
                  <span className="opp-meta">
                    <span title="Hand">H{p.hand.count}</span>
                    <span title="Library">L{p.library.count}</span>
                    <span title="Battlefield">B{p.battlefield.lands.length + p.battlefield.creatures.length + p.battlefield.other.length}</span>
                    {p.counters.poison ? <span className="is-poison">{p.counters.poison}p</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="turn-bar">
            {view.phase === "mulligan" ? (
              <span className="turn-label">Mulligans</span>
            ) : view.phase === "ended" ? (
              <span className="turn-label">{view.winner ? `${view.players[view.winner]?.name} wins` : "Game over"}</span>
            ) : (
              <>
                <span className="turn-label">
                  <strong>T{view.turn}</strong> {active?.name ?? ""} &middot; {STEP_LABELS[view.step]}
                </span>
                <button className="btn btn-small" disabled={!canAct} onClick={() => sock.dispatch({ type: "StepAdvanced", payload: {} })}>
                  Next step
                </button>
                <button className={`btn btn-small${isMyTurn ? " btn-primary" : ""}`} disabled={!canAct} onClick={() => sock.dispatch({ type: "TurnAdvanced", payload: {} })}>
                  Pass turn
                </button>
              </>
            )}
            <button className="btn btn-small menu-btn" onClick={() => setShowMenu(true)} aria-label="Menu">
              &#8942;
            </button>
          </div>
        </div>

        {/* ---- middle: my battlefield ---- */}
        <div className="table-mid">
          {mePlayer ? (
            (["lands", "creatures", "other"] as const).map((row) => (
              <DropRow key={row} id={`row:${row}`} className="bf-row">
                <span className="row-label">{ROW_LABEL[row]}</span>
                {mePlayer.battlefield[row].map((c) => (
                  <CardTile key={c.iid} card={c} printings={printings} onTap={tapCard} onHold={holdCard} draggable={canAct} attached={Boolean(c.attachedTo)} />
                ))}
              </DropRow>
            ))
          ) : (
            <div className="spectating">
              <p className="muted">You are watching. Tap a player above to see their battlefield.</p>
            </div>
          )}
        </div>

        {/* ---- bottom: zones, hand, life ---- */}
        {mePlayer && (
          <div className="table-bottom">
            <div className="zone-btns">
              <DropButton id="zone:library" className="is-library" onClick={() => setSheet({ kind: "library" })}>
                <span>Library</span>
                <strong>{mePlayer.library.count}</strong>
              </DropButton>
              <DropButton id="zone:graveyard" onClick={() => showCards("Your graveyard", mePlayer.graveyard)}>
                <span>Grave</span>
                <strong>{mePlayer.graveyard.length}</strong>
              </DropButton>
              <DropButton id="zone:exile" onClick={() => showCards("Your exile", mePlayer.exile)}>
                <span>Exile</span>
                <strong>{mePlayer.exile.length}</strong>
              </DropButton>
              <DropButton id="zone:command" className="is-command" onClick={() => showCards("Your command zone", mePlayer.command)}>
                <span>Cmd</span>
                <strong>{mePlayer.command.length}</strong>
              </DropButton>
            </div>
            <DropRow id="zone:hand" className="hand">
              {mePlayer.hand.cards.length === 0 && <span className="muted small">Empty hand</span>}
              {mePlayer.hand.cards.map((c) => (
                <CardTile key={c.iid} card={c} printings={printings} onTap={tapCard} onHold={holdCard} draggable={canAct} />
              ))}
            </DropRow>
            <LifeWidget
              player={mePlayer}
              mine
              onDelta={(d) => sock.dispatch({ type: "LifeChanged", payload: { player: me!, delta: d } })}
              onBig={() => lifeBig(mePlayer)}
              onCounters={() => setSheet({ kind: "player", player: mePlayer })}
            />
          </div>
        )}

        <p className="table-notice">Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Card data and images courtesy of Scryfall.</p>

        {sock.error && <div className="toast">{sock.error}</div>}
        {sock.status !== "open" && <div className="toast is-warn">{sock.status === "reconnecting" ? "Reconnecting..." : sock.status}</div>}
      </div>

      {/* ---- overlays ---- */}
      {showMulligan && mePlayer && (
        <div className="mulligan">
          <div className="mulligan-box">
            {!mePlayer.kept ? (
              <>
                <h2>Keep this hand?</h2>
                <p className="muted small">
                  {mePlayer.mulligans === 0 ? "Seven cards. " : `Mulligan ${mePlayer.mulligans}: you will put ${mePlayer.mulligans} on the bottom after keeping. `}
                  {view.players[view.activePlayer]?.name} goes first.
                </p>
                <div className="mulligan-hand">
                  {mePlayer.hand.cards.map((c) => (
                    <CardTile key={c.iid} card={c} printings={printings} onTap={holdCard} onHold={holdCard} />
                  ))}
                </div>
                <div className="actions">
                  <button className="btn" onClick={() => sock.dispatch({ type: "Mulligan", payload: { player: me! } })}>
                    Mulligan
                  </button>
                  <button className="btn btn-primary" onClick={() => sock.dispatch({ type: "HandKept", payload: { player: me! } })}>
                    Keep
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Put {needBottom} on the bottom</h2>
                <p className="muted small">Tap a card to put it on the bottom of your library.</p>
                <div className="mulligan-hand">
                  {mePlayer.hand.cards.map((c) => (
                    <CardTile key={c.iid} card={c} printings={printings} onTap={(card) => sock.dispatch({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "library", owner: me!, position: "bottom" } } })} onHold={holdCard} />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {view.phase === "mulligan" && mePlayer?.kept && needBottom === 0 && (
        <div className="toast is-info">Waiting for {view.turnOrder.filter((id) => !view.players[id]!.kept).map((id) => view.players[id]!.name).join(", ") || "everyone"}...</div>
      )}

      {sheetView}
      {dialog && <DialogView dialog={dialog} onClose={() => setDialog(null)} />}
      {zoom && <CardZoom card={zoom} printings={printings} onClose={() => setZoom(null)} />}
      {liveCardsPanel && (
        <Panel title={liveCardsPanel.title} {...(liveCardsPanel.subtitle ? { subtitle: liveCardsPanel.subtitle } : {})} onClose={() => setCardsPanel(null)} wide>
          <CardList cards={liveCardsPanel.cards} printings={printings} onTap={tapCard} onHold={holdCard} />
        </Panel>
      )}
      {opponent && view.players[opponent] && (
        <OpponentPanel player={view.players[opponent]!} view={view} printings={printings} me={me} onClose={() => setOpponent(null)} onTap={tapCard} onHold={holdCard} onShowCards={showCards} onPlayerSheet={(p) => setSheet({ kind: "player", player: p })} />
      )}
      {showLog && (
        <LogPanel
          log={view.log}
          canRevert={canAct}
          onClose={() => setShowLog(false)}
          onRevert={(seq) =>
            setDialog({
              kind: "confirm",
              title: `Rewind the game to just after #${seq}?`,
              body: "Everything after that line is undone for everyone. The log keeps a note of the rewind.",
              confirmLabel: "Rewind",
              danger: true,
              onConfirm: () => {
                sock.send({ t: "revert", toSeq: seq });
                setShowLog(false);
              },
            })
          }
        />
      )}
      {showTokens && me && (
        <TokenPanel
          onClose={() => setShowTokens(false)}
          onCreate={({ printingId, custom, count, row }) => {
            sock.dispatch({ type: "TokenCreated", payload: { player: me, printing: printingId ? ({ id: printingId } as never) : null, custom, count, row } });
            setShowTokens(false);
          }}
        />
      )}
      {showMenu && <MenuPanel room={room} view={view} me={me} status={sock.status} onClose={() => setShowMenu(false)} actions={menuActions} />}
    </DndContext>
  );
}
