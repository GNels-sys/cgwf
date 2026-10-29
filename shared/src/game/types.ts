import type { CardPrinting, Color } from "../cards.js";

/**
 * Game model shared by server and client. The server is the only holder of
 * the true GameState; clients receive a filtered PlayerView (see view.ts).
 */

export type PlayerId = string;
export const SYSTEM_ACTOR = "system";

export const ZONE_KINDS = ["library", "hand", "graveyard", "exile", "command", "battlefield"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

/**
 * Battlefield sections. Laid out as three rows on the table: Other on top,
 * then Creatures | Enchantments, then Lands | Artifacts. A card's section is
 * state (everyone sees the same), defaulted from the type line (sections.ts)
 * and freely overridable by the player.
 */
export const ROWS = ["other", "creatures", "enchantments", "lands", "artifacts"] as const;
export type Row = (typeof ROWS)[number];
export type Section = Row;
export const SECTIONS = ROWS;

/** Where a card sits: a zone belonging to a player, plus a section on the battlefield. */
export interface ZoneRef {
  kind: ZoneKind;
  owner: PlayerId;
  row?: Row;
}

export interface CustomToken {
  name: string;
  typeLine: string;
  power: string | null;
  toughness: string | null;
  colors: Color[];
  text: string;
}

/** What an attachment grants its host (confirmed by the player, parsed from oracle text). */
export interface AttachmentEffect {
  power: number;
  toughness: number;
  keywords: string[];
}

/** Manual adjustments on a permanent for whatever the parsers miss. */
export interface CardModifier {
  power: number;
  toughness: number;
  keywords: string[];
  removedKeywords: string[];
}

export interface ManualAnthem {
  id: string;
  power: number;
  toughness: number;
  keywords: string[];
  note: string;
}

export const MANA_COLORS = ["W", "U", "B", "R", "G", "C"] as const;
export type ManaColor = (typeof MANA_COLORS)[number];
export type ManaPool = Record<ManaColor, number>;
export const EMPTY_MANA: ManaPool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };

/** An advisory "this may have triggered" note; nothing is enforced. */
export interface PendingTrigger {
  id: string;
  iid: string;
  controller: PlayerId;
  /** Short family label, e.g. "Landfall", "ETB", "Upkeep". */
  kind: string;
  /** Card name at the time, for the panel and the log. */
  name: string;
  seq: number;
}

export interface CardInstance {
  /** Opaque instance id, unique within a game. */
  iid: string;
  /** Full printing data; null only for custom (text-only) tokens. */
  printing: CardPrinting | null;
  custom: CustomToken | null;
  /** Who brought the card to the game (tokens: who created them). */
  owner: PlayerId;
  zone: ZoneRef;
  tapped: boolean;
  faceDown: boolean;
  /** Which face is up for two-faced cards (0 front, 1 back). */
  face: 0 | 1;
  counters: Record<string, number>;
  /** Host instance this card is attached to (auras, equipment), if any. */
  attachedTo: string | null;
  /** Who may see this card's identity while it is in a hidden zone or face-down. */
  revealedTo: PlayerId[] | "all" | null;
  isToken: boolean;
  isCommander: boolean;
  /** When attached: what this card grants its host. */
  effect: AttachmentEffect | null;
  modifier: CardModifier | null;
  /** The player hid this card's detected anthem (conditional ones). */
  anthemDismissed: boolean;
}

export type Battlefield = Record<Section, string[]>;

export interface PlayerZones {
  /** Index 0 is the top of the library. */
  library: string[];
  hand: string[];
  graveyard: string[];
  exile: string[];
  command: string[];
  battlefield: Battlefield;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  seat: number;
  life: number;
  /** poison, energy, experience, and anything the players name. */
  counters: Record<string, number>;
  /** Damage taken, keyed by the commander instance that dealt it. */
  commanderDamage: Record<string, number>;
  /** Extra cost accumulated per commander instance. */
  commanderTax: Record<string, number>;
  mulligans: number;
  kept: boolean;
  /** Cards still to put on the bottom after keeping a mulliganed hand. */
  toBottom: number;
  conceded: boolean;
  /** Set automatically at 0 life, 10 poison or 21 commander damage from one commander; cleared when the cause goes away (revert, corrected life). */
  eliminated: EliminationCause | null;
  zones: PlayerZones;
  mana: ManaPool;
  /** Keep floating mana across steps (cards that carry mana over). */
  keepMana: boolean;
  manualAnthems: ManualAnthem[];
}

export type EliminationCause = "life" | "poison" | "commander damage";

