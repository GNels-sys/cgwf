import type { FastifyInstance } from "fastify";
import {
  ADMIN_FILTER_MAX,
  ADMIN_ONLINE_MS,
  ADMIN_USERS_LIMIT_DEFAULT,
  ADMIN_USERS_LIMIT_MAX,
  ADMIN_WEEKS,
  isAdminUserSort,
  type AdminStatsResponse,
  type AdminTotals,
  type AdminUserDetail,
  type AdminUserRow,
  type AdminUserSort,
  type AdminWeekPoint,
  type SubmissionStatus,
} from "@cgwf/shared";
import { requireOwner, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import type { RoomManager } from "../rooms/live.js";
import type { Presence } from "../social/presence.js";

interface Deps {
  handle: DbHandle;
  roomsManager: RoomManager;
  presence: Presence;
}

/** The totals, charts and per-user aggregates are recomputed at most this often. */
export const ADMIN_CACHE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

type UserAgg = Omit<AdminUserRow, "online"> & { lastActiveMs: number };

interface Snapshot {
  at: number;
  totals: Omit<AdminTotals, "onlineNow">;
  signupsPerWeek: AdminWeekPoint[];
  activePerWeek: AdminWeekPoint[];
  /** Every player (agents excluded), unsorted, without the live `online` flag. */
  users: UserAgg[];
}

function emptyStatuses(): Record<SubmissionStatus, number> {
  return { pending: 0, approved: 0, rejected: 0 };
}

function isStatus(s: string): s is SubmissionStatus {
  return s === "pending" || s === "approved" || s === "rejected";
}

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStartUtc(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

function parseMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Everything the overview needs, from plain SQL over the existing tables.
 * Agents (users.is_agent) are left out of every people count; their games and
 * spend still show up under the agent tiles.
 */
export function computeSnapshot(handle: DbHandle, now = Date.now()): Snapshot {
  const q = handle.sqlite;
  const iso = (ms: number) => new Date(ms).toISOString();
  const since7 = iso(now - 7 * DAY_MS);
  const since30 = iso(now - 30 * DAY_MS);

  // ---- per-user aggregates (one query per table, joined in memory by id)
  const people = q
    .prepare("SELECT id, display_name, avatar, color, email, is_owner, created_at, last_seen_at FROM users WHERE is_agent = 0")
    .all() as Array<{ id: string; display_name: string; avatar: string; color: string; email: string | null; is_owner: number; created_at: string; last_seen_at: string }>;
  const count = (sql: string): Map<string, number> => new Map((q.prepare(sql).all() as Array<{ id: string; n: number }>).map((r) => [r.id, r.n]));
  const devices = count("SELECT user_id AS id, count(*) AS n FROM sessions GROUP BY user_id");
  const newestSession = new Map((q.prepare("SELECT user_id AS id, max(last_seen_at) AS t FROM sessions GROUP BY user_id").all() as Array<{ id: string; t: string }>).map((r) => [r.id, r.t]));
  const deckCounts = count("SELECT user_id AS id, count(*) AS n FROM decks GROUP BY user_id");
  const friendCounts = count("SELECT user_id AS id, count(*) AS n FROM friendships GROUP BY user_id");
  const played = count(
    "SELECT m.user_id AS id, count(DISTINCT m.room_id) AS n FROM room_members m WHERE m.role = 'player' AND EXISTS (SELECT 1 FROM room_events e WHERE e.room_id = m.room_id AND e.type = 'GameStarted') GROUP BY m.user_id",
  );
  const hosted = count("SELECT r.host_user_id AS id, count(*) AS n FROM rooms r WHERE EXISTS (SELECT 1 FROM room_events e WHERE e.room_id = r.id AND e.type = 'GameStarted') GROUP BY r.host_user_id");
  const subs = new Map<string, Record<SubmissionStatus, number>>();
  for (const r of q.prepare("SELECT user_id, status, count(*) AS n FROM library_submissions GROUP BY user_id, status").all() as Array<{ user_id: string; status: string; n: number }>) {
    if (!isStatus(r.status)) continue;
    const rec = subs.get(r.user_id) ?? emptyStatuses();
    rec[r.status] = r.n;
    subs.set(r.user_id, rec);
  }

  const users: UserAgg[] = people.map((p) => {
    const lastActiveMs = Math.max(parseMs(p.last_seen_at), parseMs(newestSession.get(p.id)));
    return {
      id: p.id,
      displayName: p.display_name,
      avatar: p.avatar as AdminUserRow["avatar"],
      color: p.color as AdminUserRow["color"],
      email: p.email ?? null,
      isOwner: Boolean(p.is_owner),
      createdAt: p.created_at,
      lastSeenAt: lastActiveMs ? iso(lastActiveMs) : p.last_seen_at,
      lastActiveMs,
      devices: devices.get(p.id) ?? 0,
      decks: deckCounts.get(p.id) ?? 0,
      submissions: subs.get(p.id) ?? emptyStatuses(),
      gamesPlayed: played.get(p.id) ?? 0,
      gamesHosted: hosted.get(p.id) ?? 0,
      friends: friendCounts.get(p.id) ?? 0,
    };
  });

  // ---- totals
  const one = (sql: string, ...params: unknown[]): number => Number((q.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0);
  const activeSince = (ms: number) => users.filter((u) => u.lastActiveMs >= ms).length;
  const submissions = emptyStatuses();
  for (const r of q.prepare("SELECT status, count(*) AS n FROM library_submissions GROUP BY status").all() as Array<{ status: string; n: number }>) if (isStatus(r.status)) submissions[r.status] = r.n;
  const totals: Snapshot["totals"] = {
    users: users.length,
    usersWithEmail: users.filter((u) => u.email).length,
    usersDeviceOnly: users.filter((u) => !u.email).length,
    owners: users.filter((u) => u.isOwner).length,
    activeToday: activeSince(now - DAY_MS),
    active7d: activeSince(now - 7 * DAY_MS),
    active30d: activeSince(now - 30 * DAY_MS),
    decks: one("SELECT count(*) AS n FROM decks"),
    libraryDecks: one("SELECT count(*) AS n FROM library_decks"),
    submissions,
    roomsCreated7d: one("SELECT count(*) AS n FROM rooms WHERE created_at >= ?", since7),
    roomsCreated30d: one("SELECT count(*) AS n FROM rooms WHERE created_at >= ?", since30),
    gamesStarted7d: one("SELECT count(*) AS n FROM room_events WHERE type = 'GameStarted' AND ts >= ?", now - 7 * DAY_MS),
    gamesStarted30d: one("SELECT count(*) AS n FROM room_events WHERE type = 'GameStarted' AND ts >= ?", now - 30 * DAY_MS),
    agentGames30d: one("SELECT count(DISTINCT room_id) AS n FROM agent_runs WHERE started_at >= ?", since30),
    agentSpendUsd30d: Math.round(one("SELECT coalesce(sum(cost_usd), 0) AS n FROM agent_runs WHERE started_at >= ?", since30) * 1e4) / 1e4,
  };

  // ---- weekly charts: ADMIN_WEEKS Monday-based UTC weeks ending with the current one
  const thisWeek = weekStartUtc(now);
  const firstWeek = thisWeek - (ADMIN_WEEKS - 1) * WEEK_MS;
  const weekIndex = (ms: number): number => (ms < firstWeek ? -1 : Math.min(ADMIN_WEEKS - 1, Math.floor((ms - firstWeek) / WEEK_MS)));
  const signups = new Array<number>(ADMIN_WEEKS).fill(0);
  for (const u of users) {
    const i = weekIndex(parseMs(u.createdAt));
    if (i >= 0) signups[i]!++;
  }
  // Active in a week = any stored timestamp of theirs falls in it. A lower bound:
  // last_seen keeps only the latest visit, so quieter weeks can be under-counted.
  const activeSets = Array.from({ length: ADMIN_WEEKS }, () => new Set<string>());
  const playerIds = new Set(users.map((u) => u.id));
  const mark = (userId: string, ms: number) => {
    const i = weekIndex(ms);
    if (i >= 0 && playerIds.has(userId)) activeSets[i]!.add(userId);
  };
  for (const u of users) {
    mark(u.id, parseMs(u.createdAt));
    mark(u.id, u.lastActiveMs);
  }
  const sinceIso = iso(firstWeek);
  for (const r of q.prepare("SELECT user_id, created_at, last_seen_at FROM sessions WHERE last_seen_at >= ?").all(sinceIso) as Array<{ user_id: string; created_at: string; last_seen_at: string }>) {
    mark(r.user_id, parseMs(r.created_at));
    mark(r.user_id, parseMs(r.last_seen_at));
  }
  for (const r of q.prepare("SELECT user_id, created_at, updated_at FROM decks WHERE updated_at >= ?").all(sinceIso) as Array<{ user_id: string; created_at: string; updated_at: string }>) {
    mark(r.user_id, parseMs(r.created_at));
    mark(r.user_id, parseMs(r.updated_at));
  }
  for (const r of q.prepare("SELECT host_user_id AS user_id, created_at FROM rooms WHERE created_at >= ?").all(sinceIso) as Array<{ user_id: string; created_at: string }>) mark(r.user_id, parseMs(r.created_at));
  for (const r of q.prepare("SELECT user_id, created_at FROM library_submissions WHERE created_at >= ?").all(sinceIso) as Array<{ user_id: string; created_at: string }>) mark(r.user_id, parseMs(r.created_at));
  for (const r of q.prepare("SELECT DISTINCT actor, ts FROM room_events WHERE ts >= ? AND actor != 'system'").all(firstWeek) as Array<{ actor: string; ts: number }>) mark(r.actor, r.ts);
  const weeks = (values: number[]): AdminWeekPoint[] => values.map((value, i) => ({ weekStart: iso(firstWeek + i * WEEK_MS).slice(0, 10), value }));

  return {
    at: now,
    totals,
    signupsPerWeek: weeks(signups),
    activePerWeek: weeks(activeSets.map((s) => s.size)),
    users,
  };
}

export function userDetail(handle: DbHandle, userId: string): AdminUserDetail {
  const q = handle.sqlite;
  const decks = q
    .prepare("SELECT d.id, d.name, d.created_at, l.bracket FROM decks d LEFT JOIN library_decks l ON l.source_key = 'deck:' || d.id WHERE d.user_id = ? ORDER BY d.created_at DESC")
    .all(userId) as Array<{ id: string; name: string; created_at: string; bracket: number | null }>;
  const submissions = q
    .prepare("SELECT id, deck_name, status, reason, created_at, reviewed_at FROM library_submissions WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as Array<{ id: string; deck_name: string; status: string; reason: string | null; created_at: string; reviewed_at: string | null }>;
  return {
    decks: decks.map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, bracket: d.bracket ?? null })),
    submissions: submissions.flatMap((s) => (isStatus(s.status) ? [{ id: s.id, deckName: s.deck_name, status: s.status, reason: s.reason, createdAt: s.created_at, reviewedAt: s.reviewed_at }] : [])),
  };
}

const SORTS: Record<AdminUserSort, (a: UserAgg, b: UserAgg) => number> = {
  lastSeen: (a, b) => b.lastActiveMs - a.lastActiveMs,
  created: (a, b) => b.createdAt.localeCompare(a.createdAt),
  decks: (a, b) => b.decks - a.decks,
  games: (a, b) => b.gamesPlayed - a.gamesPlayed,
};

/**
 * Owner only:
 *   GET /api/admin/stats?sort=lastSeen|created|decks|games&q=&limit=&refresh=1
 *   GET /api/admin/users/:id   decks + submission history for one row
 */
export function registerAdminRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, roomsManager, presence } = deps;
  const owner = [requireUser(handle), requireOwner(handle)];
  let cache: Snapshot | null = null;

  app.get<{ Querystring: { sort?: string; q?: string; limit?: string; refresh?: string } }>("/api/admin/stats", { preHandler: owner }, async (req): Promise<AdminStatsResponse> => {
    const now = Date.now();
    const cached = Boolean(cache && req.query.refresh !== "1" && now - cache.at < ADMIN_CACHE_MS);
    if (!cached) cache = computeSnapshot(handle, now);
    const snap = cache!;

    const sort: AdminUserSort = isAdminUserSort(req.query.sort) ? req.query.sort : "lastSeen";
    const needle = (req.query.q ?? "").trim().toLowerCase().slice(0, ADMIN_FILTER_MAX);
    const limitRaw = Number(req.query.limit ?? ADMIN_USERS_LIMIT_DEFAULT);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(ADMIN_USERS_LIMIT_MAX, Math.floor(limitRaw)) : ADMIN_USERS_LIMIT_DEFAULT;

    const tables = roomsManager.tablesOf(snap.users.map((u) => u.id));
    const online = (u: UserAgg) => tables.has(u.id) || presence.seenWithin(u.id, ADMIN_ONLINE_MS, now) || now - u.lastActiveMs < ADMIN_ONLINE_MS;
    const matching = snap.users.filter((u) => !needle || u.displayName.toLowerCase().includes(needle) || (u.email ?? "").includes(needle));
    const sorted = [...matching].sort((a, b) => SORTS[sort](a, b) || SORTS.lastSeen(a, b) || a.displayName.localeCompare(b.displayName));
    const users: AdminUserRow[] = sorted.slice(0, limit).map((u) => {
      const { lastActiveMs: _ignored, ...row } = u;
      return { ...row, online: online(u) };
    });

    return {
      generatedAt: new Date(snap.at).toISOString(),
      cached,
      totals: { ...snap.totals, onlineNow: snap.users.filter(online).length },
      signupsPerWeek: snap.signupsPerWeek,
      activePerWeek: snap.activePerWeek,
      users,
      usersTotal: matching.length,
    };
  });

  app.get<{ Params: { id: string } }>("/api/admin/users/:id", { preHandler: owner }, async (req, reply): Promise<AdminUserDetail | void> => {
    const row = handle.sqlite.prepare("SELECT is_agent FROM users WHERE id = ?").get(req.params.id) as { is_agent: number } | undefined;
    if (!row || row.is_agent) return reply.code(404).send({ error: "no such player" });
    return userDetail(handle, req.params.id);
  });
}
