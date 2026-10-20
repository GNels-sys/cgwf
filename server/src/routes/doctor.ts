import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DoctorApplyRequest, DoctorPrefRequest, DoctorResponse } from "@cgwf/shared";
import { DeckDoctor, DoctorError } from "../analysis/doctor/service.js";
import { rateLimitKey, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { decks, libraryDecks } from "../db/schema.js";

/**
 * Deck Doctor (free, no model spend; analysis/doctor):
 *   GET    /api/decks/:id/doctor?bracket=N&allowHigher=1     own deck
 *   GET    /api/library-decks/:id/doctor?bracket=N&...       library deck, read-only (any signed-in player)
 *   POST   /api/decks/:id/doctor/apply {cutEntryId, addOracleId}   own deck only
 *   POST   /api/doctor/prefs {deckRef, oracleId, name, kind}        keep / dismiss
 *   DELETE /api/doctor/prefs {deckRef, oracleId, kind}
 */
export function registerDoctorRoutes(app: FastifyInstance, deps: { handle: DbHandle; doctor: DeckDoctor }): void {
  const { handle, doctor } = deps;
  const auth = requireUser(handle);
  const keyGenerator = rateLimitKey(handle);
  const limited = { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator } } };

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DoctorError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };
  const opts = (q: { bracket?: string; allowHigher?: string }) => ({ target: q.bracket ? Number(q.bracket) : undefined, allowHigher: q.allowHigher === "1" || q.allowHigher === "true" });

  app.get<{ Params: { id: string }; Querystring: { bracket?: string; allowHigher?: string } }>("/api/decks/:id/doctor", limited, async (req, reply): Promise<DoctorResponse | void> => {
    try {
      return await doctor.run({ kind: "own", deckId: req.params.id, userId: req.user!.id }, opts(req.query));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { bracket?: string; allowHigher?: string } }>("/api/library-decks/:id/doctor", limited, async (req, reply): Promise<DoctorResponse | void> => {
    try {
      return await doctor.run({ kind: "library", libraryId: req.params.id, userId: req.user!.id }, opts(req.query));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: Partial<DoctorApplyRequest> | null }>("/api/decks/:id/doctor/apply", limited, async (req, reply) => {
    const cut = Number(req.body?.cutEntryId);
    const add = typeof req.body?.addOracleId === "string" ? req.body.addOracleId : "";
    if (!Number.isInteger(cut) || !add) return reply.code(400).send({ error: "cutEntryId and addOracleId are required" });
    try {
      doctor.applySwap(req.user!.id, req.params.id, cut, add);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** A deck reference the caller may read: their own deck, or any library deck. */
  const readable = (userId: string, ref: string): boolean => {
    if (ref.startsWith("library:")) return Boolean(handle.db.select({ id: libraryDecks.id }).from(libraryDecks).where(eq(libraryDecks.id, ref.slice(8))).get());
    return Boolean(handle.db.select({ id: decks.id }).from(decks).where(and(eq(decks.id, ref), eq(decks.userId, userId))).get());
  };
  const prefBody = (b: Partial<DoctorPrefRequest> | null) => {
    const kind = b?.kind === "keep" || b?.kind === "dismiss" ? b.kind : null;
    const deckRef = typeof b?.deckRef === "string" ? b.deckRef : "";
    const oracleId = typeof b?.oracleId === "string" ? b.oracleId : "";
    return kind && deckRef && oracleId ? { kind, deckRef, oracleId, name: typeof b?.name === "string" ? b.name : "" } : null;
  };
  app.post<{ Body: Partial<DoctorPrefRequest> | null }>("/api/doctor/prefs", { preHandler: auth }, async (req, reply) => {
    const b = prefBody(req.body);
    if (!b) return reply.code(400).send({ error: "deckRef, oracleId and kind (keep | dismiss) are required" });
    if (!readable(req.user!.id, b.deckRef)) return reply.code(404).send({ error: "deck not found" });
    doctor.setPref(req.user!.id, b.deckRef, b.oracleId, b.name, b.kind);
    return { ok: true };
  });
  app.delete<{ Body: Partial<DoctorPrefRequest> | null }>("/api/doctor/prefs", { preHandler: auth }, async (req, reply) => {
    const b = prefBody(req.body);
    if (!b) return reply.code(400).send({ error: "deckRef, oracleId and kind (keep | dismiss) are required" });
    if (!readable(req.user!.id, b.deckRef)) return reply.code(404).send({ error: "deck not found" });
    doctor.clearPref(req.user!.id, b.deckRef, b.oracleId, b.kind);
    return { ok: true };
  });
}
