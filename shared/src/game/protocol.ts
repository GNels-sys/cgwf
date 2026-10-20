import type { CardPrinting } from "../cards.js";
import type { AvatarColorKey, AvatarKey } from "../user.js";
import type { Look } from "../settings.js";
import type { EventInput, PlayerId } from "./types.js";
import type { PlayerView } from "./view.js";
import type { EngineAnswer, EngineNotice, EngineStops } from "../engine.js";
import type { RoomVoice } from "../discord.js";
import type { FirstPlayerMethod, FirstRollInfo } from "../firstRoll.js";

/**
 * Room + WebSocket protocol. The socket is opened at
 * `/api/rooms/:code/ws?token=<device token>`; every frame is one JSON object
 * with a `t` discriminator.
 */

export type RoomStatus = "lobby" | "playing" | "ended";
export type MemberRole = "player" | "spectator";

export interface RoomMember {
  userId: PlayerId;
  name: string;
  avatar: AvatarKey;
  color: AvatarColorKey;
  role: MemberRole;
  seat: number | null;
  deckId: string | null;
  deckName: string | null;
  commanders: string[];
  online: boolean;
  /** Playmat + sleeve this player chose (applied client-side by everyone). */
  look: Look;
  /** A computer opponent (Phase 7). Agents never have sockets; `online` means its runner is up. */
  isAgent: boolean;
  /** Agents only: a decision is in flight right now. */
  thinking: boolean;
  /** Engine tables only: why this seat's deck cannot start an engine game (empty = legal or no deck yet). */
  deckProblems: string[];
  /** Engine lobbies: the seated deck's bracket (library: stored; own deck: suggested), null = unknown. */
  deckBracket?: number | null;
}

export interface RoomInfo {
  id: string;
  code: string;
  status: RoomStatus;
  hostId: PlayerId;
  format: "commander";
  members: RoomMember[];
  createdAt: string;
  /** After a rematch: the code of the new table everyone should move to. */
  nextCode: string | null;
  /** Who you are in this room (null before joining). */
  you: { userId: PlayerId; role: MemberRole; seat: number | null } | null;
  /** Rules-engine table (Forge decides what is legal) instead of the classic manual table. */
  engine: boolean;
  /** Lobby setting: a test game is played normally but never counted in deck statistics. */
  testGame: boolean;
  /**
   * The table bracket (1-5) agreed before the game: the host's pick, or else the highest suggested
   * bracket among the seated decks; frozen when the game starts. Null when no deck's bracket is known.
   */
  tableBracket: number | null;
  /** True when the host picked the table bracket (false = the automatic default above). */
  tableBracketChosen: boolean;
  /** Voice on Discord: only members of this table get it (null for anyone else). */
  voice: RoomVoice | null;
  /** Engine tables, lobby setting (host): "roll" = everyone rolls a D20 for who goes first (default), "random" = the server picks. */
  firstPlayer: FirstPlayerMethod;
  /** Engine tables: the roll for who goes first (null before the start, and for random picks). */
  firstRoll: FirstRollInfo | null;
}

export const ROOM_CODE_LENGTH = 6;
export const MAX_SEATS = 4;

// client -> server
export type ClientMessage =
  | { t: "seat"; seat: number; deckId: string | null }
  | { t: "unseat" }
  | { t: "start" }
  | { t: "event"; event: EventInput; cid?: string }
  | { t: "undo" }
  | { t: "revert"; toSeq: number }
  /** Host only, once the game has ended: new table, same seats and decks, fresh seed. */
  | { t: "rematch" }
  /** Host only, in the lobby: the Test-game toggle and the table bracket (null = automatic). */
  | { t: "tableSettings"; testGame?: boolean; tableBracket?: number | null; firstPlayer?: FirstPlayerMethod }
  /** Engine tables, while rolling for who goes first: roll your D20 (the server rolls it). */
  | { t: "roll" }
  /** Host only (or the owner): close the table without recording a result. */
  | { t: "endTable" }
  /** Host only: the manual voice link (a Discord invite), or null to clear it. */
  | { t: "voiceLink"; url: string | null }
  | { t: "leave" }
  /** Engine tables: answer the prompt the engine is waiting on (see shared/engine.ts). */
  | { t: "engine"; answer: EngineAnswer; cid?: string }
  /** Engine tables: change this seat's auto-pass stops. */
  | { t: "stops"; stops: EngineStops }
  /** Engine tables: hold priority for this turn (every priority stops, nothing auto-passes); null releases. */
  | { t: "hold"; turn: number | null }
  /** Concede (any table); on engine tables the engine records it at the seat's next decision. */
  | { t: "concede" }
  | { t: "ping" };

// server -> client
export type ServerMessage =
  | { t: "room"; room: RoomInfo }
  | { t: "state"; view: PlayerView; printings: Record<string, CardPrinting> }
  | { t: "error"; message: string; cid?: string }
  /** Engine tables: cards revealed to this player / a value Forge announces (see EngineNotice). */
  | { t: "notice"; notice: EngineNotice; printings: Record<string, CardPrinting> }
  | { t: "pong" };

export interface CreateRoomRequest {
  /** Open a rules-engine table (only honoured when the server has an engine configured). */
  engine?: boolean;
}
export interface CreateRoomResponse {
  room: RoomInfo;
}
/** GET /api/features: what this deployment has switched on. */
export interface FeaturesResponse {
  engine: boolean;
}
export interface RoomResponse {
  room: RoomInfo;
}
export interface MyRoomsResponse {
  /** `engine`: a rules-engine table (Forge enforces the rules) rather than a casual table (nothing enforced). */
  rooms: Array<{ code: string; status: RoomStatus; players: number; updatedAt: string; hostName: string; engine: boolean; isHost: boolean; testGame: boolean }>;
}
