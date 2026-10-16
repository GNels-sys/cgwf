import type { AvatarColorKey, AvatarKey } from "./user.js";
import type { SubmissionStatus } from "./social.js";

/**
 * Owner-only platform overview (GET /api/admin/stats). Everything is computed
 * on request from the existing tables (users, sessions, decks, library_decks,
 * library_submissions, rooms, room_events, agent_runs, friendships); nothing
 * here touches game state, so no hidden card information is involved.
 */

/** "Online right now" = heard from within this many milliseconds. */
export const ADMIN_ONLINE_MS = 5 * 60 * 1000;
/** Weekly charts cover this many weeks, the current one included. */
export const ADMIN_WEEKS = 12;
export const ADMIN_USERS_LIMIT_DEFAULT = 100;
export const ADMIN_USERS_LIMIT_MAX = 500;
export const ADMIN_FILTER_MAX = 64;

export interface AdminTotals {
  /** Players (agents excluded). */
  users: number;
  usersWithEmail: number;
  usersDeviceOnly: number;
  owners: number;
  /** By users.last_seen_at or the newest session, whichever is later. */
  activeToday: number;
  active7d: number;
  active30d: number;
  /** Connected to a table right now, or seen in the last ADMIN_ONLINE_MS. */
  onlineNow: number;
  decks: number;
  libraryDecks: number;
  submissions: Record<SubmissionStatus, number>;
  /** rooms.created_at within the window. */
  roomsCreated7d: number;
  roomsCreated30d: number;
  /** GameStarted events in room_events within the window. */
  gamesStarted7d: number;
  gamesStarted30d: number;
  /** Distinct rooms with an agent_runs row started in the last 30 days. */
  agentGames30d: number;
  /** Sum of agent_runs.cost_usd for runs started in the last 30 days. */
  agentSpendUsd30d: number;
}

export interface AdminWeekPoint {
  /** ISO date (UTC) of the Monday that starts the week. */
  weekStart: string;
  value: number;
}

export type AdminUserSort = "lastSeen" | "created" | "decks" | "games";
export const ADMIN_USER_SORTS: readonly AdminUserSort[] = ["lastSeen", "created", "decks", "games"];

export interface AdminUserRow {
  id: string;
  displayName: string;
  avatar: AvatarKey;
  color: AvatarColorKey;
  /** Lower-cased account email, or null for a device-only profile. */
  email: string | null;
  isOwner: boolean;
  createdAt: string;
  lastSeenAt: string;
  online: boolean;
  /** Signed-in devices (rows in sessions). */
  devices: number;
  decks: number;
  submissions: Record<SubmissionStatus, number>;
  /** Rooms where the user held a player seat and the game started. */
  gamesPlayed: number;
  /** Started rooms the user hosts (rooms.host_user_id). */
  gamesHosted: number;
  friends: number;
}

export interface AdminUserDeck {
  id: string;
  name: string;
  createdAt: string;
  /** The library's bracket when this deck was approved into it, else null. */
  bracket: number | null;
}

export interface AdminUserSubmission {
  id: string;
  deckName: string;
  status: SubmissionStatus;
  reason: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

/** GET /api/admin/users/:id -> that user's decks and submission history. */
export interface AdminUserDetail {
  decks: AdminUserDeck[];
  submissions: AdminUserSubmission[];
}

export interface AdminStatsQuery {
  sort?: AdminUserSort;
  /** Case-insensitive substring of the display name or email. */
  q?: string;
  limit?: number;
}

export interface AdminStatsResponse {
  generatedAt: string;
  /** True when the totals and charts came from the short in-memory cache. */
  cached: boolean;
  totals: AdminTotals;
  signupsPerWeek: AdminWeekPoint[];
  activePerWeek: AdminWeekPoint[];
  users: AdminUserRow[];
  /** Players matching the filter, before the limit. */
  usersTotal: number;
}

export function isAdminUserSort(v: unknown): v is AdminUserSort {
  return typeof v === "string" && (ADMIN_USER_SORTS as readonly string[]).includes(v);
}
