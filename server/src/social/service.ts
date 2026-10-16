import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type {
  FriendInfo,
  FriendRequestInfo,
  FriendsResponse,
  NotificationInfo,
  NotificationKind,
  NotificationsResponse,
  PublicProfile,
  RoomInviteInfo,
  RoomStatus,
} from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { friendRequests, friendships, notifications, roomInvites, roomMembers, rooms, users, type UserRow } from "../db/schema.js";
import type { RoomManager } from "../rooms/live.js";
import { ensureFriendCode } from "./codes.js";
import type { Presence } from "./presence.js";

export class SocialError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SocialError";
  }
}

const MAX_FRIENDS = 200;
const MAX_NOTIFICATIONS = 50;

function now(): string {
  return new Date().toISOString();
}

export function toProfile(u: UserRow): PublicProfile {
  return { userId: u.id, name: u.displayName, avatar: u.avatar as PublicProfile["avatar"], color: u.color as PublicProfile["color"] };
}

/**
 * Friends, friend requests, table invites and the notification bell.
 * Everything here is plain rows; nothing is cached, nothing is pushed. The
 * client polls /api/notifications, which doubles as the presence heartbeat.
 */
export class SocialService {
  constructor(
    private readonly handle: DbHandle,
    private readonly roomsManager: RoomManager,
    private readonly presence: Presence,
  ) {}

  // ------------------------------------------------------------ helpers

