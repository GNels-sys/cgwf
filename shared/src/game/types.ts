import type { CardPrinting, Color } from "../cards.js";

/**
 * Game model shared by server and client. The server is the only holder of
 * the true GameState; clients receive a filtered PlayerView (see view.ts).
 */

export type PlayerId = string;
export const SYSTEM_ACTOR = "system";

export const ZONE_KINDS = ["library", "hand", "graveyard", "exile", "command", "battlefield"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

export const ROWS = ["lands", "creatures", "other"] as const;
export type Row = (typeof ROWS)[number];

/** Where a card sits: a zone belonging to a player, plus a row on the battlefield. */
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
}

export interface Battlefield {
  lands: string[];
  creatures: string[];
  other: string[];
}

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
  zones: PlayerZones;
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
export interface StackItem {
  id: string;
  controller: PlayerId;
  sourceIid: string | null;
  description: string;
}

export type GamePhase = "mulligan" | "playing" | "ended";

export interface LogEntry {
  seq: number;
  actor: PlayerId | typeof SYSTEM_ACTOR;
  text: string;
  ts: number;
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
  Attached: { iid: string; to: string | null };
  TurnAdvanced: Record<string, never>;
  StepAdvanced: Record<string, never>;
  StepSet: { step: Step };
  DiceRolled: { player: PlayerId; sides: number; count?: number };
  CoinFlipped: { player: PlayerId };
  RandomOpponent: { player: PlayerId };
  PlayerConceded: { player: PlayerId };
  /** Rewind the game to just after event `toSeq`. Applied by the replayer, not the reducer. */
  Revert: { toSeq: number; reason?: string };
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
  TurnAdvanced: 0,
  StepAdvanced: 0,
  StepSet: 0,
  DiceRolled: 0,
  CoinFlipped: 0,
  RandomOpponent: 0,
  PlayerConceded: 0,
  Revert: 0,
} satisfies Record<EventType, 0>) as EventType[];

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
export function isStep(v: unknown): v is Step {
  return typeof v === "string" && (STEPS as readonly string[]).includes(v);
}
export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}
