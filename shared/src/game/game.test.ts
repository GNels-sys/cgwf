import { describe, expect, it } from "vitest";
import type { CardPrinting } from "../cards.js";
import { applyEvent, replay } from "./reducer.js";
import { nextInt, seedFromString, shuffle } from "./rng.js";
import { SYSTEM_ACTOR, type EventInput, type GameEvent, type GameState, type GameStartedPayload } from "./types.js";
import { viewFor } from "./view.js";

let printingSeq = 0;
function printing(name: string, typeLine = "Creature — Test", faces = 1): CardPrinting {
  printingSeq++;
  const face = (n: string) => ({
    name: n,
    manaCost: "{1}",
    typeLine,
    oracleText: "",
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    colors: [],
    artist: null,
    hasOwnImage: faces > 1,
  });
  return {
    id: `00000000-0000-4000-8000-${String(printingSeq).padStart(12, "0")}`,
    oracleId: null,
    name,
    set: "tst",
    setName: "Test",
    collectorNumber: String(printingSeq),
    releasedAt: "2026-01-01",
    rarity: "common",
    layout: faces > 1 ? "transform" : "normal",
    manaCost: "{1}",
    cmc: 1,
    typeLine,
    oracleText: "",
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    colors: [],
    colorIdentity: [],
    keywords: [],
    legalities: {},
    faces: faces > 1 ? [face(name), face(`${name} (back)`)] : [],
    isToken: false,
    isPromo: false,
    isDigital: false,
    artist: null,
    scryfallUri: "",
  };
}

const A = "user-a";
const B = "user-b";
const SEED = "test-seed-123";

/** Each library card has a unique secret name so leaks are easy to grep for. */
function startPayload(): GameStartedPayload {
  const lib = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => printing(`${prefix} Secret ${i + 1}`, i % 3 === 0 ? "Land" : "Creature — Test"));
  return {
    players: [
      { id: A, name: "Alex", seat: 0 },
      { id: B, name: "Blair", seat: 1 },
    ],
    decks: {
      [A]: { library: lib("Alpha", 12), commanders: [printing("Alpha Commander", "Legendary Creature — Test")] },
      [B]: { library: lib("Bravo", 12), commanders: [printing("Bravo Commander", "Legendary Creature — Test")] },
    },
    startingLife: 40,
  };
}

class Game {
  events: GameEvent[] = [];
  state: GameState | null = null;
  constructor(public seed = SEED) {}
  push(actor: string, input: EventInput): GameState {
    const ev = { ...input, seq: this.events.length + 1, actor, ts: 1000 + this.events.length } as GameEvent;
    this.events.push(ev);
    this.state = ev.type === "Revert" ? replay(this.events, this.seed) : applyEvent(this.state, ev, this.seed);
    return this.state!;
  }
  start(): GameState {
    return this.push(SYSTEM_ACTOR, { type: "GameStarted", payload: startPayload() });
  }
  keepAll(): GameState {
    this.push(A, { type: "HandKept", payload: { player: A } });
    return this.push(B, { type: "HandKept", payload: { player: B } });
  }
}

describe("seeded rng", () => {
  it("is deterministic and well spread", () => {
    const s = seedFromString("hello");
    expect(seedFromString("hello")).toBe(s);
    const [a1, s1] = nextInt(s, 1000);
    const [a2] = nextInt(s, 1000);
    expect(a1).toBe(a2);
    expect(s1).not.toBe(s);
    const seen = new Set<number>();
    let st = s;
    for (let i = 0; i < 200; i++) {
      let v: number;
      [v, st] = nextInt(st, 6);
      seen.add(v);
    }
    expect(seen.size).toBe(6);
  });

  it("shuffles the same way for the same seed and differently for another", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const [x] = shuffle(items, seedFromString("one"));
    const [y] = shuffle(items, seedFromString("one"));
    const [z] = shuffle(items, seedFromString("two"));
    expect(x).toEqual(y);
    expect(x).not.toEqual(z);
    expect(x.slice().sort((a, b) => a - b)).toEqual(items);
  });
});