/** Conceded or eliminated: skipped for turns, never attacked, not counted as alive. */
export function isOut(p: { conceded: boolean; eliminated: EliminationCause | null }): boolean {
  return p.conceded || p.eliminated !== null;
}

// ---------------------------------------------------------------- combat

export interface CombatAttacker {
  iid: string;
  /** Defending player. */
  player: PlayerId;
  /** Planeswalker or battle being attacked instead of the player (controlled by `player`). */
  planeswalker: string | null;
}

export interface CombatBlocker {
  iid: string;
  /** The attacker this creature blocks. */
  attacker: string;
  /** The defending player who declared the block. */
  player: PlayerId;
}

export interface CombatState {
  /** The attacking (active) player. */
  attacker: PlayerId;
  attackers: CombatAttacker[];
  blockers: CombatBlocker[];
  /** Defenders who have declared their blocks (possibly none). */
  blockersDeclared: PlayerId[];
  /** Attackers the declaration tapped (untapped again when attackers are re-declared). */
  tappedByAttack: string[];
  damageDealt: boolean;
}

export type DamageTarget = { kind: "player"; player: PlayerId } | { kind: "card"; iid: string };

/** One source (attacker or blocker) dealing `amount` combat damage to one target. */
export interface DamageAssignment {
  source: string;
  target: DamageTarget;
  amount: number;
}

/** "You win the game" card whose printed condition appears to be met; the controller confirms. */
export interface WinAdvisory {
  id: string;
  iid: string;
  controller: PlayerId;
  name: string;
  /** Human-readable condition, e.g. "20 or more charge counters (has 20)". */
  condition: string;
}

export const STEPS = [
  "untap",
  "upkeep",
  "draw",
  "main1",
  "beginCombat",
  "attackers",
  "blockers",
  "damage",
  "endCombat",
  "main2",
  "end",
  "cleanup",
] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Record<Step, string> = {
  untap: "Untap",
  upkeep: "Upkeep",
  draw: "Draw",
  main1: "Main 1",
  beginCombat: "Begin combat",
  attackers: "Attackers",
  blockers: "Blockers",
  damage: "Damage",
  endCombat: "End combat",
  main2: "Main 2",
  end: "End step",
  cleanup: "Cleanup",
};

/** Reserved for a later rules engine: nothing is ever pushed in v1. */
/** What a stack item points at (engine tables): a card, a player or another stack item. */
export type StackTargetRef = { kind: "card"; iid: string; name: string | null } | { kind: "player"; player: PlayerId } | { kind: "stack"; id: string; name: string | null; iid: string | null };

export interface StackItem {
  id: string;
  controller: PlayerId;
  sourceIid: string | null;
  description: string;
  /** Engine tables: spell, activated ability or triggered ability. */
  kind?: "spell" | "ability" | "trigger";
  /** Engine tables: the source card's name and printing (stack items are public). */
  name?: string | null;
  printingId?: string | null;
  /** Engine tables: what it targets, in order. */
  targets?: StackTargetRef[];
}

export type GamePhase = "mulligan" | "playing" | "ended";

export interface LogEntry {
  seq: number;
  actor: PlayerId | typeof SYSTEM_ACTOR;
  text: string;
  ts: number;
  /** Engine tables (2026-10-29): turn | step | round | event, from Forge's log entry type. Absent on classic tables and older lines. */
  kind?: "turn" | "step" | "round" | "event";
}

export interface GameState {
  format: "commander";
  phase: GamePhase;
  players: Record<PlayerId, PlayerState>;
  /** Seat order; turns go round this list skipping conceded players. */
  turnOrder: PlayerId[];
  cards: Record<string, CardInstance>;
  activePlayer: PlayerId;
  turn: number;
  step: Step;
  /** Reserved concepts (see StackItem). Priority is never assigned in v1. */
  stack: StackItem[];
  priority: PlayerId | null;
  rng: number;
  log: LogEntry[];
  /** Seq of the last event applied. */
  seq: number;
  winner: PlayerId | null;
  pendingTriggers: PendingTrigger[];
  /** The active player has taken this turn's draw (automatic when the draw step is reached or passed). */
  drewForTurn: boolean;
  /** The combat in progress this turn, if attackers were declared. */
  combat: CombatState | null;
  /** Recomputed after every event: "you win the game" cards whose condition looks met (minus dismissed ones). */
  winAdvisories: WinAdvisory[];
  /** Cards whose win prompt the controller dismissed. */
  dismissedWins: string[];
}

// ---------------------------------------------------------------- events

