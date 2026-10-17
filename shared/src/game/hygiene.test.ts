import { describe, expect, it } from "vitest";
import type { CardPrinting } from "../cards.js";
import { combatContextFromView, proposeCombatDamage, proposeDamage } from "./combat.js";
import { applyEvent, replay } from "./reducer.js";
import { SYSTEM_ACTOR, type EventInput, type GameEvent, type GameState, type GameStartedPayload } from "./types.js";
import { viewFor } from "./view.js";
import { checkWinCondition, wordToNumber } from "./wincons.js";

/**
 * Table hygiene (stopgap before the rules engine): ownership guardrails,
 * hidden-information paths, automatic untap/draw, combat as events, automatic
 * eliminations and advisory win conditions.
 */

let n = 0;
function printing(name: string, typeLine: string, oracleText = "", opts: { power?: string; toughness?: string; keywords?: string[] } = {}): CardPrinting {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    oracleId: null,
    name,
    set: "tst",
    setName: "Test",
    collectorNumber: String(n),
    releasedAt: "2026-01-01",
    rarity: "common",
    layout: "normal",
    manaCost: "{1}",
    cmc: 1,
    typeLine,
    oracleText,
    power: opts.power ?? null,
    toughness: opts.toughness ?? null,
    loyalty: null,
    defense: null,
    colors: [],
    colorIdentity: [],
    keywords: opts.keywords ?? [],
    legalities: {},
    faces: [],
    isToken: false,
    isPromo: false,
    isDigital: false,
    artist: null,
    scryfallUri: "",
  };
}

const A = "user-a";
const B = "user-b";
const C = "user-c";
const SEED = "hygiene-seed";

function payload(three = false): GameStartedPayload {
  const lib = (prefix: string) => Array.from({ length: 12 }, (_, i) => printing(`${prefix} Secret ${i + 1}`, i % 3 === 0 ? "Land" : "Creature — Test", "", { power: "2", toughness: "2" }));
  const players = [
    { id: A, name: "Alex", seat: 0 },
    { id: B, name: "Blair", seat: 1 },
  ];
  const decks: GameStartedPayload["decks"] = {
    [A]: { library: lib("Alpha"), commanders: [printing("Alpha Commander", "Legendary Creature — Test", "", { power: "5", toughness: "5" })] },
    [B]: { library: lib("Bravo"), commanders: [printing("Bravo Commander", "Legendary Creature — Test", "", { power: "3", toughness: "3" })] },
  };
  if (three) {
    players.push({ id: C, name: "Casey", seat: 2 });
    decks[C] = { library: lib("Charlie"), commanders: [printing("Charlie Commander", "Legendary Creature — Test", "", { power: "4", toughness: "4" })] };
  }
  return { players, decks, startingLife: 40 };
}

class Game {
  events: GameEvent[] = [];
  state: GameState | null = null;
  constructor(public three = false) {}
  push(actor: string, input: EventInput): GameState {
    const ev = { ...input, seq: this.events.length + 1, actor, ts: 1000 + this.events.length } as GameEvent;
    this.events.push(ev);
    try {
      this.state = ev.type === "Revert" ? replay(this.events, SEED) : applyEvent(this.state, ev, SEED);
    } catch (err) {
      this.events.pop(); // a refused event is never appended (what the server does)
      throw err;
    }
    return this.state!;
  }
  start(): GameState {
    this.push(SYSTEM_ACTOR, { type: "GameStarted", payload: payload(this.three) });
    this.push(A, { type: "HandKept", payload: { player: A } });
    this.push(B, { type: "HandKept", payload: { player: B } });
    if (this.three) this.push(C, { type: "HandKept", payload: { player: C } });
    return this.state!;
  }
  /** Put a custom-printing token on a player's battlefield and return its iid. */
  token(owner: string, p: CardPrinting, row: "creatures" | "other" | "lands" | "artifacts" | "enchantments" = "creatures"): string {
    const s = this.push(owner, { type: "TokenCreated", payload: { player: owner, printing: p, custom: null, count: 1, row } });
    return s.players[owner]!.zones.battlefield[row].at(-1)!;
  }
  /** Make `who` the active player (pass turns). */
  turnOf(who: string): GameState {
    while (this.state!.activePlayer !== who) this.push(this.state!.activePlayer, { type: "TurnAdvanced", payload: {} });
    return this.state!;
  }
  last(): string {
    return this.state!.log.at(-1)!.text;
  }
  lines(): string[] {
    return this.state!.log.map((l) => l.text);
  }
}

