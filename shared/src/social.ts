import type { AvatarColorKey, AvatarKey } from "./user.js";
import type { RoomStatus } from "./game/protocol.js";
import type { ArchetypeTag, Bracket } from "./analysis.js";

/**
 * Phase 8: friends, table invites, notifications and the agent deck queue.
 * Friend codes are six characters from the join-code alphabet (no 0/O/1/I/L).
 */
export const FRIEND_CODE_LENGTH = 6;
export const FRIEND_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const SUBMISSION_NOTE_MAX = 500;
/** A player counts as online when the server heard from them this recently. */
export const PRESENCE_ONLINE_MS = 2 * 60 * 1000;

/** Uppercase and strip spaces/dashes so a code pasted from a chat still works. */
export function normalizeFriendCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, FRIEND_CODE_LENGTH);
}

export function isFriendCode(v: string): boolean {
  return v.length === FRIEND_CODE_LENGTH && [...v].every((ch) => FRIEND_CODE_ALPHABET.includes(ch));
}

/** Another player as the social pages show them (never their email). */
export interface PublicProfile {
  userId: string;
  name: string;
  avatar: AvatarKey;
  color: AvatarColorKey;
}

export interface FriendInfo extends PublicProfile {
  since: string;
  online: boolean;
  /** Set when the friend is connected to a table right now. */
  table: { code: string; status: RoomStatus } | null;
}

export interface FriendRequestInfo {
  id: string;
  from: PublicProfile;
  to: PublicProfile;
  createdAt: string;
}

export interface FriendsResponse {
  /** The caller's own friend code. */
  code: string;
  friends: FriendInfo[];
  incoming: FriendRequestInfo[];
  outgoing: FriendRequestInfo[];
}

export interface RoomInviteInfo {
  id: string;
  code: string;
  roomStatus: RoomStatus;
  from: PublicProfile;
  to: PublicProfile;
  /** "pending" | "accepted" | "declined" | "expired" (expired = the room has ended). */
  status: "pending" | "accepted" | "declined" | "expired";
  createdAt: string;
}

export type NotificationKind = "friend_request" | "friend_accepted" | "room_invite" | "submission_reviewed";

export interface NotificationInfo {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export interface NotificationsResponse {
  unread: number;
  notifications: NotificationInfo[];
}

export type SubmissionStatus = "pending" | "approved" | "rejected";

export interface SubmissionInfo {
  id: string;
  deckId: string;
  deckName: string;
  commanders: string[];
  cardCount: number;
  note: string;
  status: SubmissionStatus;
  reason: string | null;
  libraryDeckId: string | null;
  submitter: PublicProfile;
  createdAt: string;
  reviewedAt: string | null;
  /** Owner view: what the engine thinks, so the review needs no extra click. */
  bracketSuggested?: Bracket | null;
  tags?: ArchetypeTag[];
}
