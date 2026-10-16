import { describe, expect, it } from "vitest";
import { analyzeDeck, gameChangersFromNames, loadGameChangers, primerSkeleton } from "./index.js";
import { detectArchetypes } from "./archetypes.js";
import { decideBracket } from "./bracket.js";
import { classifyCombos } from "./combos.js";
import { detectExtraTurns } from "./extraTurns.js";
import { detectFastMana, detectFreeInteraction } from "./fastMana.js";
import { detectGameChangers } from "./gameChangers.js";
import { detectMassLandDenial } from "./landDenial.js";
import { classifyTutor, detectTutors } from "./tutors.js";
import { EXPENSIVE_TWO_CARD_VARIANT, F, goblinDeck, THORACLE_VARIANT, THREE_CARD_VARIANT, card } from "./fixtures.js";

const GC = loadGameChangers();

describe("game changers data file", () => {
  it("loads the dated list with 53 cards", () => {
    expect(GC.listDate).toBe("2026-02-09");
    expect(GC.cards.length).toBe(53);
    expect(GC.source).toContain("magic.wizards.com");
    expect(GC.cards).toContain("Farewell");
    expect(GC.cards).toContain("Biorhythm");
    // Removed October 2025, must not be there.
    expect(GC.cards).not.toContain("Food Chain");
    expect(GC.cards).not.toContain("Expropriate");
  });

  it("detects by name, by front face, and without duplicates", () => {
    const list = gameChangersFromNames(["Demonic Tutor", "Delver of Secrets", "Sol Ring"]);
    const hits = detectGameChangers([F.demonicTutor, F.delver, F.solRing, F.solRing, F.forest], list);
    expect(hits).toEqual(["Demonic Tutor", "Delver of Secrets", "Sol Ring"]);
  });
});

describe("mass land denial", () => {
  it("catches wipes, sacrifice, untap denial and Blood Moon", () => {
    const hits = detectMassLandDenial([F.armageddon, F.ruination, F.jokulhaups, F.winterOrb, F.bloodMoon, F.wildfire, F.sunder, F.hokori]);
    expect(hits.map((h) => h.name)).toEqual(["Armageddon", "Ruination", "Jokulhaups", "Winter Orb", "Blood Moon", "Wildfire", "Sunder", "Hokori, Dust Drinker"]);
  });
  it("ignores single-target land destruction, nonland wipes and ordinary sacrifice", () => {
    expect(detectMassLandDenial([F.stripMine, F.planarCleansing, F.wrath, F.smallpox, F.rampantGrowth, F.forest])).toEqual([]);
  });
});

describe("extra turns", () => {
  it("counts Time Warp even though it says 'target player'", () => {
    const r = detectExtraTurns([F.timeWarp, F.forest]);
    expect(r.cards).toEqual(["Time Warp"]);
    expect(r.chaining).toBe(false);
  });
  it("flags chaining for three extra-turn cards", () => {
    const r = detectExtraTurns([F.timeWarp, F.temporalMastery, F.nexusOfFate]);
    expect(r.chaining).toBe(true);
    expect(r.chainingWhy).toContain("3 extra-turn cards");
  });
  it("flags Nexus of Fate on its own (it shuffles itself back)", () => {
    const r = detectExtraTurns([F.nexusOfFate]);
    expect(r.chaining).toBe(true);
    expect(r.chainingWhy).toContain("Nexus of Fate");
  });
  it("flags one extra turn plus recursion", () => {
    expect(detectExtraTurns([F.timeWarp, F.regrowth]).chaining).toBe(true);
    expect(detectExtraTurns([F.timeWarp, F.pastInFlames]).chaining).toBe(true);
    expect(detectExtraTurns([F.timeWarp, F.counterspell]).chaining).toBe(false);
  });
});

describe("tutors", () => {
  it("classifies search phrases", () => {
    expect(classifyTutor("")).toBe("any");
    expect(classifyTutor("creature ")).toBe("creature");
    expect(classifyTutor("artifact or enchantment ")).toBe("artifact");
    expect(classifyTutor("instant or sorcery ")).toBe("instant_sorcery");
    expect(classifyTutor("basic land ")).toBe("land");
    expect(classifyTutor("creature card with mana value x or less ".replace(" card", ""))).toBe("creature");
  });
  it("counts real tutors and skips land fetch and named searches", () => {
    const r = detectTutors([F.demonicTutor, F.worldlyTutor, F.enlightenedTutor, F.mysticalTutor, F.rampantGrowth, F.squadronHawk, F.chordOfCalling, F.counterspell]);
    expect(r.count).toBe(5);
    expect(r.cards).toEqual([
      { name: "Demonic Tutor", kind: "any" },
      { name: "Worldly Tutor", kind: "creature" },
      { name: "Enlightened Tutor", kind: "artifact" },
      { name: "Mystical Tutor", kind: "instant_sorcery" },
      { name: "Chord of Calling", kind: "creature" },
    ]);
    expect(r.landTutors).toEqual(["Rampant Growth"]);
  });
});

