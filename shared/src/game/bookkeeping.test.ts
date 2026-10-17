import { describe, expect, it } from "vitest";
import type { CardPrinting } from "../cards.js";
import { deriveBattlefield, describeAnthems, parseAnthem, parseAttachmentEffect, parseKeywordList } from "./effects.js";
import { applyEvent, replay } from "./reducer.js";
import { defaultSection } from "./sections.js";
import { etbListeners, hasSelfEtb } from "./triggers.js";
import { SYSTEM_ACTOR, type EventInput, type GameEvent, type GameState, type GameStartedPayload } from "./types.js";

// Real oracle texts (Scryfall wording).
const TEXT = {
  lotusCobra: "Landfall — Whenever a land you control enters, add one mana of any color.",
  gloriousAnthem: "Creatures you control get +1/+1.",
  intangibleVirtue: "Creature tokens you control get +1/+1 and have vigilance.",
  greaves: "Equipped creature has haste and shroud. (It can't be the target of spells or abilities.)\nEquip {0}",
  rancor: "Enchant creature\nEnchanted creature gets +2/+0 and has trample.\nWhen Rancor is put into a graveyard from the battlefield, return Rancor to its owner's hand.",
  swiftfoot: "Flash\nEquipped creature has hexproof and haste.\nEquip {1}",
  scuteSwarm: "Landfall — Whenever a land you control enters, create a 1/1 green Insect creature token. If you control six or more lands, create a token that's a copy of Scute Swarm instead.",
  tracker: "Landfall — Whenever a land you control enters, investigate.\nWhenever you sacrifice a Clue, put a +1/+1 counter on Tireless Tracker.",
  soulWarden: "Whenever another creature enters, you gain 1 life.",
  mycosynth: "Whenever an artifact enters the battlefield under your control, you may draw a card.",
  eidolon: "Constellation — Whenever an enchantment you control enters, you may draw a card.",
  mulldrifter: "Flying\nWhen Mulldrifter enters, draw two cards.",
  newTemplate: "When this creature enters, create a Treasure token.",
  phyrexianArena: "At the beginning of your upkeep, you draw a card and you lose 1 life.",
  howlingMine: "At the beginning of each player's draw step, if Howling Mine is untapped, that player draws an additional card.",
  heliod: "Other creatures you control get +1/+1 and have lifelink.",
  craterhoof: "Haste\nWhen Craterhoof Behemoth enters, creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control.",
  swordFF: "Equipped creature gets +2/+2 and has protection from red and from blue.\nWhenever equipped creature deals combat damage to a player, you may destroy target artifact. Draw a card.\nEquip {2}",
};