export interface DeckForGame {
  library: CardPrinting[];
  commanders: CardPrinting[];
}

export interface GameStartedPayload {
  players: Array<{ id: PlayerId; name: string; seat: number }>;
  decks: Record<PlayerId, DeckForGame>;
  startingLife: number;
}

export type LibraryPosition = "top" | "bottom" | number;

export interface MoveTarget {
  kind: ZoneKind;
  owner: PlayerId;
  row?: Row;
  /** Library only: where to insert. Defaults to top. */
  position?: LibraryPosition;
  /** Battlefield / exile: put the card face-down. */
  faceDown?: boolean;
}

export type EventPayloads = {
  GameStarted: GameStartedPayload;
  /** London mulligan: shuffle the hand back and draw seven again. */
  Mulligan: { player: PlayerId };
  /** Keep the hand; with n mulligans the player then bottoms n cards by hand. */
  HandKept: { player: PlayerId };
  CardsDrawn: { player: PlayerId; count: number };
  CardMoved: { iid: string; to: MoveTarget };
  CardTapped: { iid: string; tapped: boolean };
  UntapAll: { player: PlayerId };
  /** Transform / flip to the other face. */
  CardFlipped: { iid: string };
  CardTurned: { iid: string; faceDown: boolean };
  /** Reveal a card in hand (or a face-down card) to everyone. */
  CardRevealed: { iid: string };
  CounterChanged: { iid: string; kind: string; delta: number };
  LifeChanged: { player: PlayerId; delta?: number; value?: number };
  PlayerCounterChanged: { player: PlayerId; kind: string; delta: number };
  CommanderDamage: { player: PlayerId; commanderIid: string; delta: number };
  CommanderTaxChanged: { player: PlayerId; commanderIid: string; delta: number };
  LibraryShuffled: { player: PlayerId };
  /** Reveal the top n cards to everyone (they stay on top). */
  LibraryRevealed: { player: PlayerId; count: number };
  /** Look at the top n cards privately. */
  LibraryLooked: { player: PlayerId; count: number };
  /** Search: the whole library becomes visible to its owner until it is shuffled. */
  LibrarySearched: { player: PlayerId };
  Milled: { player: PlayerId; count: number };
  TokenCreated: { player: PlayerId; printing: CardPrinting | null; custom: CustomToken | null; count: number; row: Row };
  /** Token copy of a permanent, under the creator's control. */
  CardCopied: { iid: string; player: PlayerId };
  Attached: { iid: string; to: string | null; effect?: AttachmentEffect | null };
  /** Edit what an attachment grants after the fact. */
  AttachmentEffectSet: { iid: string; effect: AttachmentEffect | null };
  CardModifierSet: { iid: string; modifier: CardModifier | null };
  AnthemDismissed: { iid: string; dismissed: boolean };
  ManualAnthemAdded: { player: PlayerId; power: number; toughness: number; keywords: string[]; note: string };
  ManualAnthemRemoved: { player: PlayerId; id: string };
  TriggerResolved: { id: string };
  TriggersDismissed: { player: PlayerId };
  ManaChanged: { player: PlayerId; color: ManaColor; delta: number };
  ManaConverted: { player: PlayerId; to: ManaColor };
  ManaEmptied: { player: PlayerId };
  KeepManaToggled: { player: PlayerId; keep: boolean };
  TurnAdvanced: Record<string, never>;
  StepAdvanced: Record<string, never>;
  StepSet: { step: Step };
  DiceRolled: { player: PlayerId; sides: number; count?: number };
  CoinFlipped: { player: PlayerId };
  RandomOpponent: { player: PlayerId };
  PlayerConceded: { player: PlayerId };
  /** A short public note in the log ("Attacking Blair with Krenko for 6"). Agents announce intent with it. */
  NoteAdded: { player: PlayerId; text: string };
  /**
   * Take control of another player's permanent (or a card in their graveyard/exile): it moves to
   * the actor's battlefield. The only way to move a card you do not control; always logged.
   */
  ControlTaken: { iid: string; row?: Row };
  /** Active player declares attackers: each creature attacks a player or one of their planeswalkers/battles. Taps them unless they have vigilance. */
  AttackersDeclared: { attacks: Array<{ iid: string; player: PlayerId; planeswalker?: string | null }> };
  /** A defending player declares blocks (replaces their earlier declaration; an empty list = no blocks). */
  BlockersDeclared: { player: PlayerId; blocks: Array<{ iid: string; attacker: string }> };
  /** Apply combat damage. Without `assignments` the default proposal (combat.ts) is used. */
  CombatDamageDealt: { assignments?: DamageAssignment[] };
  /** Controller confirms a detected "you win the game" condition; the game ends. */
  WinClaimed: { iid: string };
  /** Controller hides the win prompt for that card. */
  WinAdvisoryDismissed: { iid: string };
  /** Rewind the game to just after event `toSeq`. Applied by the replayer, not the reducer. */
  Revert: { toSeq: number; reason?: string };
  /** Engine tables: one line of the rules engine's log (appended by the relay, never by a client). */
  EngineLog: { engineSeq: number; turn: number; logType: string; text: string };
  /** Engine tables: a seat's answer to a prompt, kept so the game can be replayed later. */
  EngineAnswer: { seat: number; promptId: number; prompt: string; answer: Record<string, unknown> };
  /** Engine tables: how the engine ended the game. */
  EngineGameOver: { winner: PlayerId | null; endReason: string | null; turns: number };
  /** Engine tables, before the first turn: one D20 roll for who goes first (rolled by the server). */
  EngineRoll: { round: number; seat: number; value: number; auto: boolean };
  /** Engine tables: who goes first, handed to Forge as the starting player. */
  EngineFirstPlayer: { seat: number; method: "roll" | "random" };
};

