import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DndContext, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { STEP_LABELS, type PlayerView, type RoomInfo, type Row, type ViewCard, type ViewPlayer } from "@cgwf/shared";
import { Avatar } from "../components/Avatar";
import { useSettings } from "../settings";
import { anthemActions, cardActions, diceActions, libraryActions, playerActions, type Ctx } from "./actions";
import { setAmbient, stopAmbient } from "./ambient";
import { Battlefield } from "./Battlefield";
import { CardTile } from "./CardTile";
import { CardZoom } from "./CardZoom";
import { LifeTicks, LifeWidget, useLifeTicks } from "./LifeWidget";
import { useMat, useSleeves, type Looks } from "./look";
import { ManaBank, ManaSummary } from "./Mana";
import { battlefieldCards, deriveFor, nameOf, seatOrderFrom, type Printings } from "./model";
import { CardList, LogPanel, MenuPanel, OpponentPanel, Panel } from "./Panels";
import { SettingsPanel } from "./SettingsPanel";
import { ActionSheet, DialogView, type Action, type Dialog } from "./Sheets";
import type { RoomSocket } from "./socket";
import { TokenFinder } from "./TokenFinder";
import { TriggersPanel } from "./Triggers";

/**
 * The table. Phone landscape first: opponents across the top (or around the
 * table), my battlefield sections on my playmat in the middle, hand + zones +
 * life along the bottom (or top). Every action goes through the server as an
 * event; this component only renders the view and applies the player's
 * personalization.
 */

type Sheet = { kind: "card"; card: ViewCard } | { kind: "library" } | { kind: "player"; player: ViewPlayer } | { kind: "dice" } | { kind: "anthems"; player: ViewPlayer } | null;
interface CardsPanel {
  title: string;
  subtitle?: string;
  cards: ViewCard[];
  /** "library": the panel follows my known library cards and offers Shuffle. */
  follow?: "library";
}

function DropRow({ id, className, children }: { id: string; className: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`${className}${isOver ? " is-over" : ""}`}>
      {children}
    </div>
  );
}

