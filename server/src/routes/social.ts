import type { FastifyInstance, FastifyReply } from "fastify";
import { isFriendCode, normalizeFriendCode, type FriendsResponse, type NotificationsResponse, type RoomInviteInfo, type SubmissionInfo } from "@cgwf/shared";
import { rateLimitKey, requireOwner, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { isRoomCode, normalizeRoomCode } from "../rooms/codes.js";
import type { RoomManager } from "../rooms/live.js";
import { ensureFriendCode } from "../social/codes.js";
import { SocialError, type SocialService } from "../social/service.js";
import type { SubmissionService } from "../social/submissions.js";

interface Deps {
  handle: DbHandle;
  social: SocialService;
  submissions: SubmissionService;
  roomsManager: RoomManager;
}

/**
 * Phase 8 routes.
 *   GET    /api/friends                         my code, friends (online / at a table), requests
 *   POST   /api/friends/requests {code}         send (or auto-accept a crossed request)
 *   POST   /api/friends/requests/:id/accept | /decline | /cancel
 *   DELETE /api/friends/:userId
 *   GET    /api/notifications                   bell (also the presence heartbeat)
 *   POST   /api/notifications/read {ids?}
 *   POST   /api/rooms/:code/invites {userIds}   invite friends to my table
 *   GET    /api/rooms/:code/invites
 *   GET    /api/invites                         my pending invites
 *   POST   /api/invites/:id/accept | /decline
 *   POST   /api/decks/:id/submit {note?}        agent deck queue
 *   GET    /api/decks/:id/submission
 *   GET    /api/submissions/mine
 *   DELETE /api/submissions/:id                 withdraw while pending
 *   GET    /api/library/submissions             owner: the queue
 *   POST   /api/library/submissions/:id/approve | /reject {reason}
 */
export function registerSocialRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, social, submissions } = deps;
  const auth = requireUser(handle);
  const owner = [requireUser(handle), requireOwner(handle)];
  const keyGenerator = rateLimitKey(handle);
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SocialError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  // ------------------------------------------------------------ friends

  app.get("/api/friends", { preHandler: auth }, async (req): Promise<FriendsResponse> => social.friendsOf(req.user!.id));

  app.get("/api/me/friend-code", { preHandler: auth }, async (req): Promise<{ code: string }> => ({ code: ensureFriendCode(handle, req.user!.id) }));

  app.post<{ Body: { code?: unknown } }>(
    "/api/friends/requests",
    { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 hour", keyGenerator } } },
    async (req, reply) => {
      const code = normalizeFriendCode(req.body?.code);
      if (!isFriendCode(code)) return reply.code(400).send({ error: "a friend code has 6 letters or numbers" });
      try {
        return reply.code(201).send(social.request(req.user!.id, code));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/friends/requests/:id/accept", { preHandler: auth }, async (req, reply) => {
    try {
      return { friend: social.accept(req.user!.id, req.params.id) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/friends/requests/:id/decline", { preHandler: auth }, async (req, reply) => {
    try {
      social.decline(req.user!.id, req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/friends/requests/:id/cancel", { preHandler: auth }, async (req, reply) => {
    try {
      social.cancel(req.user!.id, req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { userId: string } }>("/api/friends/:userId", { preHandler: auth }, async (req, reply) => {
    try {
      social.remove(req.user!.id, req.params.userId);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ------------------------------------------------------------ notifications

  app.get("/api/notifications", { preHandler: auth }, async (req): Promise<NotificationsResponse> => social.notificationsFor(req.user!.id));

  app.post<{ Body: { ids?: unknown } | null }>("/api/notifications/read", { preHandler: auth }, async (req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((v): v is string => typeof v === "string") : undefined;
    social.markRead(req.user!.id, ids);
    return { ok: true };
  });

  // ------------------------------------------------------------ invites

  app.post<{ Params: { code: string }; Body: { userIds?: unknown } | null }>(
    "/api/rooms/:code/invites",
    { preHandler: auth, config: { rateLimit: { max: 60, timeWindow: "1 hour", keyGenerator } } },
    async (req, reply): Promise<{ invites: RoomInviteInfo[] } | void> => {
      const code = normalizeRoomCode(req.params.code);
      if (!isRoomCode(code)) return reply.code(404).send({ error: "no room with that code" });
      const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.filter((v): v is string => typeof v === "string") : [];
      if (userIds.length === 0) return reply.code(400).send({ error: "pick at least one friend" });
      try {
        return reply.code(201).send({ invites: social.invite(req.user!.id, code, userIds) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { code: string } }>("/api/rooms/:code/invites", { preHandler: auth }, async (req, reply): Promise<{ invites: RoomInviteInfo[] } | void> => {
    const code = normalizeRoomCode(req.params.code);
    const room = isRoomCode(code) ? deps.roomsManager.get(code) : null;
    if (!room) return reply.code(404).send({ error: "no room with that code" });
    if (!room.member(req.user!.id)) return reply.code(403).send({ error: "join the table first" });
    return { invites: social.invitesForRoom(room.id) };
  });

  app.get("/api/invites", { preHandler: auth }, async (req): Promise<{ invites: RoomInviteInfo[] }> => ({ invites: social.pendingInvitesFor(req.user!.id) }));

  app.post<{ Params: { id: string } }>("/api/invites/:id/accept", { preHandler: auth }, async (req, reply) => {
    try {
      return social.acceptInvite(req.user!.id, req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/invites/:id/decline", { preHandler: auth }, async (req, reply) => {
    try {
      social.declineInvite(req.user!.id, req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ------------------------------------------------------------ agent deck queue

  app.post<{ Params: { id: string }; Body: { note?: unknown } | null }>(
    "/api/decks/:id/submit",
    { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 hour", keyGenerator } } },
    async (req, reply): Promise<{ submission: SubmissionInfo } | void> => {
      try {
        return reply.code(201).send({ submission: submissions.submit(req.user!.id, req.params.id, req.body?.note) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/decks/:id/submission", { preHandler: auth }, async (req): Promise<{ submission: SubmissionInfo | null }> => ({
    submission: submissions.latestForDeck(req.user!.id, req.params.id),
  }));

  app.get("/api/submissions/mine", { preHandler: auth }, async (req): Promise<{ submissions: SubmissionInfo[] }> => ({ submissions: submissions.mine(req.user!.id) }));

  app.delete<{ Params: { id: string } }>("/api/submissions/:id", { preHandler: auth }, async (req, reply) => {
    try {
      submissions.withdraw(req.user!.id, req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/api/library/submissions", { preHandler: owner }, async (): Promise<{ submissions: SubmissionInfo[] }> => ({ submissions: submissions.list() }));

  app.post<{ Params: { id: string } }>("/api/library/submissions/:id/approve", { preHandler: owner }, async (req, reply): Promise<{ submission: SubmissionInfo } | void> => {
    try {
      return { submission: await submissions.approve(req.params.id, req.user!.id) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { reason?: unknown } | null }>("/api/library/submissions/:id/reject", { preHandler: owner }, async (req, reply): Promise<{ submission: SubmissionInfo } | void> => {
    try {
      return { submission: submissions.reject(req.params.id, req.user!.id, req.body?.reason) };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
