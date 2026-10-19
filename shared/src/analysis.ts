/**
 * Deck analysis + Commander Bracket shapes, shared so the client renders exactly
 * what the server computed. The engine itself lives in server/src/analysis
 * (pure functions over card rows); nothing here calls a model.
 */

export type Bracket = 1 | 2 | 3 | 4 | 5;

export const BRACKET_NAMES: Record<Bracket, string> = {
  1: "Exhibition",
  2: "Core",
  3: "Upgraded",
  4: "Optimized",
  5: "cEDH",
};

/** Why the floor is where it is. Each reason names the cards behind it. */
export type BracketReasonKind =
  | "game_changers"
  | "mass_land_denial"
  | "extra_turns"
  | "extra_turn_chaining"
  | "two_card_combo"
  | "cheap_two_card_combo";

export interface BracketReason {
  kind: BracketReasonKind;
  /** The lowest bracket this reason forces the deck into. */
  bracket: Bracket;
  cards: string[];
  text: string;
}

/** Soft signals that move the SUGGESTED bracket up (never the floor). */
export interface PowerSignal {
  kind: "fast_mana" | "tutors" | "free_interaction" | "low_curve" | "game_changers" | "combo_density" | "extra_turns" | "stax";
  weight: number;
  cards: string[];
  text: string;
}

export type TutorKind = "any" | "creature" | "artifact" | "enchantment" | "instant_sorcery" | "planeswalker" | "other";

export interface TutorHit {
  name: string;
  kind: TutorKind;
}

export interface ComboHit {
  /** Commander Spellbook variant id. */
  id: string;
  cards: string[];
  /** What the combo produces ("Infinite colorless mana", "Win the game"). */
  produces: string[];
  /** Mana value needed to assemble it, as Spellbook reports it. */
  manaValueNeeded: number;
  /** True when the combo is assembled from two cards (commander included). */
  twoCard: boolean;
  /** Two-card AND cheap enough to show up in the first ~6 turns (heuristic: total mana value <= 6). */
  early: boolean;
  /** Spellbook's own bracket tag (C core, E exhibition, P powerful, S spicy, R ruthless, O oddball, B banned). */
  bracketTag: string | null;
  url: string;
}

export type ArchetypeTag =
  | "tokens"
  | "counters"
  | "aristocrats"
  | "voltron"
  | "spellslinger"
  | "reanimator"
  | "lands"
  | "artifacts"
  | "enchantress"
  | "stax"
  | "group_hug"
  | "control"
  | "combo"
  | "aggro"
  | "tribal"
  | "blink"
  | "lifegain"
  | "mill"
  | "wheels"
  | "big_mana"
  | "theft"
  | "graveyard"
  | "storm"
  | "politics";

export interface ArchetypeHit {
  tag: ArchetypeTag;
  /** 0..1 */
  confidence: number;
  /** A few cards that drove the tag. */
  evidence: string[];
}

export interface DeckAnalysis {
  /** Lowest bracket the hard rules allow. */
  floor: Bracket;
  /** Our best guess at where the deck actually plays. */
  suggested: Bracket;
  reasons: BracketReason[];
  signals: PowerSignal[];
  /** Always present: the brackets are a conversation tool, 3 vs 4 especially. */
  judgmentNote: string;
  gameChangers: string[];
  massLandDenial: string[];
  extraTurns: { cards: string[]; chaining: boolean; chainingWhy: string | null };
  tutors: { count: number; cards: TutorHit[] };
  fastMana: string[];
  combos: ComboHit[];
  /** "ok" = Spellbook answered, "unavailable" = network/API problem (analysis still valid), "skipped" = not asked. */
  combosStatus: "ok" | "unavailable" | "skipped";
  archetypes: ArchetypeHit[];
  summary: string;
  stats: { cards: number; nonlandCount: number; landCount: number; averageManaValue: number; interactionCount: number; rampCount: number; cardDrawCount: number };
  /** Date of the Game Changers list used. */
  gameChangersListDate: string;
  computedAt: string;
}

export interface DeckAnalysisResponse {
  analysis: DeckAnalysis;
  /** True when the combo lookup came from the cache rather than a fresh request. */
  combosCached: boolean;
}

/** Library of decks the owner curates for Phase 7's agent opponents (and precons). */
export interface LibraryDeckSummary {
  id: string;
  name: string;
  /** "precon" (MTGJSON import), "user" (added from a player's deck) or "edhrec" (EDHREC average deck). */
  source: LibrarySource;
  /** Source page for imported lists (EDHREC), shown with the attribution. */
  sourceUrl: string | null;
  /** Importer details for EDHREC decks; null for precons and player decks. */
  importInfo: LibraryImportInfo | null;
  setCode: string | null;
  setName: string | null;
  releaseDate: string | null;
  commanders: string[];
  bracket: Bracket;
  floor: Bracket | null;
  suggested: Bracket | null;
  tags: ArchetypeTag[];
  agentEligible: boolean;
  hasPrimer: boolean;
  cardCount: number;
  updatedAt: string;
  /** User id credited with a user deck (the submitter, Phase 8), null for precons. */
  createdBy: string | null;
  createdByName: string | null;
  /** Rules-engine check for any source (2026-10-19); null = never checked. */
  engineCheck?: LibraryEngineCheck | null;
}

