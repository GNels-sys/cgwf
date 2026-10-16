import type { CardPrinting } from "../cards.js";
import { nextId, nextInt, seedFromString, shuffle, type RngState } from "./rng.js";
import {
  HAND_SIZE,
  STEPS,
  STEP_LABELS,
  SYSTEM_ACTOR,
  type CardInstance,
  type CustomToken,
  type GameEvent,
  type GameState,
  type MoveTarget,
  type PlayerId,
  type PlayerState,
  type Row,
  type Step,
  type ZoneKind,
} from "./types.js";

/**
 * Pure game reducer. `applyEvent(state, event)` returns a new state or throws
 * GameError when the event is illegal for its actor (the server refuses such
 * events; clients never see them). `replay(events, seed)` rebuilds state from
 * the log, honouring Revert events. Nothing here touches the clock or Math.random.
 */

export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameError";
  }
}

const MAX_LOG = 400;

// ---------------------------------------------------------------- helpers

/**
 * Copy the mutable parts of a state. Printing and custom-token objects are
 * never mutated by the reducer, so they are shared, which keeps a clone cheap
 * even with 400 full card objects in play.
 */
function clone(s: GameState): GameState {
  const cards: Record<string, CardInstance> = {};
  for (const [iid, c] of Object.entries(s.cards)) {
    cards[iid] = {
      ...c,
      zone: { ...c.zone },
      counters: { ...c.counters },
      revealedTo: Array.isArray(c.revealedTo) ? c.revealedTo.slice() : c.revealedTo,
    };
  }
  const players: Record<string, PlayerState> = {};
  for (const [id, p] of Object.entries(s.players)) {
    players[id] = {
      ...p,
      counters: { ...p.counters },
      commanderDamage: { ...p.commanderDamage },
      commanderTax: { ...p.commanderTax },
      zones: {
        library: p.zones.library.slice(),
        hand: p.zones.hand.slice(),
        graveyard: p.zones.graveyard.slice(),
        exile: p.zones.exile.slice(),
        command: p.zones.command.slice(),
        battlefield: {
          lands: p.zones.battlefield.lands.slice(),
          creatures: p.zones.battlefield.creatures.slice(),
          other: p.zones.battlefield.other.slice(),
        },
      },
    };
  }
  return { ...s, cards, players, turnOrder: s.turnOrder.slice(), stack: s.stack.slice(), log: s.log.slice() };
}

function fail(msg: string): never {
  throw new GameError(msg);
}

function player(state: GameState, id: PlayerId): PlayerState {
  return state.players[id] ?? fail("unknown player");
}

function card(state: GameState, iid: string): CardInstance {
  return state.cards[iid] ?? fail("unknown card");
}

function isActor(ev: GameEvent, id: PlayerId): boolean {
  return ev.actor === SYSTEM_ACTOR || ev.actor === id;
}

function requireActor(ev: GameEvent, id: PlayerId, what: string): void {
  if (!isActor(ev, id)) fail(`only ${what} may do that`);
}

function requirePlaying(state: GameState): void {
  if (state.phase === "ended") fail("the game is over");
}

function cardName(c: CardInstance): string {
  if (c.custom) return c.custom.name;
  if (!c.printing) return "a card";
  const face = c.printing.faces[c.face] ?? c.printing.faces[0];
  return face ? face.name : c.printing.name;
}

/** Is the card's identity public right now (so the log may name it)? */
function isPublic(c: CardInstance): boolean {
  if (c.revealedTo === "all") return true;
  if (c.zone.kind === "library" || c.zone.kind === "hand") return false;
  return !c.faceDown;
}

function describe(c: CardInstance, publicBefore: boolean): string {
  return publicBefore || isPublic(c) ? cardName(c) : "a card";
}

function zoneList(p: PlayerState, kind: ZoneKind, row?: Row): string[] {
  if (kind === "battlefield") return p.zones.battlefield[row ?? "other"];
  return p.zones[kind];
}

