import { describe, expect, it } from "vitest";
import { normalizeName } from "@cgwf/shared";
import { card, F, THORACLE_VARIANT } from "../fixtures.js";
import { gameChangersFromNames, type SpellbookVariant } from "../index.js";
import type { AnalysisCard } from "../cards.js";
import { edhrecSlug, pageMatches, parseCommanderPage, slugCandidates, type EdhrecCardStat } from "./edhrec.js";
import { planSwaps, type DoctorCandidate, type DoctorDeckCard, type PlanInput } from "./plan.js";
import { rolesOf } from "./roles.js";

let n = 0;
const inDeck = (c: AnalysisCard): DoctorDeckCard => ({ ...c, entryId: ++n, cardId: `id-${c.name}`, oracleId: `o-${c.name}`, faceCount: 1 });
const cand = (c: AnalysisCard, completes: SpellbookVariant[] = []): DoctorCandidate => ({ ...c, quantity: 1, board: "main", cardId: `id-${c.name}`, oracleId: `o-${c.name}`, faceCount: 1, sources: completes.length ? ["combo"] : ["edhrec"], completes });
const stat = (name: string, synergy: number, inclusion: number): [string, EdhrecCardStat] => [normalizeName(name), { name, synergy, inclusion, numDecks: Math.round(inclusion * 1000) }];

const ramp = (name: string, cmc = 2) => card(name, "Sorcery", "Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.", { manaCost: "{1}{G}", cmc });
const draw = (name: string) => card(name, "Sorcery", "Draw two cards.", { manaCost: "{2}{U}", cmc: 3 });
const vanilla = (name: string, cmc: number) => card(name, "Creature — Beast", "", { manaCost: `{${cmc - 1}}{G}`, cmc, power: "5", toughness: "5" });
const commander = card("Tester, Deck Doctor", "Legendary Creature — Human Druid", "Whenever a land enters under your control, draw a card.", { manaCost: "{G}{U}", cmc: 2, board: "commander", colorIdentity: ["G", "U"] });
const sanguine = card("Sanguine Bond", "Enchantment", "Whenever you gain life, target opponent loses that much life.", { manaCost: "{3}{B}{B}", cmc: 5 });
const exquisite = card("Exquisite Blood", "Enchantment", "Whenever an opponent loses life, you gain that much life.", { manaCost: "{4}{B}", cmc: 5 });
const BOND_VARIANT = {
  id: "bond",
  status: "OK",
  uses: [{ card: { name: "Sanguine Bond" }, quantity: 1 }, { card: { name: "Exquisite Blood" }, quantity: 1 }],
  requires: [],
  produces: [{ feature: { name: "Infinite lifeloss" } }],
  manaValueNeeded: 10,
  bracketTag: "P",
} as unknown as SpellbookVariant;

function baseInput(over: Partial<PlanInput> = {}): PlanInput {
  const deck = [
    inDeck(commander),
    inDeck(ramp("Rampant Growth")),
    inDeck(ramp("Cultivate", 3)),
    inDeck(draw("Divination")),
    inDeck(F.thassasOracle),
    inDeck(vanilla("Big Dumb Beast", 7)),
    inDeck(vanilla("Pet Card", 4)),
    inDeck(sanguine),
    inDeck(exquisite),
    inDeck({ ...F.forest, quantity: 34 }),
  ];
  return {
    deck,
    candidates: [
      cand(ramp("Nature's Lore", 2)),
      cand(card("Rhystic Study", "Enchantment", "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.", { manaCost: "{2}{U}", cmc: 3 })),
      cand(card("Demonic Consultation", "Instant", "Choose a card name. Exile the top six cards of your library, then reveal cards from the top of your library until you reveal a card with the chosen name.", { manaCost: "{B}", cmc: 1 }), [THORACLE_VARIANT as unknown as SpellbookVariant]),
      cand(card("Breeding Pool", "Land — Forest Island", "({T}: Add {G} or {U}.)")),
      cand(vanilla("Not Wanted", 3)),
    ],
    edhrec: new Map([
      stat("Nature's Lore", 0.3, 0.5),
      stat("Rhystic Study", 0.4, 0.6),
      stat("Demonic Consultation", 0.2, 0.3),
      stat("Breeding Pool", 0.25, 0.7),
      stat("Not Wanted", 0.6, 0.9),
      stat("Rampant Growth", 0.01, 0.1),
      stat("Cultivate", 0.2, 0.6),
      stat("Divination", 0.05, 0.1),
      stat("Big Dumb Beast", 0.02, 0.05),
    ]),
    commanderLabel: "Tester",
    target: 2,
    allowHigher: false,
    gameChangers: gameChangersFromNames(["Rhystic Study"]),
    combos: { included: [BOND_VARIANT], almostIncluded: [THORACLE_VARIANT as unknown as SpellbookVariant] },
    keep: new Set(),
    dismissed: new Set(["o-Not Wanted"]),
    ...over,
  };
}

