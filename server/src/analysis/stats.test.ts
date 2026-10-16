import { describe, expect, it } from "vitest";
import { card } from "./fixtures.js";
import { cardManaValue, computeStats, deckIdentity, frontCost, manaSource, manaValueOf, pipsOf } from "./stats.js";

/**
 * A small hand-written deck (29 cards: a commander, 21 other nonland cards,
 * 7 lands) with real Oracle text. Every expected number below was worked out by
 * hand from the card list, so a regression here means the definition changed.
 */
const DECK = [
  card("Jenara, Asura of War", "Legendary Creature — Angel", "Flying\n{1}{W}: Put a +1/+1 counter on Jenara, Asura of War.", { manaCost: "{G}{W}{U}", cmc: 3, keywords: ["Flying"], colorIdentity: ["G", "U", "W"], power: "3", toughness: "3", board: "commander" }),
  card("Sol Ring", "Artifact", "{T}: Add {C}{C}.", { manaCost: "{1}", cmc: 1 }),
  card("Llanowar Elves", "Creature — Elf Druid", "{T}: Add {G}.", { manaCost: "{G}", cmc: 1, power: "1", toughness: "1" }),
  card("Dark Ritual", "Instant", "Add {B}{B}{B}.", { manaCost: "{B}", cmc: 1 }),
  card("Lightning Bolt", "Instant", "Lightning Bolt deals 3 damage to any target.", { manaCost: "{R}", cmc: 1 }),
  card("Wrath of God", "Sorcery", "Destroy all creatures. They can't be regenerated.", { manaCost: "{2}{W}{W}", cmc: 4 }),
  card("Counterspell", "Instant", "Counter target spell.", { manaCost: "{U}{U}", cmc: 2 }),
  card("Demonic Tutor", "Sorcery", "Search your library for a card, put that card into your hand, then shuffle.", { manaCost: "{1}{B}", cmc: 2 }),
  card("Regrowth", "Sorcery", "Return target card from your graveyard to your hand.", { manaCost: "{1}{G}", cmc: 2 }),
  card("Rampant Growth", "Sorcery", "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.", { manaCost: "{1}{G}", cmc: 2 }),
  card("Fire // Ice", "Instant // Instant", "Fire deals 2 damage divided as you choose among one or two targets.\n//\nTap target permanent.\nDraw a card.", { manaCost: "{1}{R} // {1}{U}", cmc: 4, colors: ["R", "U"] }),
  card("Kitchen Finks", "Creature — Ouphe", "Persist (When this creature dies, if it had no -1/-1 counters on it, return it to the battlefield under its owner's control with a -1/-1 counter on it.)\nWhen Kitchen Finks enters, you gain 2 life.", { manaCost: "{1}{G/W}{G/W}", cmc: 3, keywords: ["Persist"], colors: ["G", "W"], power: "3", toughness: "2" }),
  card("Gitaxian Probe", "Sorcery", "Look at target player's hand.\nDraw a card.", { manaCost: "{U/P}", cmc: 1, colors: ["U"] }),
  card("Chord of Calling", "Instant", "Convoke\nSearch your library for a creature card with mana value X or less, put it onto the battlefield, then shuffle.", { manaCost: "{X}{G}{G}{G}", cmc: 3, keywords: ["Convoke"] }),
  card("Swords to Plowshares", "Instant", "Exile target creature. Its controller gains life equal to its power.", { manaCost: "{W}", cmc: 1 }),
  card("Heroic Intervention", "Instant", "Permanents you control gain hexproof and indestructible until end of turn.", { manaCost: "{1}{G}", cmc: 2 }),
  card("Raise the Alarm", "Instant", "Create two 1/1 white Soldier creature tokens.", { manaCost: "{1}{W}", cmc: 2 }),
  card("Arcane Signet", "Artifact", "{T}: Add one mana of any color in your commander's color identity.", { manaCost: "{2}", cmc: 2 }),
  card("Divination", "Sorcery", "Draw two cards.", { manaCost: "{2}{U}", cmc: 3 }),
  card("Terastodon", "Creature — Elephant", "When Terastodon enters, you may destroy up to three target noncreature permanents. For each permanent put into a graveyard this way, its controller creates a 3/3 green Elephant creature token.", { manaCost: "{6}{G}{G}", cmc: 8, power: "9", toughness: "9" }),
  card("Tarmogoyf", "Creature — Lhurgoyf", "Tarmogoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.", { manaCost: "{1}{G}", cmc: 2, power: "*", toughness: "1+*" }),
  card("Rhystic Study", "Enchantment", "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.", { manaCost: "{2}{U}", cmc: 3 }),
  card("Forest", "Basic Land — Forest", "({T}: Add {G}.)", { quantity: 3 }),
  card("Mountain", "Basic Land — Mountain", "({T}: Add {R}.)", { quantity: 2 }),
  card("Command Tower", "Land", "{T}: Add one mana of any color in your commander's color identity."),
  card("Evolving Wilds", "Land", "{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle."),
];