const bear = () => printing("Grizzly Bears", "Creature — Bear", "", { power: "2", toughness: "2" });
const angel = () => printing("Serra Angel", "Creature — Angel", "Flying, vigilance", { power: "4", toughness: "4", keywords: ["Flying", "Vigilance"] });
const wall = () => printing("Wall of Omens", "Creature — Wall", "Defender", { power: "0", toughness: "4", keywords: ["Defender"] });
const trampler = () => printing("Craw Wurm", "Creature — Wurm", "Trample", { power: "6", toughness: "4", keywords: ["Trample"] });
const vampire = () => printing("Vampire Nighthawk", "Creature — Vampire", "Flying, deathtouch, lifelink", { power: "2", toughness: "3", keywords: ["Flying", "Deathtouch", "Lifelink"] });
const jace = () => printing("Jace Beleren", "Legendary Planeswalker — Jace", "", {});

describe("ownership guardrails", () => {
  it("only the controller taps, moves, counters, flips, turns or attaches a permanent", () => {
    const g = new Game();
    g.start();
    const bears = g.token(A, bear());
    const equip = g.token(A, printing("Bonesplitter", "Artifact — Equipment", "Equipped creature gets +2/+0.\nEquip {1}"), "artifacts");
    expect(() => g.push(B, { type: "CardTapped", payload: { iid: bears, tapped: true } })).toThrow(/only the controller/);
    expect(() => g.push(B, { type: "CardMoved", payload: { iid: bears, to: { kind: "graveyard", owner: A } } })).toThrow(/only the controller/);
    expect(() => g.push(B, { type: "CardMoved", payload: { iid: bears, to: { kind: "battlefield", owner: B } } })).toThrow(/only the controller/);
    expect(() => g.push(B, { type: "CounterChanged", payload: { iid: bears, kind: "-1/-1", delta: 1 } })).toThrow(/only the controller/);
    expect(() => g.push(B, { type: "CardTurned", payload: { iid: bears, faceDown: true } })).toThrow(/only the controller/);
    expect(() => g.push(B, { type: "Attached", payload: { iid: equip, to: bears } })).toThrow(/only the controller/);
    expect(() => g.push(B, { type: "CardModifierSet", payload: { iid: bears, modifier: { power: 1, toughness: 1, keywords: [], removedKeywords: [] } } })).toThrow(/only the controller/);
    expect(() => g.push(B, { type: "UntapAll", payload: { player: A } })).toThrow(/only that player/);
    expect(() => g.push(B, { type: "CardCopied", payload: { iid: bears, player: A } })).toThrow(/only the player receiving/);
    // The controller may do all of it, including attaching to an opponent's creature and copying an opponent's permanent.
    const bBear = g.token(B, bear());
    let s = g.push(A, { type: "Attached", payload: { iid: equip, to: bBear, effect: { power: 2, toughness: 0, keywords: [] } } });
    expect(s.cards[equip]!.attachedTo).toBe(bBear);
    s = g.push(A, { type: "CardCopied", payload: { iid: bBear, player: A } });
    expect(s.players[A]!.zones.battlefield.creatures).toHaveLength(2);
    s = g.push(A, { type: "CardTapped", payload: { iid: bears, tapped: true } });
    expect(s.cards[bears]!.tapped).toBe(true);
    // Only the controller moves it to someone else's battlefield (a gift), and that is logged as such.
    s = g.push(A, { type: "CardMoved", payload: { iid: bears, to: { kind: "battlefield", owner: B, row: "creatures" } } });
    expect(g.last()).toBe("Alex gave control of Grizzly Bears to Blair");
    expect(s.cards[bears]!.zone.owner).toBe(B);
    expect(replay(g.events, SEED)).toEqual(g.state);
  });

  it("ControlTaken is the explicit way to take another player's permanent (or reanimate from their graveyard)", () => {
    const g = new Game();
    g.start();
    const bears = g.token(A, bear());
    expect(() => g.push(A, { type: "ControlTaken", payload: { iid: bears } })).toThrow(/already control/);
    let s = g.push(B, { type: "ControlTaken", payload: { iid: bears } });
    expect(s.cards[bears]!.zone).toEqual({ kind: "battlefield", owner: B, row: "creatures" });
    expect(g.last()).toBe("Blair took control of Grizzly Bears from Alex");
    // A real card in Alex's graveyard: Blair reanimates it onto Blair's battlefield.
    const dead = s.players[A]!.zones.hand[0]!;
    const deadName = s.cards[dead]!.printing!.name;
    s = g.push(A, { type: "CardMoved", payload: { iid: dead, to: { kind: "graveyard", owner: A } } });
    s = g.push(B, { type: "ControlTaken", payload: { iid: dead } });
    expect(s.cards[dead]!.zone.owner).toBe(B);
    expect(s.cards[dead]!.zone.kind).toBe("battlefield");
    expect(s.cards[dead]!.owner).toBe(A);
    expect(g.last()).toBe(`Blair took control of ${deadName} from Alex's graveyard`);
    // Never from a hand, a library or the command zone.
    const inHand = s.players[A]!.zones.hand[0]!;
    expect(() => g.push(B, { type: "ControlTaken", payload: { iid: inHand } })).toThrow(/not on the table/);
    expect(() => g.push(B, { type: "ControlTaken", payload: { iid: s.players[A]!.zones.library[0]! } })).toThrow(/not on the table/);
    expect(() => g.push(B, { type: "ControlTaken", payload: { iid: s.players[A]!.zones.command[0]! } })).toThrow(/not on the table/);
  });

  it("spectators act on nothing, and private bookkeeping (mana, anthems, triggers) is per player", () => {
    const g = new Game();
    g.start();
    expect(() => g.push("stranger", { type: "LifeChanged", payload: { player: A, delta: -1 } })).toThrow(/spectators/);
    expect(() => g.push("stranger", { type: "StepAdvanced", payload: {} })).toThrow(/spectators/);
    expect(() => g.push("stranger", { type: "CardsDrawn", payload: { player: A, count: 1 } })).toThrow(/spectators/);
    expect(() => g.push(B, { type: "ManaChanged", payload: { player: A, color: "G", delta: 1 } })).toThrow(/only that player/);
    expect(() => g.push(B, { type: "ManualAnthemAdded", payload: { player: A, power: 1, toughness: 1, keywords: [], note: "" } })).toThrow(/only that player/);
    expect(() => g.push(B, { type: "TriggersDismissed", payload: { player: A } })).toThrow(/only that player/);
    expect(() => g.push(B, { type: "KeepManaToggled", payload: { player: A, keep: true } })).toThrow(/only that player/);
  });

  it("commander damage is recorded by the victim or the commander's owner only", () => {
    const g = new Game(true);
    const s = g.start();
    const bCmd = s.players[B]!.zones.command[0]!;
    expect(() => g.push(C, { type: "CommanderDamage", payload: { player: A, commanderIid: bCmd, delta: 3 } })).toThrow(/commander's owner/);
    g.push(B, { type: "CommanderDamage", payload: { player: A, commanderIid: bCmd, delta: 3 } });
    g.push(A, { type: "CommanderDamage", payload: { player: A, commanderIid: bCmd, delta: 2 } });
    expect(g.state!.players[A]!.commanderDamage[bCmd]).toBe(5);
  });
});

describe("hidden information: libraries are browsed only by their owner, through logged actions", () => {
  const serialized = (s: GameState, viewer: string | null) => {
    const { view, printings } = viewFor(s, viewer);
    return JSON.stringify({ view: { ...view, log: [] }, printings: Object.fromEntries(printings) });
  };

  it("searching shows the owner's library to the owner only; others and spectators see counts; it is logged", () => {
    const g = new Game();
    let s = g.start();
    expect(() => g.push(B, { type: "LibrarySearched", payload: { player: A } })).toThrow(/only the owner/);
    expect(() => g.push(B, { type: "LibraryLooked", payload: { player: A, count: 3 } })).toThrow(/only the owner/);
    expect(() => g.push(B, { type: "LibraryRevealed", payload: { player: A, count: 1 } })).toThrow(/only the owner/);
    expect(() => g.push("stranger", { type: "LibrarySearched", payload: { player: A } })).toThrow(/spectators/);
    s = g.push(A, { type: "LibrarySearched", payload: { player: A } });
    expect(g.last()).toBe("Alex searched their library");
    const names = s.players[A]!.zones.library.map((iid) => s.cards[iid]!.printing!.name);
    expect(names.length).toBeGreaterThan(0);
    const forA = serialized(s, A);
    const forB = serialized(s, B);
    const forSpectator = serialized(s, null);
    for (const name of names) {
      expect(forA).toContain(`"${name}"`);
      expect(forB).not.toContain(`"${name}"`);
      expect(forSpectator).not.toContain(`"${name}"`);
    }
    expect(viewFor(s, B).view.players[A]!.library.known).toHaveLength(0);
    expect(viewFor(s, null).view.players[A]!.library.known).toHaveLength(0);
    expect(viewFor(s, B).view.players[A]!.library.count).toBe(names.length);
    // Without a search nothing in a library is visible, not even to its owner.
    s = g.push(A, { type: "LibraryShuffled", payload: { player: A } });
    for (const name of s.players[A]!.zones.library.map((iid) => s.cards[iid]!.printing!.name)) expect(serialized(s, A)).not.toContain(`"${name}"`);
  });

  it("another player's hand and face-down cards cannot be revealed, turned up or flipped by anyone else", () => {
    const g = new Game();
    let s = g.start();
    const aHand = s.players[A]!.zones.hand[0]!;
    expect(() => g.push(B, { type: "CardRevealed", payload: { iid: aHand } })).toThrow(/only the owner/);
    expect(() => g.push(B, { type: "CardFlipped", payload: { iid: aHand } })).toThrow(/only the owner/);
    s = g.push(A, { type: "CardMoved", payload: { iid: aHand, to: { kind: "battlefield", owner: A, faceDown: true } } });
    expect(() => g.push(B, { type: "CardTurned", payload: { iid: aHand, faceDown: false } })).toThrow(/only the controller/);
    expect(() => g.push(B, { type: "CardRevealed", payload: { iid: aHand } })).toThrow(/only the owner/);
    const name = s.cards[aHand]!.printing!.name;
    expect(serialized(s, B)).not.toContain(name);
    expect(serialized(s, null)).not.toContain(name);
  });
});

describe("turn automation", () => {
  it("a new turn untaps the active player's permanents (logged) and the draw happens once the draw step is reached or passed", () => {
    const g = new Game();
    let s = g.start();
    const first = s.activePlayer;
    const second = first === A ? B : A;
    expect(s.step).toBe("upkeep");
    expect(s.drewForTurn).toBe(false);
    // Turn one: the first player draws too (Commander: everyone draws on their first turn).
    const handBefore = s.players[first]!.zones.hand.length;
    s = g.push(first, { type: "StepAdvanced", payload: {} });
    expect(s.step).toBe("draw");
    expect(s.players[first]!.zones.hand.length).toBe(handBefore + 1);
    expect(g.last()).toBe(`${s.players[first]!.name} drew for the turn`);
    expect(s.drewForTurn).toBe(true);
    // Passing more steps never draws again this turn.
    s = g.push(first, { type: "StepAdvanced", payload: {} });
    s = g.push(first, { type: "StepSet", payload: { step: "draw" } });
    expect(s.players[first]!.zones.hand.length).toBe(handBefore + 1);

    // Tap something, pass the turn: untap is logged, the new turn opens on upkeep, and jumping straight to main1 draws.
    const bears = g.token(first, bear());
    g.push(first, { type: "CardTapped", payload: { iid: bears, tapped: true } });
    const bearsB = g.token(second, bear());
    g.push(second, { type: "CardTapped", payload: { iid: bearsB, tapped: true } });
    s = g.push(first, { type: "TurnAdvanced", payload: {} });
    expect(s.activePlayer).toBe(second);
    expect(s.step).toBe("upkeep");
    expect(s.cards[bearsB]!.tapped).toBe(false);
    expect(s.cards[bears]!.tapped).toBe(true); // only the active player's permanents untap
    expect(g.lines().slice(-2)).toEqual([`Turn 2: ${s.players[second]!.name}'s turn`, `${s.players[second]!.name}'s permanents untapped (1)`]);
    const hand2 = s.players[second]!.zones.hand.length;
    s = g.push(second, { type: "StepSet", payload: { step: "main1" } });
    expect(s.players[second]!.zones.hand.length).toBe(hand2 + 1);
    expect(g.lines()).toContain(`${s.players[second]!.name} drew for the turn`);
    // Cleanup -> next turn through StepAdvanced behaves the same.
    s = g.push(second, { type: "StepSet", payload: { step: "cleanup" } });
    s = g.push(second, { type: "StepAdvanced", payload: {} });
    expect(s.turn).toBe(3);
    expect(s.activePlayer).toBe(first);
    expect(s.step).toBe("upkeep");
    expect(s.cards[bears]!.tapped).toBe(false);
    expect(replay(g.events, SEED)).toEqual(g.state);
  });

  it("an empty library is logged, not an error", () => {
    const g = new Game();
    let s = g.start();
    const first = s.activePlayer;
    s = g.push(first, { type: "Milled", payload: { player: first, count: 50 } });
    expect(s.players[first]!.zones.library).toHaveLength(0);
    s = g.push(first, { type: "StepSet", payload: { step: "main1" } });
    expect(g.lines()).toContain(`${s.players[first]!.name} could not draw for the turn (library empty)`);
  });
});

describe("combat as events", () => {
  function setup() {
    const g = new Game(true);
    g.start();
    g.turnOf(A);
    g.push(A, { type: "StepSet", payload: { step: "main1" } });
    return g;
  }

  it("declaring attackers taps them (vigilance excepted), targets players or planeswalkers, and only the active player may declare", () => {
    const g = setup();
    const bears = g.token(A, bear());
    const serra = g.token(A, angel());
    const bBear = g.token(B, bear());
    const pw = g.token(B, jace(), "other");
    expect(() => g.push(B, { type: "AttackersDeclared", payload: { attacks: [{ iid: bBear, player: A }] } })).toThrow(/active player/);
    expect(() => g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bBear, player: B }] } })).toThrow(/permanents you control/);
    expect(() => g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: A }] } })).toThrow(/yourself/);
    expect(() => g.push(A, { type: "AttackersDeclared", payload: { attacks: [] } })).toThrow(/at least one/);
    let s = g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: B }, { iid: serra, player: B, planeswalker: pw }] } });
    expect(s.step).toBe("attackers");
    expect(s.cards[bears]!.tapped).toBe(true);
    expect(s.cards[serra]!.tapped).toBe(false);
    expect(s.combat).toMatchObject({ attacker: A, blockers: [], blockersDeclared: [], damageDealt: false, tappedByAttack: [bears] });
    expect(s.combat!.attackers).toEqual([
      { iid: bears, player: B, planeswalker: null },
      { iid: serra, player: B, planeswalker: pw },
    ]);
    expect(g.last()).toBe("Alex attacks Blair with Grizzly Bears; Blair's Jace Beleren with Serra Angel (vigilance: Serra Angel)");
    // Re-declaring replaces the attack and untaps what the earlier declaration tapped.
    s = g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: serra, player: C }] } });
    expect(s.cards[bears]!.tapped).toBe(false);
    expect(s.combat!.attackers).toEqual([{ iid: serra, player: C, planeswalker: null }]);
    // A creature tapped for another reason cannot attack.
    g.push(A, { type: "CardTapped", payload: { iid: bears, tapped: true } });
    expect(() => g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: B }] } })).toThrow(/tapped/);
    expect(replay(g.events, SEED)).toEqual(g.state);
  });

  it("defenders declare blocks with their own untapped creatures against creatures attacking them", () => {
    const g = setup();
    const bears = g.token(A, bear());
    const wurm = g.token(A, trampler());
    const bWall = g.token(B, wall());
    const bBear = g.token(B, bear());
    const cBear = g.token(C, bear());
    g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: B }, { iid: wurm, player: C }] } });
    expect(() => g.push(A, { type: "BlockersDeclared", payload: { player: B, blocks: [] } })).toThrow(/only that player/);
    expect(() => g.push(B, { type: "BlockersDeclared", payload: { player: B, blocks: [{ iid: cBear, attacker: bears }] } })).toThrow(/creatures you control/);
    expect(() => g.push(B, { type: "BlockersDeclared", payload: { player: B, blocks: [{ iid: bWall, attacker: wurm }] } })).toThrow(/not attacking you/);
    expect(() => g.push(B, { type: "BlockersDeclared", payload: { player: B, blocks: [{ iid: bWall, attacker: bears }, { iid: bWall, attacker: bears }] } })).toThrow(/two attackers/);
    g.push(B, { type: "CardTapped", payload: { iid: bBear, tapped: true } });
    expect(() => g.push(B, { type: "BlockersDeclared", payload: { player: B, blocks: [{ iid: bBear, attacker: bears }] } })).toThrow(/tapped/);
    let s = g.push(B, { type: "BlockersDeclared", payload: { player: B, blocks: [{ iid: bWall, attacker: bears }] } });
    expect(s.step).toBe("blockers");
    expect(s.combat!.blockers).toEqual([{ iid: bWall, attacker: bears, player: B }]);
    expect(g.last()).toBe("Blair blocks Grizzly Bears with Wall of Omens");
    s = g.push(C, { type: "BlockersDeclared", payload: { player: C, blocks: [] } });
    expect(g.last()).toBe("Casey declares no blocks");
    expect(s.combat!.blockersDeclared).toEqual([B, C]);
    // Re-declaring replaces only that player's blocks.
    s = g.push(B, { type: "BlockersDeclared", payload: { player: B, blocks: [] } });
    expect(s.combat!.blockers).toEqual([]);
  });

  it("proposes default damage (lethal to blockers in order, trample over, blockers hit back) and applies it to life, commander damage and loyalty", () => {
    const g = setup();
    const s0 = g.state!;
    const aCmd = s0.players[A]!.zones.command[0]!; // 5/5 commander
    g.push(A, { type: "CardMoved", payload: { iid: aCmd, to: { kind: "battlefield", owner: A } } });
    const wurm = g.token(A, trampler()); // 6/4 trample
    const hawk = g.token(A, vampire()); // 2/3 deathtouch lifelink
    const bWall = g.token(B, wall()); // 0/4
    const bBear = g.token(B, bear()); // 2/2
    const pw = g.token(C, jace(), "other");
    g.push(C, { type: "CounterChanged", payload: { iid: pw, kind: "loyalty", delta: 3 } });
    g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: aCmd, player: B }, { iid: wurm, player: B }, { iid: hawk, player: C, planeswalker: pw }] } });
    g.push(B, { type: "BlockersDeclared", payload: { player: B, blocks: [{ iid: bWall, attacker: wurm }, { iid: bBear, attacker: wurm }] } });
    const proposal = proposeCombatDamage(g.state!);
    expect(proposal).toEqual([
      { source: aCmd, target: { kind: "player", player: B }, amount: 5 },
      { source: wurm, target: { kind: "card", iid: bWall }, amount: 4 },
      { source: wurm, target: { kind: "card", iid: bBear }, amount: 2 },
      { source: hawk, target: { kind: "card", iid: pw }, amount: 2 },
      { source: bBear, target: { kind: "card", iid: wurm }, amount: 2 },
    ]);
    // The client computes the same default from its view (what the damage sheet shows), for any seat.
    for (const viewer of [A, B, C]) {
      const { view, printings } = viewFor(g.state!, viewer);
      expect(proposeDamage(combatContextFromView(view, Object.fromEntries(printings)))).toEqual(proposal);
    }
    // Only the attacking player applies damage.
    expect(() => g.push(B, { type: "CombatDamageDealt", payload: {} })).toThrow(/attacking player/);
    let s = g.push(A, { type: "CombatDamageDealt", payload: {} });
    expect(s.players[B]!.life).toBe(35);
    expect(s.players[B]!.commanderDamage[aCmd]).toBe(5);
    expect(s.players[A]!.life).toBe(42); // lifelink from the Nighthawk's 2 to Jace
    expect(s.cards[pw]!.counters.loyalty).toBe(1);
    expect(s.step).toBe("damage");
    expect(s.combat!.damageDealt).toBe(true);
    const lines = g.lines();
    expect(lines.at(-2)).toBe(
      "Alex's combat damage (default assignment): Alpha Commander dealt 5 to Blair (now 35); Blair has taken 5 from Alpha Commander in total; Craw Wurm dealt 4 to Wall of Omens; Craw Wurm dealt 2 to Grizzly Bears; Vampire Nighthawk dealt 2 to Jace Beleren (loyalty now 1); Alex gained 2 from lifelink (now 42); Grizzly Bears dealt 2 to Craw Wurm",
    );
    expect(lines.at(-1)).toBe("Lethal damage on Wall of Omens, Grizzly Bears: move them to the graveyard unless something saves them");
    expect(() => g.push(A, { type: "CombatDamageDealt", payload: {} })).toThrow(/already dealt/);
    // Combat clears once the turn moves past combat.
    s = g.push(A, { type: "StepAdvanced", payload: {} });
    expect(s.combat).toBeNull();
    expect(replay(g.events, SEED)).toEqual(g.state);
  });

  it("the attacker can adjust the assignment within what each creature may legally damage", () => {
    const g = setup();
    const wurm = g.token(A, trampler());
    const bWall = g.token(B, wall());
    const bBear = g.token(B, bear());
    g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: wurm, player: B }] } });
    g.push(B, { type: "BlockersDeclared", payload: { player: B, blocks: [{ iid: bWall, attacker: wurm }] } });
    // Cannot hit a creature that is not blocking it, or a player it is not attacking.
    expect(() => g.push(A, { type: "CombatDamageDealt", payload: { assignments: [{ source: wurm, target: { kind: "card", iid: bBear }, amount: 6 }] } })).toThrow(/can only damage/);
    expect(() => g.push(A, { type: "CombatDamageDealt", payload: { assignments: [{ source: wurm, target: { kind: "player", player: C }, amount: 6 }] } })).toThrow(/can only damage/);
    expect(() => g.push(A, { type: "CombatDamageDealt", payload: { assignments: [{ source: bBear, target: { kind: "card", iid: wurm }, amount: 2 }] } })).toThrow(/attackers and blockers/);
    const s = g.push(A, {
      type: "CombatDamageDealt",
      payload: {
        assignments: [
          { source: wurm, target: { kind: "card", iid: bWall }, amount: 1 },
          { source: wurm, target: { kind: "player", player: B }, amount: 5 },
        ],
      },
    });
    expect(s.players[B]!.life).toBe(35);
    expect(g.lines().at(-1)).toBe("Alex's combat damage: Craw Wurm dealt 1 to Wall of Omens; Craw Wurm dealt 5 to Blair (now 35)");
  });

  it("passing the step or the turn with attackers declared applies the default damage automatically", () => {
    const g = setup();
    const bears = g.token(A, bear());
    g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: B }] } });
    let s = g.push(A, { type: "StepSet", payload: { step: "main2" } });
    expect(s.players[B]!.life).toBe(38);
    expect(s.combat).toBeNull();
    expect(g.lines()).toContain("Alex's combat damage (default assignment): Grizzly Bears dealt 2 to Blair (now 38)");
    // Next turn: declare, then pass the turn straight away.
    g.push(A, { type: "TurnAdvanced", payload: {} });
    g.turnOf(A);
    g.push(A, { type: "StepSet", payload: { step: "main1" } });
    g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: B }] } });
    s = g.push(A, { type: "TurnAdvanced", payload: {} });
    expect(s.players[B]!.life).toBe(36);
    expect(s.combat).toBeNull();
    // Infect deals poison instead of life loss.
    g.push(A, { type: "TurnAdvanced", payload: {} });
    g.turnOf(A);
    g.push(A, { type: "StepSet", payload: { step: "main1" } });
    const blight = g.token(A, printing("Blight Mamba", "Creature — Snake", "Infect", { power: "1", toughness: "1", keywords: ["Infect"] }));
    g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: blight, player: B }] } });
    s = g.push(A, { type: "CombatDamageDealt", payload: {} });
    expect(s.players[B]!.life).toBe(36);
    expect(s.players[B]!.counters.poison).toBe(1);
  });
});

