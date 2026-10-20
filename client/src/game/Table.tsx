import { CoachLink } from "../coach/coach";
import { VoiceButton } from "./Voice";
import { useTableMotion } from "./useTableMotion";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DndContext, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { isOut, type EngineAnswer, type EngineOption, type PlayerView, type RoomInfo, type Row, type ViewCard, type ViewPlayer } from "@cgwf/shared";
import { EngineBar, EngineListSheet, EngineMulligan, NO_PICK, cardOptionIndex, initialPick, promptHighlights, refKey, type EnginePick } from "./Engine";
import { EnginePromptSheet, SHEET_PROMPT_KINDS, PayWithSheet } from "./EnginePrompts";
import { InteractionStack, StackPanel, isInteraction } from "./StackPanel";
import { ActiveBoard, EdgeTab, GameLog, LogToasts, printingAsCard } from "./Overlays";
import { EngineNotices } from "./Notices";
import { INITIAL_PANELS, isLandscapeNow, panelsReducer } from "./sidePanels";
import { installLayoutCheck } from "./layoutCheck";
import { StopsPanel, toggleStop } from "./StopsPanel";
import { Avatar } from "../components/Avatar";
import { useSettings } from "../settings";
import { anthemActions, cardActions, diceActions, libraryActions, playerActions, type Ctx } from "./actions";
import { setAmbient, stopAmbient } from "./ambient";
import { Battlefield } from "./Battlefield";
import { CardTile } from "./CardTile";
import { CardZoom } from "./CardZoom";
import { playableHand, zoomOptions, ZoomActions } from "./ZoomActions";
import { CombatBar, attackTargets, colorOf, targetKey, type AttackTarget, type CombatMode } from "./CombatBar";
import { DamageSheet } from "./DamageSheet";
import { PhaseStrip } from "./PhaseStrip";
import { LifeTicks, LifeWidget, useLifeTicks } from "./LifeWidget";
import { useMat, useSleeves, type Looks } from "./look";
import { ManaBank, ManaSummary } from "./Mana";
import { battlefieldCards, deriveFor, findCard as findCardIn, nameOf, seatOrderFrom, type Printings } from "./model";
import { CardList, LogPanel, MenuPanel, OpponentPanel, Panel } from "./Panels";
import { SettingsPanel } from "./SettingsPanel";
import { ActionSheet, DialogView, type Action, type Dialog } from "./Sheets";
import type { RoomSocket } from "./socket";
import { TokenFinder } from "./TokenFinder";
import { TriggersPanel } from "./Triggers";
import { AgentsPanel } from "./AgentsPanel";
import { isOwner, useUser } from "../user";
import { isOptionalChoice } from "./optionalChoice";

/**
 * The table. Phone landscape first: opponents across the top (or around the
 * table), my battlefield sections on my playmat in the middle, hand + zones +
 * life along the bottom (or top). Every action goes through the server as an
 * event; this component only renders the view and applies the player's
 * personalization.
 */

type Sheet =
  | { kind: "card"; card: ViewCard }
  | { kind: "library" }
  | { kind: "player"; player: ViewPlayer }
  | { kind: "dice" }
  | { kind: "anthems"; player: ViewPlayer }
  | { kind: "engineAbilities"; card: ViewCard; options: Array<{ index: number; description: string; cost: string | null; kind: string }> }
  | { kind: "payWith"; card: ViewCard; options: Array<{ index: number; description: string; cost: string | null; kind: string }> }
  | { kind: "engineList" }
  | { kind: "enginePrompt" }
  | null;
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
    <div ref={setNodeRef} data-zone={id.replace("zone:", "")} className={`${className}${isOver ? " is-over" : ""}`}>
      {children}
    </div>
  );
}

function DropButton({ id, className, style, onClick, label, children }: { id: string; className?: string; style?: React.CSSProperties | undefined; onClick: () => void; label: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <button ref={setNodeRef} data-zone={id.replace("zone:", "")} className={`zone-btn${className ? ` ${className}` : ""}${isOver ? " is-over" : ""}`} style={style} onClick={onClick} aria-label={label}>
      {children}
    </button>
  );
}