  private userRows(ids: string[]): Map<string, UserRow> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    return new Map(this.handle.db.select().from(users).where(inArray(users.id, unique)).all().map((u) => [u.id, u]));
  }

  private user(id: string): UserRow {
    const row = this.handle.db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new SocialError("no such player", 404);
    return row;
  }

  areFriends(a: string, b: string): boolean {
    return Boolean(this.handle.db.select({ u: friendships.userId }).from(friendships).where(and(eq(friendships.userId, a), eq(friendships.friendId, b))).get());
  }

  friendIds(userId: string): string[] {
    return this.handle.db.select({ id: friendships.friendId }).from(friendships).where(eq(friendships.userId, userId)).all().map((r) => r.id);
  }

  notify(userId: string, kind: NotificationKind, payload: Record<string, unknown>): void {
    this.handle.db.insert(notifications).values({ id: randomUUID(), userId, kind, payload, readAt: null, createdAt: now() }).run();
  }

  // ------------------------------------------------------------ friends

  friendsOf(userId: string): FriendsResponse {
    const code = ensureFriendCode(this.handle, userId);
    const links = this.handle.db.select().from(friendships).where(eq(friendships.userId, userId)).all();
    const incomingRows = this.handle.db.select().from(friendRequests).where(and(eq(friendRequests.toUserId, userId), eq(friendRequests.status, "pending"))).orderBy(desc(friendRequests.createdAt)).all();
    const outgoingRows = this.handle.db.select().from(friendRequests).where(and(eq(friendRequests.fromUserId, userId), eq(friendRequests.status, "pending"))).orderBy(desc(friendRequests.createdAt)).all();
    const people = this.userRows([userId, ...links.map((l) => l.friendId), ...incomingRows.map((r) => r.fromUserId), ...outgoingRows.map((r) => r.toUserId)]);
    const tables = this.roomsManager.tablesOf(links.map((l) => l.friendId));
    const friends: FriendInfo[] = links
      .flatMap((l) => {
        const u = people.get(l.friendId);
        if (!u) return [];
        return [{ ...toProfile(u), since: l.createdAt, online: this.presence.isOnline(u.id), table: tables.get(u.id) ?? null }];
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const req = (r: typeof friendRequests.$inferSelect): FriendRequestInfo | null => {
      const from = people.get(r.fromUserId);
      const to = people.get(r.toUserId);
      return from && to ? { id: r.id, from: toProfile(from), to: toProfile(to), createdAt: r.createdAt } : null;
    };
    return {
      code,
      friends,
      incoming: incomingRows.map(req).filter((r): r is FriendRequestInfo => r !== null),
      outgoing: outgoingRows.map(req).filter((r): r is FriendRequestInfo => r !== null),
    };
  }

  /**
   * Send a request by friend code. If the other person already asked us, this
   * accepts theirs instead (no crossed requests). Returns what happened.
   */
  request(fromId: string, code: string): { outcome: "sent" | "accepted"; user: PublicProfile } {
    const from = this.user(fromId);
    if (from.isAgent) throw new SocialError("computer opponents have no friends");
    const target = this.handle.db.select().from(users).where(eq(users.friendCode, code)).get();
    if (!target || target.isAgent) throw new SocialError("no player has that code", 404);
    if (target.id === fromId) throw new SocialError("that is your own code");
    if (this.areFriends(fromId, target.id)) throw new SocialError(`you and ${target.displayName} are already friends`, 409);
    if (this.friendIds(fromId).length >= MAX_FRIENDS) throw new SocialError("friend list is full");
    const reverse = this.handle.db
      .select()
      .from(friendRequests)
      .where(and(eq(friendRequests.fromUserId, target.id), eq(friendRequests.toUserId, fromId), eq(friendRequests.status, "pending")))
      .get();
    if (reverse) {
      this.accept(fromId, reverse.id);
      return { outcome: "accepted", user: toProfile(target) };
    }
    const existing = this.handle.db
      .select()
      .from(friendRequests)
      .where(and(eq(friendRequests.fromUserId, fromId), eq(friendRequests.toUserId, target.id), eq(friendRequests.status, "pending")))
      .get();
    if (existing) throw new SocialError(`you already asked ${target.displayName}; waiting for them`, 409);
    const id = randomUUID();
    this.handle.sqlite.transaction(() => {
      this.handle.db.insert(friendRequests).values({ id, fromUserId: fromId, toUserId: target.id, status: "pending", createdAt: now(), respondedAt: null }).run();
      this.notify(target.id, "friend_request", { requestId: id, fromUserId: fromId, fromName: from.displayName });
    })();
    return { outcome: "sent", user: toProfile(target) };
  }

  accept(userId: string, requestId: string): PublicProfile {
    const r = this.handle.db.select().from(friendRequests).where(eq(friendRequests.id, requestId)).get();
    if (!r || r.toUserId !== userId) throw new SocialError("no such request", 404);
    if (r.status !== "pending") throw new SocialError("that request was already answered", 409);
    const me = this.user(userId);
    const other = this.user(r.fromUserId);
    const ts = now();
    this.handle.sqlite.transaction(() => {
      this.handle.db.update(friendRequests).set({ status: "accepted", respondedAt: ts }).where(eq(friendRequests.id, r.id)).run();
      if (!this.areFriends(userId, other.id)) {
        this.handle.db.insert(friendships).values({ userId, friendId: other.id, createdAt: ts }).run();
        this.handle.db.insert(friendships).values({ userId: other.id, friendId: userId, createdAt: ts }).run();
      }
      // Any crossed request the other way is settled too.
      this.handle.db
        .update(friendRequests)
        .set({ status: "accepted", respondedAt: ts })
        .where(and(eq(friendRequests.fromUserId, userId), eq(friendRequests.toUserId, other.id), eq(friendRequests.status, "pending")))
        .run();
      this.notify(other.id, "friend_accepted", { userId, name: me.displayName });
      this.markKind(userId, "friend_request", "requestId", r.id);
    })();
    return toProfile(other);
  }

  decline(userId: string, requestId: string): void {
    const r = this.handle.db.select().from(friendRequests).where(eq(friendRequests.id, requestId)).get();
    if (!r || r.toUserId !== userId) throw new SocialError("no such request", 404);
    if (r.status !== "pending") throw new SocialError("that request was already answered", 409);
    this.handle.sqlite.transaction(() => {
      this.handle.db.update(friendRequests).set({ status: "declined", respondedAt: now() }).where(eq(friendRequests.id, r.id)).run();
      this.markKind(userId, "friend_request", "requestId", r.id);
    })();
  }

  /** Withdraw a request I sent that has not been answered. */
  cancel(userId: string, requestId: string): void {
    const r = this.handle.db.select().from(friendRequests).where(eq(friendRequests.id, requestId)).get();
    if (!r || r.fromUserId !== userId || r.status !== "pending") throw new SocialError("no such request", 404);
    this.handle.db.delete(friendRequests).where(eq(friendRequests.id, r.id)).run();
  }

  remove(userId: string, friendId: string): void {
    if (!this.areFriends(userId, friendId)) throw new SocialError("not in your friends", 404);
    this.handle.sqlite.transaction(() => {
      this.handle.db.delete(friendships).where(or(and(eq(friendships.userId, userId), eq(friendships.friendId, friendId)), and(eq(friendships.userId, friendId), eq(friendships.friendId, userId)))).run();
    })();
  }

  // ------------------------------------------------------------ invites

  private inviteStatus(row: typeof roomInvites.$inferSelect, roomStatus: RoomStatus): RoomInviteInfo["status"] {
    if (row.status === "pending" && roomStatus === "ended") return "expired";
    return row.status as RoomInviteInfo["status"];
  }

  private inviteInfo(row: typeof roomInvites.$inferSelect, people: Map<string, UserRow>): RoomInviteInfo | null {
    const room = this.handle.db.select({ code: rooms.code, status: rooms.status }).from(rooms).where(eq(rooms.id, row.roomId)).get();
    const from = people.get(row.fromUserId);
    const to = people.get(row.toUserId);
    if (!room || !from || !to) return null;
    const roomStatus = room.status as RoomStatus;
    return { id: row.id, code: room.code, roomStatus, from: toProfile(from), to: toProfile(to), status: this.inviteStatus(row, roomStatus), createdAt: row.createdAt };
  }

  /** Invite friends to a table I am in. Only friends; one invite per person per room (re-sending is a no-op). */
  invite(fromId: string, roomCode: string, toIds: string[]): RoomInviteInfo[] {
    const room = this.roomsManager.get(roomCode);
    if (!room) throw new SocialError("no room with that code", 404);
    if (!room.member(fromId)) throw new SocialError("join the table before inviting people");
    if (room.refreshRow().status === "ended") throw new SocialError("that game has ended");
    const from = this.user(fromId);
    const wanted = [...new Set(toIds)].slice(0, 20);
    const made: string[] = [];
    this.handle.sqlite.transaction(() => {
      for (const toId of wanted) {
        if (toId === fromId || !this.areFriends(fromId, toId)) continue;
        if (room.member(toId)) continue;
        const existing = this.handle.db.select().from(roomInvites).where(and(eq(roomInvites.roomId, room.id), eq(roomInvites.toUserId, toId))).get();
        if (existing) {
          if (existing.status === "pending") {
            made.push(existing.id);
            continue;
          }
          // Declined earlier: a fresh invite replaces it.
          this.handle.db.delete(roomInvites).where(eq(roomInvites.id, existing.id)).run();
        }
        const id = randomUUID();
        this.handle.db.insert(roomInvites).values({ id, roomId: room.id, fromUserId: fromId, toUserId: toId, status: "pending", createdAt: now(), respondedAt: null }).run();
        this.notify(toId, "room_invite", { inviteId: id, code: room.code, fromUserId: fromId, fromName: from.displayName });
        made.push(id);
      }
    })();
    return this.invitesForRoom(room.id).filter((i) => made.includes(i.id));
  }

  invitesForRoom(roomId: string): RoomInviteInfo[] {
    const rows = this.handle.db.select().from(roomInvites).where(eq(roomInvites.roomId, roomId)).orderBy(desc(roomInvites.createdAt)).all();
    const people = this.userRows(rows.flatMap((r) => [r.fromUserId, r.toUserId]));
    return rows.map((r) => this.inviteInfo(r, people)).filter((i): i is RoomInviteInfo => i !== null);
  }

  /** Invites addressed to me that can still be used (room not ended, not yet answered). */
  pendingInvitesFor(userId: string): RoomInviteInfo[] {
    const rows = this.handle.db.select().from(roomInvites).where(and(eq(roomInvites.toUserId, userId), eq(roomInvites.status, "pending"))).orderBy(desc(roomInvites.createdAt)).limit(20).all();
    const people = this.userRows(rows.flatMap((r) => [r.fromUserId, r.toUserId]));
    return rows
      .map((r) => this.inviteInfo(r, people))
      .filter((i): i is RoomInviteInfo => i !== null && i.status === "pending");
  }

  /** Accept: join the room and, in the lobby, take the first free seat (deck picked later). Returns the code. */
  acceptInvite(userId: string, inviteId: string): { code: string; seated: boolean } {
    const r = this.handle.db.select().from(roomInvites).where(eq(roomInvites.id, inviteId)).get();
    if (!r || r.toUserId !== userId) throw new SocialError("no such invite", 404);
    const roomRow = this.handle.db.select({ code: rooms.code, status: rooms.status }).from(rooms).where(eq(rooms.id, r.roomId)).get();
    if (!roomRow) throw new SocialError("that table is gone", 404);
    if (roomRow.status === "ended") throw new SocialError("that game has already ended", 410);
    if (r.status === "declined") throw new SocialError("you declined this invite", 409);
    const room = this.roomsManager.get(roomRow.code);
    if (!room) throw new SocialError("that table is gone", 404);
    room.join(userId);
    let seated = false;
    if (room.status === "lobby") {
      const taken = new Set(room.members().filter((m) => m.role === "player").map((m) => m.seat));
      const m = room.member(userId);
      if (m?.role === "player") seated = true;
      else {
        for (let seat = 0; seat < 4 && !seated; seat++) {
          if (taken.has(seat)) continue;
          try {
            room.takeSeat(userId, seat, null);
            seated = true;
          } catch {
            /* seat raced away; try the next one */
          }
        }
      }
    }
    room.broadcastRoom();
    this.handle.sqlite.transaction(() => {
      this.handle.db.update(roomInvites).set({ status: "accepted", respondedAt: now() }).where(eq(roomInvites.id, r.id)).run();
      this.markKind(userId, "room_invite", "inviteId", r.id);
    })();
    return { code: roomRow.code, seated };
  }

  declineInvite(userId: string, inviteId: string): void {
    const r = this.handle.db.select().from(roomInvites).where(eq(roomInvites.id, inviteId)).get();
    if (!r || r.toUserId !== userId) throw new SocialError("no such invite", 404);
    this.handle.sqlite.transaction(() => {
      if (r.status === "pending") this.handle.db.update(roomInvites).set({ status: "declined", respondedAt: now() }).where(eq(roomInvites.id, r.id)).run();
      this.markKind(userId, "room_invite", "inviteId", r.id);
    })();
  }

  // ------------------------------------------------------------ notifications

  /** Mark read the notification(s) of one kind whose payload names this id (answered elsewhere). */
  private markKind(userId: string, kind: NotificationKind, key: string, value: string): void {
    const rows = this.handle.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, kind), isNull(notifications.readAt))).all();
    const ts = now();
    for (const n of rows) if (n.payload[key] === value) this.handle.db.update(notifications).set({ readAt: ts }).where(eq(notifications.id, n.id)).run();
  }

  /**
   * The bell. Invites to rooms that have ended are reported as read so a dead
   * invite never keeps the badge lit; the payload gains `live: false`.
   */
  notificationsFor(userId: string): NotificationsResponse {
    const rows = this.handle.db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(MAX_NOTIFICATIONS).all();
    const inviteIds = rows.filter((n) => n.kind === "room_invite").map((n) => String(n.payload.inviteId ?? ""));
    const liveInvites = new Set(
      inviteIds.length
        ? this.handle.db
            .select({ id: roomInvites.id, status: roomInvites.status, roomStatus: rooms.status })
            .from(roomInvites)
            .innerJoin(rooms, eq(rooms.id, roomInvites.roomId))
            .where(inArray(roomInvites.id, inviteIds))
            .all()
            .filter((r) => r.status === "pending" && r.roomStatus !== "ended")
            .map((r) => r.id)
        : [],
    );
    const requestIds = rows.filter((n) => n.kind === "friend_request").map((n) => String(n.payload.requestId ?? ""));
    const openRequests = new Set(
      requestIds.length
        ? this.handle.db
            .select({ id: friendRequests.id })
            .from(friendRequests)
            .where(and(inArray(friendRequests.id, requestIds), eq(friendRequests.status, "pending")))
            .all()
            .map((r) => r.id)
        : [],
    );
    const list: NotificationInfo[] = rows.map((n) => {
      let read = n.readAt !== null;
      const payload: Record<string, unknown> = { ...n.payload };
      if (n.kind === "room_invite") {
        payload.live = liveInvites.has(String(n.payload.inviteId ?? ""));
        if (!payload.live) read = true;
      }
      if (n.kind === "friend_request") {
        payload.live = openRequests.has(String(n.payload.requestId ?? ""));
        if (!payload.live) read = true;
      }
      return { id: n.id, kind: n.kind as NotificationKind, payload, read, createdAt: n.createdAt };
    });
    return { unread: list.filter((n) => !n.read).length, notifications: list };
  }

  markRead(userId: string, ids?: string[]): void {
    const ts = now();
    if (ids && ids.length) this.handle.db.update(notifications).set({ readAt: ts }).where(and(eq(notifications.userId, userId), inArray(notifications.id, ids.slice(0, 100)), isNull(notifications.readAt))).run();
    else this.handle.db.update(notifications).set({ readAt: ts }).where(and(eq(notifications.userId, userId), isNull(notifications.readAt))).run();
  }

  /** For the lobby: which of my friends are already members here (so they are not offered again). */
  memberIds(roomId: string): Set<string> {
    return new Set(this.handle.db.select({ id: roomMembers.userId }).from(roomMembers).where(eq(roomMembers.roomId, roomId)).all().map((r) => r.id));
  }
}
