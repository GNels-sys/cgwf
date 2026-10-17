import type { CardPrinting } from "../cards.js";
import type { AvatarColorKey, AvatarKey } from "../user.js";
import type { Look } from "../settings.js";
import type { EventInput, PlayerId } from "./types.js";
import type { PlayerView } from "./view.js";
import type { EngineAnswer, EngineStops } from "../engine.js";

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
  | { t: "leave" }
  /** Engine tables: answer the prompt the engine is waiting on (see shared/engine.ts). */
  | { t: "engine"; answer: EngineAnswer; cid?: string }
  /** Engine tables: change this seat's auto-pass stops. */
  | { t: "stops"; stops: EngineStops }
  /** Concede (any table); on engine tables the engine records it at the seat's next decision. */
  | { t: "concede" }
  | { t: "ping" };

// server -> client
export type ServerMessage =
  | { t: "room"; room: RoomInfo }
  | { t: "state"; view: PlayerView; printings: Record<string, CardPrinting> }
  | { t: "error"; message: string; cid?: string }
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
  rooms: Array<{ code: string; status: RoomStatus; players: number; updatedAt: string; hostName: string }>;
}