describe("fast mana and free interaction", () => {
  it("finds rocks and rituals but not signets or dorks", () => {
    expect(detectFastMana([F.solRing, F.manaCrypt, F.darkRitual, F.lotusPetal, F.arcaneSignet, F.llanowar, F.forest])).toEqual(["Sol Ring", "Mana Crypt", "Dark Ritual", "Lotus Petal"]);
  });
  it("finds pitch spells and commander-free spells", () => {
    expect(detectFreeInteraction([F.forceOfWill, F.fierceGuardianship, F.counterspell])).toEqual(["Force of Will", "Fierce Guardianship"]);
  });
});

describe("combos", () => {
  it("marks a cheap two-card game-ending combo as early", () => {
    const hits = classifyCombos({ included: [THORACLE_VARIANT, THREE_CARD_VARIANT, EXPENSIVE_TWO_CARD_VARIANT] });
    expect(hits.map((h) => h.id)).toEqual(["742-1295", "9-10", "1-2-3"]);
    expect(hits[0]).toMatchObject({ twoCard: true, early: true, manaValueNeeded: 3, bracketTag: "R" });
    expect(hits[1]).toMatchObject({ twoCard: true, early: false });
    expect(hits[2]).toMatchObject({ twoCard: false, early: false });
    expect(hits[0]!.url).toBe("https://commanderspellbook.com/combo/742-1295/");
  });
  it("skips non-OK variants and handles no results", () => {
    expect(classifyCombos({ included: [{ ...THORACLE_VARIANT, status: "NW" }] })).toEqual([]);
    expect(classifyCombos(null)).toEqual([]);
  });
  it("does not call a two-card value engine a two-card infinite", () => {
    const hits = classifyCombos({ included: [{ ...THORACLE_VARIANT, id: "x", produces: [{ feature: { name: "Draw a card" } }] }] });
    expect(hits[0]!.twoCard).toBe(false);
  });
});

describe("archetypes", () => {
  it("tags the goblin list as tokens and tribal with evidence", () => {
    const tags = detectArchetypes({ cards: goblinDeck() });
    const byTag = Object.fromEntries(tags.map((t) => [t.tag, t]));
    expect(byTag.tokens).toBeDefined();
    expect(byTag.tokens!.evidence).toContain("Krenko, Mob Boss");
    expect(byTag.tribal).toBeDefined();
    expect(byTag.tribal!.evidence[0]).toMatch(/^Goblin x/);
    expect(tags.every((t) => t.confidence > 0 && t.confidence <= 1)).toBe(true);
  });
  it("tags aristocrats and spellslinger from their signature cards", () => {
    const arist = detectArchetypes({ cards: [F.bloodArtist, F.viscera, { ...F.bloodArtist, name: "Zulaport Cutthroat" }, { ...F.viscera, name: "Carrion Feeder" }, { ...F.bloodArtist, name: "Cruel Celebrant", board: "commander" }] });
    expect(arist[0]!.tag).toBe("aristocrats");
    const spells = detectArchetypes({ cards: [F.guttersnipe, { ...F.guttersnipe, name: "Electrostatic Field" }, { ...F.guttersnipe, name: "Niv", board: "commander" }] });
    expect(spells[0]!.tag).toBe("spellslinger");
  });
});

