import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  OWNER_CODE_MAX,
  normalizeEmail,
  passwordProblem,
  type ChangePasswordRequest,
  type RegisterResponse,
  type SessionInfo,
  type SignInRequest,
  type SignUpRequest,
  type User,
} from "@cgwf/shared";
import { createSession, rateLimitKey, requireUser, toPublicUser } from "../auth.js";
import { config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { hashPassword, secretsEqual, verifyPassword } from "../password.js";

/**
 * Accounts on top of device identity. A device-only profile "signs up" by
 * adding an email + password to itself (nothing is lost); an account "signs
 * in" from another device by opening a new session there. Errors about
 * credentials are deliberately generic.
 */

const BAD_CREDENTIALS = "email or password is wrong";
const DUMMY_RECORD = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Owner-claim attempts across every client, so a botnet of IPs cannot brute-force the code. */
const OWNER_CLAIM_GLOBAL_MAX = 30;
const OWNER_CLAIM_WINDOW_MS = 60 * 60 * 1000;

export function registerAuthRoutes(app: FastifyInstance, handle: DbHandle): void {
  const auth = requireUser(handle);
  const keyGenerator = rateLimitKey(handle);
  const claimAttempts: number[] = [];

  /** Add an email + password to the signed-in (device) profile. */
  app.post<{ Body: Partial<SignUpRequest> }>(
    "/api/auth/signup",
    { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 hour", keyGenerator } } },
    async (req, reply): Promise<{ user: User } | void> => {
      const user = req.user!;
      if (user.email) return reply.code(409).send({ error: "this profile already has an account" });
      const email = normalizeEmail(req.body?.email);
      if (!email) return reply.code(400).send({ error: "enter a valid email address" });
      const problem = passwordProblem(req.body?.password);
      if (problem) return reply.code(400).send({ error: problem });
      const taken = handle.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
      if (taken) return reply.code(409).send({ error: "that email is already in use; sign in instead" });
      const passwordHash = await hashPassword(req.body!.password!);
      try {
        handle.db.update(users).set({ email, passwordHash }).where(eq(users.id, user.id)).run();
      } catch {
        // Lost a race on the unique index.
        return reply.code(409).send({ error: "that email is already in use; sign in instead" });
      }
      const row = handle.db.select().from(users).where(eq(users.id, user.id)).get()!;
      req.log.info({ userId: user.id }, "account created");
      return { user: toPublicUser(row) };
    },
  );

  /** Open a new session (device) for an existing account. */
  app.post<{ Body: Partial<SignInRequest> }>(
    "/api/auth/signin",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (req, reply): Promise<RegisterResponse | void> => {
      const email = normalizeEmail(req.body?.email);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!email || !password || password.length > 1024) return reply.code(401).send({ error: BAD_CREDENTIALS });
      const row = handle.db.select().from(users).where(eq(users.email, email)).get();
      // Verify against a dummy record when the email is unknown so timing does not reveal which emails exist.
      const ok = await verifyPassword(password, row?.passwordHash ?? DUMMY_RECORD);
      if (!row || !ok) {
        req.log.warn({ ip: req.ip }, "failed sign-in");
        return reply.code(401).send({ error: BAD_CREDENTIALS });
      }
      const { token } = createSession(handle, row.id, req.headers["user-agent"]);
      return { token, user: toPublicUser(row) };
    },
  );

  app.post<{ Body: Partial<ChangePasswordRequest> }>(
    "/api/auth/password",
    { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 hour", keyGenerator } } },
    async (req, reply): Promise<{ ok: true } | void> => {
      const user = req.user!;
      if (!user.email) return reply.code(409).send({ error: "add an email and password first" });
      const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
      if (!(await verifyPassword(current, user.passwordHash))) return reply.code(401).send({ error: "current password is wrong" });
      const problem = passwordProblem(req.body?.newPassword);
      if (problem) return reply.code(400).send({ error: problem });
      const passwordHash = await hashPassword(req.body!.newPassword!);
      handle.sqlite.transaction(() => {
        handle.db.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run();
        // Every other device must sign in again with the new password.
        handle.db.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, req.session!.id))).run();
      })();
      return { ok: true };
    },
  );

  app.get("/api/me/sessions", { preHandler: auth }, async (req): Promise<{ sessions: SessionInfo[] }> => {
    const rows = handle.db.select().from(sessions).where(eq(sessions.userId, req.user!.id)).all();
    rows.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    return {
      sessions: rows.map((s) => ({ id: s.id, device: s.device, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === req.session!.id })),
    };
  });

  /** Sign out one device (any of mine, including this one). */
  app.delete<{ Params: { id: string } }>("/api/me/sessions/:id", { preHandler: auth }, async (req, reply): Promise<{ ok: true } | void> => {
    const result = handle.db.delete(sessions).where(and(eq(sessions.id, req.params.id), eq(sessions.userId, req.user!.id))).run();
    if (result.changes === 0) return reply.code(404).send({ error: "no such device" });
    return { ok: true };
  });

  /** Sign out everywhere, this device included. */
  app.delete("/api/me/sessions", { preHandler: auth }, async (req): Promise<{ ok: true }> => {
    handle.db.delete(sessions).where(eq(sessions.userId, req.user!.id)).run();
    return { ok: true };
  });

  /**
   * Owner claim: the one-time code from the OWNER_CLAIM_CODE secret grants
   * users.is_owner. Needs an account (so the flag cannot be stranded on a
   * device-only profile), is rate-limited per client and globally, and every
   * attempt is logged. Ownership is never granted by email.
   */
  app.post<{ Body: { code?: unknown } }>(
    "/api/me/owner-claim",
    { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: "1 hour", keyGenerator } } },
    async (req, reply): Promise<{ user: User } | void> => {
      const user = req.user!;
      const now = Date.now();
      while (claimAttempts.length && claimAttempts[0]! < now - OWNER_CLAIM_WINDOW_MS) claimAttempts.shift();
      if (claimAttempts.length >= OWNER_CLAIM_GLOBAL_MAX) {
        req.log.warn({ userId: user.id, ip: req.ip }, "owner claim: global limit hit");
        return reply.code(429).send({ error: "too many attempts; try again later" });
      }
      claimAttempts.push(now);
      const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
      if (!config.ownerClaimCode) {
        req.log.warn({ userId: user.id, ip: req.ip }, "owner claim attempted but OWNER_CLAIM_CODE is not set");
        return reply.code(503).send({ error: "owner claim is not enabled on this server" });
      }
      if (!user.email) return reply.code(409).send({ error: "add an email and password before claiming ownership" });
      const ok = code.length > 0 && code.length <= OWNER_CODE_MAX && secretsEqual(code, config.ownerClaimCode);
      req.log.warn({ userId: user.id, email: user.email, ip: req.ip, ok }, "owner claim attempt");
      if (!ok) return reply.code(403).send({ error: "that code is not right" });
      handle.sqlite.transaction(() => {
        // One owner: a successful claim moves the flag (the code is the secret, not the account).
        handle.db.update(users).set({ isOwner: false }).where(ne(users.id, user.id)).run();
        handle.db.update(users).set({ isOwner: true }).where(eq(users.id, user.id)).run();
      })();
      const row = handle.db.select().from(users).where(eq(users.id, user.id)).get()!;
      return { user: toPublicUser(row) };
    },
  );
}