let n = 0;
function printing(name: string, typeLine: string, oracleText: string, opts: { power?: string; toughness?: string; keywords?: string[] } = {}): CardPrinting {
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

describe("sections", () => {
  it("defaults from the type line", () => {
    expect(defaultSection("Creature — Snake")).toBe("creatures");
    expect(defaultSection("Artifact Creature — Golem")).toBe("creatures");
    expect(defaultSection("Enchantment Creature — Nymph")).toBe("creatures");
    expect(defaultSection("Legendary Creature — Phyrexian Angel Horror")).toBe("creatures");
    expect(defaultSection("Basic Land — Forest")).toBe("lands");
    expect(defaultSection("Artifact Land")).toBe("lands");
    expect(defaultSection("Artifact — Equipment")).toBe("artifacts");
    expect(defaultSection("Artifact — Vehicle")).toBe("artifacts");
    expect(defaultSection("Artifact")).toBe("artifacts");
    expect(defaultSection("Enchantment — Aura")).toBe("enchantments");
    expect(defaultSection("Legendary Enchantment")).toBe("enchantments");
    expect(defaultSection("Legendary Planeswalker — Jace")).toBe("other");
    expect(defaultSection("Battle — Siege")).toBe("other");
    expect(defaultSection("Instant")).toBe("other");
    expect(defaultSection("Creature — Human // Instant — Adventure")).toBe("creatures");
  });
});

describe("attachment effect parser", () => {
  it("reads +X/+Y and keyword grants from equipment and auras", () => {
    expect(parseAttachmentEffect(TEXT.rancor)).toEqual({ power: 2, toughness: 0, keywords: ["trample"] });
    expect(parseAttachmentEffect(TEXT.greaves)).toEqual({ power: 0, toughness: 0, keywords: ["haste", "shroud"] });
    expect(parseAttachmentEffect(TEXT.swiftfoot)).toEqual({ power: 0, toughness: 0, keywords: ["hexproof", "haste"] });
    expect(parseAttachmentEffect(TEXT.swordFF)).toEqual({ power: 2, toughness: 2, keywords: ["protection from red", "protection from blue"] });
    expect(parseAttachmentEffect("Enchanted creature gets -2/-2.")).toEqual({ power: -2, toughness: -2, keywords: [] });
    expect(parseAttachmentEffect("Enchanted creature has hexproof.")).toEqual({ power: 0, toughness: 0, keywords: ["hexproof"] });
    expect(parseAttachmentEffect("Enchant creature\nEnchanted creature can't attack or block.")).toBeNull();
    expect(parseAttachmentEffect(TEXT.lotusCobra)).toBeNull();
  });

  it("parses keyword lists and drops things that are not keywords", () => {
    expect(parseKeywordList("flying, first strike and haste")).toEqual(["flying", "first strike", "haste"]);
    expect(parseKeywordList("haste and can't be blocked")).toEqual(["haste"]);
    expect(parseKeywordList("ward {2}")).toEqual(["ward {2}"]);
    expect(parseKeywordList("flying and flying")).toEqual(["flying"]);
  });
});

describe("anthem parser", () => {
  it("detects static anthems and respects 'other'; skips temporary and conditional ones", () => {
    expect(parseAnthem(TEXT.gloriousAnthem)).toEqual({ power: 1, toughness: 1, keywords: [], other: false });
    expect(parseAnthem(TEXT.heliod)).toEqual({ power: 1, toughness: 1, keywords: ["lifelink"], other: true });
    expect(parseAnthem("Creatures you control have haste.")).toEqual({ power: 0, toughness: 0, keywords: ["haste"], other: false });
    expect(parseAnthem(TEXT.craterhoof)).toBeNull();
    expect(parseAnthem("Creatures you control get +1/+1 as long as you control an artifact.")).toBeNull();
    // Token-only anthems are not the general form and are left to the player.
    expect(parseAnthem(TEXT.intangibleVirtue)).toBeNull();
  });
});

describe("trigger text matchers", () => {
  it("recognises the ETB families", () => {
    expect(etbListeners(TEXT.lotusCobra, ["Landfall"]).map((l) => l.kind)).toEqual(["Landfall"]);
    expect(etbListeners(TEXT.scuteSwarm, [])).toEqual([{ kind: "Landfall", another: false }]);
    expect(etbListeners(TEXT.soulWarden, [])).toEqual([{ kind: "Creature ETB", another: true }]);
    expect(etbListeners(TEXT.mycosynth, [])).toEqual([{ kind: "Artifact ETB", another: false }]);
    expect(etbListeners(TEXT.eidolon, ["Constellation"]).map((l) => l.kind)).toEqual(["Constellation"]);
    expect(etbListeners(TEXT.gloriousAnthem, [])).toEqual([]);
  });
  it("recognises the card's own ETB in old and new templating", () => {
    expect(hasSelfEtb(TEXT.mulldrifter, "Mulldrifter")).toBe(true);
    expect(hasSelfEtb(TEXT.newTemplate, "Whatever")).toBe(true);
    expect(hasSelfEtb("When Atraxa, Praetors' Voice enters, proliferate.", "Atraxa, Praetors' Voice")).toBe(true);
    expect(hasSelfEtb(TEXT.lotusCobra, "Lotus Cobra")).toBe(false);
  });
});

// ---------------------------------------------------------------- reducer-level

const A = "user-a";
const B = "user-b";
const SEED = "seed-bookkeeping";

function payload(): GameStartedPayload {
  // Libraries are all Forests so whatever is drawn, "play a card from hand" is a land drop.
  const filler = (_prefix: string, k: number) => Array.from({ length: k }, () => printing("Forest", "Basic Land — Forest", "({T}: Add {G}.)"));
  return {
    players: [
      { id: A, name: "Alex", seat: 0 },
      { id: B, name: "Blair", seat: 1 },
    ],
    decks: {
      [A]: { library: filler("A", 10), commanders: [printing("Alpha Commander", "Legendary Creature — Test", "", { power: "3", toughness: "3" })] },
      [B]: { library: filler("B", 10), commanders: [printing("Bravo Commander", "Legendary Creature — Test", "", { power: "3", toughness: "3" })] },
    },
    startingLife: 40,
  };
}

class Game {
  events: GameEvent[] = [];
  state: GameState | null = null;
  push(actor: string, input: EventInput): GameState {
    const ev = { ...input, seq: this.events.length + 1, actor, ts: 1000 + this.events.length } as GameEvent;
    this.events.push(ev);
    try {
      this.state = ev.type === "Revert" ? replay(this.events, SEED) : applyEvent(this.state, ev, SEED);
    } catch (err) {
      this.events.pop(); // a rejected event never reaches the log
      throw err;
    }
    return this.state!;
  }
  start(): GameState {
    this.push(SYSTEM_ACTOR, { type: "GameStarted", payload: payload() });
    this.push(A, { type: "HandKept", payload: { player: A } });
    return this.push(B, { type: "HandKept", payload: { player: B } });
  }
  /** Put a fresh card straight onto A's battlefield via a custom token with real printing data is not possible, so use a token with the card's text. */
  token(owner: string, p: CardPrinting): string {
    const before = new Set(Object.keys(this.state!.cards));
    const s = this.push(owner, { type: "TokenCreated", payload: { player: owner, printing: p, custom: null, count: 1, row: defaultSection(p.typeLine) } });
    return Object.keys(s.cards).find((iid) => !before.has(iid))!;
  }
}

describe("reducer: sections, attachments, anthems, modifiers", () => {
  it("places cards by type and keeps attachments under the host, re-sectioning on detach", () => {
    const g = new Game();
    let s = g.start();
    const cobra = g.token(A, printing("Lotus Cobra", "Creature — Snake", TEXT.lotusCobra, { power: "2", toughness: "1", keywords: ["Landfall"] }));
    const greaves = g.token(A, printing("Lightning Greaves", "Artifact — Equipment", TEXT.greaves, { keywords: ["Equip"] }));
    const rancor = g.token(A, printing("Rancor", "Enchantment — Aura", TEXT.rancor, { keywords: ["Enchant"] }));
    s = g.state!;
    const bf = () => s.players[A]!.zones.battlefield;
    expect(bf().creatures).toContain(cobra);
    expect(bf().artifacts).toContain(greaves);
    expect(bf().enchantments).toContain(rancor);

    s = g.push(A, { type: "Attached", payload: { iid: greaves, to: cobra, effect: parseAttachmentEffect(TEXT.greaves) } });
    expect(bf().creatures).toContain(greaves);
    expect(bf().artifacts).not.toContain(greaves);
    expect(s.cards[greaves]!.effect).toEqual({ power: 0, toughness: 0, keywords: ["haste", "shroud"] });
    expect(s.log.at(-1)!.text).toContain("haste, shroud");
    s = g.push(A, { type: "Attached", payload: { iid: rancor, to: cobra, effect: { power: 2, toughness: 0, keywords: ["trample"] } } });

    const d = deriveBattlefield(
      Object.values(bf())
        .flat()
        .map((iid) => s.cards[iid]!),
      (c) => (c as { printing: CardPrinting | null }).printing,
      s.players[A]!.manualAnthems,
    );
    const cobraD = d.cards.get(cobra)!;
    expect(cobraD.power).toBe(4);
    expect(cobraD.toughness).toBe(1);
    expect(cobraD.keywords).toEqual(["landfall", "haste", "shroud", "trample"]);
    expect(cobraD.attachments).toEqual([greaves, rancor]);

    // Detach -> back to Artifacts, effect gone.
    s = g.push(A, { type: "Attached", payload: { iid: greaves, to: null } });
    expect(bf().artifacts).toContain(greaves);
    expect(s.cards[greaves]!.effect).toBeNull();
    // Host moves rows: the aura follows. Host leaves: the aura is unattached and re-sectioned.
    s = g.push(A, { type: "CardMoved", payload: { iid: cobra, to: { kind: "battlefield", owner: A, row: "other" } } });
    expect(bf().other).toEqual(expect.arrayContaining([cobra, rancor]));
    s = g.push(A, { type: "CardMoved", payload: { iid: cobra, to: { kind: "graveyard", owner: A } } });
    expect(s.cards[rancor]!.attachedTo).toBeNull();
    expect(bf().enchantments).toContain(rancor);
  });

  it("anthems, manual anthems, dismissal and manual modifiers feed the derived stats", () => {
    const g = new Game();
    let s = g.start();
    const bear = g.token(A, printing("Grizzly Bears", "Creature — Bear", "", { power: "2", toughness: "2" }));
    const anthem = g.token(A, printing("Glorious Anthem", "Enchantment", TEXT.gloriousAnthem));
    const heliod = g.token(A, printing("Heliod", "Legendary Enchantment Creature — God", TEXT.heliod, { power: "5", toughness: "6", keywords: ["Indestructible"] }));
    s = g.state!;
    const derive = () =>
      deriveBattlefield(
        Object.values(s.players[A]!.zones.battlefield)
          .flat()
          .map((iid) => s.cards[iid]!),
        (c) => (c as { printing: CardPrinting | null }).printing,
        s.players[A]!.manualAnthems,
      );
    let d = derive();
    expect(d.anthems.map((a) => a.name)).toEqual(["Glorious Anthem", "Heliod"]);
    expect(d.cards.get(bear)!.power).toBe(4);
    expect(d.cards.get(bear)!.keywords).toEqual(["lifelink"]);
    // "Other creatures": Heliod gets Glorious Anthem but not itself.
    expect(d.cards.get(heliod)!.power).toBe(6);
    expect(d.cards.get(heliod)!.keywords).toEqual(["indestructible"]);
    expect(describeAnthems(d)).toBe("+2/+2, lifelink (Glorious Anthem, Heliod)");

    s = g.push(A, { type: "AnthemDismissed", payload: { iid: anthem, dismissed: true } });
    d = derive();
    expect(d.cards.get(bear)!.power).toBe(3);
    s = g.push(A, { type: "ManualAnthemAdded", payload: { player: A, power: 2, toughness: 2, keywords: ["trample"], note: "Overrun" } });
    d = derive();
    expect(d.cards.get(bear)!.power).toBe(5);
    expect(d.cards.get(bear)!.keywords).toEqual(["lifelink", "trample"]);
    const id = s.players[A]!.manualAnthems[0]!.id;
    s = g.push(A, { type: "ManualAnthemRemoved", payload: { player: A, id } });
    expect(s.players[A]!.manualAnthems).toHaveLength(0);

    s = g.push(A, { type: "CounterChanged", payload: { iid: bear, kind: "+1/+1", delta: 2 } });
    s = g.push(A, { type: "CardModifierSet", payload: { iid: bear, modifier: { power: -1, toughness: 0, keywords: ["flying"], removedKeywords: ["lifelink"] } } });
    d = derive();
    expect(d.cards.get(bear)!.power).toBe(2 + 2 + 1 - 1);
    expect(d.cards.get(bear)!.keywords).toEqual(["flying"]);
    // Leaving the battlefield clears modifiers.
    s = g.push(A, { type: "CardMoved", payload: { iid: bear, to: { kind: "hand", owner: A } } });
    expect(s.cards[bear]).toBeUndefined(); // it was a token
    expect(replay(g.events, SEED)).toEqual(s);
  });
});

describe("reducer: triggers", () => {
  it("landfall and ETB families fire for the controller, step triggers for the active player, resolve and dismiss are logged", () => {
    const g = new Game();
    let s = g.start();
    g.token(A, printing("Lotus Cobra", "Creature — Snake", TEXT.lotusCobra, { power: "2", toughness: "1", keywords: ["Landfall"] }));
    g.token(A, printing("Tireless Tracker", "Creature — Human Scout", TEXT.tracker, { power: "3", toughness: "2", keywords: ["Landfall", "Investigate"] }));
    g.token(A, printing("Soul Warden", "Creature — Human Cleric", TEXT.soulWarden, { power: "1", toughness: "1" }));
    g.token(B, printing("Scute Swarm", "Creature — Insect", TEXT.scuteSwarm, { power: "1", toughness: "1", keywords: ["Landfall"] }));
    s = g.push(A, { type: "TriggersDismissed", payload: { player: A } }); // clear the ETB chatter from setup
    s = g.push(B, { type: "TriggersDismissed", payload: { player: B } });
    expect(s.pendingTriggers).toEqual([]);

    // A plays a land: Cobra + Tracker (A's) fire, Scute Swarm (B's) does not, Soul Warden does not.
    const landCard = s.players[A]!.zones.hand[0]!;
    s = g.push(A, { type: "CardMoved", payload: { iid: landCard, to: { kind: "battlefield", owner: A } } });
    expect(s.players[A]!.zones.battlefield.lands).toContain(landCard);
    expect(s.pendingTriggers.map((t) => [t.name, t.kind, t.controller])).toEqual([
      ["Lotus Cobra", "Landfall", A],
      ["Tireless Tracker", "Landfall", A],
    ]);
    const first = s.pendingTriggers[0]!;
    s = g.push(A, { type: "TriggerResolved", payload: { id: first.id } });
    expect(s.pendingTriggers).toHaveLength(1);
    expect(s.log.at(-1)!.text).toBe("Alex resolved Lotus Cobra's landfall trigger");

    // A creature token entering under A's control: Soul Warden ("another creature") fires; its own ETB too.
    g.token(A, printing("Mulldrifter", "Creature — Elemental", TEXT.mulldrifter, { power: "2", toughness: "2", keywords: ["Flying"] }));
    s = g.state!;
    expect(s.pendingTriggers.map((t) => [t.name, t.kind])).toEqual([
      ["Tireless Tracker", "Landfall"],
      ["Soul Warden", "Creature ETB"],
      ["Mulldrifter", "ETB"],
    ]);
    s = g.push(A, { type: "TriggersDismissed", payload: { player: A } });
    expect(s.pendingTriggers).toEqual([]);

    // Step triggers: Phyrexian Arena (yours) fires on A's upkeep only; Howling Mine (each) on everyone's draw step.
    g.token(A, printing("Phyrexian Arena", "Enchantment", TEXT.phyrexianArena));
    g.token(B, printing("Howling Mine", "Artifact", TEXT.howlingMine));
    g.push(A, { type: "TriggersDismissed", payload: { player: A } });
    g.push(B, { type: "TriggersDismissed", payload: { player: B } });
    s = g.state!;
    // Make A the active player: a new turn untaps and lands on upkeep, so upkeep triggers show at once.
    do s = g.push(s.activePlayer, { type: "TurnAdvanced", payload: {} });
    while (s.activePlayer !== A);
    expect(s.step).toBe("upkeep");
    expect(s.pendingTriggers.map((t) => [t.name, t.kind])).toEqual([["Phyrexian Arena", "Upkeep"]]);
    s = g.push(A, { type: "StepAdvanced", payload: {} }); // draw
    expect(s.pendingTriggers.map((t) => t.name)).toEqual(["Phyrexian Arena", "Howling Mine"]);
    s = g.push(A, { type: "TurnAdvanced", payload: {} }); // B's turn clears the list; B's upkeep: Arena is A's -> nothing
    expect(s.pendingTriggers).toEqual([]);
    s = g.push(B, { type: "StepAdvanced", payload: {} }); // B draw: Howling Mine (each)
    expect(s.pendingTriggers.map((t) => t.name)).toEqual(["Howling Mine"]);
    expect(replay(g.events, SEED)).toEqual(s);
  });
});

describe("reducer: mana bank", () => {
  it("adds, spends, converts, empties on step change unless kept, and logs it", () => {
    const g = new Game();
    let s = g.start();
    s = g.push(A, { type: "ManaChanged", payload: { player: A, color: "G", delta: 2 } });
    expect(s.players[A]!.mana.G).toBe(2);
    expect(s.log.at(-1)!.text).toBe("Alex added GG");
    s = g.push(A, { type: "ManaChanged", payload: { player: A, color: "G", delta: -1 } });
    expect(s.log.at(-1)!.text).toBe("Alex spent G");
    s = g.push(A, { type: "ManaChanged", payload: { player: A, color: "G", delta: -5 } });
    expect(s.players[A]!.mana.G).toBe(0);
    s = g.push(A, { type: "ManaChanged", payload: { player: A, color: "W", delta: 1 } });
    s = g.push(A, { type: "ManaChanged", payload: { player: A, color: "U", delta: 2 } });
    s = g.push(A, { type: "ManaConverted", payload: { player: A, to: "C" } });
    expect(s.players[A]!.mana).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 3 });
    expect(s.log.at(-1)!.text).toBe("Alex converted their mana to CCC");
    s = g.push(A, { type: "StepAdvanced", payload: {} });
    expect(s.players[A]!.mana.C).toBe(0);
    expect(s.log.map((l) => l.text)).toContain("Alex's mana emptied (step change)");

    s = g.push(A, { type: "KeepManaToggled", payload: { player: A, keep: true } });
    s = g.push(A, { type: "ManaChanged", payload: { player: A, color: "R", delta: 3 } });
    s = g.push(A, { type: "StepAdvanced", payload: {} });
    expect(s.players[A]!.mana.R).toBe(3);
    s = g.push(A, { type: "TurnAdvanced", payload: {} });
    expect(s.players[A]!.mana.R).toBe(3);
    s = g.push(A, { type: "ManaEmptied", payload: { player: A } });
    expect(s.players[A]!.mana.R).toBe(0);
    expect(s.log.at(-1)!.text).toBe("Alex's mana emptied");
    expect(() => g.push(A, { type: "ManaChanged", payload: { player: A, color: "X" as never, delta: 1 } })).toThrow(/colour/);
    expect(replay(g.events, SEED)).toEqual(s);
  });
});