const stats = computeStats(DECK, new Date("2026-10-16T12:00:00Z"));
const curve = (v: number) => stats.curve.find((b) => b.value === v)!;
const fn = (key: string) => stats.functional.find((f) => f.key === key)!;
const names = (key: string) => fn(key).cards.map((c) => c.name);

describe("mana cost parsing", () => {
  it("takes the front half of a split cost", () => {
    expect(frontCost("{1}{R} // {1}{U}")).toBe("{1}{R}");
    expect(frontCost("")).toBe("");
  });
  it("mana value: numbers add, X is 0, {2/W} is 2, every other symbol is 1", () => {
    expect(manaValueOf("{X}{G}{G}{G}")).toBe(3);
    expect(manaValueOf("{2/W}{2/W}")).toBe(4);
    expect(manaValueOf("{U/P}")).toBe(1);
    expect(manaValueOf("{1}{G/W}{G/W}")).toBe(3);
    expect(manaValueOf("{0}")).toBe(0);
    expect(manaValueOf("{C}{S}")).toBe(2);
  });
  it("falls back to cmc when a card has no mana cost", () => {
    expect(cardManaValue(card("Ancestral Vision", "Sorcery", "Suspend 4—{U}\nTarget player draws three cards.", { cmc: 0 }))).toBe(0);
    expect(cardManaValue(card("Forest", "Basic Land — Forest", "({T}: Add {G}.)"))).toBe(0);
    expect(cardManaValue(card("Fire // Ice", "Instant // Instant", "", { manaCost: "{1}{R} // {1}{U}", cmc: 4 }))).toBe(2);
  });
  it("pips: hybrid halves, phyrexian for its colour, {C} its own column, snow is generic", () => {
    expect(pipsOf("{1}{G/W}{G/W}")).toMatchObject({ colored: { W: 1, U: 0, B: 0, R: 0, G: 1, C: 0 }, generic: 1, hybrid: 2, phyrexian: 0, hasX: false });
    expect(pipsOf("{U/P}")).toMatchObject({ colored: { U: 1 }, phyrexian: 1 });
    expect(pipsOf("{X}{C}{S}")).toMatchObject({ colored: { C: 1 }, generic: 1, hasX: true });
    expect(pipsOf("{2/W}")).toMatchObject({ colored: { W: 1 }, generic: 0 });
  });
});

describe("mana curve and totals (exact)", () => {
  it("buckets nonland cards by mana value, lands separately", () => {
    expect(curve(0)).toEqual({ value: 0, nonland: 0, lands: 7 });
    expect(curve(1).nonland).toBe(6); // Sol Ring, Llanowar, Dark Ritual, Bolt, Probe, Swords
    expect(curve(2).nonland).toBe(9); // Counterspell, Tutor, Regrowth, Rampant, Fire, Heroic, Raise, Signet, Tarmogoyf
    expect(curve(3).nonland).toBe(5); // Jenara, Finks, Chord, Divination, Rhystic
    expect(curve(4).nonland).toBe(1); // Wrath
    expect(curve(5).nonland).toBe(0);
    expect(curve(6).nonland).toBe(0);
    expect(curve(7).nonland).toBe(1); // Terastodon (8)
    expect(stats.curve.reduce((n, b) => n + b.nonland, 0)).toBe(22);
  });
  it("sums and averages mana value", () => {
    expect(stats.manaValue).toEqual({
      total: 51,
      nonlandTotal: 51,
      nonlandCount: 22,
      landCount: 7,
      cardCount: 29,
      averageNonland: 2.32, // 51 / 22
      averageAll: 1.76, // 51 / 29
    });
  });
});

