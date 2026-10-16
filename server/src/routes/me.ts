import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  DISPLAY_NAME_MAX,
  isAvatarColorKey,
  isAvatarKey,
  type RegisterRequest,
  type RegisterResponse,
  type User,
} from "@cgwf/shared";
import { hashToken, newDeviceToken, requireUser, toPublicUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { users } from "../db/schema.js";

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > DISPLAY_NAME_MAX) return null;
  return name;
}

export function registerMeRoutes(app: FastifyInstance, handle: DbHandle): void {
  /** Create a device identity. The token is returned exactly once. */
  app.post<{ Body: Partial<RegisterRequest> }>(
    "/api/me/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (req, reply): Promise<RegisterResponse | void> => {
      const displayName = cleanName(req.body?.displayName);
      const { avatar, color } = req.body ?? {};
      if (!displayName) return reply.code(400).send({ error: `name must be 1-${DISPLAY_NAME_MAX} characters` });
      if (!isAvatarKey(avatar) || !isAvatarColorKey(color)) return reply.code(400).send({ error: "pick an avatar and a colour" });
      const token = newDeviceToken();
      const now = new Date().toISOString();
      const row = {
        id: randomUUID(),
        displayName,
        avatar,
        color,
        deviceTokenHash: hashToken(token),
        createdAt: now,
        lastSeenAt: now,
      };
      handle.db.insert(users).values(row).run();
      const user = handle.db.select().from(users).where(eq(users.id, row.id)).get()!;
      return { token, user: toPublicUser(user) };
    },
  );

  app.get("/api/me", { preHandler: requireUser(handle) }, async (req): Promise<{ user: User }> => ({
    user: toPublicUser(req.user!),
  }));

  app.patch<{ Body: Partial<RegisterRequest> }>(
    "/api/me",
    { preHandler: requireUser(handle) },
    async (req, reply): Promise<{ user: User } | void> => {
      const patch: Partial<{ displayName: string; avatar: string; color: string }> = {};
      if (req.body?.displayName !== undefined) {
        const name = cleanName(req.body.displayName);
        if (!name) return reply.code(400).send({ error: `name must be 1-${DISPLAY_NAME_MAX} characters` });
        patch.displayName = name;
      }
      if (req.body?.avatar !== undefined) {
        if (!isAvatarKey(req.body.avatar)) return reply.code(400).send({ error: "unknown avatar" });
        patch.avatar = req.body.avatar;
      }
      if (req.body?.color !== undefined) {
        if (!isAvatarColorKey(req.body.color)) return reply.code(400).send({ error: "unknown colour" });
        patch.color = req.body.color;
      }
      if (Object.keys(patch).length) handle.db.update(users).set(patch).where(eq(users.id, req.user!.id)).run();
      const row = handle.db.select().from(users).where(eq(users.id, req.user!.id)).get()!;
      return { user: toPublicUser(row) };
    },
  );
}
