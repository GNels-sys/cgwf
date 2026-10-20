import type { CardPrinting } from "../cards.js";
import { nextId, nextInt, seedFromString, shuffle, type RngState } from "./rng.js";
import { defaultSection } from "./sections.js";
import { detectTriggers } from "./triggers.js";
import { derivedCard, derivedFor, hasKeyword, isPlaneswalkerOrBattle, lethalCards, proposeCombatDamage, typeLineOf } from "./combat.js";
import { detectWinConditions } from "./wincons.js";
import {
  EMPTY_MANA,
  HAND_SIZE,
  MANA_COLORS,
  SECTIONS,
  STEPS,
  STEP_LABELS,
  SYSTEM_ACTOR,
  isOut,
  type Battlefield,
  type CardInstance,
  type CombatState,
  type CustomToken,
  type DamageAssignment,
  type EliminationCause,
  type GameEvent,
  type GameState,
  type ManaColor,
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
      effect: c.effect ? { ...c.effect, keywords: c.effect.keywords.slice() } : null,
      modifier: c.modifier ? { ...c.modifier, keywords: c.modifier.keywords.slice(), removedKeywords: c.modifier.removedKeywords.slice() } : null,
    };
  }
  const players: Record<string, PlayerState> = {};
  for (const [id, p] of Object.entries(s.players)) {
    players[id] = {
      ...p,
      counters: { ...p.counters },
      commanderDamage: { ...p.commanderDamage },
      commanderTax: { ...p.commanderTax },
      mana: { ...p.mana },
      manualAnthems: p.manualAnthems.map((a) => ({ ...a, keywords: a.keywords.slice() })),
      zones: {
        library: p.zones.library.slice(),
        hand: p.zones.hand.slice(),
        graveyard: p.zones.graveyard.slice(),
        exile: p.zones.exile.slice(),
        command: p.zones.command.slice(),
        battlefield: emptyBattlefield(p.zones.battlefield),
      },
    };
  }
  const combat: CombatState | null = s.combat
    ? {
        ...s.combat,
        attackers: s.combat.attackers.map((a) => ({ ...a })),
        blockers: s.combat.blockers.map((b) => ({ ...b })),
        blockersDeclared: s.combat.blockersDeclared.slice(),
        tappedByAttack: s.combat.tappedByAttack.slice(),
      }
    : null;
  return {
    ...s,
    cards,
    players,
    turnOrder: s.turnOrder.slice(),
    stack: s.stack.slice(),
    log: s.log.slice(),
    pendingTriggers: s.pendingTriggers.slice(),
    combat,
    winAdvisories: s.winAdvisories.slice(),
    dismissedWins: s.dismissedWins.slice(),
  };
}

function emptyBattlefield(from?: Battlefield): Battlefield {
  const out = {} as Battlefield;
  for (const sec of SECTIONS) out[sec] = from ? from[sec].slice() : [];
  return out;
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

/**
 * Ownership guardrail: a card on the battlefield belongs to its controller
 * (zone.owner); a card in a graveyard, exile or command zone to that zone's
 * owner. Only they (or the table itself) may tap, move, flip, counter or attach it.
 */
function requireController(ev: GameEvent, c: CardInstance): void {
  if (isActor(ev, c.zone.owner)) return;
  if (c.zone.kind === "battlefield") fail("only the controller of that permanent may do that");
  if (c.zone.kind === "hand" || c.zone.kind === "library") fail("only the owner of that hand or library may do that");
  fail("only the owner of that card may do that");
}

function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
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

function defaultRow(printing: CardPrinting | null, custom: CustomToken | null, face: 0 | 1 = 0): Row {
  const f = printing ? (printing.faces[face] ?? printing.faces[0]) : undefined;
  return defaultSection(custom?.typeLine ?? f?.typeLine ?? printing?.typeLine ?? "");
}

/** Put an unattached card back in its default section (equipment -> artifacts, auras -> enchantments). */
function reSection(state: GameState, c: CardInstance): void {
  if (c.zone.kind !== "battlefield") return;
  const row = defaultRow(c.printing, c.custom, c.face);
  if (c.zone.row === row) return;
  removeFromZone(state, c);
  c.zone = { kind: "battlefield", owner: c.zone.owner, row };
  zoneList(player(state, c.zone.owner), "battlefield", row).push(c.iid);
}

function manaString(color: ManaColor, n: number): string {
  return color.repeat(Math.max(1, n));
}

function emptyMana(state: GameState, ev: GameEvent, reason: string): void {
  for (const p of Object.values(state.players)) {
    const total = MANA_COLORS.reduce((n, c) => n + p.mana[c], 0);
    if (!total || p.keepMana) continue;
    p.mana = { ...EMPTY_MANA };
    log(state, ev, `${p.name}'s mana emptied (${reason})`);
  }
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
    effect: null,
    modifier: null,
    anthemDismissed: false,
  };
  state.cards[c.iid] = c;
  return c;
}