function OpponentChip({ p, member, active, side, size, onClick }: { p: ViewPlayer; member: RoomInfo["members"][number] | undefined; active: boolean; side: boolean; size: string; onClick: () => void }) {
  const ticks = useLifeTicks(p.life);
  const field = battlefieldCards(p).length;
  return (
    <button
      className={`opp-chip is-${size}${active ? " is-active" : ""}${isOut(p) ? " is-out" : ""}${member && !member.online ? " is-offline" : ""}${side ? " is-side" : ""}${member?.isAgent ? " is-agent" : ""}${member?.thinking ? " is-thinking" : ""}`}
      onClick={onClick}
      data-player-id={p.id}
      aria-label={`${p.name}, ${p.life} life, ${p.hand.count} in hand, ${p.library.count} in library, ${field} on the battlefield${active ? ", active player" : ""}${p.conceded ? ", conceded" : p.eliminated ? `, out (${p.eliminated})` : ""}. Open their battlefield`}
    >
      {member && <Avatar avatar={member.avatar} color={member.color} size={size === "small" ? 22 : size === "large" ? 34 : 26} />}
      <span className="opp-name">
        {p.name}
        {member?.isAgent && <span className="bot-chip">{member.thinking ? "…" : "BOT"}</span>}
        {p.eliminated && !p.conceded && <span className="out-chip">OUT</span>}
      </span>
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
  const tableRef = useRef<HTMLDivElement>(null);
  useTableMotion(tableRef, view, sock.status === "open");
  const navigate = useNavigate();
  const { settings, update: updateSettings } = useSettings();
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
  const [showAgents, setShowAgents] = useState(false);
  const [showStops, setShowStops] = useState(false);
  const [mode, setMode] = useState<CombatMode | null>(null);
  const [showDamage, setShowDamage] = useState(false);
  const { user } = useUser();
  const hasAgents = room.members.some((m) => m.isAgent);
  const [dismissedEnd, setDismissedEnd] = useState(false);
  const wantRematch = useRef(false);

  // ---- rules engine (engine tables) ------------------------------------------
  const engine = view.engine ?? null;
  const engineMode = engine !== null;
  const prompt = engine?.prompt ?? null;
  const [pick, setPickState] = useState<EnginePick>(NO_PICK);
  const pickFor = useRef<number | null>(null);
  // A new prompt starts with a fresh pick state (and closes any list sheet from the previous one).
  useEffect(() => {
    const id = prompt?.promptId ?? null;
    if (pickFor.current === id) return;
    pickFor.current = id;
    setPickState(initialPick(prompt));
    setSheet((s) => {
      const mine = s && (s.kind === "engineList" || s.kind === "engineAbilities" || s.kind === "enginePrompt" || s.kind === "payWith");
      if (mine) s = null;
      if (!prompt || s) return s; // never stomp a sheet the player opened themself
      // Questions that need a sheet open at once; list choices open when there is nothing on the table to tap.
      if (SHEET_PROMPT_KINDS.has(prompt.kind)) return { kind: "enginePrompt" };
      // Optional choices ("up to one", "any number of", "you may") always open their list: the empty answer must
      // never be the easy one, and glowing cards may be hidden behind an overlay (owner report, Cloud, 2026-10-20).
      if (isOptionalChoice(prompt)) return { kind: "engineList" };
      // Lists open on their own when something in them cannot be tapped on the table (hidden cards, text, spells on the stack);
      // players are chips in the bar already.
      if (prompt.kind === "choose" || (prompt.kind === "chooseMany" && prompt.reason !== "mulligan" && prompt.reason !== "putBack") || prompt.kind === "targets") {
        const tappable = (o: EngineOption) => (o.kind === "card" && findCardIn(view, o.iid) !== null) || (o.kind === "player" && prompt.kind === "targets");
        if (prompt.options.length && !prompt.options.every(tappable)) return { kind: "engineList" };
      }
      return s;
    });
  }, [prompt]); // eslint-disable-line react-hooks/exhaustive-deps
  const setPick = useCallback((p: EnginePick) => setPickState(p), []);
  const answerEngine = useCallback((a: EngineAnswer) => sock.send({ t: "engine", answer: a }), [sock]);
  // The Interaction Stack window opens on its own whenever a new chain forms (a response on top of
  // something, or a spell aimed at a stack item) and stays until the stack empties or the player tucks it away.
  const chain = engineMode && isInteraction(view.stack);
  const [chainMin, setChainMin] = useState(false);
  // Active Board (left edge) follows the turn around the table; the Game Log lives on the right third.
  // One reducer (sidePanels.ts) decides which are open: one at a time at phone landscape, stacked in
  // portrait, re-applied on every rotation. Orientation is read live at each dispatch, never cached.
  const [panels, dispatchPanels] = useReducer(panelsReducer, INITIAL_PANELS);
  const boardOpen = panels.board;
  const logOpen = panels.log;
  const openBoard = useCallback(() => dispatchPanels({ type: "openBoard", landscape: isLandscapeNow() }), []);
  const closeBoard = useCallback(() => dispatchPanels({ type: "closeBoard" }), []);
  const openLog = useCallback(() => dispatchPanels({ type: "openLog", landscape: isLandscapeNow() }), []);
  const closeLog = useCallback(() => dispatchPanels({ type: "closeLog" }), []);
  const opponentsTurn = useRef(false);
  opponentsTurn.current = engineMode && view.phase === "playing" && view.activePlayer !== me;
  useEffect(() => {
    // Rotation: matchMedia "change", plus resize / orientationchange for browsers that report late.
    const relayout = () => dispatchPanels({ type: "layout", landscape: isLandscapeNow(), opponentsTurn: opponentsTurn.current });
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(orientation: landscape)") : null;
    mq?.addEventListener("change", relayout);
    window.addEventListener("resize", relayout);
    window.addEventListener("orientationchange", relayout);
    relayout();
    const uninstall = installLayoutCheck();
    return () => {
      mq?.removeEventListener("change", relayout);
      window.removeEventListener("resize", relayout);
      window.removeEventListener("orientationchange", relayout);
      uninstall();
    };
  }, []);
  const activeSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!engineMode || view.phase !== "playing") return;
    if (activeSeen.current === view.activePlayer) return;
    activeSeen.current = view.activePlayer;
    if (view.activePlayer !== me) openBoard();
    else closeBoard(); // your own board is the table itself
  }, [engineMode, view.phase, view.activePlayer, me, openBoard, closeBoard]);
  const chainTop = view.stack[0]?.id ?? null;
  const chainSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!chain) {
      chainSeen.current = null;
      setChainMin(false);
      return;
    }
    if (chainSeen.current !== chainTop) {
      chainSeen.current = chainTop;
      setChainMin(false);
    }
  }, [chain, chainTop]);
  const engineHighlights = useMemo(() => promptHighlights(prompt), [prompt]);
  const engineSelected = useMemo(() => {
    const out = new Set<string>();
    if (!prompt) return out;
    if (pick.kind === "attack") for (const iid of Object.keys(pick.targets)) out.add(iid);
    else if (pick.kind === "block") for (const iid of Object.keys(pick.blocks)) out.add(iid);
    else if (pick.kind === "select" && (prompt.kind === "targets" || prompt.kind === "chooseMany")) {
      for (const o of prompt.options) if (o.kind === "card" && pick.picked.includes(o.index)) out.add(o.iid);
    }
    return out;
  }, [pick, prompt]);
  /** Tap on an engine table: act on the open prompt if the card is one of its options, else zoom. */
  const engineTap = useCallback(
    (card: ViewCard) => {
      if (!prompt) {
        setZoom(card);
        return;
      }
      switch (prompt.kind) {
        case "priority": {
          const options = prompt.options.filter((o) => o.iid === card.iid);
          if (options.length === 1) answerEngine({ promptId: prompt.promptId, option: options[0]!.index });
          else if (options.length > 1) setSheet({ kind: "engineAbilities", card, options });
          else setZoom(card);
          return;
        }
        case "targets":
        case "chooseMany": {
          const index = cardOptionIndex(prompt.options, card.iid);
          if (index === null) return void setZoom(card);
          const picked = pick.kind === "select" ? pick.picked : [];
          const next = picked.includes(index) ? picked.filter((i) => i !== index) : prompt.max === 1 ? [index] : picked.length >= prompt.max ? picked : [...picked, index];
          setPickState({ kind: "select", picked: next });
          return;
        }
        case "choose": {
          const index = cardOptionIndex(prompt.options, card.iid);
          if (index === null) return void setZoom(card);
          answerEngine({ promptId: prompt.promptId, option: index });
          return;
        }
        case "attackers": {
          const cand = prompt.candidates.find((c) => c.iid === card.iid);
          if (!cand || pick.kind !== "attack") return void setZoom(card);
          const targets = { ...pick.targets };
          if (targets[card.iid]) delete targets[card.iid];
          else {
            const current = pick.current;
            const allowed = current && (cand.canAttack ?? []).some((d) => refKey(d) === refKey(current)) ? current : (cand.canAttack ?? [])[0];
            if (!allowed) return;
            targets[card.iid] = allowed;
          }
          setPickState({ kind: "attack", targets, current: pick.current });
          return;
        }
        case "blockers": {
          if (pick.kind !== "block") return void setZoom(card);
          if (prompt.attackers.some((a) => a.iid === card.iid)) {
            setPickState({ ...pick, current: card.iid });
            return;
          }
          const blocker = prompt.blockers.find((b) => b.iid === card.iid);
          if (!blocker) return void setZoom(card);
          const blocks = { ...pick.blocks };
          if (blocks[card.iid]) delete blocks[card.iid];
          else if (pick.current && (blocker.canBlock ?? []).includes(pick.current)) blocks[card.iid] = pick.current;
          else return;
          setPickState({ kind: "block", blocks, current: pick.current });
          return;
        }
        default:
          setZoom(card);
      }
    },
    [prompt, pick, answerEngine],
  );

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

  const tapCard = useCallback(
    (card: ViewCard) => {
      if (engineMode) {
        engineTap(card);
        return;
      }
      // Combat picking: tapping one of my battlefield cards assigns it instead of opening the sheet.
      if (mode && me && card.zone.kind === "battlefield" && card.zone.owner === me) {
        if (mode.kind === "attack") {
          const next = { ...mode.targets };
          if (next[card.iid] && targetKey(next[card.iid]!) === targetKey(mode.current)) delete next[card.iid];
          else if (card.tapped) return;
          else next[card.iid] = mode.current;
          setMode({ ...mode, targets: next });
        } else {
          if (!mode.current) return;
          const next = { ...mode.blocks };
          if (next[card.iid] === mode.current) delete next[card.iid];
          else if (card.tapped) return;
          else next[card.iid] = mode.current;
          setMode({ ...mode, blocks: next });
        }
        return;
      }
      setSheet({ kind: "card", card });
    },
    [mode, me, engineMode, engineTap],
  );
  const holdCard = useCallback((card: ViewCard) => setZoom(card), []);
  /** Long-press on an engine table: a glowing spell or ability opens "Pay with" (choose the mana sources); anything else zooms. */
  const engineHold = useCallback(
    (card: ViewCard) => {
      if (prompt?.kind === "priority") {
        const options = prompt.options.filter((o) => o.iid === card.iid && o.kind !== "land");
        if (options.length > 0) {
          setSheet({ kind: "payWith", card, options });
          return;
        }
      }
      setZoom(card);
    },
    [prompt],
  );

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
  const highlighted = useMemo(() => (engineMode ? engineHighlights : new Set(view.pendingTriggers.map((t) => t.iid))), [engineMode, engineHighlights, view.pendingTriggers]);
  // For the zoom view: derived stats + attachments of whichever battlefield the card sits on.
  const zoomExtras = useMemo(() => {
    if (!zoom || zoom.zone.kind !== "battlefield") return { derived: undefined, attachments: [] as ViewCard[] };
    const holder = view.players[zoom.zone.owner];
    if (!holder) return { derived: undefined, attachments: [] as ViewCard[] };
    const d = deriveFor(holder, printings);
    return { derived: d.cards.get(zoom.iid), attachments: battlefieldCards(holder).filter((c) => c.attachedTo === zoom.iid) };
  }, [zoom, view, printings]);
  const isMyTurn = me === view.activePlayer;
  const ended = view.phase === "ended";
  const canAct = Boolean(mePlayer && !mePlayer.conceded && !ended && !(engineMode && mePlayer.eliminated));
  /** Classic-table actions (events) are off on engine tables. */
  const canEdit = canAct && !engineMode;

  const legalPrompt = canAct && !engine?.engineDown ? prompt : null;
  const availableHand = engineMode ? playableHand(mePlayer?.hand.cards ?? [], legalPrompt) : canEdit ? mePlayer?.hand.cards ?? [] : [];
  const zoomInHand = zoom ? mePlayer?.hand.cards.some((card) => card.iid === zoom.iid) : false;
  const zoomIndex = availableHand.findIndex((card) => card.iid === zoom?.iid);
  const otherPlayable = availableHand.filter((card) => card.iid !== zoom?.iid);
  const zoomNavigation = zoomInHand ? {
    label: zoomIndex >= 0 ? `Playable ${zoomIndex + 1} of ${availableHand.length}` : `${availableHand.length} playable`,
    previous: otherPlayable.length ? () => setZoom(availableHand[zoomIndex < 0 ? availableHand.length - 1 : (zoomIndex - 1 + availableHand.length) % availableHand.length] ?? otherPlayable[otherPlayable.length - 1]!) : null,
    next: otherPlayable.length ? () => setZoom(availableHand[(zoomIndex + 1) % availableHand.length] ?? otherPlayable[0]!) : null,
  } : undefined;
  function zoomActions(card: ViewCard, done: () => void) {
    const hand = Boolean(mePlayer?.hand.cards.some((entry) => entry.iid === card.iid));
    if (engineMode) {
      const options = zoomOptions(legalPrompt, card.iid);
      if (!hand && !options.length && !((card.printingId && printings[card.printingId]?.typeLine.includes("Planeswalker")) && card.owner === me)) return undefined;
      return <ZoomActions options={options} hand={hand} onPick={(index) => {
        // Use only this frame's prompt and options; the server validates again.
        if (legalPrompt?.kind !== "priority" || !options.some((option) => option.index === index)) return;
        done(); closeSheet(); answerEngine({ promptId: legalPrompt.promptId, option: index });
      }} />;
    }
    if (!hand || !canEdit) return undefined;
    const play = cardActions(ctx, card).find((action) => action.label === "Play");
    return play ? <div className="zoom-decisions"><p className="eyebrow">Casual table · You enforce the rules</p><button className="btn btn-primary" onClick={() => { done(); play.run(); }}>Play now</button></div> : undefined;
  }

  const isHost = me !== null && room.hostId === me;

  // ---- combat picking (attackers / blockers) --------------------------------
  const startAttack = () => {
    if (!me) return;
    const first = attackTargets(view, printings, me)[0];
    if (!first) return;
    const targets: Record<string, AttackTarget> = {};
    // Re-declaring: start from the attack already on the table.
    if (view.combat && view.combat.attacker === me && !view.combat.damageDealt) for (const a of view.combat.attackers) targets[a.iid] = { player: a.player, planeswalker: a.planeswalker };
    setMode({ kind: "attack", targets, current: first.target });
  };
  const startBlock = () => {
    if (!me || !view.combat) return;
    const mine = view.combat.attackers.filter((a) => a.player === me);
    const blocks: Record<string, string> = {};
    for (const b of view.combat.blockers) if (b.player === me) blocks[b.iid] = b.attacker;
    setMode({ kind: "block", blocks, current: mine[0]?.iid ?? null });
  };
  const declare = () => {
    if (!mode || !me) return;
    if (mode.kind === "attack") {
      const attacks = Object.entries(mode.targets).map(([iid, t]) => ({ iid, player: t.player, planeswalker: t.planeswalker }));
      if (attacks.length) sock.dispatch({ type: "AttackersDeclared", payload: { attacks } });
    } else {
      sock.dispatch({ type: "BlockersDeclared", payload: { player: me, blocks: Object.entries(mode.blocks).map(([iid, attacker]) => ({ iid, attacker })) } });
    }
    setMode(null);
  };
  // Combat picking ends with the combat it belongs to (damage dealt, turn passed, game over).
  useEffect(() => {
    if (!mode) return;
    if (!canAct || view.phase !== "playing") setMode(null);
    else if (mode.kind === "block" && (!view.combat || view.combat.damageDealt || !view.combat.attackers.some((a) => a.player === me))) setMode(null);
    else if (mode.kind === "attack" && view.activePlayer !== me) setMode(null);
  }, [mode, canAct, view.phase, view.combat, view.activePlayer, me]);
  useEffect(() => {
    if (showDamage && (!view.combat || view.combat.damageDealt || view.combat.attacker !== me)) setShowDamage(false);
  }, [showDamage, view.combat, me]);
  const combatMarks = useMemo(() => {
    const marks = new Map<string, { label: string; color?: string | undefined }>();
    const short = (iid: string) => {
      const c = findCardIn(view, iid);
      return c ? nameOf(c, printings).split(",")[0]! : "?";
    };
    if (mode?.kind === "attack") {
      for (const [iid, t] of Object.entries(mode.targets)) marks.set(iid, { label: `→ ${t.planeswalker ? short(t.planeswalker) : (view.players[t.player]?.name ?? "?")}`, color: colorOf(room.members, t.player) });
    } else if (mode?.kind === "block") {
      for (const [iid, attacker] of Object.entries(mode.blocks)) marks.set(iid, { label: `blocks ${short(attacker)}`, color: view.combat ? colorOf(room.members, view.combat.attacker) : undefined });
    } else if (view.combat && !view.combat.damageDealt) {
      // Everyone sees who attacks whom and who blocks what, on the tiles themselves.
      for (const a of view.combat.attackers) marks.set(a.iid, { label: `→ ${a.planeswalker ? short(a.planeswalker) : (view.players[a.player]?.name ?? "?")}`, color: colorOf(room.members, a.player) });
      for (const b of view.combat.blockers) marks.set(b.iid, { label: `blocks ${short(b.attacker)}`, color: colorOf(room.members, view.combat.attacker) });
    }
    return marks;
  }, [mode, view, printings, room.members]);
  const combatSelected = useMemo(() => (engineMode ? engineSelected : new Set(mode ? Object.keys(mode.kind === "attack" ? mode.targets : mode.blocks) : [])), [mode, engineMode, engineSelected]);
  const confirmWin = (iid: string, name: string, condition: string) =>
    setDialog({
      kind: "confirm",
      title: `Claim the win with ${name}?`,
      body: `${condition}. The game ends and the log records the condition. If an opponent has a response, let them act first.`,
      confirmLabel: "I win",
      onConfirm: () => sock.dispatch({ type: "WinClaimed", payload: { iid } }),
    });

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
  const showMulligan = !engineMode && Boolean(mePlayer && !mePlayer.conceded && ((view.phase === "mulligan" && !mePlayer.kept) || needBottom > 0));

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
    } else if (sheet.kind === "engineAbilities" && prompt) {
      sheetView = <CardZoom card={sheet.card} printings={printings} view={view} onClose={closeSheet}
        actions={zoomActions(sheet.card, closeSheet)} />;
    } else if (sheet.kind === "payWith" && prompt?.kind === "priority") {
      sheetView = <PayWithSheet card={sheet.card} options={sheet.options} view={view} printings={printings} promptId={prompt.promptId} answer={answerEngine} onClose={closeSheet} onZoom={holdCard} />;
    } else if (sheet.kind === "engineList" && prompt) {
      sheetView = <EngineListSheet prompt={prompt} view={view} printings={printings} pick={pick} setPick={setPick} answer={answerEngine} onClose={closeSheet} onZoom={holdCard} />;
    } else if (sheet.kind === "enginePrompt" && prompt && SHEET_PROMPT_KINDS.has(prompt.kind)) {
      sheetView = <EnginePromptSheet prompt={prompt} view={view} printings={printings} answer={answerEngine} onClose={closeSheet} onZoom={holdCard} />;
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
    setDialog({
      kind: "confirm",
      title: "Concede the game?",
      body: engineMode ? "The engine records the concession at your next decision; you stay at the table as a spectator." : "You stay at the table as a spectator.",
      confirmLabel: "Concede",
      danger: true,
      onConfirm: () => (engineMode ? sock.send({ t: "concede" }) : sock.dispatch({ type: "PlayerConceded", payload: { player: me! } })),
    });
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
    ...(isOwner(user) && hasAgents ? [{ label: "Agent reasoning", hint: "what the computer opponents decided and spent", run: () => (setShowMenu(false), setShowAgents(true)) }] : []),
    ...(engineMode
      ? [{ label: "Stops", hint: "where the engine pauses to ask you", run: () => (setShowMenu(false), setShowStops(true)), disabled: !canAct }]
      : [
          { label: "Dice, coin, random opponent", run: () => (setShowMenu(false), setSheet({ kind: "dice" })), disabled: !canAct },
          { label: "Create tokens", run: () => (setShowMenu(false), setShowTokens(true)), disabled: !canAct },
          { label: "Undo my last action", hint: "only while nobody else has acted", run: () => (setShowMenu(false), sock.send({ t: "undo" })), disabled: !canAct },
          { label: "Untap all my permanents", run: () => (setShowMenu(false), sock.dispatch({ type: "UntapAll", payload: { player: me! } })), disabled: !canAct },
        ]),
    ...(ended && isHost ? [{ label: "Rematch with the same decks", hint: "new game, same seats", run: () => (setShowMenu(false), rematch()) }] : []),
    { label: "Concede", danger: true, disabled: !canAct, run: () => (setShowMenu(false), concede()) },
    { label: "Leave table", danger: true, run: () => (setShowMenu(false), leave()) },
  ];

  const renderChip = (p: ViewPlayer, side: boolean) => (
    <OpponentChip key={p.id} p={p} member={room.members.find((m) => m.userId === p.id)} active={view.activePlayer === p.id} side={side} size={layout.opponentSize} onClick={() => setOpponent(p.id)} />
  );

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div ref={tableRef} className={tableClass} style={tableStyle}>
        {/* ---- top: opponents + turn tracker ---- */}
        <div className="table-top">
          <div className="opp-strip">{topOpponents.map((p) => renderChip(p, false))}</div>
          <div className="turn-bar">
            {mePlayer && <ManaBank player={mePlayer} dispatch={sock.dispatch} disabled={!canEdit} />}
            <VoiceButton room={room} />
            <button className="btn btn-small menu-btn" onClick={() => setShowMenu(true)} aria-label="Menu">
              &#8942;
            </button>
          </div>
        </div>

        <PhaseStrip
          view={view}
          printings={printings}
          members={room.members}
          me={me}
          canAct={canEdit}
          dispatch={sock.dispatch}
          onAttack={startAttack}
          onBlock={startBlock}
          onAssignDamage={() => setShowDamage(true)}
          onZoom={holdCard}
          onConfirmWin={confirmWin}
          busy={mode !== null || prompt !== null}
          engine={engine}
          onToggleStop={
            engine
              ? (phase, mine) => {
                  const stops = toggleStop(engine.stops, phase, mine);
                  sock.send({ t: "stops", stops });
                  updateSettings({ engineStops: stops });
                }
              : undefined
          }
          onHold={engine ? (turn) => sock.send({ t: "hold", turn }) : undefined}
        >
          {engineMode && prompt && me && mePlayer && (
            <EngineBar prompt={prompt} view={view} printings={printings} members={room.members} me={me} pick={pick} setPick={setPick} answer={answerEngine} onZoom={holdCard} openList={() => setSheet(SHEET_PROMPT_KINDS.has(prompt.kind) ? { kind: "enginePrompt" } : { kind: "engineList" })} />
          )}
          {mode && me && (
            <CombatBar
              mode={mode}
              view={view}
              printings={printings}
              members={room.members}
              me={me}
              onPickTarget={(t) => mode.kind === "attack" && setMode({ ...mode, current: t })}
              onPickAttacker={(iid) => mode.kind === "block" && setMode({ ...mode, current: iid })}
              onDeclare={declare}
              onCancel={() => setMode(null)}
              onZoom={holdCard}
            />
          )}
        </PhaseStrip>

        {around && sideLeft && <div className="table-side is-left">{renderChip(sideLeft, true)}</div>}
        {around && sideRight && <div className="table-side is-right">{renderChip(sideRight, true)}</div>}

        {/* ---- middle: my battlefield on my playmat ---- */}
        <div className={`table-mid mat ${myMat.className}${mode ? " is-picking" : ""}${engineMode ? " side-panels" : ""}${engineMode && boardOpen ? " has-board" : ""}${engineMode && logOpen ? " has-log" : ""}`} style={myMat.style}>
          {engineMode && (
            <div className="corner-right">
              {engineMode && sock.notices.length > 0 && (
                <EngineNotices notices={sock.notices} printings={printings} onDismiss={sock.dismissNotice} onCard={(p) => setZoom(printingAsCard(p, me ?? view.turnOrder[0] ?? ""))} />
              )}
              {view.stack.length > 0 && <StackPanel stack={view.stack} view={view} printings={printings} members={room.members} onZoom={holdCard} chain={chain} onOpenChain={() => setChainMin(false)} />}
              <LogToasts log={view.log} active={!logOpen} printings={printings} onCard={(p) => setZoom(printingAsCard(p, me ?? view.turnOrder[0] ?? ""))} />
            </div>
          )}
          {engineMode && boardOpen && <ActiveBoard view={view} printings={printings} members={room.members} me={me} sleeveOf={sleeveOf} onTap={tapCard} onHold={holdCard} onMinimize={closeBoard} />}
          {engineMode && !boardOpen && view.phase === "playing" && <EdgeTab side="left" label="Board" onClick={openBoard} />}
          {engineMode && logOpen && <GameLog log={view.log} members={room.members} printings={printings} onCard={(p) => setZoom(printingAsCard(p, me ?? view.turnOrder[0] ?? ""))} onMinimize={closeLog} />}
          {engineMode && !logOpen && <EdgeTab side="right" label="Log" onClick={openLog} />}
          {mePlayer && myDerived ? (
            <Battlefield
              player={mePlayer}
              printings={printings}
              derived={myDerived}
              onTap={tapCard}
              onHold={engineMode ? engineHold : holdCard}
              onZoom={holdCard}
              draggable={canEdit}
              droppable={canEdit}
              highlighted={highlighted}
              onAnthems={() => setSheet({ kind: "anthems", player: mePlayer })}
              sleeveOf={sleeveOf}
              marks={combatMarks}
              selected={combatSelected}
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
              <button className="zone-btn is-tokens" onClick={() => setShowTokens(true)} disabled={!canEdit} aria-label="Create tokens">
                <span>Token</span>
                <strong>+</strong>
              </button>
            </div>
            <DropRow id="zone:hand" className="hand">
              {mePlayer.hand.cards.length === 0 && <span className="muted small">Empty hand</span>}
              {mePlayer.hand.cards.map((c) => (
                <CardTile key={c.iid} card={c} printings={printings} onTap={tapCard} onHold={engineMode ? engineHold : holdCard} onZoom={holdCard} draggable={canEdit} highlight={highlighted.has(c.iid)} selected={combatSelected.has(c.iid)} />
              ))}
            </DropRow>
            <LifeWidget
              player={mePlayer}
              mine
              readOnly={engineMode}
              onDelta={(d) => sock.dispatch({ type: "LifeChanged", payload: { player: me!, delta: d } })}
              onBig={() => lifeBig(mePlayer)}
              onCounters={() => setSheet({ kind: "player", player: mePlayer })}
            />
          </div>
        )}

        <p className="table-notice">Unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Card data and images courtesy of Scryfall.</p>

        {me && canEdit && <TriggersPanel triggers={view.pendingTriggers} me={me} dispatch={sock.dispatch} />}
        {engineMode && engine?.engineDown && (
          <div className="toast is-warn" role="status">
            Reconnecting to the rules engine...
          </div>
        )}
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
      {chain && !chainMin && !(prompt && prompt.kind !== "priority") && (
        <InteractionStack stack={view.stack} view={view} printings={printings} members={room.members} onZoom={holdCard} prompt={prompt} me={me} answer={answerEngine} onMinimize={() => setChainMin(true)} />
      )}
      {engineMode && prompt && me && (prompt.kind === "mulligan" || (prompt.kind === "chooseMany" && (prompt.reason === "mulligan" || prompt.reason === "putBack"))) && (
        <EngineMulligan prompt={prompt} view={view} printings={printings} me={me} pick={pick} setPick={setPick} answer={answerEngine} onZoom={holdCard} />
      )}
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
              {engineMode && <CoachLink code={room.code} className="btn" />}
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
      {showDamage && <DamageSheet view={view} printings={printings} dispatch={sock.dispatch} onClose={() => setShowDamage(false)} />}
      {dialogState && <DialogView key={dialogState.key} dialog={dialogState.d} onClose={() => setDialog(null)} />}
      {zoom && <CardZoom card={zoom} printings={printings} view={view} sleeve={sleeveOf(zoom.owner)} derived={zoomExtras.derived} attachments={zoomExtras.attachments} actions={zoomActions(zoom, () => setZoom(null))} navigation={zoomNavigation} onClose={() => setZoom(null)} />}
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
          canRevert={canEdit}
          onClose={() => setShowLog(false)}
          onRevert={(seq) =>
            engineMode
              ? undefined
              : setDialog({
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
      {showAgents && <AgentsPanel code={room.code} onClose={() => setShowAgents(false)} />}
      {showStops && engine && (
        <StopsPanel
          stops={engine.stops}
          onSave={(stops) => {
            sock.send({ t: "stops", stops });
            updateSettings({ engineStops: stops }); // remembered for the next table too
          }}
          onClose={() => setShowStops(false)}
        />
      )}
    </DndContext>
  );
}