describe("win conditions", () => {
  it("0 life, 10 poison or 21 commander damage eliminates a player automatically; the last player standing wins; a revert brings everyone back", () => {
    const g = new Game(true);
    g.start();
    const aCmd = g.state!.players[A]!.zones.command[0]!;
    let s = g.push(A, { type: "LifeChanged", payload: { player: B, value: 0 } });
    expect(s.players[B]!.eliminated).toBe("life");
    expect(g.lines().at(-1)).toBe("Blair is out of the game: 0 life (revert if that was a mistake)");
    expect(s.phase).toBe("playing");
    // Corrected life brings them straight back.
    s = g.push(B, { type: "LifeChanged", payload: { player: B, value: 12 } });
    expect(s.players[B]!.eliminated).toBeNull();
    expect(g.last()).toBe("Blair is back in the game");
    s = g.push(C, { type: "PlayerCounterChanged", payload: { player: C, kind: "poison", delta: 10 } });
    expect(s.players[C]!.eliminated).toBe("poison");
    const seqBefore = s.seq;
    s = g.push(A, { type: "CommanderDamage", payload: { player: B, commanderIid: aCmd, delta: 21 } });
    expect(s.players[B]!.eliminated).toBe("commander damage");
    expect(s.phase).toBe("ended");
    expect(s.winner).toBe(A);
    expect(g.lines().slice(-2)).toEqual(["Blair is out of the game: 21 damage from Alpha Commander (revert if that was a mistake)", "Alex won the game"]);
    // Revert the mistake: Blair is back, the game continues.
    s = g.push(B, { type: "Revert", payload: { toSeq: seqBefore } });
    expect(s.phase).toBe("playing");
    expect(s.winner).toBeNull();
    expect(s.players[B]!.eliminated).toBeNull();
    expect(s.players[C]!.eliminated).toBe("poison");
    // Eliminated players are skipped for turns and cannot be attacked.
    g.turnOf(A);
    s = g.push(A, { type: "TurnAdvanced", payload: {} });
    expect(s.activePlayer).toBe(B);
    s = g.push(B, { type: "TurnAdvanced", payload: {} });
    expect(s.activePlayer).toBe(A);
    const bears = g.token(A, bear());
    g.push(A, { type: "StepSet", payload: { step: "main1" } });
    expect(() => g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: C }] } })).toThrow(/out of the game/);
    expect(replay(g.events, SEED)).toEqual(g.state);
  });

  it("combat damage that drops a player to 0 eliminates them in the same event", () => {
    const g = new Game();
    g.start();
    g.turnOf(A);
    g.push(A, { type: "StepSet", payload: { step: "main1" } });
    g.push(A, { type: "LifeChanged", payload: { player: B, value: 2 } });
    const bears = g.token(A, bear());
    g.push(A, { type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: B }] } });
    const s = g.push(A, { type: "CombatDamageDealt", payload: {} });
    expect(s.players[B]!.life).toBe(0);
    expect(s.players[B]!.eliminated).toBe("life");
    expect(s.phase).toBe("ended");
    expect(s.winner).toBe(A);
  });

  it("reads the common static 'you win the game' patterns", () => {
    expect(wordToNumber("twenty")).toBe(20);
    expect(wordToNumber("one hundred")).toBe(100);
    expect(wordToNumber("twenty-five")).toBe(25);
    expect(wordToNumber("13")).toBe(13);
    const g = new Game();
    g.start();
    const reactor = g.token(A, printing("Darksteel Reactor", "Artifact", "Indestructible\nAt the beginning of your upkeep, you may put a charge counter on Darksteel Reactor.\nWhen Darksteel Reactor has twenty or more charge counters on it, you win the game."), "artifacts");
    const felidar = g.token(A, printing("Felidar Sovereign", "Creature — Cat Beast", "Vigilance, lifelink\nAt the beginning of your upkeep, if you have 40 or more life, you win the game.", { power: "4", toughness: "6" }));
    const maze = g.token(B, printing("Maze's End", "Land", "Maze's End enters tapped.\n{T}: Add {C}.\n{3}, {T}, Return Maze's End to its owner's hand: Search your library for a Gate card, put it onto the battlefield, then shuffle. If you control ten or more Gates with different names, you win the game."), "lands");
    const helix = g.token(B, printing("Helix Pinnacle", "Enchantment", "Shroud\n{X}: Put X tower counters on Helix Pinnacle.\nAt the beginning of your upkeep, if there are one hundred or more tower counters on Helix Pinnacle, you win the game."), "enchantments");
    const mortal = g.token(B, printing("Mortal Combat", "Enchantment", "At the beginning of your upkeep, if twenty or more creature cards are in your graveyard, you win the game."), "enchantments");
    const oracle = g.token(A, printing("Thassa's Oracle", "Creature — Merfolk Wizard", "When Thassa's Oracle enters, look at the top X cards of your library, where X is your devotion to blue. Put up to one of them on top of your library and the rest on the bottom in a random order. If X is greater than or equal to the number of cards in your library, you win the game.", { power: "1", toughness: "3" }));
    let s = g.state!;
    expect(checkWinCondition(s, s.cards[reactor]!)).toEqual({ condition: "20 or more charge counters (has 0)", met: false });
    expect(checkWinCondition(s, s.cards[felidar]!)).toEqual({ condition: "40 or more life (has 40)", met: true });
    expect(checkWinCondition(s, s.cards[maze]!)).toEqual({ condition: "10 or more gates (has 0)", met: false });
    expect(checkWinCondition(s, s.cards[helix]!)).toEqual({ condition: "100 or more tower counters (has 0)", met: false });
    expect(checkWinCondition(s, s.cards[mortal]!)).toMatchObject({ condition: "20 or more creature cards in your graveyard (has 0)", met: false });
    expect(checkWinCondition(s, s.cards[oracle]!)).toBeNull(); // not a static pattern we read
    // Felidar's condition is met from the start: an advisory for Alex only.
    expect(s.winAdvisories).toEqual([{ id: `${felidar}:win`, iid: felidar, controller: A, name: "Felidar Sovereign", condition: "40 or more life (has 40)" }]);
    s = g.push(A, { type: "LifeChanged", payload: { player: A, delta: -1 } });
    expect(s.winAdvisories).toEqual([]);
    // Twenty charge counters later the Reactor's prompt appears; dismissing hides it, claiming ends the game.
    s = g.push(A, { type: "CounterChanged", payload: { iid: reactor, kind: "charge", delta: 20 } });
    expect(s.winAdvisories.map((w) => w.iid)).toEqual([reactor]);
    expect(() => g.push(B, { type: "WinClaimed", payload: { iid: reactor } })).toThrow(/controller/);
    expect(() => g.push(A, { type: "WinClaimed", payload: { iid: felidar } })).toThrow(/no win condition/);
    expect(() => g.push(B, { type: "WinAdvisoryDismissed", payload: { iid: reactor } })).toThrow(/controller/);
    s = g.push(A, { type: "WinAdvisoryDismissed", payload: { iid: reactor } });
    expect(s.winAdvisories).toEqual([]);
    s = g.push(A, { type: "Revert", payload: { toSeq: s.seq - 1 } });
    expect(s.winAdvisories.map((w) => w.iid)).toEqual([reactor]);
    s = g.push(A, { type: "WinClaimed", payload: { iid: reactor } });
    expect(s.phase).toBe("ended");
    expect(s.winner).toBe(A);
    expect(g.last()).toBe("Alex won the game with Darksteel Reactor (20 or more charge counters (has 20))");
    expect(viewFor(s, B).view.winAdvisories).toEqual([]);
    expect(replay(g.events, SEED)).toEqual(g.state);
  });
});