export interface LibraryEngineCheck {
  checkedAt: string | null;
  /** Cards Forge cannot play (empty = all known); null when the check could not run. */
  missing: string[] | null;
  /** Why an engine table would refuse the deck (size, singleton, colour identity...). */
  problems: string[];
  error: string | null;
  /** Who set agent eligibility last: the owner by hand, or a coverage check. */
  eligibleBy: "owner" | "coverage" | null;
}

export type LibrarySource = "precon" | "user" | "edhrec";

export function isLibrarySource(v: unknown): v is LibrarySource {
  return v === "precon" || v === "user" || v === "edhrec";
}

/** What the EDHREC importer recorded about one deck (library_decks.import_meta). */
export interface LibraryImportInfo {
  provider: "edhrec";
  slug: string;
  edhrecBracket: "upgraded" | "optimized" | "cedh";
  /** Decks EDHREC averaged for this commander at this bracket when it was imported. */
  decks: number;
  /** Rank by that deck count among the import's candidates. */
  rank: number;
  winCondition: string;
  fetchedAt: string;
  /** Why the importer picked it (diversity pass + reason). */
  pickReason: string;
  /** The analysis engine disagrees with EDHREC's bracket (EDHREC's is kept); null when they agree. */
  mismatch: string | null;
  /** Forge rules-engine coverage: null = not checked yet; `missing` = cards Forge cannot play. */
  coverage: { checkedAt: string; missing: string[] } | null;
  coverageError: string | null;
}

export interface LibraryDeckDetail extends LibraryDeckSummary {
  primer: string;
  analysis: DeckAnalysis | null;
  cards: Array<{
    cardId: string;
    name: string;
    quantity: number;
    board: string;
    typeLine: string;
    manaCost: string;
    /** The line's id (library_deck_cards.id) and the printing's details, for the printing picker. */
    entryId?: number;
    oracleId?: string | null;
    set?: string;
    collectorNumber?: string;
    faceCount?: number;
  }>;
  sourceKey: string | null;
  createdAt: string;
}

export interface LibraryImportState {
  running: boolean;
  phase: "idle" | "list" | "decks" | "coverage" | "done" | "error";
  total: number;
  done: number;
  imported: number;
  skipped: number;
  errors: string[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LibraryListResponse {
  decks: LibraryDeckSummary[];
  importState: LibraryImportState;
  /** Whole library per bracket, ignoring the filters: bot-eligible vs total (2026-10-19). */
  bracketCounts: Record<Bracket, { eligible: number; total: number }>;
}

/** Library-wide Forge coverage check (`cli check-library-coverage`, owner route). */
export interface LibraryCoverageState {
  running: boolean;
  phase: "idle" | "checking" | "done" | "error";
  message: string;
  total: number;
  checked: number;
  /** Switched on by this run. */
  enabled: number;
  /** Failing decks left on because the owner switched them on by hand. */
  keptByOwner: number;
  /** Decks Forge cannot play or that are not legal for engine tables. */
  excluded: number;
  /** Decks the check could not run for (engine down or busy). */
  unchecked: number;
  error: string | null;
  reportPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LibraryPatchRequest {
  name?: string;
  bracket?: Bracket;
  tags?: ArchetypeTag[];
  primer?: string;
  agentEligible?: boolean;
}

export const ARCHETYPE_TAGS: readonly ArchetypeTag[] = [
  "tokens",
  "counters",
  "aristocrats",
  "voltron",
  "spellslinger",
  "reanimator",
  "lands",
  "artifacts",
  "enchantress",
  "stax",
  "group_hug",
  "control",
  "combo",
  "aggro",
  "tribal",
  "blink",
  "lifegain",
  "mill",
  "wheels",
  "big_mana",
  "theft",
  "graveyard",
  "storm",
  "politics",
];

export const ARCHETYPE_LABELS: Record<ArchetypeTag, string> = {
  tokens: "Tokens",
  counters: "+1/+1 counters",
  aristocrats: "Aristocrats",
  voltron: "Voltron",
  spellslinger: "Spellslinger",
  reanimator: "Reanimator",
  lands: "Lands / landfall",
  artifacts: "Artifacts",
  enchantress: "Enchantress",
  stax: "Stax",
  group_hug: "Group hug",
  control: "Control",
  combo: "Combo",
  aggro: "Aggro",
  tribal: "Tribal",
  blink: "Blink / flicker",
  lifegain: "Lifegain",
  mill: "Mill",
  wheels: "Wheels",
  big_mana: "Big mana",
  theft: "Theft",
  graveyard: "Graveyard",
  storm: "Storm",
  politics: "Politics",
};

export function isBracket(v: unknown): v is Bracket {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
}

export function isArchetypeTag(v: unknown): v is ArchetypeTag {
  return typeof v === "string" && (ARCHETYPE_TAGS as readonly string[]).includes(v);
}