describe("pips (exact)", () => {
  it("counts coloured pips per colour with hybrid halves, generic apart, X spells", () => {
    expect(stats.pips.colored).toEqual({ W: 6, U: 6, B: 2, R: 2, G: 12, C: 0 });
    expect(stats.pips.coloredTotal).toBe(28);
    expect(stats.pips.generic).toBe(23);
    expect(stats.pips.hybridSymbols).toBe(2);
    expect(stats.pips.phyrexianSymbols).toBe(1);
    expect(stats.pips.xSpells).toBe(1);
    expect(stats.pips.xSpellNames).toEqual(["Chord of Calling"]);
  });
});

describe("mana production (heuristic)", () => {
  it("classifies single cards", () => {
    expect(manaSource(card("Forest", "Basic Land — Forest", "({T}: Add {G}.)"))).toMatchObject({ kind: "land", produces: ["G"] });
    expect(manaSource(card("Tropical Island", "Land — Forest Island", "({T}: Add {G} or {U}.)"))).toMatchObject({ kind: "land", produces: ["U", "G"] });
    expect(manaSource(card("Misty Rainforest", "Land", "{T}, Pay 1 life, Sacrifice Misty Rainforest: Search your library for a Forest or Island card, put it onto the battlefield, then shuffle."))).toMatchObject({ produces: ["U", "G"] });
    expect(manaSource(card("Evolving Wilds", "Land", "{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle."))).toMatchObject({ produces: ["any"] });
    expect(manaSource(card("Command Tower", "Land", "{T}: Add one mana of any color in your commander's color identity."))).toMatchObject({ produces: ["any"] });
    expect(manaSource(card("Sol Ring", "Artifact", "{T}: Add {C}{C}.", { manaCost: "{1}", cmc: 1 }))).toMatchObject({ kind: "rock", produces: ["C"] });
    expect(manaSource(card("Birds of Paradise", "Creature — Bird", "Flying\n{T}: Add one mana of any color.", { manaCost: "{G}", cmc: 1 }))).toMatchObject({ kind: "dork", produces: ["any"] });
    expect(manaSource(card("Wild Growth", "Enchantment — Aura", "Enchant land\nWhenever enchanted land is tapped for mana, its controller adds an additional {G}.", { manaCost: "{G}", cmc: 1 }))).toBeNull(); // "adds an additional" is not "add {G}" - known miss
    expect(manaSource(card("Talisman of Dominance", "Artifact", "{T}: Add {C}.\n{T}: Add {U} or {B}. Talisman of Dominance deals 1 damage to you.", { manaCost: "{2}", cmc: 2 }))).toMatchObject({ kind: "rock", produces: ["U", "B", "C"] });
    expect(manaSource(card("Dark Ritual", "Instant", "Add {B}{B}{B}.", { manaCost: "{B}", cmc: 1 }))).toBeNull();
    expect(manaSource(card("Lightning Bolt", "Instant", "Lightning Bolt deals 3 damage to any target.", { manaCost: "{R}", cmc: 1 }))).toBeNull();
    expect(manaSource(card("Smothering Tithe", "Enchantment", "Whenever an opponent draws a card, that player may pay {2}. If the player doesn't, you create a Treasure token. (It's an artifact with \"{T}, Sacrifice this artifact: Add one mana of any color.\")", { manaCost: "{3}{W}", cmc: 4 }))).toBeNull();
  });
  it("uses the commander's colour identity for any-colour sources", () => {
    expect(deckIdentity(DECK)).toEqual(["W", "U", "G"]);
    expect(stats.production.identity).toEqual(["W", "U", "G"]);
    expect(stats.production.anyColorSources).toBe(3); // Command Tower, Evolving Wilds, Arcane Signet
    expect(stats.production.totalSources).toBe(10); // 7 lands + Sol Ring + Signet + Llanowar
    expect(stats.production.byKind).toEqual({ land: 7, rock: 2, dork: 1, other: 0 });
  });
  it("compares sources with pips per colour", () => {
    const row = (c: string) => stats.production.rows.find((r) => r.color === c)!;
    expect(row("W")).toMatchObject({ pips: 6, sources: 3, ratio: 0.5, byKind: { land: 2, rock: 1, dork: 0, other: 0 } });
    expect(row("U")).toMatchObject({ pips: 6, sources: 3, ratio: 0.5 });
    expect(row("B")).toMatchObject({ pips: 2, sources: 0, ratio: 0 });
    expect(row("R")).toMatchObject({ pips: 2, sources: 2, ratio: 1 }); // the two Mountains; outside the identity
    expect(row("G")).toMatchObject({ pips: 12, sources: 7, ratio: 0.58, byKind: { land: 5, rock: 1, dork: 1, other: 0 } });
    expect(row("C")).toMatchObject({ pips: 0, sources: 1, ratio: null });
    // Shares are over the five colours only: pips 28, colour source slots 3+3+0+2+7 = 15.
    expect(row("G").pipShare).toBe(0.43);
    expect(row("G").sourceShare).toBe(0.47);
    expect(row("B").note).toContain("no way to make black mana");
    expect(row("R").note).toContain("outside the commander's colour identity");
    expect(row("C").note).toContain("nothing that needs it");
    expect(stats.production.summary).toContain("10 mana sources in this 3-colour deck: 7 lands, 2 rocks, 1 dork; 3 of them make any colour.");
    expect(stats.production.guideline.author).toBe("Frank Karsten");
    expect(stats.production.cards.map((c) => c.name)).toEqual(["Llanowar Elves", "Command Tower", "Evolving Wilds", "Forest", "Mountain", "Arcane Signet", "Sol Ring"]);
    expect(stats.production.cards.find((c) => c.name === "Forest")!.quantity).toBe(3);
  });
  it("falls back to card colours when there is no commander", () => {
    expect(deckIdentity(DECK.filter((c) => c.board !== "commander"))).toEqual(["W", "U", "B", "R", "G"]);
  });
});

