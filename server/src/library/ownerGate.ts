import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { userFromRequest } from "../auth.js";
import type { DbHandle } from "../db/index.js";

/**
 * TEMPORARY PLACEHOLDER - DO NOT SHIP.
 *
 * Phase 5 (accounts) adds `users.is_owner` and a real `requireOwner(handle)`
 * preHandler in server/src/auth.ts. Until that branch is merged, the library
 * routes are gated by this stand-in, which only lets through the user whose id
 * is in CGWF_OWNER_PLACEHOLDER_USER_ID (set by the tests). In production the
 * variable is never set, so every request is refused. The merge replaces the
 * import in routes/library.ts with the real requireOwner and deletes this file.
 */
export function requireOwner(handle: DbHandle): preHandlerHookHandler {
  return (req: FastifyRequest, reply: FastifyReply, done) => {
    const user = userFromRequest(handle, req);
    if (!user) {
      void reply.code(401).send({ error: "sign in required" });
      return;
    }
    const allowed = process.env.CGWF_OWNER_PLACEHOLDER_USER_ID;
    if (!allowed || user.id !== allowed) {
      void reply.code(403).send({ error: "owner only" });
      return;
    }
    req.user = user;
    done();
  };
}