describe("bracket decision", () => {
  const none = { cards: [], chaining: false, chainingWhy: null };
  it("nothing restricted: floor 1, suggestion 2, with the Bracket 1 note", () => {
    const d = decideBracket({ gameChangers: [], massLandDenial: [], extraTurns: none, combos: [], signals: [] });
    expect(d.floor).toBe(1);
    expect(d.suggested).toBe(2);
    expect(d.reasons).toEqual([]);
    expect(d.judgmentNote).toContain("Bracket 1");
  });
  it("one to three game changers -> floor 3; four -> floor 4", () => {
    expect(decideBracket({ gameChangers: ["Rhystic Study"], massLandDenial: [], extraTurns: none, combos: [], signals: [] }).floor).toBe(3);
    expect(decideBracket({ gameChangers: ["a", "b", "c"], massLandDenial: [], extraTurns: none, combos: [], signals: [] }).floor).toBe(3);
    const four = decideBracket({ gameChangers: ["a", "b", "c", "d"], massLandDenial: [], extraTurns: none, combos: [], signals: [] });
    expect(four.floor).toBe(4);
    expect(four.reasons[0]!.text).toContain("at most three");
  });
  it("mass land denial -> floor 4", () => {
    const d = decideBracket({ gameChangers: [], massLandDenial: [{ name: "Armageddon", why: "wipes every land" }], extraTurns: none, combos: [], signals: [] });
    expect(d.floor).toBe(4);
    expect(d.reasons[0]!.kind).toBe("mass_land_denial");
  });
  it("extra turns: one -> floor 2, chaining -> floor 4", () => {
    expect(decideBracket({ gameChangers: [], massLandDenial: [], extraTurns: { cards: ["Time Warp"], chaining: false, chainingWhy: null }, combos: [], signals: [] }).floor).toBe(2);
    expect(decideBracket({ gameChangers: [], massLandDenial: [], extraTurns: { cards: ["Nexus of Fate"], chaining: true, chainingWhy: "x" }, combos: [], signals: [] }).floor).toBe(4);
  });
  it("two-card combos: late -> floor 3, early -> floor 4", () => {
    const late = classifyCombos({ included: [EXPENSIVE_TWO_CARD_VARIANT] });
    const early = classifyCombos({ included: [THORACLE_VARIANT] });
    expect(decideBracket({ gameChangers: [], massLandDenial: [], extraTurns: none, combos: late, signals: [] }).floor).toBe(3);
    const d = decideBracket({ gameChangers: [], massLandDenial: [], extraTurns: none, combos: early, signals: [] });
    expect(d.floor).toBe(4);
    expect(d.reasons[0]!.kind).toBe("cheap_two_card_combo");
    expect(d.reasons[0]!.cards).toEqual(["Demonic Consultation", "Thassa's Oracle"]);
  });
  it("power signals raise the suggestion but never below the floor, and 3 vs 4 is called a judgment call", () => {
    const strong = [{ kind: "fast_mana" as const, weight: 6, cards: [], text: "" }, { kind: "tutors" as const, weight: 6, cards: [], text: "" }, { kind: "free_interaction" as const, weight: 4, cards: [], text: "" }];
    const d = decideBracket({ gameChangers: [], massLandDenial: [], extraTurns: none, combos: [], signals: strong });
    expect(d.floor).toBe(1);
    expect(d.suggested).toBe(4);
    expect(d.judgmentNote).toContain("3 vs 4");
    const mid = decideBracket({ gameChangers: ["x"], massLandDenial: [], extraTurns: none, combos: [], signals: [{ kind: "tutors", weight: 2, cards: [], text: "" }] });
    expect(mid.suggested).toBe(3);
    expect(mid.suggested).toBeGreaterThanOrEqual(mid.floor);
  });
});

describe("analyzeDeck end to end", () => {
  it("produces floor, suggestion, reasons, tags, stats and a summary", () => {
    const deck = [...goblinDeck(), F.demonicTutor, F.armageddon, F.timeWarp];
    const a = analyzeDeck(deck, { gameChangers: GC, combos: { included: [THORACLE_VARIANT] }, now: new Date("2026-10-15T00:00:00Z") });
    expect(a.gameChangers).toEqual(["Demonic Tutor"]);
    expect(a.massLandDenial).toEqual(["Armageddon"]);
    expect(a.extraTurns.cards).toEqual(["Time Warp"]);
    expect(a.floor).toBe(4);
    expect(a.suggested).toBe(4);
    expect(a.reasons.map((r) => r.kind).sort()).toEqual(["cheap_two_card_combo", "extra_turns", "game_changers", "mass_land_denial"]);
    expect(a.combosStatus).toBe("ok");
    expect(a.combos[0]!.twoCard).toBe(true);
    expect(a.archetypes.map((t) => t.tag)).toContain("tokens");
    expect(a.stats.cards).toBe(deck.reduce((n, c) => n + c.quantity, 0));
    expect(a.stats.landCount).toBe(30);
    expect(a.summary).toContain("Floor: Bracket 4");
    expect(a.summary).toContain("Krenko, Mob Boss");
    expect(a.gameChangersListDate).toBe("2026-02-09");
    expect(a.computedAt).toBe("2026-10-15T00:00:00.000Z");
  });
  it("reports combo status honestly", () => {
    expect(analyzeDeck([F.forest], { gameChangers: GC }).combosStatus).toBe("skipped");
    expect(analyzeDeck([F.forest], { gameChangers: GC, combos: null }).combosStatus).toBe("unavailable");
    expect(analyzeDeck([F.forest], { gameChangers: GC, combos: { included: [] } }).combosStatus).toBe("ok");
  });
  it("a plain precon-like list lands on floor 1 / suggestion 2", () => {
    const a = analyzeDeck(goblinDeck(), { gameChangers: GC, combos: { included: [] } });
    expect(a.floor).toBe(1);
    expect(a.suggested).toBe(2);
  });
});

describe("primer skeleton", () => {
  it("has every section heading and uses the analysis", () => {
    const deck = goblinDeck();
    const a = analyzeDeck(deck, { gameChangers: GC, combos: { included: [THORACLE_VARIANT] } });
    const p = primerSkeleton("Krenko Goblins", a, deck);
    for (const h of ["# Krenko Goblins", "## Archetype", "## Game plan", "## Win conditions", "## Key synergies", "## Game Changers", "## Combos", "## Early turns", "## Weaknesses", "## Agent notes"]) {
      expect(p).toContain(h);
    }
    expect(p).toContain("Demonic Consultation + Thassa's Oracle");
    expect(p).toContain("Go wide with tokens");
    expect(p).toContain("(fill in");
  });
  it("card() helper fills defaults", () => {
    expect(card("X", "Land", "").board).toBe("main");
  });
});
