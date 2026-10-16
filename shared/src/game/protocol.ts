import type { CardPrinting } from "../cards.js";
import type { AvatarColorKey, AvatarKey } from "../user.js";
import type { Look } from "../settings.js";
import type { EventInput, PlayerId } from "./types.js";
import type { PlayerView } from "./view.js";

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
  | { t: "ping" };

// server -> client
export type ServerMessage =
  | { t: "room"; room: RoomInfo }
  | { t: "state"; view: PlayerView; printings: Record<string, CardPrinting> }
  | { t: "error"; message: string; cid?: string }
  | { t: "pong" };

export interface CreateRoomResponse {
  room: RoomInfo;
}
export interface RoomResponse {
  room: RoomInfo;
}
export interface MyRoomsResponse {
  rooms: Array<{ code: string; status: RoomStatus; players: number; updatedAt: string; hostName: string }>;
}