describe("breakdowns (exact, except token makers)", () => {
  it("counts card types on the front face, each type once", () => {
    expect(stats.breakdowns.types).toEqual({ creature: 5, instant: 8, sorcery: 6, artifact: 2, enchantment: 1, planeswalker: 0, battle: 0, land: 7 });
  });
  it("counts nonland colours, multicolour and colourless cards", () => {
    expect(stats.breakdowns.colors).toEqual({ W: 5, U: 6, B: 2, R: 2, G: 9 });
    expect(stats.breakdowns.multicolor).toBe(3); // Jenara, Fire // Ice, Kitchen Finks
    expect(stats.breakdowns.colorless).toBe(2); // Sol Ring, Arcane Signet
  });
  it("splits lands and averages numeric P/T", () => {
    expect(stats.breakdowns.lands).toEqual({ total: 7, basic: 5, nonbasic: 2 });
    expect(stats.breakdowns.creatures).toEqual({ count: 5, averagePower: 4, averageToughness: 3.75, nonNumeric: 1 }); // (3+1+3+9)/4, (3+1+2+9)/4; Tarmogoyf skipped
    expect(stats.breakdowns.xSpells).toBe(1);
  });
  it("lists token makers", () => {
    expect(stats.breakdowns.tokenMakers).toEqual({ count: 2, names: ["Raise the Alarm", "Terastodon"] });
  });
  it("counts an Artifact Creature in both types", () => {
    const s = computeStats([card("Solemn Simulacrum", "Artifact Creature — Golem", "When Solemn Simulacrum enters, you may search your library for a basic land card, put it onto the battlefield tapped, then shuffle.", { manaCost: "{4}", cmc: 4, power: "2", toughness: "2" })]);
    expect(s.breakdowns.types.artifact).toBe(1);
    expect(s.breakdowns.types.creature).toBe(1);
    expect(s.breakdowns.colorless).toBe(1);
  });
});