function DropButton({ id, className, style, onClick, label, children }: { id: string; className?: string; style?: React.CSSProperties | undefined; onClick: () => void; label: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <button ref={setNodeRef} className={`zone-btn${className ? ` ${className}` : ""}${isOver ? " is-over" : ""}`} style={style} onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}

function OpponentChip({ p, member, active, side, size, onClick }: { p: ViewPlayer; member: RoomInfo["members"][number] | undefined; active: boolean; side: boolean; size: string; onClick: () => void }) {
  const ticks = useLifeTicks(p.life);
  const field = battlefieldCards(p).length;
  return (
    <button
      className={`opp-chip is-${size}${active ? " is-active" : ""}${p.conceded ? " is-out" : ""}${member && !member.online ? " is-offline" : ""}${side ? " is-side" : ""}`}
      onClick={onClick}
      aria-label={`${p.name}, ${p.life} life, ${p.hand.count} in hand, ${p.library.count} in library, ${field} on the battlefield${active ? ", active player" : ""}${p.conceded ? ", conceded" : ""}. Open their battlefield`}
    >
      {member && <Avatar avatar={member.avatar} color={member.color} size={size === "small" ? 22 : size === "large" ? 34 : 26} />}
      <span className="opp-name">{p.name}</span>
      <span className="opp-life">
        {p.life}
        <LifeTicks ticks={ticks} />
      </span>
      <span className="opp-meta">
        <span title="Hand">H{p.hand.count}</span>
        <span title="Library">L{p.library.count}</span>
        <span title="Battlefield">B{field}</span>
        {p.counters.poison ? <span className="is-poison">{p.counters.poison}p</span> : null}
        <ManaSummary player={p} />
      </span>
    </button>
  );
}

export function Table({ room, view, printings, sock }: { room: RoomInfo; view: PlayerView; printings: Printings; sock: RoomSocket }) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const me = view.viewer;
  const mePlayer = me ? view.players[me] : undefined;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [dialogState, setDialogState] = useState<{ d: Dialog; key: number } | null>(null);
  const dialogSeq = useRef(0);
  // Each dialog gets a fresh key so its form state never leaks into the next one in a chain.
  const setDialog = useCallback((d: Dialog | null) => setDialogState(d ? { d, key: ++dialogSeq.current } : null), []);
  const [zoom, setZoom] = useState<ViewCard | null>(null);
  const [cardsPanel, setCardsPanel] = useState<CardsPanel | null>(null);
  const [opponent, setOpponent] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [showTokens, setShowTokens] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [dismissedEnd, setDismissedEnd] = useState(false);
  const wantRematch = useRef(false);

  // Looks (playmat + sleeves) for everyone at the table.
  const looks: Looks = useMemo(() => Object.fromEntries(room.members.map((m) => [m.userId, m.look])), [room.members]);
  const sleeveOf = useSleeves(looks);
  const myMat = useMat(me ? looks[me] : undefined);
  const mySleeve = me ? sleeveOf(me) : null;

  // The table takes the whole screen: hide the site chrome while it is mounted.
  useEffect(() => {
    document.body.classList.add("in-table");
    return () => document.body.classList.remove("in-table");
  }, []);

  // Ambient sound follows the setting while a table is open.
  useEffect(() => {
    setAmbient(settings.ambient);
    return () => stopAmbient();
  }, [settings.ambient]);

  // Rematch: the host navigates as soon as the new code arrives; others get a banner.
  useEffect(() => {
    if (room.nextCode && wantRematch.current) {
      wantRematch.current = false;
      navigate(`/room/${room.nextCode}`);
    }
  }, [room.nextCode, navigate]);

  const closeSheet = useCallback(() => setSheet(null), []);
  const showCards = useCallback((title: string, cards: ViewCard[], subtitle?: string) => setCardsPanel(subtitle ? { title, cards, subtitle } : { title, cards }), []);
  const awaitingLibrary = useRef(false);
  const openLibraryWhenKnown = useCallback(() => {
    awaitingLibrary.current = true;
  }, []);
  useEffect(() => {
    if (!awaitingLibrary.current || !mePlayer || mePlayer.library.known.length === 0) return;
    awaitingLibrary.current = false;
    setCardsPanel({ title: "Your library (top first)", subtitle: "Only you can see these until you shuffle", cards: mePlayer.library.known, follow: "library" });
  }, [mePlayer]);

  const ctx: Ctx = useMemo(
    () => ({ view, printings, me, dispatch: sock.dispatch, send: sock.send, dialog: setDialog, zoom: setZoom, showCards, openLibraryWhenKnown, close: closeSheet }),
    [view, printings, me, sock.dispatch, sock.send, setDialog, showCards, openLibraryWhenKnown, closeSheet],
  );

  const tapCard = useCallback((card: ViewCard) => setSheet({ kind: "card", card }), []);
  const holdCard = useCallback((card: ViewCard) => setZoom(card), []);

  // Keep panels in sync with the live view (a card list opened from a zone follows that zone).
  const liveCardsPanel = useMemo(() => {
    if (!cardsPanel) return null;
    if (cardsPanel.follow === "library") return mePlayer ? { ...cardsPanel, cards: mePlayer.library.known } : null;
    const ids = new Set(cardsPanel.cards.map((c) => c.iid));
    const all = Object.values(view.players).flatMap((p) => [...p.graveyard, ...p.exile, ...p.command, ...p.hand.cards, ...p.library.known, ...battlefieldCards(p)]);
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
  const myDerived = useMemo(() => (mePlayer ? deriveFor(mePlayer, printings) : null), [mePlayer, printings]);
  const highlighted = useMemo(() => new Set(view.pendingTriggers.map((t) => t.iid)), [view.pendingTriggers]);
  // For the zoom view: derived stats + attachments of whichever battlefield the card sits on.
  const zoomExtras = useMemo(() => {
    if (!zoom || zoom.zone.kind !== "battlefield") return { derived: undefined, attachments: [] as ViewCard[] };
    const holder = view.players[zoom.zone.owner];
    if (!holder) return { derived: undefined, attachments: [] as ViewCard[] };
    const d = deriveFor(holder, printings);
    return { derived: d.cards.get(zoom.iid), attachments: battlefieldCards(holder).filter((c) => c.attachedTo === zoom.iid) };
  }, [zoom, view, printings]);
  const active = view.players[view.activePlayer];
  const isMyTurn = me === view.activePlayer;
  const ended = view.phase === "ended";
  const canAct = Boolean(mePlayer && !mePlayer.conceded && !ended);
  const isHost = me !== null && room.hostId === me;

  // ---- layout from settings ---------------------------------------------
  const layout = settings.layout;
  const around = layout.opponents === "around" && others.length >= 2;
  const sideLeft = around ? others[0] : undefined;
  const sideRight = around ? others[others.length - 1] : undefined;
  const topOpponents = around ? others.slice(1, -1) : others;
  const tableClass = ["table", `theme-${settings.theme}`, `opp-${layout.opponentSize}`, isMyTurn ? "is-my-turn" : "", layout.compact ? "is-compact" : "", layout.hand === "top" ? "hand-top" : "", around ? "opp-around" : ""]
    .filter(Boolean)
    .join(" ");
  const tableStyle = { "--card-scale": layout.cardScale } as React.CSSProperties;

  // ---- mulligan overlay ------------------------------------------------
  const needBottom = mePlayer?.toBottom ?? 0;
  const showMulligan = Boolean(mePlayer && !mePlayer.conceded && ((view.phase === "mulligan" && !mePlayer.kept) || needBottom > 0));

  // ---- sheet contents ----------------------------------------------------
  let sheetView: React.ReactNode = null;
  if (sheet && me) {
    if (sheet.kind === "card") {
      const live = Object.values(view.players)
        .flatMap((p) => [...p.graveyard, ...p.exile, ...p.command, ...p.hand.cards, ...p.library.known, ...battlefieldCards(p)])
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
    } else if (sheet.kind === "anthems") {
      const p = view.players[sheet.player.id] ?? sheet.player;
      sheetView = <ActionSheet title={p.id === me ? "Anthems on your creatures" : `Anthems on ${p.name}'s creatures`} subtitle="Detected from card text; hide conditional ones, add what the parser misses" actions={anthemActions(ctx, p)} onClose={closeSheet} />;
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

  const concede = () =>
    setDialog({ kind: "confirm", title: "Concede the game?", body: "You stay at the table as a spectator.", confirmLabel: "Concede", danger: true, onConfirm: () => sock.dispatch({ type: "PlayerConceded", payload: { player: me! } }) });
  const leave = () =>
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
  const rematch = () => {
    wantRematch.current = true;
    sock.send({ t: "rematch" });
  };

  const menuActions: Action[] = [
    { label: "Game log", run: () => (setShowMenu(false), setShowLog(true)) },
    { label: "Personalize", hint: "playmat, sleeves, layout", run: () => (setShowMenu(false), setShowSettings(true)) },
    { label: "Dice, coin, random opponent", run: () => (setShowMenu(false), setSheet({ kind: "dice" })), disabled: !canAct },
    { label: "Create tokens", run: () => (setShowMenu(false), setShowTokens(true)), disabled: !canAct },
    { label: "Undo my last action", hint: "only while nobody else has acted", run: () => (setShowMenu(false), sock.send({ t: "undo" })), disabled: !canAct },
    { label: "Untap all my permanents", run: () => (setShowMenu(false), sock.dispatch({ type: "UntapAll", payload: { player: me! } })), disabled: !canAct },
    ...(ended && isHost ? [{ label: "Rematch with the same decks", hint: "new game, same seats", run: () => (setShowMenu(false), rematch()) }] : []),
    { label: "Concede", danger: true, disabled: !canAct, run: () => (setShowMenu(false), concede()) },
    { label: "Leave table", danger: true, run: () => (setShowMenu(false), leave()) },
  ];

  const renderChip = (p: ViewPlayer, side: boolean) => (
    <OpponentChip key={p.id} p={p} member={room.members.find((m) => m.userId === p.id)} active={view.activePlayer === p.id} side={side} size={layout.opponentSize} onClick={() => setOpponent(p.id)} />
  );

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className={tableClass} style={tableStyle}>
        {/* ---- top: opponents + turn tracker ---- */}
        <div className="table-top">
          <div className="opp-strip">{topOpponents.map((p) => renderChip(p, false))}</div>
          <div className="turn-bar">
            {view.phase === "mulligan" ? (
              <span className="turn-label">Mulligans</span>
            ) : ended ? (
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
            {mePlayer && <ManaBank player={mePlayer} dispatch={sock.dispatch} disabled={!canAct} />}
            <button className="btn btn-small menu-btn" onClick={() => setShowMenu(true)} aria-label="Menu">
              &#8942;
            </button>
          </div>
        </div>

        {around && sideLeft && <div className="table-side is-left">{renderChip(sideLeft, true)}</div>}
        {around && sideRight && <div className="table-side is-right">{renderChip(sideRight, true)}</div>}

        {/* ---- middle: my battlefield on my playmat ---- */}
        <div className={`table-mid mat ${myMat.className}`} style={myMat.style}>
          {mePlayer && myDerived ? (
            <Battlefield
              player={mePlayer}
              printings={printings}
              derived={myDerived}
              onTap={tapCard}
              onHold={holdCard}
              draggable={canAct}
              droppable={canAct}
              highlighted={highlighted}
              onAnthems={() => setSheet({ kind: "anthems", player: mePlayer })}
              sleeveOf={sleeveOf}
            />
          ) : (
            <div className="spectating">
              <p className="muted">You are watching. Tap a player above to see their battlefield.</p>
            </div>
          )}
        </div>

        {/* ---- bottom (or top): zones, hand, life ---- */}
        {mePlayer && (
          <div className="table-bottom">
            <div className="zone-btns">
              <DropButton id="zone:library" className={`is-library ${mySleeve?.className ?? ""}`} style={mySleeve?.style} onClick={() => setSheet({ kind: "library" })} label={`Library, ${mePlayer.library.count} cards`}>
                <span>Library</span>
                <strong>{mePlayer.library.count}</strong>
              </DropButton>
              <DropButton id="zone:graveyard" onClick={() => showCards("Your graveyard", mePlayer.graveyard)} label={`Graveyard, ${mePlayer.graveyard.length} cards`}>
                <span>Grave</span>
                <strong>{mePlayer.graveyard.length}</strong>
              </DropButton>
              <DropButton id="zone:exile" onClick={() => showCards("Your exile", mePlayer.exile)} label={`Exile, ${mePlayer.exile.length} cards`}>
                <span>Exile</span>
                <strong>{mePlayer.exile.length}</strong>
              </DropButton>
              <DropButton id="zone:command" className="is-command" onClick={() => showCards("Your command zone", mePlayer.command)} label={`Command zone, ${mePlayer.command.length} cards`}>
                <span>Cmd</span>
                <strong>{mePlayer.command.length}</strong>
              </DropButton>
              <button className="zone-btn is-tokens" onClick={() => setShowTokens(true)} disabled={!canAct} aria-label="Create tokens">
                <span>Token</span>
                <strong>+</strong>
              </button>
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

        {me && canAct && <TriggersPanel triggers={view.pendingTriggers} me={me} dispatch={sock.dispatch} />}
        {sock.error && (
          <div className="toast" role="status">
            {sock.error}
          </div>
        )}
        {sock.status !== "open" && (
          <div className="toast is-warn" role="status">
            {sock.status === "reconnecting" ? "Reconnecting..." : sock.status}
          </div>
        )}
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
        <div className="toast is-info" role="status">
          Waiting for {view.turnOrder.filter((id) => !view.players[id]!.kept).map((id) => view.players[id]!.name).join(", ") || "everyone"}...
        </div>
      )}

      {ended && !dismissedEnd && (
        <div className="mulligan game-over">
          <div className="mulligan-box">
            <h2>{view.winner ? `${view.players[view.winner]?.name} wins` : "Game over"}</h2>
            <p className="muted small">
              {view.turn} turn{view.turn === 1 ? "" : "s"}. {room.nextCode ? "The host has started a rematch." : isHost ? "Play again with the same decks and seats, or leave the table." : `${room.members.find((m) => m.userId === room.hostId)?.name ?? "The host"} can start a rematch with the same decks.`}
            </p>
            <div className="actions">
              {room.nextCode ? (
                <button className="btn btn-primary btn-big" onClick={() => navigate(`/room/${room.nextCode}`)}>
                  Join the rematch
                </button>
              ) : isHost ? (
                <button className="btn btn-primary btn-big" onClick={rematch}>
                  Rematch
                </button>
              ) : null}
              <button className="btn" onClick={() => setDismissedEnd(true)}>
                Look at the table
              </button>
              <button className="btn btn-danger" onClick={leave}>
                Leave table
              </button>
            </div>
          </div>
        </div>
      )}
      {ended && dismissedEnd && room.nextCode && (
        <button className="toast is-info is-action" onClick={() => navigate(`/room/${room.nextCode}`)}>
          Rematch started: tap to join table {room.nextCode}
        </button>
      )}

      {sheetView}
      {dialogState && <DialogView key={dialogState.key} dialog={dialogState.d} onClose={() => setDialog(null)} />}
      {zoom && <CardZoom card={zoom} printings={printings} view={view} sleeve={sleeveOf(zoom.owner)} derived={zoomExtras.derived} attachments={zoomExtras.attachments} onClose={() => setZoom(null)} />}
      {liveCardsPanel && (
        <Panel title={liveCardsPanel.title} {...(liveCardsPanel.subtitle ? { subtitle: liveCardsPanel.subtitle } : {})} onClose={() => setCardsPanel(null)} wide>
          {liveCardsPanel.follow === "library" && me && (
            <div className="actions" style={{ marginBottom: 10 }}>
              <button
                className="btn btn-small btn-primary"
                onClick={() => {
                  sock.dispatch({ type: "LibraryShuffled", payload: { player: me } });
                  setCardsPanel(null);
                }}
              >
                Done, shuffle
              </button>
              <button className="btn btn-small" onClick={() => setCardsPanel(null)}>
                Done, keep order
              </button>
            </div>
          )}
          <CardList cards={liveCardsPanel.cards} printings={printings} onTap={tapCard} onHold={holdCard} sleeveOf={sleeveOf} empty="No cards here." />
        </Panel>
      )}
      {opponent && view.players[opponent] && (
        <OpponentPanel
          player={view.players[opponent]!}
          member={room.members.find((m) => m.userId === opponent)}
          view={view}
          printings={printings}
          me={me}
          sleeveOf={sleeveOf}
          onClose={() => setOpponent(null)}
          onTap={tapCard}
          onHold={holdCard}
          onShowCards={showCards}
          onPlayerSheet={(p) => setSheet({ kind: "player", player: p })}
          onAnthems={(p) => setSheet({ kind: "anthems", player: p })}
          highlighted={highlighted}
        />
      )}
      {showLog && (
        <LogPanel
          log={view.log}
          members={room.members}
          canRevert={canAct}
          onClose={() => setShowLog(false)}
          onRevert={(seq) =>
            setDialog({
              kind: "confirm",
              title: `Rewind the game to just after #${seq}?`,
              body: "Everything after that line is undone for everyone, and the log says who rewound it.",
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
        <TokenFinder
          onClose={() => setShowTokens(false)}
          onCreate={({ printingId, custom, count, row }) => {
            sock.dispatch({ type: "TokenCreated", payload: { player: me, printing: printingId ? ({ id: printingId } as never) : null, custom, count, row } });
            setShowTokens(false);
          }}
        />
      )}
      {showSettings && (
        <Panel title="Personalize" subtitle="Changes apply as you make them" onClose={() => setShowSettings(false)} wide>
          <SettingsPanel />
        </Panel>
      )}
      {showMenu && <MenuPanel room={room} view={view} me={me} status={sock.status} onClose={() => setShowMenu(false)} actions={menuActions} />}
    </DndContext>
  );
}