describe("Deck Doctor planner", () => {
  it("pairs a ramp add with the deck's lowest-synergy ramp card and explains it from the data", () => {
    const r = planSwaps(baseInput());
    const lore = r.swaps.find((s) => s.add.name === "Nature's Lore")!;
    expect(lore.cut.name).toBe("Rampant Growth");
    expect(lore.role).toBe("ramp");
    expect(lore.add.sources).toEqual(expect.arrayContaining(["edhrec", "role"]));
    expect(lore.reason).toBe("+30% synergy with Tester, in 50% of Tester decks; the deck has 2 ramp of 10 suggested. Replaces Rampant Growth, your lowest-synergy ramp card.");
    expect(r.roles.find((x) => x.role === "ramp")).toEqual({ role: "ramp", have: 2, want: 10 });
  });

  it("never suggests a dismissed card, and never cuts the commander, a pinned card or a piece of a combo the deck has", () => {
    const r = planSwaps(baseInput({ keep: new Set(["o-Big Dumb Beast"]) }));
    const adds = r.swaps.map((s) => s.add.name);
    const cuts = r.swaps.map((s) => s.cut.name);
    expect(adds).not.toContain("Not Wanted");
    for (const protectedCard of ["Tester, Deck Doctor", "Big Dumb Beast", "Sanguine Bond", "Exquisite Blood"]) expect(cuts).not.toContain(protectedCard);
  });

  it("keeps the land count: only a land add may cut a land (one copy of the basic line)", () => {
    const r = planSwaps(baseInput());
    for (const s of r.swaps) {
      const addIsLand = /Land/.test(s.add.typeLine);
      if (!addIsLand) expect(s.cut.name).not.toBe("Forest");
    }
    const pool = r.swaps.find((s) => s.add.name === "Breeding Pool")!;
    expect(pool.cut).toMatchObject({ name: "Forest", quantity: 34 });
    expect(pool.role).toBe("land");
  });

  it("is bracket-aware: a Game Changer at a Bracket 2 target is held back unless a higher bracket is allowed", () => {
    // Without the deck's own combo its floor is 2, so one Game Changer (floor 3) would push it over.
    const noCombo = { combos: { included: [], almostIncluded: [] } };
    expect(planSwaps(baseInput(noCombo)).swaps.map((s) => s.add.name)).not.toContain("Rhystic Study");
    const higher = planSwaps(baseInput({ ...noCombo, allowHigher: true })).swaps.find((s) => s.add.name === "Rhystic Study")!;
    expect(higher.bracket).toMatchObject({ raises: true, floorAfter: 3 });
    expect(higher.bracket.note).toMatch(/Raises the bracket floor to 3 \(your target is 2\)/);
    // With the combo the deck already sits at floor 3: the same Game Changer does not raise it further.
    expect(planSwaps(baseInput()).swaps.find((s) => s.add.name === "Rhystic Study")?.bracket).toMatchObject({ floorBefore: 3, raises: false });
  });

  it("an early two-card combo completion is refused at Bracket 3 and offered at Bracket 4", () => {
    expect(planSwaps(baseInput({ target: 3, gameChangers: gameChangersFromNames([]) })).swaps.map((s) => s.add.name)).not.toContain("Demonic Consultation");
    const b4 = planSwaps(baseInput({ target: 4 })).swaps.find((s) => s.add.name === "Demonic Consultation")!;
    expect(b4.combos[0]).toMatch(/^Demonic Consultation \+ Thassa's Oracle: exile your library, win the game$/);
    expect(b4.bracket.raises).toBe(false);
    expect(b4.reason).toMatch(/completes Demonic Consultation \+ Thassa's Oracle/);
  });

  it("returns at most ten swaps, best first, each with a positive gain", () => {
    const r = planSwaps(baseInput({ target: 4, limit: 2 }));
    expect(r.swaps.length).toBeLessThanOrEqual(2);
    expect(r.swaps.every((s) => s.score > 0)).toBe(true);
    expect([...r.swaps].sort((a, b) => b.score - a.score)).toEqual(r.swaps);
  });

  it("roles come from the Stats finders", () => {
    expect(rolesOf(ramp("X"))).toEqual(["ramp"]);
    expect(rolesOf(F.forest)).toContain("land");
  });
});

describe("EDHREC commander pages", () => {
  it("slugs names the way EDHREC does and tries both orders for a pair", () => {
    expect(edhrecSlug("Atraxa, Praetors' Voice")).toBe("atraxa-praetors-voice");
    expect(edhrecSlug("Éowyn, Shieldmaiden")).toBe("eowyn-shieldmaiden");
    expect(edhrecSlug("Avatar Aang // Aang, Master of Elements")).toBe("avatar-aang");
    expect(slugCandidates(["Thrasios, Triton Hero", "Tymna the Weaver"])).toEqual(["thrasios-triton-hero-tymna-the-weaver", "tymna-the-weaver-thrasios-triton-hero"]);
  });

  it("reads synergy and inclusion from every card list and checks the page belongs to the commander", () => {
    const page = parseCommanderPage({
      container: {
        json_dict: {
          card: { name: "Atraxa, Praetors' Voice" },
          cardlists: [
            { cardviews: [{ name: "Doubling Season", synergy: 0.126, num_decks: 14829, potential_decks: 45691 }] },
            { cardviews: [{ name: "Sol Ring", synergy: -0.018, num_decks: 38836, potential_decks: 45691 }, { name: "Doubling Season", synergy: 0.1, num_decks: 10, potential_decks: 45691 }] },
          ],
        },
      },
    })!;
    expect(page.cards.get("doubling season")).toMatchObject({ synergy: 0.126, numDecks: 14829 });
    expect(page.cards.get("sol ring")!.inclusion).toBeCloseTo(0.85, 2);
    expect(pageMatches(page.name, ["Atraxa, Praetors' Voice"])).toBe(true);
    expect(pageMatches("Atraxa, Grand Unifier", ["Atraxa, Praetors' Voice"])).toBe(false);
    expect(parseCommanderPage({ nope: 1 })).toBeNull();
  });
});
