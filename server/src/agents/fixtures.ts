import { applyEvent, type CardPrinting, type GameEvent, type GameState } from "@cgwf/shared";

/** Minimal printings for agent tests (no images, no legalities). */
export function printing(name: string, typeLine: string, opts: Partial<Pick<CardPrinting, "manaCost" | "cmc" | "oracleText" | "power" | "toughness" | "keywords">> = {}): CardPrinting {
  const id = `p-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return {
    id,
    oracleId: `o-${id}`,
    name,
    set: "tst",
    setName: "Test",
    collectorNumber: "1",
    releasedAt: "2020-01-01",
    rarity: "common",
    layout: "normal",
    manaCost: opts.manaCost ?? "",
    cmc: opts.cmc ?? 0,
    typeLine,
    oracleText: opts.oracleText ?? "",
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

export const FOREST = printing("Forest", "Basic Land — Forest", { oracleText: "({T}: Add {G}.)" });
export const BEARS = printing("Grizzly Bears", "Creature — Bear", { manaCost: "{1}{G}", cmc: 2, power: "2", toughness: "2" });
export const ELF = printing("Llanowar Elves", "Creature — Elf Druid", { manaCost: "{G}", cmc: 1, power: "1", toughness: "1", oracleText: "{T}: Add {G}." });
export const GIANT = printing("Hill Giant", "Creature — Giant", { manaCost: "{3}{R}", cmc: 4, power: "3", toughness: "3" });
export const BOLT = printing("Lightning Bolt", "Instant", { manaCost: "{R}", cmc: 1, oracleText: "Lightning Bolt deals 3 damage to any target." });
export const COMMANDER = printing("Test Commander", "Legendary Creature — Human", { manaCost: "{2}{G}", cmc: 3, power: "3", toughness: "3" });

/** A deck whose library is a sequence of uniquely named cards, so hidden-information leaks are detectable by name. */
export function secretDeck(tag: string, size = 20): { library: CardPrinting[]; commanders: CardPrinting[] } {
  const library: CardPrinting[] = [];
  for (let i = 0; i < size; i++) {
    library.push(i % 2 === 0 ? printing(`Secret ${tag} land ${String(i).padStart(2, "0")}`, "Basic Land — Forest") : printing(`Secret ${tag} spell ${String(i).padStart(2, "0")}`, "Creature — Secret", { manaCost: "{1}{G}", cmc: 2, power: "2", toughness: "2" }));
  }
  return { library, commanders: [printing(`${tag} Commander`, "Legendary Creature — Human", { manaCost: "{2}{G}", cmc: 3, power: "3", toughness: "3" })] };
}

/** Start a game between the given players (seat order) with the given decks. */
export function startedGame(players: Array<{ id: string; name: string }>, decks: Record<string, { library: CardPrinting[]; commanders: CardPrinting[] }>, seed = "seed-1"): GameState {
  const ev: GameEvent = {
    seq: 1,
    actor: "system",
    ts: 0,
    type: "GameStarted",
    payload: { players: players.map((p, seat) => ({ ...p, seat })), decks, startingLife: 40 },
  };
  return applyEvent(null, ev, seed);
}

export function apply(state: GameState, actor: string, ev: Omit<GameEvent, "seq" | "actor" | "ts">, seed = "seed-1"): GameState {
  return applyEvent(state, { ...ev, seq: state.seq + 1, actor, ts: 0 } as GameEvent, seed);
}
