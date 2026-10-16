import type { AnalysisCard } from "./cards.js";

/**
 * Hand-written cards with their real Oracle text, for the engine's tests.
 * Keep the text exact (Scryfall wording) so the regexes are tested against
 * what production data looks like.
 */
export function card(
  name: string,
  typeLine: string,
  oracleText: string,
  opts: Partial<Pick<AnalysisCard, "manaCost" | "cmc" | "keywords" | "colorIdentity" | "quantity" | "board" | "colors" | "power" | "toughness">> = {},
): AnalysisCard {
  // Colours default to the coloured symbols in the mana cost, as Scryfall's `colors` would be.
  const costColors = [...new Set((opts.manaCost ?? "").match(/[WUBRG]/g) ?? [])];
  return {
    name,
    typeLine,
    oracleText,
    manaCost: opts.manaCost ?? "",
    cmc: opts.cmc ?? 0,
    keywords: opts.keywords ?? [],
    colorIdentity: opts.colorIdentity ?? [],
    quantity: opts.quantity ?? 1,
    board: opts.board ?? "main",
    colors: opts.colors ?? costColors,
    power: opts.power ?? null,
    toughness: opts.toughness ?? null,
  };
}

export const F = {
  // --- mass land denial (and look-alikes) ---
  armageddon: card("Armageddon", "Sorcery", "Destroy all lands.", { manaCost: "{3}{W}", cmc: 4 }),
  ruination: card("Ruination", "Sorcery", "Destroy all nonbasic lands.", { manaCost: "{2}{R}{R}", cmc: 4 }),
  jokulhaups: card("Jokulhaups", "Sorcery", "Destroy all artifacts, creatures, and lands. They can't be regenerated.", { manaCost: "{4}{R}{R}", cmc: 6 }),
  winterOrb: card("Winter Orb", "Artifact", "As long as Winter Orb is untapped, players can't untap more than one land during their untap steps.", { manaCost: "{2}", cmc: 2 }),
  bloodMoon: card("Blood Moon", "Enchantment", "Nonbasic lands are Mountains.", { manaCost: "{2}{R}", cmc: 3 }),
  wildfire: card("Wildfire", "Sorcery", "Each player sacrifices four lands. Wildfire deals 4 damage to each creature.", { manaCost: "{4}{R}{R}", cmc: 6 }),
  sunder: card("Sunder", "Instant", "Return all lands to their owners' hands.", { manaCost: "{2}{U}{U}", cmc: 4 }),
  hokori: card("Hokori, Dust Drinker", "Legendary Creature — Spirit", "Lands don't untap during their controllers' untap steps.\nAt the beginning of each player's upkeep, that player untaps a land they control.", { manaCost: "{2}{W}{W}", cmc: 4 }),
  stripMine: card("Strip Mine", "Land", "{T}: Add {C}.\n{T}, Sacrifice Strip Mine: Destroy target land."),
  planarCleansing: card("Planar Cleansing", "Sorcery", "Destroy all nonland permanents.", { manaCost: "{3}{W}{W}{W}", cmc: 6 }),
  wrath: card("Wrath of God", "Sorcery", "Destroy all creatures. They can't be regenerated.", { manaCost: "{2}{W}{W}", cmc: 4 }),
  smallpox: card("Smallpox", "Sorcery", "Each player loses 1 life, discards a card, sacrifices a creature, then sacrifices a land.", { manaCost: "{B}{B}", cmc: 2 }),
  elspethTirel: card("Elspeth Tirel", "Legendary Planeswalker — Elspeth", "+2: You gain 1 life for each creature you control.\n−2: Create three 1/1 white Soldier creature tokens.\n−5: Destroy all other permanents except for lands and tokens.", { manaCost: "{3}{W}{W}", cmc: 5 }),
  waveOfVitriol: card("Wave of Vitriol", "Sorcery", "Each player sacrifices all artifacts, enchantments, and nonbasic lands they control. For each land sacrificed this way, its controller may search their library for a basic land card and put it onto the battlefield tapped. Then each player who searched their library this way shuffles.", { manaCost: "{5}{G}{G}", cmc: 7 }),
  fromTheAshes: card("From the Ashes", "Sorcery", "Destroy all nonbasic lands. For each land destroyed this way, its controller may search their library for a basic land card and put it onto the battlefield. Then each player who searched their library this way shuffles.", { manaCost: "{3}{R}", cmc: 4 }),
  washOut: card("Wash Out", "Sorcery", "Return all permanents of the color of your choice to their owners' hands.", { manaCost: "{3}{U}", cmc: 4 }),
  cataclysmicGearhulk: card("Cataclysmic Gearhulk", "Artifact Creature — Construct", "Vigilance\nWhen Cataclysmic Gearhulk enters, each player chooses an artifact, a creature, an enchantment, and a planeswalker from among the nonland permanents they control, then sacrifices the rest.", { manaCost: "{3}{W}{W}", cmc: 5, keywords: ["Vigilance"] }),
  magusOfTheBalance: card("Magus of the Balance", "Creature — Human Wizard", "{4}{W}, {T}, Sacrifice Magus of the Balance: Each player chooses a number of lands they control equal to the number of lands controlled by the player who controls the fewest, then sacrifices the rest. Players discard cards and sacrifice creatures the same way.", { manaCost: "{3}{W}", cmc: 4 }),
  cataclysm: card("Cataclysm", "Sorcery", "Each player chooses from among the permanents they control an artifact, a creature, an enchantment, and a land, then sacrifices the rest.", { manaCost: "{2}{W}{W}", cmc: 4 }),

  // --- extra turns and recursion ---
  timeWarp: card("Time Warp", "Sorcery", "Target player takes an extra turn after this one.", { manaCost: "{3}{U}{U}", cmc: 5 }),
  temporalMastery: card("Temporal Mastery", "Sorcery", "Take an extra turn after this one. Exile Temporal Mastery.\nMiracle {1}{U} (You may cast this card for its miracle cost when you draw it if it's the first card you drew this turn.)", { manaCost: "{5}{U}{U}", cmc: 7, keywords: ["Miracle"] }),
  nexusOfFate: card("Nexus of Fate", "Instant", "Take an extra turn after this one.\nIf Nexus of Fate would be put into a graveyard from anywhere, reveal Nexus of Fate and shuffle it into its owner's library instead.", { manaCost: "{5}{U}{U}", cmc: 7 }),
  regrowth: card("Regrowth", "Sorcery", "Return target card from your graveyard to your hand.", { manaCost: "{1}{G}", cmc: 2 }),
  mysticSanctuary: card("Mystic Sanctuary", "Land — Island", "({T}: Add {U}.)\nMystic Sanctuary enters tapped unless you control three or more other Islands.\nWhen Mystic Sanctuary enters untapped, you may put target instant or sorcery card from your graveyard on top of your library."),
  pastInFlames: card("Past in Flames", "Sorcery", "Each instant and sorcery card in your graveyard gains flashback until end of turn. The flashback cost is equal to its mana cost.\nFlashback {4}{R}", { manaCost: "{3}{R}", cmc: 4, keywords: ["Flashback"] }),

  // --- tutors and ramp ---
  demonicTutor: card("Demonic Tutor", "Sorcery", "Search your library for a card, put that card into your hand, then shuffle.", { manaCost: "{1}{B}", cmc: 2 }),
  worldlyTutor: card("Worldly Tutor", "Instant", "Search your library for a creature card, reveal that card, put it on top of your library, then shuffle.", { manaCost: "{G}", cmc: 1 }),
  enlightenedTutor: card("Enlightened Tutor", "Instant", "Search your library for an artifact or enchantment card, reveal it, put it on top of your library, then shuffle.", { manaCost: "{W}", cmc: 1 }),
  mysticalTutor: card("Mystical Tutor", "Instant", "Search your library for an instant or sorcery card, reveal it, put it on top of your library, then shuffle.", { manaCost: "{U}", cmc: 1 }),
  rampantGrowth: card("Rampant Growth", "Sorcery", "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.", { manaCost: "{1}{G}", cmc: 2 }),
  squadronHawk: card("Squadron Hawk", "Creature — Bird", "Flying\nWhen Squadron Hawk enters, you may search your library for up to three cards named Squadron Hawk, reveal them, put them into your hand, then shuffle.", { manaCost: "{1}{W}", cmc: 2, keywords: ["Flying"] }),
  chordOfCalling: card("Chord of Calling", "Instant", "Convoke\nSearch your library for a creature card with mana value X or less, put it onto the battlefield, then shuffle.", { manaCost: "{X}{G}{G}{G}", cmc: 3, keywords: ["Convoke"] }),

  // --- mana ---
  solRing: card("Sol Ring", "Artifact", "{T}: Add {C}{C}.", { manaCost: "{1}", cmc: 1 }),
  manaCrypt: card("Mana Crypt", "Artifact", "At the beginning of your upkeep, flip a coin. If you lose the flip, Mana Crypt deals 3 damage to you.\n{T}: Add {C}{C}.", { manaCost: "{0}", cmc: 0 }),
  darkRitual: card("Dark Ritual", "Instant", "Add {B}{B}{B}.", { manaCost: "{B}", cmc: 1 }),
  lotusPetal: card("Lotus Petal", "Artifact", "{T}, Sacrifice Lotus Petal: Add one mana of any color.", { manaCost: "{0}", cmc: 0 }),
  arcaneSignet: card("Arcane Signet", "Artifact", "{T}: Add one mana of any color in your commander's color identity.", { manaCost: "{2}", cmc: 2 }),
  llanowar: card("Llanowar Elves", "Creature — Elf Druid", "{T}: Add {G}.", { manaCost: "{G}", cmc: 1 }),
  forest: card("Forest", "Basic Land — Forest", "({T}: Add {G}.)", { quantity: 1 }),

  // --- free interaction ---
  forceOfWill: card("Force of Will", "Instant", "You may exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.", { manaCost: "{3}{U}{U}", cmc: 5 }),
  fierceGuardianship: card("Fierce Guardianship", "Instant", "If you control a commander, you may cast this spell without paying its mana cost.\nCounter target noncreature spell.", { manaCost: "{2}{U}", cmc: 3 }),
  counterspell: card("Counterspell", "Instant", "Counter target spell.", { manaCost: "{U}{U}", cmc: 2 }),

  // --- combo pieces ---
  thassasOracle: card("Thassa's Oracle", "Creature — Merfolk Wizard", "When Thassa's Oracle enters, look at the top X cards of your library, where X is your devotion to blue. Put up to one of them on top of your library and the rest on the bottom of your library in a random order. If X is greater than or equal to the number of cards in your library, you win the game.", { manaCost: "{U}{U}", cmc: 2 }),
  demonicConsultation: card("Demonic Consultation", "Instant", "Choose a card name. Exile the top six cards of your library, then reveal cards from the top of your library until you reveal a card with the chosen name. Put that card into your hand and exile all other cards revealed this way.", { manaCost: "{B}", cmc: 1 }),

  // --- a two-faced game changer ---
  delver: card("Delver of Secrets // Insectile Aberration", "Creature — Human Wizard // Creature — Human Insect", "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.\n//\nFlying", { manaCost: "{U}", cmc: 1 }),

  // --- archetype material ---
  krenko: card("Krenko, Mob Boss", "Legendary Creature — Goblin Warrior", "{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.", { manaCost: "{2}{R}{R}", cmc: 4, board: "commander" }),
  intangibleVirtue: card("Intangible Virtue", "Enchantment", "Creature tokens you control get +1/+1 and have vigilance.", { manaCost: "{1}{W}", cmc: 2 }),
  anointedProcession: card("Anointed Procession", "Enchantment", "If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.", { manaCost: "{3}{W}", cmc: 4 }),
  raiseTheAlarm: card("Raise the Alarm", "Instant", "Create two 1/1 white Soldier creature tokens.", { manaCost: "{1}{W}", cmc: 2 }),
  skirkProspector: card("Skirk Prospector", "Creature — Goblin", "Sacrifice a Goblin: Add {R}.", { manaCost: "{R}", cmc: 1 }),
  goblinWarchief: card("Goblin Warchief", "Creature — Goblin Warrior", "Goblin spells you cast cost {1} less to cast.\nGoblins you control have haste.", { manaCost: "{1}{R}{R}", cmc: 3 }),
  goblinChieftain: card("Goblin Chieftain", "Creature — Goblin", "Haste\nOther Goblin creatures you control get +1/+1 and have haste.", { manaCost: "{1}{R}{R}", cmc: 3, keywords: ["Haste"] }),
  bloodArtist: card("Blood Artist", "Creature — Vampire", "Whenever Blood Artist or another creature dies, target player loses 1 life and you gain 1 life.", { manaCost: "{1}{B}", cmc: 2 }),
  viscera: card("Viscera Seer", "Creature — Vampire Wizard", "Sacrifice a creature: Scry 1.", { manaCost: "{B}", cmc: 1 }),
  guttersnipe: card("Guttersnipe", "Creature — Goblin Shaman", "Whenever you cast an instant or sorcery spell, Guttersnipe deals 2 damage to each opponent.", { manaCost: "{2}{R}", cmc: 3 }),
};

