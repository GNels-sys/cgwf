import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { User } from "@cgwf/shared";
import type { DbHandle } from "./db/index.js";
import { sessions, users, type SessionRow, type UserRow } from "./db/schema.js";

/**
 * Identity: every signed-in device holds a random secret, sent as a Bearer
 * token (or ?token= on the WebSocket). We store only its SHA-256 hash in
 * `sessions`, so a database leak exposes no usable tokens. A user may have any
 * number of sessions (one per device); deleting a session signs that device
 * out. Accounts (email + password) only add a way to open a new session.
 */

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
    session?: SessionRow;
  }
}

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function toPublicUser(row: UserRow): User {
  return {
    id: row.id,
    displayName: row.displayName,
    avatar: row.avatar as User["avatar"],
    color: row.color as User["color"],
    createdAt: row.createdAt,
    email: row.email ?? null,
    isOwner: Boolean(row.isOwner),
  };
}

/** A short, human label for the device list, from the User-Agent header. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  let platform = "Unknown device";
  if (/iPhone/i.test(ua)) platform = "iPhone";
  else if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua))) platform = "iPad";
  else if (/Android/i.test(ua)) platform = "Android";
  else if (/Windows/i.test(ua)) platform = "Windows";
  else if (/Macintosh|Mac OS/i.test(ua)) platform = "Mac";
  else if (/CrOS/i.test(ua)) platform = "Chromebook";
  else if (/Linux/i.test(ua)) platform = "Linux";
  let browser = "";
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/SamsungBrowser/i.test(ua)) browser = "Samsung Internet";
  else if (/Firefox|FxiOS/i.test(ua)) browser = "Firefox";
  else if (/CriOS|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Safari/i.test(ua)) browser = "Safari";
  return (browser ? `${platform} / ${browser}` : platform).slice(0, 64);
}

/** Create a session for a user and return the one-time token. */
export function createSession(handle: DbHandle, userId: string, userAgent: string | undefined): { token: string; session: SessionRow } {
  const token = newDeviceToken();
  const now = new Date().toISOString();
  const row: SessionRow = { id: randomUUID(), userId, tokenHash: hashToken(token), device: deviceLabel(userAgent), createdAt: now, lastSeenAt: now };
  handle.db.insert(sessions).values(row).run();
  return { token, session: row };
}

const LAST_SEEN_BUMP_MS = 60 * 60 * 1000;

/** Resolve a raw token to its session + user, bumping last_seen at most hourly. */
export function sessionFromToken(handle: DbHandle, token: string): { user: UserRow; session: SessionRow } | null {
  if (token.length < 20 || token.length > 128) return null;
  const hit = handle.db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .get();
  if (!hit) return null;
  if (Date.now() - Date.parse(hit.session.lastSeenAt) > LAST_SEEN_BUMP_MS) {
    const now = new Date().toISOString();
    handle.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, hit.session.id)).run();
    handle.db.update(users).set({ lastSeenAt: now }).where(eq(users.id, hit.user.id)).run();
  }
  return hit;
}

export function userFromToken(handle: DbHandle, token: string): UserRow | null {
  return sessionFromToken(handle, token)?.user ?? null;
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

export function userFromRequest(handle: DbHandle, req: FastifyRequest): UserRow | null {
  if (req.user) return req.user;
  const token = bearer(req);
  if (!token) return null;
  const hit = sessionFromToken(handle, token);
  if (!hit) return null;
  req.user = hit.user;
  req.session = hit.session;
  return hit.user;
}

/** Route preHandler: attach req.user (and req.session) or answer 401. */
export function requireUser(handle: DbHandle): preHandlerHookHandler {
  return (req: FastifyRequest, reply: FastifyReply, done) => {
    const user = userFromRequest(handle, req);
    if (!user) {
      void reply.code(401).send({ error: "sign in required" });
      return;
    }
    done();
  };
}

/** Route preHandler for owner-only features (later phases): 401 when signed out, 403 otherwise. */
export function requireOwner(handle: DbHandle): preHandlerHookHandler {
  return (req: FastifyRequest, reply: FastifyReply, done) => {
    const user = userFromRequest(handle, req);
    if (!user) {
      void reply.code(401).send({ error: "sign in required" });
      return;
    }
    if (!user.isOwner) {
      void reply.code(403).send({ error: "owner only" });
      return;
    }
    done();
  };
}

/** Rate-limit key: per user when signed in, else per IP. */
export function rateLimitKey(handle: DbHandle) {
  return (req: FastifyRequest): string => {
    const user = userFromRequest(handle, req);
    return user ? `u:${user.id}` : `ip:${req.ip}`;
  };
}