describe("reducer", () => {
  it("starts a game: shuffled libraries, seven in hand, commanders in the command zone, random first player", () => {
    printingSeq = 0;
    const g = new Game();
    const s = g.start();
    expect(s.phase).toBe("mulligan");
    for (const id of [A, B]) {
      const p = s.players[id]!;
      expect(p.zones.hand).toHaveLength(7);
      expect(p.zones.library).toHaveLength(5);
      expect(p.zones.command).toHaveLength(1);
      expect(s.cards[p.zones.command[0]!]!.isCommander).toBe(true);
    }
    expect([A, B]).toContain(s.activePlayer);
    // The same seed starts the same way; another seed does not (very likely).
    printingSeq = 0;
    const again = new Game().start();
    expect(again.players[A]!.zones.library).toEqual(s.players[A]!.zones.library);
    printingSeq = 0;
    const other = new Game("different").start();
    const namesOf = (st: GameState, iids: string[]) => iids.map((i) => st.cards[i]!.printing!.name);
    expect(namesOf(other, other.players[A]!.zones.hand)).not.toEqual(namesOf(s, s.players[A]!.zones.hand));
  });

  it("replays the log to the identical state", () => {
    const g = new Game();
    g.start();
    g.keepAll();
    const a = g.state!.players[A]!;
    g.push(A, { type: "CardsDrawn", payload: { player: A, count: 2 } });
    g.push(A, { type: "CardMoved", payload: { iid: a.zones.hand[0]!, to: { kind: "battlefield", owner: A } } });
    g.push(A, { type: "DiceRolled", payload: { player: A, sides: 20 } });
    g.push(B, { type: "LibraryShuffled", payload: { player: B } });
    g.push(A, { type: "LifeChanged", payload: { player: A, delta: -3 } });
    const replayed = replay(g.events, SEED);
    expect(replayed).toEqual(g.state);
  });

  it("mulligan: London style, keeps count, game begins when everyone kept", () => {
    const g = new Game();
    g.start();
    const before = g.state!.players[A]!.zones.hand.slice();
    let s = g.push(A, { type: "Mulligan", payload: { player: A } });
    expect(s.players[A]!.mulligans).toBe(1);
    expect(s.players[A]!.zones.hand).toHaveLength(7);
    expect(s.players[A]!.zones.hand).not.toEqual(before);
    expect(() => g.push(B, { type: "Mulligan", payload: { player: A } })).toThrow(/only/);
    s = g.keepAll();
    expect(s.phase).toBe("playing");
    expect(s.turn).toBe(1);
    expect(() => g.push(A, { type: "Mulligan", payload: { player: A } })).toThrow(/over/);
  });

  it("protects hidden zones: nobody touches another player's hand or library", () => {
    const g = new Game();
    g.start();
    g.keepAll();
    const bHand = g.state!.players[B]!.zones.hand[0]!;
    expect(() => g.push(A, { type: "CardMoved", payload: { iid: bHand, to: { kind: "graveyard", owner: B } } })).toThrow(/only the owner/);
    expect(() => g.push(A, { type: "CardsDrawn", payload: { player: B, count: 1 } })).toThrow(/only/);
    expect(() => g.push(A, { type: "LibraryLooked", payload: { player: B, count: 3 } })).toThrow(/only/);
    expect(() => g.push(A, { type: "LibraryShuffled", payload: { player: B } })).toThrow(/only/);
    // B may do all of that for themself.
    g.push(B, { type: "CardMoved", payload: { iid: bHand, to: { kind: "graveyard", owner: B } } });
    g.push(B, { type: "LibraryLooked", payload: { player: B, count: 2 } });
  });

  it("moves cards between zones with library positions, tap/untap, counters, tokens, attachments", () => {
    const g = new Game();
    g.start();
    g.keepAll();
    let s = g.state!;
    const a = () => s.players[A]!;
    const land = a().zones.hand.map((i) => s.cards[i]!).find((c) => /Land/.test(c.printing!.typeLine));
    const creature = a().zones.hand.map((i) => s.cards[i]!).find((c) => /Creature/.test(c.printing!.typeLine))!;
    if (land) {
      s = g.push(A, { type: "CardMoved", payload: { iid: land.iid, to: { kind: "battlefield", owner: A } } });
      expect(a().zones.battlefield.lands).toContain(land.iid);
    }
    s = g.push(A, { type: "CardMoved", payload: { iid: creature.iid, to: { kind: "battlefield", owner: A } } });
    expect(a().zones.battlefield.creatures).toContain(creature.iid);
    expect(s.log.at(-1)!.text).toContain(`plays ${creature.printing!.name}`);

    s = g.push(A, { type: "CardTapped", payload: { iid: creature.iid, tapped: true } });
    expect(s.cards[creature.iid]!.tapped).toBe(true);
    s = g.push(A, { type: "CounterChanged", payload: { iid: creature.iid, kind: "+1/+1", delta: 2 } });
    expect(s.cards[creature.iid]!.counters["+1/+1"]).toBe(2);
    s = g.push(B, { type: "UntapAll", payload: { player: A } });
    expect(s.cards[creature.iid]!.tapped).toBe(false);

    // Token + attach: the token follows the host when it changes rows / controller.
    s = g.push(A, { type: "TokenCreated", payload: { player: A, printing: null, custom: { name: "Equipment", typeLine: "Artifact — Equipment", power: null, toughness: null, colors: [], text: "" }, count: 1, row: "other" } });
    const token = a().zones.battlefield.other.at(-1)!;
    s = g.push(A, { type: "Attached", payload: { iid: token, to: creature.iid } });
    expect(s.cards[token]!.zone.row).toBe("creatures");
    s = g.push(B, { type: "CardMoved", payload: { iid: creature.iid, to: { kind: "battlefield", owner: B, row: "creatures" } } });
    expect(s.players[B]!.zones.battlefield.creatures).toContain(token);
    expect(s.cards[token]!.attachedTo).toBe(creature.iid);
    // Counters survive a control change; when the host leaves the battlefield the equipment stays, unattached.
    expect(s.cards[creature.iid]!.counters["+1/+1"]).toBe(2);
    s = g.push(A, { type: "CardMoved", payload: { iid: creature.iid, to: { kind: "graveyard", owner: A } } });
    expect(s.cards[token]!.attachedTo).toBeNull();
    expect(s.cards[creature.iid]!.counters).toEqual({});
    // A token leaving the battlefield ceases to exist.
    s = g.push(A, { type: "CardMoved", payload: { iid: token, to: { kind: "graveyard", owner: A } } });
    expect(s.cards[token]).toBeUndefined();
    expect(a().zones.graveyard).not.toContain(token);

    // Library top / bottom.
    const fromGy = creature.iid;
    s = g.push(A, { type: "CardMoved", payload: { iid: fromGy, to: { kind: "library", owner: A, position: "bottom" } } });
    expect(a().zones.library.at(-1)).toBe(fromGy);
    s = g.push(A, { type: "CardMoved", payload: { iid: fromGy, to: { kind: "library", owner: A, position: "top" } } });
    expect(a().zones.library[0]).toBe(fromGy);
    s = g.push(A, { type: "Milled", payload: { player: A, count: 1 } });
    expect(a().zones.graveyard.at(-1)).toBe(fromGy);
  });

  it("tracks turns, steps, life, commander damage and tax, concession ends the game", () => {
    const g = new Game();
    g.start();
    let s = g.keepAll();
    const first = s.activePlayer;
    s = g.push(first, { type: "StepAdvanced", payload: {} });
    expect(s.step).toBe("upkeep");
    s = g.push(first, { type: "TurnAdvanced", payload: {} });
    expect(s.turn).toBe(2);
    expect(s.activePlayer).not.toBe(first);
    expect(s.step).toBe("untap");
    s = g.push(first, { type: "StepSet", payload: { step: "main2" } });
    expect(s.step).toBe("main2");

    s = g.push(A, { type: "LifeChanged", payload: { player: A, delta: -7 } });
    expect(s.players[A]!.life).toBe(33);
    s = g.push(A, { type: "LifeChanged", payload: { player: A, value: 20 } });
    expect(s.players[A]!.life).toBe(20);
    s = g.push(A, { type: "PlayerCounterChanged", payload: { player: A, kind: "poison", delta: 2 } });
    expect(s.players[A]!.counters.poison).toBe(2);
    const bCmd = s.players[B]!.zones.command[0]!;
    s = g.push(A, { type: "CommanderDamage", payload: { player: A, commanderIid: bCmd, delta: 5 } });
    expect(s.players[A]!.commanderDamage[bCmd]).toBe(5);
    s = g.push(B, { type: "CommanderTaxChanged", payload: { player: B, commanderIid: bCmd, delta: 2 } });
    expect(s.players[B]!.commanderTax[bCmd]).toBe(2);
    expect(() => g.push(A, { type: "CommanderTaxChanged", payload: { player: A, commanderIid: bCmd, delta: 2 } })).toThrow();

    s = g.push(B, { type: "PlayerConceded", payload: { player: B } });
    expect(s.phase).toBe("ended");
    expect(s.winner).toBe(A);
    expect(() => g.push(A, { type: "CardsDrawn", payload: { player: A, count: 1 } })).toThrow(/over/);
  });

  it("dice and coins come from the seeded rng", () => {
    const g1 = new Game();
    g1.start();
    g1.keepAll();
    const g2 = new Game();
    printingSeq -= 26; // same printing ids as g1
    g2.start();
    g2.keepAll();
    for (let i = 0; i < 5; i++) {
      const a = g1.push(A, { type: "DiceRolled", payload: { player: A, sides: 20 } }).log.at(-1)!.text;
      const b = g2.push(A, { type: "DiceRolled", payload: { player: A, sides: 20 } }).log.at(-1)!.text;
      expect(a).toBe(b);
      expect(a).toMatch(/rolls a d20: \d+/);
    }
    expect(g1.push(A, { type: "CoinFlipped", payload: { player: A } }).log.at(-1)!.text).toMatch(/heads|tails/);
    expect(g1.push(A, { type: "RandomOpponent", payload: { player: A } }).log.at(-1)!.text).toContain("Blair");
  });

  it("Revert rewinds to a seq and later events continue from there; undo is a Revert", () => {
    const g = new Game();
    g.start();
    g.keepAll(); // seq 3
    const hand0 = g.state!.players[A]!.zones.hand[0]!;
    g.push(A, { type: "CardMoved", payload: { iid: hand0, to: { kind: "battlefield", owner: A } } }); // 4
    g.push(A, { type: "LifeChanged", payload: { player: A, delta: -5 } }); // 5
    let s = g.push(A, { type: "Revert", payload: { toSeq: 4, reason: "undo" } }); // 6
    expect(s.players[A]!.life).toBe(40);
    expect(s.cards[hand0]!.zone.kind).toBe("battlefield");
    expect(s.seq).toBe(6);
    expect(s.log.at(-1)!.text).toContain("undoes");
    s = g.push(A, { type: "LifeChanged", payload: { player: A, delta: -1 } }); // 7
    expect(s.players[A]!.life).toBe(39);
    s = g.push(B, { type: "Revert", payload: { toSeq: 3 } }); // 8
    expect(s.cards[hand0]!.zone.kind).toBe("hand");
    expect(s.players[A]!.life).toBe(40);
    expect(replay(g.events, SEED)).toEqual(s);
  });
});