function removeFromZone(state: GameState, c: CardInstance): void {
  const p = player(state, c.zone.owner);
  const list = zoneList(p, c.zone.kind, c.zone.row);
  const i = list.indexOf(c.iid);
  if (i >= 0) list.splice(i, 1);
}

function zoneLabel(kind: ZoneKind, owner: PlayerState, actorIsOwner: boolean, row?: Row): string {
  const whose = actorIsOwner ? "their" : `${owner.name}'s`;
  switch (kind) {
    case "battlefield":
      return row ? `the battlefield (${row})` : "the battlefield";
    case "command":
      return `${whose} command zone`;
    default:
      return `${whose} ${kind}`;
  }
}

function defaultRow(printing: CardPrinting | null, custom: CustomToken | null): Row {
  const type = (custom?.typeLine ?? printing?.typeLine ?? "").split(" // ")[0] ?? "";
  if (/\bCreature\b/.test(type)) return "creatures";
  if (/\bLand\b/.test(type)) return "lands";
  return "other";
}

function log(state: GameState, ev: GameEvent, text: string): void {
  state.log.push({ seq: ev.seq, actor: ev.actor, text, ts: ev.ts });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

function uniqueId(state: GameState, prefix = "c"): string {
  for (;;) {
    const [id, rng] = nextId(state.rng, prefix);
    state.rng = rng;
    if (!state.cards[id]) return id;
  }
}

function newInstance(state: GameState, owner: PlayerId, printing: CardPrinting | null, custom: CustomToken | null, zone: CardInstance["zone"]): CardInstance {
  const c: CardInstance = {
    iid: uniqueId(state),
    printing,
    custom,
    owner,
    zone,
    tapped: false,
    faceDown: false,
    face: 0,
    counters: {},
    attachedTo: null,
    revealedTo: null,
    isToken: false,
    isCommander: false,
  };
  state.cards[c.iid] = c;
  return c;
}

/** Move a card into a zone. Handles attachments and visibility resets. */
function moveCard(state: GameState, c: CardInstance, to: MoveTarget): void {
  const dest = player(state, to.owner);
  removeFromZone(state, c);

  const row: Row | undefined = to.kind === "battlefield" ? (to.row ?? defaultRow(c.printing, c.custom)) : undefined;
  c.zone = row ? { kind: to.kind, owner: to.owner, row } : { kind: to.kind, owner: to.owner };

  const list = zoneList(dest, to.kind, row);
  if (to.kind === "library") {
    const pos = to.position ?? "top";
    if (pos === "top") list.unshift(c.iid);
    else if (pos === "bottom") list.push(c.iid);
    else list.splice(Math.max(0, Math.min(list.length, Math.floor(pos))), 0, c.iid);
  } else {
    list.push(c.iid);
  }

  c.revealedTo = null;
  c.tapped = false;
  const keepFaceDown = Boolean(to.faceDown) && (to.kind === "battlefield" || to.kind === "exile");
  c.faceDown = keepFaceDown;
  if (to.kind !== "battlefield") {
    c.face = 0;
    c.counters = {};
    c.attachedTo = null;
  }

  // Attachments: follow the host around the battlefield; drop off when it leaves.
  for (const other of Object.values(state.cards)) {
    if (other.attachedTo !== c.iid) continue;
    if (to.kind === "battlefield" && other.zone.kind === "battlefield") {
      if (other.zone.owner !== to.owner || other.zone.row !== row) {
        removeFromZone(state, other);
        other.zone = { kind: "battlefield", owner: to.owner, row: row ?? "other" };
        zoneList(dest, "battlefield", row).push(other.iid);
      }
    } else {
      other.attachedTo = null;
    }
  }

  // Tokens cease to exist outside the battlefield.
  if (c.isToken && to.kind !== "battlefield") {
    removeFromZone(state, c);
    delete state.cards[c.iid];
  }
}

function draw(state: GameState, p: PlayerState, count: number): number {
  let n = 0;
  for (let i = 0; i < count; i++) {
    const iid = p.zones.library.shift();
    if (!iid) break;
    const c = card(state, iid);
    c.zone = { kind: "hand", owner: p.id };
    c.revealedTo = null;
    p.zones.hand.push(iid);
    n++;
  }
  return n;
}

function shuffleLibrary(state: GameState, p: PlayerState): void {
  const [order, rng] = shuffle(p.zones.library, state.rng);
  p.zones.library = order;
  state.rng = rng;
  for (const iid of order) card(state, iid).revealedTo = null;
}

function nextActivePlayer(state: GameState): PlayerId {
  const order = state.turnOrder;
  const start = order.indexOf(state.activePlayer);
  for (let k = 1; k <= order.length; k++) {
    const id = order[(start + k) % order.length] as PlayerId;
    if (!player(state, id).conceded) return id;
  }
  return state.activePlayer;
}

function untapAll(state: GameState, p: PlayerState): number {
  let n = 0;
  for (const row of Object.values(p.zones.battlefield)) {
    for (const iid of row) {
      const c = card(state, iid);
      if (c.tapped) {
        c.tapped = false;
        n++;
      }
    }
  }
  return n;
}

function addReveal(c: CardInstance, who: PlayerId): void {
  if (c.revealedTo === "all") return;
  if (!c.revealedTo) c.revealedTo = [who];
  else if (!c.revealedTo.includes(who)) c.revealedTo.push(who);
}

function checkEnded(state: GameState, ev: GameEvent): void {
  const alive = state.turnOrder.filter((id) => !player(state, id).conceded);
  if (alive.length <= 1 && state.turnOrder.length >= 2) {
    state.phase = "ended";
    state.winner = alive[0] ?? null;
    log(state, ev, state.winner ? `${player(state, state.winner).name} wins the game` : "The game is over");
  }
}

function maybeFinishMulligans(state: GameState, ev: GameEvent): void {
  if (state.phase !== "mulligan") return;
  if (!state.turnOrder.every((id) => player(state, id).kept || player(state, id).conceded)) return;
  state.phase = "playing";
  state.turn = 1;
  state.step = "untap";
  log(state, ev, `Everyone kept. Turn 1: ${player(state, state.activePlayer).name}`);
}

// ---------------------------------------------------------------- start

function start(ev: Extract<GameEvent, { type: "GameStarted" }>, seed: string): GameState {
  const { players, decks, startingLife } = ev.payload;
  if (players.length < 2 || players.length > 4) fail("a game needs 2 to 4 players");
  const sorted = players.slice().sort((a, b) => a.seat - b.seat);
  const state: GameState = {
    format: "commander",
    phase: "mulligan",
    players: {},
    turnOrder: sorted.map((p) => p.id),
    cards: {},
    activePlayer: sorted[0]!.id,
    turn: 0,
    step: "untap",
    stack: [],
    priority: null,
    rng: seedFromString(seed),
    log: [],
    seq: 0,
    winner: null,
  };

  for (const p of sorted) {
    state.players[p.id] = {
      id: p.id,
      name: p.name,
      seat: p.seat,
      life: startingLife,
      counters: {},
      commanderDamage: {},
      commanderTax: {},
      mulligans: 0,
      kept: false,
      toBottom: 0,
      conceded: false,
      zones: { library: [], hand: [], graveyard: [], exile: [], command: [], battlefield: { lands: [], creatures: [], other: [] } },
    };
  }

  for (const p of sorted) {
    const deck = decks[p.id] ?? fail(`no deck for ${p.name}`);
    const ps = state.players[p.id]!;
    for (const printing of deck.library) {
      const c = newInstance(state, p.id, printing, null, { kind: "library", owner: p.id });
      ps.zones.library.push(c.iid);
    }
    for (const printing of deck.commanders) {
      const c = newInstance(state, p.id, printing, null, { kind: "command", owner: p.id });
      c.isCommander = true;
      ps.zones.command.push(c.iid);
      ps.commanderTax[c.iid] = 0;
    }
    shuffleLibrary(state, ps);
    draw(state, ps, HAND_SIZE);
  }

  const [first, rng] = nextInt(state.rng, sorted.length);
  state.rng = rng;
  state.activePlayer = sorted[first]!.id;
  log(state, ev, `Game started with ${sorted.map((p) => p.name).join(", ")}. ${player(state, state.activePlayer).name} goes first. Keep or mulligan?`);
  return state;
}

// ---------------------------------------------------------------- apply

/** Apply one event. Returns a new state; the input is never mutated. */
export function applyEvent(prev: GameState | null, ev: GameEvent, seed: string): GameState {
  if (ev.type === "GameStarted") {
    if (prev) fail("the game has already started");
    const s = start(ev, seed);
    s.seq = ev.seq;
    return s;
  }
  if (!prev) fail("the game has not started");
  if (ev.type === "Revert") fail("Revert is handled by replay()");
  const state = clone(prev);
  state.seq = ev.seq;
  const actorName = ev.actor === SYSTEM_ACTOR ? "The table" : (state.players[ev.actor]?.name ?? "Someone");

  switch (ev.type) {
    case "Mulligan": {
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      if (state.phase !== "mulligan" || p.kept) fail("mulligans are over");
      for (const iid of p.zones.hand.splice(0)) {
        const c = card(state, iid);
        c.zone = { kind: "library", owner: p.id };
        p.zones.library.push(iid);
      }
      shuffleLibrary(state, p);
      draw(state, p, HAND_SIZE);
      p.mulligans++;
      log(state, ev, `${p.name} mulligans (${p.mulligans})`);
      break;
    }
    case "HandKept": {
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      if (state.phase !== "mulligan") fail("mulligans are over");
      p.kept = true;
      p.toBottom = Math.min(p.mulligans, p.zones.hand.length);
      log(state, ev, p.mulligans ? `${p.name} keeps and will put ${p.mulligans} on the bottom` : `${p.name} keeps`);
      maybeFinishMulligans(state, ev);
      break;
    }
    case "CardsDrawn": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const want = Math.max(1, Math.min(50, Math.floor(ev.payload.count)));
      const n = draw(state, p, want);
      log(state, ev, n === want ? `${p.name} draws ${n === 1 ? "a card" : `${n} cards`}` : `${p.name} draws ${n} (library empty)`);
      break;
    }
    case "CardMoved": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      const to = ev.payload.to;
      const dest = player(state, to.owner);
      // Hidden zones belong to their owner: nobody else may touch cards in them or put cards into them.
      if (c.zone.kind === "hand" || c.zone.kind === "library") requireActor(ev, c.zone.owner, "the owner of that hand or library");
      if (to.kind === "hand" || to.kind === "library") requireActor(ev, to.owner, "the owner of that hand or library");
      const publicBefore = isPublic(c);
      const fromKind = c.zone.kind;
      const fromOwner = c.zone.owner;
      const bottoming = fromKind === "hand" && to.kind === "library" && to.position === "bottom" && fromOwner === to.owner && dest.toBottom > 0;
      moveCard(state, c, to);
      if (bottoming) dest.toBottom--;
      const alive = state.cards[c.iid];
      const name = alive ? describe(alive, publicBefore) : cardName(c);
      const toLabel = zoneLabel(to.kind, dest, ev.actor === to.owner, to.kind === "battlefield" ? alive?.zone.row : undefined);
      const fromLabel = zoneLabel(fromKind, player(state, fromOwner), ev.actor === fromOwner);
      if (!alive) log(state, ev, `${actorName} removes token ${name}`);
      else if (to.kind === "library") log(state, ev, `${actorName} puts ${name} on the ${to.position === "bottom" ? "bottom" : "top"} of ${toLabel}`);
      else if (fromKind === "hand" && to.kind === "battlefield") log(state, ev, `${actorName} plays ${name}${to.faceDown ? " face down" : ""}`);
      else log(state, ev, `${actorName} moves ${name} from ${fromLabel} to ${toLabel}${to.faceDown ? " face down" : ""}`);
      break;
    }
    case "CardTapped": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield") fail("only permanents tap");
      c.tapped = ev.payload.tapped;
      log(state, ev, `${actorName} ${c.tapped ? "taps" : "untaps"} ${describe(c, false)}`);
      break;
    }
    case "UntapAll": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      const n = untapAll(state, p);
      log(state, ev, `${actorName} untaps ${n === 1 ? "1 permanent" : `${n} permanents`}${p.id === ev.actor ? "" : ` of ${p.name}'s`}`);
      break;
    }
    case "CardFlipped": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind === "hand" || c.zone.kind === "library") requireActor(ev, c.zone.owner, "the owner");
      if (!c.printing || c.printing.faces.length < 2) fail("that card has only one face");
      c.face = c.face === 0 ? 1 : 0;
      log(state, ev, `${actorName} transforms ${describe(c, false)}`);
      break;
    }
    case "CardTurned": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield" && c.zone.kind !== "exile") fail("only cards on the battlefield or in exile turn face down");
      const publicBefore = isPublic(c);
      c.faceDown = ev.payload.faceDown;
      if (!c.faceDown) c.revealedTo = null;
      log(state, ev, c.faceDown ? `${actorName} turns ${describe(c, publicBefore)} face down` : `${actorName} turns ${describe(c, false)} face up`);
      break;
    }
    case "CardRevealed": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      requireActor(ev, c.zone.owner, "the owner");
      c.revealedTo = "all";
      log(state, ev, `${actorName} reveals ${cardName(c)}${c.zone.kind === "hand" ? " from their hand" : ""}`);
      break;
    }
    case "CounterChanged": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield") fail("counters go on permanents");
      const kind = ev.payload.kind.trim().slice(0, 24);
      if (!kind) fail("counter needs a name");
      const delta = Math.trunc(ev.payload.delta);
      const next = Math.max(0, (c.counters[kind] ?? 0) + delta);
      if (next === 0) delete c.counters[kind];
      else c.counters[kind] = next;
      log(state, ev, `${actorName} ${delta >= 0 ? "adds" : "removes"} ${Math.abs(delta)} ${kind} counter${Math.abs(delta) === 1 ? "" : "s"} ${delta >= 0 ? "to" : "from"} ${describe(c, false)} (now ${next})`);
      break;
    }
    case "LifeChanged": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      const before = p.life;
      if (typeof ev.payload.value === "number") p.life = Math.trunc(ev.payload.value);
      else p.life += Math.trunc(ev.payload.delta ?? 0);
      const d = p.life - before;
      log(state, ev, `${p.name}${p.id === ev.actor ? "" : ` (by ${actorName})`}: life ${before} → ${p.life} (${d >= 0 ? "+" : ""}${d})`);
      break;
    }
    case "PlayerCounterChanged": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      const kind = ev.payload.kind.trim().slice(0, 24);
      if (!kind) fail("counter needs a name");
      const next = Math.max(0, (p.counters[kind] ?? 0) + Math.trunc(ev.payload.delta));
      if (next === 0) delete p.counters[kind];
      else p.counters[kind] = next;
      log(state, ev, `${p.name}: ${kind} ${next}`);
      break;
    }
    case "CommanderDamage": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      const cmd = card(state, ev.payload.commanderIid);
      if (!cmd.isCommander) fail("not a commander");
      const next = Math.max(0, (p.commanderDamage[cmd.iid] ?? 0) + Math.trunc(ev.payload.delta));
      p.commanderDamage[cmd.iid] = next;
      log(state, ev, `${p.name} has taken ${next} from ${cardName(cmd)}`);
      break;
    }
    case "CommanderTaxChanged": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      const cmd = card(state, ev.payload.commanderIid);
      if (!cmd.isCommander || cmd.owner !== p.id) fail("not that player's commander");
      const next = Math.max(0, (p.commanderTax[cmd.iid] ?? 0) + Math.trunc(ev.payload.delta));
      p.commanderTax[cmd.iid] = next;
      log(state, ev, `${cardName(cmd)} now costs ${next} more`);
      break;
    }
    case "LibraryShuffled": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "the owner");
      shuffleLibrary(state, p);
      log(state, ev, `${p.name} shuffles their library`);
      break;
    }
    case "LibraryRevealed": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "the owner");
      const n = Math.max(1, Math.min(20, Math.floor(ev.payload.count)));
      const names: string[] = [];
      for (const iid of p.zones.library.slice(0, n)) {
        const c = card(state, iid);
        c.revealedTo = "all";
        names.push(cardName(c));
      }
      log(state, ev, `${p.name} reveals the top of their library: ${names.join(", ") || "(empty)"}`);
      break;
    }
    case "LibraryLooked": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "the owner");
      const n = Math.max(1, Math.min(50, Math.floor(ev.payload.count)));
      for (const iid of p.zones.library.slice(0, n)) addReveal(card(state, iid), p.id);
      log(state, ev, `${p.name} looks at the top ${n === 1 ? "card" : `${n} cards`} of their library`);
      break;
    }
    case "LibrarySearched": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "the owner");
      for (const iid of p.zones.library) addReveal(card(state, iid), p.id);
      log(state, ev, `${p.name} searches their library`);
      break;
    }
    case "Milled": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "the owner");
      const n = Math.max(1, Math.min(50, Math.floor(ev.payload.count)));
      const names: string[] = [];
      for (let i = 0; i < n; i++) {
        const iid = p.zones.library.shift();
        if (!iid) break;
        const c = card(state, iid);
        c.zone = { kind: "graveyard", owner: p.id };
        c.revealedTo = null;
        p.zones.graveyard.push(iid);
        names.push(cardName(c));
      }
      log(state, ev, `${p.name} mills ${names.length}: ${names.join(", ") || "(empty)"}`);
      break;
    }
    case "TokenCreated": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      const { printing, custom } = ev.payload;
      if (!printing && !custom) fail("token needs a printing or a description");
      const count = Math.max(1, Math.min(20, Math.floor(ev.payload.count)));
      const row = ev.payload.row;
      for (let i = 0; i < count; i++) {
        const c = newInstance(state, p.id, printing, custom, { kind: "battlefield", owner: p.id, row });
        c.isToken = true;
        p.zones.battlefield[row].push(c.iid);
      }
      log(state, ev, `${actorName} creates ${count} ${custom?.name ?? printing?.name ?? "token"} token${count === 1 ? "" : "s"}${p.id === ev.actor ? "" : ` for ${p.name}`}`);
      break;
    }
    case "CardCopied": {
      requirePlaying(state);
      const src = card(state, ev.payload.iid);
      if (src.zone.kind !== "battlefield") fail("only permanents can be copied");
      const p = player(state, ev.payload.player);
      const row = src.zone.row ?? "other";
      const c = newInstance(state, p.id, src.printing, src.custom, { kind: "battlefield", owner: p.id, row });
      c.isToken = true;
      c.face = src.face;
      p.zones.battlefield[row].push(c.iid);
      log(state, ev, `${actorName} creates a token copy of ${describe(src, false)}`);
      break;
    }
    case "Attached": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield") fail("only permanents attach");
      if (ev.payload.to) {
        const host = card(state, ev.payload.to);
        if (host.zone.kind !== "battlefield") fail("the host must be on the battlefield");
        if (host.iid === c.iid || host.attachedTo === c.iid) fail("cannot attach a card to itself");
        c.attachedTo = host.iid;
        // Sit next to the host so the client can draw it underneath.
        if (host.zone.owner !== c.zone.owner || host.zone.row !== c.zone.row) {
          removeFromZone(state, c);
          c.zone = { kind: "battlefield", owner: host.zone.owner, row: host.zone.row ?? "other" };
          zoneList(player(state, host.zone.owner), "battlefield", host.zone.row).push(c.iid);
        }
        log(state, ev, `${actorName} attaches ${describe(c, false)} to ${describe(host, false)}`);
      } else {
        c.attachedTo = null;
        log(state, ev, `${actorName} unattaches ${describe(c, false)}`);
      }
      break;
    }
    case "TurnAdvanced": {
      requirePlaying(state);
      if (state.phase !== "playing") fail("the game has not started");
      state.activePlayer = nextActivePlayer(state);
      state.turn++;
      state.step = "untap";
      const p = player(state, state.activePlayer);
      const n = untapAll(state, p);
      log(state, ev, `Turn ${state.turn}: ${p.name}${n ? ` (untapped ${n})` : ""}`);
      break;
    }
    case "StepAdvanced": {
      requirePlaying(state);
      if (state.phase !== "playing") fail("the game has not started");
      const i = STEPS.indexOf(state.step);
      if (i >= STEPS.length - 1) {
        state.activePlayer = nextActivePlayer(state);
        state.turn++;
        state.step = "untap";
        const p = player(state, state.activePlayer);
        const n = untapAll(state, p);
        log(state, ev, `Turn ${state.turn}: ${p.name}${n ? ` (untapped ${n})` : ""}`);
      } else {
        state.step = STEPS[i + 1] as Step;
        log(state, ev, `${STEP_LABELS[state.step]}`);
      }
      break;
    }
    case "StepSet": {
      requirePlaying(state);
      state.step = ev.payload.step;
      log(state, ev, `${actorName} moves to ${STEP_LABELS[state.step]}`);
      break;
    }
    case "DiceRolled": {
      const sides = Math.max(2, Math.min(100, Math.floor(ev.payload.sides)));
      const count = Math.max(1, Math.min(10, Math.floor(ev.payload.count ?? 1)));
      const rolls: number[] = [];
      for (let i = 0; i < count; i++) {
        const [v, rng] = nextInt(state.rng, sides);
        state.rng = rng;
        rolls.push(v + 1);
      }
      log(state, ev, `${actorName} rolls ${count > 1 ? `${count}d${sides}: ${rolls.join(" + ")} = ${rolls.reduce((a, b) => a + b, 0)}` : `a d${sides}: ${rolls[0]}`}`);
      break;
    }
    case "CoinFlipped": {
      const [v, rng] = nextInt(state.rng, 2);
      state.rng = rng;
      log(state, ev, `${actorName} flips a coin: ${v === 0 ? "heads" : "tails"}`);
      break;
    }
    case "RandomOpponent": {
      const p = player(state, ev.payload.player);
      const others = state.turnOrder.filter((id) => id !== p.id && !player(state, id).conceded);
      if (!others.length) fail("no opponents left");
      const [i, rng] = nextInt(state.rng, others.length);
      state.rng = rng;
      log(state, ev, `${p.name} picks a random opponent: ${player(state, others[i]!).name}`);
      break;
    }
    case "PlayerConceded": {
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      if (p.conceded) fail("already conceded");
      p.conceded = true;
      p.kept = true;
      log(state, ev, `${p.name} concedes`);
      if (state.activePlayer === p.id && state.phase === "playing") {
        state.activePlayer = nextActivePlayer(state);
      }
      maybeFinishMulligans(state, ev);
      checkEnded(state, ev);
      break;
    }
    default: {
      const never: never = ev;
      fail(`unknown event ${(never as { type: string }).type}`);
    }
  }
  return state;
}

/**
 * Rebuild state from the whole log. A Revert event rewinds to just after
 * `toSeq` (events are 1-based and contiguous) and later events continue from
 * there; nested reverts work because the prefix is replayed the same way.
 */
export function replay(events: readonly GameEvent[], seed: string): GameState | null {
  let state: GameState | null = null;
  for (const ev of events) {
    if (ev.type === "Revert") {
      const to = Math.max(0, Math.min(ev.seq - 1, Math.floor(ev.payload.toSeq)));
      state = replay(events.slice(0, to), seed);
      if (state) {
        state = clone(state);
        state.seq = ev.seq;
        const who = ev.actor === SYSTEM_ACTOR ? "The table" : (state.players[ev.actor]?.name ?? "Someone");
        log(state, ev, `${who} ${ev.payload.reason === "undo" ? "undoes their last action" : `reverts the game to #${to}`}`);
      }
      continue;
    }
    state = applyEvent(state, ev, seed);
  }
  return state;
}

/** Names a card for UI/log purposes (front face unless transformed). */
export function instanceName(c: CardInstance): string {
  return cardName(c);
}
