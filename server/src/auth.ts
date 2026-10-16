import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { User } from "@cgwf/shared";
import type { DbHandle } from "./db/index.js";
import { users, type UserRow } from "./db/schema.js";

/**
 * v1 identity: each device holds a random secret, sent as a Bearer token.
 * We store only its SHA-256 hash, so a database leak exposes no usable tokens.
 * Real sign-in can be layered on later (users.email / password_hash exist).
 */

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
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
  };
}

const LAST_SEEN_BUMP_MS = 60 * 60 * 1000;

export function userFromRequest(handle: DbHandle, req: FastifyRequest): UserRow | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (token.length < 20 || token.length > 128) return null;
  const row = handle.db.select().from(users).where(eq(users.deviceTokenHash, hashToken(token))).get();
  if (!row) return null;
  if (Date.now() - Date.parse(row.lastSeenAt) > LAST_SEEN_BUMP_MS) {
    handle.db.update(users).set({ lastSeenAt: new Date().toISOString() }).where(eq(users.id, row.id)).run();
  }
  return row;
}

/** Route preHandler: attach req.user or answer 401. */
export function requireUser(handle: DbHandle): preHandlerHookHandler {
  return (req: FastifyRequest, reply: FastifyReply, done) => {
    const user = userFromRequest(handle, req);
    if (!user) {
      void reply.code(401).send({ error: "sign in required" });
      return;
    }
    req.user = user;
    done();
  };
}

/** Rate-limit key: per user when signed in, else per IP. */
export function rateLimitKey(handle: DbHandle) {
  return (req: FastifyRequest): string => {
    const user = req.user ?? userFromRequest(handle, req);
    return user ? `u:${user.id}` : `ip:${req.ip}`;
  };
}