describe("per-player view (hidden information)", () => {
  function secretsOf(state: GameState, pred: (c: GameState["cards"][string]) => boolean): string[] {
    return Object.values(state.cards)
      .filter(pred)
      .map((c) => c.printing!.name);
  }
  function serialized(state: GameState, viewer: string | null): string {
    const { view, printings } = viewFor(state, viewer);
    return JSON.stringify({ view, printings: Object.fromEntries(printings) });
  }

  it("never leaks libraries, other hands or face-down cards, while own hand and public zones show", () => {
    const g = new Game();
    g.start();
    let s = g.keepAll();
    const aHand = s.players[A]!.zones.hand[0]!;
    const aHand2 = s.players[A]!.zones.hand[1]!;
    s = g.push(A, { type: "CardMoved", payload: { iid: aHand, to: { kind: "battlefield", owner: A } } });
    s = g.push(A, { type: "CardMoved", payload: { iid: aHand2, to: { kind: "battlefield", owner: A, faceDown: true } } });

    const libraryNames = secretsOf(s, (c) => c.zone.kind === "library");
    const aHandNames = secretsOf(s, (c) => c.zone.kind === "hand" && c.zone.owner === A);
    const bHandNames = secretsOf(s, (c) => c.zone.kind === "hand" && c.zone.owner === B);
    const faceDownName = s.cards[aHand2]!.printing!.name;
    const playedName = s.cards[aHand]!.printing!.name;
    expect(libraryNames.length).toBeGreaterThan(0);

    const forA = serialized(s, A);
    const forB = serialized(s, B);
    const forSpectator = serialized(s, null);

    for (const text of [forA, forB, forSpectator]) {
      for (const name of libraryNames) expect(text).not.toContain(name);
      expect(text).toContain(playedName);
    }
    for (const name of aHandNames) {
      expect(forA).toContain(name);
      expect(forB).not.toContain(name);
      expect(forSpectator).not.toContain(name);
    }
    for (const name of bHandNames) {
      expect(forB).toContain(name);
      expect(forA).not.toContain(name);
    }
    expect(forA).toContain(faceDownName);
    expect(forB).not.toContain(faceDownName);
    expect(forSpectator).not.toContain(faceDownName);

    // Counts are still visible and the face-down card is listed (identity-less) for everyone.
    const vb = viewFor(s, B).view;
    expect(vb.players[A]!.hand.count).toBe(5);
    expect(vb.players[A]!.hand.cards).toHaveLength(0);
    expect(vb.players[A]!.library.count).toBe(5);
    expect(vb.players[A]!.library.known).toHaveLength(0);
    const fd = vb.players[A]!.battlefield.creatures.concat(vb.players[A]!.battlefield.lands, vb.players[A]!.battlefield.other).find((c) => c.iid === aHand2)!;
    expect(fd.faceDown).toBe(true);
    expect(fd.printingId).toBeNull();
    expect(fd.public).toBe(false);
    // The rng state and seed are not part of any view.
    expect(forA).not.toContain('"rng"');
    expect(forA).not.toContain(SEED);
  });

  it("reveals: look-at-top shows the owner only, reveal-top shows everyone, shuffle forgets", () => {
    const g = new Game();
    g.start();
    let s = g.keepAll();
    s = g.push(A, { type: "LibraryLooked", payload: { player: A, count: 2 } });
    const top2 = s.players[A]!.zones.library.slice(0, 2).map((i) => s.cards[i]!.printing!.name);
    const forA = serialized(s, A);
    const forB = serialized(s, B);
    for (const n of top2) {
      expect(forA).toContain(n);
      expect(forB).not.toContain(n);
    }
    expect(viewFor(s, A).view.players[A]!.library.known.map((c) => c.position)).toEqual([0, 1]);

    s = g.push(A, { type: "LibraryRevealed", payload: { player: A, count: 1 } });
    expect(serialized(s, B)).toContain(top2[0]!);
    expect(serialized(s, null)).toContain(top2[0]!);
    expect(serialized(s, B)).not.toContain(top2[1]!);

    s = g.push(A, { type: "LibrarySearched", payload: { player: A } });
    expect(viewFor(s, A).view.players[A]!.library.known).toHaveLength(5);
    expect(viewFor(s, B).view.players[A]!.library.known).toHaveLength(1);

    s = g.push(A, { type: "LibraryShuffled", payload: { player: A } });
    expect(viewFor(s, A).view.players[A]!.library.known).toHaveLength(0);
    // (The log keeps the earlier public reveal, which is history everyone saw; the zones must not.)
    const noLog = (viewer: string) => {
      const { view, printings } = viewFor(s, viewer);
      return JSON.stringify({ view: { ...view, log: [] }, printings: Object.fromEntries(printings) });
    };
    for (const iid of s.players[A]!.zones.library) {
      expect(noLog(A)).not.toContain(s.cards[iid]!.printing!.name);
      expect(noLog(B)).not.toContain(s.cards[iid]!.printing!.name);
    }

    // Revealing a hand card shows it to everyone; drawing it back hides it again.
    const h = s.players[A]!.zones.hand[0]!;
    const hName = s.cards[h]!.printing!.name;
    s = g.push(A, { type: "CardRevealed", payload: { iid: h } });
    expect(serialized(s, B)).toContain(hName);
    expect(viewFor(s, B).view.players[A]!.hand.cards.map((c) => c.iid)).toEqual([h]);
  });

  it("log lines never name hidden cards", () => {
    const g = new Game();
    g.start();
    let s = g.keepAll();
    const h = s.players[A]!.zones.hand[0]!;
    s = g.push(A, { type: "CardMoved", payload: { iid: h, to: { kind: "battlefield", owner: A, faceDown: true } } });
    expect(s.log.at(-1)!.text).toBe("Alex plays a card face down");
    s = g.push(A, { type: "CardMoved", payload: { iid: h, to: { kind: "hand", owner: A } } });
    expect(s.log.at(-1)!.text).toContain("moves a card");
    s = g.push(A, { type: "CardsDrawn", payload: { player: A, count: 1 } });
    expect(s.log.at(-1)!.text).toBe("Alex draws a card");
    expect(s.log.map((l) => l.text).join("\n")).not.toContain("Secret");
  });
});