/** Move a card into a zone. Handles attachments and visibility resets. */
function moveCard(state: GameState, c: CardInstance, to: MoveTarget): void {
  const dest = player(state, to.owner);
  removeFromZone(state, c);

  const row: Row | undefined = to.kind === "battlefield" ? (to.row ?? defaultRow(c.printing, c.custom, c.face)) : undefined;
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
    c.effect = null;
    c.modifier = null;
    c.anthemDismissed = false;
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
      other.effect = null;
      reSection(state, other);
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
    if (!isOut(player(state, id))) return id;
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
  if (state.phase === "ended") return;
  const alive = state.turnOrder.filter((id) => !isOut(player(state, id)));
  if (alive.length <= 1 && state.turnOrder.length >= 2) {
    state.phase = "ended";
    state.winner = alive[0] ?? null;
    log(state, ev, state.winner ? `${player(state, state.winner).name} won the game` : "The game is over");
  }
}

/**
 * Automatic eliminations: 0 life, 10 poison, 21 damage from one commander. Derived
 * from the totals after every event, so a revert (or a corrected life total) brings
 * the player straight back; the log says so either way.
 */
function checkEliminations(state: GameState, ev: GameEvent): void {
  if (state.phase !== "playing") return;
  for (const id of state.turnOrder) {
    const p = player(state, id);
    if (p.conceded) continue;
    let cause: EliminationCause | null = null;
    let detail = "";
    if (p.life <= 0) {
      cause = "life";
      detail = `${p.life} life`;
    } else if ((p.counters.poison ?? 0) >= 10) {
      cause = "poison";
      detail = `${p.counters.poison} poison`;
    } else {
      const hit = Object.entries(p.commanderDamage).find(([, n]) => n >= 21);
      if (hit) {
        cause = "commander damage";
        const cmd = state.cards[hit[0]];
        detail = `${hit[1]} damage from ${cmd ? cardName(cmd) : "a commander"}`;
      }
    }
    if (cause && !p.eliminated) {
      p.eliminated = cause;
      log(state, ev, `${p.name} is out of the game: ${detail} (revert if that was a mistake)`);
      if (state.activePlayer === p.id) state.activePlayer = nextActivePlayer(state);
    } else if (!cause && p.eliminated) {
      p.eliminated = null;
      log(state, ev, `${p.name} is back in the game`);
    }
  }
}

function maybeFinishMulligans(state: GameState, ev: GameEvent): void {
  if (state.phase !== "mulligan") return;
  if (!state.turnOrder.every((id) => player(state, id).kept || player(state, id).conceded)) return;
  state.phase = "playing";
  state.turn = 1;
  state.step = "upkeep";
  state.drewForTurn = false;
  log(state, ev, `Everyone kept. Turn 1: ${player(state, state.activePlayer).name} goes first`);
}

/** The next player's turn begins: untap everything they control (logged), land on upkeep so its triggers surface. */
function beginTurn(state: GameState, ev: GameEvent): void {
  resolvePendingCombat(state, ev);
  state.activePlayer = nextActivePlayer(state);
  state.turn++;
  state.step = "upkeep";
  state.drewForTurn = false;
  state.combat = null;
  state.pendingTriggers = [];
  const p = player(state, state.activePlayer);
  log(state, ev, `Turn ${state.turn}: ${p.name}'s turn`);
  const n = untapAll(state, p);
  if (n) log(state, ev, `${p.name}'s permanents untapped (${n})`);
  emptyMana(state, ev, "new turn");
}

/**
 * What happens automatically when the step changes: the turn's draw once the
 * draw step is reached or passed, and combat damage once the damage step is
 * reached or passed with attackers declared and damage not yet dealt.
 */
function afterStepChange(state: GameState, ev: GameEvent): void {
  if (state.phase !== "playing") return;
  const i = stepIndex(state.step);
  if (!state.drewForTurn && i >= stepIndex("draw")) {
    state.drewForTurn = true;
    const p = player(state, state.activePlayer);
    const n = draw(state, p, 1);
    log(state, ev, n ? `${p.name} drew for the turn` : `${p.name} could not draw for the turn (library empty)`);
  }
  if (i >= stepIndex("damage")) resolvePendingCombat(state, ev);
  if (state.combat && state.combat.damageDealt && i >= stepIndex("endCombat")) state.combat = null;
}

/** Attackers were declared but damage was never assigned: apply the default proposal. */
function resolvePendingCombat(state: GameState, ev: GameEvent): void {
  const combat = state.combat;
  if (!combat || combat.damageDealt || combat.attackers.length === 0) return;
  applyCombatDamage(state, ev, proposeCombatDamage(state), true);
}

function targetLabel(state: GameState, t: DamageAssignment["target"]): string {
  if (t.kind === "player") return player(state, t.player).name;
  const c = state.cards[t.iid];
  return c ? describe(c, false) : "a card";
}