export type EventType = keyof EventPayloads;
export const EVENT_TYPES = Object.keys({
  GameStarted: 0,
  Mulligan: 0,
  HandKept: 0,
  CardsDrawn: 0,
  CardMoved: 0,
  CardTapped: 0,
  UntapAll: 0,
  CardFlipped: 0,
  CardTurned: 0,
  CardRevealed: 0,
  CounterChanged: 0,
  LifeChanged: 0,
  PlayerCounterChanged: 0,
  CommanderDamage: 0,
  CommanderTaxChanged: 0,
  LibraryShuffled: 0,
  LibraryRevealed: 0,
  LibraryLooked: 0,
  LibrarySearched: 0,
  Milled: 0,
  TokenCreated: 0,
  CardCopied: 0,
  Attached: 0,
  AttachmentEffectSet: 0,
  CardModifierSet: 0,
  AnthemDismissed: 0,
  ManualAnthemAdded: 0,
  ManualAnthemRemoved: 0,
  TriggerResolved: 0,
  TriggersDismissed: 0,
  ManaChanged: 0,
  ManaConverted: 0,
  ManaEmptied: 0,
  KeepManaToggled: 0,
  TurnAdvanced: 0,
  StepAdvanced: 0,
  StepSet: 0,
  DiceRolled: 0,
  CoinFlipped: 0,
  RandomOpponent: 0,
  PlayerConceded: 0,
  NoteAdded: 0,
  ControlTaken: 0,
  AttackersDeclared: 0,
  BlockersDeclared: 0,
  CombatDamageDealt: 0,
  WinClaimed: 0,
  WinAdvisoryDismissed: 0,
  Revert: 0,
  EngineLog: 0,
  EngineAnswer: 0,
  EngineGameOver: 0,
  EngineRoll: 0,
  EngineFirstPlayer: 0,
} satisfies Record<EventType, 0>) as EventType[];

/** Event types only the relay appends on engine tables; a client may never send them and the classic reducer refuses them. */
export const ENGINE_ONLY_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>(["EngineLog", "EngineAnswer", "EngineGameOver", "EngineRoll", "EngineFirstPlayer"]);

/** What a client sends: type + payload. The server adds seq, actor and ts. */
export type EventInput = { [K in EventType]: { type: K; payload: EventPayloads[K] } }[EventType];

export type GameEvent = EventInput & {
  seq: number;
  actor: PlayerId | typeof SYSTEM_ACTOR;
  ts: number;
};

export const STARTING_LIFE = 40;
export const HAND_SIZE = 7;
export const PLAYER_COUNTER_KINDS = ["poison", "energy", "experience"] as const;
export const CARD_COUNTER_KINDS = ["+1/+1", "-1/-1", "loyalty", "charge"] as const;

export function isZoneKind(v: unknown): v is ZoneKind {
  return typeof v === "string" && (ZONE_KINDS as readonly string[]).includes(v);
}
export function isRow(v: unknown): v is Row {
  return typeof v === "string" && (ROWS as readonly string[]).includes(v);
}
export function isManaColor(v: unknown): v is ManaColor {
  return typeof v === "string" && (MANA_COLORS as readonly string[]).includes(v);
}
export function isStep(v: unknown): v is Step {
  return typeof v === "string" && (STEPS as readonly string[]).includes(v);
}
export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}