function goblin(i: number): AnalysisCard {
  return card(`Goblin Grunt ${i}`, "Creature — Goblin", "Haste", { manaCost: "{R}", cmc: 1, keywords: ["Haste"] });
}

/** A small goblin tokens list: tokens + tribal + aristocrats-ish. */
export function goblinDeck(): AnalysisCard[] {
  return [F.krenko, F.intangibleVirtue, F.anointedProcession, F.raiseTheAlarm, F.skirkProspector, F.goblinWarchief, F.goblinChieftain, ...Array.from({ length: 12 }, (_, i) => goblin(i + 1)), F.solRing, { ...F.forest, name: "Mountain", typeLine: "Basic Land — Mountain", oracleText: "({T}: Add {R}.)", quantity: 30 }];
}

/** The Thassa's Oracle + Demonic Consultation variant as Spellbook returns it (trimmed). */
export const THORACLE_VARIANT = {
  id: "742-1295",
  status: "OK",
  identity: "UB",
  uses: [
    { card: { name: "Demonic Consultation" }, quantity: 1 },
    { card: { name: "Thassa's Oracle" }, quantity: 1 },
  ],
  requires: [],
  produces: [
    { feature: { name: "Exile your library" } },
    { feature: { name: "Win the game" } },
  ],
  manaValueNeeded: 3,
  bracketTag: "R",
};

export const THREE_CARD_VARIANT = {
  id: "1-2-3",
  status: "OK",
  identity: "G",
  uses: [{ card: { name: "A" } }, { card: { name: "B" } }, { card: { name: "C" } }],
  requires: [],
  produces: [{ feature: { name: "Infinite green mana" } }],
  manaValueNeeded: 9,
  bracketTag: "P",
};

export const EXPENSIVE_TWO_CARD_VARIANT = {
  id: "9-10",
  status: "OK",
  identity: "W",
  uses: [{ card: { name: "Big One" } }, { card: { name: "Other One" } }],
  requires: [],
  produces: [{ feature: { name: "Infinite ETB" } }],
  manaValueNeeded: 11,
  bracketTag: "P",
};