function applyCombatDamage(state: GameState, ev: GameEvent, assignments: DamageAssignment[], automatic: boolean): void {
  const combat = state.combat;
  if (!combat) return;
  const attacker = player(state, combat.attacker);
  const lines: string[] = [];
  for (const a of assignments) {
    if (a.amount <= 0) continue;
    const src = state.cards[a.source];
    if (!src || src.zone.kind !== "battlefield") continue;
    const stats = derivedCard(state, src);
    const srcName = describe(src, false);
    if (a.target.kind === "player") {
      const victim = player(state, a.target.player);
      const infect = hasKeyword(stats, "infect");
      if (infect) {
        victim.counters.poison = (victim.counters.poison ?? 0) + a.amount;
        lines.push(`${srcName} gave ${victim.name} ${a.amount} poison (now ${victim.counters.poison})`);
      } else {
        victim.life -= a.amount;
        lines.push(`${srcName} dealt ${a.amount} to ${victim.name} (now ${victim.life})`);
      }
      const toxicN = hasKeyword(stats, "toxic") ? Number(textOf(src).match(/\btoxic (\d+)/i)?.[1] ?? 1) || 1 : 0;
      if (toxicN) {
        victim.counters.poison = (victim.counters.poison ?? 0) + toxicN;
        lines.push(`${victim.name} got ${toxicN} poison from toxic (now ${victim.counters.poison})`);
      }
      if (src.isCommander) {
        victim.commanderDamage[src.iid] = (victim.commanderDamage[src.iid] ?? 0) + a.amount;
        lines.push(`${victim.name} has taken ${victim.commanderDamage[src.iid]} from ${srcName} in total`);
      }
    } else {
      const target = state.cards[a.target.iid];
      if (!target || target.zone.kind !== "battlefield") continue;
      const tName = describe(target, false);
      if (isPlaneswalkerOrBattle(target)) {
        const kind = /\bbattle\b/.test(typeLineOf(target)) ? "defense" : "loyalty";
        const next = Math.max(0, (target.counters[kind] ?? 0) - a.amount);
        if (next === 0) delete target.counters[kind];
        else target.counters[kind] = next;
        lines.push(`${srcName} dealt ${a.amount} to ${tName} (${kind} now ${next})`);
      } else {
        lines.push(`${srcName} dealt ${a.amount} to ${tName}`);
      }
    }
    if (hasKeyword(stats, "lifelink")) {
      const controller = player(state, src.zone.owner);
      controller.life += a.amount;
      lines.push(`${controller.name} gained ${a.amount} from lifelink (now ${controller.life})`);
    }
  }
  combat.damageDealt = true;
  if (stepIndex(state.step) < stepIndex("damage")) state.step = "damage";
  log(state, ev, `${attacker.name}'s combat damage${automatic ? " (default assignment)" : ""}: ${lines.length ? lines.join("; ") : "none"}`);
  const lethal = lethalCards(state, assignments).map((iid) => describe(card(state, iid), false));
  if (lethal.length) log(state, ev, `Lethal damage on ${lethal.join(", ")}: move them to the graveyard unless something saves them`);
}