describe("functional counts (heuristic, names listed)", () => {
  it("ramp", () => {
    expect(names("ramp")).toEqual(["Arcane Signet", "Llanowar Elves", "Rampant Growth", "Sol Ring"]);
    expect(fn("ramp").count).toBe(4);
  });
  it("card draw", () => {
    expect(names("draw")).toEqual(["Divination", "Fire // Ice", "Gitaxian Probe", "Rhystic Study"]);
  });
  it("targeted removal", () => {
    expect(names("removal")).toEqual(["Lightning Bolt", "Swords to Plowshares", "Terastodon"]);
  });
  it("board wipes", () => {
    expect(names("wipes")).toEqual(["Wrath of God"]);
  });
  it("counterspells", () => {
    expect(names("counterspells")).toEqual(["Counterspell"]);
  });
  it("tutors (land searches are ramp, not tutors)", () => {
    expect(names("tutors")).toEqual(["Chord of Calling", "Demonic Tutor"]);
  });
  it("recursion", () => {
    expect(names("recursion")).toEqual(["Regrowth"]);
  });
  it("protection", () => {
    expect(names("protection")).toEqual(["Heroic Intervention"]);
  });
  it("counts duplicates by quantity", () => {
    const s = computeStats([card("Lightning Bolt", "Instant", "Lightning Bolt deals 3 damage to any target.", { manaCost: "{R}", cmc: 1, quantity: 4 })]);
    expect(s.functional.find((f) => f.key === "removal")).toEqual({ key: "removal", count: 4, cards: [{ name: "Lightning Bolt", quantity: 4 }] });
  });
  it("more wordings", () => {
    const s = computeStats([
      card("Beast Within", "Instant", "Destroy target permanent. Its controller creates a 3/3 green Beast creature token.", { manaCost: "{2}{G}", cmc: 3 }),
      card("Cyclonic Rift", "Instant", "Return target nonland permanent you don't control to its owner's hand.\nOvercharge {6}{U}", { manaCost: "{1}{U}", cmc: 2 }),
      card("Blasphemous Act", "Sorcery", "This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature.", { manaCost: "{8}{R}", cmc: 9 }),
      card("Toxic Deluge", "Sorcery", "As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.", { manaCost: "{2}{B}", cmc: 3 }),
      card("Eternal Witness", "Creature — Human Shaman", "When Eternal Witness enters, you may return target card from your graveyard to your hand.", { manaCost: "{1}{G}{G}", cmc: 3, power: "2", toughness: "1" }),
      card("Teferi's Protection", "Instant", "Until your next turn, your life total can't change and you gain protection from everything. All permanents you control phase out.", { manaCost: "{2}{W}", cmc: 3 }),
      card("Light-Paws, Emperor's Voice", "Legendary Creature — Fox Advisor", "Whenever an Aura enters the battlefield under your control, if you cast it, you may search your library for an Aura card with mana value less than or equal to that Aura's mana value, put it onto the battlefield attached to a creature you control, then shuffle.", { manaCost: "{1}{W}", cmc: 2, power: "2", toughness: "2" }),
      card("Reassembling Skeleton", "Creature — Skeleton Warrior", "{1}{B}: Return Reassembling Skeleton from your graveyard to the battlefield tapped.", { manaCost: "{1}{B}", cmc: 2, power: "1", toughness: "1" }),
      card("Armageddon", "Sorcery", "Destroy all lands.", { manaCost: "{3}{W}", cmc: 4 }),
      card("Thought Vessel", "Artifact", "You have no maximum hand size.\n{T}: Add {C}.", { manaCost: "{2}", cmc: 2 }),
      card("Phyrexian Arena", "Enchantment", "At the beginning of your upkeep, you draw a card and you lose 1 life.", { manaCost: "{1}{B}{B}", cmc: 3 }),
      card("Howling Mine", "Artifact", "At the beginning of each player's draw step, if Howling Mine is untapped, that player draws an additional card.", { manaCost: "{2}", cmc: 2 }),
    ]);
    const n = (k: string) => s.functional.find((f) => f.key === k)!.cards.map((c) => c.name);
    expect(n("removal")).toEqual(["Beast Within", "Cyclonic Rift"]);
    expect(n("wipes")).toEqual(["Blasphemous Act", "Toxic Deluge"]); // Armageddon is land denial, not a wipe
    expect(n("recursion")).toEqual(["Eternal Witness", "Reassembling Skeleton"]);
    expect(n("protection")).toEqual(["Teferi's Protection"]);
    expect(n("tutors")).toEqual(["Light-Paws, Emperor's Voice"]);
    expect(n("ramp")).toEqual(["Thought Vessel"]);
    expect(n("draw")).toEqual(["Phyrexian Arena"]); // Howling Mine draws for everyone -> not counted
    expect(s.breakdowns.tokenMakers.names).toEqual(["Beast Within"]);
    const doubler = computeStats([card("Doubling Season", "Enchantment", "If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead.", { manaCost: "{4}{G}", cmc: 5 })]);
    expect(doubler.breakdowns.tokenMakers.count).toBe(0); // doublers are not makers
  });
});

describe("whole result", () => {
  it("names the commander and stamps the time", () => {
    expect(stats.commanders).toEqual(["Jenara, Asura of War"]);
    expect(stats.computedAt).toBe("2026-10-16T12:00:00.000Z");
  });
  it("handles an empty list", () => {
    const s = computeStats([]);
    expect(s.manaValue.averageNonland).toBe(0);
    expect(s.production.rows).toEqual([]);
    expect(s.production.identity).toEqual([]);
    expect(s.functional.every((f) => f.count === 0)).toBe(true);
  });
});
