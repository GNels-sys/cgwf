import type { PlayerId } from "./game/types.js";

/**
 * Rules-engine (Forge) games. The CGwF server relays frames between the engine service and the
 * players' room sockets; the browser only ever sees the shapes below, embedded in the normal
 * `state` frame as `view.engine`, plus the `engine` client message to answer prompts.
 *
 * Card references inside prompts use `iid` = the engine's card id as a string (the same ids the
 * view's cards carry), so a client can match an option to a tile.
 */

/** Forge's steps, as the engine names them. Mapped onto our Step for the phase strip. */
export const ENGINE_PHASES = [
  "UNTAP",
  "UPKEEP",
  "DRAW",
  "MAIN1",
  "COMBAT_BEGIN",
  "COMBAT_DECLARE_ATTACKERS",
  "COMBAT_DECLARE_BLOCKERS",
  "COMBAT_FIRST_STRIKE_DAMAGE",
  "COMBAT_DAMAGE",
  "COMBAT_END",
  "MAIN2",
  "END_OF_TURN",
  "CLEANUP",
] as const;
export type EnginePhase = (typeof ENGINE_PHASES)[number];

/** A card as a prompt option (identity is always present: the engine only offers what the seat may see). */
export interface EngineOptionCard {
  kind: "card";
  index: number;
  iid: string;
  name: string;
  /** Scryfall printing id when the relay could map it, else null (the client falls back to the name). */
  printingId: string | null;
  zone: string;
  controller: PlayerId | null;
  owner: PlayerId | null;
  tapped: boolean;
  power: number | null;
  toughness: number | null;
  /** Attackers prompt: which defenders this creature may attack. */
  canAttack?: EngineEntityRef[];
  /** Blockers prompt: which attackers (iids) this creature may block. */
  canBlock?: string[];
  /** Blockers prompt: who/what the attacker is attacking. */
  attacking?: EngineEntityRef;
}

export interface EngineOptionPlayer {
  kind: "player";
  index: number;
  player: PlayerId;
  name: string;
  life?: number;
}

export interface EngineOptionText {
  kind: "text";
  index: number;
  label: string;
}

export type EngineOption = EngineOptionCard | EngineOptionPlayer | EngineOptionText;

export type EngineEntityRef = { kind: "player"; player: PlayerId; name?: string; life?: number } | { kind: "card"; iid: string; name?: string | null; controller?: PlayerId | null };

/** One playable ability in a priority prompt. */
export interface EnginePlayable {
  index: number;
  iid: string;
  cardName: string;
  zone: string;
  kind: "land" | "spell" | "ability";
  description: string;
  cost: string | null;
  targets: boolean;
}

export type EnginePrompt =
  | { kind: "priority"; promptId: number; title: string; options: EnginePlayable[]; phase: EnginePhase | null; myTurn: boolean; stackEmpty: boolean; stackTopMine: boolean }
  | { kind: "targets"; promptId: number; title: string; ability: string; min: number; max: number; options: EngineOption[] }
  | { kind: "attackers"; promptId: number; title: string; candidates: EngineOptionCard[]; defenders: EngineEntityRef[] }
  | { kind: "blockers"; promptId: number; title: string; attackers: EngineOptionCard[]; blockers: EngineOptionCard[] }
  | { kind: "choose"; promptId: number; title: string; optional: boolean; source: string | null; options: EngineOption[] }
  | { kind: "chooseMany"; promptId: number; title: string; min: number; max: number; source: string | null; options: EngineOption[]; reason?: string }
  | { kind: "confirm"; promptId: number; title: string; options: string[]; source: string | null; card: EngineOptionCard | null }
  | { kind: "mulligan"; promptId: number; title: string; cardsToReturn: number; hand: EngineOptionCard[] };

export type EnginePromptKind = EnginePrompt["kind"];

/** Answers, mirrored from the engine protocol; `promptId` must echo the prompt. */
export type EngineAnswer =
  | { promptId: number; option: number | null; passUntilTurn?: number; concede?: boolean }
  | { promptId: number; options: number[]; cancel?: boolean }
  | { promptId: number; attacks: Array<{ iid: string; defender: EngineEntityRef }> }
  | { promptId: number; blocks: Array<{ blockerIid: string; attackerIid: string }> }
  | { promptId: number; confirm: boolean }
  | { promptId: number; keep: boolean };

/** Arena-style stops: steps at which the engine offers priority instead of passing for the seat. */
export interface EngineStops {
  myTurn: EnginePhase[];
  theirTurn: EnginePhase[];
  /** Always stop when the top of the stack is someone else's. */
  respond: boolean;
}

export const DEFAULT_ENGINE_STOPS: EngineStops = {
  myTurn: ["MAIN1", "COMBAT_DECLARE_ATTACKERS", "MAIN2", "END_OF_TURN"],
  theirTurn: ["END_OF_TURN"],
  respond: true,
};

/** What a stack item looks like in an engine game (the classic StackItem shape, plus who is waiting). */
export interface EngineInfo {
  /** Forge's current step name. */
  phase: EnginePhase | null;
  /** The prompt this seat must answer, or null when the engine is not waiting on this seat. */
  prompt: EnginePrompt | null;
  /** Players the engine is waiting on right now (whoever has an open prompt), for everyone's benefit. */
  waitingOn: PlayerId[];
  /** Cards that could be played right now (from the open priority prompt), for highlighting. */
  playable: string[];
  stops: EngineStops;
  /** True while the relay has lost the engine (the table shows "reconnecting to the rules engine"). */
  engineDown: boolean;
}

/** The engine's deck shape (what CGwF sends in createGame). */
export interface EngineDeckCard {
  name: string;
  setCode: string | null;
  number: string | null;
  scryfallId: string | null;
  count: number;
}
export interface EngineDeck {
  name: string;
  commanders: EngineDeckCard[];
  main: EngineDeckCard[];
}

/** Reasons a deck cannot start an engine game (blocking, unlike the classic table's warnings). */
export interface EngineDeckProblem {
  player: PlayerId;
  deckName: string;
  problems: string[];
}