function textOf(c: CardInstance): string {
  const p = c.printing;
  const face = p ? (p.faces[c.face] ?? p.faces[0]) : undefined;
  return c.custom?.text ?? face?.oracleText ?? p?.oracleText ?? "";
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
    pendingTriggers: [],
    drewForTurn: false,
    combat: null,
    winAdvisories: [],
    dismissedWins: [],
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
      eliminated: null,
      zones: { library: [], hand: [], graveyard: [], exile: [], command: [], battlefield: emptyBattlefield() },
      mana: { ...EMPTY_MANA },
      keepMana: false,
      manualAnthems: [],
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
  // Spectators (anyone not seated in this game) act on nothing.
  if (ev.actor !== SYSTEM_ACTOR && !prev.players[ev.actor]) fail("spectators cannot act");
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
      log(state, ev, `${p.name} took a mulligan (${p.mulligans})`);
      break;
    }
    case "HandKept": {
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      if (state.phase !== "mulligan") fail("mulligans are over");
      p.kept = true;
      p.toBottom = Math.min(p.mulligans, p.zones.hand.length);
      log(state, ev, p.mulligans ? `${p.name} kept and will put ${p.mulligans} on the bottom` : `${p.name} kept their hand`);
      maybeFinishMulligans(state, ev);
      break;
    }
    case "CardsDrawn": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const want = Math.max(1, Math.min(50, Math.floor(ev.payload.count)));
      const n = draw(state, p, want);
      log(state, ev, n === want ? `${p.name} drew ${n === 1 ? "a card" : `${n} cards`}` : `${p.name} drew ${n} (library empty)`);
      break;
    }
    case "CardMoved": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      const to = ev.payload.to;
      const dest = player(state, to.owner);
      // Only the controller (battlefield) or owner (any other zone) moves a card; nobody puts cards into another player's hand or library.
      requireController(ev, c);
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
      if (!alive) log(state, ev, `${actorName} removed the ${name} token`);
      else if (to.kind === "library") log(state, ev, `${actorName} put ${name} on the ${to.position === "bottom" ? "bottom" : "top"} of ${toLabel}`);
      else if (fromKind === "hand" && to.kind === "battlefield") log(state, ev, `${actorName} played ${name}${to.faceDown ? " face down" : ""}`);
      else if (fromKind === "battlefield" && to.kind === "battlefield" && fromOwner !== to.owner) log(state, ev, `${actorName} gave control of ${name} to ${dest.name}`);
      else log(state, ev, `${actorName} moved ${name} from ${fromLabel} to ${toLabel}${to.faceDown ? " face down" : ""}`);
      break;
    }
    case "ControlTaken": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (ev.actor === SYSTEM_ACTOR) fail("a player must take control");
      if (c.zone.kind === "hand" || c.zone.kind === "library" || c.zone.kind === "command") fail("that card is not on the table");
      if (c.zone.owner === ev.actor) fail("you already control that card");
      const from = player(state, c.zone.owner);
      const fromKind = c.zone.kind;
      const publicBefore = isPublic(c);
      const row = ev.payload.row ?? defaultRow(c.printing, c.custom, c.face);
      moveCard(state, c, { kind: "battlefield", owner: ev.actor, row, faceDown: c.faceDown });
      const name = describe(card(state, c.iid), publicBefore);
      log(state, ev, `${actorName} took control of ${name} from ${from.name}${fromKind === "battlefield" ? "" : `'s ${fromKind}`}`);
      break;
    }
    case "CardTapped": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield") fail("only permanents tap");
      requireController(ev, c);
      c.tapped = ev.payload.tapped;
      log(state, ev, `${actorName} ${c.tapped ? "tapped" : "untapped"} ${describe(c, false)}`);
      break;
    }
    case "UntapAll": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const n = untapAll(state, p);
      log(state, ev, `${actorName} untapped ${n === 1 ? "1 permanent" : `${n} permanents`}`);
      break;
    }
    case "CardFlipped": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      requireController(ev, c);
      if (!c.printing || c.printing.faces.length < 2) fail("that card has only one face");
      c.face = c.face === 0 ? 1 : 0;
      log(state, ev, `${actorName} transformed ${describe(c, false)}`);
      break;
    }
    case "CardTurned": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield" && c.zone.kind !== "exile") fail("only cards on the battlefield or in exile turn face down");
      requireController(ev, c);
      const publicBefore = isPublic(c);
      c.faceDown = ev.payload.faceDown;
      if (!c.faceDown) c.revealedTo = null;
      log(state, ev, c.faceDown ? `${actorName} turned ${describe(c, publicBefore)} face down` : `${actorName} turned ${describe(c, false)} face up`);
      break;
    }
    case "CardRevealed": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      requireActor(ev, c.zone.owner, "the owner");
      c.revealedTo = "all";
      log(state, ev, `${actorName} revealed ${cardName(c)}${c.zone.kind === "hand" ? " from their hand" : ""}`);
      break;
    }
    case "CounterChanged": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield") fail("counters go on permanents");
      requireController(ev, c);
      const kind = ev.payload.kind.trim().slice(0, 24);
      if (!kind) fail("counter needs a name");
      const delta = Math.trunc(ev.payload.delta);
      const next = Math.max(0, (c.counters[kind] ?? 0) + delta);
      if (next === 0) delete c.counters[kind];
      else c.counters[kind] = next;
      const howMany = Math.abs(delta) === 1 ? `a ${kind} counter` : `${Math.abs(delta)} ${kind} counters`;
      log(state, ev, `${actorName} ${delta >= 0 ? "put" : "removed"} ${howMany} ${delta >= 0 ? "on" : "from"} ${describe(c, false)} (now ${next})`);
      break;
    }
    case "LifeChanged": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      const before = p.life;
      if (typeof ev.payload.value === "number") p.life = Math.trunc(ev.payload.value);
      else p.life += Math.trunc(ev.payload.delta ?? 0);
      const d = p.life - before;
      const by = p.id === ev.actor ? "" : ` (by ${actorName})`;
      if (d === 0) log(state, ev, `${p.name}${by} set their life to ${p.life}`);
      else log(state, ev, `${p.name}${by} ${d > 0 ? "gained" : "lost"} ${Math.abs(d)} life (now ${p.life})`);
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
      const dlt = Math.trunc(ev.payload.delta);
      log(state, ev, `${p.name} ${dlt >= 0 ? "got" : "lost"} ${Math.abs(dlt)} ${kind} (now ${next})`);
      break;
    }
    case "CommanderDamage": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      const cmd = card(state, ev.payload.commanderIid);
      if (!cmd.isCommander) fail("not a commander");
      if (!isActor(ev, p.id) && ev.actor !== cmd.owner) fail("only that player or the commander's owner may record commander damage");
      const next = Math.max(0, (p.commanderDamage[cmd.iid] ?? 0) + Math.trunc(ev.payload.delta));
      p.commanderDamage[cmd.iid] = next;
      log(state, ev, `${p.name} has taken ${next} damage from ${cardName(cmd)} in total`);
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
      log(state, ev, `${p.name} shuffled their library`);
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
      log(state, ev, `${p.name} revealed the top of their library: ${names.join(", ") || "(empty)"}`);
      break;
    }
    case "LibraryLooked": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "the owner");
      const n = Math.max(1, Math.min(50, Math.floor(ev.payload.count)));
      for (const iid of p.zones.library.slice(0, n)) addReveal(card(state, iid), p.id);
      log(state, ev, `${p.name} looked at the top ${n === 1 ? "card" : `${n} cards`} of their library`);
      break;
    }
    case "LibrarySearched": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "the owner");
      for (const iid of p.zones.library) addReveal(card(state, iid), p.id);
      log(state, ev, `${p.name} searched their library`);
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
      log(state, ev, `${p.name} milled ${names.length}: ${names.join(", ") || "(empty)"}`);
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
      const tokenName = custom?.name ?? printing?.name ?? "token";
      log(state, ev, `${actorName} created ${count === 1 ? `a ${tokenName} token` : `${count} ${tokenName} tokens`}${p.id === ev.actor ? "" : ` for ${p.name}`}`);
      break;
    }
    case "CardCopied": {
      requirePlaying(state);
      const src = card(state, ev.payload.iid);
      if (src.zone.kind !== "battlefield") fail("only permanents can be copied");
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "the player receiving the copy");
      const row = src.zone.row ?? "other";
      const c = newInstance(state, p.id, src.printing, src.custom, { kind: "battlefield", owner: p.id, row });
      c.isToken = true;
      c.face = src.face;
      p.zones.battlefield[row].push(c.iid);
      log(state, ev, `${actorName} created a token copy of ${describe(src, false)}`);
      break;
    }
    case "Attached": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield") fail("only permanents attach");
      requireController(ev, c);
      if (ev.payload.to) {
        const host = card(state, ev.payload.to);
        if (host.zone.kind !== "battlefield") fail("the host must be on the battlefield");
        if (host.iid === c.iid || host.attachedTo === c.iid) fail("cannot attach a card to itself");
        c.attachedTo = host.iid;
        if (ev.payload.effect !== undefined) c.effect = ev.payload.effect ? cleanEffect(ev.payload.effect) : null;
        // Sit next to the host so the client can draw it underneath.
        if (host.zone.owner !== c.zone.owner || host.zone.row !== c.zone.row) {
          removeFromZone(state, c);
          c.zone = { kind: "battlefield", owner: host.zone.owner, row: host.zone.row ?? "other" };
          zoneList(player(state, host.zone.owner), "battlefield", host.zone.row).push(c.iid);
        }
        log(state, ev, `${actorName} attached ${describe(c, false)} to ${describe(host, false)}${c.effect ? ` (${effectText(c.effect)})` : ""}`);
      } else {
        c.attachedTo = null;
        c.effect = null;
        reSection(state, c);
        log(state, ev, `${actorName} unattached ${describe(c, false)}`);
      }
      break;
    }
    case "AttachmentEffectSet": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (!c.attachedTo) fail("that card is not attached");
      requireController(ev, c);
      c.effect = ev.payload.effect ? cleanEffect(ev.payload.effect) : null;
      log(state, ev, `${actorName} set ${describe(c, false)} to grant ${c.effect ? effectText(c.effect) : "nothing"}`);
      break;
    }
    case "CardModifierSet": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      if (c.zone.kind !== "battlefield") fail("only permanents take modifiers");
      requireController(ev, c);
      const m = ev.payload.modifier;
      c.modifier = m ? { power: Math.trunc(m.power) || 0, toughness: Math.trunc(m.toughness) || 0, keywords: cleanKeywords(m.keywords), removedKeywords: cleanKeywords(m.removedKeywords) } : null;
      log(state, ev, `${actorName} adjusted ${describe(c, false)}: ${c.modifier ? effectText(c.modifier, c.modifier.removedKeywords) : "cleared"}`);
      break;
    }
    case "AnthemDismissed": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      requireController(ev, c);
      c.anthemDismissed = Boolean(ev.payload.dismissed);
      log(state, ev, `${actorName} ${c.anthemDismissed ? "hid" : "restored"} the anthem from ${describe(c, false)}`);
      break;
    }
    case "ManualAnthemAdded": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const id = uniqueId(state, "a");
      const anthem = { id, power: Math.trunc(ev.payload.power) || 0, toughness: Math.trunc(ev.payload.toughness) || 0, keywords: cleanKeywords(ev.payload.keywords), note: String(ev.payload.note ?? "").slice(0, 60) };
      p.manualAnthems.push(anthem);
      log(state, ev, `${actorName} added an anthem for ${p.id === ev.actor ? "their" : `${p.name}'s`} creatures: ${effectText(anthem)}${anthem.note ? ` (${anthem.note})` : ""}`);
      break;
    }
    case "ManualAnthemRemoved": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const i = p.manualAnthems.findIndex((a) => a.id === ev.payload.id);
      if (i < 0) fail("no such anthem");
      const [gone] = p.manualAnthems.splice(i, 1);
      log(state, ev, `${actorName} removed the anthem ${gone?.note || effectText(gone!)}`);
      break;
    }
    case "TriggerResolved": {
      const i = state.pendingTriggers.findIndex((t) => t.id === ev.payload.id);
      if (i < 0) fail("that trigger is gone");
      requireActor(ev, state.pendingTriggers[i]!.controller, "the controller of that trigger");
      const [t] = state.pendingTriggers.splice(i, 1);
      log(state, ev, `${actorName} resolved ${t!.name}'s ${t!.kind.toLowerCase()} trigger`);
      break;
    }
    case "TriggersDismissed": {
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const before = state.pendingTriggers.length;
      state.pendingTriggers = state.pendingTriggers.filter((t) => t.controller !== p.id);
      if (before !== state.pendingTriggers.length) log(state, ev, `${p.name} dismissed ${before - state.pendingTriggers.length} trigger${before - state.pendingTriggers.length === 1 ? "" : "s"}`);
      break;
    }
    case "ManaChanged": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const color = ev.payload.color;
      if (!MANA_COLORS.includes(color)) fail("bad mana colour");
      const delta = Math.trunc(ev.payload.delta);
      const next = Math.max(0, Math.min(99, p.mana[color] + delta));
      const applied = next - p.mana[color];
      p.mana[color] = next;
      if (applied !== 0) log(state, ev, `${p.name} ${applied > 0 ? "added" : "spent"} ${manaString(color, Math.abs(applied))}`);
      break;
    }
    case "ManaConverted": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const to = ev.payload.to;
      if (!MANA_COLORS.includes(to)) fail("bad mana colour");
      const total = MANA_COLORS.reduce((n, c) => n + p.mana[c], 0);
      p.mana = { ...EMPTY_MANA, [to]: total };
      log(state, ev, `${p.name} converted their mana to ${manaString(to, total)}`);
      break;
    }
    case "ManaEmptied": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      p.mana = { ...EMPTY_MANA };
      log(state, ev, `${p.name}'s mana emptied`);
      break;
    }
    case "KeepManaToggled": {
      requirePlaying(state);
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      p.keepMana = Boolean(ev.payload.keep);
      log(state, ev, `${p.name} ${p.keepMana ? "now keeps" : "no longer keeps"} mana between steps`);
      break;
    }
    case "TurnAdvanced": {
      requirePlaying(state);
      if (state.phase !== "playing") fail("the game has not started");
      beginTurn(state, ev);
      break;
    }
    case "StepAdvanced": {
      requirePlaying(state);
      if (state.phase !== "playing") fail("the game has not started");
      const i = STEPS.indexOf(state.step);
      if (i >= STEPS.length - 1) {
        beginTurn(state, ev);
      } else {
        state.step = STEPS[i + 1] as Step;
        log(state, ev, `${actorName} moved to ${STEP_LABELS[state.step]}`);
        emptyMana(state, ev, "step change");
        afterStepChange(state, ev);
      }
      break;
    }
    case "StepSet": {
      requirePlaying(state);
      if (state.phase !== "playing") fail("the game has not started");
      state.step = ev.payload.step;
      log(state, ev, `${actorName} jumped to ${STEP_LABELS[state.step]}`);
      emptyMana(state, ev, "step change");
      afterStepChange(state, ev);
      break;
    }
    case "AttackersDeclared": {
      requirePlaying(state);
      if (state.phase !== "playing") fail("the game has not started");
      requireActor(ev, state.activePlayer, "the active player");
      const me = player(state, state.activePlayer);
      const attacks = Array.isArray(ev.payload.attacks) ? ev.payload.attacks.slice(0, 40) : [];
      if (attacks.length === 0) fail("pick at least one attacker");
      // Re-declaring replaces this combat: untap what the earlier declaration tapped.
      if (state.combat && !state.combat.damageDealt) {
        for (const iid of state.combat.tappedByAttack) {
          const c = state.cards[iid];
          if (c && c.zone.kind === "battlefield") c.tapped = false;
        }
      }
      const combat: CombatState = { attacker: me.id, attackers: [], blockers: [], blockersDeclared: [], tappedByAttack: [], damageDealt: false };
      const derived = derivedFor(state, me.id);
      const seen = new Set<string>();
      for (const a of attacks) {
        if (!a || typeof a.iid !== "string" || seen.has(a.iid)) continue;
        seen.add(a.iid);
        const c = card(state, a.iid);
        if (c.zone.kind !== "battlefield" || c.zone.owner !== me.id) fail("you can only attack with permanents you control");
        if (c.tapped) fail(`${describe(c, false)} is tapped and cannot attack`);
        const defender = player(state, a.player);
        if (defender.id === me.id) fail("you cannot attack yourself");
        if (isOut(defender)) fail(`${defender.name} is out of the game`);
        let planeswalker: string | null = null;
        if (a.planeswalker) {
          const pw = card(state, a.planeswalker);
          if (pw.zone.kind !== "battlefield" || pw.zone.owner !== defender.id) fail("that planeswalker is not on the defender's battlefield");
          planeswalker = pw.iid;
        }
        combat.attackers.push({ iid: c.iid, player: defender.id, planeswalker });
        if (!hasKeyword(derived.get(c.iid), "vigilance")) {
          c.tapped = true;
          combat.tappedByAttack.push(c.iid);
        }
      }
      if (combat.attackers.length === 0) fail("pick at least one attacker");
      state.combat = combat;
      if (stepIndex(state.step) < stepIndex("attackers")) state.step = "attackers";
      const groups = new Map<string, string[]>();
      for (const a of combat.attackers) {
        const key = a.planeswalker ? `${player(state, a.player).name}'s ${describe(card(state, a.planeswalker), false)}` : player(state, a.player).name;
        const list = groups.get(key) ?? [];
        list.push(describe(card(state, a.iid), false));
        groups.set(key, list);
      }
      const vigilant = combat.attackers.filter((a) => !combat.tappedByAttack.includes(a.iid)).map((a) => describe(card(state, a.iid), false));
      log(state, ev, `${me.name} attacks ${[...groups].map(([who, names]) => `${who} with ${names.join(", ")}`).join("; ")}${vigilant.length ? ` (vigilance: ${vigilant.join(", ")})` : ""}`);
      break;
    }
    case "BlockersDeclared": {
      requirePlaying(state);
      const combat = state.combat;
      if (!combat || combat.damageDealt) fail("there is no attack to block");
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      if (!combat.attackers.some((a) => a.player === p.id)) fail(`${p.name} is not being attacked`);
      const blocks = Array.isArray(ev.payload.blocks) ? ev.payload.blocks.slice(0, 40) : [];
      const next = combat.blockers.filter((b) => b.player !== p.id);
      const used = new Set<string>();
      const pairs: string[] = [];
      for (const b of blocks) {
        if (!b || typeof b.iid !== "string" || typeof b.attacker !== "string") continue;
        const blocker = card(state, b.iid);
        if (blocker.zone.kind !== "battlefield" || blocker.zone.owner !== p.id) fail("you can only block with creatures you control");
        if (blocker.tapped) fail(`${describe(blocker, false)} is tapped and cannot block`);
        if (used.has(blocker.iid)) fail(`${describe(blocker, false)} cannot block two attackers`);
        used.add(blocker.iid);
        const attacker = combat.attackers.find((a) => a.iid === b.attacker);
        if (!attacker) fail("that creature is not attacking");
        if (attacker.player !== p.id) fail(`${describe(card(state, attacker.iid), false)} is not attacking you`);
        next.push({ iid: blocker.iid, attacker: attacker.iid, player: p.id });
        pairs.push(`${describe(card(state, attacker.iid), false)} with ${describe(blocker, false)}`);
      }
      combat.blockers = next;
      if (!combat.blockersDeclared.includes(p.id)) combat.blockersDeclared.push(p.id);
      if (stepIndex(state.step) < stepIndex("blockers")) state.step = "blockers";
      log(state, ev, pairs.length ? `${p.name} blocks ${pairs.join(", ")}` : `${p.name} declares no blocks`);
      break;
    }
    case "CombatDamageDealt": {
      requirePlaying(state);
      const combat = state.combat;
      if (!combat || combat.attackers.length === 0) fail("no attackers were declared");
      if (combat.damageDealt) fail("combat damage was already dealt");
      requireActor(ev, combat.attacker, "the attacking player");
      let assignments: DamageAssignment[];
      if (Array.isArray(ev.payload.assignments)) {
        assignments = [];
        for (const raw of ev.payload.assignments.slice(0, 200)) {
          if (!raw || typeof raw.source !== "string" || !raw.target) continue;
          const amount = Math.max(0, Math.min(999, Math.trunc(Number(raw.amount) || 0)));
          const asAttacker = combat.attackers.find((a) => a.iid === raw.source);
          const asBlocker = combat.blockers.find((b) => b.iid === raw.source);
          if (!asAttacker && !asBlocker) fail("damage can only come from attackers and blockers");
          const t = raw.target;
          if (asAttacker) {
            const legal =
              (t.kind === "player" && t.player === asAttacker.player) ||
              (t.kind === "card" && (t.iid === asAttacker.planeswalker || combat.blockers.some((b) => b.attacker === asAttacker.iid && b.iid === t.iid)));
            if (!legal) fail(`${describe(card(state, asAttacker.iid), false)} can only damage what it attacks or what blocks it`);
            assignments.push({ source: raw.source, target: t.kind === "player" ? { kind: "player", player: t.player } : { kind: "card", iid: t.iid }, amount });
          } else if (asBlocker) {
            if (t.kind !== "card" || t.iid !== asBlocker.attacker) fail(`${describe(card(state, asBlocker.iid), false)} can only damage the attacker it blocks`);
            assignments.push({ source: raw.source, target: { kind: "card", iid: t.iid }, amount });
          }
        }
      } else {
        assignments = proposeCombatDamage(state);
      }
      applyCombatDamage(state, ev, assignments, !Array.isArray(ev.payload.assignments));
      break;
    }
    case "WinClaimed": {
      requirePlaying(state);
      const adv = state.winAdvisories.find((w) => w.iid === ev.payload.iid);
      if (!adv) fail("no win condition is showing for that card");
      requireActor(ev, adv.controller, "that card's controller");
      const p = player(state, adv.controller);
      state.phase = "ended";
      state.winner = p.id;
      state.winAdvisories = [];
      log(state, ev, `${p.name} won the game with ${adv.name} (${adv.condition})`);
      break;
    }
    case "WinAdvisoryDismissed": {
      requirePlaying(state);
      const c = card(state, ev.payload.iid);
      requireController(ev, c);
      if (!state.dismissedWins.includes(c.iid)) state.dismissedWins.push(c.iid);
      log(state, ev, `${actorName} dismissed the win prompt from ${describe(c, false)}`);
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
      log(state, ev, `${actorName} rolled ${count > 1 ? `${count}d${sides}: ${rolls.join(" + ")} = ${rolls.reduce((a, b) => a + b, 0)}` : `a d${sides}: ${rolls[0]}`}`);
      break;
    }
    case "CoinFlipped": {
      const [v, rng] = nextInt(state.rng, 2);
      state.rng = rng;
      log(state, ev, `${actorName} flipped a coin: ${v === 0 ? "heads" : "tails"}`);
      break;
    }
    case "RandomOpponent": {
      const p = player(state, ev.payload.player);
      const others = state.turnOrder.filter((id) => id !== p.id && !isOut(player(state, id)));
      if (!others.length) fail("no opponents left");
      const [i, rng] = nextInt(state.rng, others.length);
      state.rng = rng;
      log(state, ev, `${p.name} picked a random opponent: ${player(state, others[i]!).name}`);
      break;
    }
    case "PlayerConceded": {
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      if (p.conceded) fail("already conceded");
      p.conceded = true;
      p.kept = true;
      log(state, ev, `${p.name} conceded`);
      if (state.activePlayer === p.id && state.phase === "playing") {
        state.activePlayer = nextActivePlayer(state);
      }
      maybeFinishMulligans(state, ev);
      break;
    }
    case "NoteAdded": {
      const p = player(state, ev.payload.player);
      requireActor(ev, p.id, "that player");
      const text = String(ev.payload.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!text) fail("empty note");
      log(state, ev, `${p.name}: ${text}`);
      break;
    }
    case "EngineLog":
    case "EngineAnswer":
    case "EngineGameOver":
    case "EngineRoll":
    case "EngineFirstPlayer":
      // Rules-engine tables keep their own log; the classic reducer never sees these (the relay appends them without reducing).
      fail("engine events do not apply to this table");
      break;
    default: {
      const never: never = ev;
      fail(`unknown event ${(never as { type: string }).type}`);
    }
  }
  // Automatic eliminations (0 life, 10 poison, 21 commander damage), then "last player standing" ends the game.
  checkEliminations(state, ev);
  checkEnded(state, ev);
  // Advisory "you win the game" prompts (the controller confirms with WinClaimed).
  state.winAdvisories = detectWinConditions(state);
  // Advisory triggers for whatever just happened (deterministic, so every replay agrees).
  const found = detectTriggers(state, ev);
  if (found.length) {
    state.pendingTriggers.push(...found);
    if (state.pendingTriggers.length > 30) state.pendingTriggers.splice(0, state.pendingTriggers.length - 30);
  }
  return state;
}

function cleanKeywords(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((k): k is string => typeof k === "string").map((k) => k.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 12);
}

function cleanEffect(e: { power: number; toughness: number; keywords: string[] }): { power: number; toughness: number; keywords: string[] } {
  return { power: Math.trunc(e.power) || 0, toughness: Math.trunc(e.toughness) || 0, keywords: cleanKeywords(e.keywords) };
}

function effectText(e: { power: number; toughness: number; keywords: string[] }, removed: string[] = []): string {
  const parts: string[] = [];
  if (e.power || e.toughness) parts.push(`${e.power >= 0 ? "+" : ""}${e.power}/${e.toughness >= 0 ? "+" : ""}${e.toughness}`);
  if (e.keywords.length) parts.push(e.keywords.join(", "));
  if (removed.length) parts.push(`without ${removed.join(", ")}`);
  return parts.join(" and ") || "nothing";
}

/**
 * Rebuild state from the whole log. A Revert event rewinds to just after
 * `toSeq` (events are 1-based and contiguous) and later events continue from
 * there; nested reverts work because the prefix is replayed the same way.
 * A Revert with reason "undo" is silent; any other revert is logged.
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
        // A quiet undo (own last action, nobody acted since) leaves no trace in the log: the undone
        // line simply disappears. An explicit revert is announced so everyone knows what happened.
        if (ev.payload.reason !== "undo") {
          const who = ev.actor === SYSTEM_ACTOR ? "The table" : (state.players[ev.actor]?.name ?? "Someone");
          log(state, ev, `${who} reverted the game to #${to}`);
        }
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
